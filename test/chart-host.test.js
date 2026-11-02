"use strict";
// The waveform host: panel identity and restore, history from sampling into the store and archive, snapshot
// export, and the viewport transport between host and page.
const assert = require("assert");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const vm = require("vm");
const { ChartHistoryStore, INITIAL_BLOCK_POINTS, blockBytes } = require("../src/services/chartHistoryStore");
const { MAX_BACKLOG_BYTES, ChartHistoryService, estimateHistoryBytes } = require("../src/services/chartHistoryService");
const { WatchListStore } = require("../src/services/watchListStore");
const { t } = require("../src/i18n");
const { getLiveWatchContent } = require("../src/liveWatchView");
const elf = require("../src/elfSymbols");
const { LiveWatchService, buildChartHistoryItems } = require("../src/services/liveWatchService");
const { SamplingArchive } = require("../src/services/samplingArchive");
const { decodeRecords } = require("../src/services/samplingArchiveFormat");
const { encodeViewport, decodeViewport } = require("../src/webview/liveWatch/chartTransport");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { scenario } = require("./helpers/scenario");

// Panel migration, multi-panel styles, history batches and snapshot export
async function panels() {
    async function testHistoryBatches(p, entry, panel, history, requests, values) {
        const other = p._livePanels.get(1);
        p._historyFeed.configure(other, 1);
        history.clear(entry.watchKey);
        requests.length = 0;
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 3, t: 15 }], 25);
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 1, t: 5 }], 20);
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 2, t: 10 }], 15);
        p._historyFeed.queueAppend(other, [{ name: "shared", value: 99, t: 8 }], 10);
        assert.strictEqual(requests.filter((method) => method === "append").length, 0);
        await new Promise((resolve) => setTimeout(resolve, 70));
        await p._historyFeed.flushPending();
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
        assert.strictEqual(p._historyFeed.queuedBytes, 0);

        const request = p._chartHistory.request;
        let finishAppend;
        p._chartHistory.request = (method, args) => {
            if (method !== "append") return request(method, args);
            request(method, args);
            return new Promise((resolve) => {
                finishAppend = resolve;
            });
        };
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 4, t: 30 }], 30);
        const inFlight = p._historyFeed.flushAppend(entry);
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 5, t: 35 }], 35);
        await panel.receive({ type: "clearSamplingHistory", panelId: 2, historyRevision: 2 });
        assert.strictEqual(entry._historyBatch, null, "clear drops old samples still waiting for a timer");
        assert.strictEqual(entry._historyBatchTimer, null);
        finishAppend();
        await inFlight;
        p._chartHistory.request = request;
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 6, t: 40 }], 40);
        await p._historyFeed.flushPending();
        assert.deepStrictEqual(
            [...history.points(history._scope(entry.watchKey).series.get("shared"))].map((point) => [point.t, point.v]),
            [[40, 6]],
            "an old acknowledgement cannot replay samples across clear"
        );

        requests.length = 0;
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 7, t: 45 }], 45);
        await panel.receive({ type: "chartFreeze", historyRevision: 2, requestId: 1 });
        assert.deepStrictEqual(
            requests,
            ["append", "freeze"],
            "freeze fences the pending append before capturing history"
        );
        const frozen = panel.messages.at(-1);
        assert.strictEqual(history._source(entry.watchKey, frozen.snapshotId).series.get("shared").count, 2);
        requests.length = 0;
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 8, t: 50 }], 50);
        await panel.receive({
            type: "chartViewport",
            historyRevision: 2,
            names: ["shared"],
            range: { min: 0, max: 60 },
            width: 100
        });
        assert.deepStrictEqual(requests, ["append", "viewport"]);
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 9, t: 55 }], 55);
        entry.historyRevision++;
        await p._historyFeed.flushPending();
        assert.strictEqual(
            history._scope(entry.watchKey).series.get("shared").count,
            3,
            "revision changes fence pending samples"
        );

        const previousItems = values.get(entry.watchKey);
        requests.length = 0;
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 10, t: 60 }], 60);
        values.set(entry.watchKey, [{ name: "shared", type: "u8", address: 0x20000000 }]);
        p._historyFeed.configure(entry, 61);
        await p._historyFeed.flushPending();
        assert.deepStrictEqual(
            requests,
            ["append", "configure"],
            "old samples reach the old type before reconfiguration"
        );
        assert.strictEqual(history._scope(entry.watchKey).series.get("shared").count, 0);
        requests.length = 0;
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 11, t: 65 }], 65);
        p._debugSamplingScope = (key) => key + ":next-session";
        p._historyFeed.configure(entry, 66);
        assert.deepStrictEqual(requests, ["remove", "configure"], "a scope change discards the old pending batch");
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 12, t: 70 }], 70);
        await p._historyFeed.flushPending();
        assert.strictEqual(history._scope(entry.historyScope).series.get("shared").count, 1);
        p._debugSamplingScope = (key) => key;
        values.set(entry.watchKey, previousItems);
        p._historyFeed.configure(entry, 71);
        await p._historyFeed.flushPending();

        requests.length = 0;
        p._sampling.consumers = new Set();
        p._debugBridge = { setIntent() {} };
        p._postConsumerStatuses = () => {};
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 13, t: 75 }], 75);
        p._sampling.stop();
        await p._historyFeed.flushPending();
        assert.deepStrictEqual(requests, ["append"], "stop flushes a batch without waiting for its timer");
        assert.strictEqual(entry._historyBatchTimer, null);

        p._webviewAssetRootUri = {
            fsPath: require("path").join(require("os").tmpdir(), "chart-host-" + require("crypto").randomUUID())
        };
        p._sampling.refreshSamplingPlan = async () => {};
        p.openLiveWatchPanel();
        const closing = p._livePanels.get(3);
        values.set(closing.watchKey, [{ name: "shared" }]);
        p._historyFeed.configure(closing, 1);
        requests.length = 0;
        p._historyFeed.queueAppend(closing, [{ name: "shared", value: 1, t: 1 }], 1);
        closing._batchTimer = setTimeout(() => assert.fail("closed panel delivered a pending value"), 1000);
        closing.panel.dispose();
        await p._historyFeed.flushPending();
        assert.deepStrictEqual(
            requests,
            ["append", "remove"],
            "panel disposal flushes before removing its history scope"
        );
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
        p._sampling.stop = () => stopped++;
        p._postLive = (message) => messages.push(message);
        p._t = (key) => key;
        p._historyFeed.warnLimited = function () {
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
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 1, t: 1 }], 1);
        await p._historyFeed.flushPending();
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
        for (let t = 2; t <= 20; t++) p._historyFeed.queueAppend(entry, [{ name: "shared", value: t, t }], t);
        assert.strictEqual(markers, 1, "host queue pressure coalesces gap markers");
        assert.strictEqual(
            p._historyFeed.pendingAppends.size,
            1,
            "dropped batches do not accumulate tracking promises"
        );
        finishMarker({ limited: true });
        await p._historyFeed.flushPending();
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
            _debugBridge: { setIntent() {} },
            _elfService: { invalidate() {} },
            _cubemxService: { cancel() {} },
            _postConsumerStatuses() {},
            disposeDebugBridge() {},
            _agentService: { close() {}, stop: async () => {}, dispose: async () => {} },
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
        Object.assign(p._agentOps, { stopReadIfRunning: () => null });
        Object.assign(p.debugLaunch, { clearStartupWatchdog() {}, stopManagedServer: async () => {} });
        Object.assign(p._sampling, { consumers: new Set() });
        p._historyFeed.queueAppend(entry, [{ name: "shared", value: 1, t: 1 }], 1);
        const shuttingDown = p.shutdown();
        await writing;
        assert.strictEqual(disposed, false);
        appended = true;
        resolveAppend();
        await shuttingDown;
        assert.strictEqual(disposed, true, "shutdown waits for pending history appends before terminating the worker");
    }

    const panels = [],
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
            fs: {}
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
    p._sampling.invalidateConsumerTypes = () => {};
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
    assert.deepEqual(panels[1].messages[0].styles, {}, "ready does not allocate styles for saved watches");
    await panels[1].receive({ type: "setSeriesStyle", name: "shared", style: { color: "#123456", line: "dotted" } });
    assert.equal(panels[0].messages.at(-1).styles.shared.color, "#123456");
    assert.equal(panels[1].messages.at(-1).styles.shared.line, "dotted");
    await panels[0].receive({ type: "setSeriesStyle", panelId: 2, name: "other" });
    assert.equal(panels[0].messages.at(-1).type, "liveError");
    await panels[0].receive({ type: "setSeriesStyle", name: "shared", style: { color: "invalid", line: "solid" } });
    assert.equal(panels[0].messages.at(-1).type, "liveError");
    const exported = [];
    p._samplingArchive.exportCsv = async (request) => {
        exported.push(request);
        return { seriesCount: 1, rows: 2 };
    };
    await panels[0].receive({ type: "exportCsv", names: ["shared"], historyRevision: 0 });
    assert.equal(panels[0].messages.at(-1).ok, true);
    assert.equal(panels[0].messages.at(-1).rowCount, 2);
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
        await panels[0].receive({ type: "exportCsv", names: ["shared"], fileName });
        const suggested = saveOptions.at(-1).defaultUri.fsPath;
        if (expected) assert.strictEqual(suggested, expected);
        else assert.match(suggested, /^emberprobe-live-\d{8}-\d{6}\.csv$/, "invalid file names use the default");
    }
    exported.length = 0;
    progress.titles.length = 0;
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
    // The panel's success notice offers "Show in Folder" for the file it just wrote.
    await panels[0].receive({ type: "exportCsv", names: ["shared"], historyRevision: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(panels[0].messages.at(-1).type, "exportCsvResult");
    assert.strictEqual(panels[0].messages.at(-1).ok, true);
    await panels[0].receive({ type: "revealCsvExport" });
    assert.deepStrictEqual(commands.at(-1), ["revealFileInOS", { fsPath: "snapshot.csv" }]);
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
    p._sampling.status = () => ({ running: false });
    p.readElfSymbols = () => ({ symbols: [] });
    p._historyFeed.configure(entry);
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
    p._sampling.status = () => {
        statusCalls++;
        return { actualHz: 30.3, bytesPerSecond: 12345 };
    };
    p._sampling._postWebviewBatch(
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
}

// Panel identity, hidden tabs and restore isolation
async function identity() {
    const one = [{ name: "only_in_one", type: "u32" }];
    const two = [{ name: "only_in_two", type: "f32" }];
    function fixture(saved) {
        const values = new Map(
            saved || [
                ["mcu.watchList", one],
                ["mcu.watchList.2", two]
            ]
        );
        const tabs = [];
        function panel(title, viewType = "mainThreadWebview-emberprobe.liveWatch") {
            let disposed;
            const p = {
                title,
                messages: [],
                onDidDispose(fn) {
                    disposed = fn;
                },
                onDidChangeViewState() {},
                dispose() {
                    tabs.splice(tabs.indexOf(tab), 1);
                    disposed?.();
                }
            };
            p.webview = {
                postMessage: (m) => p.messages.push(structuredClone(m)),
                onDidReceiveMessage: (fn) => {
                    p.receive = fn;
                }
            };
            const tab = {
                get label() {
                    return p.title;
                },
                input: { viewType }
            };
            tabs.push(tab);
            return p;
        }
        const state = {
            get: (key) => values.get(key),
            keys: () => [...values.keys()],
            update: async (key, value) => {
                values.set(key, structuredClone(value));
            }
        };
        const vscode = {
            ViewColumn: { Active: 1 },
            workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
            window: {
                tabGroups: { all: [{ tabs }] },
                createWebviewPanel: (_, title) => panel(title)
            }
        };
        const P = loadProvider(vscode),
            host = Object.create(P.prototype);
        Object.assign(host, {
            _context: { workspaceState: state },
            _livePanels: new Map(),
            _livePanelFocusOrder: 0,
            _webviewAssetRootUri: { fsPath: path.join(os.tmpdir(), "panel-identity-" + randomUUID()) },
            _lang: "zh",
            _latestSidebarSamples: new Map(),
            _seriesStyleStore: { initialize: async () => {}, styles: {} },
            _renderWebview(webview, html) {
                webview.html = html;
            },
            readElfSymbols: () => ({ symbols: [] }),
            _syncSidebarTarget() {},
            _chartBackgroundState: () => ({ type: "chartBackgroundIcon", icon: null }),
            chartBackground: () => ({ ready() {} }),
            _t: (key, params) => t("zh", key, params)
        });
        Object.assign(host._historyFeed, { configure() {} });
        Object.assign(host._sampling, { frequencyHz: 10, status: () => ({ running: false }), pruneSampleMap() {} });
        Object.assign(host._sampling, { invalidateConsumerTypes() {}, refreshSamplingPlan: async () => {} });
        host._watchLists = new WatchListStore({
            state,
            normalize: (items) => items,
            symbols: () => [],
            onChanged() {},
            onError: assert.fail
        });
        const entry = (p) => [...host._livePanels.values()].find((e) => e.panel === p);
        const ready = async (p) => {
            await p.receive({ type: "ready", panelId: entry(p).panelId });
            assert.ok(!p.messages.some((m) => m.type === "liveError"), "panel initializes without errors");
            return p.messages.findLast((m) => m.type === "watchList")?.items;
        };
        const open = () => {
            host.openLiveWatchPanel();
            return [...host._livePanels.values()].at(-1).panel;
        };
        return { host, values, panel, entry, ready, open };
    }

    // A hidden editor has a tab but no deserialized WebviewPanel yet.
    {
        const f = fixture(),
            old = f.panel("波形图 #1"),
            fresh = f.open();
        assert.strictEqual(f.entry(fresh).panelId, 2, "hidden #1 reserves its number before restoration");
        assert.notStrictEqual(old.title, fresh.title);
        f.host.restoreLiveWatchPanel(old, { panelId: 1 });
        assert.deepStrictEqual(await f.ready(old), one);
        assert.deepStrictEqual(await f.ready(fresh), two);
    }
    // Tab inventory is scoped to EmberProbe, supports both host view-type forms and both languages.
    {
        const f = fixture();
        f.panel("Waveform #1", "another.extension");
        const old = f.panel("Waveform #2", "emberprobe.liveWatch");
        const fresh = f.open();
        assert.strictEqual(f.entry(fresh).panelId, 1);
        f.host.restoreLiveWatchPanel(old, { hidden: {} });
        assert.strictEqual(f.entry(old).panelId, 2, "legacy English title recovers the original identity");
        assert.deepStrictEqual(await f.ready(old), two);
    }
    // Even a conflicting legacy number must retain its original watches, not those of the new label.
    {
        const f = fixture(),
            first = f.open(),
            old = f.panel("波形图 #1");
        f.values.set("liveWatch.curveVisibility", { "mcu.watchList": { only_in_one: true } });
        f.values.set("liveWatch.runtimeExpansions", { "mcu.watchList": { only_in_one: ["member"] } });
        f.host.restoreLiveWatchPanel(old, { panelId: 1 });
        assert.strictEqual(f.entry(old).panelId, 2);
        assert.deepStrictEqual(await f.ready(old), one, "renumbering never switches to #2's watches");
        assert.notStrictEqual(
            f.entry(old).watchKey,
            f.entry(first).watchKey,
            "duplicate identities become independent"
        );
        assert.deepStrictEqual(old.messages.find((m) => m.type === "curveVisibility").hidden, { only_in_one: true });
        const key = f.entry(old).watchKey;
        assert.deepStrictEqual(f.values.get("liveWatch.runtimeExpansions")[key], { only_in_one: ["member"] });
        await old.receive({ type: "saveWatch", panelId: 2, items: two });
        assert.deepStrictEqual(f.values.get("mcu.watchList"), one, "editing the copied chart cannot change #1");
        assert.deepStrictEqual(f.values.get(key), two);
        await old.receive({ type: "saveWatch", panelId: 1, items: [] });
        assert.strictEqual(old.messages.at(-1).diagnostic.code, "INVALID_PANEL_ID");
        assert.deepStrictEqual(f.values.get(key), two, "cross-panel messages cannot change the list");
    }
    // Number and storage key stay independent across another restart, even while the chart is hidden.
    {
        const f = fixture(),
            old = f.panel("波形图 #2");
        f.host.restoreLiveWatchPanel(old, { panelId: 2, watchKey: "mcu.watchList" });
        assert.deepStrictEqual(await f.ready(old), one);
        const view = render(old.webview.html, { panelId: 2, watchKey: "mcu.watchList" });
        let saved;
        try {
            saved = view.getState();
            assert.strictEqual(saved.watchKey, "mcu.watchList", "identity is saved at startup before host messages");
            assert.strictEqual(saved.panelId, 2);
            view.assertHealthy();
        } finally {
            view.close();
        }
        const restarted = fixture(structuredClone([...f.values]));
        const pending = restarted.panel("波形图 #2"),
            fresh = restarted.open();
        assert.strictEqual(restarted.entry(fresh).panelId, 1);
        assert.notStrictEqual(restarted.entry(fresh).watchKey, "mcu.watchList", "hidden #2 still owns #1's storage");
        restarted.host.restoreLiveWatchPanel(pending, saved);
        assert.deepStrictEqual(await restarted.ready(pending), one);
        assert.deepStrictEqual(
            await restarted.ready(fresh),
            [],
            "a new independent chart cannot borrow hidden watches"
        );
    }
    // Two overlapping restore requests may duplicate an identity whose first copy is still being saved.
    {
        const f = fixture();
        f.open();
        const copy = f.panel("波形图 #2");
        f.host.restoreLiveWatchPanel(copy, { panelId: 1 });
        const next = f.panel("波形图 #3");
        f.host.restoreLiveWatchPanel(next, { panelId: 3, watchKey: f.entry(copy).watchKey });
        assert.deepStrictEqual(await f.ready(copy), one);
        assert.deepStrictEqual(await f.ready(next), one, "copies wait for their source initialization");
        assert.notStrictEqual(f.entry(copy).watchKey, f.entry(next).watchKey);
    }
    // VS Code's initial tab inventory can arrive after the first serializer during activation.
    {
        const f = fixture();
        f.values.set("liveWatch.panelBindings", { 2: "mcu.watchList" });
        const active = f.panel("Waveform #3");
        f.host.restoreLiveWatchPanel(active, { panelId: 3 });
        await f.ready(active);
        assert.strictEqual(f.values.get("liveWatch.panelBindings")[2], "mcu.watchList");
        const next = fixture(structuredClone([...f.values]));
        next.panel("Waveform #2");
        assert.notStrictEqual(next.entry(next.open()).watchKey, "mcu.watchList");
    }
    // Reverse restoration and legacy Chinese titles retain the two independent lists.
    {
        const f = fixture(),
            first = f.panel("波形图 #1"),
            second = f.panel("波形图 #2");
        f.host.restoreLiveWatchPanel(second, {});
        f.host.restoreLiveWatchPanel(first, null);
        assert.deepStrictEqual(await f.ready(second), two);
        assert.deepStrictEqual(await f.ready(first), one);
        second.dispose();
        assert.strictEqual(f.entry(f.open()).panelId, 2, "closed slots can be reused");
    }
    // A shutdown during an old renumbering can leave the title ahead of the saved panel number.
    {
        const f = fixture(),
            pending = f.panel("波形图 #1"),
            old = f.panel("波形图 #2");
        f.host.restoreLiveWatchPanel(old, { panelId: 1 });
        assert.strictEqual(f.entry(old).panelId, 2, "restoring cannot steal another hidden tab's visible number");
        assert.deepStrictEqual(await f.ready(old), one);
        assert.notStrictEqual(f.entry(old).watchKey, "mcu.watchList");
        f.host.restoreLiveWatchPanel(pending, { panelId: 1 });
        assert.deepStrictEqual(await f.ready(pending), one);
    }
    // Closing before initialization and reusing the number must not accept late messages from the old tab.
    {
        const f = fixture(),
            closing = f.open();
        const queued = closing.receive({ type: "saveWatch", panelId: 1, items: two });
        closing.dispose();
        const replacement = f.open();
        await queued;
        assert.strictEqual(f.entry(replacement).panelId, 1);
        assert.deepStrictEqual(await f.ready(replacement), one);
        assert.deepStrictEqual(f.values.get("mcu.watchList"), one);
    }
    // Corrupt persisted values cannot read unrelated workspace state or pick an arbitrary old list.
    {
        const f = fixture();
        for (const state of [{ panelId: -1 }, { panelId: Number.MAX_SAFE_INTEGER + 1 }, { watchKey: "mcu.debugger" }]) {
            const old = f.panel("Unknown chart");
            f.host.restoreLiveWatchPanel(old, state);
            assert.deepStrictEqual(await f.ready(old), []);
            assert.ok(Number.isSafeInteger(f.entry(old).panelId));
        }
    }
    console.log("Waveform panel identity, hidden tabs and restore isolation tests passed");
}

// Restored charts keep their curves; narrow sidebar rows keep values aligned
async function restore() {
    const fs = require("fs");
    // Charts reopened after a VS Code restart show the curves the user left on, and narrow sidebar
    // member rows keep their values right-aligned once the type badge is hidden.

    const items = [
        { name: "speed", type: "f32" },
        { name: "count", type: "u32" }
    ];
    const curveSaves = (view) => view.messages.filter((message) => message.type === "saveCurveVisibility");
    const swatch = (view, name) =>
        [...view.document.querySelectorAll(".var-card")]
            .find((card) => card.textContent.includes(name))
            ?.querySelector(".swatch");

    // A newly opened chart adopts the host's saved curves and reports changes back, but never
    // overwrites the host's copy before it has arrived.
    {
        const view = render(getLiveWatchContent({ panelId: 1 }, "en"), {});
        try {
            view.send({ type: "watchList", items });
            assert.deepStrictEqual(curveSaves(view), [], "no visibility is saved before the host's copy arrives");
            view.send({ type: "curveVisibility", hidden: { speed: true } });
            assert.ok(swatch(view, "speed").classList.contains("off"), "saved hidden curve stays hidden");
            assert.ok(!swatch(view, "count").classList.contains("off"), "saved visible curve stays visible");
            assert.deepStrictEqual(curveSaves(view).at(-1).hidden, { speed: true });
            assert.strictEqual(view.getState().panelId, 1, "the panel number is kept for restoring the tab");
            swatch(view, "count").click();
            assert.deepStrictEqual(curveSaves(view).at(-1).hidden, { speed: true, count: true });
            view.assertHealthy();
        } finally {
            view.close();
        }
    }

    // A tab VS Code restored keeps its own state rather than the host's copy.
    {
        const view = render(getLiveWatchContent({ panelId: 2 }, "en"), {
            panelId: 2,
            hidden: { count: true },
            pointerCurveDefaults: true
        });
        try {
            view.send({ type: "curveVisibility", hidden: { speed: true } });
            view.send({ type: "watchList", items });
            assert.ok(!swatch(view, "speed").classList.contains("off"));
            assert.ok(swatch(view, "count").classList.contains("off"));
            assert.deepStrictEqual(curveSaves(view).at(-1).hidden, { count: true });
            view.assertHealthy();
        } finally {
            view.close();
        }
    }

    // While DWARF types load, the host does not send a chart the empty list it cannot resolve yet;
    // the rebind afterwards sends the real one.
    {
        const Provider = loadProvider();
        const host = Object.create(Provider.prototype);
        const posted = [];
        Object.assign(host, {
            _elfService: { workerPath: "elfWorker.js", cache: { dwarfReady: false } },
            _watchLists: { read: () => items, invalidate() {} }
        });
        Object.assign(host._historyFeed, { configure() {} });
        Object.assign(host._sampling, { status: () => ({ running: false }) });
        const entry = { ready: true, watchKey: "mcu.watchList", latestSamples: new Map(), post: (m) => posted.push(m) };
        host._syncGraphTarget(entry, true);
        assert.ok(!posted.some((message) => message.type === "watchList"), "no unresolved list reaches the chart");
        host._elfService.cache.dwarfReady = true;
        host._syncGraphTarget(entry, true);
        assert.deepStrictEqual(posted.filter((message) => message.type === "watchList").at(-1).items, items);
    }

    // The member name, not the type badge, absorbs the free space, so hiding the badge in narrow
    // sidebars cannot move the value to the left.
    {
        const css = fs.readFileSync(path.resolve(__dirname, "../src/webview/sidebar/app.css"), "utf8");
        const block = (selector) => css.match(new RegExp(selector.replace(/[.>]/g, "\\$&") + "\\s*\\{([^}]*)\\}"))?.[1];
        assert.match(block(".sb-mrow > .sb-mname"), /margin-right:\s*auto/);
        assert.doesNotMatch(block(".sb-mrow > .sb-mtype"), /margin-left:\s*auto/);
        assert.match(
            css,
            /@media\(max-width:260px\)\{[^}]*#liveValues \.sb-mtype/,
            "narrow sidebars hide the type badge"
        );
    }

    console.log("Chart restore curve visibility and narrow sidebar alignment tests passed");
}

// Huge composites under memory and queue pressure keep sampling, the full archive and one warning
async function recording() {
    const fs = require("fs/promises");
    const parents = Array.from({ length: 2 }, (_, i) => ({
        name: "experiment" + i,
        address: 0x20000000 + i * 10000,
        size: 10000,
        isComposite: true,
        compositeLayout: {
            kind: "array",
            byteSize: 10000,
            dimensions: [10000],
            totalElements: 10000,
            elementType: { kind: "scalar", byteSize: 1, watchType: "u8" }
        }
    }));

    const warnings = [];
    const Provider = loadProvider({ window: { showWarningMessage: (message) => warnings.push(message) } });
    const p = Object.create(Provider.prototype);
    const messages = [];
    const entry = { watchKey: "p", latestSamples: new Map(), ready: true, post: (message) => messages.push(message) };
    const leaves = buildChartHistoryItems(parents, elf);
    assert.strictEqual(leaves.length, 20000);
    // Force memory degradation while keeping every leaf in the data of record.
    const store = new ChartHistoryStore(blockBytes(INITIAL_BLOCK_POINTS));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chart-recording-"));
    const archive = new SamplingArchive({ rootDir: dir });
    let archivedBatches = 0;
    const append = archive.append.bind(archive);
    archive.append = (...args) => {
        archivedBatches++;
        return append(...args);
    };
    Object.assign(p, {
        _livePanels: new Map([[1, entry]]),
        _scalarWatchList: (key) => (key === "p" ? parents : []),
        _context: { workspaceState: { get: () => [] } },
        _debugSamplingScope: (key) => key,
        _liveWatchService: new LiveWatchService(elf),
        _latestSidebarSamples: new Map(),
        _chartHistory: { request: async (method, args) => store[method](...args), fail: assert.fail },
        _samplingArchive: archive,
        _t: (key) => t("en", key)
    });
    Object.assign(p._sampling, {
        _postWebviewBatch() {},
        _postSidebarBatch() {},
        stop: () => assert.fail("memory history must never stop sampling")
    });
    try {
        p._historyFeed.configure(entry, 1000);
        for (let tick = 0; tick < 4; tick++) {
            const time = 1000 + tick * 20; // 50 Hz; disk archive remains independently authoritative.
            p._sampling.handleRawSamples(
                parents.map((parent) => ({ name: parent.name, t: time, bytes: Buffer.alloc(10000, tick) })),
                time
            );
            await p._historyFeed.flushPending();
        }
        assert.strictEqual(archivedBatches, 4);
        assert.strictEqual(store.status("p").limited, true);
        assert.strictEqual(store.status("p").bounds, null);
        // The waveform panel says it once in its own notice; there is no VS Code notification.
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(messages.filter((message) => message.type === "chartHistoryLimited").length, 1);
        // Realistic large composite batches can fill the shared host/IPC queue in a few ticks.
        const decoded = leaves.map(({ name }, i) => ({ name, value: i & 255, valueText: String(i & 255), t: 1100 }));
        const size = estimateHistoryBytes(["p", decoded, 1100]);
        assert.ok(size > 1024 * 1024 && size < MAX_BACKLOG_BYTES);
        p._chartHistory.queuedBytes = MAX_BACKLOG_BYTES - size + 1;
        p._sampling.handleRawSamples(
            parents.map((parent) => ({ name: parent.name, t: 1100, bytes: Buffer.alloc(10000, 4) })),
            1100
        );
        await p._historyFeed.flushPending();
        assert.strictEqual(archivedBatches, 5, "host queue pressure still appends the complete disk batch");
        assert.strictEqual(entry._historyBatch, null);
        assert.strictEqual(warnings.length, 0);
        const source = await archive.historySource("p");
        const records = decodeRecords(await fs.readFile(source.dataPath)).rows;
        assert.strictEqual(records.length, 5);
        assert.ok(records.every((record) => Object.keys(record.v).length === 20000));
        assert.strictEqual(records.at(-1).v[leaves.at(-1).name + " [u8]"], "4");
        p._chartHistory.failed = new Error("worker unavailable");
        p._sampling.handleRawSamples(
            parents.map((parent) => ({ name: parent.name, t: 1120, bytes: Buffer.alloc(10000, 5) })),
            1120
        );
        assert.strictEqual(archivedBatches, 6, "an unavailable memory worker also leaves disk recording active");
        // Genuine worker exit triggers automatic recovery while raw samples still reach the archive.
        const errors = [];
        p._postLive = (message) => errors.push(message);
        p._historyFeed.resetWarnings();
        // Restart backoff (250 ms, 1 s, 3 s) is not under test here; skip the real waits.
        p._historyFeed.recoveryDelaysMs = [0, 0, 0];
        let restarts = 0;
        let restores = 0;
        const recovering = new ChartHistoryService({
            onError: (error) => p._historyFeed.handleError(error)
        });
        const restart = recovering.restart.bind(recovering);
        recovering.restart = async () => {
            restarts++;
            return restart();
        };
        const request = recovering.request.bind(recovering);
        recovering.request = (method, args) => {
            if (method === "restore") {
                restores++;
                assert.ok(
                    Array.isArray(args[0].dictionary.channels),
                    "host forwards the binary dictionary in recovery"
                );
                assert.ok(Number.isSafeInteger(args[0].startOffset), "host forwards the indexed restore boundary");
            }
            return request(method, args);
        };
        p._chartHistory = recovering;
        const historySource = archive.historySource.bind(archive);
        let releaseSource;
        let enteredSource;
        const sourceEntered = new Promise((resolve) => {
            enteredSource = resolve;
        });
        const sourceGate = new Promise((resolve) => {
            releaseSource = resolve;
        });
        archive.historySource = async (scope) => {
            enteredSource();
            await sourceGate;
            return historySource(scope);
        };
        try {
            await recovering.request("configure", ["p", entry.historyItems]);
            await recovering.worker.terminate();
            await sourceEntered;
            const recovery = p._historyFeed.recovery;
            assert.strictEqual(p._historyFeed.recover(), recovery, "concurrent failures share one recovery");
            p._sampling.handleRawSamples(
                parents.map((parent) => ({ name: parent.name, t: 1140, bytes: Buffer.alloc(10000, 6) })),
                1140
            );
            assert.strictEqual(archivedBatches, 7, "archive appends continue during recovery");
            releaseSource();
            await recovery;
            assert.strictEqual(restarts, 1);
            assert.ok(restores >= 1, "recovery restores the archive");
            assert.strictEqual(recovering.failed, null);
            assert.strictEqual(errors.length, 0, "successful recovery reports no worker error");
            const status = await recovering.request("status", ["p"]);
            assert.ok(status.bounds.max >= 1140);
            p._sampling.handleRawSamples(
                parents.map((parent) => ({ name: parent.name, t: 1160, bytes: Buffer.alloc(10000, 7) })),
                1160
            );
            await p._historyFeed.flushPending();
            assert.strictEqual(archivedBatches, 8);
            assert.ok((await recovering.request("status", ["p"])).bounds.max >= 1160);

            // Recurring failures spend the same per-run restart budget and emit one localized error.
            recovering.request = (method, args) =>
                method === "restore" ? Promise.reject(new Error("restore unavailable")) : request(method, args);
            recovering.fail(new Error("worker failed again"));
            await p._historyFeed.recovery;
            assert.strictEqual(restarts, 3);
            assert.strictEqual(errors.length, 1);
            assert.strictEqual(errors[0].key, "lw.historyRecoveryFailed");
            assert.strictEqual(errors[0].message, t("en", "lw.historyRecoveryFailed"));
            assert.notStrictEqual(t("zh", "lw.historyRecoveryFailed"), errors[0].message);
            p._historyFeed.handleError(new Error("duplicate failure"));
            await p._historyFeed.recovery;
            assert.strictEqual(restarts, 3, "no restart storm after exhaustion");
            assert.strictEqual(errors.length, 1);
            p._sampling.handleRawSamples(
                parents.map((parent) => ({ name: parent.name, t: 1180, bytes: Buffer.alloc(10000, 8) })),
                1180
            );
            assert.strictEqual(archivedBatches, 9, "failed recovery still leaves recording active");
        } finally {
            releaseSource();
            archive.historySource = historySource;
            await recovering.dispose();
        }
    } finally {
        await p._historyFeed.flushPending();
        await archive.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    }

    // Service pressure keeps accepted batches and sends only one ordered marker per scope.
    const service = new ChartHistoryService();
    const sent = [];
    service.worker = { postMessage: (message) => sent.push(message), terminate: async () => {} };
    const samples = leaves.map(({ name }, i) => ({ name, value: i & 255, valueText: String(i & 255), t: 1000 }));
    const requests = [];
    while (!service.limitedScopes.size) requests.push(service.request("append", ["p", samples, 1000]));
    for (let i = 0; i < 20; i++) requests.push(service.request("append", ["p", samples, 1000 + i * 5]));
    assert.strictEqual(service.failed, null);
    assert.ok(service.queuedBytes <= MAX_BACKLOG_BYTES);
    assert.strictEqual(sent.filter((message) => message.method === "markLimited").length, 1);
    for (const message of sent) {
        const pending = service.pending.get(message.id);
        service.pending.delete(message.id);
        service.queuedBytes -= pending.bytes;
        pending.resolve({ limited: message.method === "markLimited" });
    }
    await Promise.all(requests);
    await service.dispose();

    // Exercise production start and clear dispatch: one warning per run/history clear.
    let receive;
    const resetWarnings = [];
    const ResetProvider = loadProvider({
        ViewColumn: { Active: 1 },
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        window: {
            showWarningMessage: (message) => resetWarnings.push(message),
            createWebviewPanel: () => ({
                webview: {
                    postMessage() {},
                    onDidReceiveMessage: (handler) => {
                        receive = handler;
                    }
                },
                onDidChangeViewState() {},
                onDidDispose() {}
            })
        }
    });
    const resetProvider = Object.create(ResetProvider.prototype);
    let clears = 0;
    const limited = [];
    Object.assign(resetProvider, {
        _context: { workspaceState: { get: () => undefined, update: async () => {} } },
        _postLive: (message) => message.type === "chartHistoryLimited" && limited.push(message),
        _livePanels: new Map(),
        _seriesStyleStore: {},
        _samplingArchive: {
            clear() {
                clears++;
            }
        },
        _chartHistory: { request: async () => ({}) },
        _renderWebview() {},
        _postProbeOperationStatus() {},
        _t: (key) => t("en", key)
    });
    Object.assign(resetProvider._sampling, { _start: async () => {} });
    Object.assign(resetProvider._sampling, { invalidateConsumerTypes() {} });
    resetProvider.openLiveWatchPanel();
    resetProvider._historyFeed.warnLimited();
    resetProvider._historyFeed.warnLimited();
    assert.strictEqual(limited.length, 1);
    assert.strictEqual(resetWarnings.length, 0, "the limit is a waveform notice, not a notification");
    await resetProvider._sampling.start([], 10);
    resetProvider._historyFeed.warnLimited();
    resetProvider._historyFeed.warnLimited();
    assert.strictEqual(limited.length, 2, "starting another run resets the warning");
    await receive({ type: "clearSamplingHistory", historyRevision: 1 });
    assert.strictEqual(clears, 1);
    resetProvider._historyFeed.warnLimited();
    resetProvider._historyFeed.warnLimited();
    assert.strictEqual(limited.length, 3, "clearing history resets the warning");

    // A newly plotted evicted curve goes through the real host viewport/restore dispatch.
    const restoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "chart-plot-restore-"));
    const plotArchive = new SamplingArchive({ rootDir: restoreDir });
    const plotStore = new ChartHistoryStore(blockBytes(INITIAL_BLOCK_POINTS) * 2);
    const plotEntry = [...resetProvider._livePanels.values()][0];
    const plotItems = [
        { name: "a", type: "u8", address: 1 },
        { name: "b", type: "u8", address: 2 }
    ];
    const plotScope = plotEntry.watchKey;
    const plotRequests = [];
    Object.assign(resetProvider, {
        _samplingArchive: plotArchive,
        _debugSamplingScope: (key) => key,
        _scalarWatchList: () => plotItems,
        _chartHistory: {
            request: async (method, args) => {
                plotRequests.push(method);
                return method === "restore"
                    ? require("../src/chartHistoryWorker").restoreHistory(plotStore, args[0])
                    : plotStore[method](...args);
            },
            fail: assert.fail
        }
    });
    plotEntry.historyItems = plotItems;
    plotEntry.historySignature = "plot";
    plotStore.configure(plotScope, plotItems);
    try {
        for (let frame = 0; frame <= INITIAL_BLOCK_POINTS; frame++) {
            const tick = frame * 10 + 1000;
            const samples = plotItems.map((item) => ({ name: item.name, value: frame, t: tick }));
            plotStore.append(plotScope, samples, tick);
            plotArchive.append(
                samples.map((sample) => ({ ...sample, name: sample.name + " [u8]" })),
                tick,
                plotScope
            );
        }
        assert.strictEqual(plotStore._scope(plotScope).series.get("a").count, 1);
        await receive({
            type: "chartViewport",
            historyRevision: 1,
            names: ["a"],
            range: { min: 1000, max: 1640 },
            width: 1,
            requestId: 1
        });
        assert.ok(plotRequests.includes("restore"));
        assert.strictEqual(plotStore._scope(plotScope).series.get("a").count, 65);
        assert.strictEqual(plotStore.status(plotScope).bounds.min, 1000);
        assert.ok(plotStore.bytes <= plotStore.maxBytes);
    } finally {
        await plotArchive.dispose();
        await fs.rm(restoreDir, { recursive: true, force: true });
    }

    const page = render(getLiveWatchContent({}, "en"));
    try {
        page.send({
            type: "chartHistoryStatus",
            revision: 1,
            bounds: { min: 2000, max: 3000 },
            variables: ["value"],
            limited: true,
            historyRevision: 0
        });
        assert.strictEqual(page.window.eval("state").remoteHistory.status.limited, true);
        assert.strictEqual(page.window.retainedTimeBounds().min, 2000);
        assert.strictEqual(
            page.document.querySelector('#lwNotice [data-notice-id="history-limited"] .notice-text').textContent,
            t("en", "lw.memoryHistoryLimited")
        );
        page.window.eval("state").remoteHistory.view = { series: [{ name: "stale" }] };
        page.window.eval("state").remoteHistory.overview = { series: [{ name: "stale" }] };
        page.send({
            type: "chartHistoryStatus",
            revision: 2,
            bounds: null,
            variables: [],
            limited: true,
            historyRevision: 0
        });
        assert.strictEqual(page.window.retainedTimeBounds(), null);
        assert.strictEqual(page.window.eval("state").remoteHistory.view, null);
        assert.strictEqual(page.window.eval("state").remoteHistory.overview, null);
        page.assertHealthy();
    } finally {
        page.close();
    }
    console.log("Huge composite memory/queue pressure preserves sampling, full disk archive and once-only warning");
}

