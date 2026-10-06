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
    assert.strictEqual(histories.length, 2, "new acquisitions resume in the cleared panel");
    console.log("Layered consumer scheduling, timestamp and archive isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
