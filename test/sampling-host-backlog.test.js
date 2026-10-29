"use strict";
const assert = require("assert");
const path = require("path");
const { EventEmitter } = require("events");
const { run } = require("../src/samplingWorker");
const { SamplingSession } = require("../src/samplingSession");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { HostLoopDelay } = require("../src/services/hostLoopDelay");
const { loadProvider } = require("./helpers/load-provider");

const graph = { graphNames: ["g"], sidebarNames: [] };
const sidebar = { graphNames: [], sidebarNames: ["a", "b"] };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Drives samplingWorker.run with a fake session and a controllable monotonic clock.
function harness({ unlimited = false } = {}) {
    const port = new EventEmitter();
    const messages = [];
    port.postMessage = (message) => messages.push(message);
    const holds = [];
    let handlers,
        clock = 0;
    const session = {
        samplingEnabled: true,
        stopped: false,
        unlimitedActive: unlimited,
        stats: () => ({ actualHz: 1 }),
        setHostHold: (held) => holds.push(held),
        setSamplingEnabled(value) {
            this.samplingEnabled = value;
        },
        stop() {}
    };
    run(
        port,
        {},
        (_config, next) => {
            handlers = next;
            return session;
        },
        () => clock
    );
    return {
        port,
        messages,
        holds,
        session,
        sample: (t, consumers, samples = [{ name: "g", bytes: [1, 2, 3, 4] }]) =>
            handlers.onSample(samples, t, consumers),
        advance: (ms) => (clock += ms),
        ack: () => port.emit("message", { ack: true }),
        posted: () => messages.filter((message) => message.event === "samples"),
        errors: () => messages.filter((message) => message.event === "onError"),
        async request(id, method, args = []) {
            port.emit("message", { id, method, args, generation: 0 });
            await tick();
            return messages.find((message) => message.id === id);
        }
    };
}

async function testFixedRateBacklog() {
    const h = harness();
    for (let t = 1; t <= 300; t++) h.sample(t);
    assert.strictEqual(h.posted().length, 1, "one chunk is in flight until the host acknowledges it");
    assert(
        h.holds.every((held) => held === false),
        "a fixed-rate clock never waits for the host"
    );
    h.advance(500);
    const stats = (await h.request(1, "stats")).result;
    assert.deepStrictEqual(
        [stats.actualHz, stats.backlogBatches, stats.backlogAgeMs, stats.droppedBatches, stats.deliveryHold],
        [1, 299, 500, 0, false]
    );
    h.ack();
    assert.strictEqual(h.posted()[1].batch.length, 256, "a long backlog drains in bounded chunks");
    assert.deepStrictEqual(
        h.posted()[1].batch.map((batch) => batch.t),
        Array.from({ length: 256 }, (_, i) => i + 2),
        "chunks keep acquisition order and timestamps"
    );
    h.ack();
    assert.strictEqual(h.posted()[2].batch.length, 43);
    h.ack();
    assert.strictEqual(h.posted().length, 3, "an empty backlog posts nothing");
    assert.strictEqual(h.errors().length, 0);
    const unknown = await h.request(2, "nope");
    assert.match(unknown.error.message, /Unknown sampling operation/);
}

async function testDeliveryHold() {
    const h = harness();
    assert.strictEqual((await h.request(1, "setDeliveryHold", [true])).error, undefined);
    h.sample(1);
    h.sample(2);
    assert.strictEqual(h.posted().length, 0, "held delivery keeps samples in the Worker");
    assert.strictEqual(h.session.samplingEnabled, true, "and does not pause acquisition");
    assert.strictEqual((await h.request(2, "stats")).result.deliveryHold, true);
    await h.request(3, "setDeliveryHold", ["yes"]);
    assert.deepStrictEqual(
        h.posted()[0].batch.map((batch) => batch.t),
        [1, 2],
        "only a literal true holds; release delivers the backlog"
    );
}

