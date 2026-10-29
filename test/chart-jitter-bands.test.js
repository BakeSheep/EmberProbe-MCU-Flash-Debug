"use strict";
const assert = require("assert");
const { JSDOM } = require("jsdom");
const { envelopeIndices, jitterBands } = require("../src/webview/liveWatch/chartInspection");
const { paint } = require("../src/webview/liveWatch/chart");
const VP = require("../src/webview/liveWatch/viewport");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

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
