"use strict";
const assert = require("assert");
const path = require("path");
const { EventEmitter } = require("events");
const { MultiRatePlan } = require("../src/services/multiRatePlan");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { SamplingSession } = require("../src/samplingSession");
const { scheduleSamplingTick } = require("../src/samplingClock");
const { run } = require("../src/samplingWorker");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

const graph = { name: "graph", address: 0x20000000, size: 4 };
const sidebar = { name: "sidebar", address: 0x20000010, size: 4 };
const plan = (unlimited = true) => ({ graphItems: [graph], sidebarItems: [sidebar], graphIntervalMs: 5, unlimited });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, message, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        assert(Date.now() < deadline, message);
        await wait(2);
    }
}
function assertStats(stats, requested, active, reason = null) {
    assert.strictEqual(stats.unlimited, requested);
    assert.strictEqual(stats.unlimitedActive, active);
    assert.strictEqual(stats.unlimitedSuppressedReason, reason);
    assert.strictEqual(typeof stats.hostHoldMs, "number");
    assert(Number.isFinite(stats.hostHoldMs) && stats.hostHoldMs >= 0);
    assert(active ? ["probe", "host"].includes(stats.limitedBy) : stats.limitedBy === null);
    if (stats.consumers) {
        assert.strictEqual(stats.consumers.unlimited, active);
        assert.strictEqual(stats.consumers.graphTargetHz, active ? null : 200);
    }
}

function testPlanAndClock() {
    const unlimited = new MultiRatePlan(plan());
    assert.strictEqual(unlimited.intervalMs, 0);
    assert.strictEqual(unlimited.delay(0), 0);
    const first = unlimited.due(100, 0);
    assert.deepStrictEqual(
        first.items.map((item) => item.name),
        ["graph", "sidebar"]
    );
    unlimited.deliver(
        [
            { name: "graph", bytes: [1] },
            { name: "sidebar", bytes: [2] }
        ],
        1000,
        first
    );
    const second = unlimited.due(101, 0);
    assert.deepStrictEqual(second.graphNames, ["graph"]);
    assert.deepStrictEqual(second.sidebarNames, []);
    assert.deepStrictEqual(
        second.items.map((item) => item.name),
        ["graph"]
    );
    unlimited.deliver([{ name: "graph", bytes: [3] }], 1001, second);
    const third = unlimited.due(149, 0);
    unlimited.deliver([{ name: "graph", bytes: [4] }], 1049, third);
    const sidebarDue = unlimited.due(150, 0);
    assert.deepStrictEqual(sidebarDue.sidebarNames, ["sidebar"]);
    const delivered = unlimited.deliver(
        [
            { name: "graph", bytes: [5] },
            { name: "sidebar", bytes: [6] }
        ],
        1050,
        sidebarDue
    );
    assert.strictEqual(delivered.find((sample) => sample.name === "sidebar").t, 1050);
    assert.strictEqual(unlimited.stats().graphTargetHz, null);
    assert.strictEqual(unlimited.stats().unlimited, true);
    assert.strictEqual(unlimited.stats().sidebarTargetHz, 20);
    // A shared graph/sidebar value uses the most recent graph sample without another read.
    const shared = new MultiRatePlan({ ...plan(), sidebarItems: [graph] });
    shared.deliver([{ name: "graph", bytes: [7] }], 10, shared.due(0, 0));
    const cachedDue = shared.due(50, 0);
    assert.strictEqual(cachedDue.items.length, 1);
    assert.deepStrictEqual(shared.deliver([{ name: "graph", bytes: [8] }], 60, cachedDue)[0].bytes, [8]);
    const normal = new MultiRatePlan(plan(false));
    assert.strictEqual(normal.intervalMs, 5);
    normal.due(100, 5);
    assert.strictEqual(normal.delay(101), 4);
    assert.deepStrictEqual(normal.due(101, 5).graphNames, []);
    assert.strictEqual(normal.stats().graphTargetHz, 200);
    assert.strictEqual(normal.stats().unlimited, false);
    const emptyGraph = new MultiRatePlan({ ...plan(), graphItems: [] });
    assert.strictEqual(emptyGraph.intervalMs, 50);
    emptyGraph.due(0, 0);
    assert.strictEqual(emptyGraph.delay(1), 49);
    assert.strictEqual(emptyGraph.stats().unlimited, false);

    const saved = {
        setImmediate: global.setImmediate,
        clearImmediate: global.clearImmediate,
        setTimeout: global.setTimeout,
        clearTimeout: global.clearTimeout
    };
    const calls = [];
    try {
        global.setImmediate = (callback) => {
            calls.push(["immediate", callback]);
            return "immediate-handle";
        };
        global.clearImmediate = (handle) => calls.push(["cancel-immediate", handle]);
        global.setTimeout = (callback, delay) => {
            calls.push(["timeout", delay, callback]);
            return "timeout-handle";
        };
        global.clearTimeout = (handle) => calls.push(["cancel-timeout", handle]);
        for (const platform of ["linux", "darwin", "win32"]) {
            const timer = scheduleSamplingTick(0, () => {}, { platform, immediate: true });
            assert.strictEqual(calls.at(-1)[0], "immediate", platform);
            timer.cancel();
            assert.deepStrictEqual(calls.at(-1), ["cancel-immediate", "immediate-handle"]);
        }
        scheduleSamplingTick(0, () => {}, { platform: "linux" }).cancel();
        assert.deepStrictEqual(calls.at(-2).slice(0, 2), ["timeout", 0], "normal timing stays opt-in");
        const local = new ManagedOpenOcdSession(null, {}, {});
        local.setSamplingPlan(plan());
        local.socket = { destroyed: false };
        local._scheduleNext(0);
        assert.strictEqual(calls.at(-1)[0], "immediate", "session opts into setImmediate");
        local.setSamplingEnabled(false);
        assert.strictEqual(local.timer, null);
        assert.strictEqual(local._timerResolutionHeld, false);
    } finally {
        Object.assign(global, saved);
    }
}

