"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const workflow = yaml.parse(fs.readFileSync(path.resolve(__dirname, "../.github/workflows/ci.yml"), "utf8"));
const cpp = workflow.jobs["cpp-gdb"];
const printer = workflow.jobs["gdb-printer-modes"];
const cppCommands = cpp.steps.filter((step) => typeof step.run === "string").map((step) => step.run);
const printerCommands = printer.steps.filter((step) => typeof step.run === "string").map((step) => step.run);
const printerJobs = Object.values(workflow.jobs).filter((job) =>
    job.steps.some((step) => typeof step.run === "string" && step.run.includes("printer-modes.test.js"))
);

assert.deepStrictEqual(cpp.strategy.matrix.gcc, [14, 15]);
assert.deepStrictEqual(cpp.strategy.matrix.standard, [17, 20]);
assert.deepStrictEqual(cpp.strategy.matrix.dwarf, [4, 5]);
assert.strictEqual(cppCommands.filter((command) => command.includes("printer-modes.test.js")).length, 0);
assert.strictEqual(printerCommands.filter((command) => command.includes("printer-modes.test.js")).length, 1);
assert.strictEqual(printerJobs.length, 1, "printer modes must run in exactly one job");
assert.strictEqual(cppCommands.filter((command) => command.includes("cpp-paused.test.js")).length, 1);
const cppStep = cpp.steps.find((step) => step.run?.includes("cpp-paused.test.js"));
assert.strictEqual(cppStep.env.CPP_DWARF, "${{ matrix.dwarf }}");
assert.strictEqual(cppStep.env.CPP_STANDARD, "${{ matrix.standard }}");
assert.ok(
    !cpp.strategy.matrix.include && !cpp.strategy.matrix.exclude,
    "all eight compatibility combinations must run"
);
assert.deepStrictEqual(workflow.jobs.check.strategy.matrix.os, ["windows-latest", "ubuntu-latest", "macos-latest"]);
assert.ok(workflow.jobs.quality.steps.some((step) => step.run === "npm run quality"));
assert.strictEqual(
    Object.hasOwn(printer, "strategy"),
    false,
    "printer modes must not inherit the compatibility matrix"
);

console.log("CI GDB test topology passed");
