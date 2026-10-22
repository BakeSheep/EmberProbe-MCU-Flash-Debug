"use strict";
const assert = require("assert");
const { paint } = require("../src/webview/liveWatch/chart");
const I = require("../src/webview/liveWatch/chartInspection");
const VP = require("../src/webview/liveWatch/viewport");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

function geometryScenario(run) {
    const page = render('<div id="chartEmpty"></div><span id="points"></span><span id="range"></span>');
    const calls = [];
    const ctx = new Proxy(
        {},
        {
            get(target, key) {
                if (key in target) return target[key];
                if (key === "measureText") return (text) => ({ width: String(text).length * 7 });
                return (...args) => calls.push([key, ...args]);
            }
        }
    );
    const state = { x: { min: 100, max: 200 }, y: { min: 0, max: 20 }, autoY: false };
    const series = [
        { item: { name: "a" }, idx: 0, arr: Array.from({ length: 301 }, (_, t) => ({ t, v: 10 + Math.sin(t / 10) })) }
    ];
    const options = {
        canvas: { clientWidth: 800, clientHeight: 400 },
        ctx,
        chartState: state,
        series,
        norm: false,
        hasBounds: true,
        pixelRatio: 1,
        style: { fontFamily: "sans-serif", getPropertyValue: () => "" },
        elements: Object.fromEntries(
            ["chartEmpty", "points", "range"].map((id) => [id, page.document.getElementById(id)])
        ),
        VP,
        padRange: (min, max) => ({ min: min - 1, max: max + 1 }),
        fmtNum: String,
        colorFor: () => "red",
        inspection: I,
        formatChartTime: String,
        t: String
    };
    function draw() {
        calls.length = 0;
        paint(options);
        return state.curveGeometry;
    }
    try {
        run({ state, series, options, calls, draw });
    } finally {
        page.close();
    }
}

geometryScenario(({ state, series, options, calls, draw }) => {
    const original = draw(),
        prepared = state.prepared;
    const curve = original.value[0],
        index = curve.raw.indexOf(series[0].arr[150]);
    assert.ok(curve.xs instanceof Float64Array && curve.ys instanceof Float64Array);
    assert.ok(curve.drawing instanceof Uint32Array);
    assert.strictEqual(curve.raw[index], series[0].arr[150]);
    const before = I.pointAt(curve, index);
    const oldDot = calls.find(([op]) => op === "arc");
    state.x = { min: 110, max: 210 };
    assert.strictEqual(draw(), original, "a translation inside the margin reuses geometry");
    assert.strictEqual(state.prepared, prepared, "panning reuses integer preparation");
    const after = I.pointAt(curve, index);
    assert.ok(Math.abs(after.x - before.x + state.geometry.pw / 10) < 1e-9);
    assert.strictEqual(after.y, before.y);
    const dot = calls.find(([op]) => op === "arc");
    assert.strictEqual(dot[1], oldDot[1], "the last visible sample stays at the right edge");
    assert.strictEqual(dot[2], I.pointAt(curve, curve.raw.indexOf(series[0].arr[210])).y);
    const cachedHit = I.hit(original.value, after)[0];
    state.curveGeometry = null;
    const fresh = draw();
    assert.strictEqual(I.hit(fresh.value, after)[0].point, cachedHit.point);
    assert.strictEqual(cachedHit.point, series[0].arr[150]);
    state.y = { min: 1, max: 21 };
    assert.strictEqual(draw(), fresh, "pure y translation reuses geometry");
    state.y.max++;
    const scaled = draw();
    assert.notStrictEqual(scaled, fresh, "changing the y span rebuilds");
    state.x.max++;
    assert.notStrictEqual(draw(), scaled, "zoom rebuilds");
    const zoomed = state.curveGeometry;
    options.pixelRatio = 2;
    assert.notStrictEqual(draw(), zoomed, "DPR changes rebuild");
    const resized = state.curveGeometry;
    state.x = { min: 250, max: 351 };
    assert.notStrictEqual(draw(), resized, "leaving the built window rebuilds");
});

