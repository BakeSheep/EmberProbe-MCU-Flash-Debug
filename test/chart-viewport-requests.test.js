"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { encodeViewport } = require("../src/webview/liveWatch/chartTransport");

function scenario(run) {
    let now = 10000;
    const page = render(
        getLiveWatchContent({ backendHistory: true }, "en"),
        {},
        {
            beforeParse(w) {
                w.performance.now = () => now;
            }
        }
    );
    const w = page.window;
    Object.defineProperties(page.document.getElementById("chart"), {
        clientWidth: { value: 800 },
        clientHeight: { value: 400 }
    });
    const items = [
        { name: "a", type: "f32", address: 0x20000000 },
        { name: "b", type: "f32", address: 0x20000004 }
    ];
    const store = new ChartHistoryStore();
    store.configure("p", items);
    function append(time) {
        store.append(
            "p",
            items.map((item, index) => ({ name: item.name, t: time, value: time + index })),
            time
        );
    }
    for (let time = 1000; time <= 101000; time += 100) append(time);
    function status() {
        page.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: w.historyRevision });
    }
    page.send({ type: "watchList", items });
    status();
    w.syncTimeBounds();
    w.chartState.follow = false;
    w.chartState.x = { min: 41000, max: 51000 };
    const sent = [];
    function draw(elapsed = 80) {
        now += elapsed;
        w.dirty = true;
        w.chartState.fastDirty = true;
        w.draw(now);
        const request = w.remoteHistory.inFlight;
        if (request && !sent.includes(request)) {
            request.sentAt = w.remoteHistory.lastRequest;
            sent.push(request);
        }
        return request;
    }
    function answer(request = w.remoteHistory.inFlight, response) {
        assert.ok(request, "a request is in flight");
        const reply = response || store.viewport("p", request.names, request.range, request.width, request.snapshotId);
        page.send({
            type: "chartViewportResult",
            ...encodeViewport(reply).message,
            requestId: request.requestId,
            historyRevision: page.messages.find((m) => m.type === "chartViewport" && m.requestId === request.requestId)
                .historyRevision,
            snapshotId: request.snapshotId
        });
        return reply;
    }
    function settle() {
        for (let i = 0; i < 10; i++) {
            const request = draw();
            if (!request) return;
            answer(request);
        }
        assert.fail("viewport requests must settle with unchanged data");
    }
    function series() {
        return w.chartData(w.chartState.x, 800);
    }
    try {
        run({
            w,
            page,
            store,
            items,
            append,
            status,
            draw,
            answer,
            settle,
            series,
            sent,
            advance: (ms) => (now += ms)
        });
        page.assertHealthy();
    } finally {
        page.close();
    }
}

scenario(({ w, draw, answer, settle, sent }) => {
    w.chartState.x = { min: 11000, max: 21000 };
    w.chartState.drag = { region: "x" };
    let queued = null,
        accepted = 0;
    for (let frame = 0; frame < 60; frame++) {
        w.chartState.x = { min: 11000 + frame * 800, max: 21000 + frame * 800 };
        const request = draw(16);
        if (request && !queued) queued = { request, due: frame + 2 };
        if (queued && queued.due === frame) {
            const previous = w.remoteHistory.view;
            answer(queued.request);
            if (queued.request.purpose === "detail") {
                assert.notStrictEqual(w.remoteHistory.view, previous, "moving range does not discard a reply");
                assert.strictEqual(w.remoteHistory.view.range, queued.request.range);
                accepted++;
            }
            queued = null;
        }
    }
    assert.ok(accepted >= 5, "detail replies are accepted throughout a continuous drag");
    if (queued) answer(queued.request);
    w.chartState.drag = null;
    settle();
    const { view } = w.remoteHistory;
    assert.ok(view.range.min <= w.chartState.x.min && view.range.max >= w.chartState.x.max);
    assert.ok(
        view.series.every((part) => part.arr[0].t <= w.chartState.x.min && part.arr.at(-1).t >= w.chartState.x.max)
    );
    for (let i = 1; i < sent.length; i++) {
        assert.ok(sent[i].requestId > sent[i - 1].requestId);
        assert.ok(sent[i].sentAt - sent[i - 1].sentAt >= 80, "dispatches are at least 80 ms apart");
    }
});

