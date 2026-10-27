"use strict";

const assert = require("assert");
const { getModernWebviewContent } = require("../src/modernView");
const { render } = require("./helpers/render-webview");
const { loadProvider } = require("./helpers/load-provider");

const html = getModernWebviewContent({}, "en");
// OpenOCD problems are a notice in the global slot; a ready OpenOCD shows nothing.
const openocdShown = (document) => !!document.querySelector('#noticeGlobal [data-notice-id="openocd"]');
const first = render(html);
let saved;
try {
    const toggle = first.document.getElementById("skillStatus");
    assert.strictEqual(openocdShown(first.document), false, "unknown OpenOCD status does not flash a checking notice");
    assert.strictEqual(toggle.classList.contains("status-ready"), false);
    first.send({ type: "openocdStatus", state: "ready", key: "oc.ready", result: { lines: ["verbose log"] } });
    first.send({
        type: "skillStatus",
        state: "installed",
        scopes: { workspace: { state: "installed", root: "/workspace", installed: 9, total: 9 } }
    });
    assert.strictEqual(openocdShown(first.document), false);
    assert.strictEqual(toggle.getAttribute("aria-checked"), "true");
    assert.strictEqual(toggle.disabled, false);
    assert.strictEqual(toggle.classList.contains("animate"), false, "initial status does not slide the switch");
    saved = first.getState();
    assert.ok(!Object.hasOwn(saved.sidebarStatus.openocd, "result"), "cache only the visible OpenOCD state");
    assert.deepStrictEqual(saved.sidebarStatus.skill.scopes, { workspace: { state: "installed" } });
    first.assertHealthy();
} finally {
    first.close();
}

const restored = render(html, saved);
let missing;
try {
    const toggle = restored.document.getElementById("skillStatus");
    assert.strictEqual(
        openocdShown(restored.document),
        false,
        "ready status survives document recreation before host replies"
    );
    assert.strictEqual(toggle.getAttribute("aria-checked"), "true");
    assert.strictEqual(toggle.disabled, false);
    assert.strictEqual(toggle.classList.contains("animate"), false);
    restored.send({ type: "setLang", lang: "zh" });
    assert.strictEqual(openocdShown(restored.document), false, "language refresh preserves the cached ready status");
    toggle.click();
    assert.strictEqual(toggle.classList.contains("animate"), true, "user changes keep the switch animation");
    assert.strictEqual(restored.messages.at(-1).cmd, "mcu-vscode.manageAgentSkills");
    restored.send({ type: "skillStatus", state: "notInstalled", scopes: { workspace: { state: "notInstalled" } } });
    assert.strictEqual(toggle.getAttribute("aria-checked"), "false");
    restored.send({ type: "openocdStatus", state: "missing", key: "oc.notFound", canInstall: true });
    assert.strictEqual(openocdShown(restored.document), true, "a new missing result remains visible");
    const notice = restored.document.querySelector('[data-notice-id="openocd"]');
    assert.ok(notice.classList.contains("notice--warning"));
    notice.querySelector(".notice-action.primary").click();
    assert.deepStrictEqual(restored.messages.at(-1), { type: "openocdAction", action: "install" });
    missing = restored.getState();
} finally {
    restored.close();
}

const failed = render(html, missing);
try {
    assert.strictEqual(openocdShown(failed.document), true);
    assert.strictEqual(failed.document.getElementById("skillStatus").getAttribute("aria-checked"), "false");
    failed.send({ type: "openocdStatus", state: "checking", key: "oc.checking" });
    assert.ok(
        failed.document.querySelector('[data-notice-id="openocd"]').classList.contains("notice--busy"),
        "explicit rechecks still show progress"
    );
    failed.assertHealthy();
} finally {
    failed.close();
}
const Provider = loadProvider();
const provider = Object.create(Provider.prototype);
const environmentMessages = [],
    checks = [];
let onVisibility,
    onDispose,
    disposed = false;
const view = {
    visible: false,
    webview: {
        postMessage: (message) => environmentMessages.push(message),
        onDidReceiveMessage: () => ({ dispose() {} })
    },
    onDidChangeVisibility: (callback) => {
        onVisibility = callback;
        return {
            dispose: () => {
                disposed = true;
            }
        };
    },
    onDidDispose: (callback) => {
        onDispose = callback;
    }
};
Object.assign(provider, {
    _context: { workspaceState: { get: () => "configured" } },
    _webviewRenders: new WeakMap(),
    _openOcdStatusService: { status: { state: "ready" } },
    _skillStatusService: { lastStatus: { state: "installed" }, busy: true },
    getModernWebviewContent: () => "",
    _renderWebview: async () => {},
    updateView: async () => {},
    refreshOpenOcdStatus: (checking) => checks.push(checking),
    refreshSkillStatus: async () => checks.push("skills")
});
provider.resolveWebviewView(view);
onVisibility();
assert.strictEqual(environmentMessages.length, 0, "do not replay into a hidden view");
view.visible = true;
onVisibility();
assert.deepStrictEqual(environmentMessages, [
    { type: "openocdStatus", state: "ready" },
    { type: "skillStatus", state: "installed", busy: true }
]);
assert.deepStrictEqual(checks, [false, "skills"], "revalidate quietly without resetting the document");
onDispose();
assert.strictEqual(disposed, true);
assert.strictEqual(provider._webviewView, null);
console.log("Sidebar status restoration, visibility synchronization and initialization animation regressions passed");
