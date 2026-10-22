"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { MAX_BACKLOG_BYTES } = require("../src/services/chartHistoryService");
async function testHistoryBatches(p, entry, panel, history, requests, values) {
    const other = p._livePanels.get(1);
    p._configureChartHistory(other, 1);
    history.clear(entry.watchKey);
    requests.length = 0;
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 3, t: 15 }], 25);
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 1, t: 5 }], 20);
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 2, t: 10 }], 15);
    p._queueChartHistoryAppend(other, [{ name: "shared", value: 99, t: 8 }], 10);
    assert.strictEqual(requests.filter((method) => method === "append").length, 0);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await p._flushPendingChartHistorySamples();
    assert.strictEqual(requests.filter((method) => method === "append").length, 2, "one batch per scope");
    assert.strictEqual(history._scope(entry.watchKey).tick, 25, "a batch uses its maximum tick");
    assert.deepStrictEqual(
        [...history.points(history._scope(entry.watchKey).series.get("shared"))].map((point) => [point.t, point.v]),
        [
            [5, 1],
            [10, 2],
            [15, 3]
        ],
        "multi-tick samples stay in time order"
    );
    assert.strictEqual(history._scope(other.watchKey).series.get("shared").count, 1);
    assert.strictEqual(p._queuedChartHistoryBytes, 0);

    const request = p._chartHistory.request;
    let finishAppend;
    p._chartHistory.request = (method, args) => {
        if (method !== "append") return request(method, args);
        request(method, args);
        return new Promise((resolve) => {
            finishAppend = resolve;
        });
    };
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 4, t: 30 }], 30);
    const inFlight = p._flushChartHistoryAppend(entry);
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 5, t: 35 }], 35);
    await panel.receive({ type: "clearSamplingHistory", panelId: 2, historyRevision: 2 });
    assert.strictEqual(entry._historyBatch, null, "clear drops old samples still waiting for a timer");
    assert.strictEqual(entry._historyBatchTimer, null);
    finishAppend();
    await inFlight;
    p._chartHistory.request = request;
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 6, t: 40 }], 40);
    await p._flushPendingChartHistorySamples();
    assert.deepStrictEqual(
        [...history.points(history._scope(entry.watchKey).series.get("shared"))].map((point) => [point.t, point.v]),
        [[40, 6]],
        "an old acknowledgement cannot replay samples across clear"
    );

    requests.length = 0;
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 7, t: 45 }], 45);
    await panel.receive({ type: "chartFreeze", historyRevision: 2, requestId: 1 });
    assert.deepStrictEqual(requests, ["append", "freeze"], "freeze fences the pending append before capturing history");
    const frozen = panel.messages.at(-1);
    assert.strictEqual(history._source(entry.watchKey, frozen.snapshotId).series.get("shared").count, 2);
    requests.length = 0;
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 8, t: 50 }], 50);
    await panel.receive({
        type: "chartViewport",
        historyRevision: 2,
        names: ["shared"],
        range: { min: 0, max: 60 },
        width: 100
    });
    assert.deepStrictEqual(requests, ["append", "viewport"]);
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 9, t: 55 }], 55);
    entry.historyRevision++;
    await p._flushPendingChartHistorySamples();
    assert.strictEqual(
        history._scope(entry.watchKey).series.get("shared").count,
        3,
        "revision changes fence pending samples"
    );

    const previousItems = values.get(entry.watchKey);
    requests.length = 0;
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 10, t: 60 }], 60);
    values.set(entry.watchKey, [{ name: "shared", type: "u8", address: 0x20000000 }]);
    p._configureChartHistory(entry, 61);
    await p._flushPendingChartHistorySamples();
    assert.deepStrictEqual(requests, ["append", "configure"], "old samples reach the old type before reconfiguration");
    assert.strictEqual(history._scope(entry.watchKey).series.get("shared").count, 0);
    requests.length = 0;
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 11, t: 65 }], 65);
    p._debugSamplingScope = (key) => key + ":next-session";
    p._configureChartHistory(entry, 66);
    assert.deepStrictEqual(requests, ["remove", "configure"], "a scope change discards the old pending batch");
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 12, t: 70 }], 70);
    await p._flushPendingChartHistorySamples();
    assert.strictEqual(history._scope(entry.historyScope).series.get("shared").count, 1);
    p._debugSamplingScope = (key) => key;
    values.set(entry.watchKey, previousItems);
    p._configureChartHistory(entry, 71);
    await p._flushPendingChartHistorySamples();

    requests.length = 0;
    p._liveConsumers = new Set();
    p._debugBridge = { setIntent() {} };
    p._postConsumerStatuses = () => {};
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 13, t: 75 }], 75);
    p.stopLiveWatch();
    await p._flushPendingChartHistorySamples();
    assert.deepStrictEqual(requests, ["append"], "stop flushes a batch without waiting for its timer");
    assert.strictEqual(entry._historyBatchTimer, null);

    p._webviewAssetRootUri = {
        fsPath: require("path").join(require("os").tmpdir(), "chart-host-" + require("crypto").randomUUID())
    };
    p._refreshSamplingPlan = async () => {};
    p.openLiveWatchPanel();
    const closing = p._livePanels.get(3);
    values.set(closing.watchKey, [{ name: "shared" }]);
    p._configureChartHistory(closing, 1);
    requests.length = 0;
    p._queueChartHistoryAppend(closing, [{ name: "shared", value: 1, t: 1 }], 1);
    closing._batchTimer = setTimeout(() => assert.fail("closed panel delivered a pending value"), 1000);
    closing.panel.dispose();
    await p._flushPendingChartHistorySamples();
    assert.deepStrictEqual(requests, ["append", "remove"], "panel disposal flushes before removing its history scope");
    assert.strictEqual(closing._historyBatchTimer, null);
    assert.strictEqual(p._livePanels.has(3), false);
    assert.strictEqual(history.scopes.has(closing.watchKey), false);
}

