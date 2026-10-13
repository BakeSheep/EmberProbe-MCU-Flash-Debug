"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const {
    buildChipInfoCommands,
    decodeCpuid,
    parseMdwWord,
    parseMdwDump,
    parseRegLine,
    parseKv,
    splitIdcode,
    normalizeTransport,
    seriesFromTarget,
    seriesFromFlashDriver,
    uidBaseForTarget,
    idcodeBaseForTarget,
    flashSizeBaseForTarget,
    formatUid,
    normalizeFlashSize,
    decodeRomPidr,
    assessAuthenticity,
    deriveVendor,
    chooseIdcode,
    ALL_IDCODE_ADDRS,
    DEV_ID_FAMILY,
    STM32_SERIES_CORES,
    coreMatchesSeries
} = require("../src/chipInfo");
const { createChipParser } = require("../src/chip/parser");

// SCB CPUID 0x410FC241 → Cortex-M4 r0p1（ARM）
const m4 = decodeCpuid(0x410fc241);
assert.strictEqual(m4.core, "Cortex-M4");
assert.strictEqual(m4.revision, "r0p1");
assert.strictEqual(m4.implementer, "ARM");
assert.strictEqual(m4.raw, "0x410FC241");

// 覆盖常见 Cortex-M part number（bits[15:4]）
assert.strictEqual(decodeCpuid(0x410cc200).core, "Cortex-M0");
assert.strictEqual(decodeCpuid(0x410cc601).core, "Cortex-M0+");
assert.strictEqual(decodeCpuid(0x412fc231).core, "Cortex-M3");
assert.strictEqual(decodeCpuid(0x410fc271).core, "Cortex-M7");
assert.strictEqual(decodeCpuid(0x410cd200).core, "Cortex-M23");

// 未知 part number：core 为空但仍给出 raw / revision
const unknown = decodeCpuid(0x41000000);
assert.strictEqual(unknown.core, "");
assert.ok(unknown.raw.startsWith("0x"));
assert.strictEqual(unknown.revision, "r0p0");

// 非法输入返回 null
assert.strictEqual(decodeCpuid(null), null);
assert.strictEqual(decodeCpuid(undefined), null);
assert.strictEqual(decodeCpuid(NaN), null);

// mdw 输出行解析（大小写不敏感，带地址校验）
assert.strictEqual(parseMdwWord("0xe000ed00: 410fc241", 0xe000ed00), 0x410fc241);
assert.strictEqual(parseMdwWord("0xE000ED00: 410FC241"), 0x410fc241);
assert.strictEqual(parseMdwWord("0x20000000: deadbeef", 0xe000ed00), null); // 地址不匹配应丢弃
assert.strictEqual(parseMdwWord("Info : hla_swd"), null); // 非内存转储行

// EP_KV 标记行解析
assert.deepStrictEqual(parseKv("EP_KV name stm32f4x.cpu"), { key: "name", value: "stm32f4x.cpu" });
assert.deepStrictEqual(parseKv("EP_KV state running"), { key: "state", value: "running" });
assert.deepStrictEqual(parseKv("EP_KV endian little"), { key: "endian", value: "little" });
assert.strictEqual(parseKv("random line"), null);

// parseMdwDump / formatUid：UID 三字转储
const dump = parseMdwDump("0x1ff1e800: 00360026 32355114 20393443");
assert.strictEqual(dump.addr, 0x1ff1e800);
assert.deepStrictEqual(dump.words, [0x00360026, 0x32355114, 0x20393443]);
assert.strictEqual(parseMdwDump("Info : hla_swd"), null);
assert.strictEqual(formatUid([0x00360026, 0x32355114, 0x20393443]), "0x003600263235511420393443");

