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
const { ChipInfoService } = require("../src/services/chipInfoService");
const { ProbeCoordinator } = require("../src/probeCoordinator");

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

async function chipPreflight() {
    const f = fixture();
    const sidebar = render(getModernWebviewContent({}, "en"));
    const failure = Object.assign(new Error("Probe selection required"), { code: "PROBE_SELECTION_REQUIRED" });
    f.provider._svdManager = { syncStatus: async () => {} };
    f.provider._chipInfoService = new ChipInfoService({
        vscode: f.vscode,
        context: { workspaceState: { get: (key) => (key === "target" ? "stm32h7x.cfg" : "") } },
        cacheKeys: { debugger: "probe", mcuCore: "target" },
        coordinator: new ProbeCoordinator(),
        t: f.provider._t,
        isDebugActive: () => false,
        resolveProbe: async () => {
            throw failure;
        },
        onPost: (message) => f.messages.push(message)
    });
    try {
        for (const blocked of [false, true]) {
            f.provider._assertCpuIdle = () => {
                if (blocked) throw failure;
            };
            const read = sidebar.document.getElementById("chipRead");
            read.click();
            assert.strictEqual(read.disabled, true);
            f.messages.length = 0;
            await f.dispatch(sidebar.messages.at(-1));
            const status = f.messages.findLast((message) => message.type === "chipInfoStatus");
            assert.strictEqual(status?.state, "error", "early read failures acknowledge the sidebar request");
            sidebar.send(status);
            assert.strictEqual(read.disabled, false, "failed chip read can be retried");
            assert.match(sidebar.document.getElementById("chipLabel").textContent, /Probe selection/);
        }
        f.provider._chipInfoService.control = async () => {
            throw failure;
        };
        f.messages.length = 0;
        await f.dispatch({ type: "chipControl", action: "pause" });
        assert.strictEqual(f.messages.at(-1).state, "error", "control failures also finish their spinner");
        assert.strictEqual(f.messages.at(-1).diagnostic.code, failure.code);
        f.provider._assertCpuIdle = () => {};
        f.provider._chipInfoService.read = async () => f.messages.push({ type: "chipInfoStatus", state: "ready" });
        f.provider._svdManager.syncStatus = async () => {
            throw new Error("SVD unavailable");
        };
        f.messages.length = 0;
        await f.dispatch({ type: "readChipInfo" });
        assert.deepStrictEqual(
            f.messages.map((message) => message.type),
            ["chipInfoStatus", "svdStatus"]
        );
        assert.strictEqual(f.messages[0].state, "ready", "SVD failure cannot overwrite a successful chip read");
        assert.strictEqual(f.messages[1].state, "error");
        sidebar.assertHealthy();
    } finally {
        sidebar.close();
    }
}

async function incompleteActions() {
    for (const ambiguous of [false, true]) {
        for (const action of ["download", "debug", "attachDebug", "liveToggle"]) {
            const f = fixture();
            const sidebar = render(getModernWebviewContent({}, "en"));
            const coordinator = new ProbeCoordinator();
            Object.assign(f.provider, {
                _probeCoordinator: coordinator,
                _debugBridge: { hasAnySession: false, hasSession: false },
                _probeConnectionService: {
                    resolveProbe: async () => {
                        if (ambiguous)
                            throw Object.assign(new Error("No unique probe selected"), {
                                code: "PROBE_SELECTION_REQUIRED"
                            });
                        return "cmsis-dap.cfg";
                    }
                },
                _assertCpuIdle() {},
                _liveDebugSession: () => null,
                _postProbeOperationStatus() {},
                _resetChartHistoryWarnings() {},
                _clearDebugStartupWatchdog() {},
                _resolveOpenOcdPath: async () => "openocd",
                _postConsumerStatuses: (status, error) =>
                    f.messages.push({
                        type: "liveStatus",
                        running: false,
                        ...status,
                        error
                    })
            });
            f.provider._context.workspaceState.get = () => undefined;
            try {
                if (action === "liveToggle") await f.dispatch({ type: action });
                else {
                    const cmd = `mcu-vscode.${action}`;
                    sidebar.document.querySelector(`[data-command="${cmd}"]`).click();
                    await f.dispatch(sidebar.messages.at(-1));
                }
                assert.strictEqual(coordinator.anyActive(), false, `${action} releases its probe lease`);
                assert(!f.provider._debugCommandPending, `${action} cannot leave a pending debug startup`);
                assert(!f.provider._liveStartPromise, `${action} cannot leave a pending sampling startup`);
                const reply = f.messages.findLast((message) => ["liveStatus", "commandError"].includes(message.type));
                assert(reply, `${action} must acknowledge missing configuration`);
                sidebar.send(reply);
                if (action === "liveToggle") {
                    assert.strictEqual(sidebar.document.getElementById("liveToggle").disabled, false);
                    assert.match(
                        sidebar.document.getElementById("liveLabel").textContent,
                        ambiguous ? /No unique probe/ : /debugger.*MCU/
                    );
                } else assert(!sidebar.document.getElementById("statusText").textContent.includes("Executing"));
                sidebar.assertHealthy();
            } finally {
                sidebar.close();
            }
        }
    }
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

// A slider drag queues writes faster than a paused DAP write-and-verify completes; only the newest
// value of each variable may still run once the in-flight write finishes.
async function queuedWrites() {
    const f = fixture(),
        first = deferred(),
        calls = [];
    Object.assign(f.provider, { _uiWritePromise: Promise.resolve(), _uiWriteTicket: 0, _uiWriteLatest: new Map() });
    f.provider._writeUiVariable = async (name, value) => {
        calls.push([name, value]);
        if (calls.length === 1) await first.promise;
        return { results: [{ readBack: value, readBackText: String(value) }] };
    };
    const inFlight = f.dispatch({ type: "writeVariable", name: "x", value: 1, seq: 1 });
    while (!calls.length) await new Promise((resolve) => setImmediate(resolve));
    const pending = [
        inFlight,
        f.dispatch({ type: "writeVariable", name: "x", value: 2, seq: 2 }),
        f.dispatch({ type: "writeVariable", name: "y", value: 5, seq: 3 }),
        f.dispatch({ type: "writeVariable", name: "x", value: 3, seq: 4 })
    ];
    await new Promise((resolve) => setImmediate(resolve));
    first.resolve();
    await Promise.all(pending);
    assert.deepStrictEqual(calls, [
        ["x", 1],
        ["y", 5],
        ["x", 3]
    ]);
    assert.deepStrictEqual(
        f.messages.filter((message) => message.type === "writeResult").map((message) => message.seq),
        [1, 3, 4]
    );
    assert.strictEqual(f.provider._uiWriteLatest.size, 0, "completed writes release their coalescing slot");
}

(async () => {
    await chipPreflight();
    await incompleteActions();
    views(await commands());
    await diagnostics();
    await queuedWrites();
    console.log("UI error, cancellation, warning and stale snapshot regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
