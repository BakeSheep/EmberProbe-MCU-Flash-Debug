"use strict";
const assert = require("assert");
const { decodeCpuid, parseMdwWord, parseMdwDump, parseRegLine, parseKv, splitIdcode, normalizeTransport, seriesFromTarget, seriesFromFlashDriver, uidBaseForTarget, idcodeBaseForTarget, flashSizeBaseForTarget, formatUid, normalizeFlashSize } = require("../src/chipInfo");

// SCB CPUID 0x410FC241 → Cortex-M4 r0p1（ARM）
const m4 = decodeCpuid(0x410FC241);
assert.strictEqual(m4.core, "Cortex-M4");
assert.strictEqual(m4.revision, "r0p1");
assert.strictEqual(m4.implementer, "ARM");
assert.strictEqual(m4.raw, "0x410FC241");

// 覆盖常见 Cortex-M part number（bits[15:4]）
assert.strictEqual(decodeCpuid(0x410CC200).core, "Cortex-M0");
assert.strictEqual(decodeCpuid(0x410CC601).core, "Cortex-M0+");
assert.strictEqual(decodeCpuid(0x412FC231).core, "Cortex-M3");
assert.strictEqual(decodeCpuid(0x410FC271).core, "Cortex-M7");
assert.strictEqual(decodeCpuid(0x410CD200).core, "Cortex-M23");

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
assert.strictEqual(parseMdwWord("0xe000ed00: 410fc241", 0xE000ED00), 0x410fc241);
assert.strictEqual(parseMdwWord("0xE000ED00: 410FC241"), 0x410fc241);
assert.strictEqual(parseMdwWord("0x20000000: deadbeef", 0xE000ED00), null); // 地址不匹配应丢弃
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
assert.strictEqual(idcodeBaseForTarget("stm32f0x.cfg"), 0x40015800);
assert.strictEqual(flashSizeBaseForTarget("stm32h7x.cfg"), 0x1ff1e880);
assert.strictEqual(flashSizeBaseForTarget("stm32f4x.cfg"), 0x1fff7a22);
assert.strictEqual(flashSizeBaseForTarget("nrf52.cfg"), 0);

// normalizeFlashSize：kbytes → KiB
assert.strictEqual(normalizeFlashSize("1024 kbytes"), "1024 KiB");

console.log("Chip info tests passed");