scenario(({ w, settle, draw, series, sent }) => {
    settle();
    const before = sent.filter((r) => r.purpose === "detail").length;
    assert.deepStrictEqual({ ...w.remoteHistory.view.range }, { min: 31000, max: 61000 });
    assert.strictEqual(w.remoteHistory.view.width, 2400);
    w.chartState.x = { min: 49000, max: 59000 };
    draw();
    assert.strictEqual(sent.filter((r) => r.purpose === "detail").length, before, "small pans reuse overscan");
    for (const name of ["a", "b"]) {
        const points = series()
            .filter((part) => part.item.name === name)
            .flatMap((part) => part.arr);
        assert.ok(points.some((p) => p.t <= 49000) && points.some((p) => p.t >= 59000));
    }
});

scenario(({ w, draw, answer, settle, series }) => {
    settle();
    const oldView = w.remoteHistory.view;
    w.chartState.x = { min: 43500, max: 48500 };
    const zoom = draw();
    assert.strictEqual(zoom.purpose, "detail");
    assert.ok((zoom.range.max - zoom.range.min) / zoom.width < (oldView.range.max - oldView.range.min) / oldView.width);
    answer(zoom);
    w.chartState.x = { min: 1000, max: 101000 };
    const out = draw();
    assert.strictEqual(out.purpose, "detail");
    const current = w.remoteHistory.view,
        detail = current.series[0].arr,
        composed = series();
    assert.ok(
        composed.some((part) => part.arr === detail),
        "detail arrays remain intact inside the fetched range"
    );
    assert.ok(composed.some((part) => part.arr.some((p) => p.t < current.range.min)));
    assert.ok(composed.some((part) => part.arr.some((p) => p.t > current.range.max)));
    assert.ok(
        composed
            .filter((part) => !current.series.some((s) => s.arr === part.arr))
            .every((part) => !("visibleCount" in part))
    );
    answer(out);
    settle();
});

scenario(({ w, draw, answer, series, store }) => {
    const detail = draw();
    answer(detail);
    const overview = draw();
    assert.strictEqual(overview.purpose, "overview");
    assert.deepStrictEqual({ ...overview.range }, { ...store.status("p").bounds });
    assert.strictEqual(overview.width, 800);
    w.chartState.x = { min: 71000, max: 81000 };
    draw(0);
    answer(overview);
    assert.strictEqual(w.remoteHistory.overview.range, overview.range, "overview acceptance ignores view movement");
    const parts = series().filter((part) => part.item.name === "a" && !("visibleCount" in part)),
        range = w.remoteHistory.view.range,
        source = w.remoteHistory.overview.series.find((s) => s.name === "a").arr,
        left = parts.find((part) => part.arr[0].t < range.min),
        right = parts.find((part) => part.arr.at(-1).t > range.max);
    const ends = w.remoteHistory.view.series.filter((part) => part.name === "a");
    // The coarse line ends exactly on the detail curve's end points; no coarse point is drawn inside its range,
    // so the visible ends of the curve cannot jump when the overview or detail range changes.
    assert.strictEqual(left.arr.at(-1), ends[0].arr[0], "the left underlay joins the detail start");
    assert.strictEqual(right.arr[0], ends.at(-1).arr.at(-1), "the right underlay joins the detail end");
    for (const part of [left, right])
        for (const point of part.arr)
            if (point !== ends[0].arr[0] && point !== ends.at(-1).arr.at(-1)) {
                assert.ok(source.includes(point));
                assert.ok(point.t < ends[0].arr[0].t || point.t > ends.at(-1).arr.at(-1).t);
            }
});

