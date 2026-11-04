"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { scenario } = require("./helpers/scenario");

const ids = ["mcuConfigSection", "chipInfoSection", "liveValuesSection", "variableBrowser"];
const html = getModernWebviewContent({}, "en");
const view = render(html);
let saved;
try {
    const config = view.document.getElementById(ids[0]);
    assert.strictEqual(config.open, false, "the MCU configuration card starts folded");
    config.open = true;
    config.dispatchEvent(new view.window.Event("toggle"));
    for (const id of ids.slice(1))
        assert.ok(view.document.getElementById(id).open, "first use keeps the default expansion");
    for (const id of ids) {
        const section = view.document.getElementById(id);
        section.open = false;
        section.dispatchEvent(new view.window.Event("toggle"));
    }
    const taskBox = view.document.getElementById("rtosTableWrap");
    const handle = view.document.getElementById("rtosResizeHandle");
    taskBox.getBoundingClientRect = () => ({ height: Number.parseInt(taskBox.style.height, 10) || 220 });
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    const drag = (start, end) => {
        handle.dispatchEvent(new view.window.MouseEvent("pointerdown", { clientY: start }));
        handle.dispatchEvent(new view.window.MouseEvent("pointermove", { clientY: end }));
        handle.dispatchEvent(new view.window.MouseEvent("pointerup", { clientY: end }));
    };
    drag(100, 200);
    assert.strictEqual(taskBox.style.height, "320px", "RTOS view grows by dragging its bottom edge");
    drag(100, -500);
    assert.strictEqual(taskBox.style.height, "80px", "RTOS resizing preserves the minimum height");
    drag(100, 340);
    assert.strictEqual(taskBox.style.height, "320px");
    assert.strictEqual(view.window.getComputedStyle(view.document.querySelector(".rtos-table th")).position, "static");
    const rttSection = view.document.getElementById("rttSection");
    assert.ok(rttSection, "the RTT card exists");
    assert.strictEqual(rttSection.open, false, "the RTT card starts folded");
    assert.ok(view.document.getElementById("rttToggle"), "the RTT start/stop button exists");
    assert.ok(
        view.document.querySelector('#rttSection [data-command="mcu-vscode.showRttTerminals"]'),
        "the terminals button opens the RTT terminals"
    );
    view.send({
        type: "rttStatus",
        state: "running",
        channels: { up: [{ index: 0, name: "Terminal", size: 1024, mode: "block" }], down: [] },
        buffers: [{ channel: 0, connected: true }]
    });
    assert.match(view.document.getElementById("rttLabel").textContent, /1/);
    assert.strictEqual(view.document.querySelectorAll("#rttChannels .rtt-ch").length, 1);
    assert.strictEqual(view.document.getElementById("rttToggle").textContent, "Stop");
    view.send({ type: "rttStatus", state: "stopped" });
    assert.strictEqual(view.document.querySelectorAll("#rttChannels .rtt-ch").length, 0);
    assert.strictEqual(view.document.getElementById("rttToggle").textContent, "Start");
    rttSection.open = true;
    rttSection.dispatchEvent(new view.window.Event("toggle"));
    saved = view.getState();
    for (const id of ids) assert.strictEqual(saved.sections[id], false);
    const headers = [...view.document.querySelectorAll(".rtos-table th")].map((cell) => cell.textContent);
    assert.strictEqual(headers.length, 5);
    assert.ok(!headers.includes("TCB"));
    assert.match(view.document.getElementById("rtosStatus").textContent, /Pause/);
    view.assertHealthy();
} finally {
    view.close();
}
const restored = render(html, saved);
try {
    for (const id of ids) assert.strictEqual(restored.document.getElementById(id).open, false);
    assert.strictEqual(
        restored.document.getElementById("rtosTableWrap").style.height,
        "320px",
        "RTOS height is restored"
    );
    assert.strictEqual(restored.document.getElementById("rttSection").open, true, "the RTT fold is restored");
    const section = restored.document.getElementById(ids[0]);
    section.open = true;
    section.dispatchEvent(new restored.window.Event("toggle"));
    assert.strictEqual(restored.getState().sections[ids[0]], true);
    for (const id of ids.slice(1)) assert.strictEqual(restored.getState().sections[id], false);
    restored.assertHealthy();
} finally {
    restored.close();
}
console.log("Sidebar sections survive webview recreation and RTOS columns are compact");

