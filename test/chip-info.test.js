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

// SCB CPUID 0x410FC241 -> Cortex-M4 r0p1 (ARM)
const m4 = decodeCpuid(0x410fc241);
assert.strictEqual(m4.core, "Cortex-M4");
assert.strictEqual(m4.revision, "r0p1");
assert.strictEqual(m4.implementer, "ARM");
assert.strictEqual(m4.raw, "0x410FC241");

// Common Cortex-M part numbers (bits[15:4])
assert.strictEqual(decodeCpuid(0x410cc200).core, "Cortex-M0");
assert.strictEqual(decodeCpuid(0x410cc601).core, "Cortex-M0+");
assert.strictEqual(decodeCpuid(0x412fc231).core, "Cortex-M3");
assert.strictEqual(decodeCpuid(0x410fc271).core, "Cortex-M7");
assert.strictEqual(decodeCpuid(0x410cd200).core, "Cortex-M23");

// Unknown part number: empty core but raw and revision are still given
const unknown = decodeCpuid(0x41000000);
assert.strictEqual(unknown.core, "");
assert.ok(unknown.raw.startsWith("0x"));
assert.strictEqual(unknown.revision, "r0p0");

// Invalid input returns null
assert.strictEqual(decodeCpuid(null), null);
assert.strictEqual(decodeCpuid(undefined), null);
assert.strictEqual(decodeCpuid(NaN), null);

// mdw output line parsing (case-insensitive, with address check)
assert.strictEqual(parseMdwWord("0xe000ed00: 410fc241", 0xe000ed00), 0x410fc241);
assert.strictEqual(parseMdwWord("0xE000ED00: 410FC241"), 0x410fc241);
assert.strictEqual(parseMdwWord("0x20000000: deadbeef", 0xe000ed00), null); // a mismatched address is dropped
assert.strictEqual(parseMdwWord("Info : hla_swd"), null); // not a memory dump line

// EP_KV marker line parsing
assert.deepStrictEqual(parseKv("EP_KV name stm32f4x.cpu"), { key: "name", value: "stm32f4x.cpu" });
assert.deepStrictEqual(parseKv("EP_KV state running"), { key: "state", value: "running" });
assert.deepStrictEqual(parseKv("EP_KV endian little"), { key: "endian", value: "little" });
assert.strictEqual(parseKv("random line"), null);

// parseMdwDump / formatUid: three-word UID dump
const dump = parseMdwDump("0x1ff1e800: 00360026 32355114 20393443");
assert.strictEqual(dump.addr, 0x1ff1e800);
assert.deepStrictEqual(dump.words, [0x00360026, 0x32355114, 0x20393443]);
assert.strictEqual(parseMdwDump("Info : hla_swd"), null);
assert.strictEqual(formatUid([0x00360026, 0x32355114, 0x20393443]), "0x003600263235511420393443");

// splitIdcode: STM32 DBGMCU_IDCODE split into DEV_ID / REV_ID
const id = splitIdcode(0x10076413);
assert.strictEqual(id.deviceId, "0x413");
assert.strictEqual(id.revId, "0x1007");
const idBare = splitIdcode("0x450");
assert.strictEqual(idBare.deviceId, "0x450");
assert.strictEqual(idBare.revId, "");
assert.strictEqual(splitIdcode(""), null);
assert.strictEqual(splitIdcode("not-a-device-id"), null);
assert.strictEqual(splitIdcode("0x450 trailing"), null);

// parseRegLine: register lines (r13/r14/r15 normalized to sp/lr/pc, values upper-cased)
assert.deepStrictEqual(parseRegLine("pc (/32): 0x080034ac"), { name: "pc", value: "0x080034AC" });
assert.deepStrictEqual(parseRegLine("sp (/32): 0x2407ff90"), { name: "sp", value: "0x2407FF90" });
assert.deepStrictEqual(parseRegLine("r15 (/32): 0x08000abc"), { name: "pc", value: "0x08000ABC" });
assert.strictEqual(parseRegLine("Info : something"), null);

