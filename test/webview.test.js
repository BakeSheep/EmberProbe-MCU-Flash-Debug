"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent, shiftSliderBounds } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
for (const [input, expected] of [
    [[0, 100, 30, 130], { min: 100, max: 200 }],
    [[0, 100, 70, -30], { min: -100, max: 0 }],
    [[0, 100, 30, 60], { min: 0, max: 100 }]
])
    assert.deepStrictEqual(shiftSliderBounds(...input), expected);
const sidebar = render(
    getModernWebviewContent({ elf: "<script>evil()</script>", debugger: "stlink.cfg", mcu: "stm32f4x.cfg" }, "en")
);
try {
    sidebar.assertHealthy();
    assert.ok(sidebar.messages.some((m) => m.type === "initCheck"));
    for (const id of [
        "liveValues",
        "liveToggle",
        "openocdCard",
        "skillStatus",
        "availableVars",
        "chipRead",
        "chipBody",
        "writeValues",
        "varResizeHandle",
        "svdStatus"
    ])
        assert.ok(sidebar.document.getElementById(id), id);
    assert.strictEqual(sidebar.window.evil, undefined);
    const click = (id) => sidebar.document.getElementById(id).click();
    click("openocdSelect");
    assert.deepStrictEqual(sidebar.messages.at(-1), { type: "openocdAction", action: "select" });
    click("chipRead");
    assert.strictEqual(sidebar.messages.at(-1).type, "readChipInfo");
    sidebar.send({ type: "chipInfo", info: { core: "Cortex-M4", uid: "1234", targetState: "halted" } });
    assert.ok(sidebar.document.getElementById("chipBody").textContent.includes("Cortex-M4"));
    sidebar.document.querySelector(".chip-copy").click();
    assert.deepStrictEqual(sidebar.messages.at(-1), { type: "copyText", text: "1234" });
    sidebar.send({ type: "openocdStatus", state: "incompatible", message: "unsupported" });
    assert.ok(sidebar.document.getElementById("openocdCard").classList.contains("error"));
    const card = sidebar.document.getElementById("liveValues").closest(".live-box");
    for (const status of [
        { source: "dap", snapshotReady: false, mode: "debug-running-waiting", canRead: false },
        { source: "dap", snapshotReady: true, mode: "debug-paused-ready", canRead: true },
        { source: "openocd", mode: "debug-running-sampling", canRead: true },
        { source: "openocd", mode: "stopped", canRead: false }
    ]) {
        sidebar.send({ type: "liveStatus", intentEnabled: true, canWrite: false, ...status });
        assert.strictEqual(card.classList.contains("debug-stale"), !status.canRead);
    }
    sidebar.send({ type: "sidebarWatchList", items: [{ name: "tick", type: "u32", address: 536870912 }] });
    sidebar.send({ type: "liveSample", samples: [{ name: "tick", value: 7, valueText: "7", t: 1000 }] });
    assert.ok(sidebar.document.getElementById("liveValues").textContent.includes("7"));
    sidebar.send({
        type: "sidebarWatchList",
        items: [{ name: "tick", type: "u32", address: 536870916 }],
        resetValues: true
    });
    assert.ok(!sidebar.document.getElementById("liveValues").textContent.includes("7"));
    for (const kind of ["issue", "feature", "star"]) {
        sidebar.send({ type: "feedbackPrompt", kind });
        assert.strictEqual(sidebar.document.getElementById("feedbackPrompt").hidden, false);
        sidebar.document.querySelector(".fp-close").click();
        assert.deepStrictEqual(sidebar.messages.at(-1), { type: "feedbackPromptAction", kind, action: "dismiss" });
    }
    click("langToggle");
    assert.strictEqual(sidebar.messages.at(-1).type, "setLang");
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}
const graph = render(getLiveWatchContent({ maxSamples: -10, intervalMs: 1, panelId: 2 }, "en"));
try {
    graph.assertHealthy();
    assert.ok(graph.messages.some((m) => m.type === "ready" && m.panelId === 2));
    assert.strictEqual(graph.window.__CFG__.maxSamples, 100);
    assert.strictEqual(graph.window.__CFG__.intervalMs, 20);
    graph.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 536870912 }] });
    graph.send({ type: "liveStatus", source: "dap", snapshotReady: false, intentEnabled: true });
    assert.ok(graph.document.body.classList.contains("debug-stale"));
    graph.send({ type: "liveStatus", source: "openocd", canRead: true, intentEnabled: true });
    assert.ok(!graph.document.body.classList.contains("debug-stale"));
    graph.send({ type: "liveSample", samples: [{ name: "tick", value: 7, valueText: "7", t: 1000 }] });
    graph.send({ type: "agentExportCsv", requestId: "export", names: ["tick"] });
    const exported = graph.messages.at(-1);
    assert.strictEqual(exported.ok, true);
    assert.strictEqual(exported.rowCount, 1);
    assert.ok(exported.csv.includes(",7"));
    assert.strictEqual(exported.panelId, 2);
    graph.send({ type: "agentExportCsv", requestId: "missing", names: ["absent"] });
    assert.strictEqual(graph.messages.at(-1).code, "CSV_SERIES_NOT_FOUND");
    graph.send({ type: "liveInterval", intervalMs: 250 });
    assert.strictEqual(graph.document.getElementById("interval").value, "250");
    graph.assertHealthy();
} finally {
    graph.close();
}
console.log("Webview DOM and message behavior tests passed");
