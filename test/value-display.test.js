"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

async function checkDisplay(html, listType, selector) {
    const view = render(html);
    try {
        view.window.Date.now = () => 1000;
        view.send({ type: listType, items: [{ name: "counter", type: "u32", address: 536870912 }] });
        view.send({ type: "liveSample", samples: [{ name: "counter", value: 9, valueText: "9", t: 1000 }] });
        const cell = view.document.querySelector(selector);
        assert.match(view.window.getComputedStyle(cell).fontFamily, /Consolas/);
        assert.strictEqual(cell.textContent, "9");
        view.send({ type: "liveSample", samples: [{ name: "counter", value: 100000, valueText: "100000", t: 1005 }] });
        assert.strictEqual(cell.textContent, "9", "frequent samples should not repaint the value on every message");
        for (let attempt = 0; attempt < 25 && cell.textContent !== "100000"; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.strictEqual(cell.textContent, "100000", "the display should catch up to the latest sample");
        assert.strictEqual(cell.title, "100000", "the complete value should remain available when the column clips it");
        view.assertHealthy();
    } finally {
        view.close();
    }
}

(async () => {
    await checkDisplay(getModernWebviewContent({}, "en"), "sidebarWatchList", ".value-number");
    await checkDisplay(getLiveWatchContent({ maxSamples: 100, frequencyHz: 200 }, "en"), "watchList", ".var-value");
    console.log("Live value display tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