// normalizeTransport: transport normalization
assert.strictEqual(normalizeTransport("hla_swd"), "SWD");
assert.strictEqual(normalizeTransport("dapdirect_swd"), "SWD");
assert.strictEqual(normalizeTransport("jtag"), "JTAG");
assert.strictEqual(normalizeTransport(""), "");

// seriesFromTarget / uidBaseForTarget: series and UID base inferred from the target configuration name
assert.strictEqual(seriesFromTarget("stm32h7x.cfg"), "STM32H7x");
assert.strictEqual(seriesFromTarget("geehy/apm32f4x.cfg"), "APM32F4X");
assert.strictEqual(seriesFromTarget("stm32f4x_dual.cfg"), "STM32F4x");
assert.strictEqual(uidBaseForTarget("stm32h7x.cfg"), 0x1ff1e800);
assert.strictEqual(uidBaseForTarget("stm32f4x.cfg"), 0x1fff7a10);
assert.strictEqual(uidBaseForTarget("nrf52.cfg"), 0);

// seriesFromFlashDriver: series inferred from the flash driver name (hardware measurement wins)
assert.strictEqual(seriesFromFlashDriver("stm32f1x"), "STM32F1x");
assert.strictEqual(seriesFromFlashDriver("stm32h7x"), "STM32H7x");
assert.strictEqual(seriesFromFlashDriver("stm32l4x"), "STM32L4x");
assert.strictEqual(seriesFromFlashDriver(""), "");
assert.strictEqual(seriesFromFlashDriver("nrf5"), "");

// idcodeBaseForTarget / flashSizeBaseForTarget: DBGMCU_IDCODE and FLASHSIZE register bases (H7 and classic parts)
assert.strictEqual(idcodeBaseForTarget("stm32h7x.cfg"), 0x5c001000);
assert.strictEqual(idcodeBaseForTarget("stm32f4x.cfg"), 0xe0042000);
assert.strictEqual(idcodeBaseForTarget("geehy/apm32f4x.cfg"), 0xe0042000);
assert.strictEqual(idcodeBaseForTarget("stm32f0x.cfg"), 0x40015800);
assert.strictEqual(flashSizeBaseForTarget("stm32h7x.cfg"), 0x1ff1e880);
assert.strictEqual(flashSizeBaseForTarget("stm32f4x.cfg"), 0x1fff7a22);
assert.strictEqual(flashSizeBaseForTarget("nrf52.cfg"), 0);

// normalizeFlashSize: kbytes -> KiB
assert.strictEqual(normalizeFlashSize("1024 kbytes"), "1024 KiB");

// decodeRomPidr: CoreSight ROM table vendor fingerprint
const CIDR_OK = [0x0d, 0x10, 0x05, 0xb1];
// Genuine STM32F407: designer ST (bank 0, 0x20), part number = DEV_ID 0x413 (OpenOCD shows Peripheral ID 0x00000A0413)
const stRom = decodeRomPidr([0x13, 0x04, 0x0a, 0x00], [0x00, 0, 0, 0], CIDR_OK);
assert.strictEqual(stRom.key, "0:0x20");
assert.strictEqual(stRom.designer, "STMicroelectronics");
assert.strictEqual(stRom.part, "0x413");
// Arm default ROM table (common on compatible chips such as GD32/CH32): designer Arm (bank 4, 0x3B), Cortex-M3 ROM part
// number 0x4C3
const armRom = decodeRomPidr([0xc3, 0xb4, 0x0b, 0x00], [0x04, 0, 0, 0], CIDR_OK);
assert.strictEqual(armRom.key, "4:0x3b");
assert.strictEqual(armRom.designer, "Arm");
assert.strictEqual(armRom.part, "0x4C3");
// Geehy (Zhuhai Geehy, part of Apex): bank 11, 0x23
const geehyRom = decodeRomPidr([0x13, 0x34, 0x0a, 0x00], [0x0b, 0, 0, 0], CIDR_OK);
assert.strictEqual(geehyRom.key, "11:0x23");
assert.strictEqual(geehyRom.designer, "Apex Microelectronics (Geehy)");
// Invalid CIDR preamble (bus error or noise) -> null; no JEDEC code (PIDR2 bit3 = 0) -> null
assert.strictEqual(decodeRomPidr([0x13, 0x04, 0x0a, 0x00], [0x00, 0, 0, 0], [0, 0, 0, 0]), null);
assert.strictEqual(decodeRomPidr([0x13, 0x04, 0x02, 0x00], [0x00, 0, 0, 0], CIDR_OK), null);
assert.strictEqual(decodeRomPidr(null, null, CIDR_OK), null);

