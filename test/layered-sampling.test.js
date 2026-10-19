"use strict";
const assert = require("assert");
const { MultiRatePlan } = require("../src/services/multiRatePlan");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { LiveWatchService } = require("../src/services/liveWatchService");
const { loadProvider } = require("./helpers/load-provider");
const item = (name, size = 4) => ({ name, address: 0x20000000, size });
(async () => {
    for (const hz of [0.1, 10, 20, 30, 200]) {
        const plan = new MultiRatePlan({
            graphItems: [item("graph"), item("shared", 8)],
            sidebarItems: [item("sidebar"), item("shared")],
            graphIntervalMs: Math.round(1000 / hz)
        });
        let graphTicks = 0,
            sidebarTicks = 0,
            sideReads = 0,
            sharedReads = 0;
        for (let time = 0; time < 10000; time++) {
            const due = plan.due(time, plan.intervalMs);
            if (due.graphNames.length) graphTicks++;
            if (due.sidebarNames.length) sidebarTicks++;
            assert.strictEqual(new Set(due.items.map((entry) => entry.name)).size, due.items.length);
            sideReads += due.items.filter((entry) => entry.name === "sidebar").length;
            sharedReads += due.items.filter((entry) => entry.name === "shared").length;
            const samples = plan.deliver(
                due.items.map((entry) => ({ name: entry.name, bytes: Buffer.alloc(entry.size) })),
                time,
                due
            );
            for (const sample of samples) assert.ok(sample.t <= time);
        }
        assert.strictEqual(sidebarTicks, 200);
        assert.strictEqual(sideReads, 200, `sidebar-exclusive reads at ${hz} Hz`);
        assert.strictEqual(graphTicks, Math.ceil(10000 / Math.round(1000 / hz)));
        assert.ok(sharedReads <= graphTicks + sidebarTicks);
        assert.ok(sharedReads >= graphTicks);
        assert.strictEqual(plan.items.find((entry) => entry.name === "shared").size, 8);
    }
    for (const nextInterval of [5, 1000]) {
        const changing = new ManagedOpenOcdSession(null, {}, {});
        changing.setSamplingPlan({
            graphItems: [item("graph")],
            sidebarItems: [item("sidebar")],
            graphIntervalMs: 10000
        });
        changing.ratePlan.due(1000, 50);
        const sidebarDeadline = changing.ratePlan.nextSidebar;
        changing.setIntervalMs(nextInterval);
        assert.deepStrictEqual(
            changing.ratePlan.due(1001, changing.targetIntervalMs).graphNames,
            ["graph"],
            "a higher graph frequency takes effect before the old ten-second deadline"
        );
        assert.strictEqual(
            changing.ratePlan.nextSidebar,
            sidebarDeadline,
            "changing graph frequency preserves the sidebar deadline"
        );
        const graphDeadline = changing.ratePlan.nextGraph;
        changing.setIntervalMs(nextInterval);
        assert.strictEqual(
            changing.ratePlan.nextGraph,
            graphDeadline,
            "setting the same frequency preserves an active deadline"
        );
        changing.setIntervalMs(10000);
        changing.ratePlan.due(2000, changing.targetIntervalMs);
        assert.deepStrictEqual(
            changing.ratePlan.due(2001, changing.targetIntervalMs).graphNames,
            [],
            "lowering frequency uses the new long interval"
        );
    }
    // Switching rates must measure only new graph ticks, even when the sidebar keeps the base clock at 20 Hz.
    {
        const changing = new ManagedOpenOcdSession(null, {}, {});
        const plan = { graphItems: [item("graph")], sidebarItems: [item("sidebar")], graphIntervalMs: 5 };
        changing.setSamplingPlan({ ...plan, unlimited: true });
        for (let i = 0; i < 8; i++) changing._recordCycle(1, true, i);
        changing.ratePlan.deliver([], 0, changing.ratePlan.due(0, 0));
        changing.ratePlan.deliver([], 1, changing.ratePlan.due(1, 0));
        assert.strictEqual(changing.stats().actualHz, 1000);
        const costs = changing._recentDurations.slice();
        const cache = changing.ratePlan.latest;
        changing.setSamplingPlan({ ...plan, unlimited: false });
        assert.deepStrictEqual(changing._recentDurations, costs);
        assert.strictEqual(changing.ratePlan.latest, cache);
        assert.strictEqual(changing.effectiveIntervalMs, 5, "leaving unlimited skips initial 100 ms warm-up");
        assert.strictEqual(changing._warmingUp, false);
        let time = 1000;
        for (const interval of [5, 10, 20, 50, 1000, 10000, 50, 5]) {
            changing.setIntervalMs(interval);
            assert.strictEqual(changing.stats().actualHz, 0, "old-rate ticks do not bias a new measurement");
            assert.strictEqual(changing.effectiveIntervalMs, Math.min(interval, 50));
            for (let n = 0; n < 2; n++) {
                changing.ratePlan.deliver([], time, changing.ratePlan.due(time, changing.effectiveIntervalMs));
                time += interval;
            }
            assert.strictEqual(changing.stats().actualHz, 1000 / interval, "two new ticks establish the new rate");
            changing.setIntervalMs(interval);
            assert.strictEqual(changing.stats().actualHz, 1000 / interval, "same-rate updates retain statistics");
        }
        changing._recentDurations = [20, 20, 20, 20];
        changing.setSamplingPlan({ ...plan, unlimited: true });
        changing.setSamplingPlan({ ...plan, unlimited: false });
        assert.strictEqual(changing.effectiveIntervalMs, 29, "switching retains the measured safety margin");
        changing.setSamplingPlan({ ...plan, graphItems: [item("different")] });
        assert.strictEqual(changing.effectiveIntervalMs, 100, "changed variables still require calibration");
        assert.deepStrictEqual(changing._recentDurations, []);
    }
    // A rate change during a read must discard that cycle and rearm, even with an unchanged sidebar clock.
    {
        const changing = new ManagedOpenOcdSession(null, {}, {});
        changing.setSamplingPlan({
            graphItems: [item("graph")],
            sidebarItems: [item("sidebar")],
            graphIntervalMs: 10000
        });
        changing._recentDurations = [1, 1, 1, 1];
        changing.socket = { destroyed: false };
        const scheduled = [],
            delivered = [];
        changing._scheduleNext = (delay) => scheduled.push(delay);
        changing.handlers.onSample = (samples) => delivered.push(samples);
        let finish;
        changing._readItems = () => new Promise((resolve) => (finish = () => resolve({ samples: [], ok: 2 })));
        const reading = changing._sampleTick(true);
        changing.setIntervalMs(1000);
        assert.strictEqual(changing.targetIntervalMs, 50);
        assert.deepStrictEqual(scheduled, [0], "rearm immediately while the old cycle owns the socket");
        finish();
        await reading;
        assert.deepStrictEqual(delivered, []);
        assert.deepStrictEqual(changing._recentDurations, [1, 1, 1, 1]);
        assert.deepStrictEqual(changing.ratePlan.graphTicks, []);
        assert.deepStrictEqual(scheduled, [0], "stale cycle must not replace the new timer");
        changing._readItems = async () => ({ samples: [], ok: 2 });
        await changing._sampleTick(true);
        assert.strictEqual(delivered.length, 1, "the new schedule continues delivering samples");
    }
    const session = new ManagedOpenOcdSession(null, { intervalMs: 5 }, {});
    session.setSamplingPlan({ sidebarItems: [item("sidebar")], graphIntervalMs: 5 });
    session.setIntervalMs(10000);
    assert.strictEqual(session.targetIntervalMs, 50);
    session._recentDurations = [1, 1, 1, 1];
    session.socket = { destroyed: false };
    session.stopped = false;
    session.samplingEnabled = true;
    session._readItems = async (items, time) => ({
        samples: items.map((entry) => ({ name: entry.name, t: time })),
        ok: items.length
    });
    await session._sampleTick();
    assert.strictEqual(session.ratePlan.sidebarTicks.length, 1);
    const delivered = [],
        scheduled = [];
    session.handlers.onSample = (samples) => delivered.push(samples);
    session._scheduleNext = (delay) => scheduled.push(delay);
    session.ratePlan.nextSidebar = 0;
    session.ratePlan.latest.clear();
    let finish;
    session._readItems = (items, time) =>
        new Promise((resolve) => {
            finish = () =>
                resolve({ samples: items.map((entry) => ({ name: entry.name, t: time })), ok: items.length });
        });
    const reading = session._sampleTick(true);
    session.setSamplingPlan({ sidebarItems: [item("new")], graphIntervalMs: 10000 });
    finish();
    await reading;
    assert.strictEqual(delivered.length, 0, "plan change invalidates an old in-flight read");
    assert.ok(scheduled.length, "plan replacement keeps the scheduling chain alive");
    const p = Object.create(loadProvider({}).prototype);
    const archives = [],
        histories = [],
        messages = [],
        sidebar = [];
    p._livePanels = new Map([[1, { watchKey: "graph", latestSamples: new Map(), ready: true }]]);
    p._getCachedConsumerTypes = () => ({
        graphs: new Map([["graph", new Map([["g", "u32"]])]]),
        sidebar: new Map([
            ["g", "u32"],
            ["s", "u32"]
        ])
    });
    p._compositeMap = () => new Map();
    p._configureChartHistory = () => {};
    p._liveWatchService = new LiveWatchService({ decodeValue: () => 42, decodeValueText: () => "42" });
    p._debugSamplingScope = (key) => key;
    p._samplingArchive = { append: (...args) => archives.push(args) };
    p._chartHistory = {
        request: (...args) => {
            histories.push(args);
            return Promise.resolve();
        }
    };
    p._latestSidebarSamples = new Map();
    p._postWebviewBatch = (_entry, samples) => messages.push(samples);
    p._postSidebarBatch = (samples) => sidebar.push(samples);
    const raw = ["g", "s"].map((name) => ({ name, bytes: Buffer.alloc(4), t: 100 }));
    p._handleRawSamples(raw, 120, { graphNames: [], sidebarNames: ["g", "s"] });
    assert.strictEqual(histories.length, 0);
    assert.strictEqual(archives[0][0].length, 0);
    assert.strictEqual(sidebar[0][0].t, 100, "cached acquisition timestamps survive delivery");
    p._handleRawSamples(raw, 200, { graphNames: ["g"], sidebarNames: [] });
    assert.strictEqual(histories.length, 0, "history ticks wait for the short host batch");
    await p._flushPendingChartHistorySamples();
    assert.strictEqual(histories.length, 1);
    assert.deepStrictEqual(
        archives[1][0].map((entry) => entry.name),
        ["g [u32]"]
    );
    assert.strictEqual(messages[0].length, 1);
    const entry = p._livePanels.get(1);
    entry.historyClearedAt = 100;
    p._handleRawSamples(raw, 300, { graphNames: ["g"], sidebarNames: [] });
    assert.strictEqual(
        histories.length,
        1,
        "late delivery acquired before clear cannot enter the new archive generation"
    );
    p._handleRawSamples([{ ...raw[0], t: 101 }], 300, { graphNames: ["g"], sidebarNames: [] });
    await p._flushPendingChartHistorySamples();
    assert.strictEqual(histories.length, 2, "new acquisitions resume in the cleared panel");
    console.log("Layered consumer scheduling, timestamp and archive isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