async function testSessionAndFairness() {
    const fake = new FakeOpenOcdServer();
    const samples = [],
        errors = [];
    const session = new ManagedOpenOcdSession(
        null,
        {},
        {
            onSample: (items, t, consumers) =>
                samples.push({ items, t, consumers, interval: session.effectiveIntervalMs }),
            onError: (error) => errors.push(error)
        }
    );
    try {
        await fake.start();
        fake.seed(graph.address, [1, 2, 3, 4]);
        fake.seed(sidebar.address, [5, 6, 7, 8]);
        fake.readLatencyMs = 1;
        session.socket = await fake.connect();
        session._setupSocket();
        session.setSamplingPlan(plan());
        assertStats(session.stats(), true, true);
        assert.strictEqual(session.stats().limitedBy, "probe");
        assert.strictEqual(session.effectiveIntervalMs, 0);
        assert.strictEqual(session._warmingUp, false);
        await waitFor(() => samples.length >= 8, "unlimited ticks run back-to-back");
        assert(samples.slice(0, 8).every((sample) => sample.interval === 0));
        assert(samples[7].t - samples[0].t < 250, "no 100 ms warm-up floor");
        assert(samples.every((sample) => sample.consumers.graphNames.includes("graph")));
        const misses = session.stats().missedDeadlines;
        for (let index = 0; index < 40; index++) session._recordCycle(500, true, Date.now() + index);
        session._evaluateAdaptiveSchedule();
        assert.strictEqual(session.effectiveIntervalMs, 0, "slow reads never cause unlimited backoff");
        assert.strictEqual(session.stats().missedDeadlines, misses);
        assert.strictEqual(session.stats().p95DurationMs, 500);
        assert(session.stats().actualHz > 0);
        session.setIntervalMs(10);
        assert.strictEqual(session.effectiveIntervalMs, 0, "finite target changes retain unlimited mode");
        session.setIntervalMs(5);

        await waitFor(() => session.busy, "a variable tick owns the socket");
        const order = [];
        const readItems = session._readItems.bind(session);
        const writeBytes = session._writeMemoryBytes.bind(session);
        const checked = session._sendCheckedCommand.bind(session);
        session._readItems = async (...args) => {
            if (args[0][0]?.name === "once") order.push("read");
            if (args[0][0]?.name === "verify") order.push("verify-read");
            return readItems(...args);
        };
        session._writeMemoryBytes = async (address, bytes) => {
            order.push("write:" + bytes[0]);
            return writeBytes(address, bytes);
        };
        session._sendCheckedCommand = async (command) => {
            if (command === "[target current] curstate")
                assert.fail("aligned verification must not query target state");
            return checked(command);
        };
        const reads = session.readOnce([{ ...graph, name: "once" }], 500);
        const writes = session.writeAndVerify([{ ...graph, name: "first", bytes: [9, 8, 7, 6] }], 500);
        const verifies = session.writeAndVerify([{ ...graph, name: "verify", bytes: [4, 3, 2, 1] }], 500);
        const idle = session.waitForIdle(500);
        const [readResult, written, verified, idleResult] = await Promise.all([reads, writes, verifies, idle]);
        assert.deepStrictEqual(
            order,
            ["read", "write:9", "verify-read", "write:4", "verify-read"],
            "FIFO transactions cannot starve"
        );
        assert.strictEqual(verified.halted, false);
        assert.deepStrictEqual(readResult[0].bytes, [1, 2, 3, 4]);
        assert.deepStrictEqual(written.after[0].bytes, [9, 8, 7, 6]);
        assert.deepStrictEqual(verified.before[0].bytes, [9, 8, 7, 6]);
        assert.deepStrictEqual(verified.after[0].bytes, [4, 3, 2, 1]);
        assert.strictEqual(idleResult, true);
        assert.strictEqual(fake.maxInFlight, 1);
        assert.deepStrictEqual(errors, []);
        session.setHostHold(true);
        await wait(5);
        const held = session.stats().hostHoldMs;
        assert(held > 0);
        session.setHostHold(false);
        await wait(1050);
        assert.strictEqual(session.stats().hostHoldMs, 0, "hold time ages out of the one-second window");
        assert.strictEqual(session.stats().limitedBy, "probe");
        // Rate-only changes retain calibration, while discarding an old in-flight cycle.
        await waitFor(() => session.busy, "tick in flight before leaving unlimited");
        const durations = session._recentDurations.slice();
        const scheduleNext = session._scheduleNext;
        session._scheduleNext = () => {};
        session.setSamplingPlan(plan(false));
        assertStats(session.stats(), false, false);
        assert.strictEqual(
            session.effectiveIntervalMs,
            Math.max(5, Math.ceil(session._adaptiveCost().duration / 0.85))
        );
        assert.strictEqual(session._warmingUp, false);
        assert.deepStrictEqual(session._recentDurations, durations);
        await waitFor(() => !session.busy, "old cycle releases ownership");
        assert.deepStrictEqual(session._recentDurations, durations, "old unlimited cycle is discarded");
        session._scheduleNext = scheduleNext;
        session.setSamplingEnabled(false);
        await session.waitForIdle();
        assert.strictEqual(session.timer, null);
        assert.strictEqual(session._timerResolutionHeld, false);
    } finally {
        await session.stop();
        await fake.stop();
    }
    const debug = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    debug.setSamplingPlan(plan());
    assertStats(debug.stats(), true, false, "debug");
    assert.strictEqual(debug.effectiveIntervalMs, 100);
    for (let index = 0; index < 4; index++) debug._recordCycle(4);
    assert.strictEqual(debug.effectiveIntervalMs, 10, "debug retains its 40% adaptive threshold");
    await debug.stop();
    const sidebarOnly = new ManagedOpenOcdSession(null, {}, {});
    sidebarOnly.setSamplingPlan({ ...plan(), graphItems: [] });
    assertStats(sidebarOnly.stats(), true, false);
    assert.strictEqual(sidebarOnly.effectiveIntervalMs, 100);
    await sidebarOnly.stop();
}

