"use strict";
const assert = require("assert");
const { parseLine, quoteTclWord } = require("../src/openocdRunner");

const cases = [
  ["Info : CMSIS-DAP: SWD supported", "probe"],
  ["target halted due to debug-request", "target"],
  ["wrote 524288 bytes from file app.elf in 2.1s", "program"],
  ["verified 524288 bytes in 0.8s", "verify"],
  ["Error: unable to find a matching CMSIS-DAP device", "error"]
];

for (const [line, stage] of cases) assert.strictEqual(parseLine(line)?.stage, stage, line);

// 失败流程中 OpenOCD 同样会打印 "shutdown command invoked"，不能据此判定完成（以退出代码为准）
assert.strictEqual(parseLine("shutdown command invoked"), null);
// 剥离 "Error:" 前缀后为空时回退为整行，避免产生空消息
const errEvent = parseLine("embedded:startup.tcl:1789: Error:");
assert.strictEqual(errEvent?.stage, "error");
assert.ok(errEvent.message.length > 0, "error message should not be empty");

// wrote/verified 事件应携带结构化字段（含可选速率）
const wrote = parseLine("wrote 524288 bytes from file app.elf in 2.1s (249.9 KiB/s)");
assert.strictEqual(wrote?.stage, "program");
assert.strictEqual(wrote.bytes, 524288);
assert.strictEqual(wrote.seconds, 2.1);
assert.strictEqual(wrote.speed, "249.9 KiB/s");
const verified = parseLine("verified 524288 bytes in 0.8s");
assert.strictEqual(verified?.stage, "verify");
assert.strictEqual(verified.bytes, 524288);
assert.strictEqual(verified.speed, "");

// 新增信息行：芯片、Flash 容量、适配器时钟、目标电压
const chipId = parseLine("Info : device id = 0x10076413");
assert.strictEqual(chipId?.stage, "chip");
assert.strictEqual(chipId.deviceId, "0x10076413");
const chipName = parseLine("Info : Device: STM32F40x/STM32F41x");
assert.strictEqual(chipName?.stage, "chip");
assert.ok(chipName.chip.includes("STM32F40x"));
const flashInfo = parseLine("Info : flash size = 1024 kbytes");
assert.strictEqual(flashInfo?.stage, "flash");
assert.ok(flashInfo.flashSize.includes("1024"));
assert.strictEqual(parseLine("Info : clock speed 1800 kHz")?.stage, "adapter");
assert.strictEqual(parseLine("Info : Target voltage: 3.239000")?.level, "info");
assert.strictEqual(parseLine("Info : Target voltage: 0.000000")?.level, "error");
// 配置脚本缺失应归类为错误
assert.strictEqual(parseLine("Error: Can't find interface/stlink.cfg")?.stage, "error");
// 正常 Info 提示（含 "unable to"/"failed" 等关键词）不应被误判为错误
assert.strictEqual(parseLine("Info : Unable to match requested speed 5000 kHz, using 1800 kHz"), null);
assert.strictEqual(parseLine("Info : clock speed 1800 kHz")?.stage, "adapter");
assert.strictEqual(parseLine("libusb_open() failed with LIBUSB_ERROR_ACCESS")?.stage, "error");

// Tcl 双引号内的变量与命令替换必须被禁用，同时保留空格路径。
assert.strictEqual(
  quoteTclWord('C:/work/$board/[danger]/app "debug".elf'),
  '"C:/work/\\$board/\\[danger\\]/app \\"debug\\".elf"'
);

console.log("OpenOCD parser tests passed");