async function testHistoryFailures(Provider) {
    const p = Object.create(Provider.prototype);
    const entry = { watchKey: "scope", historyRevision: 0 };
    const messages = [];
    let stopped = 0;
    p._livePanels = new Map([[1, entry]]);
    p.stopLiveWatch = () => stopped++;
    p._postLive = (message) => messages.push(message);
    p._t = (key) => key;
    p._warnChartHistoryLimited = function () {
        if (this._chartHistoryLimitedWarned) return;
        this._chartHistoryLimitedWarned = true;
        messages.push({ key: "lw.memoryHistoryLimited" });
    };
    p._chartHistory = {
        request: async (method) => {
            if (method === "append") throw Object.assign(new Error("budget full"), { code: "CHART_HISTORY_FULL" });
            return { limited: true };
        },
        fail: assert.fail
    };
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 1, t: 1 }], 1);
    await p._flushPendingChartHistorySamples();
    assert.strictEqual(stopped, 0);
    assert.strictEqual(messages[0].key, "lw.memoryHistoryLimited");
    let failure, finishMarker;
    let markers = 0;
    p._chartHistory = {
        queuedBytes: MAX_BACKLOG_BYTES - 1,
        request: (method) => {
            assert.strictEqual(method, "markLimited");
            markers++;
            return new Promise((resolve) => {
                finishMarker = resolve;
            });
        },
        fail: (error) => {
            failure = error;
        }
    };
    for (let t = 2; t <= 20; t++) p._queueChartHistoryAppend(entry, [{ name: "shared", value: t, t }], t);
    assert.strictEqual(markers, 1, "host queue pressure coalesces gap markers");
    assert.strictEqual(p._pendingChartHistoryAppends.size, 1, "dropped batches do not accumulate tracking promises");
    finishMarker({ limited: true });
    await p._flushPendingChartHistorySamples();
    assert.strictEqual(failure, undefined);
    assert.strictEqual(stopped, 0);
    assert.strictEqual(messages.length, 1, "memory limit warning is not repeated");
    assert.strictEqual(entry._historyBatch, null, "host batching shares the 16 MiB IPC limit");
}

