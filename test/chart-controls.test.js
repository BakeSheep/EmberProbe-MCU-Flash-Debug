"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { create } = require("../src/webview/liveWatch/chartControls");
const { paint } = require("../src/webview/liveWatch/chart");
const I = require("../src/webview/liveWatch/chartInspection");
const VP = require("../src/webview/liveWatch/viewport");
const dom = new JSDOM(
    '<button id="freeze"></button><div class="side-head"></div><div class="chart-head"></div><section><div><div id="chartStage"><canvas id="chart"></canvas><div id="chartEmpty"></div></div></div></section><span id="points"></span><span id="range"></span>'
);
try {
    const doc = dom.window.document,
        actions = [];
    const series = ["a", "b"].map((name) => ({
        item: { name },
        arr: [
            { t: 0, v: 1.5 },
            { t: 100, v: 2.7 }
        ]
    }));
    const state = {
        chart: {
            x: { min: 0, max: 100 },
            pointer: { x: 100, y: 100 },
            geometry: { padL: 10, pw: 300 },
            hits: [{ name: "a", point: series[0].arr[0] }]
        },
        analysis: {},
        hidden: {},
        watch: [{ name: "a", type: "u32" }],
        types: ["u32", "f32"],
        style: () => ({ color: "#1684c5", line: "solid" }),
        compare: true,
        frozen: false,
        lang: "en"
    };
    const controls = create({
        document: doc,
        t: (k) => k,
        change: (...args) => actions.push(args),
        get: () => state,
        fmtNum: String,
        time: String,
        inspection: I
    });
    const row = doc.createElement("div"),
        swatch = doc.createElement("button");
    row.append(swatch);
    doc.body.append(row);
    controls.decorate(row, "a", swatch);
    controls.refresh(series);
    assert.equal(doc.getElementById("curveTooltip").textContent, "1.5");
    assert.ok(!doc.getElementById("curveTooltip").textContent.includes("a"));
    assert.ok(row.classList.contains("curve-emphasis"));
    row.dispatchEvent(new dom.window.Event("pointerenter"));
    row.dispatchEvent(new dom.window.Event("pointerleave"));
    row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    assert.equal(row.querySelector(".series-options"), null);
    const type = doc.querySelector(".series-type");
    type.value = "f32";
    type.dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual(actions.at(-1), ["type", { name: "a", type: "f32" }]);
    const color = doc.querySelector('input[type="color"]');
    color.value = "#aabbcc";
    color.dispatchEvent(new dom.window.Event("input"));
    assert.equal(actions.at(-1)[1].style.color, "#aabbcc");
    doc.querySelector(".series-menu > select").value = "dotted";
    doc.querySelector(".series-menu > select").dispatchEvent(new dom.window.Event("change"));
    assert.equal(actions.at(-1)[1].style.line, "dotted");
    doc.getElementById("seriesOnly").click();
    assert.deepEqual(actions.at(-1), ["focus", "a"]);
    row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    doc.getElementById("seriesRemove").click();
    assert.deepEqual(actions.at(-1), ["remove", "a"]);
    row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    doc.getElementById("seriesClose").click();
    assert.ok(doc.querySelector(".series-menu").classList.contains("hidden"));
    row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
    assert.ok(!doc.querySelector(".series-menu").classList.contains("hidden"));
    doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));

    doc.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    for (const id of ["showAll", "hideAll", "restoreCurves", "autoY"]) doc.getElementById(id).click();
    state.frozen = true;
    state.chart.hits = [{ name: "b", point: series[0].arr[1] }];
    controls.refresh(series);
    assert.equal(doc.getElementById("curveTooltip").textContent, "2.7");
    assert.ok(doc.getElementById("chartViewStatus").textContent.includes("Frozen"));
    state.hidden.a = true;
    const hiddenRow = doc.createElement("div"),
        hiddenSwatch = doc.createElement("button");
    hiddenRow.append(hiddenSwatch);
    controls.decorate(hiddenRow, "a", hiddenSwatch);
    assert.equal(hiddenSwatch.getAttribute("aria-pressed"), "false");
    assert.equal(hiddenSwatch.textContent, "");
    assert.equal(hiddenSwatch.style.background, "rgb(128, 128, 128)");
    state.analysis = {};
    state.chart.hits = [];
    state.chart.pointer = null;
    state.compare = false;
    controls.refresh(series);
    assert.ok(doc.getElementById("curveTooltip").classList.contains("hidden"));

    const calls = [];
    const ctx = new Proxy(
        {},
        {
            get: (target, key) =>
                target[key] ||
                (key === "measureText" ? () => ({ width: 50 }) : (...args) => calls.push([key, ...args])),
            set: (target, key, value) => {
                target[key] = value;
                return true;
            }
        }
    );
    const canvas = { clientWidth: 600, clientHeight: 300, width: 0, height: 0 };
    const chartState = {
        x: { min: 0, max: 100 },
        y: { min: 0, max: 4 },
        autoY: false,
        endNames: true,
        cursors: { A: 0, B: 100 },
        pointer: { x: 100, y: 100 }
    };
    const options = {
        canvas,
        ctx,
        chartState,
        series,
        norm: false,
        hasBounds: true,
        pixelRatio: 2,
        style: { fontFamily: "sans-serif", getPropertyValue: () => "" },
        elements: Object.fromEntries(["chartEmpty", "points", "range"].map((id) => [id, doc.getElementById(id)])),
        VP,
        padRange: (a, b) => ({ min: a - 1, max: b + 1 }),
        fmtNum: String,
        colorFor: () => "red",
        styleFor: () => ({ color: "#abcdef", line: "dashed" }),
        inspection: I,
        formatChartTime: String,
        t: String
    };
    paint(options);
    const geometry = chartState.curveGeometry;
    chartState.pointer = { x: geometry.value[0].points[0].x, y: geometry.value[0].points[0].y };
    paint(options);
    assert.equal(chartState.curveGeometry, geometry, "pointer movement reuses geometry");
    assert.deepEqual(
        chartState.hits.map((h) => h.name),
        ["a", "b"]
    );
    assert.ok(!calls.some(([op, text]) => op === "fillText" && text === "a"));
    chartState.cursors = { A: -1, B: 200 };
    paint({ ...options, norm: true });
    paint(options);
    assert.equal(chartState.autoY, false);
    const dense = [
        { x: 0, y: 2 },
        { x: 0.2, y: -10 },
        { x: 0.3, y: 100 },
        { x: 0.4, y: 5 },
        { x: 1, y: 3 }
    ];
    assert.ok(I.envelope(dense).some((p) => p.y === -10));
    assert.ok(I.envelope(dense).some((p) => p.y === 100));
    console.log("Chart controls, accessibility, overlap and envelope tests passed");
} finally {
    dom.window.close();
}