async function testArbiterFailures() {
    const session = new ManagedOpenOcdSession(null, {}, {});
    session.samplingEnabled = false;
    session.socket = {
        destroyed: false,
        write: (_data, callback) => callback?.(),
        destroy() {
            this.destroyed = true;
        }
    };
    assert(session._tryAcquireExclusive());
    const order = [];
    const first = session._acquireExclusive(Date.now() + 1000).then(() => {
        order.push(1);
        assert.strictEqual(session.busy, true);
        assert.strictEqual(session._tryAcquireExclusive(), false);
        session._releaseExclusive();
    });
    const second = session._acquireExclusive(Date.now() + 1000).then(() => {
        order.push(2);
        session._releaseExclusive();
    });
    session._releaseExclusive();
    assert.strictEqual(session._tryAcquireExclusive(), false, "handoff reserves busy before the waiter continuation");
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, [1, 2]);
    assert.strictEqual(session.busy, false);
    assert(session._tryAcquireExclusive());
    const timedOut = session.readOnce([graph], 5);
    await assert.rejects(
        timedOut,
        (error) =>
            error.code === "PROBE_CONNECTION_BUSY_TIMEOUT" &&
            error.message === "Timed out waiting for the sampling connection to become idle"
    );
    await assert.rejects(session.writeAndVerify([{ ...graph, bytes: [1] }], 0), {
        code: "PROBE_CONNECTION_BUSY_TIMEOUT"
    });
    assert.strictEqual(await session.waitForIdle(5), false);
    assert.strictEqual(session._exclusiveWaiters.length, 0);
    session._releaseExclusive();
    session._readItems = async () => {
        throw new Error("read exception");
    };
    await assert.rejects(session.readOnce([graph]), /read exception/);
    assert.strictEqual(session.busy, false);
    session._writeMemoryBytes = async () => {
        throw new Error("write exception");
    };
    session._readItems = async (items) => ({ samples: items.map((item) => ({ name: item.name, bytes: [0] })), ok: 1 });
    await assert.rejects(session.writeAndVerify([{ ...graph, bytes: [1, 2, 3, 4] }]), /write exception/);
    assert.strictEqual(session.busy, false);
    const commands = [];
    session._sendCheckedCommand = async (command) => {
        commands.push(command);
        return "running";
    };
    session._readItems = async () => ({ samples: [], ok: 1 });
    await assert.rejects(session.writeAndVerify([{ ...graph, bytes: [1] }]), /write exception/);
    assert.strictEqual(commands.at(-1), "resume", "failed writes still restore running state");
    assert.strictEqual(session.busy, false);
    session.setSamplingPlan(plan());
    session._readItems = async () => {
        throw new Error("tick exception");
    };
    session.setSamplingEnabled(true);
    session._clearSamplingTimer();
    await session._sampleTick();
    assert.strictEqual(session.busy, false, "variable exceptions also release Tcl ownership");
    session.setSamplingEnabled(false);
    assert(session._tryAcquireExclusive());
    session._readItems = async () => ({ samples: [{ name: "graph", bytes: [7] }], ok: 1 });
    const preserved = session.readOnce([graph], 10000);
    session.setSamplingPlan(plan());
    session._releaseExclusive();
    assert.deepStrictEqual((await preserved)[0].bytes, [7], "standalone read waiters survive plan changes");
    session.setSamplingEnabled(false);
    assert(session._tryAcquireExclusive());
    const rejected = assert.rejects(session.readOnce([graph], 10000), /Stopped|stopped/);
    await session.stop();
    await rejected;
    assert.strictEqual(session._exclusiveWaiters.length, 0);
    session._releaseExclusive();
    assert.strictEqual(session.busy, false);
    const lost = new ManagedOpenOcdSession(null, {}, {});
    assert(lost._tryAcquireExclusive());
    const loss = assert.rejects(lost._acquireExclusive(Date.now() + 10000), /socket lost/);
    lost._abortConnection(new Error("socket lost"));
    await loss;
    assert.strictEqual(lost._exclusiveWaiters.length, 0);
    lost._releaseExclusive();
    await lost.stop();
}

