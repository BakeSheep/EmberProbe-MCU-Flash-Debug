"use strict";

const assert = require("assert");
const { JSDOM } = require("jsdom");
const i18n = require("../src/i18n");
const notice = require("../src/webview/notice");
const runtime = require("../src/webview/runtime");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { NoticeService, commandArea, COMMAND_FAILURE_TITLES } = require("../src/services/noticeService");

const { document } = new JSDOM("<!doctype html><body><div id=area></div></body>").window;
let lang = "en";
const timers = [];
const actions = [];
const copies = [];
const area = notice.createNoticeArea(document.getElementById("area"), {
    t: (key, params) => i18n.t(lang, key, params),
    setTimeout: (callback, ms) => timers.push({ callback, ms }) && timers.length,
    clearTimeout: (handle) => (timers[handle - 1] = null),
    onAction: (action, id) => actions.push([action.id, id]),
    onCopy: (text) => copies.push(text)
});
const container = document.getElementById("area");
const box = (id) => container.querySelector(`[data-notice-id="${id}"]`);

assert(container.hidden, "an empty area takes no space");

// Every level renders its own icon inside one shared box shape.
const shapes = new Set();
for (const level of notice.LEVELS) {
    area.set(level, { level, message: level + " text" });
    const node = box(level);
    assert(node.classList.contains("notice") && node.classList.contains("notice--" + level));
    assert.strictEqual(node.querySelector(".notice-text").textContent, level + " text");
    assert.strictEqual(node.getAttribute("role"), level === "error" ? "alert" : "status");
    shapes.add(node.querySelector("svg.notice-icon").innerHTML);
}
assert.strictEqual(shapes.size, 4, "each severity has a distinct icon");
assert(!container.hidden);
assert(box("error").querySelector(".notice-close"), "errors can be dismissed");
assert(box("warning").querySelector(".notice-close"), "event warnings can be dismissed");
assert(!box("info").querySelector(".notice-close"), "info follows its condition");
area.set("state", { level: "warning", message: "partial", dismissible: false });
assert(!box("state").querySelector(".notice-close"), "state-driven warnings clear with their condition");
area.clear("state");
assert.strictEqual(
    runtime.warningIconSvg("write-risk-icon").replace("write-risk-icon", "notice-icon"),
    notice.noticeIconSvg("warning", "notice-icon"),
    "write-risk markers keep the notice warning triangle"
);

// Success fades by itself; replacing it first cancels the pending fade.
const successTimer = timers.findIndex((timer) => timer?.ms === 4000);
assert(successTimer >= 0);
area.set("success", { level: "success", message: "again" });
assert.strictEqual(timers[successTimer], null, "a replaced success cancels its old timer");
timers.at(-1).callback();
assert(!area.has("success"));

// One id holds one notice: a newer message replaces the old one in place.
const order = () => [...container.children].map((node) => node.dataset.noticeId);
const before = order();
area.set("warning", { level: "error", key: "notice.close" });
assert.deepStrictEqual(order(), before);
assert.strictEqual(container.querySelectorAll('[data-notice-id="warning"]').length, 1);
assert.strictEqual(box("warning").querySelector(".notice-text").textContent, "Dismiss");

// Dismiss removes it, and clearing the rest hides the area.
box("error").querySelector(".notice-close").click();
assert(!area.has("error"));
area.clearAll();
assert(container.hidden);

// Errors: the failed operation is the title, the likely cause the body, suggestions a list, and the raw
// error plus diagnostic sit in a folded panel next to the actions.
const diagnostic = { message: "boom", code: "E_PROBE", likelyCause: "USB cable", suggestedActions: ["Replug it"] };
area.set("flash", {
    ...notice.errorNotice({ error: "Error: init failed", diagnostic }, "notice.details"),
    actions: [{ id: "retry", label: { key: "notice.close" }, primary: true }]
});
const flash = box("flash");
assert.strictEqual(flash.querySelector(".notice-head .notice-title").textContent, "Diagnostic details");
assert.deepStrictEqual(
    [...flash.querySelectorAll(".notice-head .notice-buttons > button")].map((node) => node.className),
    ["notice-button notice-action primary", "notice-button notice-close"],
    "actions and close share the title row as one button group"
);
assert.strictEqual(flash.querySelector(".notice-content > .notice-text").textContent, "USB cable");
assert.deepStrictEqual(
    [...flash.querySelectorAll(".notice-items li")].map((li) => li.textContent),
    ["Replug it"]
);
const toggle = flash.querySelector(".notice-footer .notice-toggle");
const panel = flash.querySelector(".notice-diagnostic");
assert(panel.hidden && toggle.getAttribute("aria-expanded") === "false");
assert.strictEqual(toggle.getAttribute("aria-controls"), panel.id);
toggle.click();
assert(!panel.hidden && toggle.getAttribute("aria-expanded") === "true");
const shown = panel.querySelector("pre").textContent;
assert(shown.startsWith("Error: init failed\n\n"), "the raw error leads the diagnostic panel");
assert.deepStrictEqual(
    JSON.parse(shown.split("\n\n")[1]),
    { message: "boom", code: "E_PROBE" },
    "the panel leaves out the cause and suggestions the box already shows"
);
panel.querySelector(".notice-copy").click();
assert(copies[0].startsWith("Error: init failed\n\n"));
assert.deepStrictEqual(JSON.parse(copies[0].split("\n\n")[1]), diagnostic, "the copied report is complete");
flash.querySelector(".notice-head .notice-action.primary").click();
assert.deepStrictEqual(actions, [["retry", "flash"]]);

