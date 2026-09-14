"use strict";
const assert = require("assert");
const Styles = require("../src/webview/liveWatch/seriesStyles");
const I = require("../src/webview/liveWatch/chartInspection");
const A = require("../src/webview/liveWatch/analysisState");
const { SeriesStyleStore } = require("../src/services/seriesStyleStore");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

(async () => {
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
    assert.equal(I.read(series, "x", 15).v, 1);
    assert.equal(I.read(series, "x", 30), null);
    assert.equal(I.read(series, "missing", 15), null);
    assert.equal(I.read(series, "x", 40).v, 4);
    assert.equal(I.nearest([], 0), null);
    assert.equal(
        I.delta({ v: 0, valueText: "18446744073709551614" }, { v: 0, valueText: "18446744073709551615" }),
        "1"
    );
    assert.equal(I.delta({ v: 1.5 }, { v: 2.5 }), "1");
    assert.equal(I.delta(null, { v: 1 }), null);
    assert.equal(I.adjacent(series, 20, 1), 40);
    assert.equal(I.adjacent(series, 20, -1), 10);
    assert.equal(I.adjacent(series, 40, 1), 40);
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

    const analysis = A.create(),
        data = {
            x: [
                { t: 10, v: 1 },
                { t: 20, v: 2 }
            ]
        };
    A.freeze(analysis, data, 1);
    data.x[1].v = 99;
    A.freeze(analysis, data, 1);
    assert.equal(analysis.snapshot.x[0].v, 2);
    let hidden = A.focus(analysis, { z: true }, ["x", "y", "z"], "x");
    hidden = A.focus(analysis, hidden, ["x", "y", "z"], "y");
    assert.deepEqual(A.restore(analysis, ["x", "y", "z", "new"]), { x: false, y: false, z: true, new: false });
    A.remove(analysis, ["x"]);
    assert.ok(!analysis.snapshot.x);
    A.resume(analysis);
    assert.equal(analysis.snapshot, null);

    const graph = render(getLiveWatchContent({ maxSamples: 100 }, "en"));
    try {
        const w = graph.window,
            doc = graph.document;
        Object.defineProperties(doc.getElementById("chart"), {
            clientWidth: { value: 700 },
            clientHeight: { value: 400 }
        });
        const scalar = (name) => ({ name, address: 0x20000000, size: 4, type: "u32" });
        graph.send({ type: "watchList", items: [scalar("a"), scalar("b"), scalar("c")] });
        graph.send({
            type: "liveSample",
            samples: [
                { name: "a", value: 1, t: 1000 },
                { name: "b", value: 2, t: 1000 }
            ]
        });
        graph.send({
            type: "liveSample",
            samples: [
                { name: "a", value: 3, t: 2000 },
                { name: "b", value: 4, t: 2000 }
            ]
        });
        w.draw(100);
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
        const hitPoint = w.chartState.curveGeometry.value[0].points[0];
        w.chartState.hits = [];
        doc.getElementById("chart").dispatchEvent(
            new w.MouseEvent("click", { button: 0, clientX: hitPoint.x, clientY: hitPoint.y })
        );
        assert.ok(w.frozen, "click identifies its own position without waiting for a hover frame");
        w.chartState.pointer = { x: hitPoint.x, y: hitPoint.y };
        w.dirty = true;
        w.draw(150);
        assert.equal(doc.getElementById("curveTooltip").textContent, "1");
        const nextPoint = w.chartState.curveGeometry.value[0].points.at(-1);
        w.chartState.pointer = { x: nextPoint.x, y: nextPoint.y };
        w.dirty = true;
        w.draw(250);
        assert.equal(doc.getElementById("curveTooltip").textContent, "3", "frozen hover updates at new position");
        const otherPoint = w.chartState.curveGeometry.value[1].points.at(-1);
        w.chartState.pointer = { x: otherPoint.x, y: otherPoint.y };
        w.dirty = true;
        w.draw(350);
        assert.equal(doc.getElementById("curveTooltip").textContent, "4", "frozen hover can inspect another series");
        w.resumeChart();
        const oldColor = w.colorFor("b"),
            count = graph.messages.length;
        doc.querySelector(".swatch").click();
        assert.equal(graph.messages.length, count, "hiding never alters sampling subscription");
        assert.equal(w.data.a.length, 2);
        doc.querySelector(".swatch").click();
        w.chartState.autoY = false;
        w.chartState.y = { min: -10, max: 10 };
        w.toggleCurve("b");
        w.draw(200);
        assert.equal(w.chartState.autoY, false);
        assert.equal(w.chartState.y.min, -10);
        w.chartAction("focus", "a");
        w.chartAction("focus", "c");
        w.chartAction("restore");
        assert.equal(w.hidden.b, true);
        assert.equal(w.hidden.a, false);
        w.chartAction("showAll");
        w.chartAction("hideAll");
        assert.ok(w.watch.every((item) => w.hidden[item.name]));
        w.chartAction("showAll");
        doc.body.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Alt", bubbles: true }));
        assert.equal(w.frozen, false, "Alt no longer freezes the chart");
        w.freezeChart();
        for (let i = 0; i < 105; i++)
            graph.send({ type: "liveSample", samples: [{ name: "a", value: i, t: 3000 + i }] });
        assert.equal(w.data.a.length, 100);
        assert.equal(w.latest.a, 104);
        assert.equal(w.analysis.snapshot.a.length, 2);
        assert.equal(w.chartData().find((s) => s.item.name === "a").arr[0].v, 1);
        w.showExport();
        assert.equal(doc.getElementById("exportSource").value, "snapshot");
        w.applyExport();
        assert.equal(graph.messages.at(-1).source, "snapshot");
        assert.ok(graph.messages.at(-1).csv.includes("1"));
        w.removeVar("a");
        assert.equal(w.colorFor("b"), oldColor);
        assert.ok(!w.analysis.snapshot.a);
        w.resumeChart();
        assert.equal(w.frozen, false);
        w.draw(500);
        assert.equal(w.chartState.autoY, false);
        w.clearHistory();
        graph.send({ type: "liveSample", samples: [{ name: "b", value: 1, t: 1000 }] });
        graph.send({ type: "liveSample", samples: [{ name: "b", value: 2, t: 1100 }] });
        assert.equal(
            doc.getElementById("rate").textContent,
            "10.0 Hz",
            "delivery bursts do not distort measured acquisition rate"
        );
        w.clearHistory();
        assert.equal(w.analysis.snapshot, null);
        w.draw(600);
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
        doc.querySelector(".member-swatch").click();
        graph.send({ type: "liveSample", samples: [{ name: "sensor.x", value: 8, t: 1000 }] });
        const before = graph.messages.length;
        doc.querySelector(".member-swatch").click();
        assert.equal(w.data["sensor.x"].length, 1);
        assert.equal(graph.messages.length, before);
        assert.ok(w.watch.some((v) => v.name === "sensor.x"));
        doc.querySelector(".member-swatch").click();
        doc.querySelector(".member-row[data-series-name]").dispatchEvent(
            new w.MouseEvent("contextmenu", { bubbles: true })
        );
        doc.getElementById("seriesOnly").click();
        assert.equal(w.analysis.focused, "sensor.x");
        w.removeVar("sensor.x");
        assert.equal(w.analysis.focused, null);
        graph.assertHealthy();
    } finally {
        graph.close();
    }
    console.log("Chart identity, inspection, snapshot and interaction tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
