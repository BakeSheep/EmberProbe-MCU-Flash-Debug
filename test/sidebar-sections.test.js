"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { scenario } = require("./helpers/scenario");

const ids = ["mcuConfigSection", "agentConfigSection", "chipInfoSection", "liveValuesSection", "variableBrowser"];
const html = getModernWebviewContent({}, "en");
const view = render(html);
let saved;
try {
    const config = view.document.getElementById(ids[0]);
    assert.strictEqual(config.open, false, "the MCU configuration card starts folded");
    config.open = true;
    config.dispatchEvent(new view.window.Event("toggle"));
    assert.strictEqual(view.document.getElementById("agentConfigSection").open, false);
    for (const id of ids.slice(2))
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

scenario("RTT diagnostics distinguish zero, unknown, stale target samples and host history in both languages", () => {
    const view = render(html);
    try {
        const running = {
            type: "rttStatus",
            state: "running",
            channels: {
                up: [
                    {
                        index: 2,
                        name: "<img src=x>".repeat(20),
                        mode: "trim",
                        desiredMode: "block",
                        modeState: "pending"
                    }
                ],
                down: []
            },
            buffers: [{ channel: 2, connected: true, start: 42, receivedBytes: 12345, rateBytesPerSecond: 0 }],
            targetDroppedBytes: null,
            targetTelemetry: {
                available: true,
                reason: null,
                sampledAt: 1000,
                channels: [{ index: 2, usedBytes: 0, capacity: 1023, size: 1024 }]
            }
        };
        const text = () => view.document.getElementById("rttChannels").textContent;
        // The channel's metrics as label -> shown value, and each cell's hover text.
        const metrics = () =>
            Object.fromEntries(
                [...view.document.querySelectorAll(".rtt-metric")].map((cell) => [
                    cell.querySelector(".rtt-metric-k").textContent,
                    cell.querySelector(".rtt-metric-v").textContent
                ])
            );
        const hint = (index) => view.document.querySelectorAll(".rtt-metric")[index].title;
        view.send(running);
        assert.deepStrictEqual(metrics(), {
            Rate: "0 B/s",
            Received: "12.1 KiB",
            "Target used": "0/1023 B",
            Evicted: "42 B"
        });
        assert.strictEqual(hint(1), "12345 B", "the exact count is on hover");
        assert.match(hint(3), /target-side loss is unknown/);
        assert.match(text(), /Mode pending: requested Block, actual Trim/);
        assert.ok(view.document.querySelector(".rtt-ch-note.warn"), "a mode problem stands out");
        assert.strictEqual(view.document.querySelector(".rtt-channels-note"), null);
        assert.strictEqual(view.document.querySelector(".rtt-ch .tag").textContent, "Trim");
        assert.strictEqual(view.document.querySelector("#rttChannels img"), null);
        const rowStyle = view.window.getComputedStyle(view.document.querySelector(".rtt-ch"));
        assert.strictEqual(rowStyle.flexWrap, "wrap", "the diagnostics wrap below the compact channel header");
        const noteStyle = view.window.getComputedStyle(view.document.querySelector(".rtt-ch-note"));
        assert.strictEqual(noteStyle.overflowWrap, "anywhere", "localized reasons can wrap at narrow widths");
        view.send({
            ...running,
            buffers: [{ ...running.buffers[0], rateBytesPerSecond: 1234.567890123, receivedBytes: 5 * 1024 * 1024 }]
        });
        assert.strictEqual(metrics().Rate, "1235 B/s");
        assert.strictEqual(metrics().Received, "5.0 MiB");
        view.send({
            ...running,
            buffers: [{ ...running.buffers[0], rateBytesPerSecond: null }],
            targetTelemetry: { ...running.targetTelemetry, available: false, reason: "RTT_EXACT_ADDRESS_REQUIRED" }
        });
        assert.strictEqual(metrics().Rate, "—");
        assert.strictEqual(hint(0), "unknown");
        assert.strictEqual(metrics()["Target used"], "—");
        assert.match(hint(2), /Target occupancy unknown: Set the RTT control-block address/);
        assert.match(
            view.document.querySelector(".rtt-channels-note").textContent,
            /Target occupancy unknown: Set the RTT control-block address/,
            "the shared reason is shown once below the channels"
        );
        assert.ok(!text().includes("0/1023"), "a failed sample cannot show the previous occupancy as current");
        view.send({ type: "setLang", lang: "zh" });
        assert.deepStrictEqual(Object.keys(metrics()), ["接收速率", "累计接收", "目标占用", "历史淘汰"]);
        assert.match(text(), /目标占用未知：目标遥测和模式设置需要明确/);
        assert.strictEqual(metrics()["历史淘汰"], "42 B");
        assert.match(hint(3), /目标端的丢失量未知/);
        view.send({
            ...running,
            channels: { up: [{ ...running.channels.up[0], modeState: "mismatch" }], down: [] },
            targetTelemetry: { ...running.targetTelemetry, available: false, reason: "LIVE_READ_BUDGET_EXCEEDED" }
        });
        assert.match(text(), /超过事务预算/);
        assert.match(text(), /模式不符：请求阻塞，实际截断/);
        view.send({ ...running, targetTelemetry: { available: false, reason: "NEW_BACKEND_CODE", channels: [] } });
        assert.match(text(), /目标占用未知：未知/);
        assert.ok(!text().includes("NEW_BACKEND_CODE"));
        view.send({ ...running, state: "stopped" });
        assert.strictEqual(metrics()["接收速率"], "—");
        assert.ok(!text().includes("0/1023"), "stopped status cannot present a running sample as current");
        view.send({ ...running, targetTelemetry: { ...running.targetTelemetry, channels: [] } });
        assert.match(text(), /目标占用未知：未知/, "a missing selected channel remains unknown");
        view.assertHealthy();
    } finally {
        view.close();
    }
});

scenario("the RTT card leaves input to the bottom panel", () => {
    const view = render(html);
    try {
        for (const id of ["rttInputRow", "rttInput", "rttSend", "rttInputChannel", "rttInputError"])
            assert.strictEqual(view.document.getElementById(id), null, id);
        view.assertHealthy();
    } finally {
        view.close();
    }
});

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