// assessAuthenticity: only chips claiming to be STM32 get a genuine/compatible verdict
assert.strictEqual(assessAuthenticity("STM32F4x", "0:0x20").authenticity, "genuine");
const apm = assessAuthenticity("STM32F4x", "11:0x23");
assert.strictEqual(apm.authenticity, "compatible");
assert.strictEqual(apm.compatBrand, "Geehy APM32");
assert.strictEqual(apm.compatVendor, "Apex Microelectronics (Geehy)");
const gd = assessAuthenticity("STM32F1x", "7:0x51");
assert.strictEqual(gd.compatBrand, "GigaDevice GD32");
// The Arm core's own ROM table (also read on genuine ST M7/M33 parts) must not mark a chip as compatible
assert.strictEqual(assessAuthenticity("STM32H7x", "4:0x3b").authenticity, "");
assert.strictEqual(assessAuthenticity("STM32F4x", "4:0x3b").authenticity, "");
// Non-STM32 series (nRF52 with an Arm-designed ROM table, for example) are not judged
assert.strictEqual(assessAuthenticity("NRF52", "4:0x3b").authenticity, "");
assert.strictEqual(assessAuthenticity("STM32F4x", "").authenticity, "");

// deriveVendor: only trusts known non-Arm hardware vendor codes from the ROM table; otherwise unknown
assert.strictEqual(deriveVendor("STM32F4x", { key: "0:0x20", designer: "STMicroelectronics" }), "STMicroelectronics");
assert.strictEqual(
    deriveVendor("STM32F4x", { key: "11:0x23", designer: "Apex Microelectronics (Geehy)" }),
    "Apex Microelectronics (Geehy)"
);
assert.strictEqual(deriveVendor("STM32H7x", { key: "4:0x3b", designer: "Arm" }), "");
assert.strictEqual(deriveVendor("STM32H7x", null), "");
assert.strictEqual(deriveVendor("NRF52", { key: "2:0x44", designer: "Nordic Semiconductor" }), "Nordic Semiconductor");
assert.strictEqual(deriveVendor("NRF52", null), "");

// chooseIdcode: prefers a read with a known DEV_ID (with an H750 under the wrong f1x target, the classic address reads
// noise and the H7 address reads 0x450)
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00002001, 0x5c001000: 0x10036450 }), 0x10036450);
// Without a known DEV_ID only the target family's address is accepted; noise at other candidate addresses cannot be a
// fallback
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00002001 }, 0xe0042000), 0x00002001);
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00002001 }, 0x5c001000), null);
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00002001 }), null);
// All-zero or all-F DEV_IDs are invalid
assert.strictEqual(chooseIdcode({ 0xe0042000: 0x00000000, 0x40015800: 0x0000ffff }, 0xe0042000), null);
assert.strictEqual(chooseIdcode({}, 0xe0042000), null);
// The candidate set covers the classic, F0 and H7 DBGMCU addresses
assert.ok(
    ALL_IDCODE_ADDRS.includes(0xe0042000) &&
        ALL_IDCODE_ADDRS.includes(0x40015800) &&
        ALL_IDCODE_ADDRS.includes(0x5c001000)
);

// Reading chip information must not change the target's run state. The H7 running branch reads only that series'
// identity registers, and a known part does not scan other series' registers even when halted.
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