scenario("RTT controls follow state, language and probe-driver ownership", async () => {
    const view = render(html);
    try {
        const toggle = view.document.getElementById("rttToggle");
        toggle.click();
        assert.strictEqual(view.messages.at(-1).cmd, "mcu-vscode.startRtt");
        view.send({ type: "rttStatus", state: "pending-host", yieldedFor: "download" });
        assert.match(view.document.getElementById("rttLabel").textContent, /flashing/);
        view.send({ type: "rttStatus", state: "pending-host", yieldedFor: "agentDownload" });
        assert.match(view.document.getElementById("rttLabel").textContent, /Agent flashing/);
        view.send({ type: "rttStatus", state: "pending-host", yieldedFor: null });
        assert.match(view.document.getElementById("rttLabel").textContent, /waiting for a session/);
        toggle.click();
        assert.strictEqual(view.messages.at(-1).cmd, "mcu-vscode.stopRtt");
        view.send({
            type: "rttStatus",
            state: "running",
            channels: {
                up: [{ index: 2, name: "<img src=x onerror=alert(1)>", mode: "block" }],
                down: [{ index: 2, size: 16 }]
            },
            buffers: [{ channel: 2, connected: false }]
        });
        assert.strictEqual(view.document.querySelector("#rttChannels img"), null);
        const dot = view.document.querySelector(".rtt-ch-dot.off");
        assert.ok(dot);
        assert.strictEqual(dot.getAttribute("aria-label"), "Data connection is down");
        assert.ok(
            view.document.querySelector(".rtt-ch svg.rtt-ch-io[role=img]"),
            "input support is an icon with a label"
        );
        assert.strictEqual(view.document.querySelector(".rtt-ch .tag").textContent, "Block");
        assert.ok(view.document.querySelector(".rtt-ch .tag.warn"), "block mode stands out");
        const terminals = view.document.getElementById("rttTerminals");
        const logPath = view.document.getElementById("rttLogPath");
        const saveLog = view.document.getElementById("rttSaveLog");
        assert.strictEqual(terminals.disabled, true, "no terminals yet");
        assert.strictEqual(logPath.hidden, true);
        const running = view.window.eval("uiState.rtt.status");
        view.send({
            ...running,
            view: { terminals: 1, timestamps: true, log: { enabled: true, directory: "C:/logs" } }
        });
        assert.strictEqual(terminals.disabled, false);
        assert.strictEqual(saveLog.getAttribute("aria-pressed"), "true");
        assert.strictEqual(view.document.getElementById("rttTimestamps").getAttribute("aria-pressed"), "true");
        assert.match(logPath.textContent, /C:\/logs/);
        assert.strictEqual(logPath.title, "C:/logs");
        view.send({ ...running, view: { terminals: 1, timestamps: false, log: { enabled: true, directory: "" } } });
        assert.ok(logPath.classList.contains("warn"), "saving without a directory says so");
        const box = view.document.getElementById("noticeRtt");
        const head = view.document.querySelector("#rttSection .live-head");
        assert.strictEqual(head.nextElementSibling, box, "notices sit right under the state they explain");
        const section = view.document.getElementById("rttSection");
        section.open = false;
        view.send({
            type: "rttStatus",
            state: "stopped",
            reason: "start-failed",
            error: { code: "RTT_START_TIMEOUT", message: "RTT did not find the control block after 12 attempts" }
        });
        assert.strictEqual(view.document.getElementById("rttLabel").textContent, "Start failed");
        view.send({
            type: "notice",
            area: "rtt",
            id: "rtt",
            notice: { level: "error", titleKey: "notice.rttStartFailed", error: { message: "no block" } }
        });
        assert.strictEqual(section.open, true, "a failure opens the collapsed card");
        assert.match(box.textContent, /no block/);
        view.send({ type: "rttStatus", state: "stopped", reason: "host-lost" });
        assert.match(view.document.getElementById("rttState").className, /err/);
        view.send({ ...running, view: { terminals: 1, timestamps: false, log: { enabled: false, directory: "" } } });
        view.send({ type: "setLang", lang: "zh" });
        assert.strictEqual(toggle.textContent, "停止");
        for (const command of [
            "mcu-vscode.rttSaveLog",
            "mcu-vscode.rttToggleTimestamps",
            "mcu-vscode.showRttTerminals"
        ]) {
            view.document.querySelector(`[data-command="${command}"]`).click();
            assert.strictEqual(view.messages.at(-1).cmd, command);
        }
        view.send({ type: "probeDriverStatus", state: "installing", busy: true });
        assert.strictEqual(toggle.disabled, true);
        view.assertHealthy();
    } finally {
        view.close();
    }
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