async function testWorkerHold(byteLimit = false) {
    const port = new EventEmitter();
    const messages = [];
    port.postMessage = (message) => messages.push(message);
    let session,
        acquired = 0;
    const payload = [{ name: "graph", bytes: byteLimit ? Buffer.alloc(1024 * 1024) : [1, 2, 3, 4] }];
    run(port, {}, (options, handlers) => {
        session = new ManagedOpenOcdSession(null, options, handlers);
        session.socket = {
            destroyed: false,
            write: (_data, callback) => callback?.(),
            destroy() {
                this.destroyed = true;
            }
        };
        session._readItems = async () => {
            acquired++;
            return { samples: payload, ok: 1 };
        };
        return session;
    });
    const operation = async (id, method, args) => {
        port.emit("message", { id, method, args, generation: id });
        await waitFor(() => messages.some((message) => message.id === id), method + " worker reply");
        const reply = messages.find((message) => message.id === id);
        assert(!reply.error, reply.error?.message);
        return reply;
    };
    try {
        await operation(1, "setSamplingPlan", [plan()]);
        await waitFor(() => session._hostHold, "soft host hold engages");
        assert.strictEqual(acquired, byteLimit ? 2 : 9, "one posted message plus a bounded queued backlog");
        assert.strictEqual(session.samplingEnabled, true, "host hold does not disable the sampling plan");
        assert.strictEqual(session.timer, null);
        const epoch = session.sampleEpoch;
        session.setSamplingEnabled(true);
        assert.strictEqual(session.sampleEpoch, epoch, "repeated enable preserves a held loop");
        assert.strictEqual(session._hostHold, true);
        const heldCount = acquired;
        await wait(300);
        assert.strictEqual(acquired, heldCount, "host hold prevents new variable ticks");
        const heldStats = (await operation(2, "stats", [])).result;
        assertStats(heldStats, true, true);
        assert.strictEqual(heldStats.limitedBy, "host");
        assert(heldStats.hostHoldMs >= 250 && heldStats.hostHoldMs <= 1000);
        assert(
            !messages.some((message) => message.event === "onError"),
            "soft hold never reaches the hard error limit"
        );
        port.emit("message", { ack: true });
        assert.strictEqual(session._hostHold, false);
        const drained = messages.filter((message) => message.event === "samples").at(-1);
        assert.strictEqual(drained.batch.length, byteLimit ? 1 : 8);
        for (const batch of drained.batch) {
            assert.strictEqual(batch.samples[0].bytes, payload[0].bytes, "flow control preserves each payload");
            assert.strictEqual(batch.samples[0].t, batch.t, "each batch keeps its own sample timestamp");
            assert.deepStrictEqual(batch.consumers.graphNames, ["graph"]);
            assert.strictEqual(typeof batch.t, "number");
        }
        await waitFor(() => acquired > heldCount, "ack resumes immediate sampling");
        await operation(3, "setSamplingPlan", [plan(false)]);
        assert.strictEqual(session._hostHold, false);
        assert.strictEqual(session.stats().hostHoldMs, 0);
        assert.strictEqual(session.stats().limitedBy, null);
        await operation(4, "stop", []);
        assert.strictEqual(session.timer, null);
        assert.strictEqual(session._exclusiveWaiters.length, 0);
        assert.strictEqual(session._timerResolutionHeld, false);
        assert(!messages.some((message) => message.event === "onError"));
    } finally {
        await session.stop();
        port.emit("close");
    }
}