scenario(({ w, draw, answer, advance }) => {
    const first = draw();
    advance(1101);
    w.chartState.x = { min: 71000, max: 81000 };
    draw(0);
    assert.ok(w.remoteHistory.pending, "new detail waits behind the in-flight request");
    answer(first);
    assert.strictEqual(w.remoteHistory.inFlight.purpose, "overview", "overdue overview precedes pending detail");
    answer();
    assert.strictEqual(draw().purpose, "detail", "latest detail follows overview");
});

scenario(({ w, draw, answer, settle, append, status, series, advance }) => {
    w.chartState.follow = true;
    w.applyWindowPreset("10");
    const first = draw();
    assert.strictEqual(first.range.min, w.chartState.x.min);
    assert.strictEqual(first.range.max, w.chartState.x.max + 5000);
    answer(first);
    settle();
    const before = w.chartState.x.max;
    append(101100);
    status();
    const request = draw();
    assert.strictEqual(w.chartState.x.max, before, "status cannot advance follow ahead of detail data");
    assert.strictEqual(w.remoteHistory.liveStatus.bounds.max, 101100);
    assert.strictEqual(request.revision, w.remoteHistory.liveStatus.revision, "requests use latest live revision");
    append(101200);
    const reply = answer(request);
    draw(0);
    assert.strictEqual(w.chartState.x.max, reply.bounds.max);
    for (const name of ["a", "b"]) {
        assert.strictEqual(
            Math.max(
                ...series()
                    .filter((s) => s.item.name === name)
                    .flatMap((s) => s.arr.map((p) => p.t))
            ),
            reply.bounds.max
        );
        const points = w.chartState.curveGeometry.value
                .filter((s) => s.name === name)
                .flatMap((s) => s.raw.map((_, i) => w.Inspection.pointAt(s, i))),
            last = points.reduce((a, b) => (a.raw.t > b.raw.t ? a : b)),
            geometry = w.chartState.geometry;
        assert.strictEqual(last.raw.t, reply.bounds.max);
        assert.strictEqual(last.x, geometry.padL + geometry.pw, "drawn curve reaches the follow right edge");
    }
    advance(1001);
    append(101300);
    status();
    draw(0);
    assert.strictEqual(w.chartState.x.max, 101300, "stalled detail falls back to current status after one second");
});

scenario(({ w, draw, answer, settle, append, status, sent }) => {
    settle();
    const receivedAt = w.remoteHistory.view.receivedAt,
        count = sent.filter((r) => r.purpose === "detail").length;
    for (let i = 1; i <= 10; i++) {
        append(101000 + i * 100);
        status();
        draw(80);
    }
    assert.strictEqual(
        sent.filter((r) => r.purpose === "detail").length,
        count,
        "past views ignore subsecond revisions"
    );
    assert.strictEqual(w.remoteHistory.view.receivedAt, receivedAt);
    const request = draw(200);
    assert.strictEqual(request.purpose, "detail");
    answer(request);
    assert.strictEqual(sent.filter((r) => r.purpose === "detail").length, count + 1);
});

scenario(({ w, draw, answer, settle, append, status, sent }) => {
    settle();
    w.chartState.follow = true;
    w.applyWindowPreset("10");
    for (let i = 1; i <= 40; i++) {
        append(101000 + i * 80);
        status();
        const request = draw();
        if (request) answer(request);
    }
    const overviews = sent.filter((r) => r.purpose === "overview");
    assert.ok(overviews.length >= 2, "overview refresh cannot starve behind continuous live detail");
    for (let i = 1; i < overviews.length; i++) {
        assert.ok(
            overviews[i].sentAt - overviews[i - 1].sentAt >= 1000,
            "live overview refreshes at most once per second"
        );
    }
});

