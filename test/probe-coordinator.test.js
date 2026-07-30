"use strict";
const assert = require("assert");
const { ProbeCoordinator, PROBE_OPERATIONS } = require("../src/probeCoordinator");

const coordinator = new ProbeCoordinator();
assert.deepStrictEqual(
    coordinator.snapshot(),
    Object.fromEntries(PROBE_OPERATIONS.map((name) => [name, false])),
    "all probe operations should start inactive"
);

const download = coordinator.acquire("download");
assert.strictEqual(download.operation, "download");
assert.strictEqual(coordinator.isActive("download"), true);
assert.strictEqual(coordinator.anyActive(), true);
assert.strictEqual(coordinator.firstActive(["chipInfo", "download"]), "download");

assert.throws(
    () => coordinator.acquire("chipInfo"),
    (error) =>
        error.code === "PROBE_BUSY" && error.requestedOperation === "chipInfo" && error.activeOperation === "download"
);

download.release();
assert.strictEqual(coordinator.isActive("download"), false);
download.release();
assert.strictEqual(coordinator.anyActive(), false, "release should be idempotent");

const starting = coordinator.acquire("liveStart");
const running = starting.transition("liveWatch");
assert.strictEqual(starting.released, true);
assert.strictEqual(running.operation, "liveWatch");
assert.strictEqual(coordinator.isActive("liveStart"), false);
assert.strictEqual(coordinator.isActive("liveWatch"), true);
assert.throws(
    () => starting.transition("chipInfo"),
    (error) => error.code === "STALE_PROBE_LEASE"
);
running.release();

assert.throws(
    () => coordinator.isActive("unknown"),
    (error) => error.code === "INVALID_PROBE_OPERATION" && error.operation === "unknown"
);

const chip = coordinator.acquire("chipInfo");
coordinator.reset();
assert.strictEqual(chip.released, true);
assert.strictEqual(coordinator.anyActive(), false);

console.log("Probe coordinator tests passed");
