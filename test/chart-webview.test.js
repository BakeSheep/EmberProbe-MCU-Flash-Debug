"use strict";
// The waveform page: controls, painting and inspection, number bases, viewport arithmetic, and the viewport
// requests it sends for host-held history.
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { create } = require("../src/webview/liveWatch/chartControls");
const { paint } = require("../src/webview/liveWatch/chart");
const I = require("../src/webview/liveWatch/chartInspection");
const { envelopeIndices, jitterBands } = require("../src/webview/liveWatch/chartInspection");
const VP = require("../src/webview/liveWatch/viewport");
const Styles = require("../src/webview/liveWatch/seriesStyles");
const A = require("../src/webview/liveWatch/analysisState");
const { SeriesStyleStore } = require("../src/services/seriesStyleStore");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { fmtExact } = require("../src/webview/valueTree");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { encodeViewport } = require("../src/webview/liveWatch/chartTransport");
const { render } = require("./helpers/render-webview");
const { chartHistoryHost } = require("./helpers/chart-history-host");
const { scenario } = require("./helpers/scenario");

// Toolbar controls, accessibility and overlap
async function controls() {
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
        let tooltipName = "";
        const controls = create({
            document: doc,
            t: (k) => k,
            change: (...args) => actions.push(args),
            get: () => state,
            fmtNum: String,
            tooltipName: (name) => tooltipName || name,
            time: String,
            inspection: I
        });
        const row = doc.createElement("div"),
            swatch = doc.createElement("button");
        row.append(swatch);
        doc.body.append(row);
        controls.decorate(row, "a", swatch);
        controls.refresh(series);
        assert.equal(doc.getElementById("curveTooltip").textContent, "a: 1.5");
        tooltipName = ".value_";
        controls.refresh(series);
        assert.equal(
            doc.getElementById("curveTooltip").textContent,
            ".value_: 1.5",
            "metadata updates refresh unchanged hits"
        );
        tooltipName = "";
        controls.refresh(series);
        assert.ok(row.classList.contains("curve-emphasis"));
        state.chart.pointer = null;
        controls.refresh(series);
        assert.ok(!row.classList.contains("curve-emphasis"), "cached plot hits require an active plot pointer");
        state.chart.hoverName = "a";
        controls.refresh(series);
        assert.ok(row.classList.contains("curve-emphasis"), "card hover still highlights its series");
        state.chart.hoverName = null;
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
        doc.querySelector(".series-appearance select").value = "dotted";
        doc.querySelector(".series-appearance select").dispatchEvent(new dom.window.Event("change"));
        assert.equal(actions.at(-1)[1].style.line, "dotted");
        doc.getElementById("seriesOnly").click();
        assert.deepEqual(actions.at(-1), ["focus", "a"]);
        row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
        doc.getElementById("seriesRemove").click();
        assert.deepEqual(actions.at(-1), ["remove", "a"]);
        row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
        assert.equal(doc.getElementById("seriesClose"), null);
        doc.querySelector('[data-radix="16"]').click();
        assert.deepEqual(actions.at(-1), ["radix", { name: "a", radix: 16 }]);
        assert.equal(doc.querySelector('[data-radix="16"]').getAttribute("aria-pressed"), "true");
        assert.equal(doc.querySelector('[data-radix="10"]').getAttribute("aria-pressed"), "false");
        doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
        assert.ok(doc.querySelector(".series-menu").classList.contains("hidden"));
        assert.equal(doc.activeElement, row);
        row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
        assert.ok(!doc.querySelector(".series-menu").classList.contains("hidden"));
        doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
        row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
        doc.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
        assert.ok(doc.querySelector(".series-menu").classList.contains("hidden"));
        state.watch.push({ name: "object", isComposite: true });
        const compositeRow = doc.createElement("div");
        doc.body.append(compositeRow);
        controls.decorate(compositeRow, "object");
        compositeRow.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
        assert.equal(doc.querySelector(".series-radix"), null);
        assert.ok(doc.getElementById("seriesOnly").hidden);
        assert.equal(doc.activeElement, doc.getElementById("seriesRemove"));
        doc.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));
        doc.getElementById("importSidebar").click();
        assert.deepEqual(actions.at(-1), ["importSidebar"]);
        for (const id of ["showAll", "hideAll", "restoreCurves", "autoY"]) doc.getElementById(id).click();
        state.frozen = true;
        state.chart.hits = [{ name: "b", point: series[0].arr[1] }];
        controls.refresh(series);
        assert.equal(doc.getElementById("curveTooltip").textContent, "b: 2.7");
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
        chartState.pointer = I.pointAt(geometry.value[0], 0);
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
        console.log("Chart controls, accessibility and overlap tests passed");
    } finally {
        dom.window.close();
    }
}