scenario(({ w, settle, draw }) => {
    settle();
    const original = w.EmberProbeChart.paint,
        arrays = [];
    w.EmberProbeChart.paint = (options) => {
        arrays.push(options.series);
        return original(options);
    };
    draw(0);
    w.chartState.pointer = { x: 200, y: 150 };
    draw(0);
    assert.strictEqual(arrays[0], arrays[1], "hover redraws reuse the composed series array");
});

for (const change of [
    (w) => (w.watch[0].type = "u32"),
    (w) => w.watch[0].address++,
    (w) => (w.watch[0].bitOffset = 1),
    (w) => (w.watch[0].bitSize = 2),
    (w) => (w.hidden.a = true),
    (w) => (w.remoteHistory.snapshotId = "another-snapshot"),
    (w) => w.historyRevision++,
    (w) => w.clearHistory()
]) {
    scenario(({ w, draw, answer, store }) => {
        const request = draw(),
            response = store.viewport("p", request.names, request.range, request.width);
        change(w);
        // Deliberately deliver before another draw: acceptance must check the actual current configuration.
        answer(request, response);
        assert.strictEqual(w.remoteHistory.view, null, "changed configurations reject delayed detail replies");
    });
    scenario(({ w, draw, answer, store }) => {
        answer(draw());
        const request = draw(),
            response = store.viewport("p", request.names, request.range, request.width);
        assert.strictEqual(request.purpose, "overview");
        change(w);
        answer(request, response);
        assert.strictEqual(w.remoteHistory.overview, null, "changed configurations reject delayed overview replies");
    });
}

scenario(({ w, settle, series, draw }) => {
    settle();
    w.hidden.a = w.hidden.b = true;
    assert.strictEqual(series().length, 0);
    assert.strictEqual(w.remoteHistory.view, null);
    assert.strictEqual(w.remoteHistory.overview, null);
    assert.strictEqual(draw(), null, "empty visible names need no request");
    assert.strictEqual(w.historyLoading.hidden, true);
});

scenario(({ w, draw, answer, series, settle }) => {
    settle();
    w.remoteHistory.view = null;
    const overview = w.remoteHistory.overview;
    assert.ok(series().length);
    assert.ok(series().every((part) => overview.series.some((source) => source.arr === part.arr)));
    assert.ok(
        series().every((part) => !("visibleCount" in part)),
        "overview alone has no detail counts"
    );
    answer(draw());
});

scenario(({ w }) => {
    w.requestChartViewport(w.chartState.x, 4000);
    const request = w.remoteHistory.inFlight;
    assert.strictEqual(request.width, 8192);
    assert.ok(request.range.min > w.chartState.x.min - 10000, "overscan shrinks at the column limit");
    assert.strictEqual(w.chartState.x.min - request.range.min, request.range.max - w.chartState.x.max);
    assert.ok((request.range.max - request.range.min) / request.width <= 10000 / 4000);
});

scenario(({ w }) => {
    w.chartState.x = { min: 1000, max: 11000 };
    w.requestChartViewport(w.chartState.x, 4000);
    const request = w.remoteHistory.inFlight;
    assert.deepStrictEqual({ ...request.range }, { min: 1000, max: 21000 });
    assert.strictEqual(request.width, 8000, "clipping to bounds precedes the overscan column cap");
});

scenario(({ w, draw }) => {
    w.clearHistory(false);
    w.freezeChart();
    draw();
    assert.strictEqual(w.historyLoading.hidden, false, "freezing shows loading even before bounds are available");
});