async function testDeferredForegroundTick() {
    let releaseWrite,
        enteredWrite = false,
        ticks = 0,
        samples = 0;
    const writeGate = new Promise((resolve) => {
        releaseWrite = resolve;
    });
    const session = new ManagedOpenOcdSession(
        null,
        {},
        {
            onSample() {
                samples++;
                session.setSamplingEnabled(false);
            }
        }
    );
    session.socket = {
        destroyed: false,
        write: (_data, callback) => callback?.(),
        destroy() {
            this.destroyed = true;
        }
    };
    session._readItems = async (items) => ({
        samples: items.map((item) => ({ name: item.name, bytes: [1] })),
        ok: items.length
    });
    session._sendCheckedCommand = async () => "running";
    session._writeMemoryBytes = async () => {
        enteredWrite = true;
        await writeGate;
    };
    const tick = session._sampleTick.bind(session);
    session._sampleTick = (...args) => {
        ticks++;
        return tick(...args);
    };
    assert(session._tryAcquireExclusive());
    session.setSamplingPlan(plan());
    const writing = session.writeAndVerify([{ ...graph, bytes: [9] }]);
    session._releaseExclusive();
    try {
        await waitFor(() => enteredWrite && ticks > 0, "foreground write owns the link while a tick is due");
        const started = Date.now();
        await wait(30);
        assert(Date.now() - started >= 25, "the foreground transaction holds the link for about 30 ms");
        assert(ticks <= 3, "unlimited must not spin while a foreground transaction owns Tcl: " + ticks);
        assert.strictEqual(samples, 0);
        releaseWrite();
        await writing;
        await waitFor(() => samples === 1, "sampling resumes immediately after the foreground write", 100);
        assert.strictEqual(session._samplingTickDeferred, false);
    } finally {
        releaseWrite();
        await writing;
        await session.stop();
    }
}

