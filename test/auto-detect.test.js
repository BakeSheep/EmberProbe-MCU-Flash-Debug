"use strict";
const assert = require("assert");
const { debuggerFromInventory, targetFromText } = require("../src/autoDetect");

assert.strictEqual(debuggerFromInventory("CMSIS-DAP v2 Interface"), "cmsis-dap.cfg");
assert.strictEqual(debuggerFromInventory("CMSIS DAP compliant debugger"), "cmsis-dap.cfg");
assert.strictEqual(debuggerFromInventory("USB\\VID_0D28&PID_0204 DAPLink CMSIS-DAP"), "cmsis-dap.cfg");
assert.strictEqual(debuggerFromInventory("MCU-Link CMSIS-DAP V3.128"), "cmsis-dap.cfg");
assert.strictEqual(debuggerFromInventory("Raspberry Pi Picoprobe"), "cmsis-dap.cfg");
assert.strictEqual(debuggerFromInventory("SEGGER J-Link"), "jlink.cfg");
assert.strictEqual(debuggerFromInventory("ST-LINK/V2"), "stlink.cfg");
assert.strictEqual(debuggerFromInventory("Texas Instruments XDS110"), "xds110.cfg");
assert.strictEqual(debuggerFromInventory("Nuvoton Nu-Link"), "nulink.cfg");
assert.strictEqual(debuggerFromInventory("USB Composite Device"), "");

assert.strictEqual(targetFromText("Project for STM32F407"), "stm32f4x.cfg");
assert.strictEqual(targetFromText("Project for APM32F407"), "geehy/apm32f4x.cfg");
assert.strictEqual(targetFromText("Firmware for NRF52840"), "nordic/nrf52.cfg");

console.log("Auto-detect tests passed");
