"use strict";

const fs = require("fs");
const path = require("path");

const cache = new Map();

// 开发模式下 __dirname=src，打包后 __dirname=dist；发布包保留 src/webview 资产。
function loadWebviewAsset(area, name) {
    const key = `${area}/${name}`;
    if (cache.has(key)) return cache.get(key);
    const candidates = [
        path.join(__dirname, "webview", area, name),
        path.join(__dirname, "..", "src", "webview", area, name)
    ];
    const file = candidates.find((candidate) => fs.existsSync(candidate));
    if (!file) throw new Error(`Missing webview asset: ${key}`);
    const content = (name === "renderer.js" ? loadRendererPrelude(area) : "") + fs.readFileSync(file, "utf8");
    cache.set(key, content);
    return content;
}

function loadRendererPrelude(area) {
    return (
        [
            loadWebviewAsset("", "runtime.js"),
            loadWebviewAsset("", "messages.js"),
            ...(area === "sidebar"
                ? [loadWebviewAsset("sidebar", "chipView.js")]
                : [loadWebviewAsset("liveWatch", "chart.js")])
        ].join("\n") + "\n"
    );
}
module.exports = { loadWebviewAsset, loadRendererPrelude };
