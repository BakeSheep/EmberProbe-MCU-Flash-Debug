"use strict";
const {
    STM32_UID_BASE,
    STM32_FLASHSIZE_BASE,
    CPUID_ADDR,
    ROM_PIDR4_ADDR,
    ROM_PIDR0_ADDR,
    ROM_CIDR_ADDR,
    ALL_FLASHSIZE_ADDRS,
    ALL_UID_ADDRS,
    IDCODE_ADDR_SET,
    FLASHSIZE_ADDR_SET,
    UID_ADDR_SET,
    DEV_ID_FAMILY,
    coreMatchesSeries,
    decodeRomPidr,
    assessAuthenticity,
    deriveVendor,
    chooseIdcode,
    decodeCpuid,
    parseMdwDump,
    parseRegLine,
    parseKv,
    splitIdcode,
    normalizeTransport,
    seriesFromTarget,
    seriesFromFlashDriver,
    lookupStmBase,
    uidBaseForTarget,
    idcodeBaseForTarget,
    flashSizeBaseForTarget,
    formatUid,
    normalizeFlashSize
} = require("./rules");
const { parseLine } = require("../openocdRunner");
function createChipParser(target) {
    const options = { target };
    const uidBase = uidBaseForTarget(target),
        idcodeBase = idcodeBaseForTarget(target),
        flashSizeBase = flashSizeBaseForTarget(target);
    const info = {
        // Core
        core: "",
        coreRevision: "",
        cpuid: "",
        implementer: "",
        // Explains a CPUID core that disagrees with the series derived from DEV_ID or the target (empty when consistent
        // or unknown)
        coreMismatch: "",
        // Chip series
        chip: "",
        series: seriesFromTarget(options.target),
        // Vendor fingerprint (JEP106 from the ROM table) and genuine/compatible verdict; designer is the vendor the
        // fingerprint confirms, romDesigner the raw CoreSight ROM table designer
        designer: "",
        romDesigner: "",
        designerCode: "",
        romPart: "",
        authenticity: "",
        compatVendor: "",
        compatBrand: "",
        // Chip information
        idcode: "",
        deviceId: "",
        revId: "",
        flashSize: "",
        flashBase: "",
        flashDriver: "",
        endian: "",
        uid: "",
        // Debug connection
        probeName: "",
        probeVersion: "",
        probeHardwareVersion: "",
        probeFirmware: "",
        probe: "",
        transport: "",
        clock: "",
        voltage: "",
        targetName: "",
        // Run state
        targetState: "",
        stateError: "",
        haltReason: "",
        pc: "",
        sp: "",
        lr: ""
    };
    const errors = [];
    const rawTail = [];
    const rawAll = [];
    // Raw reads from the all-family scan (address -> value); the real family picks among them when the parser closes
    const idcReads = {},
        flsReads = {},
        uidReads = {};
    let idcodeLog = ""; // Device id reported by the OpenOCD flash driver (last resort only)
    let transportLog = "";
    const handleLine = (raw) => {
        const clean = raw;
        if (!clean) return;
        rawTail.push(clean);
        if (rawTail.length > 12) rawTail.shift();
        rawAll.push(clean);
        if (rawAll.length > 400) rawAll.shift();

        // Custom markers: target name, state, endianness and transport
        const kv = parseKv(clean);
        if (kv) {
            if (kv.key === "name" && kv.value) info.targetName = kv.value;
            else if (kv.key === "state" && kv.value) info.targetState = kv.value;
            else if (kv.key === "stateError") info.stateError = kv.value;
            else if (kv.key === "endian" && kv.value) info.endian = kv.value;
            else if (kv.key === "transport" && !info.transport) info.transport = normalizeTransport(kv.value);
            return;
        }
        // Register lines (OpenOCD prints them only while halted)
        const reg = parseRegLine(clean);
        if (reg && (reg.name === "pc" || reg.name === "sp" || reg.name === "lr")) {
            if (!info[reg.name]) info[reg.name] = reg.value;
            return;
        }
        // mdw reads (CPUID / DBGMCU IDCODE / FLASHSIZE / UID), dispatched by address rather than by flash driver log
        // wording
        const dump = parseMdwDump(clean);
        if (dump) {
            const a = dump.addr >>> 0;
            if (a === CPUID_ADDR >>> 0) {
                const d = decodeCpuid(dump.words[0]);
                if (d) {
                    info.cpuid = d.raw;
                    // Keep the core already given by a "processor detected" line
                    if (d.core && !info.core) info.core = d.core;
                    if (!info.coreRevision) info.coreRevision = d.revision;
                    info.implementer = d.implementer;
                }
                return;
            }
            // ROM table PIDR/CIDR (vendor fingerprint): collect the three word groups and decode them on close
            if (a === ROM_PIDR4_ADDR >>> 0 && dump.words.length >= 4) {
                if (!info._pidr47) info._pidr47 = dump.words.slice(0, 4);
                return;
            }
            if (a === ROM_PIDR0_ADDR >>> 0 && dump.words.length >= 4) {
                if (!info._pidr03) info._pidr03 = dump.words.slice(0, 4);
                return;
            }
            if (a === ROM_CIDR_ADDR >>> 0 && dump.words.length >= 4) {
                if (!info._cidr) info._cidr = dump.words.slice(0, 4);
                return;
            }
            // All-family identity register scan: only collect raw reads here, without choosing (the target
            // configuration may be wrong)
            if (IDCODE_ADDR_SET.has(a)) {
                if (idcReads[a] == null) idcReads[a] = dump.words[0] >>> 0;
                return;
            }
            if (FLASHSIZE_ADDR_SET.has(a)) {
                if (flsReads[a] == null) flsReads[a] = dump.words[0] & 0xffff;
                return;
            }
            if (UID_ADDR_SET.has(a) && dump.words.length >= 3) {
                if (uidReads[a] == null) uidReads[a] = dump.words.slice(0, 3);
                return;
            }
        }
        let m;
        // Core line such as "Info : [xxx] Cortex-M4 r0p1 processor detected" (clearer than CPUID and printed earlier)
        if (/processor detected/i.test(clean) && (m = clean.match(/\b(Cortex-[MAR]\d+(?:\+|P)?)\s+(r\d+p\d+)\b/i))) {
            if (!info.core) info.core = m[1];
            if (!info.coreRevision) info.coreRevision = m[2];
            return;
        }
        // Probe family and version
        if (/CMSIS-DAP/i.test(clean)) {
            if (!info.probeName) info.probeName = "CMSIS-DAP";
            if (!info.probeVersion) {
                const fw = clean.match(/FW Version\s*=\s*v?([\w.]+)/i);
                if (fw) info.probeVersion = "v" + fw[1];
                else if (/CMSIS-DAPv2/i.test(clean)) info.probeVersion = "v2";
            }
        } else if (/ST-?LINK/i.test(clean)) {
            if (!info.probeName) info.probeName = "ST-Link";
            const v = clean.match(/\b(V\d[A-Z]\w*)\b/);
            if (v && !info.probeVersion) info.probeVersion = v[1];
        } else if (/J-?Link/i.test(clean)) {
            if (!info.probeName) info.probeName = "J-Link";
            if (/compiled/i.test(clean)) info.probeFirmware = clean.replace(/^.*?Info\s*:\s*/i, "");
        } else if (/DAPLink/i.test(clean)) {
            if (!info.probeName) info.probeName = "DAPLink";
        }
        const hardwareVersion = clean.match(/Hardware version:\s*([\d.]+)/i);
        if (hardwareVersion && info.probeName === "J-Link") {
            info.probeHardwareVersion = hardwareVersion[1];
            info.probeVersion = hardwareVersion[1];
        }
        // Transport (log fallback: DAP prints SWD DPIDR, JTAG prints "JTAG tap:")
        if (!transportLog) {
            if (/SWD DPIDR/i.test(clean)) transportLog = "SWD";
            else if (/JTAG tap:/i.test(clean)) transportLog = "JTAG";
        }
        // Halt reason (only present after a halt event, which is usually not triggered)
        if (!info.haltReason) {
            const hr = clean.match(/halted due to\s+([^,]+)/i);
            if (hr) info.haltReason = hr[1].trim();
        }
        // 9) flash 'driver' found at 0x...
        if ((m = clean.match(/flash\s+'([^']+)'\s+found\s+at\s+(0x[0-9a-f]+)/i))) {
            if (!info.flashDriver) info.flashDriver = m[1];
            if (!info.flashBase) info.flashBase = m[2];
        }
        // Some drivers (H7, for example) print "flash size probed value 2048" in KiB instead of "flash size ="
        if (!info.flashSize) {
            const fp = clean.match(/flash size probed value\s+(\d+)/i);
            if (fp) info.flashSize = fp[1] + " KiB";
        }
        // Reuse the firmware download log parser: probe, adapter, voltage, chip and flash
        const event = parseLine(clean);
        if (!event) return;
        if (event.stage === "probe") {
            if (!info.probe) info.probe = event.message;
        } else if (event.stage === "adapter") {
            if (event.clock && !info.clock) info.clock = event.clock;
        } else if (event.stage === "voltage") {
            if (typeof event.volts === "number") info.voltage = event.volts.toFixed(2) + " V";
        } else if (event.stage === "chip") {
            if (event.chip) info.chip = event.chip;
            if (event.deviceId && !idcodeLog) idcodeLog = event.deviceId;
        } else if (event.stage === "flash") {
            if (event.flashSize && !info.flashSize) info.flashSize = normalizeFlashSize(event.flashSize);
        } else if (event.stage === "error") {
            if (!errors.includes(event.message)) errors.push(event.message);
        }
    };

    return {
        handleLine,
        rawLines: () => rawAll.slice(),
        finish(code) {
            if (!info.transport && transportLog) info.transport = transportLog;
            // IDCODE: first take a known DEV_ID at any candidate address (this works even with the wrong target), then
            // trust OpenOCD's own value. Without either, an unknown DEV_ID may only come from the target family's
            // IDCODE address.
            const knownIdcode = chooseIdcode(idcReads);
            if (knownIdcode != null) info.idcode = "0x" + (knownIdcode >>> 0).toString(16).toUpperCase();
            else if (idcodeLog && idcodeBase) info.idcode = idcodeLog;
            else {
                const targetIdcode = chooseIdcode(idcReads, idcodeBase);
                if (targetIdcode != null) info.idcode = "0x" + (targetIdcode >>> 0).toString(16).toUpperCase();
            }
            if (info.idcode) {
                const split = splitIdcode(info.idcode);
                if (split) {
                    info.deviceId = split.deviceId;
                    info.revId = split.revId;
                }
            }
            // The family inferred from DEV_ID corrects the series derived from the target configuration name, so a
            // wrongly chosen target still shows the right chip. If the CPUID core does not match that family, DEV_ID
            // does not rewrite the series and the mismatch is flagged for the UI.
            let devFamily = "";
            if (info.deviceId && /^stm32/i.test(info.series)) {
                const family = DEV_ID_FAMILY[parseInt(info.deviceId, 16)];
                if (family && coreMatchesSeries(info.core, family) === false) {
                    info.coreMismatch = `${info.core} ≠ ${family} (DEV_ID ${info.deviceId})`;
                } else if (family) {
                    devFamily = family;
                    if (family !== info.series) info.series = family;
                }
            }
            // A flash driver name measured on hardware overrides the target configuration when correcting the series
            const hwSeries = seriesFromFlashDriver(info.flashDriver);
            if (hwSeries && hwSeries !== info.series && !devFamily) info.series = hwSeries;
            if (!info.coreMismatch && coreMatchesSeries(info.core, info.series) === false)
                info.coreMismatch = `${info.core} ≠ ${info.series}`;
            // Flash size: prefer the register at the corrected family's address (authoritative, overriding log-derived
            // values), then the target configuration's address. If neither hits, accept a valid value at any candidate
            // address only for STM32, so other chips do not show stray values.
            {
                const seriesKey = String(info.series || "").toLowerCase();
                const famFlashBase = lookupStmBase(STM32_FLASHSIZE_BASE, seriesKey);
                // When DEV_ID confirms a family whose address is not in this table (L1/L5/U5, for example), reads at
                // other families' addresses are noise
                const knownLayoutElsewhere = Boolean(devFamily) && !famFlashBase;
                let kb = null;
                if (famFlashBase && flsReads[famFlashBase >>> 0] != null) kb = flsReads[famFlashBase >>> 0];
                else if (flashSizeBase && flsReads[flashSizeBase >>> 0] != null) kb = flsReads[flashSizeBase >>> 0];
                if (kb != null && kb > 0 && kb < 0xffff) info.flashSize = kb + " KiB";
                else if (!info.flashSize && /^stm32/i.test(seriesKey) && !knownLayoutElsewhere) {
                    for (const a of ALL_FLASHSIZE_ADDRS) {
                        const v = flsReads[a];
                        if (v != null && v > 0 && v < 0xffff) {
                            info.flashSize = v + " KiB";
                            break;
                        }
                    }
                }
                // UID: same order as flash size: corrected family, target configuration, then any STM32 candidate
                const famUidBase = lookupStmBase(STM32_UID_BASE, seriesKey);
                let uidWords =
                    (famUidBase && uidReads[famUidBase >>> 0]) || (uidBase && uidReads[uidBase >>> 0]) || null;
                if (!uidWords && /^stm32/i.test(seriesKey) && !knownLayoutElsewhere) {
                    for (const a of ALL_UID_ADDRS) {
                        if (uidReads[a]) {
                            uidWords = uidReads[a];
                            break;
                        }
                    }
                }
                if (uidWords) info.uid = formatUid(uidWords);
            }
            // Vendor fingerprint: decode the ROM table PIDR to get the CoreSight designer, judge genuine/compatible for
            // STM32, and derive the chip vendor (unknown for Arm core ROM tables or failed reads)
            const rom = decodeRomPidr(info._pidr03, info._pidr47, info._cidr);
            if (rom) {
                info.romDesigner = rom.designer;
                info.designerCode = rom.code;
                info.romPart = rom.part;
                const verdict = assessAuthenticity(info.series, rom.key);
                info.authenticity = verdict.authenticity;
                info.compatVendor = verdict.compatVendor;
                info.compatBrand = verdict.compatBrand;
            }
            info.designer = deriveVendor(info.series, rom);
            delete info._pidr03;
            delete info._pidr47;
            delete info._cidr;
            // Succeeds once chip-level information is known; with only adapter-level fields (probe name, clock, target
            // name) any error is still reported
            const gotChip = info.core || info.chip || info.idcode || info.flashSize || info.uid;
            const gotAny = gotChip || info.targetName || info.clock || info.probeName;
            if (gotChip || (gotAny && !errors.length)) {
                return info;
            }
            let reasonErr;
            if (errors.length) reasonErr = new Error(errors.slice(-3).join("；"));
            else if (rawTail.length) reasonErr = new Error(rawTail.slice(-3).join("；"));
            else if (code === 0) reasonErr = Object.assign(new Error("未获取到芯片信息"), { i18nKey: "chip.noInfo" });
            else
                reasonErr = Object.assign(new Error(`OpenOCD 退出码 ${code}`), {
                    i18nKey: "chip.exitCode",
                    i18nParams: { code }
                });
            throw reasonErr;
        }
    };
}
module.exports = { createChipParser };
