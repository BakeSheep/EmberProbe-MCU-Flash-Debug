"use strict";

// Opt-in audit, not a test-suite entry point. Canvas calls are real in browser mode;
// Node mode measures heap with explicit GC and uses the existing JSDOM canvas stub.
// node --expose-gc test/perf/chart-history-bench.js
// node test/perf/chart-history-bench.js --browser-html (requires mockup/build.js first)
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { render } = require("../helpers/render-webview");
const { getLiveWatchContent } = require("../../src/liveWatchView");

const scenarios = [3, 10].flatMap((channels) =>
    [200, 600, 1800].map((seconds) => ({ channels, seconds, periodMs: 33 }))
);
scenarios.push(...[200, 600, 1200, 1800].map((seconds) => ({ channels: 3, seconds, periodMs: 5 })));

function runScenario(w, scenario, collectHeap) {
    const doc = w.document;
    const points = Math.ceil((scenario.seconds * 1000) / scenario.periodMs) + 1;
    const start = 1000000;
    const end = start + (points - 1) * scenario.periodMs;
    const watch = Array.from({ length: scenario.channels }, (_, i) => ({
        name: "channel" + i,
        address: 0x20000000 + i * 4,
        type: "f32",
        size: 4
    }));
    w.watch = watch;
    w.data = Object.create(null);
    w.analysis.snapshot = null;
    w.hidden = {};
    w.invalidateSeries();
    w.chartState.prepared = null;
    w.chartState.curveGeometry = null;
    w.renderVars();
    const baseline = collectHeap?.();
    for (let c = 0; c < scenario.channels; c++) {
        w.data[watch[c].name] = Array.from({ length: points }, (_, i) => ({
            t: start + i * scenario.periodMs,
            v: Math.sin(i * 0.023 + c) * 10 + Math.cos(i * 0.11) + c * 25,
            valueText: null
        }));
    }
    const rawHeap = collectHeap?.();
    // Pre-fill a steady-state history without waiting for real-time acquisition. The published
    // baseline predates the 30-minute retention change; reruns measure the current renderer.
    w.MAXPTS = points;
    w.CFG.autoMaxSamples = false;
    w.samplingOrigin = start;
    w.setWindowCustom();
    w.chartState.follow = false;
    w.chartState.pointer = null;
    const quantiles = (values) => {
        values.sort((a, b) => a - b);
        return {
            medianMs: values[Math.floor(values.length / 2)],
            p95Ms: values[Math.ceil(values.length * 0.95) - 1]
        };
    };
    const draw = (spanSeconds) => {
        w.chartState.x = { min: Math.max(start, end - spanSeconds * 1000), max: end };
        const times = [];
        for (let i = 0; i < 38; i++) {
            // New sample messages invalidate the caches in production. Measure that path,
            // including series filtering, time bounds, statistics, geometry and Canvas calls.
            w.invalidateSeries();
            w.dirty = true;
            w.chartState.fastDirty = true;
            const before = performance.now();
            w.draw(1000 + i * 100);
            if (i >= 8) times.push(performance.now() - before);
        }
        return quantiles(times);
    };
    const last30Seconds = draw(30);
    const shortViewHeap = collectHeap?.();
    const wholeHistory = draw(scenario.seconds);
    const fullViewHeap = collectHeap?.();
    const geometryPoints = w.chartState.curveGeometry.value.reduce((n, series) => n + series.points.length, 0);
    const drawingPoints = w.chartState.curveGeometry.value.reduce((n, series) => n + series.drawing.length, 0);
    const beforeFreeze = performance.now();
    w.freezeChart();
    const freezeMs = performance.now() - beforeFreeze;
    const frozenHeap = collectHeap?.();
    w.resumeChart();
    const receive = [];
    for (let i = 0; i < 350; i++) {
        const samples = watch.map((item, c) => ({
            name: item.name,
            value: 1.25 + c,
            t: end + (i + 1) * scenario.periodMs
        }));
        const before = performance.now();
        w.onSamples(samples);
        if (i >= 50) receive.push(performance.now() - before);
    }
    const result = {
        ...scenario,
        pointsPerChannel: points,
        totalPoints: points * scenario.channels,
        last30Seconds,
        wholeHistory,
        receive: quantiles(receive),
        freezeMs,
        geometryPoints,
        drawingPoints
    };
    if (collectHeap) {
        result.heapMiB = Object.fromEntries(
            Object.entries({
                raw: rawHeap - baseline,
                last30Seconds: shortViewHeap - baseline,
                wholeHistory: fullViewHeap - baseline,
                frozenWholeHistory: frozenHeap - baseline
            }).map(([name, bytes]) => [name, bytes / 1048576])
        );
    }
    doc.getElementById("status").textContent = JSON.stringify(result);
    return result;
}

if (process.argv.includes("--browser-html")) {
    const html = getLiveWatchContent({ autoMaxSamples: false }, "en");
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    const code = `
        const scenarios = ${JSON.stringify(scenarios)};
        const results = [];
        const runScenario = ${runScenario.toString()};
        const report = document.createElement("pre");
        report.id = "historyBenchResults";
        report.style.cssText = "position:fixed;inset:0;z-index:1000;padding:20px;overflow:auto;background:#fff;color:#222;font:14px monospace";
        document.body.append(report);
        async function audit() {
            for (const scenario of scenarios) {
                report.textContent = "Running " + JSON.stringify(scenario) + "\\n" + JSON.stringify(results, null, 2);
                await new Promise(resolve => requestAnimationFrame(resolve));
                results.push(runScenario(window, scenario));
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            report.dataset.complete = "true";
            report.textContent = JSON.stringify({ userAgent: navigator.userAgent, canvasWidth: chart.clientWidth,
                canvasHeight: chart.clientHeight, results }, null, 2);
        }
        audit().catch(error => { report.textContent = String(error.stack); report.dataset.complete = "error"; });
    `;
    const destination = path.join(__dirname, "../../mockup/dist/history-bench.html");
    const tag = nonce ? `<script nonce="${nonce}">` : "<script>";
    fs.writeFileSync(destination, html.replace("</body>", `${tag}${code}</script></body>`));
    console.log(destination);
} else if (process.argv.includes("--one")) {
    if (!global.gc) throw new Error("Use --expose-gc for memory measurements");
    const scenario = JSON.parse(process.argv[process.argv.indexOf("--one") + 1]);
    const view = render(getLiveWatchContent({ autoMaxSamples: false }, "en"));
    Object.defineProperties(view.document.getElementById("chart"), {
        clientWidth: { value: 900 },
        clientHeight: { value: 500 }
    });
    const result = runScenario(view.window, scenario, () => {
        global.gc();
        return process.memoryUsage().heapUsed;
    });
    view.assertHealthy();
    view.close();
    console.log(JSON.stringify(result));
} else {
    const results = scenarios.map((scenario) => {
        const child = spawnSync(process.execPath, ["--expose-gc", __filename, "--one", JSON.stringify(scenario)], {
            encoding: "utf8",
            maxBuffer: 1024 * 1024
        });
        if (child.status !== 0) throw new Error(child.stderr || child.stdout);
        return JSON.parse(child.stdout.trim());
    });
    const report = {
        node: process.version,
        cpu: os.cpus()[0].model,
        platform: process.platform,
        canvas: "JSDOM stub; JS timings exclude native drawing",
        results
    };
    const destination = path.join(__dirname, "../../output/performance/chart-history-node.json");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
}
