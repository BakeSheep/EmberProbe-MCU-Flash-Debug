"use strict";
// Charts reopened after a VS Code restart show the curves the user left on, and narrow sidebar
// member rows keep their values right-aligned once the type badge is hidden.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { loadProvider } = require("./helpers/load-provider");

const items = [
    { name: "speed", type: "f32" },
    { name: "count", type: "u32" }
];
const curveSaves = (view) => view.messages.filter((message) => message.type === "saveCurveVisibility");
const swatch = (view, name) =>
    [...view.document.querySelectorAll(".var-card")]
        .find((card) => card.textContent.includes(name))
        ?.querySelector(".swatch");

// A newly opened chart adopts the host's saved curves and reports changes back, but never
// overwrites the host's copy before it has arrived.
{
    const view = render(getLiveWatchContent({ panelId: 1 }, "en"), {});
    try {
        view.send({ type: "watchList", items });
        assert.deepStrictEqual(curveSaves(view), [], "no visibility is saved before the host's copy arrives");
        view.send({ type: "curveVisibility", hidden: { speed: true } });
        assert.ok(swatch(view, "speed").classList.contains("off"), "saved hidden curve stays hidden");
        assert.ok(!swatch(view, "count").classList.contains("off"), "saved visible curve stays visible");
        assert.deepStrictEqual(curveSaves(view).at(-1).hidden, { speed: true });
        assert.strictEqual(view.getState().panelId, 1, "the panel number is kept for restoring the tab");
        swatch(view, "count").click();
        assert.deepStrictEqual(curveSaves(view).at(-1).hidden, { speed: true, count: true });
        view.assertHealthy();
    } finally {
        view.close();
    }
}

// A tab VS Code restored keeps its own state rather than the host's copy.
{
    const view = render(getLiveWatchContent({ panelId: 2 }, "en"), {
        panelId: 2,
        hidden: { count: true },
        pointerCurveDefaults: true
    });
    try {
        view.send({ type: "curveVisibility", hidden: { speed: true } });
        view.send({ type: "watchList", items });
        assert.ok(!swatch(view, "speed").classList.contains("off"));
        assert.ok(swatch(view, "count").classList.contains("off"));
        assert.deepStrictEqual(curveSaves(view).at(-1).hidden, { count: true });
        view.assertHealthy();
    } finally {
        view.close();
    }
}

// While DWARF types load, the host does not send a chart the empty list it cannot resolve yet;
// the rebind afterwards sends the real one.
{
    const Provider = loadProvider();
    const host = Object.create(Provider.prototype);
    const posted = [];
    Object.assign(host, {
        _elfService: { workerPath: "elfWorker.js", cache: { dwarfReady: false } },
        _watchLists: { read: () => items, invalidate() {} },
        _configureChartHistory() {},
        _samplingStatus: () => ({ running: false })
    });
    const entry = { ready: true, watchKey: "mcu.watchList", latestSamples: new Map(), post: (m) => posted.push(m) };
    host._syncGraphTarget(entry, true);
    assert.ok(!posted.some((message) => message.type === "watchList"), "no unresolved list reaches the chart");
    host._elfService.cache.dwarfReady = true;
    host._syncGraphTarget(entry, true);
    assert.deepStrictEqual(posted.filter((message) => message.type === "watchList").at(-1).items, items);
}

// The member name, not the type badge, absorbs the free space, so hiding the badge in narrow
// sidebars cannot move the value to the left.
{
    const css = fs.readFileSync(path.resolve(__dirname, "../src/webview/sidebar/app.css"), "utf8");
    const block = (selector) => css.match(new RegExp(selector.replace(/[.>]/g, "\\$&") + "\\s*\\{([^}]*)\\}"))?.[1];
    assert.match(block(".sb-mrow > .sb-mname"), /margin-right:\s*auto/);
    assert.doesNotMatch(block(".sb-mrow > .sb-mtype"), /margin-left:\s*auto/);
    assert.match(css, /@media\(max-width:260px\)\{[^}]*#liveValues \.sb-mtype/, "narrow sidebars hide the type badge");
}

console.log("Chart restore curve visibility and narrow sidebar alignment tests passed");