// CPUID part numbers: M55/M85/M52/M35P as in OpenOCD's cortex_m.h
assert.strictEqual(decodeCpuid(0x410fd220).core, "Cortex-M55");
assert.strictEqual(decodeCpuid(0x410fd230).core, "Cortex-M85");
assert.strictEqual(decodeCpuid(0x410fd240).core, "Cortex-M52");
assert.strictEqual(decodeCpuid(0x410fd310).core, "Cortex-M35P");
assert.strictEqual(decodeCpuid(0x410fd210).core, "Cortex-M33");

// DEV_ID -> series: previously mismatched parts, and each series' cores agree with STM32_SERIES_CORES
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
    0x497: "STM32WLx",
    0x443: "STM32C0x",
    0x493: "STM32C0x",
    0x44e: "STM32C5x",
    0x45a: "STM32C5x"
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
// H723 under the wrong stm32g0x target: DEV_ID 0x483 corrects it to H7 with a matching core
const h723 = parseChip("stm32g0x.cfg", ["0xe000ed00: 411fc272", "0x40015800: 10016483"]);
assert.strictEqual(h723.core, "Cortex-M7");
assert.strictEqual(h723.series, "STM32H7x");
assert.strictEqual(h723.coreMismatch, "");
// C031 under the wrong stm32g0x target: DEV_ID 0x453 at the same DBGMCU address corrects it to C0 and reads its flash
// size/UID addresses
const c031 = parseChip("stm32g0x.cfg", [
    "0xe000ed00: 410cc601",
    "0x40015800: 10006453",
    "0x1fff75a0: 00000020",
    "0x1fff75e0: 00000040",
    "0x1fff7550: 00290041 4b4b5009 20363343"
]);
assert.strictEqual(c031.series, "STM32C0x");
assert.strictEqual(c031.coreMismatch, "");
assert.strictEqual(c031.flashSize, "32 KiB");
assert.strictEqual(c031.uid, "0x00290041" + "4B4B5009" + "20363343");
// C5 (M33): CPU-side DBGMCU and flash size at 0x08FFF80C
const c562 = parseChip("stm32c5x.cfg", ["0xe000ed00: 410fd213", "0x44024000: 1000644e", "0x08fff80c: 00000200"]);
assert.strictEqual(c562.series, "STM32C5x");
assert.strictEqual(c562.coreMismatch, "");
assert.strictEqual(c562.flashSize, "512 KiB");
assert.match(buildChipInfoCommands("stm32c5x.cfg").join("\n"), /mdw 0x44024000\].*mdw 0x8fff80c\].*mdw 0x8fff800 3\]/);
// F100 (M3) DEV_ID 0x420 belongs to F1, not F0
const f100 = parseChip("stm32f1x.cfg", ["0xe000ed00: 411fc231", "0xe0042000: 10016420"]);
assert.strictEqual(f100.series, "STM32F1x");
assert.strictEqual(f100.coreMismatch, "");
// Core conflicts with the DEV_ID family: the series is not rewritten and the mismatch is explained
const clash = parseChip("stm32f4x.cfg", ["0xe000ed00: 410fc241", "0xe0042000: 10006460"]);
assert.strictEqual(clash.series, "STM32F4x");
assert.strictEqual(clash.coreMismatch, "Cortex-M4 ≠ STM32G0x (DEV_ID 0x460)");
// Without DEV_ID the core is checked against the target series
const wrongTarget = parseChip("stm32f1x.cfg", ["0xe000ed00: 410cc601"]);
assert.strictEqual(wrongTarget.coreMismatch, "Cortex-M0+ ≠ STM32F1x");
// M35P in OpenOCD's "processor detected" line must not be truncated
const m35p = parseChip("stm32f1x.cfg", ["Info : [x.cpu] Cortex-M35P r1p0 processor detected"]);
assert.strictEqual(m35p.core, "Cortex-M35P");
assert.strictEqual(m35p.coreRevision, "r1p0");
// Families whose addresses are not in the table (L5, ...) must not fall back to flash size/UID from other families'
// addresses
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