// Viewport transport: round-trip, precision, gaps, validation, transfer and size
async function transport() {
    const fs = require("fs");
    const store = new ChartHistoryStore();
    const items = [
        { name: "counter", type: "u64" },
        { name: "signal", type: "f64" },
        { name: "signed", type: "i64" }
    ];
    const exact = "18446744073709551615";
    store.configure("p", items);
    store.append(
        "p",
        [
            { name: "counter", t: 1, value: Number(exact), valueText: exact },
            { name: "counter", t: 2, value: null },
            { name: "counter", t: 3, value: 2 ** 53 - 1 },
            { name: "signal", t: 1, value: -0, valueText: "-0" },
            { name: "signal", t: 2, value: null },
            { name: "signal", t: 3, value: 1.23456789012345 },
            { name: "signed", t: 1, value: -9223372036854775808, valueText: "-9223372036854775808" }
        ],
        3
    );
    const original = store.viewport(
        "p",
        items.map((item) => item.name),
        { min: 0, max: 4 },
        100
    );
    assert.strictEqual(original.series.length, 5, "missing samples split both channels into continuous segments");
    const before = structuredClone(original);
    const { message, transfer } = encodeViewport(original);
    assert.notStrictEqual(message, original);
    assert.deepStrictEqual(original, before, "encoding leaves store output intact");
    for (const key of Object.keys(original).filter((key) => key !== "series"))
        assert.strictEqual(message[key], original[key], `status property ${key} is passed through untouched`);
    assert.strictEqual(message.series.length, 3, "each consecutive name run shares one set of columns");
    assert.deepStrictEqual([...message.series[0].ends], [1, 2]);
    assert.deepStrictEqual(message.series[0].texts, [[0, exact]]);
    assert.deepStrictEqual(decodeViewport(message.series), original.series);
    assert.ok(Object.is(message.series[1].v[0], -0));
    assert.ok(Object.is(decodeViewport(message.series)[2].arr[0].v, -0));
    assert.strictEqual(message.series[0].v[1], 2 ** 53 - 1, "safe integers stay exact in Float64");

    const buffers = message.series.flatMap((entry) => [
        entry.t.buffer,
        entry.v.buffer,
        entry.ends.buffer,
        entry.visibleCounts.buffer
    ]);
    assert.strictEqual(new Set(transfer).size, transfer.length);
    assert.deepStrictEqual(transfer, buffers);
    assert.ok(transfer.every((buffer) => buffer instanceof ArrayBuffer));
    const cloned = structuredClone(message, { transfer });
    assert.ok(
        transfer.every((buffer) => buffer.byteLength === 0),
        "the transfer list detaches every source buffer"
    );
    assert.deepStrictEqual(decodeViewport(cloned.series), original.series);

    const legacy = { name: "a", item: {}, arr: [{ t: 1, v: -0, valueText: "-0" }] };
    const zeroCount = { ...legacy, arr: [], visibleCount: 0 };
    const other = { ...legacy, name: "b" };
    const runs = encodeViewport({ series: [legacy, zeroCount, other, legacy], evictedNames: ["evicted"] });
    assert.deepStrictEqual(runs.message.evictedNames, ["evicted"]);
    assert.deepStrictEqual(
        runs.message.series.map((entry) => entry.name),
        ["a", "b", "a"]
    );
    assert.deepStrictEqual([...runs.message.series[0].ends], [1, 1], "empty segments retain their boundary");
    assert.ok(Number.isNaN(runs.message.series[0].visibleCounts[0]));
    assert.deepStrictEqual(decodeViewport(runs.message.series), [legacy, zeroCount, other, legacy]);
    assert.strictEqual(decodeViewport([legacy])[0], legacy, "legacy entries pass through by identity");
    assert.deepStrictEqual(decodeViewport([legacy, runs.message.series[0], other]), [legacy, legacy, zeroCount, other]);
    assert.strictEqual(decodeViewport(runs.message.series)[0].visibleCount, undefined);
    for (const input of [undefined, null, {}, "series", 42]) assert.deepStrictEqual(decodeViewport(input), []);
    assert.deepStrictEqual(encodeViewport({ series: [], bounds: null }), {
        message: { series: [], bounds: null },
        transfer: []
    });
    assert.deepStrictEqual(decodeViewport([]), []);

    const withoutText = encodeViewport({
        series: [
            {
                name: "plain",
                item: {},
                arr: [
                    { t: 1, v: -0 },
                    { t: 2, v: 2, valueText: 123 }
                ]
            }
        ]
    });
    assert.deepStrictEqual(withoutText.message.series[0].texts, []);
    assert.deepStrictEqual(decodeViewport(withoutText.message.series)[0].arr, [
        { t: 1, v: -0, valueText: null },
        { t: 2, v: 2, valueText: null }
    ]);

    const packed = cloned.series[0];
    const malformed = [
        null,
        undefined,
        1,
        "bad",
        {},
        { ...packed, t: [...packed.t] },
        { ...packed, t: new Float32Array(2) },
        { ...packed, v: new Float32Array(2) },
        { ...packed, t: new DataView(new ArrayBuffer(16)) },
        { ...packed, v: new Float64Array(1) },
        { ...packed, ends: [1, 2] },
        { ...packed, ends: new Int32Array([1, 2]) },
        { ...packed, ends: new Uint32Array([2, 1]) },
        { ...packed, ends: new Uint32Array([1, 3]) },
        { ...packed, ends: new Uint32Array([1, 1]) },
        { ...packed, visibleCounts: new Float32Array(2) },
        { ...packed, visibleCounts: new Float64Array(1) },
        { ...packed, texts: null },
        { ...packed, texts: Array(1) },
        ...[null, {}, [], [0], [-1, "x"], [2, "x"], [0.5, "x"], [NaN, "x"], [0, null], [0, 1], [0, "x", 1]].map(
            (text) => ({
                ...packed,
                texts: [text]
            })
        )
    ];
    for (const entry of malformed) assert.deepStrictEqual(decodeViewport([entry, legacy]), [legacy]);

    // The browser UMD export must accept typed arrays cloned in another realm.
    const browser = vm.createContext({});
    vm.runInContext(fs.readFileSync(require.resolve("../src/webview/liveWatch/chartTransport"), "utf8"), browser);
    assert.deepStrictEqual(
        structuredClone(browser.EmberProbeChartTransport.decodeViewport(cloned.series)),
        original.series
    );

    const large = {
        series: Array.from({ length: 10 }, (_, channel) => ({
            name: `channel${channel}`,
            item: { type: "f64" },
            arr: Array.from({ length: 4800 }, (_, i) => ({
                t: 1700000000000 + i * 375,
                v: Math.sin(i + channel),
                valueText: null
            })),
            visibleCount: 360000
        }))
    };
    const largePacked = encodeViewport(large);
    const packedBytes =
        largePacked.transfer.reduce((sum, buffer) => sum + buffer.byteLength, 0) +
        Buffer.byteLength(
            JSON.stringify(largePacked.message, (key, value) => (ArrayBuffer.isView(value) ? undefined : value))
        );
    assert.ok(
        packedBytes < Buffer.byteLength(JSON.stringify(large)) * 0.35,
        "packed replies are less than 35% of legacy JSON bytes"
    );
    assert.deepStrictEqual(decodeViewport(largePacked.message.series), large.series);
    console.log("Chart transport round-trip, precision, gaps, validation, transfer and size tests passed");
}

(async () => {
    await scenario("Panel migration, multi-panel styles, history batches and snapshot export", panels);
    await scenario("Panel identity, hidden tabs and restore isolation", identity);
    await scenario("Restored charts keep their curves; narrow sidebar rows keep values aligned", restore);
    await scenario(
        "Huge composites under memory and queue pressure keep sampling, the full archive and one warning",
        recording
    );
    await scenario("Viewport transport: round-trip, precision, gaps, validation, transfer and size", transport);
    console.log("Chart host, panel identity, restore, recording and transport tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