geometryScenario(({ state, series, calls, draw }) => {
    series[0].arr = [100, 120, 140, 150, 160, 180, 200, 220].map((t) => ({ t, v: t === 150 ? null : 10 }));
    series.push({
        item: { name: "a" },
        idx: 0,
        arr: [
            { t: 225, v: 10 },
            { t: 230, v: 11 }
        ]
    });
    const original = draw();
    state.x = { min: 130, max: 230 };
    assert.strictEqual(draw(), original);
    // After clip: one move on either side of the null, then a separate segment's move.
    const clip = calls.findIndex(([op]) => op === "clip");
    const paths = calls.slice(clip + 1).filter(([op]) => op === "moveTo" || op === "lineTo");
    assert.deepStrictEqual(
        paths.map(([op]) => op),
        ["moveTo", "lineTo", "moveTo", "lineTo", "lineTo", "lineTo", "moveTo", "lineTo"]
    );
    const x = state.geometry.padL + state.geometry.pw * 0.2;
    assert.strictEqual(
        I.hit(original.value, { x, y: I.pointAt(original.value[0], 0).y }, 1).length,
        0,
        "missing samples cannot be hit through a bridged segment"
    );
    const dots = calls.filter(([op]) => op === "arc");
    assert.strictEqual(dots.at(-1)[1], state.geometry.padL + state.geometry.pw);
});

geometryScenario(({ state, series, options, draw }) => {
    const base = 18446744073709551000n;
    series[0].arr = Array.from({ length: 301 }, (_, t) => ({
        t,
        v: t === 150 ? null : Number(base + BigInt(t)),
        valueText: t === 150 ? null : String(base + BigInt(t))
    }));
    state.autoY = true;
    const original = draw(),
        prepared = state.prepared;
    assert.strictEqual(options.elements.range.textContent, `${base + 99n} ～ ${base + 201n}`);
    state.x = { min: 110, max: 210 };
    assert.strictEqual(draw(), original, "autoY translation with unchanged span reuses geometry");
    assert.strictEqual(state.prepared, prepared);
    assert.strictEqual(options.elements.range.textContent, `${base + 109n} ～ ${base + 211n}`);
});

