"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

const graph = render(getLiveWatchContent({ maxSamples: 2000, frequencyHz: 200 }, "en"));
try {
    graph.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 0x20000000 }] });
    const samples = Array.from({ length: 12513 }, (_, i) => ({ name: "tick", value: i, t: 1000 + i * 5 }));
    graph.send({ type: "liveSample", samples });
    const retained = graph.window.data.tick;
    assert.ok(retained.length <= graph.window.MAXPTS);
    assert.ok(retained.at(-1).t - retained[0].t >= 60000, "200 Hz must retain the whole 60-second window");
    graph.assertHealthy();
} finally {
    graph.close();
}

const limited = render(getLiveWatchContent({ maxSamples: 100, autoMaxSamples: false, frequencyHz: 200 }, "en"));
try {
    assert.strictEqual(limited.window.MAXPTS, 100, "an explicit point limit must still be respected");
    limited.assertHealthy();
} finally {
    limited.close();
}
console.log("High-frequency chart retention tests passed");
