"use strict";
const assert = require("assert");
const { parseLine } = require("../src/openocdRunner");

const cases = [
  ["Info : CMSIS-DAP: SWD supported", "probe"],
  ["target halted due to debug-request", "target"],
  ["wrote 524288 bytes from file app.elf in 2.1s", "program"],
  ["verified 524288 bytes in 0.8s", "verify"],
  ["Error: unable to find a matching CMSIS-DAP device", "error"]
];

for (const [line, stage] of cases) assert.strictEqual(parseLine(line)?.stage, stage, line);
console.log("OpenOCD parser tests passed");