// splitIdcode：STM32 DBGMCU_IDCODE 拆分为 DEV_ID / REV_ID
const id = splitIdcode(0x10076413);
assert.strictEqual(id.deviceId, "0x413");
assert.strictEqual(id.revId, "0x1007");
const idBare = splitIdcode("0x450");
assert.strictEqual(idBare.deviceId, "0x450");
assert.strictEqual(idBare.revId, "");
assert.strictEqual(splitIdcode(""), null);
assert.strictEqual(splitIdcode("not-a-device-id"), null);
assert.strictEqual(splitIdcode("0x450 trailing"), null);

// parseRegLine：寄存器行（r13/r14/r15 归一化为 sp/lr/pc，值转大写）
assert.deepStrictEqual(parseRegLine("pc (/32): 0x080034ac"), { name: "pc", value: "0x080034AC" });
assert.deepStrictEqual(parseRegLine("sp (/32): 0x2407ff90"), { name: "sp", value: "0x2407FF90" });
assert.deepStrictEqual(parseRegLine("r15 (/32): 0x08000abc"), { name: "pc", value: "0x08000ABC" });
assert.strictEqual(parseRegLine("Info : something"), null);

// normalizeTransport：传输协议归一化
assert.strictEqual(normalizeTransport("hla_swd"), "SWD");
assert.strictEqual(normalizeTransport("dapdirect_swd"), "SWD");
assert.strictEqual(normalizeTransport("jtag"), "JTAG");
assert.strictEqual(normalizeTransport(""), "");

// seriesFromTarget / uidBaseForTarget：由目标配置名推断系列与 UID 基址
assert.strictEqual(seriesFromTarget("stm32h7x.cfg"), "STM32H7x");
assert.strictEqual(seriesFromTarget("geehy/apm32f4x.cfg"), "APM32F4X");
assert.strictEqual(seriesFromTarget("stm32f4x_dual.cfg"), "STM32F4x");
assert.strictEqual(uidBaseForTarget("stm32h7x.cfg"), 0x1ff1e800);
assert.strictEqual(uidBaseForTarget("stm32f4x.cfg"), 0x1fff7a10);
assert.strictEqual(uidBaseForTarget("nrf52.cfg"), 0);

// seriesFromFlashDriver：由 flash 驱动名推断系列（硬件实测优先）
assert.strictEqual(seriesFromFlashDriver("stm32f1x"), "STM32F1x");
assert.strictEqual(seriesFromFlashDriver("stm32h7x"), "STM32H7x");
assert.strictEqual(seriesFromFlashDriver("stm32l4x"), "STM32L4x");
assert.strictEqual(seriesFromFlashDriver(""), "");
assert.strictEqual(seriesFromFlashDriver("nrf5"), "");

// idcodeBaseForTarget / flashSizeBaseForTarget：DBGMCU_IDCODE 与 FLASHSIZE 寄存器基址（H7 与经典型号）
assert.strictEqual(idcodeBaseForTarget("stm32h7x.cfg"), 0x5c001000);
assert.strictEqual(idcodeBaseForTarget("stm32f4x.cfg"), 0xe0042000);
assert.strictEqual(idcodeBaseForTarget("geehy/apm32f4x.cfg"), 0xe0042000);
assert.strictEqual(idcodeBaseForTarget("stm32f0x.cfg"), 0x40015800);
assert.strictEqual(flashSizeBaseForTarget("stm32h7x.cfg"), 0x1ff1e880);
assert.strictEqual(flashSizeBaseForTarget("stm32f4x.cfg"), 0x1fff7a22);
assert.strictEqual(flashSizeBaseForTarget("nrf52.cfg"), 0);

// normalizeFlashSize：kbytes → KiB
assert.strictEqual(normalizeFlashSize("1024 kbytes"), "1024 KiB");

