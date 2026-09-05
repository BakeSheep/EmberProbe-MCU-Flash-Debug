"use strict";
const CORTEX_M_PARTS = {
    0xc20: "Cortex-M0",
    0xc60: "Cortex-M0+",
    0xc21: "Cortex-M1",
    0xc23: "Cortex-M3",
    0xc24: "Cortex-M4",
    0xc27: "Cortex-M7",
    0xd20: "Cortex-M23",
    0xd21: "Cortex-M33",
    0xd22: "Cortex-M35P",
    0xd23: "Cortex-M55",
    0xd24: "Cortex-M85"
};
const IMPLEMENTERS = { 0x41: "ARM", 0x44: "DEC", 0x4a: "Fujitsu", 0x51: "Qualcomm", 0x56: "Marvell", 0x69: "Intel" };
const STM32_UID_BASE = {
    stm32f0x: 0x1ffff7ac,
    stm32f1x: 0x1ffff7e8,
    stm32f2x: 0x1fff7a10,
    stm32f3x: 0x1ffff7ac,
    stm32f4x: 0x1fff7a10,
    stm32f7x: 0x1ff0f420,
    stm32g0x: 0x1fff7590,
    stm32g4x: 0x1fff7590,
    stm32h7x: 0x1ff1e800,
    stm32l0: 0x1ff80050,
    stm32l1: 0x1ff80050,
    stm32l4x: 0x1fff7590,
    stm32wbx: 0x1fff7590,
    stm32wlx: 0x1fff7590
};
const STM32_IDCODE_BASE = {
    stm32f0x: 0x40015800,
    stm32g0x: 0x40015800,
    stm32l0: 0x40015800,
    stm32h7x: 0x5c001000,
    stm32f1x: 0xe0042000,
    stm32f2x: 0xe0042000,
    stm32f3x: 0xe0042000,
    stm32f4x: 0xe0042000,
    stm32f7x: 0xe0042000,
    stm32l1: 0xe0042000,
    stm32l4x: 0xe0042000,
    stm32g4x: 0xe0042000,
    stm32wbx: 0xe0042000,
    stm32wlx: 0xe0042000
};
const STM32_FLASHSIZE_BASE = {
    stm32f0x: 0x1ffff7cc,
    stm32f1x: 0x1ffff7e0,
    stm32f2x: 0x1fff7a22,
    stm32f3x: 0x1ffff7cc,
    stm32f4x: 0x1fff7a22,
    stm32f7x: 0x1ff0f442,
    stm32g0x: 0x1fff75e0,
    stm32g4x: 0x1fff75e0,
    stm32h7x: 0x1ff1e880,
    stm32l0: 0x1ff8007c,
    stm32l4x: 0x1fff75e0,
    stm32wbx: 0x1fff75e0,
    stm32wlx: 0x1fff75e0
};
const CPUID_ADDR = 0xe000ed00;
const CPUID_HEX = "0x" + CPUID_ADDR.toString(16);
const ROM_PIDR4_ADDR = 0xe00fffd0;
const ROM_PIDR0_ADDR = 0xe00fffe0;
const ROM_CIDR_ADDR = 0xe00ffff0;
const CLASSIC_IDCODE_ADDR = 0xe0042000;
const FALLBACK_FLASHSIZE_ADDRS = [0x1ffff7e0, 0x1fff7a22];
const FALLBACK_UID_ADDRS = [0x1ffff7e8, 0x1fff7a10];
const ALL_IDCODE_ADDRS = Array.from(new Set([CLASSIC_IDCODE_ADDR, ...Object.values(STM32_IDCODE_BASE)]));
const ALL_FLASHSIZE_ADDRS = Array.from(new Set([...FALLBACK_FLASHSIZE_ADDRS, ...Object.values(STM32_FLASHSIZE_BASE)]));
const ALL_UID_ADDRS = Array.from(new Set([...FALLBACK_UID_ADDRS, ...Object.values(STM32_UID_BASE)]));
const IDCODE_ADDR_SET = new Set(ALL_IDCODE_ADDRS);
const FLASHSIZE_ADDR_SET = new Set(ALL_FLASHSIZE_ADDRS);
const UID_ADDR_SET = new Set(ALL_UID_ADDRS);
const DEV_ID_FAMILY = {
    0x410: "STM32F1x",
    0x412: "STM32F1x",
    0x414: "STM32F1x",
    0x430: "STM32F1x",
    0x411: "STM32F2x",
    0x413: "STM32F4x",
    0x419: "STM32F4x",
    0x421: "STM32F4x",
    0x423: "STM32F4x",
    0x431: "STM32F4x",
    0x433: "STM32F4x",
    0x434: "STM32F4x",
    0x441: "STM32F4x",
    0x448: "STM32F4x",
    0x463: "STM32F4x",
    0x422: "STM32F3x",
    0x432: "STM32F3x",
    0x438: "STM32F3x",
    0x439: "STM32F3x",
    0x444: "STM32F3x",
    0x446: "STM32F3x",
    0x449: "STM32F7x",
    0x451: "STM32F7x",
    0x452: "STM32F7x",
    0x450: "STM32H7x",
    0x480: "STM32H7x",
    0x460: "STM32G0x",
    0x466: "STM32G0x",
    0x467: "STM32G0x",
    0x483: "STM32G0x",
    0x468: "STM32G4x",
    0x469: "STM32G4x",
    0x470: "STM32G4x",
    0x415: "STM32L4x",
    0x435: "STM32L4x",
    0x461: "STM32L4x",
    0x462: "STM32L4x",
    0x471: "STM32L4x",
    0x472: "STM32L4x",
    0x416: "STM32L1x",
    0x427: "STM32L0x",
    0x425: "STM32L0x",
    0x417: "STM32L0x",
    0x420: "STM32F0x",
    0x426: "STM32F0x",
    0x428: "STM32F0x",
    0x495: "STM32WBx"
};
const JEP106_DESIGNERS = {
    "0:0x0e": "Freescale (NXP)",
    "0:0x15": "NXP",
    "0:0x17": "Texas Instruments",
    "0:0x1f": "Atmel (Microchip)",
    "0:0x20": "STMicroelectronics",
    "0:0x29": "Microchip",
    "0:0x34": "Cypress (Infineon)",
    "0:0x41": "Infineon",
    "0:0x65": "Analog Devices",
    "2:0x21": "Silicon Labs",
    "2:0x44": "Nordic Semiconductor",
    "4:0x23": "Renesas",
    "4:0x3b": "Arm",
    "4:0x71": "Toshiba",
    "6:0x48": "GigaDevice",
    "7:0x21": "Fudan Microelectronics",
    "7:0x36": "HiSilicon",
    "7:0x51": "GigaDevice (Beijing)",
    "8:0x1b": "Ambiq Micro",
    "8:0x2d": "Nuvoton",
    "8:0x79": "Realtek",
    "9:0x05": "Puya Semiconductor",
    "9:0x13": "Raspberry Pi",
    "9:0x3b": "Artery Technology",
    "9:0x4f": "Puya Semiconductor (Shenzhen)",
    "11:0x23": "Apex Microelectronics (Geehy)",
    "11:0x2d": "Goodix",
    "11:0x68": "Hangshun Chip Technology",
    "12:0x12": "Espressif"
};
const ST_JEP106_KEY = "0:0x20";
const ARM_JEP106_KEY = "4:0x3b";
const COMPAT_BRANDS = {
    "11:0x23": "Geehy APM32",
    "6:0x48": "GigaDevice GD32",
    "7:0x51": "GigaDevice GD32",
    "9:0x3b": "Artery AT32",
    "11:0x68": "HK32",
    "9:0x05": "Puya PY32",
    "9:0x4f": "Puya PY32",
    "7:0x21": "Fudan FM33"
};
function decodeRomPidr(pidr03, pidr47, cidr) {
    if (!Array.isArray(pidr03) || pidr03.length < 4 || !Array.isArray(pidr47) || pidr47.length < 1) return null;
    if (!Array.isArray(cidr) || cidr.length < 4) return null;
    // CIDR 前导码固定为 0x0D / 0xX0 / 0x05 / 0xB1（CIDR1 高 4 位为组件类型）
    if (
        (cidr[0] & 0xff) !== 0x0d ||
        (cidr[1] & 0x0f) !== 0x00 ||
        (cidr[2] & 0xff) !== 0x05 ||
        (cidr[3] & 0xff) !== 0xb1
    )
        return null;
    const p0 = pidr03[0] & 0xff,
        p1 = pidr03[1] & 0xff,
        p2 = pidr03[2] & 0xff,
        p4 = pidr47[0] & 0xff;
    if (!(p2 & 0x08)) return null; // 未使用 JEDEC 分配的设计者代码
    const id = ((p2 & 0x07) << 4) | ((p1 >>> 4) & 0x0f); // JEP106 识别码（7 位，不含奇偶位）
    const cont = p4 & 0x0f; // JEP106 延续码个数（bank）
    const key = cont + ":0x" + id.toString(16).padStart(2, "0");
    const part = ((p1 & 0x0f) << 8) | p0; // ST 芯片此值等于 DEV_ID，可作交叉校验
    return {
        key,
        designer: JEP106_DESIGNERS[key] || "",
        code: "JEP106 bank " + cont + ", 0x" + id.toString(16).toUpperCase().padStart(2, "0"),
        part: "0x" + part.toString(16).toUpperCase()
    };
}
function assessAuthenticity(series, designerKey) {
    const none = { authenticity: "", compatVendor: "", compatBrand: "" };
    if (!designerKey || !/^stm32/i.test(String(series || ""))) return none;
    if (designerKey === ST_JEP106_KEY) return { authenticity: "genuine", compatVendor: "", compatBrand: "" };
    if (designerKey === ARM_JEP106_KEY) return none; // 内核 ROM 表不携带芯片厂商信息，无法判定
    return {
        authenticity: "compatible",
        compatVendor: JEP106_DESIGNERS[designerKey] || "",
        compatBrand: COMPAT_BRANDS[designerKey] || ""
    };
}
function deriveVendor(series, rom) {
    if (rom && rom.designer && rom.key !== ARM_JEP106_KEY) return rom.designer;
    return "";
}
function chooseIdcode(idcMap, preferredAddr) {
    const addrs = Object.keys(idcMap || {})
        .map(Number)
        .sort((x, y) => x - y);
    for (const a of addrs) {
        const w = idcMap[a] >>> 0,
            dev = w & 0xfff;
        if (dev !== 0 && dev !== 0xfff && DEV_ID_FAMILY[dev]) return w;
    }
    const preferred = Number(preferredAddr) >>> 0;
    if (preferredAddr && Object.hasOwn(idcMap || {}, preferred)) {
        const w = idcMap[preferred] >>> 0,
            dev = w & 0xfff;
        if (dev !== 0 && dev !== 0xfff) return w;
    }
    return null;
}
function decodeCpuid(word) {
    if (word === null || word === undefined || !Number.isFinite(Number(word))) return null;
    const u = Number(word) >>> 0;
    const implementer = (u >>> 24) & 0xff;
    const variant = (u >>> 20) & 0xf;
    const partno = (u >>> 4) & 0xfff;
    const revision = u & 0xf;
    return {
        raw: "0x" + u.toString(16).toUpperCase().padStart(8, "0"),
        core: CORTEX_M_PARTS[partno] || "",
        partno: "0x" + partno.toString(16).toUpperCase(),
        implementer: IMPLEMENTERS[implementer] || "0x" + implementer.toString(16).toUpperCase(),
        revision: `r${variant}p${revision}`
    };
}
function parseMdwWord(line, addr) {
    const m = String(line || "").match(/0x0*([0-9a-f]+)\s*:\s*([0-9a-f]{8})\b/i);
    if (!m) return null;
    if (addr !== undefined && parseInt(m[1], 16) !== addr >>> 0) return null;
    return parseInt(m[2], 16);
}
function parseMdwDump(line) {
    const m = String(line || "").match(/0x0*([0-9a-f]+)\s*:\s*((?:[0-9a-f]{8}(?:\s+|$))+)/i);
    if (!m) return null;
    const words = m[2]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => parseInt(w, 16));
    if (!words.length) return null;
    return { addr: parseInt(m[1], 16), words };
}
function parseRegLine(line) {
    const m = String(line || "").match(/(?:^|\s)(pc|sp|lr|msp|psp|r13|r14|r15)\s*\(\/\d+\)\s*:\s*0x([0-9a-f]+)/i);
    if (!m) return null;
    const alias = { r13: "sp", r14: "lr", r15: "pc" };
    const name = alias[m[1].toLowerCase()] || m[1].toLowerCase();
    return { name, value: "0x" + m[2].toUpperCase() };
}
function parseKv(line) {
    const m = String(line || "").match(/EP_KV\s+(\w+)\s+(.+?)\s*$/);
    if (!m) return null;
    return { key: m[1], value: m[2].trim() };
}
function splitIdcode(idcode) {
    if (idcode === null || idcode === undefined || idcode === "") return null;
    if (typeof idcode === "string" && !/^(?:0x)?[0-9a-f]+$/i.test(idcode.trim())) return null;
    const parsed = typeof idcode === "string" ? Number.parseInt(idcode, 16) : Number(idcode);
    if (!Number.isFinite(parsed)) return null;
    const u = parsed >>> 0;
    const dev = u & 0xfff;
    const rev = (u >>> 16) & 0xffff;
    return {
        deviceId: "0x" + dev.toString(16).toUpperCase(),
        revId: rev ? "0x" + rev.toString(16).toUpperCase() : ""
    };
}
function normalizeTransport(s) {
    const t = String(s || "").toLowerCase();
    if (t.includes("jtag")) return "JTAG";
    if (t.includes("swd")) return "SWD";
    return "";
}
function seriesFromTarget(target) {
    const n = String(target || "")
        .split(/[\\/]/)
        .pop()
        .replace(/\.cfg$/i, "")
        .split("_")[0];
    if (!n) return "";
    if (/^stm32/i.test(n)) return n.replace(/^stm32([a-z])/i, (m, p1) => "STM32" + p1.toUpperCase());
    return n.toUpperCase();
}
function seriesFromFlashDriver(driver) {
    const n = String(driver || "").trim();
    if (!n) return "";
    if (/^stm32/i.test(n)) return n.replace(/^stm32([a-z])/i, (m, p1) => "STM32" + p1.toUpperCase());
    return "";
}
function lookupStmBase(map, target) {
    const name = String(target || "")
        .split(/[\\/]/)
        .pop()
        .replace(/\.cfg$/i, "")
        .toLowerCase();
    for (const key of Object.keys(map)) {
        if (name.startsWith(key)) return map[key];
    }
    return 0;
}
function uidBaseForTarget(target) {
    return lookupStmBase(STM32_UID_BASE, target);
}
function idcodeBaseForTarget(target) {
    return lookupStmBase(STM32_IDCODE_BASE, target);
}
function flashSizeBaseForTarget(target) {
    return lookupStmBase(STM32_FLASHSIZE_BASE, target);
}
function formatUid(words) {
    if (!Array.isArray(words) || !words.length) return "";
    return "0x" + words.map((w) => (w >>> 0).toString(16).toUpperCase().padStart(8, "0")).join("");
}
function buildChipInfoCommands(target) {
    const uidBase = uidBaseForTarget(target);
    const idcodeBase = idcodeBaseForTarget(target);
    const flashSizeBase = flashSizeBaseForTarget(target);
    const preferredReads = [];
    if (idcodeBase) preferredReads.push("catch { echo [mdw 0x" + idcodeBase.toString(16) + "] }");
    if (flashSizeBase) preferredReads.push("catch { echo [mdw 0x" + flashSizeBase.toString(16) + "] }");
    if (uidBase) preferredReads.push("catch { echo [mdw 0x" + uidBase.toString(16) + " 3] }");
    const exhaustiveReads = ["catch { flash probe 0 }"];
    for (const a of ALL_IDCODE_ADDRS) exhaustiveReads.push("catch { echo [mdw 0x" + a.toString(16) + "] }");
    for (const a of ALL_FLASHSIZE_ADDRS) exhaustiveReads.push("catch { echo [mdw 0x" + a.toString(16) + "] }");
    for (const a of ALL_UID_ADDRS) exhaustiveReads.push("catch { echo [mdw 0x" + a.toString(16) + " 3] }");
    // 运行中的 H7 对调试状态切换更敏感：这里只访问当前 target 的已知寄存器，
    // 不执行 flash probe、跨系列地址扫描或 halt/resume。原本已暂停时才允许完整探测。
    const identityCmd =
        'catch { if {[[target current] curstate] eq "halted"} { ' +
        exhaustiveReads.join("; ") +
        " } else { " +
        preferredReads.join("; ") +
        " } }";
    return [
        "init",
        "catch { poll }",
        'catch { echo "EP_KV name [target current]" }',
        'catch { echo "EP_KV state [[target current] curstate]" }',
        'catch { echo "EP_KV endian [[target current] cget -endian]" }',
        'catch { echo "EP_KV transport [transport select]" }',
        `catch { echo [mdw ${CPUID_HEX}] }`,
        `catch { echo [mdw 0x${ROM_PIDR4_ADDR.toString(16)} 4] }`,
        `catch { echo [mdw 0x${ROM_PIDR0_ADDR.toString(16)} 4] }`,
        `catch { echo [mdw 0x${ROM_CIDR_ADDR.toString(16)} 4] }`,
        identityCmd,
        'catch { if {[[target current] curstate] eq "halted"} { catch { echo [reg pc] }; catch { echo [reg sp] }; catch { echo [reg lr] } } }',
        "shutdown"
    ];
}
function normalizeFlashSize(text) {
    return String(text || "")
        .replace(/kbytes?/i, "KiB")
        .replace(/\s+/g, " ")
        .trim();
}
module.exports = {
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
};