function followScenario(run, reduced = false) {
    let now = 10000,
        callback,
        drawCost = 0,
        paints = 0;
    const page = render(
        getLiveWatchContent({ backendHistory: true }, "en"),
        {},
        {
            beforeParse(w) {
                w.performance.now = () => now;
                w.requestAnimationFrame = (fn) => {
                    callback = fn;
                    return 1;
                };
                w.matchMedia = () => ({ matches: reduced });
            }
        }
    );
    const w = page.window;
    Object.defineProperties(w.canvas, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
    // Timeline snapping tolerance is 8 track pixels; give the track a realistic width.
    Object.defineProperty(w.document.getElementById("chartTimeline"), "clientWidth", { value: 800 });
    page.send({ type: "watchList", items: [{ name: "a", type: "f32", address: 0x20000000 }] });
    const origin = 1700000000000;
    let dataMax = origin + 100000;
    function status() {
        page.send({
            type: "chartHistoryStatus",
            historyRevision: w.historyRevision,
            revision: dataMax,
            bounds: { min: origin, max: dataMax }
        });
    }
    status();
    w.syncTimeBounds();
    w.applyWindowPreset("10");
    const originalPaint = w.EmberProbeChart.paint;
    w.EmberProbeChart.paint = (options) => {
        paints++;
        originalPaint(options);
        now += drawCost;
    };
    function frame(ms = 16) {
        now += ms;
        callback(now);
    }
    function answer() {
        const request = w.remoteHistory.inFlight;
        assert.ok(request);
        page.send({
            type: "chartViewportResult",
            requestId: request.requestId,
            historyRevision: w.historyRevision,
            revision: dataMax,
            bounds: { min: origin, max: dataMax },
            series: [
                {
                    name: "a",
                    arr: Array.from({ length: 801 }, (_, i) => ({ t: dataMax - 16000 + i * 20, v: Math.sin(i / 20) }))
                }
            ]
        });
        return request;
    }
    function commit(ms = 80, elapsed = ms) {
        dataMax += ms;
        status();
        frame(elapsed);
        if (w.remoteHistory.inFlight?.purpose === "overview") {
            answer();
            frame(80);
        }
        // A new revision's detail is generated by the real P0 request scheduler.
        if (!w.remoteHistory.inFlight) {
            w.requestChartViewport(w.chartState.x, 800);
        }
        assert.strictEqual(w.remoteHistory.inFlight?.purpose, "detail");
        answer();
    }
    // Seed the initial atomic view before starting, so the first live commit has an existing display edge.
    frame(80);
    answer();
    frame(80);
    if (w.remoteHistory.inFlight) answer();
    w.running = true;
    try {
        run({
            w,
            page,
            frame,
            answer,
            commit,
            status,
            advanceData: (ms) => {
                dataMax += ms;
                status();
            },
            origin,
            get now() {
                return now;
            },
            get max() {
                return dataMax;
            },
            get paints() {
                return paints;
            },
            cost: (ms) => {
                drawCost = ms;
            }
        });
        page.assertHealthy();
    } finally {
        page.close();
    }
}

followScenario((h) => {
    const { w, frame, commit } = h;
    commit();
    frame();
    let previous = w.chartState.x.max;
    for (let batch = 0; batch < 5; batch++) {
        const geometry = w.chartState.curveGeometry,
            stats = w.chartState.rangeStats;
        for (let f = 0; f < 4; f++) {
            frame();
            assert.ok(w.chartState.x.max > previous, "each rendered frame moves forward");
            assert.ok(w.chartState.x.max <= h.max, "the display never runs ahead of committed data");
            assert.strictEqual(w.chartState.curveGeometry, geometry);
            assert.strictEqual(w.chartState.rangeStats, stats, "autoY is held between commits");
            previous = w.chartState.x.max;
        }
        commit(80, 16);
        assert.ok(w.chartState.x.max >= previous, "atomic commits do not rewind the display");
        frame();
        assert.notStrictEqual(w.chartState.rangeStats, stats, "new detail commits refresh autoY statistics");
        previous = w.chartState.x.max;
    }
    for (let f = 0; f < 40; f++) frame();
    assert.strictEqual(w.chartState.x.max, h.max, "stalled data stops exactly at the committed maximum");
    w.chartState.follow = false;
    frame();
    assert.strictEqual(w.chartState.followClock, null);
});

for (const disable of [
    (w) => w.freezeChart(),
    (w) => w.applyWindowPreset("0"),
    (w) => {
        w.chartState.drag = {};
    },
    (w) => {
        w.chartState.endpointDrag = {};
    },
    (w) => {
        w.chartState.timelineDrag = true;
    },
    (w) => {
        w.running = false;
    },
    (w) => {
        w.historyRevision++;
    },
    (w) => w.clearHistory(),
    (w) => w.resumeChart(),
    (w) => w.applyWindowPreset("30")
])
    followScenario(({ w, commit, frame }) => {
        commit();
        assert.ok(w.chartState.followClock);
        disable(w);
        frame();
        assert.strictEqual(w.chartState.followClock, null, "lifecycle changes stop/reset the display clock");
    });

followScenario(({ w, commit, frame }) => {
    commit();
    frame();
    assert.strictEqual(w.chartState.followClock, null);
    assert.strictEqual(w.chartState.x.max, w.remoteHistory.status.bounds.max);
}, true);

followScenario(({ w, commit, frame }) => {
    commit();
    frame();
    assert.ok(w.chartState.x.max < w.remoteHistory.status.bounds.max);
    w.matchMedia = () => ({ matches: true });
    frame(80);
    assert.strictEqual(w.chartState.followClock, null);
    assert.strictEqual(
        w.chartState.x.max,
        w.remoteHistory.status.bounds.max,
        "enabling reduced motion restores atomic step following"
    );
});

followScenario(({ w, commit, frame }) => {
    commit();
    w.norm = true;
    frame();
    const stats = w.chartState.rangeStats,
        geometry = w.chartState.curveGeometry;
    frame();
    assert.strictEqual(w.chartState.rangeStats, stats, "normalization ranges are held between commits");
    assert.strictEqual(w.chartState.curveGeometry, geometry);
    w.chartState.followClock = null;
    w.chartState.x = { min: w.chartState.bounds.max - 1000, max: w.chartState.bounds.max };
    w.commitFollowClock({ min: w.chartState.bounds.max - 1000, max: w.chartState.bounds.max });
    assert.strictEqual(w.chartState.followClock.span, 10000, "short initial history preserves the preset duration");
});

followScenario((h) => {
    h.commit();
    h.cost(60);
    for (let f = 0; f < 10; f++) h.frame(80);
    assert.ok(h.w.chartState.drawDuration > 40);
    h.cost(0);
    const count = h.paints;
    h.frame(1); // 60 ms of drawing + 1 ms since the last frame start: below the 80 ms cap.
    assert.strictEqual(h.paints, count);
    h.frame(19);
    assert.strictEqual(h.paints, count + 1, "the adaptive interval is capped at 80 ms");
});

console.log("Translation geometry, exact axes, gaps, smooth follow lifecycle and adaptive frame cadence passed");

// Timeline: while smooth following, the selected block stays pinned to the right end and does not saw back and forth
// between the lagging display clock and stepped detail commits.
followScenario((h) => {
    const { w, frame, commit } = h;
    const fill = w.document.getElementById("chartRangeFill"),
        to = w.document.getElementById("chartToRange"),
        from = w.document.getElementById("chartFromRange");
    commit();
    frame();
    const lefts = [];
    for (let batch = 0; batch < 4; batch++) {
        for (let f = 0; f < 4; f++) {
            frame();
            const right = parseFloat(fill.style.left) + parseFloat(fill.style.width);
            assert.ok(Math.abs(right - 100) < 1e-9, `the block's right edge stays at the end (${right})`);
            assert.strictEqual(to.value, to.max, "the right handle stays at the end");
            lefts.push(Number(from.max) - Number(from.value));
        }
        commit(80, 16);
    }
    // The left handle keeps a constant distance from the right end (one span).
    assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 1, "the left handle moves with the right end");
});

