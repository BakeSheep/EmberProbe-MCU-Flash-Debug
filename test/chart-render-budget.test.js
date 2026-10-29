"use strict";
const assert = require("assert");
const { visibleSegments } = require("../src/webview/liveWatch/chartInspection");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

// A 20-minute 200 Hz history must not be scanned in full for a 30-second viewport.
const raw = Array.from({ length: 240001 }, (_, i) => ({ t: 1000 + i * 5, v: i % 100 }));
let reads = 0;
const tracked = new Proxy(raw, {
    get(target, key) {
        if (/^\d+$/.test(String(key))) reads++;
        return target[key];
    }
});
const end = raw.at(-1).t;
// Reductions keep at most four points per power-of-two time bin; bins are within √2 of one column.
const budget = 4 * Math.ceil(903 * Math.SQRT2);
const short = visibleSegments(tracked, { min: end - 30000, max: end }, 900);
assert.equal(
    short.reduce((n, s) => n + s.visibleCount, 0),
    6001
);
assert.ok(reads < 60000, "offscreen samples are located with binary search instead of scanned");
assert.ok(short.flatMap((s) => s.arr).length <= budget);

// Extrema, boundary neighbours and gaps survive reduction; raw history remains untouched.
const values = [0, 80, -70, 0, null, 0, 90, -60, 0];
const gaps = values.map((v, i) => ({ t: i, v }));
const parts = visibleSegments(gaps, { min: 0, max: 8 }, 1);
assert.equal(parts.length, 2);
assert.deepStrictEqual(
    parts.flatMap((s) => s.arr).map((p) => p.v),
    [0, 80, -70, 0, 0, 90, -60, 0]
);
assert.equal(
    parts.reduce((n, s) => n + s.visibleCount, 0),
    8
);
const edge = visibleSegments(gaps, { min: 2.5, max: 5.5 }, 900);
assert.deepStrictEqual(
    edge.flatMap((s) => s.arr).map((p) => p.t),
    [2, 3, 5, 6]
);
assert.equal(
    edge.reduce((n, s) => n + s.visibleCount, 0),
    2
);
const base = 18446744073709551000n;
const exact = [0n, 30n, 1n, 2n].map((v, i) => ({ t: i, v: Number(base + v), valueText: String(base + v) }));
assert.ok(visibleSegments(exact, { min: 0, max: 10 }, 1)[0].arr.includes(exact[1]));
assert.deepStrictEqual(
    exact.map((p) => p.valueText),
    [0n, 30n, 1n, 2n].map((v) => String(base + v))
);
const expired = [undefined, undefined, ...gaps];
expired.retainedStart = 2;
assert.equal(visibleSegments(expired, { min: 0, max: 8 }, 1).length, 2);
assert.deepStrictEqual(visibleSegments([], { min: 0, max: 8 }, 1), []);

// A following range that scrolls by fractional columns keeps the same reduced samples in its interior.
const epoch = 1.8e12,
    epochRaw = raw.map((p) => ({ t: epoch + p.t, v: p.v }));
const scrolled = (shift, grow = 0) => {
    const min = epoch + 100000 + shift;
    return visibleSegments(epochRaw, { min, max: min + 30000 + grow }, 900)[0]
        .arr.map((p) => p.t - epoch)
        .filter((t) => t >= 102000 && t <= 128000);
};
for (const shift of [7, 13.3, 21.9]) assert.deepStrictEqual(scrolled(shift), scrolled(0), "shift " + shift);
// A growing ("All") range keeps its reduced samples while the power-of-two bin size is unchanged.
for (const grow of [80, 560, 2400]) assert.deepStrictEqual(scrolled(0, grow), scrolled(0), "growth " + grow);

const graph = render(getLiveWatchContent({ frequencyHz: 200 }, "en"));
try {
    const w = graph.window;
    const canvas = graph.document.getElementById("chart");
    Object.defineProperties(canvas, { clientWidth: { value: 900 }, clientHeight: { value: 500 } });
    graph.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 0x20000000 }] });
    w.data.tick = raw;
    w.invalidateSeries();
    w.draw(1000);
    assert.equal(graph.document.getElementById("points").textContent, "6001 samples");
    assert.ok(w.chartState.curveGeometry.value[0].xs.length <= budget);
    w.applyWindowPreset("0");
    w.draw(1100);
    assert.equal(graph.document.getElementById("points").textContent, "240001 samples");
    assert.ok(w.chartState.curveGeometry.value[0].xs.length <= budget);
    assert.equal(w.data.tick.length, 240001, "drawing never downsamples export buffers");
    w.freezeChart();
    assert.equal(w.analysis.snapshot.tick.length, 240001);
    w.clearHistory();
    const revision = w.historyRevision;
    assert.equal(graph.messages.at(-1).type, "clearSamplingHistory");
    graph.send({ type: "liveSample", samples: [{ name: "tick", value: 99, t: end }] });
    assert.equal(w.data.tick.length, 0, "messages in flight before the clear acknowledgement are discarded");
    graph.send({ type: "samplingHistoryCleared", historyRevision: revision - 1 });
    assert.equal(w.historyClearPending, true);
    graph.send({ type: "samplingHistoryCleared", historyRevision: revision });
    graph.send({
        type: "samplingArchiveInfo",
        historyRevision: revision - 1,
        openExport: true,
        variables: ["tick"],
        firstTimestampMs: 1000,
        lastTimestampMs: end,
        rows: 240001
    });
    assert.equal(w.archiveExportInfo, null, "old archive responses cannot restore cleared export candidates");
    assert.equal(w.exportCandidates.length, 0);
    assert.equal(w.analysis.snapshot, null);
    graph.send({ type: "liveSample", samples: [{ name: "tick", value: 7, t: end + 5 }] });
    w.showExport();
    graph.send({
        type: "samplingArchiveInfo",
        historyRevision: revision,
        openExport: true,
        variables: ["tick"],
        firstTimestampMs: end + 5,
        lastTimestampMs: end + 5
    });
    w.applyExport();
    assert.equal(graph.messages.at(-1).historyRevision, revision);
    assert.equal(w.exportTimelineStart, end + 5, "export bounds start in the new history generation");
    graph.send({ type: "debugSessionChanged" });
    assert.equal(
        w.historyClearPending,
        false,
        "session changes clear the view without erasing the destination archive"
    );
    graph.assertHealthy();
} finally {
    graph.close();
}
console.log("Chart viewport work budgets, extrema, gaps and history-clear races passed");
