"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

const ids = ["mcuConfigSection", "chipInfoSection", "liveValuesSection", "variableBrowser"];
const html = getModernWebviewContent({}, "en");
const view = render(html);
let saved;
try {
    for (const id of ids) {
        const section = view.document.getElementById(id);
        assert.ok(section.open, "first use keeps the default expansion");
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
