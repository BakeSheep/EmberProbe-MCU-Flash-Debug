"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const page = render(getLiveWatchContent({ backendHistory: true, frequencyHz: 200 }, "en"));
try {
    const w = page.window,
        canvas = page.document.getElementById("chart");
    Object.defineProperty(canvas, "clientWidth", { value: 800 });
    Object.defineProperty(canvas, "clientHeight", { value: 400 });
    const items = [
        { name: "a", type: "f32" },
        { name: "b", type: "f32" }
    ];
    const store = new ChartHistoryStore();
    store.configure("p", items);
    for (let i = 0; i <= 10000; i++)
        store.append(
            "p",
            items.map((item) => ({ name: item.name, value: i, t: 1000 + i * 5 })),
            1000 + i * 5
        );
    page.send({ type: "watchList", items });
    w.hidden.b = true;
    page.send({ type: "chartValues", samples: [{ name: "b", value: 10000, t: 51000 }] });
    assert.strictEqual(w.latest.b, 10000);
    assert.strictEqual(w.data.b.length, 0, "silent samples never enter Webview history");
    page.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
    function request() {
        w.remoteHistory.lastRequest = -Infinity;
        w.dirty = true;
        w.draw(100000);
        return page.messages.filter((message) => message.type === "chartViewport").at(-1);
    }
    function answer(r) {
        page.send({
            type: "chartViewportResult",
            ...store.viewport("p", r.names, r.range, r.width, r.snapshotId),
            requestId: r.requestId,
            historyRevision: r.historyRevision,
            snapshotId: r.snapshotId
        });
    }
    const first = request();
    assert.deepStrictEqual(first.names, ["a"]);
    w.toggleCurve("b");
    const viewport = JSON.stringify(w.chartState.x);
    request();
    assert.ok(w.remoteHistory.pending, "one latest pending request replaces intermediate views");
    answer(first);
    assert.strictEqual(w.remoteHistory.series.length, 0, "outdated visibility reply cannot restore curves");
    const second = page.messages.filter((message) => message.type === "chartViewport").at(-1);
    assert.deepStrictEqual(second.names, ["a", "b"]);
    answer(second);
    assert.strictEqual(JSON.stringify(w.chartState.x), viewport);
    assert.ok(w.remoteHistory.series.find((s) => s.name === "b").visibleCount > 5000);
    w.freezeChart();
    const freezeRequest = page.messages.at(-1);
    page.send({
        type: "chartFreezeResult",
        ...store.freeze("p"),
        requestId: freezeRequest.requestId,
        historyRevision: 0
    });
    assert.strictEqual(w.frozen, true);
    const bounds = JSON.stringify(w.retainedTimeBounds());
    store.append("p", [{ name: "a", value: 4, t: 100000 }], 100000);
    page.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
    assert.strictEqual(JSON.stringify(w.retainedTimeBounds()), bounds);
    w.showExport();
    const exportInfo = page.messages.at(-1);
    page.send({
        type: "chartExportInfoResult",
        ...store.status("p", w.remoteHistory.snapshotId),
        requestId: exportInfo.requestId,
        historyRevision: 0
    });
    w.applyExport();
    const exported = page.messages.at(-1);
    assert.strictEqual(exported.backendHistory, true);
    assert.deepStrictEqual(exported.names, ["a", "b"]);
    assert.ok(!exported.csv, "export requests original backend history");
    w.resumeChart();
    const stale = request();
    w.clearHistory();
    answer(stale);
    assert.strictEqual(w.remoteHistory.series.length, 0);
    page.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
    assert.strictEqual(w.retainedTimeBounds(), null);
    page.send({ type: "samplingHistoryCleared", historyRevision: 1 });
    page.assertHealthy();
    console.log("Remote viewport, silent history, stale replies, freeze and raw export UI tests passed");
} finally {
    page.close();
}
