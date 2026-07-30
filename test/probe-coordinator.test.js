"use strict";
const assert = require("assert");
const { ProbeCoordinator, PROBE_OPERATIONS } = require("../src/probeCoordinator");

const coordinator = new ProbeCoordinator();
assert.deepStrictEqual(
    coordinator.snapshot(),
    Object.fromEntries(PROBE_OPERATIONS.map(name => [name, false])),
    "all probe operations should start inactive"
);

assert.strictEqual(coordinator.setActive("download", true), true);
assert.strictEqual(coordinator.isActive("download"), true);
assert.strictEqual(coordinator.anyActive(), true);
assert.strictEqual(coordinator.firstActive(["chipInfo", "download"]), "download");

coordinator.setActive("chipInfo", true);
assert.strictEqual(coordinator.firstActive(), "download", "firstActive should follow the declared operation order");
assert.deepStrictEqual(
    Object.entries(coordinator.snapshot()).filter(([, active]) => active).map(([name]) => name),
    ["download", "chipInfo"]
);

coordinator.setActive("download", false);
assert.strictEqual(coordinator.isActive("download"), false);
assert.strictEqual(coordinator.firstActive(), "chipInfo");

coordinator.reset();
assert.strictEqual(coordinator.anyActive(), false);
assert.throws(
    () => coordinator.isActive("unknown"),
    error => error.code === "INVALID_PROBE_OPERATION" && error.operation === "unknown"
);

console.log("Probe coordinator tests passed");