// decodeRomPidr：CoreSight ROM 表厂商指纹解码
const CIDR_OK = [0x0d, 0x10, 0x05, 0xb1];
// 真 STM32F407：设计者 ST（bank 0, 0x20），器件号 = DEV_ID 0x413（OpenOCD 显示为 Peripheral ID 0x00000A0413）
const stRom = decodeRomPidr([0x13, 0x04, 0x0a, 0x00], [0x00, 0, 0, 0], CIDR_OK);
assert.strictEqual(stRom.key, "0:0x20");
assert.strictEqual(stRom.designer, "STMicroelectronics");
assert.strictEqual(stRom.part, "0x413");
// Arm 默认 ROM 表（GD32/CH32 等兼容片常见）：设计者 Arm（bank 4, 0x3B），Cortex-M3 ROM 器件号 0x4C3
const armRom = decodeRomPidr([0xc3, 0xb4, 0x0b, 0x00], [0x04, 0, 0, 0], CIDR_OK);
assert.strictEqual(armRom.key, "4:0x3b");
assert.strictEqual(armRom.designer, "Arm");
assert.strictEqual(armRom.part, "0x4C3");
// Geehy（珠海极海，Apex 旗下）：bank 11, 0x23
const geehyRom = decodeRomPidr([0x13, 0x34, 0x0a, 0x00], [0x0b, 0, 0, 0], CIDR_OK);
assert.strictEqual(geehyRom.key, "11:0x23");
assert.strictEqual(geehyRom.designer, "Apex Microelectronics (Geehy)");
// CIDR 前导码非法（总线错误/杂值）→ null；未用 JEDEC 编码（PIDR2 bit3=0）→ null
assert.strictEqual(decodeRomPidr([0x13, 0x04, 0x0a, 0x00], [0x00, 0, 0, 0], [0, 0, 0, 0]), null);
assert.strictEqual(decodeRomPidr([0x13, 0x04, 0x02, 0x00], [0x00, 0, 0, 0], CIDR_OK), null);
assert.strictEqual(decodeRomPidr(null, null, CIDR_OK), null);

// assessAuthenticity：仅对宣称 STM32 的芯片做原厂/兼容判定
assert.strictEqual(assessAuthenticity("STM32F4x", "0:0x20").authenticity, "genuine");
const apm = assessAuthenticity("STM32F4x", "11:0x23");
assert.strictEqual(apm.authenticity, "compatible");
assert.strictEqual(apm.compatBrand, "Geehy APM32");
assert.strictEqual(apm.compatVendor, "Apex Microelectronics (Geehy)");
const gd = assessAuthenticity("STM32F1x", "7:0x51");
assert.strictEqual(gd.compatBrand, "GigaDevice GD32");
// Arm 内核自带 ROM 表（M7/M33 等原厂 ST 芯片也会读到）：不能判为兼容芯片
assert.strictEqual(assessAuthenticity("STM32H7x", "4:0x3b").authenticity, "");
assert.strictEqual(assessAuthenticity("STM32F4x", "4:0x3b").authenticity, "");
// 非 STM32 系列（如 nRF52 由 Arm 设计 ROM 表）不参与判定
assert.strictEqual(assessAuthenticity("NRF52", "4:0x3b").authenticity, "");
assert.strictEqual(assessAuthenticity("STM32F4x", "").authenticity, "");

// deriveVendor：仅采信 ROM 表中已知的非 Arm 硬件厂商码；无法确认时保持未知
assert.strictEqual(deriveVendor("STM32F4x", { key: "0:0x20", designer: "STMicroelectronics" }), "STMicroelectronics");
assert.strictEqual(
    deriveVendor("STM32F4x", { key: "11:0x23", designer: "Apex Microelectronics (Geehy)" }),
    "Apex Microelectronics (Geehy)"
);
assert.strictEqual(deriveVendor("STM32H7x", { key: "4:0x3b", designer: "Arm" }), "");
assert.strictEqual(deriveVendor("STM32H7x", null), "");
assert.strictEqual(deriveVendor("NRF52", { key: "2:0x44", designer: "Nordic Semiconductor" }), "Nordic Semiconductor");
assert.strictEqual(deriveVendor("NRF52", null), "");

