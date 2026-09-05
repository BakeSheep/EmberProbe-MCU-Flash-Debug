"use strict";
const {
    CORTEX_M_PARTS,
    IMPLEMENTERS,
    STM32_UID_BASE,
    STM32_IDCODE_BASE,
    STM32_FLASHSIZE_BASE,
    CPUID_ADDR,
    CPUID_HEX,
    ROM_PIDR4_ADDR,
    ROM_PIDR0_ADDR,
    ROM_CIDR_ADDR,
    CLASSIC_IDCODE_ADDR,
    FALLBACK_FLASHSIZE_ADDRS,
    FALLBACK_UID_ADDRS,
    ALL_IDCODE_ADDRS,
    ALL_FLASHSIZE_ADDRS,
    ALL_UID_ADDRS,
    IDCODE_ADDR_SET,
    FLASHSIZE_ADDR_SET,
    UID_ADDR_SET,
    DEV_ID_FAMILY,
    JEP106_DESIGNERS,
    ST_JEP106_KEY,
    ARM_JEP106_KEY,
    COMPAT_BRANDS,
    decodeRomPidr,
    assessAuthenticity,
    deriveVendor,
    chooseIdcode,
    decodeCpuid,
    parseMdwWord,
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
    buildChipInfoCommands,
    normalizeFlashSize
} = require("./rules");
const { parseLine } = require("../openocdRunner");
function createChipParser(target) {
    const options = { target };
    const uidBase = uidBaseForTarget(target),
        idcodeBase = idcodeBaseForTarget(target),
        flashSizeBase = flashSizeBaseForTarget(target);
    const info = {
        // 内核
        core: "",
        coreRevision: "",
        cpuid: "",
        implementer: "",
        // 芯片系列
        chip: "",
        series: seriesFromTarget(options.target),
        // 厂商指纹（ROM 表 JEP106）与原厂/兼容判定；designer=指纹确认的芯片厂商，romDesigner=CoreSight ROM 表原始设计者
        designer: "",
        romDesigner: "",
        designerCode: "",
        romPart: "",
        authenticity: "",
        compatVendor: "",
        compatBrand: "",
        // 芯片信息
        idcode: "",
        deviceId: "",
        revId: "",
        flashSize: "",
        flashBase: "",
        flashDriver: "",
        endian: "",
        uid: "",
        // 调试连接
        probeName: "",
        probeVersion: "",
        probe: "",
        transport: "",
        clock: "",
        voltage: "",
        targetName: "",
        // 运行信息
        targetState: "",
        haltReason: "",
        pc: "",
        sp: "",
        lr: ""
    };
    const errors = [];
    const rawTail = [];
    const rawAll = [];
    // 全家族扫描的原始读数（地址 → 值），收尾时按真实家族选值
    const idcReads = {},
        flsReads = {},
        uidReads = {};
    let idcodeLog = ""; // OpenOCD flash 驱动自报的 device id（仅作最后回退）
    let transportLog = "";
    const handleLine = (raw) => {
        const clean = raw;
        if (!clean) return;
        rawTail.push(clean);
        if (rawTail.length > 12) rawTail.shift();
        rawAll.push(clean);
        if (rawAll.length > 400) rawAll.shift();

        // 1) 自定义标记：目标名称/状态/字节序/传输协议
        const kv = parseKv(clean);
        if (kv) {
            if (kv.key === "name" && kv.value) info.targetName = kv.value;
            else if (kv.key === "state" && kv.value) info.targetState = kv.value;
            else if (kv.key === "endian" && kv.value) info.endian = kv.value;
            else if (kv.key === "transport" && !info.transport) info.transport = normalizeTransport(kv.value);
            return;
        }
        // 2) 寄存器行（仅在已暂停时 OpenOCD 才会输出）
        const reg = parseRegLine(clean);
        if (reg && (reg.name === "pc" || reg.name === "sp" || reg.name === "lr")) {
            if (!info[reg.name]) info[reg.name] = reg.value;
            return;
        }
        // 3) mdw 读取（CPUID / DBGMCU IDCODE / FLASHSIZE / UID），按地址分派——不依赖 flash 驱动的日志措辞
        const dump = parseMdwDump(clean);
        if (dump) {
            const a = dump.addr >>> 0;
            if (a === CPUID_ADDR >>> 0) {
                const d = decodeCpuid(dump.words[0]);
                if (d) {
                    info.cpuid = d.raw;
                    if (d.core && !info.core) info.core = d.core; // "processor detected" 行已给出内核时不覆盖
                    if (!info.coreRevision) info.coreRevision = d.revision;
                    info.implementer = d.implementer;
                }
                return;
            }
            // ROM 表 PIDR/CIDR（厂商指纹）：收集三组字，统一在 close 时解码
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
            // 身份寄存器全家族扫描：只收集原始读数，不在此处判断取舍（目标配置可能选错）
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
        // 5) 内核识别行：Info : [xxx] Cortex-M4 r0p1 processor detected（比 CPUID 更直观且更早出现）
        if (/processor detected/i.test(clean) && (m = clean.match(/\b(Cortex-[MAR]\d+\+?)\s+(r\d+p\d+)\b/i))) {
            if (!info.core) info.core = m[1];
            if (!info.coreRevision) info.coreRevision = m[2];
            return;
        }
        // 6) 探针家族与版本
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
        } else if (/DAPLink/i.test(clean)) {
            if (!info.probeName) info.probeName = "DAPLink";
        }
        // 7) 传输协议（日志兜底：DAP 打印 SWD DPIDR；JTAG 打印 JTAG tap:）
        if (!transportLog) {
            if (/SWD DPIDR/i.test(clean)) transportLog = "SWD";
            else if (/JTAG tap:/i.test(clean)) transportLog = "JTAG";
        }
        // 8) 停止原因（仅当发生 halt 事件时才会出现，通常不主动触发）
        if (!info.haltReason) {
            const hr = clean.match(/halted due to\s+([^,]+)/i);
            if (hr) info.haltReason = hr[1].trim();
        }
        // 9) flash 'driver' found at 0x...
        if ((m = clean.match(/flash\s+'([^']+)'\s+found\s+at\s+(0x[0-9a-f]+)/i))) {
            if (!info.flashDriver) info.flashDriver = m[1];
            if (!info.flashBase) info.flashBase = m[2];
        }
        // 9.5) 部分驱动（如 H7）打印 "flash size probed value 2048"（单位 KB），补充非 "flash size =" 措辞
        if (!info.flashSize) {
            const fp = clean.match(/flash size probed value\s+(\d+)/i);
            if (fp) info.flashSize = fp[1] + " KiB";
        }
        // 10) 复用固件下载的日志解析：probe / adapter / voltage / chip / flash
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
            // IDCODE：先取任意候选地址上已知的 DEV_ID（目标选错也能命中），再采信 OpenOCD 自报值；
            // 两者都没有时，未收录 DEV_ID 仅允许从目标家族的 IDCODE 地址回退。
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
            // 由 DEV_ID 推断实际芯片家族，修正目标配置名推导的系列（用户选错 target 时仍能正确显示）
            if (info.deviceId) {
                const devNum = parseInt(info.deviceId, 16);
                const family = DEV_ID_FAMILY[devNum];
                if (family && family !== info.series) info.series = family;
            }
            // 硬件实测的 flash 驱动名优先于目标配置名修正系列（避免用户选错 target 时显示错误系列）
            const hwSeries = seriesFromFlashDriver(info.flashDriver);
            if (hwSeries && hwSeries !== info.series && !DEV_ID_FAMILY[parseInt(info.deviceId || "0", 16)])
                info.series = hwSeries;
            // Flash 容量：优先取“修正后家族”地址的寄存器值（权威，覆盖日志推导值），次取目标配置地址；
            // 均未命中时仅对 STM32 系列接受任意候选地址的有效值（避免非 STM32 芯片展示杂值）
            {
                const seriesKey = String(info.series || "").toLowerCase();
                const famFlashBase = lookupStmBase(STM32_FLASHSIZE_BASE, seriesKey);
                let kb = null;
                if (famFlashBase && flsReads[famFlashBase >>> 0] != null) kb = flsReads[famFlashBase >>> 0];
                else if (flashSizeBase && flsReads[flashSizeBase >>> 0] != null) kb = flsReads[flashSizeBase >>> 0];
                if (kb != null && kb > 0 && kb < 0xffff) info.flashSize = kb + " KiB";
                else if (!info.flashSize && /^stm32/i.test(seriesKey)) {
                    for (const a of ALL_FLASHSIZE_ADDRS) {
                        const v = flsReads[a];
                        if (v != null && v > 0 && v < 0xffff) {
                            info.flashSize = v + " KiB";
                            break;
                        }
                    }
                }
                // UID：同样按修正后家族 → 目标配置 → STM32 任意候选的顺序选值
                const famUidBase = lookupStmBase(STM32_UID_BASE, seriesKey);
                let uidWords =
                    (famUidBase && uidReads[famUidBase >>> 0]) || (uidBase && uidReads[uidBase >>> 0]) || null;
                if (!uidWords && /^stm32/i.test(seriesKey)) {
                    for (const a of ALL_UID_ADDRS) {
                        if (uidReads[a]) {
                            uidWords = uidReads[a];
                            break;
                        }
                    }
                }
                if (uidWords) info.uid = formatUid(uidWords);
            }
            // 厂商指纹：解码 ROM 表 PIDR 得到 CoreSight 设计者，对 STM32 系列做原厂/兼容判定，
            // 并推导芯片设计厂商（Arm 内核 ROM 表或读取失败时保持未知）
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
            // 拿到芯片层关键信息即视为成功；仅有适配器层字段（探针名/时钟/目标名）但存在错误时仍报错
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
