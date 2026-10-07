"use strict";
const assert = require("assert");
const {
    buildCpuLoadPlan,
    decodeTask,
    classifyCpuSample,
    CpuLoadWindow,
    inRam
} = require("../src/services/cpuLoadModel");
const { metadata, taskBytes } = require("./helpers/cpu-load-fixture");

for (const shift of [0, 4, 16]) {
    for (const numbered of [false, true]) {
        const { result, layout } = metadata(shift, numbered);
        const plan = buildCpuLoadPlan(result, layout);
        const task = decodeTask(plan, 0x20000100, taskBytes(plan, "test", 9), 0);
        assert.strictEqual(task.name, "test");
        assert.strictEqual(task.number, numbered ? 9 : null);
        assert.strictEqual(decodeTask(plan, 0x40000000, taskBytes(plan, "test"), 0), null);
        assert.strictEqual(decodeTask(plan, 0x20000101, taskBytes(plan, "test"), 0), null);
        const corrupt = taskBytes(plan, "test");
        corrupt.writeUInt32LE(0xe000edf0, 0);
        assert.strictEqual(decodeTask(plan, 0x20000100, corrupt, 0), null);
    }
}
for (const mutate of [
    (r) => {
        r.elf.machine = 3;
    },
    (r) => {
        r.elf.encoding = 2;
    },
    (r) => {
        r.symbols.push({ name: "pxCurrentTCBs" });
    },
    (r) => {
        r.symbols.push(r.symbols[0]);
    },
    (r) => {
        r.symbols[0].cppTypeUnavailable = true;
    },
    (r) => {
        r.symbols[0].address = 0xe000ed00;
    },
    (r) => {
        r.symbols[0].size = 8;
    },
    (_r, l) => {
        l.runtimeLayout.types[2].fields[0].offset = 2048;
    },
    (_r, l) => {
        l.runtimeLayout.types[0].target = 0;
    },
    (_r, l) => {
        delete l.runtimeLayout;
    },
    (_r, l) => {
        l.runtimeLayout.types[5].count = 4096;
    }
]) {
    const { result, layout } = metadata();
    mutate(result, layout);
    assert.throws(() => buildCpuLoadPlan(result, layout), { code: "CPU_LAYOUT_UNSUPPORTED" });
}
const absent = metadata();
absent.result.symbols = absent.result.symbols.slice(0, 1);
assert.strictEqual(buildCpuLoadPlan(absent.result, absent.layout).idleAddress, null);
assert.strictEqual(inRam([{ start: 0x20000000, end: 0x20000010 }], 0x2000000c, 8), false);
const task = { key: "task" };
const sample = {
    beforeState: "running",
    afterState: "running",
    beforeTcb: 1,
    afterTcb: 1,
    beforeException: 0,
    afterException: 0,
    durationMs: 1,
    periodMs: 5,
    task,
    idle: "idle"
};
assert.strictEqual(classifyCpuSample(sample).kind, "task");
assert.strictEqual(classifyCpuSample({ ...sample, task: { key: "idle" } }).kind, "idle");
for (const exception of [3, 14, 15, 16, 511])
    assert.strictEqual(
        classifyCpuSample({ ...sample, task: null, beforeException: exception, afterException: exception }).kind,
        "exception"
    );
for (const extra of [
    { afterState: "halted" },
    { afterTcb: 2 },
    { afterException: 15 },
    { durationMs: 3 },
    { task: null },
    { reason: "timeout" }
])
    assert.strictEqual(classifyCpuSample({ ...sample, ...extra }).kind, "unknown");

const window = new CpuLoadWindow(0);
window.add(0, 1000, { kind: "task", taskKey: "task", acquired: true }, "shared");
window.add(1000, 7000, { kind: "exception", exception: 15, acquired: true }, "shared");
window.add(7000, 10000, { kind: "idle", taskKey: "idle", acquired: true });
const tasks = new Map([
    ["task", { ...task, address: 1, name: "Worker", number: 2, time: 10000, lifetimeConfirmed: true }]
]);
const result = window.summary(10000, tasks, "idle", { pcsr: true });
assert.strictEqual(result.workloadPercent, 70, "10% task + 60% ISR during Idle = 70% work");
assert.strictEqual(result.idlePercent, 30);
assert.strictEqual(result.unknownPercent, 0);
assert.strictEqual(result.hotspots[0].percent, 70);
assert.strictEqual(window.summary(11000, tasks, null, {}).workloadPercent, null);
assert.strictEqual(window.summary(11001, tasks, "idle", {}).tasks[0].name, "", "expired labels must disappear");
const gap = new CpuLoadWindow(0);
gap.add(0, 1000, { kind: "task", acquired: true });
gap.add(1000, 4000, { kind: "unknown", reason: "cpu-budget" });
gap.add(4000, 10000, { kind: "idle", acquired: true });
const low = gap.summary(10000, new Map(), "idle", {});
assert.strictEqual(low.workloadPercent + low.idlePercent + low.unknownPercent, 100);
assert.strictEqual(low.state, "low-coverage");
assert.strictEqual(low.actualHz, 0.2, "skipped slots are not successful acquisitions");
assert.strictEqual(low.unknownReasons["cpu-budget"], 1);
assert.strictEqual(low.unknownReasonPercent["cpu-budget"], 30, "diagnostics use time weights, not sample counts");
const diagnostics = new CpuLoadWindow(0);
diagnostics.add(0, 1000, { kind: "unknown", reason: "transition" });
diagnostics.add(1000, 4000, { kind: "unknown", reason: "read-span" });
const explained = diagnostics.summary(10000, new Map(), "idle", {});
assert.strictEqual(explained.unknownReasonPercent.transition, 10);
assert.strictEqual(explained.unknownReasonPercent["read-span"], 30);
assert.strictEqual(explained.unknownReasonPercent.unobserved, 60);
assert.strictEqual(
    Object.values(explained.unknownReasonPercent).reduce((sum, percent) => sum + percent, 0),
    100
);
const jitter = new CpuLoadWindow(0);
jitter.add(0, 4, { kind: "task" });
jitter.add(4, 10, { kind: "idle" });
assert.strictEqual(jitter.summary(10, new Map(), "idle", {}).workloadPercent, 40, "time weighting handles jitter");
assert.strictEqual(jitter.summary(5, new Map(), "idle", {}).workloadPercent, 80, "clip the current slot");
for (let i = 0; i < 130; i++) jitter.summary(i + 11, new Map(), "idle", {});
assert.strictEqual(jitter.history.length, 120);
const many = new CpuLoadWindow(0);
const identities = new Map();
for (let i = 0; i < 40; i++) {
    const key = String(i);
    identities.set(key, { key, address: i, time: 10000 });
    many.add(i * 250, (i + 1) * 250, { kind: "task", taskKey: key, acquired: true }, `function${i}`);
}
const capped = many.summary(10000, identities, "idle", {});
assert.strictEqual(capped.tasks.length, 32);
assert.strictEqual(capped.hotspots.length, 20);
assert.strictEqual(capped.otherTaskPercent, 20);
assert.strictEqual(capped.otherHotspotPercent, 50);
console.log("CPU metadata, classification and weighted rolling-window tests passed");
