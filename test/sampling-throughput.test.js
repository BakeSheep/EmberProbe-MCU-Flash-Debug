"use strict";
const assert = require("assert");
const { SamplingThroughput } = require("../src/samplingThroughput");
const { ManagedOpenOcdSession, compileReadBatches } = require("../src/liveWatch");

(async () => {
    const meter = new SamplingThroughput();
    assert.strictEqual(meter.rate(0), 0);
    meter.record(400, 0, 100);
    assert.strictEqual(meter.rate(100), 0, "wait for a complete window");
    meter.record(600, 900, 1000);
    assert.strictEqual(meter.rate(1000), 1000, "include time spent waiting between reads");
    meter.record(0, 1000, 2000);
    assert.strictEqual(meter.rate(2000), 0, "failed reads add no payload");
    meter.record(3000, 2000, 3500);
    assert.strictEqual(meter.rate(3500), 2000, "divide by actual elapsed time for slow cycles");
    assert.strictEqual(meter.rate(4500), 0, "idle sampling must not retain an old throughput");
    meter.reset();
    for (const bytes of [-1, NaN, Infinity, 0.5]) meter.record(bytes, 0, 1000);
    meter.record(1000, NaN, 1000);
    meter.record(1000, 0, Infinity);
    meter.record(1000, 1000, 0);
    assert.strictEqual(meter.rate(1000), 0);
    meter.record(500, 5000, 6000);
    assert.strictEqual(meter.rate(6000), 500, "invalid input does not start a measurement window");
    meter.reset();
    assert.strictEqual(meter.rate(6000), 0);

    const session = new ManagedOpenOcdSession(null, { intervalMs: 10 }, {});
    session.socket = { destroyed: false };
    session.setWatch([
        { name: "a", address: 0x20000000, size: 4 },
        { name: "alias", address: 0x20000000, size: 4 },
        { name: "b", address: 0x20000004, size: 4 }
    ]);
    let clockMs = 0;
    let commands = 0;
    let response = "1 2";
    session._sendCheckedCommand = async () => {
        commands++;
        clockMs += 10;
        return response;
    };
    const bigint = process.hrtime.bigint;
    process.hrtime.bigint = () => BigInt(clockMs) * 1000000n;
    try {
        for (let i = 0; i < 100; i++) await session._sampleTick();
        assert.strictEqual(commands, 100, "measurement must not send additional commands");
        assert.strictEqual(session.stats().bytesPerSecond, 800, "merged addresses and aliases count once");

        await session._readMemoryBytes(0x20000000, 8);
        assert.strictEqual(session.stats().bytesPerSecond, 800, "one-shot reads do not publish sampling bytes");
        response = "invalid";
        for (let i = 0; i < 100; i++) await session._sampleTick();
        assert.strictEqual(session.stats().bytesPerSecond, 0);

        // Multiple groups count each validated response, including partial batch success.
        const batches = compileReadBatches([
            { name: "x", address: 0x20000000, size: 4 },
            { name: "y", address: 0x20000100, size: 4 }
        ]);
        const before = session._memoryReadBytes;
        response = "1\ninvalid";
        const bytes = await session._readBatchBytes(batches[0]);
        assert.strictEqual(bytes[0].length, 4);
        assert.strictEqual(bytes[1], null);
        assert.strictEqual(session._memoryReadBytes - before, 4);
        response = "1\n2";
        await session._readBatchBytes(batches[0]);
        assert.strictEqual(session._memoryReadBytes - before, 12);

        const prime = () => session._samplingThroughput.record(1000, clockMs - 1000, clockMs);
        prime();
        session.setIntervalMs(20);
        assert.strictEqual(session.stats().bytesPerSecond, 0, "rate changes reset measurement");
        prime();
        session.invalidateTarget();
        assert.strictEqual(session.stats().bytesPerSecond, 0, "target changes reset measurement");
        prime();
        session.setSamplingEnabled(false);
        assert.strictEqual(session.stats().bytesPerSecond, 0, "stop resets measurement");
        session.samplingEnabled = true;
        response = "1 2";
        session._sendCheckedCommand = async () => {
            session.invalidateTarget();
            clockMs += 1000;
            return response;
        };
        await session._sampleTick();
        assert.strictEqual(session.stats().bytesPerSecond, 0, "stale target reads cannot repopulate statistics");
    } finally {
        process.hrtime.bigint = bigint;
        session.socket = null;
    }
    console.log("Sampling throughput tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
