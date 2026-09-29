"use strict";
const assert = require("assert");
const { ManagedOpenOcdSession, compileReadBatches, MAX_BATCH_GROUPS, MAX_BATCH_BYTES } = require("../src/liveWatch");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

async function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    // -------------------------------------------------------------
    // 1. Batch Compilation Rules (compileReadBatches)
    // -------------------------------------------------------------
    {
        assert.deepStrictEqual(compileReadBatches([]), []);
        assert.deepStrictEqual(compileReadBatches(null), []);

        // Single item
        const single = compileReadBatches([{ name: "a", address: 0x20000000, size: 4 }]);
        assert.strictEqual(single.length, 1);
        assert.strictEqual(single[0].length, 1);
        assert.strictEqual(single[0][0].start, 0x20000000);
        assert.strictEqual(single[0][0].byteCount, 4);

        // Contiguous items merged into 1 group
        const contiguous = compileReadBatches([
            { name: "a", address: 0x20000000, size: 4 },
            { name: "b", address: 0x20000004, size: 4 }
        ]);
        assert.strictEqual(contiguous.length, 1);
        assert.strictEqual(contiguous[0].length, 1);
        assert.strictEqual(contiguous[0][0].byteCount, 8);
        assert.strictEqual(contiguous[0][0].vars.length, 2);

        // Discontiguous items split by MAX_BATCH_GROUPS (8)
        const tenItems = Array.from({ length: 10 }, (_, i) => ({
            name: `v${i}`,
            address: 0x20000000 + i * 0x100,
            size: 4
        }));
        const batchedTen = compileReadBatches(tenItems);
        assert.strictEqual(batchedTen.length, 2);
        assert.strictEqual(batchedTen[0].length, MAX_BATCH_GROUPS); // 8 groups
        assert.strictEqual(batchedTen[1].length, 2); // 2 groups

        // Byte limit: items exceeding MAX_BATCH_BYTES (1024) split into separate batches
        const largeItems = [
            { name: "g1", address: 0x20000000, size: 600 },
            { name: "g2", address: 0x20001000, size: 600 }
        ];
        const batchedLarge = compileReadBatches(largeItems);
        assert.strictEqual(batchedLarge.length, 2);
        assert.strictEqual(batchedLarge[0].length, 1);
        assert.strictEqual(batchedLarge[1].length, 1);

        const oversized = compileReadBatches([
            { name: "big", address: 0x20002000, size: 2048 },
            { name: "small", address: 0x20003000, size: 4 }
        ]);
        assert.strictEqual(oversized.length, 3);
        assert.deepStrictEqual(
            oversized.map((batch) => batch.reduce((total, unit) => total + unit.byteCount, 0)),
            [1024, 1024, 4]
        );
        assert.ok(oversized.every((batch) => batch.length <= MAX_BATCH_GROUPS));
        assert.ok(oversized.every((batch) => batch.every((unit) => unit.byteCount <= MAX_BATCH_BYTES)));
    }

    // -------------------------------------------------------------
    // 2. Fast calibration and adaptive backoff after an explicit rate change
    // -------------------------------------------------------------
    {
        const session = new ManagedOpenOcdSession(null, { intervalMs: 5, mode: "standalone" }, {});
        assert.strictEqual(session.targetIntervalMs, 5);
        assert.strictEqual(session.effectiveIntervalMs, 100, "Must warm up at 100 ms");

        for (let i = 0; i < 4; i++) session._recordCycle(1.0);
        assert.strictEqual(session.effectiveIntervalMs, 5, "Fast probe should leave warm-up after four reads");
        session.setIntervalMs(20);
        assert.strictEqual(session.effectiveIntervalMs, 20, "User changes should apply without a slow ramp");
        assert.strictEqual(session.stats().actualHz, 0, "A rate change must discard samples from the old target");
        session.setIntervalMs(5);
        assert.strictEqual(session.effectiveIntervalMs, 5);
        session.setIntervalMs(5);
        assert.strictEqual(session.effectiveIntervalMs, 5, "Repeating the target must not restart warm-up");

        const slowSession = new ManagedOpenOcdSession(null, { intervalMs: 100 }, {});
        slowSession._recentDurations = [20, 20, 20, 20];
        slowSession.setIntervalMs(5);
        assert.strictEqual(slowSession.targetIntervalMs, 5);
        assert.strictEqual(slowSession.effectiveIntervalMs, 29, "Slow probes retain a measured safety margin");

        // Test backoff when duration exceeds 70% of effective interval
        // At 5 ms, 70% is 3.5 ms. Record durations of 4.0 ms
        for (let i = 0; i < 32; i++) {
            session._recordCycle(4.0);
        }
        session._lastAdaptiveEvalAt = Number(process.hrtime.bigint() / 1000000n) - 1500;
        session._evaluateAdaptiveSchedule();
        assert.ok(session.effectiveIntervalMs > 5, "Must back off when P95 duration > 70%");
        assert.strictEqual(session.effectiveIntervalMs, 10);
        assert.strictEqual(session._consecutiveSuccesses, 0, "Success counter must reset on backoff");

        // In debug mode, threshold is 40%
        const debugSession = new ManagedOpenOcdSession(null, { intervalMs: 10, mode: "debug" }, {});
        debugSession.effectiveIntervalMs = 10;
        debugSession._warmingUp = false;
        // 40% of 10 is 4.0 ms. Durations of 4.5 ms should trigger backoff.
        for (let i = 0; i < 32; i++) {
            debugSession._recordCycle(4.5);
        }
        debugSession._lastAdaptiveEvalAt = Number(process.hrtime.bigint() / 1000000n) - 1500;
        debugSession._evaluateAdaptiveSchedule();
        assert.strictEqual(debugSession.effectiveIntervalMs, 15, "Debug mode must back off at 40% threshold");
    }

    // -------------------------------------------------------------
    // 3. Live Sampling: Single in-flight serial constraint & Batch reading
    // -------------------------------------------------------------
    {
        const fake = new FakeOpenOcdServer();
        await fake.start();
        fake.seed(0x20000000, [1, 2, 3, 4]);
        fake.seed(0x20000010, [5, 6, 7, 8]);
        fake.readLatencyMs = 10; // 10 ms simulated round-trip

        const samplesReceived = [];
        const session = new ManagedOpenOcdSession(
            null,
            { intervalMs: 5, mode: "standalone" },
            {
                onSample(samples, t) {
                    samplesReceived.push({ samples, t });
                }
            }
        );
        session.socket = await fake.connect();
        session._setupSocket();

        session.setWatch([
            { name: "v1", address: 0x20000000, size: 4, type: "u32" },
            { name: "v2", address: 0x20000010, size: 4, type: "u32" }
        ]);

        session.setSamplingEnabled(true);
        await wait(250);

        // Verify serial constraint
        assert.strictEqual(fake.maxInFlight, 1, "There must never be more than 1 read request in flight");
        assert.ok(samplesReceived.length >= 2, "Should have received multiple samples");

        // Verify batch command was used: `join [list ...]`
        const batchCommands = fake.commands.filter((cmd) => cmd.includes("join [list"));
        assert.ok(batchCommands.length > 0, "Discontiguous items must be fetched via batch command");

        // Verify metrics
        const st = session.stats();
        assert.strictEqual(st.targetIntervalMs, 5);
        assert.ok(st.effectiveIntervalMs >= 5);
        assert.ok(st.actualHz > 0);
        assert.ok(st.p95DurationMs >= 9, `P95 duration should reflect ~10ms latency (got ${st.p95DurationMs})`);

        await session.stop();
        await fake.stop();
    }

    // Large contiguous values span bounded transfers without duplicating or truncating samples.
    {
        const fake = new FakeOpenOcdServer();
        await fake.start();
        const expected = Array.from({ length: 2048 }, (_, index) => index & 0xff);
        fake.seed(0x20002000, expected);
        fake.seed(0x20003000, [7, 8, 9, 10]);
        const session = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
        session.socket = await fake.connect();
        session._setupSocket();
        try {
            const samples = await session.readOnce([
                { name: "big", address: 0x20002000, size: 2048 },
                { name: "small", address: 0x20003000, size: 4 }
            ]);
            assert.strictEqual(samples.length, 2);
            assert.deepStrictEqual(samples[0].bytes, expected);
            assert.deepStrictEqual(samples[1].bytes, [7, 8, 9, 10]);
            assert.ok(fake.commands.every((command) => !/read_memory\s+0x20002000\s+32\s+512/.test(command)));
        } finally {
            await session.stop();
            await fake.stop();
        }
    }

    // -------------------------------------------------------------
    // 4. Batch fallback when OpenOCD rejects batch command
    // -------------------------------------------------------------
    {
        const fake = new FakeOpenOcdServer();
        await fake.start();
        fake.seed(0x20000000, [10, 20, 30, 40]);
        fake.seed(0x20000020, [50, 60, 70, 80]);
        fake.rejectBatchCommand = true; // OpenOCD without 'join' command support

        const session = new ManagedOpenOcdSession(null, { intervalMs: 20, mode: "standalone" }, {});
        session.socket = await fake.connect();
        session._setupSocket();

        const samples = await session.readOnce([
            { name: "v1", address: 0x20000000, size: 4 },
            { name: "v2", address: 0x20000020, size: 4 }
        ]);

        assert.strictEqual(samples.length, 2);
        assert.deepStrictEqual(samples[0].bytes, [10, 20, 30, 40]);
        assert.deepStrictEqual(samples[1].bytes, [50, 60, 70, 80]);
        assert.strictEqual(session._batchUnsupported, true, "Must set _batchUnsupported on batch failure");

        await session.stop();
        await fake.stop();
    }

    // A target read error is not evidence that Tcl batching is unsupported.
    {
        const fake = new FakeOpenOcdServer();
        await fake.start();
        fake.seed(0x20000000, [1, 2, 3, 4]);
        fake.seed(0x20000020, [5, 6, 7, 8]);
        fake.transientFailures = 1;
        const session = new ManagedOpenOcdSession(null, {}, {});
        session.socket = await fake.connect();
        session._setupSocket();
        const plan = [
            { name: "a", address: 0x20000000, size: 4 },
            { name: "b", address: 0x20000020, size: 4 }
        ];
        try {
            await assert.rejects(session.readOnce(plan), /target memory read failed/);
            assert.strictEqual(session._batchUnsupported, false);
            const samples = await session.readOnce(plan);
            assert.deepStrictEqual(
                samples.map((sample) => sample.bytes),
                [
                    [1, 2, 3, 4],
                    [5, 6, 7, 8]
                ]
            );
            assert.strictEqual(fake.commands.filter((command) => command.includes("join [list")).length, 2);
        } finally {
            await session.stop();
            await fake.stop();
        }
    }

    // -------------------------------------------------------------
    // 5. Managed debug mode: Single response file round-trip & empty console output
    // -------------------------------------------------------------
    {
        const fake = new FakeOpenOcdServer();
        await fake.start();
        fake.seed(0x20000000, [0x11, 0x22, 0x33, 0x44]);
        fake.seed(0x20000020, [0x55, 0x66, 0x77, 0x88]);

        const session = new ManagedOpenOcdSession(null, { intervalMs: 20, mode: "debug" }, {});
        session.socket = await fake.connect();
        session._setupSocket();

        const initialCmdCount = fake.commands.length;
        const samples = await session.readOnce([
            { name: "v1", address: 0x20000000, size: 4 },
            { name: "v2", address: 0x20000020, size: 4 }
        ]);

        assert.strictEqual(samples.length, 2);
        assert.deepStrictEqual(samples[0].bytes, [0x11, 0x22, 0x33, 0x44]);
        assert.deepStrictEqual(samples[1].bytes, [0x55, 0x66, 0x77, 0x88]);

        // Debug mode must use response file and return empty string over Tcl socket
        assert.ok(
            fake.responses.every((r) => r === ""),
            "Debug mode Tcl responses must be silent/empty"
        );
        // Batched read should have added only 1 command to fake.commands for the 2 groups
        const addedCmds = fake.commands.slice(initialCmdCount);
        assert.strictEqual(addedCmds.length, 1, "Batched read in debug mode must perform only 1 RPC command");

        await session.stop();
        await fake.stop();
    }

    // -------------------------------------------------------------
    // 6. Pause reason and gap markers
    // -------------------------------------------------------------
    {
        const session = new ManagedOpenOcdSession(null, { intervalMs: 10, mode: "standalone" }, {});
        session.setSamplingEnabled(false);
        assert.strictEqual(session.stats().pauseReason, "paused");

        session.setPauseReason("backpressure");
        assert.strictEqual(session.stats().pauseReason, "backpressure");

        await session.stop();
        assert.strictEqual(session.stats().pauseReason, "stopped");
    }

    console.log("Adaptive sampling tests passed");
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
