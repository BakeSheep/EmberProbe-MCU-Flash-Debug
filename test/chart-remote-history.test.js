"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { encodeViewport } = require("../src/webview/liveWatch/chartTransport");
const page = render(getLiveWatchContent({ frequencyHz: 200 }, "en"));
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
            ...encodeViewport(store.viewport("p", r.names, r.range, r.width, r.snapshotId)).message,
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
    assert.strictEqual(w.remoteHistory.view, null, "outdated visibility reply cannot restore curves");
    const second = page.messages.filter((message) => message.type === "chartViewport").at(-1);
    assert.deepStrictEqual(second.names, ["a", "b"]);
    answer(second);
    assert.strictEqual(JSON.stringify(w.chartState.x), viewport);
    assert.ok(w.remoteHistory.view.series.find((s) => s.name === "b").visibleCount > 5000);
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
        type: "samplingArchiveInfo",
        openExport: true,
        variables: ["a", "b"],
        firstTimestampMs: 1000,
        lastTimestampMs: 100000,
        historyRevision: 0
    });
    w.applyExport();
    const exported = page.messages.at(-1);
    assert.strictEqual(exportInfo.type, "samplingArchiveInfo");
    assert.deepStrictEqual(exported.names, ["a", "b"]);
    w.resumeChart();
    const stale = request();
    w.clearHistory();
    answer(stale);
    assert.strictEqual(w.remoteHistory.view, null);
    page.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
    assert.strictEqual(w.retainedTimeBounds(), null);
    page.send({ type: "samplingHistoryCleared", historyRevision: 1 });
    page.assertHealthy();
} finally {
    page.close();
}

for (const follow of [false, true]) {
    const delayed = render(getLiveWatchContent({}, "en"));
    try {
        const w = delayed.window;
        Object.defineProperties(delayed.document.getElementById("chart"), {
            clientWidth: { value: 800 },
            clientHeight: { value: 400 }
        });
        const store = new ChartHistoryStore();
        const items = [{ name: "value", type: "u32", address: 0x20000000 }];
        store.configure("p", items);
        store.append(
            "p",
            [
                { name: "value", value: 1, t: 1000 },
                { name: "value", value: 2, t: 50000 }
            ],
            50000
        );
        delayed.send({ type: "watchList", items });
        delayed.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
        // Choose either a pinned viewport or the default automatic follow window.
        w.syncTimeBounds();
        w.chartState.follow = follow;
        w.draw(1000);
        for (let cycle = 0; cycle < 5; cycle++) {
            if (w.remoteHistory.view) w.remoteHistory.view.receivedAt = -Infinity;
            w.remoteHistory.lastRequest = -Infinity;
            w.dirty = true;
            w.draw(2000 + cycle * 200);
            const request = delayed.messages.filter((message) => message.type === "chartViewport").at(-1);
            const purpose = w.remoteHistory.inFlight.purpose;
            const response = store.viewport("p", request.names, request.range, request.width);
            store.append("p", [{ name: "value", value: cycle + 3, t: 51000 + cycle * 1000 }], 51000 + cycle * 1000);
            delayed.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
            w.draw(2100 + cycle * 200);
            assert.strictEqual(w.remoteHistory.inFlight.requestId, request.requestId);
            delayed.send({
                type: "chartViewportResult",
                ...response,
                requestId: request.requestId,
                historyRevision: 0
            });
            const accepted = w.remoteHistory[purpose === "overview" ? "overview" : "view"];
            assert.strictEqual(accepted.revision, response.revision, "continuous sampling accepts a valid reply");
            assert.ok(accepted.series.length > 0);
        }
        delayed.assertHealthy();
    } finally {
        delayed.close();
    }
}

