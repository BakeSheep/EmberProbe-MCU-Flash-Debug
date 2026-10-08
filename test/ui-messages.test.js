"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const i18n = require("../src/i18n");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { SvdManager } = require("../src/services/svdManager");
const { ProbeDriverService } = require("../src/services/probeDriverService");
const { resolveOpenOcdStatus, resetCache } = require("../src/openocdChecker");
const { diagnoseOpenOcdFailure, parseLine } = require("../src/openocdRunner");
const { toUiError } = require("../src/services/errorEnvelope");

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function fixture() {
    const messages = [],
        notices = [],
        writes = [];
    const vscode = {
        workspace: {
            findFiles: async () => [{ fsPath: path.resolve("firmware.elf") }],
            getConfiguration: () => ({ get: (_key, fallback) => fallback })
        },
        window: {
            showQuickPick: async (items) => items[0],
            showWarningMessage: (message) => notices.push(message),
            showErrorMessage: (message) => notices.push(message),
            showInformationMessage: (message) => notices.push(message)
        }
    };
    const Provider = loadProvider(vscode);
    const provider = Object.create(Provider.prototype);
    Object.assign(provider, {
        _context: {
            extensionUri: {},
            workspaceState: {
                get: () => "configured",
                update: async (key, value) => writes.push({ key, value })
            }
        },
        _webviewRenders: new WeakMap(),
        _livePanels: new Map(),
        commandHandlers: {},
        _assertConnectionEditable() {},
        _resolveOpenOcdPath: async () => null,
        _refreshElfBindings: async () => {},
        _refreshJlinkDriverChoice: async () => {},
        updateView: async () => {},
        _renderWebview: async () => {},
        getModernWebviewContent: () => "",
        _t: (key, params) => i18n.t("en", key, params)
    });
    provider.registerCommandHandlers();
    let dispatch;
    provider.resolveWebviewView({
        webview: {
            postMessage: (message) => messages.push(message),
            onDidReceiveMessage: (callback) => {
                dispatch = callback;
                return { dispose() {} };
            }
        },
        onDidDispose() {}
    });
    return { provider, vscode, messages, notices, writes, dispatch: (message) => dispatch(message) };
}

