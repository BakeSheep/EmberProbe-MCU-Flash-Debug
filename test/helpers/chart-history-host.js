"use strict";
// Plays the extension host for a rendered live-watch page: values arrive as chartValues, and curves come from a
// real ChartHistoryStore that answers the page's chartViewport / chartFreeze / chartResume / clear requests.
const { ChartHistoryStore } = require("../../src/services/chartHistoryStore");
const { encodeViewport } = require("../../src/webview/liveWatch/chartTransport");

function chartHistoryHost(page, scope = "panel") {
    const store = new ChartHistoryStore();
    const w = page.window;
    let signature = "";
    let handled = 0;

    function configure() {
        const items = w.watch.filter((item) => !item.isComposite);
        const next = JSON.stringify(items.map((item) => [item.name, item.type, item.address]));
        if (next === signature) return;
        store.configure(scope, items);
        signature = next;
    }
    function status() {
        page.send({ type: "chartHistoryStatus", ...store.status(scope), historyRevision: w.historyRevision });
    }
    // Answers every request the page posted since the last call.
    function pump() {
        while (handled < page.messages.length) {
            const message = page.messages[handled++];
            const reply = { requestId: message.requestId, historyRevision: message.historyRevision };
            if (message.type === "chartViewport") {
                configure();
                const viewport = store.viewport(scope, message.names, message.range, message.width, message.snapshotId);
                page.send({
                    type: "chartViewportResult",
                    ...encodeViewport(viewport).message,
                    ...reply,
                    snapshotId: message.snapshotId
                });
            } else if (message.type === "chartFreeze") {
                const result = store.freeze(scope);
                page.send({ type: "chartFreezeResult", ...result, ...reply, snapshotId: result.snapshotId });
            } else if (message.type === "chartResume") {
                store.resume(scope);
                page.send({ type: "chartResumeResult", ...reply });
            } else if (message.type === "clearSamplingHistory") {
                store.clear(scope);
                page.send({ type: "samplingHistoryCleared", historyRevision: message.historyRevision });
            }
        }
    }
    // Records samples ({ name, value, t, valueText? }) and delivers them like the host's batched chartValues.
    function samples(list) {
        configure();
        const tick = Math.max(...list.map((sample) => sample.t));
        store.append(scope, list, tick);
        page.send({ type: "chartValues", samples: list, t: tick });
        status();
    }
    // Draws until the page has the detail and overview views it asks for. jsdom lays nothing out, so an unsized
    // chart gets a default size that tests can still override.
    function draw(now = 0) {
        const canvas = page.document.getElementById("chart");
        if (!canvas.clientWidth) {
            Object.defineProperty(canvas, "clientWidth", { value: 800, configurable: true });
            Object.defineProperty(canvas, "clientHeight", { value: 400, configurable: true });
        }
        for (let i = 0; i < 4; i++) {
            w.remoteHistory.lastRequest = -Infinity;
            w.dirty = true;
            w.chartState.fastDirty = true;
            w.draw(now);
            const before = handled;
            pump();
            if (handled === before) break;
        }
    }
    return { store, samples, status, pump, draw };
}

module.exports = { chartHistoryHost };
