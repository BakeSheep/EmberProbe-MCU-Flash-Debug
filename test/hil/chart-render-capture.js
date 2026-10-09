"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { render } = require("../helpers/render-webview");
const { getLiveWatchContent } = require("../../src/liveWatchView");

const file = process.argv[2];
if (!file) throw new Error("Pass the VS Code HIL chart capture JSON path");
const capture = JSON.parse(fs.readFileSync(file, "utf8"));
const graph = render(getLiveWatchContent({ maxSamples: 2000, intervalMs: 100 }, "en"));
try {
    const canvas = graph.document.getElementById("chart");
    Object.defineProperties(canvas, {
        clientWidth: { value: 900 },
        clientHeight: { value: 500 }
    });
    const names = Object.values(capture.variables);
    graph.send({
        type: "watchList",
        items: names.map((name) => ({ name, type: "u32", address: 0x24000000, size: 4 }))
    });
    graph.send({ type: "liveStatus", source: "dap", canRead: true, running: true, intentEnabled: true });
    for (const message of capture.messages) graph.send(message);
    graph.window.draw(Date.now());
    const ticks = graph.window.data[capture.variables.TICKS];
    const applied = graph.window.data[capture.variables.APPLIED_MS];
    assert.ok(ticks.length >= 8, "Chart must retain at least eight real hardware points");
    assert.ok(ticks.at(-1).v > ticks[0].v, "TICKS curve must rise");
    assert.ok(ticks.at(-1).t > ticks[0].t, "Chart timeline must advance");
    assert.ok(
        applied.some((point) => point.v === 250),
        "Chart must include the tuned value"
    );
    assert.ok(
        applied.some((point) => point.v === 100),
        "Chart must include the restored value"
    );
    assert.ok(graph.window.chartState.curveGeometry.value.length > 0, "Canvas renderer must build curve geometry");
    assert.ok(graph.document.getElementById("chartEmpty").classList.contains("hidden"));
    assert.ok(Number.parseFloat(graph.document.getElementById("rate").textContent) > 0);
    assert.ok(canvas.width > 0 && canvas.height > 0);
    console.log(
        JSON.stringify({
            batches: capture.messages.length,
            tickPoints: ticks.length,
            tickFirst: ticks[0].v,
            tickLast: ticks.at(-1).v,
            appliedValues: [...new Set(applied.map((point) => point.v))],
            canvas: [canvas.width, canvas.height],
            rate: graph.document.getElementById("rate").textContent
        })
    );
} finally {
    graph.close();
}
