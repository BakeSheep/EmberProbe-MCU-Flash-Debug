"use strict";

const assert = require("assert");
const runtime = require("../src/webview/runtime");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

// Only one aligned 32-bit word is written without halting the core.
assert.strictEqual(runtime.writeHaltRisk(0x20000000, 4), "");
assert.strictEqual(runtime.writeHaltRisk(0x20000004, 1), "subword");
assert.strictEqual(runtime.writeHaltRisk(0x20000006, 2), "subword");
assert.strictEqual(runtime.writeHaltRisk(0x20000006, 4), "unaligned");
assert.strictEqual(runtime.writeHaltRisk(0x20000008, 8), "wide");
assert.strictEqual(runtime.writeHaltRisk(0x20000008, 0), "subword", "unknown widths never count as safe");

const liveState = (previous, message) => runtime.liveState(previous, message);
assert.strictEqual(liveState({}, { canWrite: true, haltWrite: false }).haltWrite, false);
assert.strictEqual(liveState({}, { canWrite: true }).haltWrite, true, "legacy write states keep halting writes");
assert.strictEqual(liveState({ haltWrite: true }, { canRead: true }).haltWrite, true);
assert.strictEqual(liveState({ haltWrite: true }, { canWrite: false }).haltWrite, false);

const symbols = [
    { name: "speed_ref", address: 0x20000000, size: 4, watchType: "f32", hasDwarfWriteType: true },
    { name: "mode", address: 0x20000004, size: 1, watchType: "u8", hasDwarfWriteType: true },
    { name: "packed_gain", address: 0x20000006, size: 4, watchType: "i32", hasDwarfWriteType: true },
    { name: "position", address: 0x20000010, size: 8, watchType: "f64", hasDwarfWriteType: true }
];
const view = render(getModernWebviewContent({}, "en"));
try {
    view.send({ type: "availableVariables", symbols });
    view.send({ type: "liveStatus", running: true, canRead: true, canWrite: true, haltWrite: true });
    for (const button of view.document.querySelectorAll("#availableVars .av-write")) button.click();
    const card = (name) =>
        Array.from(view.document.querySelectorAll(".write-row")).find(
            (row) => row.querySelector(".value-name").dataset.rawName === name
        );
    const icon = (name) => card(name).querySelector(".write-name-wrap .write-name-line > .write-risk");
    const tip = (name) => icon(name).dataset.tip;

    assert.strictEqual(card("speed_ref").querySelector(".write-risk"), null, "aligned 32-bit variables have no marker");
    assert.match(tip("mode"), /8-bit/);
    assert.match(tip("mode"), /halts the CPU/);
    assert.match(tip("packed_gain"), /0x20000006/);
    assert.match(tip("position"), /64-bit/);
    assert.strictEqual(icon("position").getAttribute("aria-label"), tip("position"));
    // Same triangle as the RTOS status, no native title (unbounded width, help cursor) on the icon or around it.
    const rtosIcon = view.document.querySelector("#rtosStatus svg.rtos-status-icon");
    assert(rtosIcon, "the RTOS status renders the shared triangle");
    assert.strictEqual(icon("mode").querySelector("svg.write-risk-icon").innerHTML, rtosIcon.innerHTML);
    assert(!icon("mode").hasAttribute("title"));
    assert(!icon("mode").closest("[title]"), "the name's title never wraps the icon");
    assert.notStrictEqual(view.window.getComputedStyle(icon("mode")).cursor, "help");
    icon("mode").dispatchEvent(new view.window.MouseEvent("mouseenter"));
    const floating = view.document.getElementById("writeRiskTip");
    assert(floating && !floating.hidden);
    assert.strictEqual(floating.getAttribute("role"), "tooltip");
    assert.strictEqual(floating.textContent, tip("mode"));
    assert.strictEqual(icon("mode").getAttribute("aria-describedby"), "writeRiskTip");
    icon("mode").dispatchEvent(new view.window.MouseEvent("mouseleave"));
    assert(floating.hidden);
    assert(!icon("mode").hasAttribute("aria-describedby"));
    icon("position").dispatchEvent(new view.window.FocusEvent("focus"));
    assert.strictEqual(floating.textContent, tip("position"), "keyboard focus shows the same tip");
    icon("position").dispatchEvent(new view.window.FocusEvent("blur"));
    assert(floating.hidden);
    assert.strictEqual(card("mode").querySelector(".value-name").textContent, "mode", "the icon adds no label text");
    for (const row of view.document.querySelectorAll(".write-row"))
        assert(!row.classList.contains("gated"), "every write is available while halting is allowed");

    // A running debug session keeps run control: only non-halting word writes stay enabled.
    view.send({
        type: "liveStatus",
        running: true,
        canRead: true,
        canWrite: true,
        haltWrite: false,
        mode: "debug-running-sampling",
        source: "openocd"
    });
    assert(!card("speed_ref").classList.contains("gated"));
    assert(!card("speed_ref").querySelector(".write-input").disabled);
    for (const name of ["mode", "packed_gain", "position"]) {
        const row = card(name);
        assert(row.classList.contains("gated"), name);
        assert(row.querySelector(".write-input").disabled);
        assert.match(row.querySelector(".write-input").title, /pause the debugger/);
    }
    const before = view.messages.filter((message) => message.type === "writeVariable").length;
    const step = (name) => card(name).querySelector(".step-btn:not([hidden])");
    step("speed_ref").click();
    const writes = view.messages.filter((message) => message.type === "writeVariable");
    assert.strictEqual(writes.length, before + 1);
    assert.strictEqual(writes.at(-1).name, "speed_ref");

    // Cards rebuilt in that state keep their per-variable gate.
    view.send({ type: "sidebarWriteList", items: view.messages.findLast((m) => m.type === "saveSidebarWrite").items });
    assert(card("mode").classList.contains("gated"));
    assert(!card("speed_ref").classList.contains("gated"));

    view.send({ type: "liveStatus", running: true, canRead: true, canWrite: false, haltWrite: false });
    assert(card("speed_ref").classList.contains("gated"));
    assert.match(card("speed_ref").querySelector(".write-input").title, /Start sampling/);
    view.send({ type: "liveStatus", running: true, canRead: true, canWrite: true, haltWrite: true });
    for (const row of view.document.querySelectorAll(".write-row")) assert(!row.classList.contains("gated"));
    view.assertHealthy();
} finally {
    view.close();
}
console.log("Write risk markers and halt-aware write gating passed");