async function testShutdownFence(Provider) {
    const p = Object.create(Provider.prototype);
    const entry = { watchKey: "scope" };
    let resolveAppend, entered;
    const writing = new Promise((resolve) => {
        entered = resolve;
    });
    let appended = false,
        disposed = false;
    Object.assign(p, {
        _livePanels: new Map([[1, entry]]),
        _liveConsumers: new Set(),
        _debugBridge: { setIntent() {} },
        _elfService: { invalidate() {} },
        _cubemxService: { cancel() {} },
        finishForeignDebug() {},
        _clearDebugStartupWatchdog() {},
        _postConsumerStatuses() {},
        disposeDebugBridge() {},
        _stopManagedDebugServer: async () => {},
        stopAgentReadIfRunning: () => null,
        _agentService: { dispose: async () => {} },
        _samplingArchive: {
            dispose: async () => assert.ok(appended, "archive disposal follows the history acknowledgement")
        },
        _chartHistory: {
            request: () =>
                new Promise((resolve) => {
                    resolveAppend = resolve;
                    entered();
                }),
            fail: assert.fail,
            dispose: async () => {
                assert.ok(appended);
                disposed = true;
            }
        }
    });
    p._queueChartHistoryAppend(entry, [{ name: "shared", value: 1, t: 1 }], 1);
    const shuttingDown = p.shutdown();
    await writing;
    assert.strictEqual(disposed, false);
    appended = true;
    resolveAppend();
    await shuttingDown;
    assert.strictEqual(disposed, true, "shutdown waits for pending history appends before terminating the worker");
}

