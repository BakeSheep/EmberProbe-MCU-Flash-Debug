"use strict";

const rules = require("../chip/rules");
const { probeRsArgs, runProbeRs } = require("./probeRsFlashService");
const { withProbeRsChipSession } = require("./probeRsChipSession");

const DHCSR_ADDR = 0xe000edf0;
const READ_TIMEOUT_MS = 15000;
const MAX_READ_BYTES = 128;
const FATAL_READ_CODES = new Set([
    "DEBUG_STATE_CHANGED",
    "CHIP_READ_TIMEOUT",
    "CHIP_READ_BUDGET",
    "PROBE_EXIT_UNCONFIRMED",
    "STALE_PROBE_LEASE"
]);

function validateRead(address, count) {
    if (
        !Number.isInteger(address) ||
        address < 0 ||
        address > 0xffffffff ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_READ_BYTES ||
        address + count > 0x100000000
    )
        throw Object.assign(new Error("Invalid chip information memory read"), { code: "CHIP_READ_BUDGET" });
}

async function withinDeadline(operation, deadline) {
    let timer;
    try {
        return await Promise.race([
            operation(),
            new Promise((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            Object.assign(new Error("Chip information read timed out"), { code: "CHIP_READ_TIMEOUT" })
                        ),
                    Math.max(1, deadline - Date.now())
                );
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function parseReadValues(output, address, count, width) {
    validateRead(address, count * width);
    const values = [];
    let found = false;
    for (const line of String(output || "").split(/\r?\n/)) {
        const match = /^\s*(?:0x)?([0-9a-f]+)\s*:\s*(.*?)\s*$/i.exec(line);
        if (!match) continue;
        const at = Number.parseInt(match[1], 16);
        if (!found && at !== address) continue;
        if (at !== address + values.length * width) throw new Error("probe-rs returned noncontiguous memory");
        found = true;
        const tokens = match[2].split(/\s+/);
        const wordPattern = new RegExp(`^(?:0x)?[0-9a-f]{1,${width * 2}}$`, "i");
        if (tokens.some((word) => !wordPattern.test(word))) throw new Error("Invalid probe-rs memory output");
        values.push(...tokens.map((word) => Number.parseInt(word.replace(/^0x/i, ""), 16) >>> 0));
    }
    if (!found) throw new Error(`probe-rs did not return memory at 0x${address.toString(16)}`);
    if (values.length !== count) throw new Error(`probe-rs returned ${values.length} of ${count} words`);
    return values;
}

function parseReadWords(output, address, count) {
    return parseReadValues(output, address, count, 4);
}

async function readDapMemory(session, address, count) {
    validateRead(address, count);
    const response = await session.customRequest("readMemory", {
        memoryReference: `0x${address.toString(16)}`,
        offset: 0,
        count
    });
    const body = response?.body || response;
    const data = body?.data;
    if (typeof data !== "string" || data.length !== 4 * Math.ceil(count / 3))
        throw new Error(`probe-rs DAP could not read ${count} bytes at 0x${address.toString(16)}`);
    const bytes = Buffer.from(data, "base64");
    if (
        response?.success === false ||
        bytes.toString("base64") !== data ||
        bytes.length !== count ||
        body?.unreadableBytes ||
        (body?.address !== undefined && Number(body.address) !== address)
    )
        throw new Error(`probe-rs DAP could not read ${count} bytes at 0x${address.toString(16)}`);
    return bytes;
}

async function readCliMemory(settings, address, count, run = runProbeRs, options = {}) {
    validateRead(address, count);
    const width =
        options.width ?? (address % 4 === 0 && count % 4 === 0 ? 4 : address % 2 === 0 && count % 2 === 0 ? 2 : 1);
    if (![1, 2, 4].includes(width) || address % width || count % width)
        throw Object.assign(new Error("Invalid chip information read width"), { code: "CHIP_READ_BUDGET" });
    const args = [
        ...probeRsArgs("read", settings),
        `b${width * 8}`,
        `0x${address.toString(16)}`,
        String(count / width)
    ];
    const result = await run(settings.executable, args, settings.cwd, { timeoutMs: options.timeoutMs });
    const words = parseReadValues(result.stdout, address, count / width, width);
    const bytes = Buffer.alloc(count);
    words.forEach((word, index) => bytes.writeUIntLE(word, index * width, width));
    return bytes;
}

function targetForChip(chip) {
    const name = String(chip || "").toLowerCase();
    if (/^stm32h7[rs]/.test(name)) return "";
    // Unknown targets never scan other families' memory.
    for (const key of Object.keys(rules.STM32_IDCODE_BASE)) {
        if (name.startsWith(key.replace(/x$/, ""))) return `${key}.cfg`;
    }
    return /^apm32f4/i.test(name) ? "apm32f4x.cfg" : "";
}

function parseRegisters(output) {
    const result = {};
    const aliases = { r15: "pc", r14: "lr", r13: "sp" };
    const pattern = /\b([a-z][a-z0-9]*(?:\/[a-z][a-z0-9]*)*)\s*:\s*(0x[0-9a-f]+)\b/gi;
    for (const match of String(output || "").matchAll(pattern)) {
        for (const alias of match[1].toLowerCase().split("/")) {
            const name = aliases[alias] || alias;
            if (["pc", "sp", "lr"].includes(name) && !result[name])
                result[name] = match[2].toUpperCase().replace("0X", "0x");
        }
    }
    return result;
}

async function readDapRegisters(session) {
    const response = await session.customRequest("evaluate", { expression: "info reg", context: "repl" });
    if (response?.success === false) throw new Error(response.message || "probe-rs could not read core registers");
    const output = (response?.body || response)?.result;
    if (typeof output !== "string" || output.length > 8192) throw new Error("Invalid probe-rs register output");
    const registers = parseRegisters(output);
    if (!registers.pc || !registers.sp || !registers.lr) throw new Error("probe-rs did not return PC, SP and LR");
    return registers;
}

function stateFromDhcsr(value) {
    // Sleeping cores are executing firmware and use the running controls.
    return value & 0x20000 ? "halted" : "running";
}

async function readProbeRsChipInfo(settings, options = {}) {
    const chip = String(settings.chip || "").trim();
    if (!chip || !/^[A-Za-z0-9_.+-]+$/.test(chip))
        throw new Error("Set emberprobe.probeRsChip before reading chip information");
    const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? READ_TIMEOUT_MS);
    const fields = options.fields && !options.fields.includes("readErrors") ? new Set(options.fields) : null;
    const wants = (...names) => !fields || names.some((name) => fields.has(name));
    const needRom = wants(
        "designer",
        "romDesigner",
        "designerCode",
        "romPart",
        "authenticity",
        "compatVendor",
        "compatBrand",
        "flashSize",
        "uid"
    );
    const needIdcode = wants("idcode", "deviceId", "revId");
    const needFlash = wants("flashSize");
    const needUid = wants("uid");
    const needRegisters = wants("pc", "sp", "lr");
    const needState = needRegisters || wants("targetState", "haltReason");
    const needCore =
        needRom || needIdcode || needState || wants("core", "coreRevision", "cpuid", "implementer", "endian");
    let bytesRead = 0;
    const read = async (address, count, width) => {
        options.assertCurrent?.();
        if ((bytesRead += count) > 256)
            throw Object.assign(new Error("Chip information read exceeds the byte budget"), {
                code: "CHIP_READ_BUDGET"
            });
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0)
            throw Object.assign(new Error("Chip information read timed out"), { code: "CHIP_READ_TIMEOUT" });
        // CLI execFile resolves only after process exit; retain ownership until then.
        const data = options.session
            ? await withinDeadline(() => readDapMemory(options.session, address, count), deadline)
            : await readCliMemory(settings, address, count, options.run, { timeoutMs, width });
        options.assertCurrent?.();
        if (Date.now() >= deadline)
            throw Object.assign(new Error("Chip information read timed out"), { code: "CHIP_READ_TIMEOUT" });
        return data;
    };
    const decoded = needCore ? rules.decodeCpuid((await read(rules.CPUID_ADDR, 4)).readUInt32LE(0)) : null;
    if (needCore && (!decoded?.core || decoded.implementer !== "ARM"))
        throw Object.assign(new Error("Chip information reads require a recognized Cortex-M core"), {
            code: "CHIP_ARCHITECTURE_UNSUPPORTED"
        });
    const target = targetForChip(chip);
    /** @type {Record<string, any>} */
    const info = {
        backend: "probe-rs",
        chip,
        targetName: chip,
        series: rules.seriesFromTarget(target),
        core: decoded?.core || "",
        coreRevision: decoded?.revision || "",
        implementer: decoded?.implementer || "",
        cpuid: decoded?.raw || "",
        endian: "little",
        probeName: /^1366:/i.test(settings.probe || "")
            ? "J-Link"
            : /^0483:/i.test(settings.probe || "")
              ? "ST-Link"
              : "probe-rs",
        probe: settings.probe || "unique probe",
        transport: rules.normalizeTransport(options.protocol || settings.protocol || "SWD"),
        clock: settings.speed ? `${settings.speed} kHz` : "",
        targetState: options.state || "",
        haltReason: options.haltReason || "",
        controlsAvailable: true,
        resetAvailable: options.session ? options.resetAvailable === true : true,
        readErrors: [],
        readAt: new Date().toISOString()
    };
    const progress = () => {
        options.assertCurrent?.();
        options.onProgress?.({ ...info, readErrors: info.readErrors.slice(), readAt: "" });
    };
    const assertRecoverable = (error) => {
        options.assertCurrent?.();
        if (error.killed)
            throw Object.assign(new Error("Chip information read timed out"), { code: "CHIP_READ_TIMEOUT" });
        if (FATAL_READ_CODES.has(error.code) || Date.now() >= deadline) throw error;
    };
    const optional = async (field, operation) => {
        try {
            return await operation();
        } catch (error) {
            assertRecoverable(error);
            info.readErrors.push({ field, message: String(error.message || error).slice(0, 500) });
            return null;
        }
    };
    progress();
    // PIDR4..7, PIDR0..3 and CIDR0..3 form one contiguous 48-byte block.
    const romBytes = needRom ? await optional("romDesigner", () => read(rules.ROM_PIDR4_ADDR, 48)) : null;
    const romWords = (offset) => romBytes && [0, 4, 8, 12].map((index) => romBytes.readUInt32LE(offset + index));
    const rom = rules.decodeRomPidr(romWords(16), romWords(0), romWords(32));
    if (rom) {
        info.romDesigner = rom.designer;
        info.designerCode = rom.code;
        info.romPart = rom.part;
        info.designer = rules.deriveVendor(info.series, rom);
        Object.assign(info, rules.assessAuthenticity(info.series, rom.key));
    }
    progress();
    const idcodeBase = needIdcode && rules.idcodeBaseForTarget(target);
    if (idcodeBase) {
        const bytes = await optional("idcode", () => read(idcodeBase, 4));
        const value = bytes?.readUInt32LE(0);
        if (value !== undefined && (value & 0xfff) !== 0 && (value & 0xfff) !== 0xfff) {
            info.idcode = `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
            Object.assign(info, rules.splitIdcode(value));
        }
    }
    progress();
    // A Geehy fingerprint does not verify STM32 UID/flash addresses for APM32 silicon.
    if (rom?.key !== "11:0x23") {
        const flashBase = needFlash && rules.flashSizeBaseForTarget(target);
        const uidBase = needUid && rules.uidBaseForTarget(target);
        let factoryBytes;
        const start = Math.min(flashBase, uidBase);
        const end = Math.max(flashBase + 2, uidBase + 12);
        // These families place both fields in the same small read-only factory block.
        // Read halfwords so the flash-size field retains its natural transfer width.
        if (flashBase && uidBase && /^stm32f[1247]x\.cfg$/.test(target) && [20, 36].includes(end - start)) {
            try {
                factoryBytes = await read(start, end - start, 2);
            } catch (error) {
                // A hole in the factory block must not hide a separately readable field.
                assertRecoverable(error);
            }
        }
        if (flashBase) {
            const bytes = factoryBytes
                ? factoryBytes.subarray(flashBase - start, flashBase - start + 2)
                : await optional("flashSize", () => read(flashBase, 2));
            const size = bytes?.readUInt16LE(0);
            if (size > 0 && size < 0xffff) info.flashSize = `${size} KiB`;
        }
        if (uidBase) {
            const bytes = factoryBytes
                ? factoryBytes.subarray(uidBase - start, uidBase - start + 12)
                : await optional("uid", () => read(uidBase, 12));
            if (bytes) info.uid = rules.formatUid([0, 4, 8].map((offset) => bytes.readUInt32LE(offset)));
        }
    }
    progress();
    if (needState && !options.session) {
        const status = await optional("targetState", () => read(DHCSR_ADDR, 4));
        info.targetState = status ? stateFromDhcsr(status.readUInt32LE(0)) : "unknown";
        if (!status) info.stateError = info.readErrors.at(-1).message;
    }
    if (needRegisters && info.targetState === "halted") {
        const registers = await optional("registers", async () => {
            if (options.session) return withinDeadline(() => readDapRegisters(options.session), deadline);
            return withProbeRsChipSession(settings, { ...options, deadline }, readDapRegisters);
        });
        if (registers) Object.assign(info, registers);
    }
    info.readAt = new Date().toISOString();
    options.assertCurrent?.();
    return info;
}

async function controlProbeRsTarget(settings, action, options = {}) {
    if (!["pause", "continue", "reset"].includes(action))
        throw Object.assign(new Error(`Unsupported target action: ${action}`), { code: "CHIP_ACTION_INVALID" });
    const readState = async (session) => stateFromDhcsr((await readDapMemory(session, DHCSR_ADDR, 4)).readUInt32LE(0));
    const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? READ_TIMEOUT_MS);
    const before = stateFromDhcsr(
        (
            await readCliMemory(settings, DHCSR_ADDR, 4, options.run, { timeoutMs: Math.max(1, deadline - Date.now()) })
        ).readUInt32LE(0)
    );
    if ((action === "pause" && before !== "running") || (action === "continue" && before !== "halted"))
        throw Object.assign(new Error(`Target is no longer ${action === "pause" ? "running" : "halted"}`), {
            code: "CHIP_CONTROL_FAILED"
        });
    options.assertCurrent?.();
    return withProbeRsChipSession(settings, { ...options, deadline }, async (session) => {
        // attach halts, so omit configurationDone; only explicit actions resume or reset.
        if (action === "reset") await session.customRequest("restart", {});
        if (action === "continue" || (action === "reset" && (await readState(session)) === "halted")) {
            const response = await session.customRequest("threads", {});
            const threadId = (response?.body || response)?.threads?.[0]?.id;
            if (!Number.isInteger(threadId)) throw new Error("probe-rs returned no core for execution control");
            await session.customRequest("continue", { threadId, singleThread: false });
        }
        const state = await readState(session);
        if (state !== (action === "pause" ? "halted" : "running"))
            throw Object.assign(new Error("probe-rs did not confirm the requested target state"), {
                code: "CHIP_CONTROL_FAILED"
            });
        if (!options.refresh) return { state };
        try {
            const info = await readProbeRsChipInfo(settings, {
                ...options,
                session,
                state,
                resetAvailable: true,
                deadline
            });
            return { state, info };
        } catch (readError) {
            return { state, readError };
        }
    });
}

module.exports = {
    DHCSR_ADDR,
    READ_TIMEOUT_MS,
    parseReadWords,
    parseRegisters,
    targetForChip,
    readDapMemory,
    readDapRegisters,
    readCliMemory,
    readProbeRsChipInfo,
    controlProbeRsTarget
};