// chooseIdcode：优先取 DEV_ID 已知的读数（H750 误选 f1x 目标时，经典地址读到杂值、H7 地址读到 0x450）
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00002001, 0x5c001000: 0x10036450 }), 0x10036450);
// 无已知 DEV_ID 时：只接受目标家族地址上的读数，其它候选地址的杂值不能回退
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00002001 }, 0xe0042000), 0x00002001);
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00002001 }, 0x5c001000), null);
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00002001 }), null);
// 全 0/全 F 的 DEV_ID 视为无效
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00000000, 0x40015800: 0x0000ffff }, 0xe0042000), null);
assert.strictEqual(chooseIdcode({}, 0xe0042000), null);
// 候选地址集应覆盖经典/F0系/H7 三类 DBGMCU 地址
assert.ok(
    ALL_IDCODE_ADDRS.includes(0xe0042000) &&
        ALL_IDCODE_ADDRS.includes(0x40015800) &&
        ALL_IDCODE_ADDRS.includes(0x5c001000)
);

// 芯片信息读取不得改变运行目标状态。H7 running 分支只读本系列身份寄存器，
// 已知型号即便暂停也不应扫描其他系列寄存器。
const chipInfoCommands = buildChipInfoCommands("stm32h7x.cfg");
const allChipInfoCommands = chipInfoCommands.join("\n");
assert.ok(!/(?:^|[;{\s])halt(?:[;}\s]|$)/.test(allChipInfoCommands), "chip info must never halt a running target");
assert.ok(!/(?:^|[;{\s])resume(?:[;}\s]|$)/.test(allChipInfoCommands), "chip info must never resume a target");
assert.ok(!allChipInfoCommands.includes("flash probe 0"));
const runningIdentityBranch = allChipInfoCommands;
assert.ok(runningIdentityBranch.includes("mdw 0x5c001000"));
assert.ok(runningIdentityBranch.includes("mdw 0x1ff1e880"));
assert.ok(runningIdentityBranch.includes("mdw 0x1ff1e800 3"));
assert.ok(!runningIdentityBranch.includes("flash probe 0"));
assert.ok(!runningIdentityBranch.includes("mdw 0xe0042000"), "H7 running branch must not scan classic STM32 addresses");

// Geehy APM32F4 uses the classic DBGMCU IDCODE address. A targeted read avoids
// probing unrelated STM32 memory ranges when the core is halted.
const apmCommands = buildChipInfoCommands("geehy/apm32f4x.cfg").join("\n");
assert.ok(apmCommands.includes("mdw 0xe0042000"));
assert.ok(!apmCommands.includes("flash probe 0"));
assert.ok(!apmCommands.includes("mdw 0x1fff7a10"));
const apmParser = createChipParser("geehy/apm32f4x.cfg");
apmParser.handleLine("0xe0042000: 10076413");
const apmInfo = apmParser.finish(0);
assert.strictEqual(apmInfo.series, "APM32F4X");
assert.strictEqual(apmInfo.deviceId, "0x413");

// CPUID 部件号：M55/M85/M52/M35P 与 OpenOCD cortex_m.h 一致
assert.strictEqual(decodeCpuid(0x410fd220).core, "Cortex-M55");
assert.strictEqual(decodeCpuid(0x410fd230).core, "Cortex-M85");
assert.strictEqual(decodeCpuid(0x410fd240).core, "Cortex-M52");
assert.strictEqual(decodeCpuid(0x410fd310).core, "Cortex-M35P");
assert.strictEqual(decodeCpuid(0x410fd210).core, "Cortex-M33");