scenario(({ w, draw, answer, settle, page, store, append, status, advance, series }) => {
    settle();
    w.freezeChart();
    assert.strictEqual(w.dirty, true, "starting a freeze schedules its loading indicator");
    const operation = w.remoteHistory.operation;
    const liveView = w.remoteHistory.view;
    page.send({ type: "chartFreezeResult", ...store.freeze("p"), requestId: operation, historyRevision: 0 });
    assert.strictEqual(w.remoteHistory.view, liveView, "freezing keeps the drawn view until the snapshot reply");
    assert.ok(series().length > 0, "curves stay visible while the snapshot view loads");
    settle();
    assert.notStrictEqual(w.remoteHistory.view, liveView);
    const snapshot = w.remoteHistory.status,
        view = w.remoteHistory.view;
    append(102000);
    status();
    advance(2000);
    assert.strictEqual(draw(), null, "frozen data never refreshes for live revisions");
    assert.strictEqual(w.remoteHistory.status, snapshot);
    assert.strictEqual(w.remoteHistory.view, view);
    w.resumeChart();
    assert.strictEqual(w.remoteHistory.view, view, "resuming keeps the frozen view until live data arrives");
    assert.ok(series().length > 0);
    const request = draw();
    w.clearHistory();
    answer(request);
    assert.strictEqual(w.remoteHistory.view, null);
    assert.strictEqual(w.remoteHistory.pending, null);
    assert.strictEqual(w.remoteHistory.inFlight, null);
    page.send({ type: "samplingHistoryCleared", historyRevision: w.historyRevision });
    page.send({ type: "chartHistoryReady", historyRevision: w.historyRevision });
    assert.strictEqual(w.remoteHistory.status, null);
});

console.log("Chart drag, overscan, overview, atomic follow, revision throttling and memoization tests passed");

for (const [span, width] of [
    [8000, 800],
    [1800000, 800],
    [1800000, 16000]
]) {
    scenario(({ w, settle, advance }) => {
        settle();
        w.chartState.follow = true;
        w.chartState.startPinned = span === 1800000;
        w.chartState.x = { min: 1000, max: 1000 + span };
        const bounds = { ...w.chartState.x };
        w.remoteHistory.liveStatus = w.remoteHistory.status = { revision: 2, bounds };
        w.remoteHistory.view = {
            ...w.remoteHistory.view,
            range: { ...bounds },
            width: Math.min(8192, width),
            revision: 1,
            receivedAt: w.performance.now()
        };
        w.remoteHistory.overview = { ...w.remoteHistory.overview, revision: 2 };
        const interval = Math.max(80, span / width);
        advance(interval - 1);
        w.requestChartViewport(w.chartState.x, width);
        assert.strictEqual(w.remoteHistory.inFlight, null, "revision-only follow refresh waits for a pixel column");
        advance(1);
        w.requestChartViewport(w.chartState.x, width);
        assert.strictEqual(w.remoteHistory.inFlight.purpose, "detail");
        assert.strictEqual(w.remoteHistory.lastRequest - w.remoteHistory.view.receivedAt, interval);
    });
}

scenario(({ w, draw, answer, settle, page, advance }) => {
    settle();
    // A failed detail request for an unchanged key is not repeated on every frame.
    w.chartState.x = { min: 61000, max: 71000 };
    const failing = draw();
    assert.strictEqual(failing.purpose, "detail");
    answer(failing, { error: "Too many discontinuities", series: [] });
    const before = page.messages.filter((m) => m.type === "chartViewport").length;
    for (let i = 0; i < 5; i++) draw();
    assert.strictEqual(page.messages.filter((m) => m.type === "chartViewport").length, before);
    // Moving the view changes the key and retries.
    advance(10);
    w.chartState.x = { min: 81000, max: 91000 };
    assert.ok(draw(), "a new viewport retries after a failure");
});

scenario(({ w, settle, series, items }) => {
    settle();
    assert.ok(series().some((part) => part.item.name === "b"));
    // Hiding a curve keeps the other curve drawn from the previous reply until the new one arrives.
    w.hidden.b = true;
    const shown = series();
    assert.ok(shown.length > 0 && shown.every((part) => part.item.name === "a"));
    w.hidden.b = false;
    // A changed identity hides stale data for that curve only.
    const index = w.watch.findIndex((item) => item.name === "a");
    w.watch[index] = { ...w.watch[index], type: "u32" };
    const changed = series();
    assert.ok(changed.every((part) => part.item.name === "b"));
    assert.ok(changed.length > 0);
    void items;
});
