"use strict";
// Opt-in software benchmark; --browser-html emits the same scenarios for real Canvas.
const fs = require("fs");
const path = require("path");
const { ChartHistoryStore } = require("../../src/services/chartHistoryStore");
const { render } = require("../helpers/render-webview");
const { getLiveWatchContent } = require("../../src/liveWatchView");
function run(w, Store, channels, seconds) {
    const store = new Store();
    const items = Array.from({ length: channels }, (_, i) => ({ name: "channel" + i, type: "f32" }));
    store.configure("bench", items);
    for (let i = 0; i <= seconds * 200; i++)
        store.append(
            "bench",
            items.map((item, c) => ({
                name: item.name,
                value: Math.sin(i * 0.023 + c) * 10 + c * 25,
                t: 1000000 + i * 5
            })),
            1000000 + i * 5
        );
    w.watch = items;
    w.hidden = {};
    w.renderVars();
    w.remoteHistory.status = store.status("bench");
    w.remoteHistory.liveStatus = w.remoteHistory.status;
    w.chartState.bounds = w.remoteHistory.status.bounds;
    w.chartState.follow = false;
    w.samplingOrigin = 1000000;
    const result = { channels, seconds, bufferMiB: store.bytes / 1048576, scenarios: [] };
    const quantiles = (values) => {
        values.sort((a, b) => a - b);
        return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.ceil(values.length * 0.95) - 1] };
    };
    for (const visible of [channels, 1])
        for (const span of [30, seconds]) {
            w.hidden = Object.fromEntries(items.slice(visible).map((item) => [item.name, true]));
            const range = { min: 1000000 + (seconds - span) * 1000, max: 1000000 + seconds * 1000 };
            w.chartState.x = range;
            const backend = [],
                frontend = [];
            for (let frame = 0; frame < 16; frame++) {
                const start = performance.now();
                const viewport = store.viewport(
                    "bench",
                    items.slice(0, visible).map((item) => item.name),
                    range,
                    w.document.getElementById("chart").clientWidth
                );
                const computed = performance.now();
                w.remoteHistory.series = viewport.series;
                w.remoteHistory.inFlight = { requestId: -1 }; // transport is measured separately by worker tests
                w.dirty = true;
                w.chartState.fastDirty = true;
                w.draw(1000 + frame * 100);
                const drawn = performance.now();
                if (frame >= 4) {
                    backend.push(computed - start);
                    frontend.push(drawn - computed);
                }
            }
            result.scenarios.push({
                visible,
                span,
                backend: quantiles(backend),
                frontend: quantiles(frontend),
                geometryPoints: w.chartState.curveGeometry.value.reduce(
                    (count, series) => count + series.points.length,
                    0
                )
            });
        }
    return result;
}
const scenarios = [3, 10].flatMap((channels) => [1200, 1800].map((seconds) => ({ channels, seconds })));
if (process.argv.includes("--browser-html")) {
    const html = getLiveWatchContent({ backendHistory: true, frequencyHz: 200 }, "en");
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    const storeCode = fs
        .readFileSync(path.join(__dirname, "../../src/services/chartHistoryStore.js"), "utf8")
        .replace("module.exports =", "window.BenchHistory =");
    const code = `${storeCode}\nconst benchRun=${run.toString()};
        const report=document.createElement('pre');report.id='layeredBenchResults';
        report.style.cssText='position:fixed;inset:0;z-index:1000;background:white;color:black;overflow:auto;padding:20px';document.body.append(report);
        (async()=>{ const results=[];for(const s of ${JSON.stringify(scenarios)}){
            report.textContent='Running '+JSON.stringify(s);await new Promise(r=>setTimeout(r,20));
            results.push(benchRun(window,window.BenchHistory.ChartHistoryStore,s.channels,s.seconds));
        } report.dataset.complete='true'; report.textContent=JSON.stringify({userAgent:navigator.userAgent,results},null,2);
        })().catch(e=>{report.dataset.complete='error';report.textContent=e.stack;});`;
    fs.writeFileSync(
        path.join(__dirname, "../../mockup/dist/layered-bench.html"),
        html.replace("</body>", `${nonce ? '<script nonce="' + nonce + '">' : "<script>"}${code}</script></body>`)
    );
} else {
    const results = scenarios.map(({ channels, seconds }) => {
        const page = render(getLiveWatchContent({ backendHistory: true, frequencyHz: 200 }, "en"));
        try {
            Object.defineProperties(page.document.getElementById("chart"), {
                clientWidth: { value: 900 },
                clientHeight: { value: 500 }
            });
            return run(page.window, ChartHistoryStore, channels, seconds);
        } finally {
            page.close();
        }
    });
    console.log(JSON.stringify({ node: process.version, canvas: "JSDOM stub", results }, null, 2));
}
