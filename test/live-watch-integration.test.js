"use strict";
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
        assert.deepStrictEqual(transaction.before[0].bytes, [2, 3]);
        assert.deepStrictEqual(transaction.after[0].bytes, [0xaa, 0xbb]);
        assert.deepStrictEqual(fake.bytes(0x20000000, 4), [1, 0xaa, 0xbb, 4]);
        assert.ok(
            fake.commands.includes("ocd_write_memory 0x20000000 32 {0x4bbaa01}"),
            "unaligned byte changes should use a preserving aligned word write"
        );
        assert.deepStrictEqual(
            fake.commands.filter((command) => command === "halt" || command === "resume"),
            ["halt", "resume"]
        );
        assert.strictEqual(fake.state, "running", "write transaction should restore the target run state");
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
    let cancelledReadCalls = 0;
    const cancelling = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    cancelling.samplingEnabled = true;
    cancelling._readMemoryBytes = async () => {
        cancelledReadCalls++;
        cancelling.setSamplingEnabled(false);
        return [1];
    };
    await assert.rejects(
        cancelling._readItems(
            [
                { name: "first", address: 0x20000000, size: 1 },
                { name: "second", address: 0x20000008, size: 1 }
            ],
            Date.now(),
            { epoch: cancelling.sampleEpoch, requireSampling: true, deadline: Date.now() + 1000 }
        ),
        (error) => error.code === "LIVE_READ_CANCELLED"
    );
    assert.strictEqual(cancelledReadCalls, 1, "a state change must prevent subsequent Tcl read groups");
    cancelling.busy = true;
    assert.strictEqual(await cancelling.waitForIdle(5), false, "quiesce timeout must be observable by the DAP bridge");
    cancelling.busy = false;
    let queuedReadCalls = 0;
    const queuedRead = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    queuedRead.socket = { destroyed: false };
    queuedRead.busy = true;
    queuedRead._readMemoryBytes = async () => {
        queuedReadCalls++;
        return [1];
    };
    const queuedPromise = queuedRead.readOnce([{ name: "queued", address: 0x20000000, size: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    queuedRead.setSamplingEnabled(false);
    queuedRead.busy = false;
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

    console.log("Live watch Tcl-RPC integration tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
