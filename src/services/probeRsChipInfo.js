"use strict";

const rules = require("../chip/rules");
const { probeRsArgs, runProbeRs } = require("./probeRsFlashService");

function parseReadWords(output, address, count) {
    const line = String(output || "")
        .split(/\r?\n/)
        .find((part) => new RegExp(`^\\s*(?:0x)?0*${address.toString(16)}\\s*:`, "i").test(part));
    if (!line) throw new Error(`probe-rs did not return memory at 0x${address.toString(16)}`);
    const words = line
        .slice(line.indexOf(":") + 1)
        .trim()
        .split(/\s+/)
        .filter((word) => /^(?:0x)?[0-9a-f]{1,8}$/i.test(word))
        .map((word) => Number.parseInt(word.replace(/^0x/i, ""), 16) >>> 0);
    if (words.length !== count) throw new Error(`probe-rs returned ${words.length} of ${count} words`);
    return words;
}

async function readDapMemory(session, address, count) {
    const response = await session.customRequest("readMemory", {
        memoryReference: `0x${address.toString(16)}`,
        offset: 0,
        count
    });
    const body = response?.body || response;
    const bytes = Buffer.from(body?.data || "", "base64");
    if (bytes.length !== count || body?.unreadableBytes)
        throw new Error(`probe-rs DAP could not read ${count} bytes at 0x${address.toString(16)}`);
    return bytes;
}

async function readCliMemory(settings, address, count, run = runProbeRs) {
    if (count % 4) throw new Error("probe-rs CLI reads must be word aligned");
    const args = [...probeRsArgs("read", settings), "b32", `0x${address.toString(16)}`, String(count / 4)];
    const result = await run(settings.executable, args, settings.cwd);
    const words = parseReadWords(result.stdout, address, count / 4);
    const bytes = Buffer.alloc(count);
    words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
    return bytes;
}

async function readProbeRsChipInfo(settings, options = {}) {
    const chip = String(settings.chip || "").trim();
    if (!chip) throw new Error("Set emberprobe.probeRsChip before reading chip information");
    const read = options.session
        ? (address, count) => readDapMemory(options.session, address, count)
        : (address, count) => readCliMemory(settings, address, count, options.run);
    const cpuid = (await read(0xe000ed00, 4)).readUInt32LE(0);
    const decoded = rules.decodeCpuid(cpuid);
    /** @type {Record<string, any>} */
    const info = {
        chip,
        targetName: chip,
        core: decoded?.core || "",
        coreRevision: decoded?.revision || "",
        cpuid: decoded?.raw || "",
        probeName: "probe-rs",
        probe: settings.probe || "unique probe",
        transport: String(options.protocol || "SWD").toUpperCase(),
        targetState: options.state || "",
        controlsAvailable: false,
        readAt: new Date().toISOString()
    };
    if (/^STM32H7/i.test(chip)) {
        const target = "stm32h7x.cfg";
        const idcode = (await read(rules.idcodeBaseForTarget(target), 4)).readUInt32LE(0);
        info.idcode = `0x${idcode.toString(16).toUpperCase().padStart(8, "0")}`;
        Object.assign(info, rules.splitIdcode(idcode));
        info.series = "STM32H7x";
        const flashWord = (await read(rules.flashSizeBaseForTarget(target), 4)).readUInt32LE(0);
        const flashKiB = flashWord & 0xffff;
        if (flashKiB > 0 && flashKiB < 0xffff) info.flashSize = `${flashKiB} KiB`;
        const uid = await read(rules.uidBaseForTarget(target), 12);
        info.uid = rules.formatUid([0, 4, 8].map((offset) => uid.readUInt32LE(offset)));
    }
    return info;
}

module.exports = { parseReadWords, readDapMemory, readCliMemory, readProbeRsChipInfo };