// Without a readable cause the error itself is the one line, and a keyed reason stays translatable.
area.set("plain", notice.errorNotice({ error: "Timed out" }));
assert.strictEqual(box("plain").querySelector(".notice-head .notice-text").textContent, "Timed out");
assert.strictEqual(box("plain").querySelector(".notice-content"), null, "a one-line error has no body");
area.set("keyed", notice.errorNotice({ key: "notice.close", error: "Dismiss" }));
assert.strictEqual(box("keyed").querySelector(".notice-head .notice-text").textContent, "Dismiss");

// An error with only a code is shown in the user's language; its raw English moves into the details.
const configBusy = "Stop the active probe session before changing connection settings";
area.set(
    "coded",
    notice.errorNotice({ message: configBusy, diagnostic: { message: configBusy, code: "PROBE_CONFIGURATION_BUSY" } })
);
assert.strictEqual(
    box("coded").querySelector(".notice-head .notice-text").textContent,
    i18n.t("en", "err.PROBE_CONFIGURATION_BUSY")
);
assert.strictEqual(box("coded").querySelector(".notice-diagnostic pre").textContent.split("\n\n")[0], configBusy);
// A code without a translation falls back to the raw message once, with no duplicate in the details.
area.set(
    "uncoded",
    notice.errorNotice({ message: "Odd failure", diagnostic: { message: "Odd failure", code: "NOPE" } })
);
assert.strictEqual(box("uncoded").querySelector(".notice-head .notice-text").textContent, "Odd failure");
assert(!box("uncoded").querySelector(".notice-diagnostic pre").textContent.includes("Odd failure"));
area.clear("coded");
area.clear("uncoded");

// Keyed text follows a language switch.
area.set("busy", { level: "info", busy: true, key: "notice.details" });
assert(box("busy").classList.contains("notice--busy"));
lang = "zh";
area.relocalize();
assert.strictEqual(box("busy").querySelector(".notice-text").textContent, "诊断详情");
assert.strictEqual(box("flash").querySelector(".notice-close").title, "关闭");

// Messages are text, never markup.
area.set("xss", { level: "warning", message: '<img src=x onerror="window.pwned=1">', items: ["<b>x</b>"] });
assert.strictEqual(box("xss").querySelector("img, b"), null);
assert.match(box("xss").querySelector(".notice-text").textContent, /<img/);

// Both webviews ship the component and its styles.
for (const html of [getModernWebviewContent({}, "en"), getLiveWatchContent({ maxSamples: 100 }, "en")]) {
    assert.match(html, /\.notice--warning/);
    const view = render(html);
    try {
        assert.strictEqual(typeof view.window.EmberProbeNotice.createNoticeArea, "function");
        view.assertHealthy();
    } finally {
        view.close();
    }
}

// Extension side: one exit, a notification only when the sidebar cannot show the notice.
{
    const posted = [],
        popups = [];
    const view = { visible: true, webview: { postMessage: (message) => posted.push(message) } };
    const window = {
        showErrorMessage: (text) => popups.push(["error", text]),
        showWarningMessage: (text) => popups.push(["warning", text])
    };
    const service = new NoticeService({
        vscode: { window },
        t: (key, params) => i18n.t("en", key, params),
        view: () => view
    });
    const failure = Object.assign(new Error("Flash failed"), { code: "OPENOCD_FAILED" });
    service.notify("flash", "mcu-vscode.download", {
        level: "error",
        titleKey: COMMAND_FAILURE_TITLES["mcu-vscode.download"],
        error: failure
    });
    assert.strictEqual(failure.reported, true, "callers further up do not report it again");
    assert.strictEqual(posted.at(-1).notice.error.diagnostic.code, "OPENOCD_FAILED");
    assert.deepStrictEqual(popups, [], "a visible sidebar shows the notice without a notification");
    view.visible = false;
    service.notify("flash", "mcu-vscode.download", {
        level: "error",
        titleKey: "notice.downloadFailed",
        error: failure
    });
    service.notify("config", "svd", { level: "info", key: "svd.configured" });
    service.notify("flash", "download-busy", { level: "warning", key: "msg.downloadBusy", quiet: true });
    assert.deepStrictEqual(popups, [["error", "Firmware download failed: Flash failed"]]);
    service.notify("flash", "ok", { level: "success", key: "msg.downloadSuccess" });
    const replayed = [];
    service.replay((message) => replayed.push(message.id));
    assert.deepStrictEqual(replayed, ["mcu-vscode.download", "svd", "download-busy"], "success is not retained");
    service.dismiss("config", "svd");
    const count = posted.length;
    service.clear("config", "svd");
    assert.strictEqual(posted.length, count, "a dismissed notice needs no clear message");
    service.clear("flash", "download-busy");
    assert.deepStrictEqual(posted.at(-1), { type: "noticeClear", area: "flash", id: "download-busy" });
    assert.strictEqual(commandArea("mcu-vscode.selectElf"), "config");
    assert.strictEqual(commandArea("mcu-vscode.manageAgentSkills"), "global");
}

console.log("Notice component passed");
