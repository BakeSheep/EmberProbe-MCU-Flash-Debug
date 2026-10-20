"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { EventEmitter } = require("events");
const {
    LiveWatchSession,
    ManagedOpenOcdSession,
    validateManagedReadPlan,
    MAX_DEBUG_READ_COMMANDS
} = require("../src/liveWatch");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

(async () => {
    const fake = new FakeOpenOcdServer();
    await fake.start();
    fake.seed(0x20000000, [1, 2, 3, 4, 5, 6]);

    const session = new LiveWatchSession(null, {}, {});
    session.socket = await fake.connect();
    session._setupSocket();

    try {
        const samples = await session.readOnce([
            { name: "head", address: 0x20000000, size: 2 },
            { name: "tail", address: 0x20000002, size: 4 }
        ]);
        assert.deepStrictEqual(
            samples.map((sample) => ({ name: sample.name, bytes: sample.bytes })),
            [
                { name: "head", bytes: [1, 2] },
                { name: "tail", bytes: [3, 4, 5, 6] }
            ]
        );
        assert.deepStrictEqual(
            fake.commands.filter((command) => command.includes("read_memory")),
            ["ocd_read_memory 0x20000000 16 3"],
            "contiguous variables should be read in one Tcl command"
        );

        const transaction = await session.writeAndVerify([{ name: "pair", address: 0x20000001, bytes: [0xaa, 0xbb] }]);
        assert.strictEqual(transaction.halted, true);
        assert.deepStrictEqual(transaction.before[0].bytes, [2, 3]);
        assert.deepStrictEqual(transaction.after[0].bytes, [0xaa, 0xbb]);
        assert.deepStrictEqual(fake.bytes(0x20000000, 4), [1, 0xaa, 0xbb, 4]);
        assert.ok(
            fake.commands.includes("ocd_write_memory 0x20000001 8 {0xaa 0xbb}"),
            "unaligned byte changes write only the variable's own bytes"
        );
        assert.ok(
            !fake.commands.some((command) => command.startsWith("ocd_write_memory 0x20000000 32")),
            "landed narrow writes never rewrite neighbouring bytes"
        );
        assert.deepStrictEqual(
            fake.commands.filter((command) => command === "halt" || command === "resume"),
            ["halt", "resume"]
        );
        assert.strictEqual(fake.state, "running", "write transaction should restore the target run state");
        fake.seed(0x20000100, [1, 2, 3, 4]);
        fake.dropNarrowWrites = true;
        fake.commands.length = 0;
        const dropped = await session.writeAndVerify([{ name: "pair", address: 0x20000101, bytes: [0xcc, 0xdd] }]);
        assert.deepStrictEqual(dropped.after[0].bytes, [0xcc, 0xdd], "dropped narrow writes are retried as words");
        assert.deepStrictEqual(fake.bytes(0x20000100, 4), [1, 0xcc, 0xdd, 4]);
        assert.ok(fake.commands.includes("ocd_write_memory 0x20000100 32 {0x4ddcc01}"));
        fake.dropNarrowWrites = false;
        fake.commands.length = 0;
        const word = await session.writeAndVerify([
            { name: "word", address: 0x20000000, bytes: [0x78, 0x56, 0x34, 0x12] }
        ]);
        assert.strictEqual(word.halted, false);
        assert.deepStrictEqual(word.before[0].bytes, [1, 0xaa, 0xbb, 4]);
        assert.deepStrictEqual(word.after[0].bytes, [0x78, 0x56, 0x34, 0x12]);
        assert.deepStrictEqual(
            fake.commands,
            [
                "ocd_read_memory 0x20000000 32 1",
                "ocd_write_memory 0x20000000 32 {0x12345678}",
                "ocd_read_memory 0x20000000 32 1"
            ],
            "aligned word transactions need only before/write/after commands"
        );
        fake.commands.length = 0;
        const mixed = await session.writeAndVerify([
            { name: "word", address: 0x20000000, bytes: [1, 0, 0, 0] },
            { name: "byte", address: 0x20000005, bytes: [0xff] }
        ]);
        assert.strictEqual(mixed.halted, true);
        assert.deepStrictEqual(fake.bytes(0x20000004, 4), [5, 0xff, 0, 0]);
        assert.deepStrictEqual(
            fake.commands.filter((command) => /curstate|^halt$|^resume$/.test(command)),
            ["[target current] curstate", "halt", "resume"]
        );
        fake.state = "halted";
        fake.commands.length = 0;
        const paused = await session.writeAndVerify([{ name: "byte", address: 0x20000005, bytes: [7] }]);
        assert.strictEqual(paused.halted, true);
        assert.strictEqual(fake.state, "halted");
        assert.deepStrictEqual(
            fake.commands.filter((command) => /curstate|^halt$|^resume$/.test(command)),
            ["[target current] curstate"]
        );
    } finally {
        await session.stop();
        await fake.stop();
    }

    const debugFake = new FakeOpenOcdServer();
    await debugFake.start();
    debugFake.seed(0x20000000, [9, 8, 7, 6]);
    const managed = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    managed.socket = await debugFake.connect();
    managed._setupSocket();
    assert.deepStrictEqual(
        (await managed.readOnce([{ name: "counter", address: 0x20000000, size: 4 }]))[0].bytes,
        [9, 8, 7, 6]
    );
    assert.deepStrictEqual(debugFake.responses, [""], "managed debug reads must not emit Tcl values to GDB output");
    debugFake.commands.length = 0;
    const debugWord = await managed.writeAndVerify([{ name: "counter", address: 0x20000000, bytes: [1, 2, 3, 4] }]);
    assert.strictEqual(debugWord.halted, false);
    assert.deepStrictEqual(debugWord.before[0].bytes, [9, 8, 7, 6]);
    assert.deepStrictEqual(debugWord.after[0].bytes, [1, 2, 3, 4]);
    assert.deepStrictEqual(debugFake.commands, [
        "ocd_read_memory 0x20000000 32 1",
        "ocd_write_memory 0x20000000 32 {0x4030201}",
        "ocd_read_memory 0x20000000 32 1"
    ]);
    assert(
        debugFake.responses.every((response) => response === ""),
        "managed writes keep Tcl responses out of GDB output"
    );
    debugFake.commands.length = 0;
    await managed._writeMemoryBytes(0x20000000, [5, 6, 7, 8]);
    assert.deepStrictEqual(debugFake.commands, ["ocd_write_memory 0x20000000 32 {0x8070605}"]);
    debugFake.commands.length = 0;
    for (const [address, size] of [
        [0x20000000, 0],
        [0x20000000, 1],
        [0x20000000, 2],
        [0x20000001, 4],
        [0x20000000, 8]
    ]) {
        const bytes = new Uint8Array(size);
        await assert.rejects(
            managed.writeAndVerify([{ name: "counter", address, bytes }]),
            (error) => error.code === "RUNTIME_WRITE_DISABLED" && /Only aligned 32-bit writes/.test(error.message)
        );
        await assert.rejects(managed._writeMemoryBytes(address, bytes), { code: "RUNTIME_WRITE_DISABLED" });
    }
    await assert.rejects(
        managed.writeAndVerify(
            Array.from({ length: MAX_DEBUG_READ_COMMANDS + 1 }, (_, index) => ({
                name: "word" + index,
                address: 0x20000000 + index * 4,
                bytes: [1, 2, 3, 4]
            }))
        ),
        { code: "LIVE_WRITE_BUDGET_EXCEEDED" }
    );
    assert.deepStrictEqual(debugFake.commands, [], "invalid managed plans are refused before any hardware access");
    await assert.rejects(
        managed.writeOnce([{ address: 0x20000000, bytes: [1] }]),
        (error) => error.code === "RUNTIME_WRITE_DISABLED"
    );
    assert.throws(
        () => validateManagedReadPlan([{ name: "large", address: 0x20000000, size: 4097 }]),
        (error) => error.code === "LIVE_READ_BUDGET_EXCEEDED"
    );
    assert.throws(
        () => validateManagedReadPlan([{ name: "overflow", address: 0xffffffff, size: 2 }]),
        (error) => error.code === "LIVE_ADDRESS_NOT_RAM"
    );
    assert.throws(
        () =>
            validateManagedReadPlan(
                Array.from({ length: MAX_DEBUG_READ_COMMANDS + 1 }, (_, index) => ({
                    name: `sparse-${index}`,
                    address: 0x20000000 + index * 8,
                    size: 1
                }))
            ),
        (error) =>
            error.code === "LIVE_READ_BUDGET_EXCEEDED" && error.details.commandCount === MAX_DEBUG_READ_COMMANDS + 1,
        "sparse variables must not create an unbounded number of Tcl requests"
    );
    await scenario("Managed transactions survive sampling configuration changes", async () => {
        for (const operation of ["read", "write"]) {
            for (const phase of operation === "write"
                ? ["queued", "before", "between", "after"]
                : ["queued", "before"]) {
                for (const change of ["interval", "consumers", "enable", "sampling-pause"]) {
                    const writing = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
                    writing.socket = { destroyed: false };
                    writing._scheduleNext = () => {};
                    writing.setSamplingEnabled(true);
                    let memory = [0, 0, 0, 0];
                    let reads = 0;
                    const reconfigure = () => {
                        if (change === "interval") writing.setIntervalMs(50);
                        else if (change === "consumers")
                            writing.setSamplingPlan({
                                graphItems: [{ name: "other", address: 0x20000004, size: 4 }],
                                sidebarItems: [],
                                graphIntervalMs: 50
                            });
                        else if (change === "enable") writing.setSamplingEnabled(true);
                        // Backpressure, plan errors and user stops pause sampling without a target change.
                        else writing.setSamplingEnabled(false);
                    };
                    writing._readMemoryBytes = async () => {
                        reads++;
                        if ((phase === "before" && reads === 1) || (phase === "after" && reads === 2)) reconfigure();
                        return memory.slice();
                    };
                    writing._writeMemoryBytes = async (_address, bytes) => {
                        memory = Array.from(bytes);
                        if (phase === "between") reconfigure();
                    };
                    const item = { name: "word", address: 0x20000000, size: 4, bytes: [1, 0, 0, 0] };
                    if (phase === "queued") writing._tryAcquireExclusive();
                    try {
                        const pending =
                            operation === "write" ? writing.writeAndVerify([item]) : writing.readOnce([item]);
                        if (phase === "queued") {
                            reconfigure();
                            writing._releaseExclusive();
                        }
                        const result = await pending;
                        if (operation === "write") {
                            assert.deepStrictEqual(result.before[0].bytes, [0, 0, 0, 0]);
                            assert.deepStrictEqual(result.after[0].bytes, item.bytes);
                            assert.strictEqual(result.halted, false);
                        } else assert.deepStrictEqual(result[0].bytes, [0, 0, 0, 0]);
                        assert.strictEqual(writing.busy, false);
                    } finally {
                        writing.socket = null;
                        await writing.stop();
                    }
                }
            }
        }
    });
    await scenario("Target changes still invalidate managed transactions", async () => {
        for (const operation of ["read", "write"]) {
            for (const change of ["pause", "pause-resume", "disconnect", "stop"]) {
                for (const phase of operation === "write" ? ["before", "between", "after"] : ["before"]) {
                    const writing = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
                    writing.socket = { destroyed: false, destroy() {} };
                    writing._scheduleNext = () => {};
                    writing.setSamplingEnabled(true);
                    let reads = 0;
                    let writes = 0;
                    const invalidate = () => {
                        if (change === "disconnect") writing._abortConnection(new Error("Connection lost"));
                        else if (change === "stop") {
                            writing.socket = null;
                            void writing.stop();
                        } else {
                            writing.invalidateTarget();
                            writing.setSamplingEnabled(false);
                            if (change === "pause-resume") writing.setSamplingEnabled(true);
                        }
                    };
                    writing._readMemoryBytes = async () => {
                        reads++;
                        if ((phase === "before" && reads === 1) || (phase === "after" && reads === 2)) invalidate();
                        return [0, 0, 0, 0];
                    };
                    writing._writeMemoryBytes = async () => {
                        writes++;
                        if (phase === "between") invalidate();
                    };
                    const item = { name: "word", address: 0x20000000, size: 4, bytes: [1, 0, 0, 0] };
                    try {
                        await assert.rejects(
                            operation === "write" ? writing.writeAndVerify([item]) : writing.readOnce([item]),
                            (error) =>
                                error.code === "LIVE_READ_CANCELLED" &&
                                (operation === "read" ||
                                    (error.details.writtenItems === (phase === "before" ? 0 : 1) &&
                                        error.details.totalItems === 1)),
                            `${operation}: ${change} ${phase}`
                        );
                        assert.strictEqual(writes, phase === "before" ? 0 : 1);
                        assert.strictEqual(reads, phase === "after" ? 2 : 1);
                        assert.strictEqual(writing.busy, false);
                    } finally {
                        writing.socket = null;
                        await writing.stop();
                    }
                }
            }
        }
    });
    await scenario("Managed writes cancel before hardware on queued state changes and between words", async () => {
        const writing = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
        writing.socket = { destroyed: false };
        let writeCalls = 0;
        writing._writeMemoryBytes = async () => {
            writeCalls++;
            writing.invalidateTarget();
        };
        writing._readMemoryBytes = async () => [0, 0, 0, 0];
        writing._tryAcquireExclusive();
        const pending = writing.writeAndVerify([{ name: "word", address: 0x20000000, bytes: [1, 0, 0, 0] }]);
        writing.invalidateTarget();
        writing._releaseExclusive();
        await assert.rejects(pending, { code: "LIVE_READ_CANCELLED" });
        assert.strictEqual(writeCalls, 0);
        await assert.rejects(
            writing.writeAndVerify([
                { name: "first", address: 0x20000000, bytes: [1, 0, 0, 0] },
                { name: "second", address: 0x20000004, bytes: [2, 0, 0, 0] }
            ]),
            (error) =>
                error.code === "LIVE_READ_CANCELLED" &&
                error.details.writtenItems === 1 &&
                error.details.totalItems === 2
        );
        assert.strictEqual(writeCalls, 1, "state changes prevent the next word write");
        assert.strictEqual(writing.busy, false);
        await assert.rejects(writing.writeAndVerify([{ name: "word", address: 0x20000000, bytes: [1, 0, 0, 0] }], 0), {
            code: "LIVE_READ_BUDGET_EXCEEDED"
        });
        assert.strictEqual(writeCalls, 1, "expired cycle budgets prevent writes");
        writing.socket = null;
        await writing.stop();
    });
    let cancelledReadCalls = 0;
    const cancelling = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    cancelling.samplingEnabled = true;
    cancelling._readBatchBytes = async (batch) => {
        cancelledReadCalls++;
        cancelling.setSamplingEnabled(false);
        return batch.map(() => [1]);
    };
    await assert.rejects(
        cancelling._readItems(
            Array.from({ length: 9 }, (_, index) => ({
                name: `item-${index}`,
                address: 0x20000000 + index * 8,
                size: 1
            })),
            Date.now(),
            { epoch: cancelling.sampleEpoch, requireSampling: true, deadline: Date.now() + 1000 }
        ),
        (error) => error.code === "LIVE_READ_CANCELLED"
    );
    assert.strictEqual(cancelledReadCalls, 1, "a state change must prevent subsequent Tcl read batches");
    cancelling._tryAcquireExclusive();
    assert.strictEqual(await cancelling.waitForIdle(5), false, "quiesce timeout must be observable by the DAP bridge");
    cancelling._releaseExclusive();
    let queuedReadCalls = 0;
    const queuedRead = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    queuedRead.socket = { destroyed: false };
    queuedRead._tryAcquireExclusive();
    queuedRead._readMemoryBytes = async () => {
        queuedReadCalls++;
        return [1];
    };
    const queuedPromise = queuedRead.readOnce([{ name: "queued", address: 0x20000000, size: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    queuedRead.invalidateTarget();
    queuedRead._releaseExclusive();
    await assert.rejects(queuedPromise, (error) => error.code === "LIVE_READ_CANCELLED");
    assert.strictEqual(queuedReadCalls, 0, "a queued Agent read must not start after the target state changes");
    const lateSamples = [];
    const epochSession = new ManagedOpenOcdSession(
        null,
        { mode: "debug", intervalMs: 100 },
        {
            onSample: (samples) => lateSamples.push(samples)
        }
    );
    epochSession.socket = { destroyed: false };
    epochSession.watch = [{ name: "late", address: 0x20000000, size: 4 }];
    epochSession._readItems = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { samples: [{ name: "late", bytes: [1, 2, 3, 4] }], ok: 1 };
    };
    epochSession.setSamplingEnabled(true);
    const lateTick = epochSession._sampleTick();
    epochSession.setSamplingEnabled(false);
    await lateTick;
    assert.deepStrictEqual(lateSamples, [], "samples completed after a stop epoch must be discarded");
    if (epochSession.timer) clearInterval(epochSession.timer);
    let reconnectRequested = false;
    const debugTransportFailure = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    debugTransportFailure._startCompleted = true;
    debugTransportFailure.child = {
        killed: false,
        kill() {
            this.killed = true;
        }
    };
    debugTransportFailure.socket = {
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    };
    debugTransportFailure._reconnectDebugTcl = () => {
        reconnectRequested = true;
    };
    debugTransportFailure._abortConnection(new Error("Tcl disconnected"));
    assert.strictEqual(debugTransportFailure.stopped, false, "a debug Tcl failure must not stop OpenOCD");
    assert.strictEqual(debugTransportFailure.child.killed, false, "a debug Tcl failure must not kill GDB's server");
    assert.strictEqual(reconnectRequested, true);
    await managed.stop();
    await debugFake.stop();

    // Reload Window 停用扩展时必须先让 OpenOCD 收到 shutdown 并退出，不能立即断 socket/杀进程。
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = (signal) => {
        child.killed = true;
        child.lastSignal = signal || "SIGTERM";
        return true;
    };
    let shutdownFrame = "";
    const graceful = new LiveWatchSession(null, {}, {});
    graceful.child = child;
    graceful.socket = {
        destroyed: false,
        write(data, callback) {
            shutdownFrame = data;
            setImmediate(() => {
                callback();
                child.exitCode = 0;
                child.emit("close", 0);
            });
        },
        destroy() {
            this.destroyed = true;
        }
    };
    const gracefulStop = graceful.stop(100);
    assert.strictEqual(graceful.stopped, true, "stop should synchronously prevent more samples");
    assert.strictEqual(
        child.killed,
        false,
        "OpenOCD should get a graceful shutdown opportunity before signals are sent"
    );
    assert.strictEqual(await gracefulStop, true);
    assert.strictEqual(shutdownFrame, "shutdown\x1a");
    assert.strictEqual(child.killed, false, "a clean OpenOCD exit must not be followed by a kill signal");

    // Recovery needs a quiet interval and consecutive reads, not a single read.
    let recoveryNow = 0;
    const recoveryStatuses = [];
    const recoveryErrors = [];
    const recoverySamples = [];
    const recovering = new LiveWatchSession(
        null,
        { now: () => recoveryNow },
        {
            onStatus: (status) => recoveryStatuses.push(status),
            onError: (error) => recoveryErrors.push(error),
            onSample: (samples) => recoverySamples.push(samples)
        }
    );
    recovering.socket = { destroyed: false };
    recovering.watch = [{ name: "counter", address: 0x20000000, size: 4 }];
    let recoveryAttempt = 0;
    recovering._readItems = async (_items, timestamp) => {
        recoveryAttempt++;
        if (recoveryAttempt === 1) throw new Error("target reset during read");
        return { samples: [{ name: "counter", bytes: [2, 0, 0, 0], timestamp }], ok: 1 };
    };
    await recovering._sampleTick();
    assert.deepStrictEqual(recoveryErrors, ["target reset during read"]);
    assert.strictEqual(recovering._sampleErrorActive, true);
    await recovering._sampleTick();
    assert.strictEqual(recovering._sampleErrorActive, true);
    recoveryNow = 2001;
    await recovering._sampleTick();
    await recovering._sampleTick();
    assert.strictEqual(recovering._sampleErrorActive, false);
    assert.strictEqual(recoverySamples.length, 3);
    assert.deepStrictEqual(recoveryStatuses, [{ key: "sb.sampling" }]);

    // 写入事务独占 Tcl 连接期间到达的采样节拍必须重新排队：采样链是自调度的，
    // 直接丢弃节拍会让查看列表在写入一个变量后永久停更。
    const busySamples = [];
    const busySession = new ManagedOpenOcdSession(
        null,
        { intervalMs: 100 },
        {
            onSample: (samples) => busySamples.push(samples)
        }
    );
    busySession.socket = { destroyed: false };
    busySession.watch = [{ name: "counter", address: 0x20000000, size: 4 }];
    busySession._readItems = async (_items, timestamp) => ({
        samples: [{ name: "counter", bytes: [7, 0, 0, 0], timestamp }],
        ok: 1
    });
    busySession.setSamplingEnabled(true);
    busySession._clearSamplingTimer();
    busySession._tryAcquireExclusive();
    await busySession._sampleTick(true);
    assert.ok(busySession.timer, "a tick skipped for an in-flight write must re-arm the sampling chain");
    assert.deepStrictEqual(busySamples, [], "no sample may be read while the write owns the connection");
    busySession._releaseExclusive();
    busySession._clearSamplingTimer();
    await busySession._sampleTick(true);
    assert.strictEqual(busySamples.length, 1, "sampling must resume once the write transaction releases the link");
    busySession.setSamplingEnabled(false);
    busySession._clearSamplingTimer();
    busySession._releaseTimerResolution();

    await scenario("Repeated H7 polling failures stop standalone sampling and degrade managed sampling", async () => {
        const { LiveWatchSession, ManagedOpenOcdSession } = require("../src/liveWatch");
        let now = 0;
        const errors = [],
            statuses = [],
            disconnected = [];
        const session = new LiveWatchSession(
            null,
            { now: () => now },
            {
                onError: (error) => errors.push(error),
                onStatus: (status) => statuses.push(status),
                onDisconnect: (error) => disconnected.push(error)
            }
        );
        session.socket = {
            destroyed: false,
            destroy() {
                this.destroyed = true;
            }
        };
        session.watch = [{ name: "count", address: 0x20000000, size: 4 }];
        session._readItems = async () => ({ samples: [], ok: 1 });
        const message = "[stm32h7x.cpu0] Polling failed, trying to reexamine";
        session._handlePollingFailure(message);
        await session._sampleTick();
        now = 1000;
        session._handlePollingFailure(message);
        await session._sampleTick();
        now = 3100;
        session._handlePollingFailure(message);
        assert.strictEqual(errors.length, 1, "identical polling errors are shown once");
        assert.strictEqual(statuses.length, 0, "successful RAM reads must not clear repeated target polling errors");
        assert.strictEqual(session.stopped, true);
        assert.strictEqual(disconnected[0].code, "LIVE_TARGET_POLL_FAILED");
        assert.strictEqual(session.setSamplingEnabled(true), false);

        let degraded = 0,
            killed = 0;
        now = 0;
        const managed = new ManagedOpenOcdSession(
            null,
            { mode: "debug", now: () => now },
            { onDegraded: () => degraded++ }
        );
        managed.child = { kill: () => killed++ };
        for (now of [0, 1000, 3100, 4000]) managed._handlePollingFailure(message);
        assert.strictEqual(degraded, 1);
        assert.strictEqual(killed, 0, "sampling degradation must not kill GDB's OpenOCD server");
        assert.strictEqual(managed.setSamplingEnabled(true), false);
    });

    console.log("Live watch Tcl-RPC integration tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