// Curve identity, inspection, snapshots and interaction
async function experience() {
    const record = Object.create(null);
    for (let i = 0; i < 40; i++) assert.ok(Styles.valid(Styles.ensure(record, "v" + i)));
    assert.equal(new Set(Object.values(record).map((s) => s.color)).size, 40);
    const first = record.v0;
    assert.equal(Styles.ensure(record, "v0"), first);
    assert.equal(Styles.valid({ color: "red", line: "solid" }), false);
    assert.equal(Styles.validName("bad\nname"), false);
    assert.equal(Styles.validName(null), false);
    assert.deepEqual(Object.keys(Styles.clean({ a: { color: "bad", line: "solid" } })), []);
    assert.deepEqual(Styles.dash("dotted"), [2, 4]);
    assert.deepEqual(Styles.dash("dashed"), [8, 4]);
    assert.deepEqual(Styles.dash("solid"), []);
    let saved;
    const state = {
        get: () => saved,
        update: async (_key, value) => {
            saved = structuredClone(value);
        }
    };
    const store = new SeriesStyleStore(state);
    await store.initialize([
        [{ name: "a" }, { name: "b" }],
        [{ name: "b" }, { name: "c" }]
    ]);
    assert.equal(store.styles.b.color, Styles.legacyColor(1));
    await store.update("b", { color: "#abcdef", line: "dashed" });
    await Promise.all([store.update("new"), store.update("new2")]);
    assert.equal(new SeriesStyleStore(state).styles.b.color, "#abcdef");
    await store.initialize([[{ name: "ignored" }]]);
    assert.ok(!store.styles.ignored);
    await assert.rejects(store.update("", {}));
    await assert.rejects(store.update("bad", { color: "#000000", line: "bad" }));
    assert.ok(/^#/.test(Styles.legacyColor(20)));

    const series = [
        {
            item: { name: "x" },
            arr: [
                { t: 10, v: 1 },
                { t: 20, v: 2 }
            ]
        },
        { item: { name: "x" }, arr: [{ t: 40, v: 4 }] }
    ];
    const geometry = ["b", "a"].map((name) => ({
        name,
        points: [
            { x: 0, y: 0, raw: series[0].arr[0] },
            { x: 100, y: 100, raw: series[0].arr[1] }
        ]
    }));
    assert.deepEqual(
        I.hit(geometry, { x: 50, y: 50 }).map((h) => h.name),
        ["a", "b"]
    );
    assert.equal(I.hit(geometry, { x: 50, y: 80 }).length, 0);
    assert.deepEqual(I.hit(geometry, null), []);
    assert.equal(I.hit([{ name: "dot", points: [{ x: 0, y: 0, raw: { t: 0, v: 0 } }] }], { x: 3, y: 4 }).length, 1);

    const analysis = A.create();
    const hidden = A.focus(analysis, { z: true }, ["x", "y", "z"], "x");
    A.focus(analysis, hidden, ["x", "y", "z"], "y");
    assert.deepEqual(A.restore(analysis, ["x", "y", "z", "new"]), { x: false, y: false, z: true, new: false });

    const graph = render(getLiveWatchContent({}, "en"));
    try {
        const w = graph.window,
            doc = graph.document,
            host = chartHistoryHost(graph);
        Object.defineProperties(doc.getElementById("chart"), {
            clientWidth: { value: 700 },
            clientHeight: { value: 400 }
        });
        const scalar = (name) => ({ name, address: 0x20000000, size: 4, type: "u32" });
        graph.send({ type: "watchList", items: [scalar("a"), scalar("b"), scalar("c")] });
        host.samples([
            { name: "a", value: 1, t: 1000 },
            { name: "b", value: 2, t: 1000 }
        ]);
        host.samples([
            { name: "a", value: 3, t: 2000 },
            { name: "b", value: 4, t: 2000 }
        ]);
        host.draw(100);
        assert.equal(doc.querySelector(".top .bar"), null, "the redundant chart title row is removed");
        assert.equal(doc.getElementById("sideToggle").previousElementSibling, doc.getElementById("dot"));
        assert.equal(doc.getElementById("langToggle"), null, "the chart has no language toggle");
        const sideToggle = doc.getElementById("sideToggle");
        assert.equal(sideToggle.getAttribute("aria-expanded"), "true");
        sideToggle.click();
        assert.equal(sideToggle.getAttribute("aria-expanded"), "false");
        assert.ok(doc.getElementById("layout").classList.contains("side-collapsed"));
        assert.equal(sideToggle.getAttribute("aria-label"), sideToggle.title);
        sideToggle.click();
        assert.equal(sideToggle.getAttribute("aria-expanded"), "true");
        assert.equal(doc.querySelector(".chart-overview-head"), null);
        assert.equal(
            doc.getElementById("chartAxisStart").closest("#chartTimeline"),
            doc.getElementById("chartTimeline")
        );
        assert.equal(doc.getElementById("chartAxisStart").textContent, "00:00");
        assert.equal(doc.getElementById("chartAxisEnd").textContent, "00:01");
        for (const id of [
            "endNames",
            "compareValues",
            "measureCurves",
            "fitY",
            "followLatest",
            "curveReadings",
            "cursorA",
            "cursorB"
        ])
            assert.equal(doc.getElementById(id), null, `removed control: ${id}`);
        assert.ok(doc.querySelector(".side-curve-tools #showAll"));
        assert.ok(doc.querySelector(".side-curve-tools #hideAll"));
        assert.equal(doc.getElementById("autoY").parentNode, doc.getElementById("freeze").parentNode);
        assert.equal(doc.querySelector(".remove").textContent, "×");
        const hitPoint = w.Inspection.pointAt(w.chartState.curveGeometry.value[0], 0);
        w.chartState.hits = [];
        doc.getElementById("chart").dispatchEvent(
            new w.MouseEvent("click", { button: 0, clientX: hitPoint.x, clientY: hitPoint.y })
        );
        host.pump();
        assert.ok(w.eval("state").frozen, "click identifies its own position without waiting for a hover frame");
        w.chartState.pointer = { x: hitPoint.x, y: hitPoint.y };
        host.draw(150);
        assert.equal(doc.getElementById("curveTooltip").textContent, "a: 1");
        const nextPoint = w.Inspection.pointAt(
            w.chartState.curveGeometry.value[0],
            w.chartState.curveGeometry.value[0].raw.length - 1
        );
        w.chartState.pointer = { x: nextPoint.x, y: nextPoint.y };
        host.draw(250);
        assert.equal(doc.getElementById("curveTooltip").textContent, "a: 3", "frozen hover updates at new position");
        const otherPoint = w.Inspection.pointAt(
            w.chartState.curveGeometry.value[1],
            w.chartState.curveGeometry.value[1].raw.length - 1
        );
        w.chartState.pointer = { x: otherPoint.x, y: otherPoint.y };
        host.draw(350);
        assert.equal(doc.getElementById("curveTooltip").textContent, "b: 4", "frozen hover can inspect another series");
        w.resumeChart();
        host.pump();
        const card = doc.querySelector('[data-series-name="b"]');
        w.chartState.pointer = { x: otherPoint.x, y: otherPoint.y };
        w.chartState.hits = [{ name: "b", point: { t: 2000, v: 4 } }];
        card.dispatchEvent(new w.Event("pointerenter"));
        assert.equal(w.chartState.pointer, null, "card hover discards the previous plot pointer");
        assert.equal(w.chartState.hits.length, 0);
        w.draw(360);
        assert.ok(card.classList.contains("curve-emphasis"));
        card.dispatchEvent(new w.Event("pointerleave"));
        w.draw(370);
        assert.equal(doc.querySelector(".curve-emphasis"), null);
        host.samples([{ name: "b", value: 5, t: 2100 }]);
        host.draw(470);
        assert.equal(doc.querySelector(".curve-emphasis"), null, "new samples cannot restore stale card hover");
        const oldColor = w.colorFor("b"),
            count = graph.messages.length;
        doc.querySelector(".swatch").click();
        assert.equal(graph.messages.length, count, "hiding never alters sampling subscription");
        assert.equal(doc.querySelector(".curve-toggle").getAttribute("aria-pressed"), "false");
        doc.querySelector(".var-name").click();
        assert.equal(w.eval("state").hidden.a, false, "clicking the scalar name restores the curve");
        assert.equal(doc.querySelector(".curve-toggle").getAttribute("aria-pressed"), "true");
        const copyCount = graph.messages.length;
        doc.querySelector(".var-value").click();
        assert.equal(graph.messages.length, copyCount + 1);
        assert.equal(graph.messages.at(-1).type, "copyText");
        assert.equal(w.eval("state").hidden.a, false, "copying a value must not toggle its curve");
        w.chartState.autoY = false;
        w.chartState.y = { min: -10, max: 10 };
        w.toggleCurve("b");
        w.draw(200);
        assert.equal(w.chartState.autoY, false);
        assert.equal(w.chartState.y.min, -10);
        w.chartAction("focus", "a");
        w.chartAction("focus", "c");
        w.chartAction("restore");
        assert.equal(w.eval("state").hidden.b, true);
        assert.equal(w.eval("state").hidden.a, false);
        w.chartAction("showAll");
        w.chartAction("hideAll");
        assert.ok(w.eval("state").watch.every((item) => w.eval("state").hidden[item.name]));
        w.chartAction("showAll");
        doc.body.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
        assert.equal(w.eval("state").frozen, false, "Alt no longer freezes the chart");
        w.freezeChart();
        host.pump();
        for (let i = 0; i < 105; i++) host.samples([{ name: "a", value: i, t: 3000 + i }]);
        assert.equal(w.eval("state").latest.a, 104);
        host.draw(480);
        assert.equal(
            w
                .chartData()
                .find((s) => s.item.name === "a")
                .arr.at(-1).v,
            3,
            "a frozen chart keeps drawing its snapshot"
        );
        w.eval("exportDialog").open();
        assert.equal(doc.getElementById("exportSource"), null);
        assert.equal(graph.messages.at(-1).type, "samplingArchiveInfo", "frozen charts export full history");
        graph.send({
            type: "samplingArchiveInfo",
            openExport: true,
            historyRevision: 0,
            variables: ["a"],
            firstTimestampMs: 1000,
            lastTimestampMs: 3104
        });
        w.eval("exportDialog").apply();
        assert.equal(graph.messages.at(-1).type, "exportCsv");
        w.removeVar("a");
        assert.equal(w.colorFor("b"), oldColor);
        w.resumeChart();
        host.pump();
        assert.equal(w.eval("state").frozen, false);
        w.draw(500);
        assert.equal(w.chartState.autoY, false);
        w.clearHistory();
        host.pump();
        host.samples([{ name: "b", value: 1, t: 1000 }]);
        w.clearHistory();
        host.pump();
        host.draw(600);
        assert.ok(doc.getElementById("chartEmpty").textContent.includes("Waiting"));
        graph.send({ type: "watchList", items: [] });
        w.draw(700);
        const symbol = {
            name: "sensor",
            address: 0x20000000,
            size: 4,
            isComposite: true,
            compositeLayout: {
                kind: "struct",
                byteSize: 4,
                members: [{ name: "x", offset: 0, watchType: "u32", byteSize: 4 }]
            }
        };
        w.addSymbol(symbol);
        assert.equal(doc.querySelector(".comp-body .comp-note"), null, "omit the member plotting hint");
        doc.querySelector(".member-name").click();
        host.samples([{ name: "sensor.x", value: 8, t: 1000 }]);
        const before = graph.messages.length;
        doc.querySelector(".member-name").click();
        assert.equal(w.eval("state").hidden["sensor.x"], true);
        assert.equal(graph.messages.length, before);
        assert.ok(w.eval("state").watch.some((v) => v.name === "sensor.x"));
        doc.querySelector(".member-swatch").click();
        doc.querySelector(".member-row[data-series-name]").dispatchEvent(
            new w.MouseEvent("contextmenu", { bubbles: true })
        );
        doc.getElementById("seriesOnly").click();
        assert.equal(w.analysis.focused, "sensor.x");
        w.removeVar("sensor.x");
        assert.equal(w.analysis.focused, null);
        w.addSymbol({
            name: "outer",
            address: 0x20000004,
            size: 4,
            isComposite: true,
            compositeLayout: {
                kind: "struct",
                members: [
                    {
                        name: "inner",
                        offset: 0,
                        compositeLayout: {
                            kind: "struct",
                            members: [{ name: "x", offset: 0, watchType: "u32", byteSize: 4 }]
                        }
                    }
                ]
            }
        });
        doc.querySelector(".comp-nest .comp-head").click();
        assert.ok(doc.querySelector(".comp-nest .comp-members").classList.contains("open"));
        doc.querySelector(".comp-nest .member-name").click();
        assert.ok(doc.querySelector(".comp-nest .comp-members").classList.contains("open"));
        assert.ok(w.eval("state").watch.some((item) => item.name === "outer.inner.x"));
        graph.assertHealthy();
    } finally {
        graph.close();
    }
    const timeline = render(getLiveWatchContent({}, "en"));
    try {
        const w = timeline.window;
        const host = chartHistoryHost(timeline);
        const doc = timeline.document;
        const from = doc.getElementById("chartFromRange");
        const to = doc.getElementById("chartToRange");
        Object.defineProperty(doc.getElementById("chartTimeline"), "clientWidth", { value: 500 });
        timeline.send({ type: "watchList", items: [{ name: "tick", address: 0x20000000, type: "u32", size: 4 }] });
        const origin = 1000000;
        const sample = (time) => host.samples([{ name: "tick", value: time, t: origin + time }]);
        const sync = () => {
            w.syncTimeBounds();
            w.refreshChartTimeline();
        };
        // jsdom does not dispatch pointer events to onpointer* properties like Chromium does.
        const pointer = (element, type) => element["on" + type]({ button: 0, currentTarget: element });
        const input = (element, value) => {
            element.value = String(value);
            element.dispatchEvent(new w.Event("input"));
        };
        sample(0);
        sample(70000);
        sync();
        assert.equal(w.chartState.follow, true);
        pointer(from, "pointerdown");
        sample(71000);
        sync();
        assert.equal(w.chartState.x.min - origin, 40000, "the preset must not move the left edge during its drag");
        assert.equal(w.chartState.x.max - origin, 71000);
        input(from, 20000);
        sample(72000);
        sync();
        assert.equal(w.chartState.x.min - origin, 20000);
        assert.equal(w.chartState.x.max - origin, 72000, "resizing the left edge preserves right-edge attachment");
        assert.equal(w.chartState.follow, true);
        sample(73000);
        pointer(from, "pointercancel");
        assert.equal(w.chartState.endpointDrag, null);
        assert.equal(w.chartState.x.max - origin, 73000, "release includes samples not drawn yet");
        sample(74000);
        sync();
        assert.equal(w.chartState.x.min - origin, 21000, "normal following preserves the resized width after release");
        assert.equal(w.chartState.x.max - origin, 74000);
        pointer(to, "pointerdown");
        input(to, 60000);
        assert.equal(w.chartState.follow, false, "moving the right edge away detaches it");
        sample(75000);
        sync();
        assert.equal(w.chartState.x.max - origin, 60000, "historical ranges must not start following on their own");
        input(to, 74500);
        assert.equal(w.chartState.x.max - origin, 75000, "the right edge snaps within tolerance");
        sample(76000);
        pointer(to, "lostpointercapture");
        assert.equal(w.chartState.endpointDrag, null);
        assert.equal(w.chartState.follow, true);
        assert.equal(
            w.chartState.x.min - origin,
            21000,
            "re-attaching the right edge keeps the left edge fixed during resizing"
        );
        assert.equal(w.chartState.x.max - origin, 76000);
        sync();
        input(from, 80000);
        assert.equal(w.chartState.x.max - w.chartState.x.min, 1, "endpoints cannot cross");
        input(from, 0);
        assert.equal(w.chartState.startPinned, true);
        sample(77000);
        sync();
        assert.equal(w.chartState.x.min - origin, 0);
        assert.equal(w.chartState.x.max - origin, 77000, "both attached edges retain the full range");
        assert.equal(doc.getElementById("chartAxisEnd").textContent, "01:17");
        timeline.assertHealthy();
    } finally {
        timeline.close();
    }
    console.log("Chart identity, inspection, snapshot and interaction tests passed");
}

// Jitter bands and envelopes
async function jitter() {
    function columns(values) {
        const xs = [],
            ys = [],
            raw = [];
        values.forEach((column, x) =>
            column.forEach((y, i) => {
                xs.push(x + (i + 0.5) / column.length);
                ys.push(y);
                raw.push({ t: xs.length, v: y === null ? null : -y });
            })
        );
        return { xs, ys, raw };
    }

    // Three reversing columns form one band; the line crosses each once on the smoothed midpoint.
    {
        const { xs, ys, raw } = columns([
            [0, 10, -10, 0],
            [0, 12, -8, 2],
            [1, 9, -9, 0],
            [0, 1]
        ]);
        const banded = jitterBands(xs, ys, raw);
        assert.equal(banded.bands.length, 1);
        assert.deepStrictEqual([...banded.bands[0].xs], [0.5, 1.5, 2.5]);
        assert.deepStrictEqual([...banded.bands[0].top], [-10, -8, -9]);
        assert.deepStrictEqual([...banded.bands[0].bottom], [10, 12, 9]);
        assert.deepStrictEqual([...banded.ys], [2 / 3, 2 / 3, 2 / 3, 0, 1], "midpoints are smoothed along the band");
        assert.deepStrictEqual([...jitterBands(xs, ys, raw, 3, 0).ys], [0, 2, 0, 0, 1]);
        assert.deepStrictEqual([...banded.xs].slice(0, 3), [0.5, 1.5, 2.5]);
    }

    // Jitter that only reverses across column edges is still banded.
    {
        const { xs, ys, raw } = columns([
            [-10, 10],
            [-10, 10],
            [-10, 10],
            [-10, 10]
        ]);
        const banded = jitterBands(xs, ys, raw);
        assert.equal(banded.bands.length, 1);
        assert.equal(banded.bands[0].xs.length, 4);
        assert.deepStrictEqual([...banded.ys], [0, 0, 0, 0]);

        // A calm column inside the noise joins the band instead of splitting it.
        const bridged = columns([
            [-10, 10],
            [-10, 10],
            [0, 0.5],
            [-10, 10],
            [-10, 10]
        ]);
        const joined = jitterBands(bridged.xs, bridged.ys, bridged.raw);
        assert.equal(joined.bands.length, 1);
        assert.equal(joined.bands[0].xs.length, 5);
        assert.equal(joined.xs.length, 5);
    }

    // Short noisy runs, monotonic steep edges and sub-2px wiggles keep the exact envelope.
    {
        const { xs, ys, raw } = columns([
            [0, 20, -20, 0],
            [0, 15, -15, 0],
            [0, 40, 80, 120],
            [120, 121, 120.5],
            [130, 140, 150]
        ]);
        const banded = jitterBands(xs, ys, raw);
        assert.deepStrictEqual(banded.bands, []);
        const exact = [...envelopeIndices(xs, ys, raw)];
        assert.deepStrictEqual(
            [...banded.xs],
            exact.map((i) => xs[i])
        );
        assert.deepStrictEqual(
            [...banded.ys],
            exact.map((i) => ys[i])
        );
    }

    // Failed samples split both the line and the band runs.
    {
        const noisy = [0, 9, -9, 0];
        const { xs, ys, raw } = columns([noisy, noisy, noisy, [null], noisy, noisy, noisy]);
        const banded = jitterBands(xs, ys, raw);
        assert.equal(banded.bands.length, 2);
        assert.equal(banded.ys.filter(Number.isNaN).length, 1);
        assert.deepStrictEqual(jitterBands([], [], []), { xs: new Float64Array(), ys: new Float64Array(), bands: [] });
    }

    // Painting: banded curves fill a translucent band and keep the configured dash on the trend line.
    {
        const dom = new JSDOM('<div id="chartEmpty"></div><span id="points"></span><span id="range"></span>');
        const calls = [];
        const ctx = new Proxy(
            {},
            {
                get: (target, key) =>
                    key in target
                        ? target[key]
                        : key === "measureText"
                          ? () => ({ width: 40 })
                          : (...args) => {
                                for (const value of args)
                                    if (typeof value === "number")
                                        assert.ok(Number.isFinite(value), key + " received non-finite coordinate");
                                calls.push([key, ctx.globalAlpha, ...args]);
                            },
                set: (target, key, value) => {
                    target[key] = value;
                    return true;
                }
            }
        );
        const arr = Array.from({ length: 4000 }, (_, i) => ({ t: i, v: i % 2 ? 1 : -1 }));
        arr[3000] = { t: 3000, v: null };
        const state = { x: { min: 0, max: 3999 }, y: { min: -2, max: 2 }, autoY: false };
        const options = {
            canvas: { clientWidth: 600, clientHeight: 300 },
            ctx,
            chartState: state,
            norm: false,
            series: [{ item: { name: "imu" }, idx: 0, arr }],
            hasBounds: true,
            pixelRatio: 1,
            style: { fontFamily: "sans-serif", getPropertyValue: () => "" },
            elements: Object.fromEntries(
                ["chartEmpty", "points", "range"].map((id) => [id, dom.window.document.getElementById(id)])
            ),
            VP,
            padRange: (min, max) => ({ min: min - 1, max: max + 1 }),
            fmtNum: String,
            colorFor: () => "red",
            styleFor: () => ({ color: "red", line: "dashed" }),
            formatChartTime: String,
            t: (key) => key
        };
        paint({ ...options, jitterBands: true });
        const curve = state.curveGeometry.value[0];
        assert.ok(curve.banded && !curve.drawing);
        assert.ok(curve.banded.bands.length >= 2, "the null sample splits the band");
        const fills = calls.filter(([op, alpha]) => op === "fill" && alpha < 1);
        assert.equal(fills.length, curve.banded.bands.length);
        assert.ok(calls.some(([op, , dash]) => op === "setLineDash" && dash.length === 2));
        const lineTos = calls.filter(([op]) => op === "lineTo").length;
        assert.ok(
            calls.some(([op]) => op === "arc"),
            "latest sample keeps its marker"
        );

        calls.length = 0;
        paint({ ...options, jitterBands: false });
        assert.ok(state.curveGeometry.value[0].drawing, "turning the option off rebuilds the plain envelope");
        assert.ok(!calls.some(([op, alpha]) => op === "fill" && alpha < 1));
        assert.ok(calls.filter(([op]) => op === "lineTo").length > lineTos);

        // Scrolling epoch timestamps by fractional pixels, or growing the span as "All" does on every commit, must not
        // regroup columns, or spikes flicker between band and line.
        const epoch = 1.8e12;
        const spiky = Array.from({ length: 400 }, (_, i) => ({
            t: epoch + 1000 + i * 5.3,
            v: i % 23 ? Math.sin(i * 1.9) * 0.3 + ((i * 7) % 11) / 20 : -3
        }));
        function bandedAt(shift, grow = 0) {
            const min = epoch + shift,
                shifted = { x: { min, max: min + 3999 + grow }, y: { min: -4, max: 2 }, autoY: false };
            paint({
                ...options,
                chartState: shifted,
                jitterBands: true,
                series: [{ item: { name: "imu" }, idx: 0, arr: spiky }]
            });
            const { ys, bands } = shifted.curveGeometry.value[0].banded;
            return JSON.stringify([bands.map((band) => [...band.top, ...band.bottom]), [...ys]]);
        }
        const anchored = bandedAt(0);
        for (let k = 1; k < 20; k++) assert.equal(bandedAt(k * 0.37), anchored, "scroll offset " + k * 0.37);
        // 3999-4799 ms over 518 px stays within one power-of-two bin size (8 ms).
        for (let grow = 40; grow <= 800; grow += 40) assert.equal(bandedAt(0, grow), anchored, "span growth " + grow);
    }

    // Toolbar: the gear ends the toolbar, opens a popover and persists the option.
    {
        const page = render(getLiveWatchContent({}, "zh"));
        try {
            const doc = page.document,
                toggle = doc.getElementById("chartSettingsToggle"),
                popup = doc.getElementById("chartSettingsPopup"),
                option = doc.getElementById("jitterBands");
            assert.equal(doc.getElementById("chartSettings").nextElementSibling, null);
            assert.equal(toggle.textContent.trim(), "", "icon-only button");
            assert.equal(toggle.getAttribute("aria-label"), "绘图设置");
            assert.ok(popup.hidden && option.checked, "optimisation defaults on");
            toggle.click();
            assert.ok(!popup.hidden);
            assert.equal(toggle.getAttribute("aria-expanded"), "true");
            option.checked = false;
            option.dispatchEvent(new page.window.Event("change"));
            assert.equal(page.getState().jitterBands, false);
            doc.body.dispatchEvent(new page.window.Event("pointerdown", { bubbles: true }));
            assert.ok(popup.hidden);
            toggle.click();
            doc.getElementById("chartSettings").dispatchEvent(
                new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
            );
            assert.ok(popup.hidden);
            page.assertHealthy();
        } finally {
            page.close();
        }
        const restored = render(getLiveWatchContent({}, "en"), { jitterBands: false });
        try {
            assert.equal(restored.document.getElementById("jitterBands").checked, false);
            assert.equal(restored.document.getElementById("chartSettingsToggle").title, "Chart settings");
            restored.assertHealthy();
        } finally {
            restored.close();
        }
    }
}

// Per-variable number bases, exact values and persistence
async function numberBases() {
    const html = getLiveWatchContent({}, "en");
    const graph = render(html);
    try {
        const w = graph.window;
        const doc = graph.document;
        const scalar = (name, type = "u32") => ({ name, type, address: 0x20000000, size: 4 });
        const items = [scalar("a"), scalar("b"), scalar("fraction", "f32"), scalar("wide", "u64")];
        graph.send({ type: "watchList", items });
        const samples = [
            { name: "a", value: 26, t: 1000 },
            { name: "b", value: 26, t: 1000 },
            { name: "fraction", value: 1.5, t: 1000 },
            { name: "wide", value: Number("18446744073709551615"), valueText: "18446744073709551615", t: 1000 }
        ];
        graph.send({ type: "chartValues", samples });
        w.updateValues();
        const value = (name) => doc.querySelector(`[data-series-name="${name}"] .var-value`).textContent;
        const open = (name) => {
            doc.querySelector(`[data-series-name="${name}"]`).dispatchEvent(
                new w.MouseEvent("contextmenu", { bubbles: true })
            );
        };
        const base = (radix) => doc.querySelector(`[data-radix="${radix}"]`).click();
        const messageCount = graph.messages.length;
        w.chartState.hits = samples.slice(0, 2).map((sample) => ({ name: sample.name, point: { v: sample.value } }));
        w.controls.refresh();
        open("a");
        base(16);
        w.controls.refresh();
        assert.equal(value("a"), "0x1A");
        assert.equal(value("b"), "26", "changing a never changes b");
        assert.deepEqual(
            [...doc.querySelectorAll(".curve-hit")].map((row) => row.textContent),
            ["a: 0x1A", "b: 26"],
            "unchanged hover hits refresh with each variable's own base"
        );
        assert.equal(graph.messages.length, messageCount, "base selection stays in the current webview");
        open("b");
        assert.equal(doc.querySelector('[data-radix="10"]').getAttribute("aria-pressed"), "true");
        base(2);
        assert.equal(value("b"), "0b11010");
        assert.equal(value("a"), "0x1A");
        open("fraction");
        base(16);
        assert.equal(value("fraction"), "0x1.8");
        base(2);
        assert.equal(value("fraction"), "0b1.1");
        open("wide");
        base(16);
        assert.equal(value("wide"), "0xFFFFFFFFFFFFFFFF", "64-bit values retain exact digits");
        base(2);
        assert.equal(value("wide"), "0b" + "1".repeat(64));
        assert.equal(fmtExact(-26, null, null, 16), "-0x1A");
        assert.equal(fmtExact(null, null, null, 16), "—");
        assert.equal(fmtExact(null, "unavailable", null, 16), "unavailable");
        assert.equal(fmtExact(NaN, null, null, 16), "—");
        assert.equal(fmtExact(26, null, "ENUM_LABEL", 16), "0x1A");
        const saved = graph.getState();
        for (const [name, radix] of [
            ["a", 8],
            ["a", "16"],
            ["missing", 16]
        ])
            w.chartAction("radix", { name, radix });
        assert.deepEqual(graph.getState().numberBases, saved.numberBases);
        const restored = render(html, saved);
        try {
            restored.send({ type: "watchList", items });
            restored.send({ type: "chartValues", samples });
            restored.window.updateValues();
            assert.equal(restored.document.querySelector('[data-series-name="a"] .var-value').textContent, "0x1A");
        } finally {
            restored.close();
        }
        open("a");
        base(10);
        assert.equal(value("a"), "26");
        assert.equal(value("b"), "0b11010");
        w.removeVar("b");
        assert.equal(graph.getState().numberBases.b, undefined);
        graph.assertHealthy();
    } finally {
        graph.close();
    }
    const members = ["roll", "pitch"].map((name, index) => ({
        name,
        offset: index * 4,
        watchType: "f32",
        byteSize: 4,
        value: 1.5
    }));
    const nested = render(html);
    try {
        nested.send({
            type: "watchList",
            items: [
                {
                    name: "imu.angle",
                    address: 0x20000000,
                    isComposite: true,
                    compositeLayout: { kind: "struct", byteSize: 8, members }
                },
                { name: "imu.angle.roll", address: 0x20000000, type: "f32", size: 4 }
            ]
        });
        nested.send({ type: "liveCompositeSample", samples: [{ name: "imu.angle", tree: { members }, t: 1000 }] });
        nested.window.updateValues();
        const row = nested.document.querySelector('[data-series-name="imu.angle.roll"]');
        row.dispatchEvent(new nested.window.MouseEvent("contextmenu", { bubbles: true }));
        nested.document.querySelector('[data-radix="16"]').click();
        assert.equal(row.querySelector(".member-value").textContent, "0x1.8");
        const values = [...nested.document.querySelectorAll(".member-value")].map((cell) => cell.textContent);
        assert.deepEqual(values, ["0x1.8", "1.5"], "a member preference does not affect its siblings");
        nested.window.chartAction("radix", { name: "imu.angle", radix: 16 });
        assert.equal(nested.getState().numberBases["imu.angle"], undefined, "composites reject base changes");
        nested.window.removeVar("imu.angle");
        assert.deepEqual(nested.getState().numberBases, {}, "removing a parent clears descendant preferences");
        nested.assertHealthy();
    } finally {
        nested.close();
    }
    console.log("Per-variable waveform number bases, exact values and persistence tests passed");
}

// Rendering, viewport and empty states
async function presentation() {
    const dom = new JSDOM('<div id="chartEmpty"></div><span id="points"></span><span id="range"></span>');
    try {
        const calls = [];
        const ctx = new Proxy(
            {},
            {
                get: (target, key) =>
                    target[key] ||
                    (key === "measureText"
                        ? () => ({ width: 40 })
                        : (...args) => {
                              for (const value of args)
                                  if (typeof value === "number")
                                      assert.ok(Number.isFinite(value), key + " received non-finite coordinate");
                              calls.push([key, ...args]);
                          }),
                set: (target, key, value) => {
                    target[key] = value;
                    return true;
                }
            }
        );
        const canvas = { clientWidth: 600, clientHeight: 300, width: 0, height: 0 };
        const elements = Object.fromEntries(
            ["chartEmpty", "points", "range"].map((id) => [id, dom.window.document.getElementById(id)])
        );
        const state = { x: { min: 100, max: 200 }, y: { min: 0, max: 10 }, autoY: true, pointer: { x: 150, y: 100 } };
        const options = {
            canvas,
            ctx,
            chartState: state,
            norm: false,
            series: [
                {
                    item: { name: "tick" },
                    idx: 0,
                    arr: [
                        { t: 90, v: 1 },
                        { t: 100, v: 2 },
                        { t: 150, v: 4 },
                        { t: 210, v: 7 }
                    ]
                }
            ],
            hasBounds: true,
            pixelRatio: 2,
            style: { fontFamily: "sans-serif", getPropertyValue: () => "" },
            elements,
            VP,
            padRange: (min, max) => ({ min: min - 1, max: max + 1 }),
            fmtNum: String,
            colorFor: () => "red",
            formatChartTime: String,
            t: (key, params) => key + (params?.n ?? "")
        };
        paint(options);
        assert.strictEqual(canvas.width, 1200);
        assert.strictEqual(canvas.height, 600);
        assert.strictEqual(elements.points.textContent, "lw.points2");
        assert.ok(elements.chartEmpty.classList.contains("hidden"));
        assert.ok(calls.some(([op]) => op === "arc"));
        assert.ok(calls.some(([op]) => op === "setLineDash"));
        paint({ ...options, norm: true });
        assert.strictEqual(elements.range.textContent, "lw.normalized");
        state.pointer = { x: -1, y: -1 };
        state.autoY = false;
        paint(options);
        paint({ ...options, hasBounds: false });
        assert.strictEqual(elements.points.textContent, "lw.points0");
        paint({ ...options, series: [] });
        assert.strictEqual(elements.chartEmpty.classList.contains("hidden"), false);
        state.x = { min: 1000, max: 2000 };
        paint(options);
        assert.strictEqual(elements.range.textContent, "-");
        paint({ ...options, canvas: { clientWidth: 0, clientHeight: 0 } });

        for (const base of [9007199254740992n, -9223372036854775808n, 18446744073709551614n]) {
            const exact = [base, base + 1n];
            const arr = exact.map((v, i) => ({ t: 100 + i * 100, v: Number(v), valueText: String(v) }));
            state.x = { min: 100, max: 200 };
            state.autoY = true;
            calls.length = 0;
            paint({ ...options, series: [{ item: { name: "wide" }, idx: 0, arr }] });
            assert.equal(state.y.max - state.y.min, 3, "adjacent integers must remain one unit apart before padding");
            assert.ok(elements.range.textContent.includes(String(base - 1n)), "axis retains the exact large baseline");
            assert.ok(elements.range.textContent.includes(String(base + 2n)));
            assert.deepStrictEqual(
                arr.map((p) => p.valueText),
                exact.map(String),
                "drawing must not mutate CSV history"
            );
            const point = calls.find(([op]) => op === "arc");
            assert.ok(point, "large integers still produce drawable coordinates");
            paint({
                ...options,
                series: [
                    {
                        item: { name: "wide" },
                        idx: 0,
                        arr: [{ t: 0, v: Number(-base), valueText: String(-base) }, ...arr]
                    }
                ]
            });
            assert.equal(state.y.max - state.y.min, 3, "offscreen history must not erase visible one-unit changes");
            state.autoY = true;
            paint({
                ...options,
                padRange: (min, max) => ({ min: min - 0.08, max: max + 0.08 }),
                series: [{ item: { name: "wide" }, idx: 0, arr }]
            });
            const expectedMin = base > 0n ? String(base - 1n) + ".92" : String(base) + ".08";
            assert.ok(elements.range.textContent.startsWith(expectedMin), "fractional ticks retain the exact baseline");
            paint({ ...options, norm: true, series: [{ item: { name: "wide" }, idx: 0, arr }] });
            assert.equal(elements.range.textContent, "lw.normalized");
        }
    } finally {
        dom.window.close();
    }
    console.log("Chart rendering, viewport and empty-state tests passed");
}

// Translation geometry, exact axes, gaps, smooth follow and adaptive frame cadence
async function smoothRender() {
    function geometryScenario(run) {
        const page = render('<div id="chartEmpty"></div><span id="points"></span><span id="range"></span>');
        const calls = [];
        const ctx = new Proxy(
            {},
            {
                get(target, key) {
                    if (key in target) return target[key];
                    if (key === "measureText") return (text) => ({ width: String(text).length * 7 });
                    return (...args) => calls.push([key, ...args]);
                }
            }
        );
        const state = { x: { min: 100, max: 200 }, y: { min: 0, max: 20 }, autoY: false };
        const series = [
            {
                item: { name: "a" },
                idx: 0,
                arr: Array.from({ length: 301 }, (_, t) => ({ t, v: 10 + Math.sin(t / 10) }))
            }
        ];
        const options = {
            canvas: { clientWidth: 800, clientHeight: 400 },
            ctx,
            chartState: state,
            series,
            norm: false,
            hasBounds: true,
            pixelRatio: 1,
            style: { fontFamily: "sans-serif", getPropertyValue: () => "" },
            elements: Object.fromEntries(
                ["chartEmpty", "points", "range"].map((id) => [id, page.document.getElementById(id)])
            ),
            VP,
            padRange: (min, max) => ({ min: min - 1, max: max + 1 }),
            fmtNum: String,
            colorFor: () => "red",
            inspection: I,
            formatChartTime: String,
            t: String
        };
        function draw() {
            calls.length = 0;
            paint(options);
            return state.curveGeometry;
        }
        try {
            run({ state, series, options, calls, draw });
        } finally {
            page.close();
        }
    }

    geometryScenario(({ state, series, options, calls, draw }) => {
        const original = draw(),
            prepared = state.prepared;
        const curve = original.value[0],
            index = curve.raw.indexOf(series[0].arr[150]);
        assert.ok(curve.xs instanceof Float64Array && curve.ys instanceof Float64Array);
        assert.ok(curve.drawing instanceof Uint32Array);
        assert.strictEqual(curve.raw[index], series[0].arr[150]);
        const before = I.pointAt(curve, index);
        const oldDot = calls.find(([op]) => op === "arc");
        state.x = { min: 110, max: 210 };
        assert.strictEqual(draw(), original, "a translation inside the margin reuses geometry");
        assert.strictEqual(state.prepared, prepared, "panning reuses integer preparation");
        const after = I.pointAt(curve, index);
        assert.ok(Math.abs(after.x - before.x + state.geometry.pw / 10) < 1e-9);
        assert.strictEqual(after.y, before.y);
        const dot = calls.find(([op]) => op === "arc");
        assert.strictEqual(dot[1], oldDot[1], "the last visible sample stays at the right edge");
        assert.strictEqual(dot[2], I.pointAt(curve, curve.raw.indexOf(series[0].arr[210])).y);
        const cachedHit = I.hit(original.value, after)[0];
        state.curveGeometry = null;
        const fresh = draw();
        assert.strictEqual(I.hit(fresh.value, after)[0].point, cachedHit.point);
        assert.strictEqual(cachedHit.point, series[0].arr[150]);
        state.y = { min: 1, max: 21 };
        assert.strictEqual(draw(), fresh, "pure y translation reuses geometry");
        state.y.max++;
        const scaled = draw();
        assert.notStrictEqual(scaled, fresh, "changing the y span rebuilds");
        state.x.max++;
        assert.notStrictEqual(draw(), scaled, "zoom rebuilds");
        const zoomed = state.curveGeometry;
        options.pixelRatio = 2;
        assert.notStrictEqual(draw(), zoomed, "DPR changes rebuild");
        const resized = state.curveGeometry;
        state.x = { min: 250, max: 351 };
        assert.notStrictEqual(draw(), resized, "leaving the built window rebuilds");
    });

    geometryScenario(({ state, series, calls, draw }) => {
        series[0].arr = [100, 120, 140, 150, 160, 180, 200, 220].map((t) => ({ t, v: t === 150 ? null : 10 }));
        series.push({
            item: { name: "a" },
            idx: 0,
            arr: [
                { t: 225, v: 10 },
                { t: 230, v: 11 }
            ]
        });
        const original = draw();
        state.x = { min: 130, max: 230 };
        assert.strictEqual(draw(), original);
        // After clip: one move on either side of the null, then a separate segment's move.
        const clip = calls.findIndex(([op]) => op === "clip");
        const paths = calls.slice(clip + 1).filter(([op]) => op === "moveTo" || op === "lineTo");
        assert.deepStrictEqual(
            paths.map(([op]) => op),
            ["moveTo", "lineTo", "moveTo", "lineTo", "lineTo", "lineTo", "moveTo", "lineTo"]
        );
        const x = state.geometry.padL + state.geometry.pw * 0.2;
        assert.strictEqual(
            I.hit(original.value, { x, y: I.pointAt(original.value[0], 0).y }, 1).length,
            0,
            "missing samples cannot be hit through a bridged segment"
        );
        const dots = calls.filter(([op]) => op === "arc");
        assert.strictEqual(dots.at(-1)[1], state.geometry.padL + state.geometry.pw);
    });

    // Sparse samples (slow probes): while smooth following, the marker rides the drawn line at the right edge instead of
    // sliding left from the last visible sample and snapping back when the next one crosses the trailing edge.
    geometryScenario(({ state, series, options, calls, draw }) => {
        series[0].arr = Array.from({ length: 31 }, (_, i) => ({ t: i * 10, v: i % 2 ? 12 : 8 }));
        const edge = () => state.geometry.padL + state.geometry.pw;
        const dots = [];
        state.smoothFollowing = true;
        for (let max = 200; max <= 210; max += 2.5) {
            state.x = { min: max - 100, max };
            draw();
            const dot = calls.find(([op]) => op === "arc");
            assert.ok(Math.abs(dot[1] - edge()) < 1e-9, "the following marker stays on the right edge");
            dots.push(dot[2]);
        }
        const y = (v) => state.geometry.padT + ((state.y.max - v) * state.geometry.ph) / 20;
        assert.ok(
            Math.abs(dots[0] - y(8)) < 1e-9 && Math.abs(dots[2] - y(10)) < 1e-9 && Math.abs(dots[4] - y(12)) < 1e-9
        );
        options.jitterBands = true;
        state.x = { min: 105, max: 205 };
        draw();
        assert.ok(Math.abs(calls.find(([op]) => op === "arc")[1] - edge()) < 1e-9, "banded curves pin the marker too");
        options.jitterBands = false;
        state.smoothFollowing = false;
        draw();
        const dot = calls.find(([op]) => op === "arc");
        assert.ok(dot[1] < edge() - 1, "static views keep the marker on the last visible sample");
    });

    geometryScenario(({ state, series, options, draw }) => {
        const base = 18446744073709551000n;
        series[0].arr = Array.from({ length: 301 }, (_, t) => ({
            t,
            v: t === 150 ? null : Number(base + BigInt(t)),
            valueText: t === 150 ? null : String(base + BigInt(t))
        }));
        state.autoY = true;
        const original = draw(),
            prepared = state.prepared;
        assert.strictEqual(options.elements.range.textContent, `${base + 99n} ～ ${base + 201n}`);
        state.x = { min: 110, max: 210 };
        assert.strictEqual(draw(), original, "autoY translation with unchanged span reuses geometry");
        assert.strictEqual(state.prepared, prepared);
        assert.strictEqual(options.elements.range.textContent, `${base + 109n} ～ ${base + 211n}`);
    });

    function followScenario(run, reduced = false) {
        let now = 10000,
            callback,
            drawCost = 0,
            paints = 0;
        const page = render(
            getLiveWatchContent({}, "en"),
            {},
            {
                beforeParse(w) {
                    w.performance.now = () => now;
                    w.requestAnimationFrame = (fn) => {
                        callback = fn;
                        return 1;
                    };
                    w.matchMedia = () => ({ matches: reduced });
                }
            }
        );
        const w = page.window;
        Object.defineProperties(w.canvas, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
        // Timeline snapping tolerance is 8 track pixels; give the track a realistic width.
        Object.defineProperty(w.document.getElementById("chartTimeline"), "clientWidth", { value: 800 });
        page.send({ type: "watchList", items: [{ name: "a", type: "f32", address: 0x20000000 }] });
        const origin = 1700000000000;
        let dataMax = origin + 100000;
        function status() {
            page.send({
                type: "chartHistoryStatus",
                historyRevision: w.historyRevision,
                revision: dataMax,
                bounds: { min: origin, max: dataMax }
            });
        }
        status();
        w.syncTimeBounds();
        w.applyWindowPreset("10");
        const originalPaint = w.EmberProbeChart.paint;
        w.EmberProbeChart.paint = (options) => {
            paints++;
            originalPaint(options);
            now += drawCost;
        };
        function frame(ms = 16) {
            now += ms;
            callback(now);
        }
        function answer() {
            const request = w.eval("state").remoteHistory.inFlight;
            assert.ok(request);
            page.send({
                type: "chartViewportResult",
                requestId: request.requestId,
                historyRevision: w.historyRevision,
                revision: dataMax,
                bounds: { min: origin, max: dataMax },
                series: [
                    {
                        name: "a",
                        arr: Array.from({ length: 801 }, (_, i) => ({
                            t: dataMax - 16000 + i * 20,
                            v: Math.sin(i / 20)
                        }))
                    }
                ]
            });
            return request;
        }
        function commit(ms = 80, elapsed = ms) {
            dataMax += ms;
            status();
            frame(elapsed);
            if (w.eval("state").remoteHistory.inFlight?.purpose === "overview") {
                answer();
                frame(80);
            }
            // A new revision's detail is generated by the real P0 request scheduler.
            if (!w.eval("state").remoteHistory.inFlight) {
                w.requestChartViewport(w.chartState.x, 800);
            }
            assert.strictEqual(w.eval("state").remoteHistory.inFlight?.purpose, "detail");
            answer();
        }
        // Seed the initial atomic view before starting, so the first live commit has an existing display edge.
        frame(80);
        answer();
        frame(80);
        if (w.eval("state").remoteHistory.inFlight) answer();
        w.running = true;
        try {
            run({
                w,
                page,
                frame,
                answer,
                commit,
                status,
                advanceData: (ms) => {
                    dataMax += ms;
                    status();
                },
                origin,
                get now() {
                    return now;
                },
                get max() {
                    return dataMax;
                },
                get paints() {
                    return paints;
                },
                cost: (ms) => {
                    drawCost = ms;
                }
            });
            page.assertHealthy();
        } finally {
            page.close();
        }
    }

    followScenario((h) => {
        const { w, frame, commit } = h;
        commit();
        frame();
        let previous = w.chartState.x.max;
        for (let batch = 0; batch < 5; batch++) {
            const geometry = w.chartState.curveGeometry,
                stats = w.chartState.rangeStats;
            for (let f = 0; f < 4; f++) {
                frame();
                assert.ok(w.chartState.x.max > previous, "each rendered frame moves forward");
                assert.ok(w.chartState.x.max <= h.max, "the display never runs ahead of committed data");
                assert.strictEqual(w.chartState.curveGeometry, geometry);
                assert.strictEqual(w.chartState.rangeStats, stats, "autoY is held between commits");
                previous = w.chartState.x.max;
            }
            commit(80, 16);
            assert.ok(w.chartState.x.max >= previous, "atomic commits do not rewind the display");
            frame();
            assert.notStrictEqual(w.chartState.rangeStats, stats, "new detail commits refresh autoY statistics");
            previous = w.chartState.x.max;
        }
        for (let f = 0; f < 40; f++) frame();
        assert.strictEqual(w.chartState.x.max, h.max, "stalled data stops exactly at the committed maximum");
        w.chartState.follow = false;
        frame();
        assert.strictEqual(w.chartState.followClock, null);
    });

    for (const disable of [
        (w) => w.freezeChart(),
        (w) => w.applyWindowPreset("0"),
        (w) => {
            w.chartState.drag = {};
        },
        (w) => {
            w.chartState.endpointDrag = {};
        },
        (w) => {
            w.chartState.timelineDrag = true;
        },
        (w) => {
            w.running = false;
        },
        (w) => {
            w.historyRevision++;
        },
        (w) => w.clearHistory(),
        (w) => w.resumeChart(),
        (w) => w.applyWindowPreset("30")
    ])
        followScenario(({ w, commit, frame }) => {
            commit();
            assert.ok(w.chartState.followClock);
            disable(w);
            frame();
            assert.strictEqual(w.chartState.followClock, null, "lifecycle changes stop/reset the display clock");
        });

    followScenario(({ w, commit, frame }) => {
        commit();
        frame();
        assert.strictEqual(w.chartState.followClock, null);
        assert.strictEqual(w.chartState.x.max, w.eval("state").remoteHistory.status.bounds.max);
    }, true);

    followScenario(({ w, commit, frame }) => {
        commit();
        frame();
        assert.ok(w.chartState.x.max < w.eval("state").remoteHistory.status.bounds.max);
        w.matchMedia = () => ({ matches: true });
        frame(80);
        assert.strictEqual(w.chartState.followClock, null);
        assert.strictEqual(
            w.chartState.x.max,
            w.eval("state").remoteHistory.status.bounds.max,
            "enabling reduced motion restores atomic step following"
        );
    });

    followScenario(({ w, commit, frame }) => {
        commit();
        w.norm = true;
        frame();
        const stats = w.chartState.rangeStats,
            geometry = w.chartState.curveGeometry;
        frame();
        assert.strictEqual(w.chartState.rangeStats, stats, "normalization ranges are held between commits");
        assert.strictEqual(w.chartState.curveGeometry, geometry);
        w.chartState.followClock = null;
        w.chartState.x = { min: w.chartState.bounds.max - 1000, max: w.chartState.bounds.max };
        w.commitFollowClock({ min: w.chartState.bounds.max - 1000, max: w.chartState.bounds.max });
        assert.strictEqual(w.chartState.followClock.span, 10000, "short initial history preserves the preset duration");
    });

    followScenario((h) => {
        h.commit();
        h.cost(60);
        for (let f = 0; f < 10; f++) h.frame(80);
        assert.ok(h.w.chartState.drawDuration > 40);
        h.cost(0);
        const count = h.paints;
        h.frame(1); // 60 ms of drawing + 1 ms since the last frame start: below the 80 ms cap.
        assert.strictEqual(h.paints, count);
        h.frame(19);
        assert.strictEqual(h.paints, count + 1, "the adaptive interval is capped at 80 ms");
    });

    console.log("Translation geometry, exact axes, gaps, smooth follow lifecycle and adaptive frame cadence passed");

    // Timeline: while smooth following, the selected block stays pinned to the right end and does not saw back and forth
    // between the lagging display clock and stepped detail commits.
    followScenario((h) => {
        const { w, frame, commit } = h;
        const fill = w.document.getElementById("chartRangeFill"),
            to = w.document.getElementById("chartToRange"),
            from = w.document.getElementById("chartFromRange");
        commit();
        frame();
        const lefts = [];
        for (let batch = 0; batch < 4; batch++) {
            for (let f = 0; f < 4; f++) {
                frame();
                const right = parseFloat(fill.style.left) + parseFloat(fill.style.width);
                assert.ok(Math.abs(right - 100) < 1e-9, `the block's right edge stays at the end (${right})`);
                assert.strictEqual(to.value, to.max, "the right handle stays at the end");
                lefts.push(Number(from.max) - Number(from.value));
            }
            commit(80, 16);
        }
        // The left handle keeps a constant distance from the right end (one span).
        assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 1, "the left handle moves with the right end");
    });

    // Dragging the left handle while the right end is snapped keeps the right end attached, also as new data arrives.
    followScenario((h) => {
        const { w, frame, commit } = h;
        const from = w.document.getElementById("chartFromRange");
        commit();
        frame();
        assert.ok(w.chartState.x.max < w.chartState.bounds.max);
        w.beginTimelineEndpoint("min", { button: 0, currentTarget: from });
        from.value = String(Number(from.value) - 2000);
        w.updateTimelineEndpoint("min");
        assert.strictEqual(w.chartState.follow, true, "the snapped right end stays attached");
        assert.strictEqual(w.chartState.x.max, w.chartState.bounds.max);
        h.advanceData(500);
        const newer = h.max;
        frame(80);
        assert.strictEqual(w.chartState.bounds.max, newer);
        assert.strictEqual(w.chartState.x.max, newer, "the attached end follows new data while dragging");
        w.endTimelineEndpoint();
        assert.strictEqual(w.chartState.follow, true, "releasing the left handle keeps following");
        for (let f = 0; f < 3; f++) commit(80, 80);
        frame();
        assert.ok(w.chartState.followClock, "smooth following resumes after the drag");
    });

    // Keyboard changes of the left handle (no pointerdown) also keep the right end attached.
    followScenario((h) => {
        const { w, frame, commit } = h;
        const from = w.document.getElementById("chartFromRange");
        commit();
        frame();
        from.value = String(Number(from.value) - 1000);
        w.updateTimelineEndpoint("min");
        assert.strictEqual(w.chartState.follow, true);
        assert.strictEqual(w.chartState.x.max, w.chartState.bounds.max);
    });

    // Starting any interaction from the lagging display first settles on the data edge, so follow detection is exact:
    // a vertical-only pan or zoom anchored at the right end keeps following, like before smooth scrolling.
    followScenario((h) => {
        const { w, frame, commit } = h;
        commit();
        frame();
        assert.ok(w.chartState.x.max < w.chartState.bounds.max);
        const span = w.chartState.x.max - w.chartState.x.min;
        w.settleFollowView();
        assert.strictEqual(w.chartState.followClock, null);
        assert.strictEqual(w.chartState.x.max, w.chartState.bounds.max);
        assert.ok(Math.abs(w.chartState.x.max - w.chartState.x.min - span) < 1e-6, "settling keeps the span");
        w.updateFollowFromView(false);
        assert.strictEqual(w.chartState.follow, true);
    });
}

// Viewport arithmetic
async function viewportArithmetic() {
    const viewport = require("../src/webview/liveWatch/viewport");
    function close(actual, expected, message) {
        assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
    }

    const source = { min: 0, max: 100 };
    const anchored = viewport.zoom(source, 0.5, 25, 1);
    close(anchored.min, 12.5, "anchored zoom should preserve the anchor ratio");
    close(anchored.max, 62.5, "anchored zoom should preserve the anchor ratio");
    close((25 - anchored.min) / viewport.span(anchored), 0.25, "anchor should stay at the same screen position");

    const centered = viewport.zoomCentered({ min: -50, max: 50 }, 0.5, 1);
    close(centered.min, -25, "centered zoom should keep the Y center fixed");
    close(centered.max, 25, "centered zoom should keep the Y center fixed");

    assert.deepStrictEqual(
        viewport.panClamped({ min: 20, max: 60 }, 70, { min: 0, max: 100 }, 1),
        { min: 60, max: 100 },
        "panning past the right bound should preserve width"
    );
    assert.deepStrictEqual(
        viewport.clamp({ min: -30, max: 130 }, { min: 0, max: 100 }, 1),
        { min: 0, max: 100 },
        "an oversized range should collapse to all retained data"
    );

    const minimum = viewport.zoom({ min: 0, max: 100 }, 1e-20, 50, 2);
    close(viewport.span(minimum), 2, "zoom should respect the numerical minimum span");
    assert.ok(Number.isFinite(minimum.min) && Number.isFinite(minimum.max), "extreme zoom should remain finite");

    assert.deepStrictEqual(
        viewport.updateEndpoint({ min: 20, max: 80 }, "min", 95, { min: 0, max: 100 }, 5),
        { min: 75, max: 80 },
        "timeline endpoints must not cross"
    );
    assert.deepStrictEqual(
        viewport.updateEndpoint({ min: 20, max: 80 }, "max", 5, { min: 0, max: 100 }, 5),
        { min: 20, max: 25 },
        "timeline endpoints must not cross"
    );

    const percentages = viewport.toPercent({ min: 25, max: 75 }, { min: 0, max: 100 });
    close(percentages.left, 25, "timeline selection should map to the correct offset");
    close(percentages.width, 50, "timeline selection should map to the correct width");

    assert.strictEqual(viewport.isAtEnd({ min: 40, max: 99 }, { min: 0, max: 100 }, 1), true);
    assert.strictEqual(viewport.isAtEnd({ min: 40, max: 95 }, { min: 0, max: 100 }, 1), false);
    assert.deepStrictEqual(
        viewport.followEnd({ min: 60, max: 100 }, { min: 0, max: 100 }, { min: 10, max: 120 }, 1),
        { min: 80, max: 120 },
        "following should preserve width and attach the range to the newest sample"
    );

    console.log("Chart viewport tests passed");
}

// Drag, overscan, overview, atomic follow, revision throttling and memoization
async function viewportRequests() {
    function scenario(run) {
        let now = 10000;
        const page = render(
            getLiveWatchContent({}, "en"),
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
            w.eval("state").dirty = true;
            w.chartState.fastDirty = true;
            w.draw(now);
            const request = w.eval("state").remoteHistory.inFlight;
            if (request && !sent.includes(request)) {
                request.sentAt = w.eval("state").remoteHistory.lastRequest;
                sent.push(request);
            }
            return request;
        }
        function answer(request = w.eval("state").remoteHistory.inFlight, response) {
            assert.ok(request, "a request is in flight");
            const reply =
                response || store.viewport("p", request.names, request.range, request.width, request.snapshotId);
            page.send({
                type: "chartViewportResult",
                ...encodeViewport(reply).message,
                requestId: request.requestId,
                historyRevision: page.messages.find(
                    (m) => m.type === "chartViewport" && m.requestId === request.requestId
                ).historyRevision,
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
                const previous = w.eval("state").remoteHistory.view;
                answer(queued.request);
                if (queued.request.purpose === "detail") {
                    assert.notStrictEqual(
                        w.eval("state").remoteHistory.view,
                        previous,
                        "moving range does not discard a reply"
                    );
                    assert.strictEqual(w.eval("state").remoteHistory.view.range, queued.request.range);
                    accepted++;
                }
                queued = null;
            }
        }
        assert.ok(accepted >= 5, "detail replies are accepted throughout a continuous drag");
        if (queued) answer(queued.request);
        w.chartState.drag = null;
        settle();
        const { view } = w.eval("state").remoteHistory;
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
        assert.deepStrictEqual({ ...w.eval("state").remoteHistory.view.range }, { min: 31000, max: 61000 });
        assert.strictEqual(w.eval("state").remoteHistory.view.width, 2400);
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
        const oldView = w.eval("state").remoteHistory.view;
        w.chartState.x = { min: 43500, max: 48500 };
        const zoom = draw();
        assert.strictEqual(zoom.purpose, "detail");
        assert.ok(
            (zoom.range.max - zoom.range.min) / zoom.width < (oldView.range.max - oldView.range.min) / oldView.width
        );
        answer(zoom);
        w.chartState.x = { min: 1000, max: 101000 };
        const out = draw();
        assert.strictEqual(out.purpose, "detail");
        const current = w.eval("state").remoteHistory.view,
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
        assert.strictEqual(
            w.eval("state").remoteHistory.overview.range,
            overview.range,
            "overview acceptance ignores view movement"
        );
        const parts = series().filter((part) => part.item.name === "a" && !("visibleCount" in part)),
            range = w.eval("state").remoteHistory.view.range,
            source = w.eval("state").remoteHistory.overview.series.find((s) => s.name === "a").arr,
            left = parts.find((part) => part.arr[0].t < range.min),
            right = parts.find((part) => part.arr.at(-1).t > range.max);
        const ends = w.eval("state").remoteHistory.view.series.filter((part) => part.name === "a");
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
        assert.ok(w.eval("state").remoteHistory.pending, "new detail waits behind the in-flight request");
        answer(first);
        assert.strictEqual(
            w.eval("state").remoteHistory.inFlight.purpose,
            "overview",
            "overdue overview precedes pending detail"
        );
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
        assert.strictEqual(w.eval("state").remoteHistory.liveStatus.bounds.max, 101100);
        assert.strictEqual(
            request.revision,
            w.eval("state").remoteHistory.liveStatus.revision,
            "requests use latest live revision"
        );
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
        const receivedAt = w.eval("state").remoteHistory.view.receivedAt,
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
        assert.strictEqual(w.eval("state").remoteHistory.view.receivedAt, receivedAt);
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
        (w) => (w.eval("state").watch[0].type = "u32"),
        (w) => w.eval("state").watch[0].address++,
        (w) => (w.eval("state").watch[0].bitOffset = 1),
        (w) => (w.eval("state").watch[0].bitSize = 2),
        (w) => (w.eval("state").hidden.a = true),
        (w) => (w.eval("state").remoteHistory.snapshotId = "another-snapshot"),
        (w) => w.historyRevision++,
        (w) => w.clearHistory()
    ]) {
        scenario(({ w, draw, answer, store }) => {
            const request = draw(),
                response = store.viewport("p", request.names, request.range, request.width);
            change(w);
            // Deliberately deliver before another draw: acceptance must check the actual current configuration.
            answer(request, response);
            assert.strictEqual(
                w.eval("state").remoteHistory.view,
                null,
                "changed configurations reject delayed detail replies"
            );
        });
        scenario(({ w, draw, answer, store }) => {
            answer(draw());
            const request = draw(),
                response = store.viewport("p", request.names, request.range, request.width);
            assert.strictEqual(request.purpose, "overview");
            change(w);
            answer(request, response);
            assert.strictEqual(
                w.eval("state").remoteHistory.overview,
                null,
                "changed configurations reject delayed overview replies"
            );
        });
    }

    scenario(({ w, settle, series, draw }) => {
        settle();
        w.eval("state").hidden.a = w.eval("state").hidden.b = true;
        assert.strictEqual(series().length, 0);
        assert.strictEqual(w.eval("state").remoteHistory.view, null);
        assert.strictEqual(w.eval("state").remoteHistory.overview, null);
        assert.strictEqual(draw(), null, "empty visible names need no request");
        assert.strictEqual(w.historyLoading.hidden, true);
    });

    scenario(({ w, draw, answer, series, settle }) => {
        settle();
        w.eval("state").remoteHistory.view = null;
        const overview = w.eval("state").remoteHistory.overview;
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
        const request = w.eval("state").remoteHistory.inFlight;
        assert.strictEqual(request.width, 8192);
        assert.ok(request.range.min > w.chartState.x.min - 10000, "overscan shrinks at the column limit");
        assert.strictEqual(w.chartState.x.min - request.range.min, request.range.max - w.chartState.x.max);
        assert.ok((request.range.max - request.range.min) / request.width <= 10000 / 4000);
    });

    scenario(({ w }) => {
        w.chartState.x = { min: 1000, max: 11000 };
        w.requestChartViewport(w.chartState.x, 4000);
        const request = w.eval("state").remoteHistory.inFlight;
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
        assert.strictEqual(w.eval("state").dirty, true, "starting a freeze schedules its loading indicator");
        const operation = w.eval("state").remoteHistory.operation;
        const liveView = w.eval("state").remoteHistory.view;
        page.send({ type: "chartFreezeResult", ...store.freeze("p"), requestId: operation, historyRevision: 0 });
        assert.strictEqual(
            w.eval("state").remoteHistory.view,
            liveView,
            "freezing keeps the drawn view until the snapshot reply"
        );
        assert.ok(series().length > 0, "curves stay visible while the snapshot view loads");
        settle();
        assert.notStrictEqual(w.eval("state").remoteHistory.view, liveView);
        const snapshot = w.eval("state").remoteHistory.status,
            view = w.eval("state").remoteHistory.view;
        append(102000);
        status();
        advance(2000);
        assert.strictEqual(draw(), null, "frozen data never refreshes for live revisions");
        assert.strictEqual(w.eval("state").remoteHistory.status, snapshot);
        assert.strictEqual(w.eval("state").remoteHistory.view, view);
        w.resumeChart();
        assert.strictEqual(
            w.eval("state").remoteHistory.view,
            view,
            "resuming keeps the frozen view until live data arrives"
        );
        assert.ok(series().length > 0);
        const request = draw();
        w.clearHistory();
        answer(request);
        assert.strictEqual(w.eval("state").remoteHistory.view, null);
        assert.strictEqual(w.eval("state").remoteHistory.pending, null);
        assert.strictEqual(w.eval("state").remoteHistory.inFlight, null);
        page.send({ type: "samplingHistoryCleared", historyRevision: w.historyRevision });
        page.send({ type: "chartHistoryReady", historyRevision: w.historyRevision });
        assert.strictEqual(w.eval("state").remoteHistory.status, null);
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
            w.eval("state").remoteHistory.liveStatus = w.eval("state").remoteHistory.status = { revision: 2, bounds };
            w.eval("state").remoteHistory.view = {
                ...w.eval("state").remoteHistory.view,
                range: { ...bounds },
                width: Math.min(8192, width),
                revision: 1,
                receivedAt: w.performance.now()
            };
            w.eval("state").remoteHistory.overview = { ...w.eval("state").remoteHistory.overview, revision: 2 };
            const interval = Math.max(80, span / width);
            advance(interval - 1);
            w.requestChartViewport(w.chartState.x, width);
            assert.strictEqual(
                w.eval("state").remoteHistory.inFlight,
                null,
                "revision-only follow refresh waits for a pixel column"
            );
            advance(1);
            w.requestChartViewport(w.chartState.x, width);
            assert.strictEqual(w.eval("state").remoteHistory.inFlight.purpose, "detail");
            assert.strictEqual(
                w.eval("state").remoteHistory.lastRequest - w.eval("state").remoteHistory.view.receivedAt,
                interval
            );
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
        w.eval("state").hidden.b = true;
        const shown = series();
        assert.ok(shown.length > 0 && shown.every((part) => part.item.name === "a"));
        w.eval("state").hidden.b = false;
        // A changed identity hides stale data for that curve only.
        const index = w.eval("state").watch.findIndex((item) => item.name === "a");
        w.eval("state").watch[index] = { ...w.eval("state").watch[index], type: "u32" };
        const changed = series();
        assert.ok(changed.every((part) => part.item.name === "b"));
        assert.ok(changed.length > 0);
        void items;
    });
}

// Remote viewports, silent history, stale replies, freeze, clear races and raw export
async function remoteHistory() {
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
        w.eval("state").hidden.b = true;
        page.send({ type: "chartValues", samples: [{ name: "b", value: 10000, t: 51000 }] });
        assert.strictEqual(w.eval("state").latest.b, 10000);
        page.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
        function request() {
            w.eval("state").remoteHistory.lastRequest = -Infinity;
            w.eval("state").dirty = true;
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
        assert.ok(w.eval("state").remoteHistory.pending, "one latest pending request replaces intermediate views");
        answer(first);
        assert.strictEqual(w.eval("state").remoteHistory.view, null, "outdated visibility reply cannot restore curves");
        const second = page.messages.filter((message) => message.type === "chartViewport").at(-1);
        assert.deepStrictEqual(second.names, ["a", "b"]);
        answer(second);
        assert.strictEqual(JSON.stringify(w.chartState.x), viewport);
        assert.ok(w.eval("state").remoteHistory.view.series.find((s) => s.name === "b").visibleCount > 5000);
        w.freezeChart();
        const freezeRequest = page.messages.at(-1);
        page.send({
            type: "chartFreezeResult",
            ...store.freeze("p"),
            requestId: freezeRequest.requestId,
            historyRevision: 0
        });
        assert.strictEqual(w.eval("state").frozen, true);
        const bounds = JSON.stringify(w.retainedTimeBounds());
        store.append("p", [{ name: "a", value: 4, t: 100000 }], 100000);
        page.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
        assert.strictEqual(JSON.stringify(w.retainedTimeBounds()), bounds);
        w.eval("exportDialog").open();
        const exportInfo = page.messages.at(-1);
        page.send({
            type: "samplingArchiveInfo",
            openExport: true,
            variables: ["a", "b"],
            firstTimestampMs: 1000,
            lastTimestampMs: 100000,
            historyRevision: 0
        });
        w.eval("exportDialog").apply();
        const exported = page.messages.at(-1);
        assert.strictEqual(exportInfo.type, "samplingArchiveInfo");
        assert.deepStrictEqual(exported.names, ["a", "b"]);
        w.resumeChart();
        const stale = request();
        w.clearHistory();
        answer(stale);
        assert.strictEqual(w.eval("state").remoteHistory.view, null);
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
                if (w.eval("state").remoteHistory.view) w.eval("state").remoteHistory.view.receivedAt = -Infinity;
                w.eval("state").remoteHistory.lastRequest = -Infinity;
                w.eval("state").dirty = true;
                w.draw(2000 + cycle * 200);
                const request = delayed.messages.filter((message) => message.type === "chartViewport").at(-1);
                const purpose = w.eval("state").remoteHistory.inFlight.purpose;
                const response = store.viewport("p", request.names, request.range, request.width);
                store.append("p", [{ name: "value", value: cycle + 3, t: 51000 + cycle * 1000 }], 51000 + cycle * 1000);
                delayed.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
                w.draw(2100 + cycle * 200);
                assert.strictEqual(w.eval("state").remoteHistory.inFlight.requestId, request.requestId);
                delayed.send({
                    type: "chartViewportResult",
                    ...response,
                    requestId: request.requestId,
                    historyRevision: 0
                });
                const accepted = w.eval("state").remoteHistory[purpose === "overview" ? "overview" : "view"];
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
            w.eval("state").watch[0].type = "f32";
        },
        (w) => {
            w.eval("state").watch[0].address++;
        },
        (w) => {
            w.eval("state").hidden.value = true;
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
            changed.send({
                type: "chartHistoryStatus",
                revision: 1,
                bounds: { min: 1000, max: 2000 },
                historyRevision: 0
            });
            w.syncTimeBounds();
            w.chartState.follow = false;
            w.draw(1000);
            const request = changed.messages.filter((message) => message.type === "chartViewport").at(-1);
            change(w);
            w.eval("state").dirty = true;
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
                assert.ok(
                    w.eval("state").remoteHistory.view.series.length,
                    "range changes accept and translate a delayed reply"
                );
                assert.strictEqual(w.chartState.x.min, 1200);
                assert.strictEqual(w.chartState.x.max, 1800);
                w.eval("state").dirty = true;
                w.draw(1200);
                const point = w.Inspection.pointAt(w.chartState.curveGeometry.value[0], 0),
                    geometry = w.chartState.geometry;
                assert.strictEqual(point.raw.t, 1500);
                assert.ok(
                    Math.abs(point.x - geometry.padL - geometry.pw / 2) < 1e-9,
                    "reply is translated to the new viewport"
                );
            } else
                assert.strictEqual(
                    w.eval("state").remoteHistory.view,
                    null,
                    "configuration changes invalidate a delayed reply"
                );
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
        reloaded.send({
            type: "chartHistoryStatus",
            revision: 2,
            historyRevision: 4,
            bounds: { min: 1000, max: 2000 }
        });
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
        w.eval("state").hidden.value = true;
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
            w.eval("state").remoteHistory.lastRequest = -Infinity;
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
        assert.strictEqual(w.eval("state").latest.value, 4, "hidden values still receive samples");
        w.toggleCurve("value");
        w.eval("state").remoteHistory.lastRequest = -Infinity;
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
            series: [
                { name: "value", arr: Array.from({ length: 5 }, (_, value) => ({ t: 1000 + value * 33, v: value })) }
            ]
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
        assert.strictEqual(
            w.eval("state").latest.tick,
            null,
            "values sent before the clear acknowledgement are discarded"
        );
        clearing.send({ type: "samplingHistoryCleared", historyRevision: revision - 1 });
        assert.strictEqual(w.historyClearPending, true, "an older acknowledgement does not end the clear");
        clearing.send({ type: "samplingHistoryCleared", historyRevision: revision });
        clearing.send({ type: "chartValues", samples: [{ name: "tick", value: 7, t: 3000 }], t: 3000 });
        assert.strictEqual(w.eval("state").latest.tick, 7);
        w.clearHistory();
        clearing.send({ type: "debugSessionChanged" });
        assert.strictEqual(w.historyClearPending, false, "session changes clear the view without erasing the archive");
        clearing.assertHealthy();
    } finally {
        clearing.close();
    }

    console.log("Remote viewport, silent history, stale replies, freeze, clear races and raw export UI tests passed");
}

(async () => {
    await scenario("Toolbar controls, accessibility and overlap", controls);
    await scenario("Curve identity, inspection, snapshots and interaction", experience);
    await scenario("Jitter bands and envelopes", jitter);
    await scenario("Per-variable number bases, exact values and persistence", numberBases);
    await scenario("Rendering, viewport and empty states", presentation);
    await scenario("Translation geometry, exact axes, gaps, smooth follow and adaptive frame cadence", smoothRender);
    await scenario("Viewport arithmetic", viewportArithmetic);
    await scenario("Drag, overscan, overview, atomic follow, revision throttling and memoization", viewportRequests);
    await scenario(
        "Remote viewports, silent history, stale replies, freeze, clear races and raw export",
        remoteHistory
    );
    console.log("Chart page controls, rendering, viewport and remote history tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