async function testDeferredLifecycle() {
    for (const action of ["timeout", "reject", "pause", "hold", "plan", "watch", "stop", "disconnect"]) {
        let samples = 0;
        const session = new ManagedOpenOcdSession(
            null,
            {},
            {
                onSample() {
                    samples++;
                    session.setSamplingEnabled(false);
                }
            }
        );
        session.samplingEnabled = false;
        session.socket = {
            destroyed: false,
            write: (_data, callback) => callback?.(),
            destroy() {
                this.destroyed = true;
            }
        };
        session._readItems = async (items) => ({
            samples: items.map((item) => ({ name: item.name, bytes: [1] })),
            ok: items.length
        });
        session.setSamplingPlan(plan());
        session.samplingEnabled = true;
        assert(session._tryAcquireExclusive());
        await session._sampleTick(true);
        assert.strictEqual(session._samplingTickDeferred, true, action);
        assert.strictEqual(session.timer, null);
        try {
            if (action === "timeout") {
                await assert.rejects(session._acquireExclusive(Date.now() + 5), {
                    code: "PROBE_CONNECTION_BUSY_TIMEOUT"
                });
                assert.strictEqual(session._samplingTickDeferred, true, "a timeout cannot bypass the current owner");
                assert.strictEqual(session.timer, null);
            } else if (action === "reject") {
                const rejected = assert.rejects(session._acquireExclusive(Date.now() + 1000), /waiter rejected/);
                session._rejectExclusiveWaiters(new Error("waiter rejected"));
                await rejected;
                assert.strictEqual(
                    session._samplingTickDeferred,
                    true,
                    "the owner still holds Tcl after waiter rejection"
                );
            } else if (action === "pause") session.setSamplingEnabled(false);
            else if (action === "hold") session.setHostHold(true);
            else if (action === "plan") session.setSamplingPlan(plan(false));
            else if (action === "watch") session.setWatch([graph]);
            else if (action === "stop") await session.stop();
            else session._abortConnection(new Error("connection lost"));
            if (!["timeout", "reject"].includes(action))
                assert.strictEqual(session._samplingTickDeferred, false, action + " clears the old deferred tick");
            session._releaseExclusive();
            if (["pause", "hold", "stop", "disconnect"].includes(action)) {
                assert.strictEqual(session.timer, null, action + " cannot resume on release");
                await wait(5);
                assert.strictEqual(samples, 0);
            }
            if (action === "pause") session.setSamplingEnabled(true);
            if (action === "hold") session.setHostHold(false);
            if (!["stop", "disconnect"].includes(action))
                await waitFor(() => samples === 1, action + " cannot kill the sampling chain", 200);
        } finally {
            await session.stop();
            session._releaseExclusive();
        }
    }
    // Deferred sampling must remain asleep across the whole FIFO handoff, not only the first release.
    const session = new ManagedOpenOcdSession(null, {}, {});
    session.samplingEnabled = false;
    session.setSamplingPlan(plan());
    session.samplingEnabled = true;
    session.socket = { destroyed: false };
    assert(session._tryAcquireExclusive());
    const first = session._acquireExclusive(Date.now() + 1000);
    const second = session._acquireExclusive(Date.now() + 1000);
    await session._sampleTick(true);
    session._releaseExclusive();
    await first;
    assert.strictEqual(session.timer, null);
    assert.strictEqual(session._samplingTickDeferred, true);
    session._releaseExclusive();
    await second;
    assert.strictEqual(session.timer, null);
    assert.strictEqual(session._samplingTickDeferred, true);
    session.setSamplingEnabled(false);
    session._releaseExclusive();
    assert.strictEqual(session.timer, null);
    session.socket = null;
    await session.stop();
}

async function testWaitersSurvivePlans() {
    for (const unlimited of [true, false]) {
        const session = new ManagedOpenOcdSession(null, {}, {});
        session.samplingEnabled = false;
        session.socket = {
            destroyed: false,
            write: (_data, callback) => callback?.(),
            destroy() {
                this.destroyed = true;
            }
        };
        let value = 1;
        session._readItems = async (items) => ({
            samples: items.map((item) => ({ name: item.name, bytes: [value] })),
            ok: items.length
        });
        session._sendCheckedCommand = async () => "running";
        session._writeMemoryBytes = async (_address, bytes) => {
            value = bytes[0];
        };
        assert(session._tryAcquireExclusive());
        const pending = Promise.all([
            session.readOnce([graph]),
            session.writeAndVerify([{ ...graph, bytes: [2] }]),
            session.writeAndVerify([{ ...graph, bytes: [3] }])
        ]);
        pending.catch(() => {});
        try {
            session.setSamplingPlan(plan(unlimited));
            session.setSamplingPlan(plan(!unlimited));
            assert.strictEqual(session._exclusiveWaiters.length, 3, "plan reapplications preserve every queued caller");
            session._releaseExclusive();
            const [readResult, written, verified] = await pending;
            assert.deepStrictEqual(readResult[0].bytes, [1]);
            assert.deepStrictEqual(written.after[0].bytes, [2]);
            assert.deepStrictEqual(verified.before[0].bytes, [2]);
            assert.deepStrictEqual(verified.after[0].bytes, [3]);
            assert.strictEqual(session.busy, false);
        } finally {
            await session.stop();
            await pending.catch(() => {});
            session._releaseExclusive();
        }
    }
}