async function testBudgetGap() {
    const h = harness();
    h.sample(1);
    h.sample(2);
    h.sample(3);
    h.advance(30001);
    h.sample(4);
    assert.strictEqual(h.errors().length, 1);
    assert.strictEqual(h.errors()[0].args[0].code, "SAMPLING_HOST_BACKLOG");
    h.sample(5);
    assert.strictEqual(h.errors().length, 1, "one notice per busy episode");
    assert.strictEqual((await h.request(1, "stats")).result.droppedBatches, 2);
    h.ack();
    const delivered = h.posted()[1].batch;
    assert.deepStrictEqual(delivered[0], { generation: 0, gap: { startT: 2, endT: 3, batches: 2 } });
    assert.deepStrictEqual(
        delivered.slice(1).map((batch) => batch.t),
        [4, 5]
    );
    h.ack();
    h.sample(6);
    h.sample(7);
    h.advance(30001);
    h.sample(8);
    assert.strictEqual(h.errors().length, 2, "a drained backlog re-arms the notice");
}

function testSidebarCoalescing() {
    const h = harness();
    h.sample(1, graph);
    h.sample(2, sidebar, [
        { name: "a", bytes: [1] },
        { name: "b", bytes: [1] }
    ]);
    h.sample(3, graph);
    h.sample(4, sidebar, [{ name: "a", bytes: [2] }]);
    h.ack();
    const delivered = h.posted()[1].batch;
    assert.deepStrictEqual(
        delivered.map((batch) => batch.t),
        [3, 4],
        "graph ticks stay; queued sidebar-only ticks collapse into the newest"
    );
    assert.deepStrictEqual(
        delivered[1].samples.map((sample) => [sample.name, sample.bytes[0]]),
        [
            ["b", 1],
            ["a", 2]
        ],
        "each sidebar variable keeps its latest value"
    );
}

function testUnlimitedAgeHold() {
    const h = harness({ unlimited: true });
    h.sample(1, graph);
    h.sample(2, graph);
    assert.strictEqual(h.holds.at(-1), false, "a fresh backlog does not hold the probe");
    h.advance(150);
    h.sample(3, graph);
    assert.strictEqual(h.holds.at(-1), true, "an old undelivered batch holds unlimited reads");
    h.ack();
    assert.deepStrictEqual(
        h.posted()[1].batch.map((batch) => batch.t),
        [2, 3]
    );
    assert.strictEqual(h.holds.at(-1), false, "draining the backlog releases the hold");
}

async function testSessionGapDispatch() {
    const events = [];
    const session = new SamplingSession(
        {},
        {
            onSample: (samples, t) => events.push(["sample", t]),
            onSampleGap: (gap) => events.push(["gap", gap.startT, gap.endT])
        },
        path.join(__dirname, "helpers/idle-worker-fixture.js")
    );
    try {
        session.worker.emit("message", {
            event: "samples",
            batch: [
                { generation: 0, gap: { startT: 1, endT: 2, batches: 2 } },
                { generation: 0, samples: [], t: 3 },
                { generation: 1, gap: { startT: 4, endT: 4, batches: 1 } }
            ]
        });
        assert.deepStrictEqual(events, [
            ["gap", 1, 2],
            ["sample", 3]
        ]);
        const notified = [];
        session.notify = (method, args) => notified.push([method, ...args]);
        session.setDeliveryHold(true);
        session.setDeliveryHold(true);
        session.setDeliveryHold(false);
        assert.deepStrictEqual(notified, [
            ["setDeliveryHold", true],
            ["setDeliveryHold", false]
        ]);
    } finally {
        session.stopping = Promise.resolve();
        await session.worker.terminate();
    }
}

function testHistoryGap() {
    const store = new ChartHistoryStore(64 * 1024 * 1024);
    store.configure("p", [{ name: "v", type: "u32", address: 0x20000000 }]);
    store.append(
        "p",
        [1, 2].map((t) => ({ name: "v", t, value: t })),
        2
    );
    const status = store.markGap("p");
    assert(!status.limited, "a backlog gap is not a history limit");
    store.append(
        "p",
        [10, 11].map((t) => ({ name: "v", t, value: t })),
        11
    );
    const parts = store._source("p").series.get("v").parts;
    assert.deepStrictEqual(
        parts.map((part) => !!part.gapBefore),
        [false, true],
        "points after the gap start a new part"
    );
}

