"use strict";
const assert = require("assert");
const path = require("path");
const { SamplingSession } = require("../src/samplingSession");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
    const ticks = [],
        errors = [];
    const session = new SamplingSession(
        { intervalMs: 20 },
        { onSample: (samples, t) => ticks.push({ samples, t }), onError: (e) => errors.push(e) },
        path.join(__dirname, "helpers/sampling-worker-fixture.js")
    );
    const plan = [{ name: "value", address: 0x20000000, size: 4 }];
    try {
        session.setWatch(plan);
        await session.start();
        await wait(120);
        assert.ok(ticks.length >= 2);
        const begin = Date.now();
        // Model a synchronous ELF parse/build extension blocking the extension host.
        while (Date.now() - begin < 600) {
            Math.sqrt(Date.now());
        }
        const end = Date.now();
        await wait(150);
        const during = ticks.filter((tick) => tick.t >= begin && tick.t <= end);
        assert.ok(during.length >= 12, `Sampling continued during host stall: ${during.length} ticks`);
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
        session.setIntervalMs(40);
        session.setSamplingEnabled(true);
        await wait(150);
        assert.ok(ticks.length > stoppedAt);
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
