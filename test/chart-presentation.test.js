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
} finally {
    dom.window.close();
}
console.log("Chart rendering, viewport and empty-state tests passed");
