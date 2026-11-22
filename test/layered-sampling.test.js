"use strict";
const assert = require("assert");
const { MultiRatePlan } = require("../src/services/multiRatePlan");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { LiveWatchService } = require("../src/services/liveWatchService");
const { loadProvider } = require("./helpers/load-provider");
const { FakeClock } = require("./helpers/fake-clock");
const { scenario } = require("./helpers/scenario");
const item = (name, size = 4) => ({ name, address: 0x20000000, size });
const read = (items) => ({
    samples: items.map((entry) => ({ name: entry.name, bytes: Buffer.alloc(entry.size) })),
    ok: items.length
});

async function sampleMixedLoad(
    graphIntervalMs,
    graphDurationMs,
    sidebarDurationMs,
    mergedDurationMs = graphDurationMs + sidebarDurationMs
) {
    const clock = new FakeClock();
    const graph = [],
        sidebar = [];
    const session = new ManagedOpenOcdSession(
        { clock: { now: clock.now, monotonicMs: clock.now, sampleNow: clock.now } },
        {
            onSample(samples, t, due) {
                if (due.graphNames.length) graph.push(t);
                if (due.sidebarNames.length) sidebar.push(samples.find((sample) => sample.name === "sidebar").t);
            }
        }
    );
    let delay;
    session._scheduleNext = (value) => (delay = value);
    session.setSamplingPlan({ graphItems: [item("graph")], sidebarItems: [item("sidebar")], graphIntervalMs });
    session.tcl.socket = { destroyed: false };
    session._warmUp(graphDurationMs);
    session._readItems = async (items) => {
        await clock.advance(
            items.length > 1 ? mergedDurationMs : items[0].name === "graph" ? graphDurationMs : sidebarDurationMs
        );
        return read(items);
    };
    const start = clock.now();
    while (clock.now() < start + 11000) {
        await session._sampleTick(true);
        await clock.advance(delay);
    }
    const steadyGraph = graph.filter((t) => t >= start + 1000);
    const gaps = steadyGraph
        .slice(1)
        .map((t, index) => t - steadyGraph[index])
        .sort((a, b) => a - b);
    return {
        start,
        sidebar,
        graphHz: (gaps.length * 1000) / (steadyGraph.at(-1) - steadyGraph[0]),
        gaps,
        stats: session.stats()
    };
}

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
        assert.ok(sidebarTicks >= 200 && sidebarTicks <= 201, `sidebar piggy-back at ${hz} Hz`);
        assert.strictEqual(sideReads, sidebarTicks, `sidebar-only reads are fresh at ${hz} Hz`);
        assert.strictEqual(graphTicks, Math.ceil(10000 / Math.round(1000 / hz)));
        assert.ok(sharedReads <= graphTicks + sidebarTicks);
        assert.ok(sharedReads >= graphTicks);
        assert.strictEqual(plan.items.find((entry) => entry.name === "shared").size, 8);
    }
    for (const nextInterval of [5, 1000]) {
        const changing = new ManagedOpenOcdSession({}, {});
        changing.setSamplingPlan({
            graphItems: [item("graph")],
            sidebarItems: [item("sidebar")],
            graphIntervalMs: 10000
        });
        changing.ratePlan.due(1000, 50);
        const sidebarDeadline = changing.ratePlan.nextSidebar;
        changing.setIntervalMs(nextInterval);
        assert.strictEqual(changing.ratePlan.nextSidebar, sidebarDeadline, "rate changes preserve the sidebar phase");
        assert.deepStrictEqual(
            changing.ratePlan.due(1001, changing.targetIntervalMs).graphNames,
            ["graph"],
            "a higher graph frequency takes effect before the old ten-second deadline"
        );
        assert.strictEqual(
            changing.ratePlan.nextSidebar,
            sidebarDeadline,
            "piggy-back is limited to half the shorter period, so a sidebar deadline 49 ms away keeps its own tick"
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
    // Explicit rate changes measure only new graph frames without moving the separate sidebar schedule.
    {
        const clock = new FakeClock();
        const changing = new ManagedOpenOcdSession({ clock: { monotonicMs: clock.now } }, {});
        const plan = { graphItems: [item("graph")], sidebarItems: [item("sidebar")], graphIntervalMs: 5 };
        changing.setSamplingPlan({ ...plan, unlimited: true });
        for (let i = 0; i < 8; i++) changing._recordCycle(1, true, i);
        for (let n = 0; n < 2; n++) {
            const due = changing.ratePlan.due(clock.now(), 0);
            changing.ratePlan.deliver(read(due.items).samples, clock.now(), due);
            await clock.advance(1);
        }
        assert.strictEqual(changing.stats().actualHz, 1000);
        const costs = changing._recentDurations.slice();
        const cache = changing.ratePlan.latest;
        changing.setSamplingPlan({ ...plan, unlimited: false });
        assert.deepStrictEqual(changing._recentDurations, costs);
        assert.strictEqual(changing.ratePlan.latest, cache);
        assert.strictEqual(changing.effectiveIntervalMs, 5, "leaving unlimited skips initial 100 ms warm-up");
        assert.strictEqual(changing._warmingUp, false);
        for (const interval of [5, 10, 20, 50, 1000, 10000, 50, 5]) {
            changing.setIntervalMs(interval);
            assert.strictEqual(changing.stats().actualHz, 0, "old-rate ticks do not bias a new measurement");
            assert.strictEqual(changing.effectiveIntervalMs, interval);
            // Advance to whichever consumer is due next, including sidebar slots between slow waveform frames.
            for (let n = 0; n < 500 && changing.ratePlan.graphTicks.length < 2; n++) {
                const time = clock.now();
                const due = changing.ratePlan.due(time, changing.effectiveIntervalMs);
                changing.ratePlan.deliver(read(due.items).samples, time, due);
                if (due.sidebarNames.length && !due.graphNames.length)
                    changing.ratePlan.recordSidebarRead(0, time, changing.effectiveIntervalMs);
                await clock.advance(changing.ratePlan.delay(time));
            }
            assert.strictEqual(changing.stats().actualHz, 1000 / interval, "two new ticks establish the new rate");
            changing.setIntervalMs(interval);
            assert.strictEqual(changing.stats().actualHz, 1000 / interval, "same-rate updates retain statistics");
        }
        changing._recentDurations = [20, 20, 20, 20];
        changing.setSamplingPlan({ ...plan, unlimited: true });
        changing.setSamplingPlan({ ...plan, unlimited: false });
        assert.strictEqual(changing.effectiveIntervalMs, 20 / 0.85, "switching retains the measured safety margin");
        changing.setSamplingPlan({ ...plan, graphItems: [item("different")] });
        assert.strictEqual(changing.effectiveIntervalMs, 100, "changed variables still require calibration");
        assert.deepStrictEqual(changing._recentDurations, []);
    }
    // Reordering watch cards keeps the same reads, so the session neither restarts nor recalibrates.
    {
        const changing = new ManagedOpenOcdSession({}, {});
        const plan = {
            graphItems: [item("a"), item("b", 2)],
            sidebarItems: [item("c"), item("d")],
            graphIntervalMs: 20
        };
        changing.setSamplingPlan(plan);
        changing._recentDurations = [3, 3, 3, 3];
        const epoch = changing.sampleEpoch;
        const ratePlan = changing.ratePlan;
        changing.setSamplingPlan({
            ...plan,
            graphItems: [...plan.graphItems].reverse(),
            sidebarItems: [...plan.sidebarItems].reverse()
        });
        assert.strictEqual(changing.sampleEpoch, epoch, "reordered consumers keep the sample epoch");
        assert.strictEqual(changing.ratePlan, ratePlan);
        assert.deepStrictEqual(changing._recentDurations, [3, 3, 3, 3]);
        changing.setSamplingPlan({ ...plan, graphItems: [item("b", 2), item("a", 2)] });
        assert.notStrictEqual(changing.sampleEpoch, epoch, "a changed item still restarts sampling");
    }
    // A rate change during a read must discard that cycle and rearm, even with an unchanged sidebar clock.
    {
        const changing = new ManagedOpenOcdSession({}, {});
        changing.setSamplingPlan({
            graphItems: [item("graph")],
            sidebarItems: [item("sidebar")],
            graphIntervalMs: 10000
        });
        changing._recentDurations = [1, 1, 1, 1];
        changing.tcl.socket = { destroyed: false };
        const scheduled = [],
            delivered = [];
        changing._scheduleNext = (delay) => scheduled.push(delay);
        changing.handlers.onSample = (samples) => delivered.push(samples);
        let finish;
        changing._readItems = () => new Promise((resolve) => (finish = () => resolve({ samples: [], ok: 2 })));
        const reading = changing._sampleTick(true);
        changing.setIntervalMs(1000);
        assert.strictEqual(changing.targetIntervalMs, 1000);
        assert.deepStrictEqual(scheduled, [0], "rearm immediately while the old cycle owns the socket");
        finish();
        await reading;
        assert.deepStrictEqual(delivered, []);
        assert.deepStrictEqual(changing._recentDurations, [1, 1, 1, 1]);
        assert.deepStrictEqual(changing.ratePlan.graphTicks, []);
        assert.deepStrictEqual(scheduled, [0], "stale cycle must not replace the new timer");
        changing._readItems = async (items) => read(items);
        await changing._sampleTick(true);
        assert.strictEqual(delivered.length, 1, "the new schedule continues delivering samples");
    }
    const session = new ManagedOpenOcdSession({ intervalMs: 5 }, {});
    session.setSamplingPlan({ sidebarItems: [item("sidebar")], graphIntervalMs: 5 });
    session.setIntervalMs(10000);
    assert.strictEqual(session.targetIntervalMs, 50);
    session._recentDurations = [1, 1, 1, 1];
    session.tcl.socket = { destroyed: false };
    session.stopped = false;
    session.samplingEnabled = true;
    session._readItems = async (items) => read(items);
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

    await scenario("side reads in the deadline gap leave the waveform phase intact", async () => {
        const { graphHz, sidebar, stats } = await sampleMixedLoad(1000 / 180, 1.5, 1);
        assert.ok(Math.abs(graphHz - 180) < 0.02);
        assert.ok(Math.abs(stats.consumers.sidebarHz - 20) < 0.1);
        assert.strictEqual(stats.missedDeadlines, 0);
        assert.ok(sidebar.length > 190);
    });

    scenario("late fractional deadlines skip elapsed slots without moving the origin", () => {
        const origin = 1e9;
        const period = 1000 / 180;
        const plan = new MultiRatePlan({ graphItems: [item("graph")], graphIntervalMs: period, prioritizeGraph: true });
        plan.due(origin, period);
        const late = plan.due(origin + 3 * period, period);
        assert.strictEqual(late.missedGraphSlots, 2);
        assert.strictEqual(plan.nextGraph, origin + 4 * period);
        assert.strictEqual(plan.recordSidebarRead(10, origin + 6 * period, period), 2);
        assert.strictEqual(
            plan.nextGraph,
            origin + 6 * period,
            "a read ending on a deadline leaves that slot available"
        );
        assert.deepStrictEqual(plan.due(plan.nextGraph, period).graphNames, ["graph"]);
    });

    scenario("an overdue sidebar gets a slot even when waveform reads end exactly on each deadline", () => {
        const origin = 1000;
        const period = 5;
        const plan = new MultiRatePlan({
            graphItems: [item("graph")],
            sidebarItems: [item("sidebar")],
            graphIntervalMs: period,
            prioritizeGraph: true
        });
        assert.deepStrictEqual(plan.due(origin, period).graphNames, ["graph"]);
        plan.recordGraphRead(origin + period);
        const probe = plan.due(origin + period, period);
        assert.deepStrictEqual(probe.graphNames, [], "cold-start overdue sidebar probes without waiting 500 ms");
        assert.deepStrictEqual(probe.sidebarNames, ["sidebar"]);
        assert.strictEqual(plan.recordSidebarRead(10, origin + 15, period), 2);
        for (let time = origin + 15; time < origin + 100; time += period) {
            assert.deepStrictEqual(plan.due(time, period).graphNames, ["graph"]);
            plan.recordGraphRead(time + period);
        }
        const fallback = plan.due(origin + 100, period);
        assert.deepStrictEqual(fallback.graphNames, []);
        assert.deepStrictEqual(fallback.sidebarNames, ["sidebar"]);
        assert.strictEqual(plan.recordSidebarRead(10, origin + 110, period), 2);
        const resumed = plan.due(origin + 110, period);
        assert.deepStrictEqual(resumed.graphNames, ["graph"]);
        assert.strictEqual(resumed.missedGraphSlots, 0);
        assert.strictEqual(plan.nextGraph, origin + 115);
    });

    await scenario("an over-budget sidebar gets service without retiming the waveform", async () => {
        for (const [graphMs, sidebarMs] of [
            [1.5, 12],
            [4, 11]
        ]) {
            const { graphHz, sidebar, gaps, stats } = await sampleMixedLoad(5, graphMs, sidebarMs);
            assert.ok(graphHz >= 175, `waveform rate ${graphHz}`);
            assert.ok(gaps[Math.ceil(gaps.length * 0.95) - 1] <= 5.5);
            assert.strictEqual(stats.effectiveIntervalMs, 5);
            assert.ok(stats.missedDeadlines > 0);
            assert.ok(sidebar.length >= 80, `timely sidebar service (${sidebar.length} reads)`);
            assert.ok(sidebar.slice(1).every((t, index) => t - sidebar[index] <= 130));
        }
    });

    await scenario(
        "typical sidebar reads fit in 200 Hz waveform gaps at full 20 Hz without waiting 500 ms",
        async () => {
            const { start, graphHz, sidebar, stats } = await sampleMixedLoad(5, 1.5, 2);
            assert.ok(graphHz >= 199, `waveform rate ${graphHz}`);
            assert.ok(Math.abs(stats.consumers.sidebarHz - 20) < 0.2, `sidebarHz ${stats.consumers.sidebarHz}`);
            assert.strictEqual(stats.missedDeadlines, 0);
            assert.ok(sidebar[0] - start < 20, `cold start probed promptly at +${sidebar[0] - start} ms`);
            assert.ok(sidebar.slice(1).every((t, index) => t - sidebar[index] <= 55));
        }
    );

    scenario(
        "shared sidebar variables still update at 20 Hz on graph ticks when exclusive sidebar variables exist",
        () => {
            const plan = new MultiRatePlan({
                graphItems: [item("shared")],
                sidebarItems: [item("shared"), item("exclusive")],
                graphIntervalMs: 5,
                prioritizeGraph: true
            });
            plan.sidebarDurations = [15];
            const sharedDeliveries = [];
            const exclusiveReads = [];
            for (let t = 1000; t < 2000;) {
                const due = plan.due(t, 5);
                let end = t;
                if (due.graphNames.length) {
                    end = t + 4;
                    plan.recordGraphRead(end);
                } else if (due.sidebarNames.length) {
                    end = t + 15;
                    plan.recordSidebarRead(15, end, 5);
                    exclusiveReads.push(t);
                }
                const delivered = plan.deliver(read(due.items).samples, end, due, end);
                if (due.sidebarNames.includes("shared") && delivered.some((s) => s.name === "shared")) {
                    sharedDeliveries.push(delivered.find((s) => s.name === "shared").t);
                }
                t = end + plan.delay(end);
            }
            assert.ok(new Set(sharedDeliveries).size >= 18, `shared delivered ${new Set(sharedDeliveries).size} times`);
            assert.ok(exclusiveReads.length >= 5, `exclusive read ${exclusiveReads.length} times`);
        }
    );

    scenario("delay avoids busy zero-delay wakes after a graph tick when sidebar cannot fit in the gap", () => {
        const plan = new MultiRatePlan({
            graphItems: [item("graph")],
            sidebarItems: [item("sidebar")],
            graphIntervalMs: 5,
            prioritizeGraph: true
        });
        plan.sidebarDurations = [10];
        plan.due(1000, 5);
        plan.recordGraphRead(1004);
        assert.strictEqual(plan.delay(1004), 1);
    });

    scenario("an isolated latency spike in sidebarDurations does not starve the next 8 cycles", () => {
        const plan = new MultiRatePlan({
            graphItems: [item("graph")],
            sidebarItems: [item("sidebar")],
            graphIntervalMs: 5,
            prioritizeGraph: true
        });
        plan.due(1000, 5, { allowMerge: false });
        plan.recordGraphRead(1002);
        plan.sidebarDurations = [1, 1, 1, 1, 1, 1, 1, 12];
        const due = plan.due(1002, 5, { allowMerge: false });
        assert.deepStrictEqual(due.sidebarNames, ["sidebar"]);
        assert.deepStrictEqual(
            due.items.map((entry) => entry.name),
            ["sidebar"]
        );
    });

    await scenario(
        "typical USB/Tcl probe merges lightweight fixed sidebar reads to hit full 200 Hz waveform and 20 Hz sidebar",
        async () => {
            const { graphHz, sidebar, stats } = await sampleMixedLoad(5, 2.5, 2.5, 2.8);
            assert.ok(graphHz >= 199.5, `waveform rate ${graphHz}`);
            assert.ok(Math.abs(stats.consumers.sidebarHz - 20) < 0.2, `sidebarHz ${stats.consumers.sidebarHz}`);
            assert.strictEqual(stats.missedDeadlines, 0);
            assert.ok(sidebar.length >= 210);
        }
    );

    await scenario(
        "heavy merged sidebar probe falls back to separate reads without slowing the 200 Hz waveform clock",
        async () => {
            const { graphHz, sidebar, stats } = await sampleMixedLoad(5, 1.5, 3, 13.5);
            assert.ok(graphHz >= 195, `waveform rate ${graphHz}`);
            assert.strictEqual(stats.effectiveIntervalMs, 5);
            assert.ok(Math.abs(stats.consumers.sidebarHz - 20) < 0.5);
            assert.ok(sidebar.length >= 200);
        }
    );

    scenario("exclusive runtimeLayout sidebar items never merge onto waveform ticks", () => {
        const runtimeSidebar = { name: "rt", address: 0x20000100, size: 4, runtimeLayout: { root: 0, types: [] } };
        const plan = new MultiRatePlan({
            graphItems: [item("graph")],
            sidebarItems: [runtimeSidebar],
            graphIntervalMs: 5,
            prioritizeGraph: true
        });
        plan.sidebarDurations = [1];
        assert.strictEqual(plan.canMergeSidebar(5, true), false);
        const due = plan.due(1000, 5);
        assert.deepStrictEqual(due.graphNames, ["graph"]);
        assert.deepStrictEqual(due.sidebarNames, []);
        assert.strictEqual(due.mergedSidebar, false);
    });

    scenario("minor sub-millisecond overrun retains the current waveform slot when enough budget remains", () => {
        const plan = new MultiRatePlan({
            graphItems: [item("graph")],
            sidebarItems: [item("sidebar")],
            graphIntervalMs: 5,
            prioritizeGraph: true
        });
        plan.due(1000, 5);
        plan.recordGraphRead(1001.5, 1.5);
        assert.strictEqual(plan.recordSidebarRead(3.8, 1005.3, 5), 0);
        assert.strictEqual(plan.nextGraph, 1005);
        const recovered = plan.due(1005.3, 5);
        assert.deepStrictEqual(recovered.graphNames, ["graph"]);
        assert.strictEqual(recovered.missedGraphSlots, 0);
        assert.strictEqual(plan.nextGraph, 1010);
    });

    await scenario("low-frequency waveform still services sidebar at 20 Hz in the gaps", async () => {
        const { graphHz, stats } = await sampleMixedLoad(200, 1.5, 1.5, 1.8);
        assert.ok(Math.abs(graphHz - 5) < 0.05, `graphHz ${graphHz}`);
        assert.ok(Math.abs(stats.consumers.sidebarHz - 20) < 0.2, `sidebarHz ${stats.consumers.sidebarHz}`);
        assert.strictEqual(stats.missedDeadlines, 0);
    });

    scenario("sidebar actualHz counts fresh source samples even with uneven wakes", () => {
        const sidebarOnly = new MultiRatePlan({ sidebarItems: [item("sidebar")] });
        for (let n = 0; n <= 40; n++) {
            const t = 1000 + n * 50 + (n % 2);
            const due = sidebarOnly.due(t, 50);
            assert.strictEqual(due.items.length, 1);
            assert.strictEqual(sidebarOnly.deliver(read(due.items).samples, t, due)[0].t, t);
        }
        assert.strictEqual(sidebarOnly.stats(3000).sidebarHz, 20);
        assert.strictEqual(sidebarOnly.stats(6001).sidebarHz, 0, "an idle source ages out of the rate window");
    });
    const p = Object.create(loadProvider({}).prototype);
    const archives = [],
        histories = [],
        messages = [],
        sidebar = [];
    p._livePanels = new Map([[1, { watchKey: "graph", latestSamples: new Map(), ready: true }]]);
    p._sampling.cachedConsumerTypes = () => ({
        graphs: new Map([["graph", new Map([["g", "u32"]])]]),
        sidebar: new Map([
            ["g", "u32"],
            ["s", "u32"]
        ])
    });
    p._sampling.compositeMap = () => new Map();
    p._historyFeed.configure = () => {};
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
    p._sampling._postWebviewBatch = (_entry, samples) => messages.push(samples);
    p._sampling._postSidebarBatch = (samples) => sidebar.push(samples);
    const raw = ["g", "s"].map((name) => ({ name, bytes: Buffer.alloc(4), t: 100 }));
    p._sampling.handleRawSamples(raw, 120, { graphNames: [], sidebarNames: ["g", "s"] });
    assert.strictEqual(histories.length, 0);
    assert.strictEqual(archives[0][0].length, 0);
    assert.strictEqual(sidebar[0][0].t, 100, "cached acquisition timestamps survive delivery");
    p._sampling.handleRawSamples(raw, 200, { graphNames: ["g"], sidebarNames: [] });
    assert.strictEqual(histories.length, 0, "history ticks wait for the short host batch");
    await p._historyFeed.flushPending();
    assert.strictEqual(histories.length, 1);
    assert.deepStrictEqual(
        archives[1][0].map((entry) => entry.name),
        ["g [u32]"]
    );
    assert.strictEqual(messages[0].length, 1);
    const entry = p._livePanels.get(1);
    entry.historyClearedAt = 100;
    p._sampling.handleRawSamples(raw, 300, { graphNames: ["g"], sidebarNames: [] });
    assert.strictEqual(
        histories.length,
        1,
        "late delivery acquired before clear cannot enter the new archive generation"
    );
    p._sampling.handleRawSamples([{ ...raw[0], t: 101 }], 300, { graphNames: ["g"], sidebarNames: [] });
    await p._historyFeed.flushPending();
    assert.strictEqual(histories.length, 2, "new acquisitions resume in the cleared panel");
    console.log("Layered consumer scheduling, timestamp and archive isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
