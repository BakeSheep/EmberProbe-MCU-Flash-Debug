"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { paint } = require("../src/webview/liveWatch/chart");
const VP = require("../src/webview/liveWatch/viewport");
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
                { item: { name: "wide" }, idx: 0, arr: [{ t: 0, v: Number(-base), valueText: String(-base) }, ...arr] }
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