async function testSetWatchPreservesBacklog() {
    const port = new EventEmitter(),
        messages = [];
    port.postMessage = (message) => messages.push(message);
    let session, handlers;
    run(port, {}, (options, nextHandlers) => {
        handlers = nextHandlers;
        session = new ManagedOpenOcdSession(null, options, handlers);
        return session;
    });
    session.setSamplingPlan(plan());
    const payloads = Array.from({ length: 9 }, (_, index) => [{ name: "graph", bytes: [index] }]);
    try {
        for (let index = 0; index < payloads.length; index++)
            handlers.onSample(payloads[index], 100 + index, { graphNames: ["graph"], sidebarNames: [] });
        assert.strictEqual(messages.filter((message) => message.event === "samples").length, 1);
        port.emit("message", { id: 1, method: "setWatch", args: [[sidebar]], generation: 99 });
        await waitFor(() => messages.some((message) => message.id === 1), "setWatch worker reply");
        assert(!messages.find((message) => message.id === 1).error);
        port.emit("message", { ack: true });
        const batches = messages.filter((message) => message.event === "samples").flatMap((message) => message.batch);
        assert.strictEqual(batches.length, 9, "setWatch must preserve every queued batch in the current generation");
        assert.deepStrictEqual(
            batches.map((batch) => batch.t),
            Array.from({ length: 9 }, (_, index) => 100 + index)
        );
        assert(batches.every((batch) => batch.generation === 0));
        batches.forEach((batch, index) => assert.strictEqual(batch.samples, payloads[index]));
    } finally {
        await session.stop();
        port.emit("close");
    }
}

async function testHostTransport() {
    const fallback = Object.create(SamplingSession.prototype);
    fallback.options = { intervalMs: 5 };
    fallback.mode = "standalone";
    assertStats(fallback.stats(), false, false);
    fallback._samplingPlan = plan();
    assertStats(fallback.stats(), true, true);
    assert.strictEqual(fallback.stats().effectiveIntervalMs, 0);
    fallback.mode = "debug";
    assertStats(fallback.stats(), true, false, "debug");
    fallback.mode = "standalone";
    fallback._samplingPlan = { ...plan(), graphItems: [] };
    assertStats(fallback.stats(), true, false);
    const samples = [];
    const host = new SamplingSession(
        {},
        { onSample: (items, t, consumers) => samples.push({ items, t, consumers }) },
        path.join(__dirname, "helpers/sampling-worker-fixture.js")
    );
    try {
        host.setSamplingPlan(plan());
        await host.start();
        const stats = (await host.request("stats")).result;
        assertStats(stats, true, true);
        await waitFor(() => samples.length >= 3, "host receives unchanged unlimited batches");
        assert.deepStrictEqual(samples[0].items[0].bytes, [1, 2, 3, 4]);
        assert.deepStrictEqual(samples[0].consumers.graphNames, ["graph"]);
        host.setSamplingPlan(plan(false));
        assertStats((await host.request("stats")).result, false, false);
        host.setSamplingEnabled(false);
        assert.strictEqual(await host.waitForIdle(), true);
    } finally {
        await host.stop();
    }
}

(async () => {
    testPlanAndClock();
    await testDeferredForegroundTick();
    await testDeferredLifecycle();
    await testWaitersSurvivePlans();
    await testSetWatchPreservesBacklog();
    await testSessionAndFairness();
    await testArbiterFailures();
    await testWorkerHold();
    await testWorkerHold(true);
    await testHostTransport();
    console.log("Unlimited sampling, FIFO Tcl ownership and host flow control passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
