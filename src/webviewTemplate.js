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

function loadRendererPrelude(area) {
    return (
        [
            loadWebviewAsset("", "notice.js"),
            loadWebviewAsset("", "elfDiagnostics.js"),
            loadWebviewAsset("", "runtime.js"),
            loadWebviewAsset("", "valueTree.js"),
            loadWebviewAsset("", "messages.js"),
            loadWebviewAsset("", "cardReorder.js"),
            ...(area === "sidebar"
                ? [
                      loadWebviewAsset("sidebar", "chipView.js"),
                      loadWebviewAsset("sidebar", "memoryView.js"),
                      loadWebviewAsset("sidebar", "peripherals.js"),
                      loadWebviewAsset("sidebar", "rtos.js"),
                      loadWebviewAsset("sidebar", "writeList.js")
                  ]
                : [
                      "seriesStyles.js",
                      "analysisState.js",
                      "chartInspection.js",
                      "chartControls.js",
                      "chartTransport.js",
                      "backgroundIcon.js",
                      "backgroundIconController.js",
                      "chart.js",
                      "samplingRateMotion.js",
                      "exportDialog.js"
                  ].map((name) => loadWebviewAsset("liveWatch", name)))
        ].join("\n") + "\n"
    );
}
module.exports = { loadWebviewAsset, loadRendererPrelude };