for (const [index, change] of [
    (w) => {
        w.chartState.x = { min: 1200, max: 1800 };
    },
    (w) => {
        w.watch[0].type = "f32";
    },
    (w) => {
        w.watch[0].address++;
    },
    (w) => {
        w.hidden.value = true;
    }
].entries()) {
    const changed = render(getLiveWatchContent({}, "en"));
    try {
        const w = changed.window;
        Object.defineProperties(changed.document.getElementById("chart"), {
            clientWidth: { value: 800 },
            clientHeight: { value: 400 }
        });
        changed.send({ type: "watchList", items: [{ name: "value", type: "u32", address: 0x20000000 }] });
        changed.send({ type: "chartHistoryStatus", revision: 1, bounds: { min: 1000, max: 2000 }, historyRevision: 0 });
        w.syncTimeBounds();
        w.chartState.follow = false;
        w.draw(1000);
        const request = changed.messages.filter((message) => message.type === "chartViewport").at(-1);
        change(w);
        w.dirty = true;
        w.draw(1100);
        changed.send({
            type: "chartViewportResult",
            requestId: request.requestId,
            historyRevision: 0,
            revision: 1,
            bounds: { min: 1000, max: 2000 },
            series: [{ name: "value", arr: [{ t: 1500, v: 7 }] }]
        });
        if (index === 0) {
            assert.ok(w.remoteHistory.view.series.length, "range changes accept and translate a delayed reply");
            assert.strictEqual(w.chartState.x.min, 1200);
            assert.strictEqual(w.chartState.x.max, 1800);
            w.dirty = true;
            w.draw(1200);
            const point = w.Inspection.pointAt(w.chartState.curveGeometry.value[0], 0),
                geometry = w.chartState.geometry;
            assert.strictEqual(point.raw.t, 1500);
            assert.ok(
                Math.abs(point.x - geometry.padL - geometry.pw / 2) < 1e-9,
                "reply is translated to the new viewport"
            );
        } else assert.strictEqual(w.remoteHistory.view, null, "configuration changes invalidate a delayed reply");
    } finally {
        changed.close();
    }
}

const reloaded = render(getLiveWatchContent({}, "en"));
try {
    const w = reloaded.window;
    reloaded.send({ type: "chartHistoryReady", historyRevision: 4 });
    assert.strictEqual(w.historyRevision, 4);
    assert.strictEqual(
        reloaded.messages.at(-1).historyRevision,
        4,
        "archive requests use the synchronized host generation"
    );
    reloaded.send({ type: "chartHistoryStatus", revision: 2, historyRevision: 4, bounds: { min: 1000, max: 2000 } });
    assert.ok(w.retainedTimeBounds(), "retained history is visible after reloading a previously cleared panel");
    reloaded.send({ type: "chartHistoryStatus", revision: 1, historyRevision: 3, bounds: null });
    assert.ok(w.retainedTimeBounds(), "old generations remain invalid after ready");
    w.clearHistory();
    reloaded.send({ type: "chartHistoryReady", historyRevision: 4 });
    assert.strictEqual(w.historyRevision, 5, "a delayed handshake cannot undo a pending clear");
    assert.strictEqual(w.historyClearPending, true);
    reloaded.send({ type: "samplingHistoryCleared", historyRevision: 5 });
    reloaded.send({ type: "chartHistoryReady", historyRevision: -1 });
    assert.strictEqual(w.historyRevision, 5, "invalid handshake generations are rejected");
    reloaded.assertHealthy();
} finally {
    reloaded.close();
}

const hiddenPage = render(getLiveWatchContent({}, "en"));
try {
    const w = hiddenPage.window;
    Object.defineProperties(hiddenPage.document.getElementById("chart"), {
        clientWidth: { value: 800 },
        clientHeight: { value: 400 }
    });
    hiddenPage.send({ type: "watchList", items: [{ name: "value", type: "u32", address: 0x20000000 }] });
    w.hidden.value = true;
    hiddenPage.send({ type: "liveStatus", running: true, actualHz: 0 });
    for (let cycle = 0; cycle < 5; cycle++) {
        hiddenPage.send({
            type: "chartValues",
            actualHz: 30.3,
            samples: [{ name: "value", value: cycle, t: 1000 + cycle * 33 }]
        });
        hiddenPage.send({
            type: "chartHistoryStatus",
            revision: cycle + 1,
            historyRevision: 0,
            bounds: { min: 1000, max: 1100 + cycle * 33 }
        });
        w.remoteHistory.lastRequest = -Infinity;
        w.draw(1000 + cycle * 200);
        assert.ok(
            hiddenPage.document.getElementById("chartEmpty").textContent.includes("All curves are hidden"),
            "a hidden chart must not switch to history loading on new samples"
        );
        assert.ok(
            hiddenPage.document.querySelector("#chartEmpty button"),
            "the show-all action stays visible while sampling"
        );
        assert.strictEqual(w.historyLoading.hidden, true);
        assert.strictEqual(hiddenPage.document.getElementById("rate").textContent, "0.0kb/s | 30.3Hz");
    }
    assert.strictEqual(
        hiddenPage.messages.filter((message) => message.type === "chartViewport").length,
        0,
        "all-hidden charts need no viewport transfer"
    );
    assert.strictEqual(w.latest.value, 4, "hidden values still receive samples");
    w.toggleCurve("value");
    w.remoteHistory.lastRequest = -Infinity;
    w.draw(2100);
    assert.deepStrictEqual(hiddenPage.messages.at(-1).names, ["value"], "showing a curve resumes history requests");
    assert.strictEqual(hiddenPage.document.getElementById("chartEmpty").textContent, "Loading recorded history…");
    const request = hiddenPage.messages.at(-1);
    hiddenPage.send({
        type: "chartViewportResult",
        requestId: request.requestId,
        historyRevision: 0,
        revision: 5,
        bounds: { min: 1000, max: 1232 },
        series: [{ name: "value", arr: Array.from({ length: 5 }, (_, value) => ({ t: 1000 + value * 33, v: value })) }]
    });
    w.draw(2300);
    assert.strictEqual(
        w.chartData(w.chartState.x, 800)[0].arr.length,
        5,
        "showing a curve restores hidden-period history"
    );
    assert.strictEqual(w.historyLoading.hidden, true);
    hiddenPage.assertHealthy();
} finally {
    hiddenPage.close();
}