// DEV_ID → 系列：曾错配的型号，以及每个系列的内核与 STM32_SERIES_CORES 一致
const expectedFamilies = {
    0x420: "STM32F1x",
    0x428: "STM32F1x",
    0x418: "STM32F1x",
    0x444: "STM32F0x",
    0x448: "STM32F0x",
    0x427: "STM32L1x",
    0x470: "STM32L4x",
    0x472: "STM32L5x",
    0x483: "STM32H7x",
    0x479: "STM32G4x",
    0x456: "STM32G0x",
    0x497: "STM32WLx"
};
for (const [dev, family] of Object.entries(expectedFamilies))
    assert.strictEqual(DEV_ID_FAMILY[dev], family, "DEV_ID 0x" + Number(dev).toString(16));
assert.strictEqual(DEV_ID_FAMILY[0x426], undefined);
for (const family of new Set(Object.values(DEV_ID_FAMILY)))
    assert.ok(STM32_SERIES_CORES[family], "missing core list for " + family);
assert.strictEqual(coreMatchesSeries("Cortex-M7", "STM32H7x"), true);
assert.strictEqual(coreMatchesSeries("Cortex-M4", "STM32H7x"), true);
assert.strictEqual(coreMatchesSeries("Cortex-M0+", "STM32H7x"), false);
assert.strictEqual(coreMatchesSeries("", "STM32H7x"), null);
assert.strictEqual(coreMatchesSeries("Cortex-M4", "NRF52"), null);

function parseChip(target, lines) {
    const parser = createChipParser(target);
    for (const line of lines) parser.handleLine(line);
    return parser.finish(0);
}
// H723 误选 stm32g0x 目标：DEV_ID 0x483 应纠正为 H7，内核一致
const h723 = parseChip("stm32g0x.cfg", ["0xe000ed00: 411fc272", "0x40015800: 10016483"]);
assert.strictEqual(h723.core, "Cortex-M7");
assert.strictEqual(h723.series, "STM32H7x");
assert.strictEqual(h723.coreMismatch, "");
// F100（M3）DEV_ID 0x420 属 F1，而非 F0
const f100 = parseChip("stm32f1x.cfg", ["0xe000ed00: 411fc231", "0xe0042000: 10016420"]);
assert.strictEqual(f100.series, "STM32F1x");
assert.strictEqual(f100.coreMismatch, "");
// 内核与 DEV_ID 家族冲突：不改写系列，并给出不一致说明
const clash = parseChip("stm32f4x.cfg", ["0xe000ed00: 410fc241", "0xe0042000: 10006460"]);
assert.strictEqual(clash.series, "STM32F4x");
assert.strictEqual(clash.coreMismatch, "Cortex-M4 ≠ STM32G0x (DEV_ID 0x460)");
// 无 DEV_ID 时按目标系列校验内核
const wrongTarget = parseChip("stm32f1x.cfg", ["0xe000ed00: 410cc601"]);
assert.strictEqual(wrongTarget.coreMismatch, "Cortex-M0+ ≠ STM32F1x");
// OpenOCD "processor detected" 行中的 M35P 不应被截断
const m35p = parseChip("stm32f1x.cfg", ["Info : [x.cpu] Cortex-M35P r1p0 processor detected"]);
assert.strictEqual(m35p.core, "Cortex-M35P");
assert.strictEqual(m35p.coreRevision, "r1p0");
// L5 等未收录地址的家族不得从其它家族地址回退 Flash 容量/UID
const l5 = parseChip("stm32l5x.cfg", ["0xe000ed00: 410fd214", "0xe0042000: 10006472", "0x1fff7a22: 00000400"]);
assert.strictEqual(l5.series, "STM32L5x");
assert.strictEqual(l5.flashSize, "");

scenario("Report fresh unknown H7 target state and polling diagnostics", () => {
    const parser = createChipParser("stm32h7x.cfg");
    parser.handleLine("0xe000ed00: 411fc271");
    parser.handleLine("EP_KV state unknown");
    parser.handleLine("EP_KV stateError target polling failed");
    const info = parser.finish(0);
    assert.strictEqual(info.targetState, "unknown");
    assert.strictEqual(info.stateError, "target polling failed");
});

console.log("Chip info tests passed");
