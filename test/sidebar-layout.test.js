"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

const configured = { elf: "app.elf", debugger: "interface/stlink.cfg", mcu: "stm32f4x.cfg" };

// MCU configuration is a folded card above flash/debug whose row names the chip family and probe.
let view = render(getModernWebviewContent(configured, "zh"));
try {
    view.assertHealthy();
    const doc = view.document;
    const config = doc.getElementById("mcuConfigSection");
    assert.strictEqual(config.nextElementSibling.id, "flashDebugSection");
    assert.strictEqual(config.previousElementSibling.id, "noticeGlobal");
    assert.strictEqual(config.open, false, "the configuration card is folded on first use");
    const summary = doc.getElementById("mcuConfigSummary");
    assert.strictEqual(summary.textContent, "STM32F4x · ST-Link");
    assert.strictEqual(config.querySelector("summary .config-title").textContent, "MCU 配置");
    view.send({ type: "setLang", lang: "en" });
    assert.strictEqual(config.querySelector("summary .config-title").textContent, "MCU Configuration");
    assert.strictEqual(summary.textContent, "STM32F4x · ST-Link", "a language change keeps the summary");
    view.send({ type: "debuggerConfig", debugger: "jlink.cfg" });
    assert.strictEqual(summary.textContent, "STM32F4x · J-Link");
    view.send({ type: "debuggerConfig", debugger: "" });
    assert.strictEqual(summary.textContent, "", "an incomplete configuration names nothing");

    // Agent Skills and the MCP installer sit in the flash card's Other dropdown, without the old description.
    const other = doc.getElementById("memoryAnalysisSection");
    assert.strictEqual(doc.getElementById("skillStatus").closest("#memoryAnalysisSection"), other);
    const mcp = other.querySelector('[data-command="mcu-vscode.installMcpServer"]');
    assert.ok(mcp, "Other offers the MCP installer");
    assert.strictEqual(doc.querySelector(".skill-row, .skill-tree"), null);
    mcp.click();
    assert.deepStrictEqual(view.messages.at(-1), { type: "executeCommand", cmd: "mcu-vscode.installMcpServer" });
    assert.strictEqual(config.open, false, "installing the MCP server needs no MCU configuration");

    // An operation that needs the configuration opens the card while it is incomplete.
    doc.querySelector('[data-command="mcu-vscode.download"]').click();
    assert.strictEqual(config.open, true);
    assert.strictEqual(view.getState().sections.mcuConfigSection, true);
} finally {
    view.close();
}

// A complete configuration stays folded when an operation runs.
view = render(getModernWebviewContent(configured, "en"));
try {
    view.document.querySelector('[data-command="mcu-vscode.download"]').click();
    assert.strictEqual(view.document.getElementById("mcuConfigSection").open, false);
} finally {
    view.close();
}

// The status line and the flash notices share one box; a notice takes the status line's place.
view = render(getModernWebviewContent({}, "en"));
try {
    const doc = view.document;
    const box = doc.querySelector("#flashDebugSection > .flash-notice-box");
    assert.ok(box.contains(doc.getElementById("statusText")));
    assert.ok(box.contains(doc.getElementById("noticeFlash")));
    view.send({ type: "initSuccess" });
    assert.strictEqual(doc.getElementById("statusText").textContent, "Extension service ready");
    assert.strictEqual(doc.getElementById("flashStatus").dataset.state, "ready");
    view.send({ type: "notice", area: "flash", id: "mcu-vscode.download", notice: { level: "info", busy: true } });
    assert.strictEqual(doc.getElementById("noticeFlash").hidden, false);
    view.send({ type: "noticeClear", area: "flash", id: "mcu-vscode.download" });
    assert.strictEqual(doc.getElementById("noticeFlash").hidden, true);
} finally {
    view.close();
}
console.log("Sidebar layout: folded MCU card, shared flash notice box, Agent entries under Other");