const compositePage = render(getLiveWatchContent({}, "en"));
try {
    const w = compositePage.window;
    Object.defineProperties(compositePage.document.getElementById("chart"), {
        clientWidth: { value: 800 },
        clientHeight: { value: 400 }
    });
    compositePage.send({
        type: "watchList",
        items: [{ name: "sensor", isComposite: true, compositeLayout: { kind: "struct", members: [] } }]
    });
    compositePage.send({ type: "liveStatus", running: true, actualHz: 0 });
    for (let cycle = 0; cycle < 5; cycle++) {
        compositePage.send({
            type: "liveCompositeSample",
            actualHz: 30.3,
            samples: [{ name: "sensor", tree: { kind: "struct", members: [] }, t: 1000 + cycle * 33 }]
        });
        compositePage.send({
            type: "chartHistoryStatus",
            revision: cycle + 1,
            historyRevision: 0,
            bounds: { min: 1000, max: 1100 + cycle * 33 }
        });
        w.draw(1000 + cycle * 200);
        assert.strictEqual(
            compositePage.document.getElementById("rate").textContent,
            "0.0kb/s | 30.3Hz",
            "composite-only sampling updates the measured rate without plotted members"
        );
        assert.ok(compositePage.document.getElementById("chartEmpty").textContent.includes("member"));
        assert.strictEqual(w.historyLoading.hidden, true);
    }
    assert.strictEqual(compositePage.messages.filter((message) => message.type === "chartViewport").length, 0);
    compositePage.send({ type: "liveStatus", running: false, actualHz: 0 });
    compositePage.send({ type: "liveCompositeSample", actualHz: 30.3, samples: [] });
    assert.strictEqual(
        compositePage.document.getElementById("rate").textContent,
        "0.0kb/s | 0.0Hz",
        "late samples do not restore the rate after stop"
    );
    compositePage.assertHealthy();
} finally {
    compositePage.close();
}

// Values in flight before the clear acknowledgement are dropped; only the matching acknowledgement resumes them.
const clearing = render(getLiveWatchContent({}, "en"));
try {
    const w = clearing.window;
    clearing.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 0x20000000 }] });
    clearing.send({ type: "chartValues", samples: [{ name: "tick", value: 1, t: 1000 }], t: 1000 });
    w.clearHistory();
    const revision = w.historyRevision;
    assert.strictEqual(clearing.messages.at(-1).type, "clearSamplingHistory");
    clearing.send({ type: "chartValues", samples: [{ name: "tick", value: 99, t: 2000 }], t: 2000 });
    assert.strictEqual(w.latest.tick, null, "values sent before the clear acknowledgement are discarded");
    clearing.send({ type: "samplingHistoryCleared", historyRevision: revision - 1 });
    assert.strictEqual(w.historyClearPending, true, "an older acknowledgement does not end the clear");
    clearing.send({ type: "samplingHistoryCleared", historyRevision: revision });
    clearing.send({ type: "chartValues", samples: [{ name: "tick", value: 7, t: 3000 }], t: 3000 });
    assert.strictEqual(w.latest.tick, 7);
    w.clearHistory();
    clearing.send({ type: "debugSessionChanged" });
    assert.strictEqual(w.historyClearPending, false, "session changes clear the view without erasing the archive");
    clearing.assertHealthy();
} finally {
    clearing.close();
}

console.log("Remote viewport, silent history, stale replies, freeze, clear races and raw export UI tests passed");