function testHostLoopDelay() {
    let now = 0,
        enabled = 0,
        disabled = 0;
    const histogram = {
        max: 0,
        enable: () => enabled++,
        disable: () => disabled++,
        reset() {
            this.max = 0;
        }
    };
    const delay = new HostLoopDelay({ windowMs: 1000, now: () => now, create: () => histogram });
    assert.strictEqual(delay.maxMs(), 0);
    histogram.max = 250e6;
    now = 500;
    assert.strictEqual(delay.maxMs(), 0, "a window reports only when complete");
    now = 1000;
    assert.strictEqual(delay.maxMs(), 250);
    assert.strictEqual(histogram.max, 0);
    now = 1500;
    assert.strictEqual(delay.maxMs(), 250, "the last complete window is kept");
    delay.dispose();
    delay.dispose();
    assert.deepStrictEqual([enabled, disabled], [1, 1]);
}

async function testResumeKeepsMeasuredCost() {
    const session = new ManagedOpenOcdSession(null, { intervalMs: 10 }, {});
    session.socket = { destroyed: false };
    try {
        session.setSamplingEnabled(true);
        session._recentDurations = [1, 1, 1, 1];
        session._warmingUp = false;
        session.effectiveIntervalMs = 12;
        session.setSamplingEnabled(false);
        session.setSamplingEnabled(true);
        assert.strictEqual(session.effectiveIntervalMs, 12, "resume keeps the adapted interval");
        assert.strictEqual(session._recentDurations.length, 4);
        session.setSamplingEnabled(false);
        session.invalidateTarget();
        session.setSamplingEnabled(true);
        assert.strictEqual(session.effectiveIntervalMs, 100, "a target change measures the cost again");
        assert.strictEqual(session._warmingUp, true);
    } finally {
        session.setSamplingEnabled(false);
        session.socket = null;
        await session.stop();
    }
}

async function testProviderWiring() {
    const P = loadProvider();
    const calls = [];
    const gap = Object.create(P.prototype);
    gap._chartHistory = {
        failed: null,
        request: (method, args) => {
            calls.push([method, ...args]);
            return Promise.resolve({});
        }
    };
    gap._debugSamplingScope = (key) => "scope:" + key;
    gap._flushChartHistoryAppend = (entry) => calls.push(["flush", entry.watchKey]);
    gap._livePanels = new Map([
        ["a", { watchKey: "a", historySignature: "x" }],
        ["b", { watchKey: "b" }],
        ["c", { watchKey: "c", historySignature: "y", _historyRestoreTask: {} }]
    ]);
    gap._handleSampleGap();
    assert.deepStrictEqual(calls, [
        ["flush", "a"],
        ["markGap", "scope:a"]
    ]);

    const make = (session) => {
        const p = Object.create(P.prototype);
        const rows = [];
        Object.assign(p, {
            _samplingCoordinator: new SamplingCoordinator(),
            _samplingIntent: true,
            _liveSession: session,
            _managedDebugServer: null,
            _debugBridge: { setIntent() {} },
            _liveWatchService: {},
            _samplingArchive: {},
            _activeReadPlan: () => [{ name: "v" }],
            _handleRawSamples: (samples) => rows.push(samples),
            _postConsumerStatuses() {},
            _samplingStatus: () => ({})
        });
        return { p, rows };
    };
    const live = {
        enables: [],
        holds: [],
        reasons: [],
        setSamplingEnabled(value) {
            this.enables.push(value);
        },
        setDeliveryHold(held) {
            this.holds.push(held);
        },
        setPauseReason(reason) {
            this.reasons.push(reason);
        }
    };
    const worker = make(live);
    worker.p._setSamplingArchiveBackpressure(true);
    worker.p._setSamplingArchiveBackpressure(false);
    assert.deepStrictEqual(live.enables, [], "archive backpressure leaves Worker sampling running");
    assert.deepStrictEqual(live.holds, [true, false]);
    assert.deepStrictEqual(live.reasons, ["archive_backpressure", null]);
    assert.deepStrictEqual(worker.rows, [], "held Worker samples need no empty gap row");
    const dap = make(null);
    dap.p._setSamplingArchiveBackpressure(true);
    dap.p._setSamplingArchiveBackpressure(false);
    assert.strictEqual(dap.rows.length, 1, "host-driven sampling still marks its paused interval");
    assert.strictEqual(dap.rows[0][0].bytes, null);
}

(async () => {
    await testFixedRateBacklog();
    await testDeliveryHold();
    await testBudgetGap();
    testSidebarCoalescing();
    testUnlimitedAgeHold();
    await testSessionGapDispatch();
    testHistoryGap();
    testHostLoopDelay();
    await testResumeKeepsMeasuredCost();
    await testProviderWiring();
    console.log("sampling host backlog tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
