"use strict";

const fs = require("fs");
const path = require("path");

const cache = new Map();

// Webview assets are served from src/webview, which the package ships as is, so tests, the mockup and the installed
// extension run the same scripts. __dirname is src in development and dist when bundled; both resolve to src/webview.
const WEBVIEW_ROOT = path.join(__dirname, "..", "src", "webview");

function loadWebviewAsset(area, name) {
    const key = `${area}/${name}`;
    if (cache.has(key)) return cache.get(key);
    const file = path.join(WEBVIEW_ROOT, area, name);
    if (!fs.existsSync(file)) throw new Error(`Missing webview asset: ${key}`);
    const content = (name === "renderer.js" ? loadRendererPrelude(area) : "") + fs.readFileSync(file, "utf8");
    cache.set(key, content);
    return content;
}

const SHARED_PRELUDE = [
    "notice.js",
    "elfDiagnostics.js",
    "runtime.js",
    "valueTree.js",
    "symbolPicker.js",
    "messages.js",
    "cardReorder.js"
];
const PAGE_PRELUDE = {
    sidebar: ["chipView.js", "memoryView.js", "openocdCard.js", "peripherals.js", "rtt.js", "rtos.js", "writeList.js"],
    liveWatch: [
        "seriesStyles.js",
        "analysisState.js",
        "chartInspection.js",
        "chartControls.js",
        "chartTransport.js",
        "backgroundIcon.js",
        "backgroundIconController.js",
        "chart.js",
        "samplingRateMotion.js",
        "panelLayout.js",
        "exportDialog.js",
        "variableEntry.js"
    ]
};

// The modules a page's renderer.js runs after, in load order, as [area, name] pairs.
function rendererPrelude(area) {
    if (!Object.hasOwn(PAGE_PRELUDE, area)) throw new Error(`Unknown webview page: ${area}`);
    return [...SHARED_PRELUDE.map((name) => ["", name]), ...PAGE_PRELUDE[area].map((name) => [area, name])];
}

function loadRendererPrelude(area) {
    return (
        rendererPrelude(area)
            .map(([dir, name]) => loadWebviewAsset(dir, name))
            .join("\n") + "\n"
    );
}
module.exports = { WEBVIEW_ROOT, loadWebviewAsset, rendererPrelude };
