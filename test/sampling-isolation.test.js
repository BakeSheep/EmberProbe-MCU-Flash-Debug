"use strict";
const assert = require("assert");
const path = require("path");
const { SamplingSession } = require("../src/samplingSession");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { EventEmitter } = require("events");
const { run, estimateRuntimeBytes } = require("../src/samplingWorker");
const { MAX_COMPOSITE_BYTES } = require("../src/dwarf/layoutLimits");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function testRuntimeAccounting() {
    const tree = {
        kind: "class",
        typeName: "Sensor",
        members: Array.from({ length: 100 }, (_, i) => ({
            kind: "scalar",
            name: "value" + i,
            type: "f32",
            value: i / 3,
            valueText: String(i / 3),
            address: 0x20000000 + i * 4
        }))
    };
    const estimate = estimateRuntimeBytes(tree);
    assert.ok(estimate >= Buffer.byteLength(JSON.stringify(tree)));
    assert.ok(estimate < MAX_COMPOSITE_BYTES, "valid runtime trees fit the metadata budget");
    assert.strictEqual(estimateRuntimeBytes("中🙂"), 16 + "中🙂".length * 2);
    const diagnostic = { code: "LIVE_ADDRESS_NOT_RAM", message: "Refusing to read an invalid address" };
    assert.ok(estimateRuntimeBytes(diagnostic) >= Buffer.byteLength(JSON.stringify(diagnostic)));
    const oversized = 16 * 1024 * 1024 + 1;
    assert.strictEqual(estimateRuntimeBytes({ valueText: "x".repeat(MAX_COMPOSITE_BYTES) }), oversized);
    assert.strictEqual(
        estimateRuntimeBytes(Array(20000).fill(0)),
        oversized,
        "work is bounded even for malformed trees"
    );
    const cycle = {};
    cycle.self = cycle;
    assert.strictEqual(estimateRuntimeBytes(cycle), oversized);
    Object.defineProperty(tree, "toJSON", { value: () => assert.fail("runtime accounting must not serialize") });
    assert.strictEqual(estimateRuntimeBytes(tree), estimate);

    const port = new EventEmitter();
    const events = [],
        pauses = [];
    port.postMessage = (message) => events.push(message);
    let handlers;
    const session = {
        samplingEnabled: true,
        stopped: false,
        stop() {},
        setSamplingEnabled(value) {
            this.samplingEnabled = value;
            pauses.push(value);
        }
    };
    run(port, {}, (_config, nextHandlers) => {
        handlers = nextHandlers;
        return session;
    });
    handlers.onSample([{ name: "scalar", bytes: Buffer.alloc(4) }], 1);
    const pendingTree = { kind: "scalar", valueText: "x".repeat(512 * 1024) };
    for (let i = 0; i < 15; i++) handlers.onSample([{ name: "runtime", runtimeTree: pendingTree, diagnostic }], i + 2);
    assert.deepStrictEqual(pauses, [], "runtime batches below 16 MiB remain enabled while waiting for an ack");
    handlers.onSample([{ name: "runtime", runtimeTree: pendingTree, diagnostic }], 17);
    assert.deepStrictEqual(pauses, [false], "structural bytes still enforce sampling-worker backpressure");
    assert.strictEqual(events.at(-1).event, "onError");
    port.emit("message", { ack: true });
    const delivered = events.at(-1);
    assert.strictEqual(delivered.event, "samples");
    assert.strictEqual(delivered.batch.length, 16);
    assert.strictEqual(
        delivered.batch[0].samples[0].runtimeTree,
        pendingTree,
        "accounting preserves the payload shape"
    );
    port.emit("close");
}
(async () => {
    testRuntimeAccounting();
    const ticks = [],
        errors = [];
    const session = new SamplingSession(
        { intervalMs: 20 },
        { onSample: (samples, t, consumers) => ticks.push({ samples, t, consumers }), onError: (e) => errors.push(e) },
        path.join(__dirname, "helpers/sampling-worker-fixture.js")
    );
    const plan = [{ name: "value", address: 0x20000000, size: 4 }];
    try {
        session.setWatch(plan);
        await session.start();
        session.setPauseReason("archive_backpressure");
        assert.strictEqual((await session.request("stats")).result.pauseReason, "archive_backpressure");
        session.setPauseReason(null);
        await wait(250);
        assert.ok(ticks.length >= 2);
        const begin = Date.now();
        // Model a synchronous ELF parse/build extension blocking the extension host.
        while (Date.now() - begin < 600) {
            Math.sqrt(Date.now());
        }
        const end = Date.now();
        await wait(150);
        const during = ticks.filter((tick) => tick.t >= begin && tick.t <= end);
        assert.ok(during.length >= 5, `Sampling continued during host stall: ${during.length} ticks`);
        assert.deepEqual(during[0].samples[0].bytes, [1, 2, 3, 4]);
        session.setSamplingEnabled(false);
        await session.waitForIdle();
        await wait(50);
        const stoppedAt = ticks.length;
        await wait(100);
        assert.equal(ticks.length, stoppedAt);
        assert.deepEqual((await session.readOnce(plan))[0].bytes, [1, 2, 3, 4]);
        const transaction = await session.writeAndVerify([
            { name: "value", address: 0x20000000, bytes: [7, 8, 9, 10] }
        ]);
        assert.deepEqual(transaction.after[0].bytes, [7, 8, 9, 10]);
        assert.strictEqual(transaction.halted, false, "Worker result preserves the non-halting transaction indicator");
        session.setIntervalMs(40);
        session.setSamplingEnabled(true);
        await wait(150);
        assert.ok(ticks.length > stoppedAt);
        const beforePlan = ticks.length;
        session.setSamplingPlan({
            graphItems: [{ ...plan[0], name: "graph" }],
            sidebarItems: plan,
            graphIntervalMs: 1000
        });
        await wait(550);
        const layered = ticks.slice(beforePlan).filter((tick) => tick.consumers);
        assert.ok(layered.filter((tick) => tick.consumers.sidebarNames.includes("value")).length >= 5);
        assert.strictEqual(
            layered.filter((tick) => tick.consumers.graphNames.includes("graph")).length,
            1,
            "worker delivery preserves the plan generation and avoids graph points from sidebar ticks"
        );
        assert.deepEqual(errors, []);
        await assert.rejects(session.request("invalid"), /Unknown sampling operation/);
        console.log(`Worker isolation: ${during.length} acquired ticks during ${end - begin} ms host stall`);
    } finally {
        await session.stop();
    }
    await assert.rejects(session.readOnce(plan), /stopped/);
    const local = new ManagedOpenOcdSession(null, {}, {});
    local.socket = { destroyed: false };
    local.setSamplingEnabled(true);
    const timer = local.timer,
        epoch = local.sampleEpoch;
    local.setSamplingEnabled(true);
    assert.equal(local.timer, timer, "repeated enable must not restart the sampling clock");
    assert.equal(local.sampleEpoch, epoch, "repeated enable must not cancel an in-flight cycle");
    local.setSamplingEnabled(false);
    local.socket = null;
    await local.stop();
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