async function commands() {
    for (const command of ["selectElf", "selectDebugger", "selectMcuCore"]) {
        const f = fixture(),
            picker = deferred(),
            saved = deferred();
        let selectedItems;
        f.vscode.window.showQuickPick = (items) => {
            selectedItems = items;
            return picker.promise;
        };
        f.provider._context.workspaceState.update = () => saved.promise;
        const cmd = "mcu-vscode." + command;
        const pending = f.dispatch({ type: "executeCommand", cmd });
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(f.messages.length, 0, "opening a picker does not complete the command");
        picker.resolve(selectedItems[0]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(f.messages.length, 0, "saving a selection is awaited");
        saved.resolve();
        await pending;
        assert.strictEqual(f.messages.at(-1).type, "commandSuccess");

        f.vscode.window.showQuickPick = async () => undefined;
        await f.dispatch({ type: "executeCommand", cmd });
        assert.strictEqual(f.messages.at(-1).type, "commandCancelled");
        f.vscode.window.showQuickPick = async (items) => items[0];
        f.provider._context.workspaceState.update = async () => {
            throw new Error("save failed");
        };
        await f.dispatch({ type: "executeCommand", cmd });
        assert.strictEqual(f.messages.at(-1).type, "commandError");
        assert.match(f.messages.at(-1).error, /save failed/);
    }
    const f = fixture(),
        statuses = [];
    const manager = Object.create(SvdManager.prototype);
    Object.assign(manager, {
        activeDownload: null,
        workspaceForElf: () => ({}),
        identityForAsync: async () => ({}),
        onStatus: (status) => statuses.push(status),
        t: f.provider._t,
        vscode: {
            ProgressLocation: { Notification: 15 },
            window: {
                ...f.vscode.window,
                withProgress: async (_options, task) => task({ report() {} }, { onCancellationRequested() {} })
            }
        },
        official: {
            discover: async () => {
                throw new Error("network failed");
            }
        }
    });
    f.provider._svdManager = manager;
    const cmd = "mcu-vscode.downloadOfficialSvd";
    await f.dispatch({ type: "executeCommand", cmd });
    assert.strictEqual(f.messages.at(-1).type, "commandError");
    assert.strictEqual(statuses.at(-1).state, "error");
    assert.strictEqual(manager.activeDownload, null);
    manager.official.discover = async () => {
        throw Object.assign(new Error("cancelled"), { code: "DOWNLOAD_CANCELLED" });
    };
    await f.dispatch({ type: "executeCommand", cmd });
    assert.strictEqual(f.messages.at(-1).type, "commandCancelled");
    assert.strictEqual(statuses.at(-1).key, "svd.cancelled");
    manager.official.discover = async () => [];
    manager.chooseCandidate = async () => null;
    await f.dispatch({ type: "executeCommand", cmd });
    assert.strictEqual(f.messages.at(-1).type, "commandError", "no matching SVD is not a successful download");

    const params = { path: "firmware.elf", limit: 64 };
    const error = Object.assign(new Error(i18n.t("en", "live.elfTooLarge", params)), {
        i18nKey: "live.elfTooLarge",
        i18nParams: params
    });
    f.provider._refreshElfBindings = async () => {
        throw error;
    };
    await f.dispatch({ type: "refreshVariables" });
    assert.deepStrictEqual(f.messages.at(-1).params, params);
    assert.strictEqual(toUiError("plain failure").message, "plain failure");
    return f.messages.at(-1);
}

function views(errorMessage) {
    const sidebar = render(getModernWebviewContent({}, "en"));
    const graph = render(getLiveWatchContent({}, "en"));
    try {
        sidebar.send({ type: "commandCancelled" });
        assert.strictEqual(sidebar.document.getElementById("statusText").textContent, "Operation cancelled");
        assert(!sidebar.document.getElementById("statusDot").classList.contains("ready"));
        sidebar.send(errorMessage);
        assert.match(sidebar.document.getElementById("liveLabel").textContent, /64.*firmware\.elf/);
        for (const [view, prefix, id, typesDone] of [
            [sidebar, "availableVariables", "availableDiagnostics", "availableTypesDone"],
            [graph, "variablesList", "elfDiagnostics", "variableTypesDone"]
        ]) {
            view.send({ type: prefix + "Reset", version: "v1", warnings: ["missing DWARF <script>bad()</script>"] });
            assert.strictEqual(view.document.getElementById(id).querySelector("script"), null);
            assert.match(view.document.getElementById(id).textContent, /<script>bad\(\)<\/script>/);
            view.send({ type: prefix + "Done", version: "v1", warnings: ["missing DWARF", "missing DWARF"] });
            assert.strictEqual(view.document.getElementById(id).hidden, false);
            assert.strictEqual(view.document.querySelectorAll("#" + id + " .elf-warning").length, 1);
            view.send({ type: typesDone, version: "v1", warnings: ["DWARF time budget exceeded"] });
            assert.match(view.document.getElementById(id).textContent, /time budget/);
            view.send({ type: prefix + "Done", version: "old", warnings: ["stale warning"] });
            assert(!view.document.getElementById(id).textContent.includes("stale warning"));
            view.send({ type: prefix + "Reset", version: "v2", warnings: [] });
            assert.strictEqual(view.document.getElementById(id).hidden, true);
        }
        graph.send({
            type: "variablesListDone",
            version: "v2",
            error: "ELF parse failed",
            warnings: ["ELF parse failed"]
        });
        assert.match(graph.document.getElementById("elfDiagnostics").textContent, /ELF parse failed/);
        graph.send({ type: "setLang", lang: "zh" });
        assert.match(graph.document.getElementById("elfDiagnostics").textContent, /ELF 解析诊断/);
        const status = {
            type: "rtosDebugStatus",
            state: "paused",
            supported: true,
            sessionId: "s1",
            stopEpoch: 1,
            inspectionEpoch: 1
        };
        sidebar.send(status);
        sidebar.send({ ...status, type: "rtosSnapshot", tasks: [{ name: "Worker", state: "running", stack: {} }] });
        sidebar.send({ ...status, type: "rtosError", message: "RTOS read failed" });
        assert.match(sidebar.document.getElementById("rtosStatus").textContent, /RTOS read failed/);
        sidebar.send({ ...status, state: "running", stopEpoch: 2 });
        assert.match(sidebar.document.getElementById("rtosStatus").textContent, /Previous snapshot/);
        assert.match(sidebar.document.getElementById("rtosTasks").textContent, /Worker/);
        sidebar.send({ ...status, stopEpoch: 3, inspectionEpoch: 2 });
        sidebar.send({ ...status, type: "rtosSnapshot", stopEpoch: 3, tasks: [{ name: "late task" }] });
        assert(!sidebar.document.getElementById("rtosTasks").textContent.includes("late task"));
        sidebar.assertHealthy();
        graph.assertHealthy();
    } finally {
        sidebar.close();
        graph.close();
    }
}

async function diagnostics() {
    for (const [service, code] of [
        ["gdb", "GDB_PORT_IN_USE"],
        ["tcl", "TCL_PORT_IN_USE"],
        ["telnet", "TELNET_PORT_IN_USE"],
        ["unknown", "OPENOCD_PORT_IN_USE"]
    ]) {
        const result = diagnoseOpenOcdFailure([
            `Error: couldn't bind ${service} to socket on port 3333: Address already in use`
        ]);
        assert.strictEqual(result.code, code);
        assert.strictEqual(result.details.port, 3333);
        if (service !== "tcl") assert(!result.suggestedActions.join(" ").includes("Tcl"));
    }
    const gdbWithoutPort = diagnoseOpenOcdFailure(["Address already in use", "Error binding GDB socket"], {
        port: 6666
    });
    assert.strictEqual(gdbWithoutPort.code, "GDB_PORT_IN_USE");
    assert.strictEqual(gdbWithoutPort.details.port, undefined, "configured Tcl port is not the failing GDB port");
    const view = render(getModernWebviewContent({}, "en"));
    try {
        await resolveOpenOcdStatus(
            "audit-openocd",
            {},
            { requested: "audit-openocd", found: false, error: "spawn EACCES" },
            (status) => view.send({ type: "openocdStatus", ...status })
        );
        assert.match(view.document.getElementById("openocdMessage").textContent, /EACCES/);
    } finally {
        view.close();
        resetCache();
    }
    const event = parseLine("Info : Target voltage: 0.000000");
    for (const lang of ["zh", "en"]) assert.match(i18n.t(lang, event.key, event.params), /VTref/);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-helper-message-"));
    try {
        const service = new ProbeDriverService({ extensionPath: root });
        await assert.rejects(service.invoke("install", "mock-device"), (error) => {
            assert(!error.message.includes("signed"));
            assert.strictEqual(error.details.path, service.helperPath);
            return true;
        });
        fs.mkdirSync(path.dirname(service.helperPath), { recursive: true });
        fs.writeFileSync(service.helperPath, "fixture, never executed");
        await assert.rejects(service.invoke("install", "mock-device"), (error) => {
            assert.match(error.details.path, /libwdi\.dll$/);
            assert.match(error.details.cause, /ENOENT/);
            return true;
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

(async () => {
    views(await commands());
    await diagnostics();
    console.log("UI error, cancellation, warning and stale snapshot regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
