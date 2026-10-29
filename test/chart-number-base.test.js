"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

const html = getLiveWatchContent({ maxSamples: 100, autoMaxSamples: false }, "en");
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
    graph.send({ type: "liveSample", samples });
    w.updateValues();
    const value = (name) => doc.querySelector(`[data-series-name="${name}"] .var-value`).textContent;
    const open = (name) => {
        doc.querySelector(`[data-series-name="${name}"]`).dispatchEvent(
            new w.MouseEvent("contextmenu", { bubbles: true })
        );
    };
    const base = (radix) => doc.querySelector(`[data-radix="${radix}"]`).click();
    const originalData = JSON.stringify(w.data);
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
    assert.equal(JSON.stringify(w.data), originalData, "display conversion never rewrites recorded samples");
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
    assert.equal(w.fmtExact(-26, null, null, "a"), "-0x1A");
    assert.equal(w.fmtExact(null, null, null, "a"), "—");
    assert.equal(w.fmtExact(null, "unavailable", null, "a"), "unavailable");
    assert.equal(w.fmtExact(NaN, null, null, "a"), "—");
    assert.equal(w.fmtExact(26, null, "ENUM_LABEL", "a"), "0x1A");
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
        restored.send({ type: "liveSample", samples });
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
    nested.send({ type: "liveSample", samples: [{ name: "imu.angle", value: { members }, t: 1000 }] });
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
