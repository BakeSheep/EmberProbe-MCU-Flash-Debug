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
        "peripheralResizeHandle",
        "githubLink",
        "svdStatus"
    ])
        assert.ok(sidebar.document.getElementById(id), id);
    assert.strictEqual(sidebar.window.evil, undefined);
    sidebar.send({
        type: "availableVariables",
        symbols: [{ name: "counter", watchType: "u32", address: 536870912, size: 4 }]
    });
    assert.equal(sidebar.document.querySelectorAll(".available-head > span").length, 2);
    assert.equal(sidebar.document.querySelectorAll(".available-address").length, 0);
    assert.equal(sidebar.document.querySelector(".available-row").children.length, 2);
    const click = (id) => sidebar.document.getElementById(id).click();
    const diagnostic = {
        code: "PROBE_OPEN_FAILED",
        message: "<script>evil()</script>",
        details: { openocdTail: ["Failed to open device"] }
    };
    sidebar.send({ type: "commandError", error: "Failed", diagnostic });
    assert.strictEqual(sidebar.document.getElementById("probeDiagnostic").hidden, false);
    assert(sidebar.document.getElementById("probeDiagnosticText").textContent.includes("PROBE_OPEN_FAILED"));
    assert.strictEqual(sidebar.document.getElementById("probeDiagnosticText").querySelector("script"), null);
    click("probeDiagnosticCopy");
    assert.deepStrictEqual(JSON.parse(sidebar.messages.at(-1).text), diagnostic);
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
    assert.strictEqual(sidebar.document.getElementById("feedbackPrompt"), null);
    assert.strictEqual(
        sidebar.document.querySelector(".primary-actions [data-command='mcu-vscode.debug']").textContent,
        "Debug"
    );
    assert.strictEqual(sidebar.document.getElementById("githubLink").textContent, "");
    click("githubLink");
    assert.deepStrictEqual(sidebar.messages.at(-1), { type: "openGitHub" });
    const peripheralTree = sidebar.document.getElementById("peripheralTree");
    const peripheralHandle = sidebar.document.getElementById("peripheralResizeHandle");
    peripheralTree.getBoundingClientRect = () => ({ height: Number.parseInt(peripheralTree.style.height, 10) || 120 });
    peripheralHandle.setPointerCapture = () => {};
    peripheralHandle.releasePointerCapture = () => {};
    peripheralHandle.dispatchEvent(new sidebar.window.MouseEvent("pointerdown", { clientY: 100 }));
    peripheralHandle.dispatchEvent(new sidebar.window.MouseEvent("pointermove", { clientY: 160 }));
    peripheralHandle.dispatchEvent(new sidebar.window.MouseEvent("pointerup", { clientY: 160 }));
    assert.strictEqual(peripheralTree.style.height, "180px");
    click("langToggle");
    assert.strictEqual(sidebar.messages.at(-1).type, "setLang");
    assert.strictEqual(sidebar.document.getElementById("githubLink").getAttribute("aria-label"), "打开 GitHub 仓库");
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}
const jlinkSidebar = render(getModernWebviewContent({ debugger: "jlink.cfg", showJlinkDriverChoice: true }, "zh"));
try {
    const driver = jlinkSidebar.document.getElementById("jlinkDriverChoice");
    assert(driver);
    assert.strictEqual(driver.hidden, true);
    assert.strictEqual(jlinkSidebar.document.getElementById("probeActiveConnection"), null);
    assert.strictEqual(
        jlinkSidebar.document.querySelector('[data-command="mcu-vscode.configureProbeConnection"]'),
        null
    );
    assert.strictEqual(jlinkSidebar.document.querySelector(".cubemx-status")?.textContent.includes("成功记录"), false);
    jlinkSidebar.send({ type: "probeDriverChoice", driver: "segger" });
    assert.strictEqual(driver.hidden, false);
    assert.strictEqual(driver.value, "segger");
    driver.value = "winusb";
    driver.dispatchEvent(new jlinkSidebar.window.Event("change"));
    assert.deepStrictEqual(jlinkSidebar.messages.at(-1), { type: "selectProbeDriver", driver: "winusb" });
    assert.strictEqual(driver.disabled, true);
    assert.strictEqual(jlinkSidebar.document.getElementById("jlinkDriverBusy").hidden, false);
    assert.strictEqual(jlinkSidebar.document.getElementById("chipRead").disabled, true);
    assert.strictEqual(driver.value, "segger", "show the confirmed driver until switching succeeds");
    jlinkSidebar.send({ type: "probeDriverChoice", driver: "winusb" });
    assert.strictEqual(driver.disabled, true);
    assert.strictEqual(driver.value, "winusb");
    jlinkSidebar.send({ type: "probeDriverSwitch", busy: false });
    assert.strictEqual(driver.disabled, false);
    assert.strictEqual(jlinkSidebar.document.getElementById("jlinkDriverBusy").hidden, true);
    assert.strictEqual(jlinkSidebar.document.getElementById("chipRead").disabled, false);
    jlinkSidebar.send({ type: "probeDriverChoice", driver: "" });
    assert.strictEqual(driver.hidden, true);
    jlinkSidebar.assertHealthy();
} finally {
    jlinkSidebar.close();
}
const graph = render(getLiveWatchContent({ maxSamples: -10, intervalMs: 1, panelId: 2 }, "en"));
try {
    graph.assertHealthy();
    assert.ok(graph.messages.some((m) => m.type === "ready" && m.panelId === 2));
    assert.strictEqual(graph.window.__CFG__.maxSamples, 100);
    assert.strictEqual(graph.window.__CFG__.intervalMs, 5);
    assert.strictEqual(graph.window.__CFG__.frequencyHz, 200);
    assert.ok(graph.document.body.textContent.includes("Sampling frequency"));
    graph.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 536870912 }] });
    graph.document.getElementById("importSidebar").click();
    assert.deepStrictEqual(graph.messages.at(-1), {
        type: "importSidebarWatch",
        items: [{ name: "tick", type: "u32", address: 536870912 }],
        panelId: 2
    });
    graph.send({ type: "sidebarImportResult", added: 1, sourceCount: 2 });
    assert.ok(graph.document.getElementById("status").textContent.includes("Imported 1"));
    graph.send({ type: "liveStatus", source: "dap", snapshotReady: false, intentEnabled: true });
    assert.ok(graph.document.body.classList.contains("debug-stale"));
    graph.send({ type: "liveStatus", source: "openocd", canRead: true, intentEnabled: true });
    assert.ok(!graph.document.body.classList.contains("debug-stale"));
    graph.send({ type: "liveSample", samples: [{ name: "tick", value: 7, valueText: "7", t: 1000 }] });
    assert.strictEqual(graph.window.MAXPTS, 12257, "200 Hz retains at least a full 60-second chart window");
    graph.send({
        type: "liveStatus",
        running: true,
        actualHz: 123.4,
        frequencyHz: 200,
        effectiveIntervalMs: 8,
        p95DurationMs: 3.2,
        missedDeadlines: 0
    });
    assert.strictEqual(graph.document.getElementById("rate").textContent, "123.4 Hz");
    assert.ok(graph.document.getElementById("rate").title.includes("Target: 200 Hz"));
    assert.ok(graph.document.getElementById("rate").title.includes("Effective: 125.0 Hz (8 ms)"));
    assert.ok(graph.document.getElementById("rate").title.includes("P95: 3.2ms"));
    graph.send({ type: "liveSample", samples: [{ name: "tick", value: null, valueText: "-", t: 1050 }] });
    graph.send({ type: "liveFrequency", frequencyHz: 30, intervalMs: 33 });
    assert.strictEqual(graph.window.MAXPTS, 2076, "retention follows the real 33 ms period, not the nominal 30 Hz");
    assert.strictEqual(graph.document.getElementById("frequency").value, "30");
    graph.document.getElementById("frequency").value = "45";
    graph.document.getElementById("frequency").onchange();
    assert.deepStrictEqual(graph.messages.at(-1), { type: "setFrequency", frequencyHz: 45, panelId: 2 });
    graph.assertHealthy();
} finally {
    graph.close();
}
console.log("Webview DOM and message behavior tests passed");