(async () => {
    const panels = [],
        writes = [],
        values = new Map([
            ["mcu.watchList.2", [{ name: "shared" }]],
            ["mcu.watchList", [{ name: "first" }, { name: "shared" }]]
        ]);
    const progress = { titles: [], reports: [], cancel: false },
        commands = [],
        saveOptions = [];
    let infoChoice;
    const vscode = {
        ViewColumn: { Active: 1 },
        ProgressLocation: { Notification: 15 },
        commands: { executeCommand: async (...args) => commands.push(args) },
        Uri: { joinPath: (_folder, name) => ({ fsPath: name }), file: (name) => ({ fsPath: name }) },
        workspace: {
            getConfiguration: () => ({ get: (_key, fallback) => fallback }),
            fs: { writeFile: async (_uri, bytes) => writes.push(bytes.toString("utf8")) }
        },
        window: {
            createWebviewPanel() {
                const p = {
                    messages: [],
                    webview: {
                        postMessage: (m) => p.messages.push(structuredClone(m)),
                        onDidReceiveMessage: (handler) => {
                            p.receive = handler;
                        }
                    },
                    onDidDispose(handler) {
                        p.dispose = handler;
                    },
                    onDidChangeViewState() {}
                };
                panels.push(p);
                return p;
            },
            showSaveDialog: async (options) => {
                saveOptions.push(options);
                return { fsPath: "snapshot.csv" };
            },
            showInformationMessage: async () => infoChoice,
            showErrorMessage() {},
            withProgress: async (options, task) => {
                progress.titles.push(options.title);
                assert.strictEqual(options.cancellable, true);
                return task(
                    { report: (value) => progress.reports.push(value) },
                    {
                        get isCancellationRequested() {
                            return progress.cancel;
                        }
                    }
                );
            }
        }
    };
    const P = loadProvider(vscode),
        p = Object.create(P.prototype);
    await testHistoryFailures(P);
    await testShutdownFence(P);
    p._context = {
        workspaceState: {
            get: (key) => values.get(key),
            keys: () => [...values.keys()],
            update: async (key, value) => values.set(key, value)
        }
    };
    p._livePanels = new Map();
    p._livePanelFocusOrder = 0;
    p._lang = "en";
    p._t = (key) => key;
    p._invalidateConsumerTypes = () => {};
    p._renderWebview = () => {};
    p._syncGraphTarget = () => {};
    p._scalarWatchList = (key) => values.get(key) || [];
    const clearedScopes = [];
    p._samplingArchive = {
        clear: (scope) => clearedScopes.push(scope),
        status: () => ({ variables: [], rows: 0 })
    };
    p.openLiveWatchPanel();
    p.openLiveWatchPanel();
    await panels[1].receive({ type: "ready", panelId: 2 });
    await panels[0].receive({ type: "ready", panelId: 1 });
    assert.equal(
        panels[1].messages[0].styles.shared.color,
        "#F14C4C",
        "migration priority is panel ID, not ready order"
    );
    await panels[1].receive({ type: "setSeriesStyle", name: "shared", style: { color: "#123456", line: "dotted" } });
    assert.equal(panels[0].messages.at(-1).styles.shared.color, "#123456");
    assert.equal(panels[1].messages.at(-1).styles.shared.line, "dotted");
    await panels[0].receive({ type: "setSeriesStyle", panelId: 2, name: "other" });
    assert.equal(panels[0].messages.at(-1).type, "liveError");
    await panels[0].receive({ type: "setSeriesStyle", name: "shared", style: { color: "invalid", line: "solid" } });
    assert.equal(panels[0].messages.at(-1).type, "liveError");
    await panels[0].receive({
        type: "exportCsv",
        source: "snapshot",
        names: ["shared"],
        csv: "time,shared\r\nnow,42\r\n"
    });
    assert.equal(writes[0], "time,shared\r\nnow,42\r\n");
    assert.equal(panels[0].messages.at(-1).ok, true);
    assert.equal(panels[0].messages.at(-1).rowCount, 1);
    assert.match(saveOptions.at(-1).defaultUri.fsPath, /^emberprobe-live-\d{8}-\d{6}\.csv$/);
    for (const [fileName, expected] of [
        ["电源采样.csv", "电源采样.csv"],
        ["  capture.CSV  ", "capture.csv"],
        ["capture", "capture.csv"],
        ["../outside.csv", null],
        ["C:\\outside.csv", null],
        ["bad\u0000name.csv", null],
        ["CON.csv", null],
        ["name..csv", null],
        ["x".repeat(181), null],
        [7, null],
        [" ", null]
    ]) {
        await panels[0].receive({ type: "exportCsv", source: "snapshot", csv: "time\r\n", fileName });
        const suggested = saveOptions.at(-1).defaultUri.fsPath;
        if (expected) assert.strictEqual(suggested, expected);
        else assert.match(suggested, /^emberprobe-live-\d{8}-\d{6}\.csv$/, "invalid file names use the default");
    }
    await panels[0].receive({ type: "exportCsv", source: "retained", names: ["shared"], csv: 7 });
    assert.equal(panels[0].messages.at(-1).ok, false);
    const exported = [];
    p._samplingArchive.exportCsv = async (request) => {
        exported.push(request);
        return { seriesCount: 1, rows: 2 };
    };
    await panels[0].receive({ type: "exportCsv", names: ["shared"], historyRevision: 0 });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].scope, "mcu.watchList");
    assert.deepStrictEqual(exported[0].names, ["shared"]);
    assert.equal(progress.titles.length, 1, "archive exports run inside a cancellable progress notification");
    assert.equal(panels[0].messages.at(-1).ok, true);
    // Progress reaches the notification and the panel; cancelling stops the export without an error.
    const archiveExport = p._samplingArchive.exportCsv;
    p._samplingArchive.exportCsv = async (request) => {
        request.onProgress(0.25);
        request.onProgress(0.5);
        progress.cancel = true;
        assert.equal(request.isCancelled(), true);
        throw Object.assign(new Error("cancelled"), { code: "CSV_EXPORT_CANCELLED" });
    };
    await panels[0].receive({ type: "exportCsv", names: ["shared"], historyRevision: 0 });
    assert.deepStrictEqual(
        progress.reports.map((report) => report.increment),
        [25, 25]
    );
    assert.ok(panels[0].messages.some((m) => m.type === "exportCsvProgress" && m.percent === 25));
    assert.deepStrictEqual(panels[0].messages.at(-1), {
        type: "exportCsvResult",
        ok: false,
        cancelled: true,
        aborted: true
    });
    progress.cancel = false;
    p._samplingArchive.exportCsv = archiveExport;
    // "Show in Folder" on the success notification reveals the exported file.
    infoChoice = "msg.revealInFolder";
    await panels[0].receive({ type: "exportCsv", names: ["shared"], historyRevision: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(commands.at(-1), ["revealFileInOS", { fsPath: "snapshot.csv" }]);
    infoChoice = undefined;
    const saveDialog = vscode.window.showSaveDialog,
        exportsBefore = exported.length;
    let finishSave;
    vscode.window.showSaveDialog = () => new Promise((resolve) => (finishSave = resolve));
    const exporting = panels[0].receive({ type: "exportCsv", names: ["shared"], historyRevision: 0 });
    await panels[0].receive({ type: "clearSamplingHistory", historyRevision: 1 });
    finishSave({ fsPath: "history.csv" });
    await exporting;
    assert.equal(exported.length, exportsBefore, "a clear during the save dialog must cancel the old export");
    assert.equal(panels[0].messages.at(-1).ok, false);
    vscode.window.showSaveDialog = saveDialog;
    clearedScopes.length = 0;
    // Each chart keeps its curve visibility in the workspace and hands it to the reopened chart.
    assert.deepStrictEqual(
        panels[0].messages.find((message) => message.type === "curveVisibility"),
        { type: "curveVisibility", hidden: null },
        "a chart without saved visibility keeps its defaults"
    );
    await panels[0].receive({ type: "saveCurveVisibility", hidden: { first: true, shared: false, bad: "yes" } });
    await panels[1].receive({ type: "saveCurveVisibility", panelId: 2, hidden: { shared: true } });
    assert.deepStrictEqual(values.get("liveWatch.curveVisibility"), {
        "mcu.watchList": { first: true, shared: false },
        "mcu.watchList.2": { shared: true }
    });
    await panels[0].receive({ type: "saveCurveVisibility", hidden: ["first"] });
    assert.equal(panels[0].messages.at(-1).type, "liveError");
    // VS Code restores a chart tab with its panel number, so it reopens the same watch list and curves.
    const restored = (state) => {
        const panel = {
            messages: [],
            webview: {
                postMessage: (m) => panel.messages.push(structuredClone(m)),
                onDidReceiveMessage: (handler) => {
                    panel.receive = handler;
                }
            },
            onDidDispose() {},
            onDidChangeViewState() {}
        };
        p.restoreLiveWatchPanel(panel, state);
        return panel;
    };
    values.set("liveWatch.curveVisibility", {
        ...values.get("liveWatch.curveVisibility"),
        "mcu.watchList.5": { restoredCurve: false }
    });
    const reopened = restored({ panelId: 5, hidden: {} });
    assert.strictEqual(p._livePanels.get(5)?.watchKey, "mcu.watchList.5");
    assert.strictEqual(reopened.title, "lw.panelTitle");
    assert.strictEqual(reopened.webview.options.enableScripts, true);
    await reopened.receive({ type: "ready", panelId: 5 });
    assert.deepStrictEqual(reopened.messages.find((message) => message.type === "curveVisibility").hidden, {
        restoredCurve: false
    });
    restored({ panelId: 1 });
    assert.ok(p._livePanels.has(3), "a restored panel number already in use takes the next free one");
    restored({});
    assert.ok(p._livePanels.has(4), "state saved before panel numbers were recorded still restores");
    for (const id of [3, 4, 5]) p._livePanels.delete(id);
    const entry = p._livePanels.get(2);
    entry.latestSamples.set("shared", { name: "shared", value: 99 });
    entry._pendingScalars = [{ name: "shared", value: 99 }];
    entry._pendingComposites = [{ name: "composite" }];
    entry._batchTimer = setTimeout(() => assert.fail("cleared batch was delivered"), 1000);
    await panels[1].receive({ type: "clearSamplingHistory", panelId: 2, historyRevision: 1 });
    assert.deepStrictEqual(clearedScopes, ["mcu.watchList.2"]);
    assert.equal(entry._batchTimer, null);
    assert.equal(entry.latestSamples.size, 0, "reloading the panel must not replay cleared readings");
    assert.deepStrictEqual(entry._pendingScalars, []);
    assert.deepStrictEqual(entry._pendingComposites, []);
    assert.deepStrictEqual(panels[1].messages.at(-1), { type: "samplingHistoryCleared", historyRevision: 1 });
    await panels[1].receive({ type: "samplingArchiveInfo", panelId: 2, historyRevision: 1 });
    assert.equal(panels[1].messages.at(-1).historyRevision, 1);
    await panels[0].receive({ type: "clearSamplingHistory", panelId: 2, historyRevision: 2 });
    assert.deepStrictEqual(clearedScopes, ["mcu.watchList.2"], "mismatched panel cannot clear history");
    const history = new ChartHistoryStore();
    const historyRequests = [];
    p._chartHistory = {
        request: async (method, args) => {
            historyRequests.push(method);
            return history[method](...args);
        },
        fail: assert.fail
    };
    p._syncGraphTarget = P.prototype._syncGraphTarget;
    p._samplingStatus = () => ({ running: false });
    p.readElfSymbols = () => ({ symbols: [] });
    p._configureChartHistory(entry);
    history.append(entry.watchKey, [{ name: "shared", value: 7, t: 2000 }], 2000);
    await panels[1].receive({ type: "ready", panelId: 2 });
    const status = panels[1].messages.at(-1);
    assert.strictEqual(status.type, "chartHistoryStatus");
    assert.strictEqual(status.historyRevision, 1, "reloaded webviews receive the host's clear generation");
    assert.deepStrictEqual(status.variables, ["shared"]);
    assert.strictEqual(
        historyRequests.filter((method) => method === "configure").length,
        1,
        "ready preserves configured history"
    );
    assert.strictEqual(
        historyRequests.at(-1),
        "status",
        "ready resends history even when configuration is unchanged and sampling stopped"
    );
    const handshakeIndex = panels[1].messages.findLastIndex((message) => message.type === "chartHistoryReady");
    assert.ok(handshakeIndex < panels[1].messages.length - 1);
    assert.strictEqual(panels[1].messages[handshakeIndex].historyRevision, 1);
    await testHistoryBatches(p, entry, panels[1], history, historyRequests, values);
    let finishStatus;
    p._chartHistory.request = () =>
        new Promise((resolve) => {
            finishStatus = resolve;
        });
    const reloading = panels[1].receive({ type: "ready", panelId: 2 });
    await Promise.resolve();
    entry.historyRevision++;
    const messageCount = panels[1].messages.length;
    finishStatus(status);
    await reloading;
    assert.strictEqual(
        panels[1].messages.length,
        messageCount,
        "a clear during ready invalidates the pending history response"
    );
    p._chartHistory = null;
    p._syncGraphTarget = () => {};
    values.set("mcu.sidebarWatchList", [
        { name: "shared", type: "u8" },
        { name: "sidebarOnly", type: "u32" }
    ]);
    const saved = [];
    p._scalarWatchList = (key) => values.get(key) || [];
    p._saveWatchList = async (key, items) => {
        saved.push(key);
        values.set(key, items);
    };
    await panels[1].receive({
        type: "importSidebarWatch",
        panelId: 2,
        items: [
            { name: "shared", type: "f32" },
            { name: "pending", type: "i16" }
        ]
    });
    assert.deepStrictEqual(
        values.get("mcu.watchList.2").map((item) => item.name),
        ["shared", "pending", "sidebarOnly"]
    );
    assert.strictEqual(values.get("mcu.watchList.2")[0].type, "f32");
    assert.deepStrictEqual(
        values.get("mcu.watchList").map((item) => item.name),
        ["first", "shared"]
    );
    assert.deepStrictEqual(saved, ["mcu.watchList.2"]);
    assert.deepStrictEqual(panels[1].messages.at(-1), { type: "sidebarImportResult", added: 1, sourceCount: 2 });
    await panels[1].receive({ type: "importSidebarWatch", panelId: 2, items: values.get("mcu.watchList.2") });
    assert.deepStrictEqual(saved, ["mcu.watchList.2"], "importing twice must not duplicate or resave watches");
    assert.deepStrictEqual(panels[1].messages.at(-1), { type: "sidebarImportResult", added: 0, sourceCount: 2 });
    p._chartHistory = {};
    let statusCalls = 0;
    p._samplingStatus = () => {
        statusCalls++;
        return { actualHz: 30.3, bytesPerSecond: 12345 };
    };
    p._postWebviewBatch(
        entry,
        [{ name: "shared", value: 1, t: 2000 }],
        [{ name: "sensor", tree: { kind: "struct", members: [] }, t: 2000 }],
        2000
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.strictEqual(statusCalls, 1, "scalar and composite deliveries share one status calculation");
    const compositeBatch = panels[1].messages.at(-1);
    assert.strictEqual(compositeBatch.type, "liveCompositeSample");
    assert.strictEqual(compositeBatch.actualHz, 30.3, "host forwards acquisition rate even when no scalar is plotted");
    assert.strictEqual(compositeBatch.bytesPerSecond, 12345, "host forwards measured throughput for composites");
    console.log("Chart host migration, multi-panel styles and snapshot export tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
