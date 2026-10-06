"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent, buildCsv } = require("../src/liveWatchView");
const { intervalMsFromHz, normalizeFrequencyHz } = require("../src/samplingFrequency");
const WINDOW = 30 * 60 * 1000;
const CAP = WINDOW / 5 + 1;
const item = { name: "tick", type: "u32", address: 0x20000000 };

function points(graph, name = "tick") {
    return graph.window.retainedPoints(graph.window.data[name]);
}
function fill(graph, count, interval, start = 1000) {
    for (let offset = 0; offset < count; offset += 1000) {
        graph.window.onSamples(
            Array.from({ length: Math.min(1000, count - offset) }, (_, i) => ({
                name: "tick",
                value: (offset + i) % 17 === 0 ? null : offset + i,
                t: start + (offset + i) * interval
            }))
        );
    }
}
function checkWindow(graph, interval) {
    const retained = points(graph);
    const span = retained.at(-1).t - retained[0].t;
    assert.ok(span <= WINDOW, "visible history never exceeds 30 minutes");
    assert.ok(span > WINDOW - interval, "retain the full window to within one actual sample period");
    assert.ok(retained.length <= CAP, "active samples remain bounded at the supported 200 Hz ceiling");
    assert.ok(graph.window.data.tick.length < CAP + graph.window.RETENTION_TRIM_CHUNK);
}

// Sweep every selectable frequency, including values that round to a higher effective clock rate.
const sweep = render(getLiveWatchContent({ frequencyHz: 30 }, "en"));
try {
    for (let step = 1; step <= 2000; step++) {
        const hz = normalizeFrequencyHz(step / 10);
        const ms = intervalMsFromHz(hz);
        assert.strictEqual(sweep.window.retainedSampleLimit(hz, ms), Math.ceil(WINDOW / ms) + 1);
        assert.strictEqual(sweep.window.retainedSampleLimit(hz), Math.ceil(WINDOW / ms) + 1);
    }
    sweep.assertHealthy();
} finally {
    sweep.close();
}

for (const hz of [0.1, 30, 181.9, 200]) {
    const graph = render(getLiveWatchContent({ frequencyHz: hz }, "en"));
    try {
        graph.send({ type: "watchList", items: [item] });
        const ms = intervalMsFromHz(hz);
        fill(graph, Math.ceil((WINDOW + 60000) / ms) + 1, ms);
        checkWindow(graph, ms);
        graph.window.syncTimeBounds();
        assert.ok(graph.window.chartState.bounds.max - graph.window.chartState.bounds.min <= WINDOW);
        graph.window.chartData();
        graph.window.freezeChart();
        assert.strictEqual(graph.window.analysis.snapshot.tick.length, points(graph).length);
        assert.ok(graph.window.analysis.snapshot.tick.every((p) => Number.isFinite(p.t)));
        graph.window.exportSource = "snapshot";
        graph.window.showLocalExport();
        assert.strictEqual(graph.window.exportCandidates[0].buffer.length, points(graph).length);
        const smallExport = points(graph).slice(-10);
        assert.strictEqual(buildCsv(["tick"], [smallExport]).split("\r\n").length, 12);
        graph.assertHealthy();
    } finally {
        graph.close();
    }
}

// Changing frequency only sizes future acquisition. It must preserve the preceding high-rate history.
const changing = render(getLiveWatchContent({ frequencyHz: 200 }, "en"));
try {
    changing.send({ type: "watchList", items: [item, { ...item, name: "idle" }] });
    changing.window.onSamples([{ name: "idle", value: 1, t: 1000 }]);
    fill(changing, CAP, 5);
    let time = points(changing).at(-1).t;
    for (const hz of [30, 0.1, 200, 181.9, 0.1, 30]) {
        const ms = intervalMsFromHz(hz);
        const before = points(changing).length;
        changing.send({ type: "liveFrequency", frequencyHz: hz, intervalMs: ms });
        assert.strictEqual(points(changing).length, before, "frequency change itself never truncates history");
        time += ms;
        changing.window.onSamples([{ name: "tick", value: 7, t: time }]);
        const retained = points(changing);
        assert.ok(retained.at(-1).t - retained[0].t > WINDOW - 10000);
        assert.ok(retained.at(-1).t - retained[0].t <= WINDOW);
        assert.ok(retained.length > 350000, "lowering frequency preserves dense high-rate history");
        changing.window.freezeChart();
        assert.strictEqual(changing.window.analysis.snapshot.tick.length, retained.length);
        changing.window.resumeChart();
    }
    assert.strictEqual(points(changing, "idle").length, 0, "inactive channels expire against the acquisition clock");
    time += WINDOW + 10000;
    changing.window.onSamples([{ name: "tick", value: 8, t: time }]);
    assert.strictEqual(points(changing).length, 1, "a long acquisition gap expires all old history");
    changing.window.clearHistory();
    assert.strictEqual(changing.window.data.tick.length, 0);
    changing.assertHealthy();
} finally {
    changing.close();
}

// Explicit point limits retain their previous meaning, with the same 30-minute time ceiling.
for (const limit of [100, CAP]) {
    const graph = render(getLiveWatchContent({ maxSamples: limit, autoMaxSamples: false, frequencyHz: 200 }, "en"));
    try {
        graph.send({ type: "watchList", items: [item] });
        graph.send({ type: "liveFrequency", frequencyHz: 0.1, intervalMs: 10000 });
        fill(graph, 500, 10000);
        assert.strictEqual(points(graph).length, Math.min(limit, 181));
        assert.strictEqual(graph.window.MAXPTS, limit);
        graph.assertHealthy();
    } finally {
        graph.close();
    }
}
console.log("30-minute chart retention and frequency transition tests passed");