// Dragging the left handle while the right end is snapped keeps the right end attached, also as new data arrives.
followScenario((h) => {
    const { w, frame, commit } = h;
    const from = w.document.getElementById("chartFromRange");
    commit();
    frame();
    assert.ok(w.chartState.x.max < w.chartState.bounds.max);
    w.beginTimelineEndpoint("min", { button: 0, currentTarget: from });
    from.value = String(Number(from.value) - 2000);
    w.updateTimelineEndpoint("min");
    assert.strictEqual(w.chartState.follow, true, "the snapped right end stays attached");
    assert.strictEqual(w.chartState.x.max, w.chartState.bounds.max);
    h.advanceData(500);
    const newer = h.max;
    frame(80);
    assert.strictEqual(w.chartState.bounds.max, newer);
    assert.strictEqual(w.chartState.x.max, newer, "the attached end follows new data while dragging");
    w.endTimelineEndpoint();
    assert.strictEqual(w.chartState.follow, true, "releasing the left handle keeps following");
    for (let f = 0; f < 3; f++) commit(80, 80);
    frame();
    assert.ok(w.chartState.followClock, "smooth following resumes after the drag");
});

// Keyboard changes of the left handle (no pointerdown) also keep the right end attached.
followScenario((h) => {
    const { w, frame, commit } = h;
    const from = w.document.getElementById("chartFromRange");
    commit();
    frame();
    from.value = String(Number(from.value) - 1000);
    w.updateTimelineEndpoint("min");
    assert.strictEqual(w.chartState.follow, true);
    assert.strictEqual(w.chartState.x.max, w.chartState.bounds.max);
});

// Starting any interaction from the lagging display first settles on the data edge, so follow detection is exact:
// a vertical-only pan or zoom anchored at the right end keeps following, like before smooth scrolling.
followScenario((h) => {
    const { w, frame, commit } = h;
    commit();
    frame();
    assert.ok(w.chartState.x.max < w.chartState.bounds.max);
    const span = w.chartState.x.max - w.chartState.x.min;
    w.settleFollowView();
    assert.strictEqual(w.chartState.followClock, null);
    assert.strictEqual(w.chartState.x.max, w.chartState.bounds.max);
    assert.ok(Math.abs(w.chartState.x.max - w.chartState.x.min - span) < 1e-6, "settling keeps the span");
    w.updateFollowFromView(false);
    assert.strictEqual(w.chartState.follow, true);
});
