"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const elf = require("../src/elfSymbols");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { LiveWatchService, buildChartHistoryItems } = require("../src/services/liveWatchService");
const { ChartHistoryStore, INITIAL_BLOCK_POINTS, blockBytes } = require("../src/services/chartHistoryStore");
const { ChartHistoryService, MAX_BACKLOG_BYTES, estimateHistoryBytes } = require("../src/services/chartHistoryService");
const { SamplingArchive } = require("../src/services/samplingArchive");
const { decodeRecords } = require("../src/services/samplingArchiveFormat");
const { t } = require("../src/i18n");

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

(async () => {
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
        _postWebviewBatch() {},
        _postSidebarBatch() {},
        _t: (key) => t("en", key),
        stopLiveWatch: () => assert.fail("memory history must never stop sampling")
    });
    try {
        p._configureChartHistory(entry, 1000);
        for (let tick = 0; tick < 4; tick++) {
            const time = 1000 + tick * 20; // 50 Hz; disk archive remains independently authoritative.
            p._handleRawSamples(
                parents.map((parent) => ({ name: parent.name, t: time, bytes: Buffer.alloc(10000, tick) })),
                time
            );
            await p._flushPendingChartHistorySamples();
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
        p._handleRawSamples(
            parents.map((parent) => ({ name: parent.name, t: 1100, bytes: Buffer.alloc(10000, 4) })),
            1100
        );
        await p._flushPendingChartHistorySamples();
        assert.strictEqual(archivedBatches, 5, "host queue pressure still appends the complete disk batch");
        assert.strictEqual(entry._historyBatch, null);
        assert.strictEqual(warnings.length, 0);
        const source = await archive.historySource("p");
        const records = decodeRecords(await fs.readFile(source.dataPath)).rows;
        assert.strictEqual(records.length, 5);
        assert.ok(records.every((record) => Object.keys(record.v).length === 20000));
        assert.strictEqual(records.at(-1).v[leaves.at(-1).name + " [u8]"], "4");
        p._chartHistory.failed = new Error("worker unavailable");
        p._handleRawSamples(
            parents.map((parent) => ({ name: parent.name, t: 1120, bytes: Buffer.alloc(10000, 5) })),
            1120
        );
        assert.strictEqual(archivedBatches, 6, "an unavailable memory worker also leaves disk recording active");
        // Genuine worker exit triggers automatic recovery while raw samples still reach the archive.
        const errors = [];
        p._postLive = (message) => errors.push(message);
        p._resetChartHistoryWarnings();
        // Restart backoff (250 ms, 1 s, 3 s) is not under test here; skip the real waits.
        p._chartHistoryRecoveryDelaysMs = [0, 0, 0];
        let restarts = 0;
        let restores = 0;
        const recovering = new ChartHistoryService({
            onError: (error) => p._handleChartHistoryError(error)
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
            const recovery = p._chartHistoryRecovery;
            assert.strictEqual(p._recoverChartHistory(), recovery, "concurrent failures share one recovery");
            p._handleRawSamples(
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
            p._handleRawSamples(
                parents.map((parent) => ({ name: parent.name, t: 1160, bytes: Buffer.alloc(10000, 7) })),
                1160
            );
            await p._flushPendingChartHistorySamples();
            assert.strictEqual(archivedBatches, 8);
            assert.ok((await recovering.request("status", ["p"])).bounds.max >= 1160);

            // Recurring failures spend the same per-run restart budget and emit one localized error.
            recovering.request = (method, args) =>
                method === "restore" ? Promise.reject(new Error("restore unavailable")) : request(method, args);
            recovering.fail(new Error("worker failed again"));
            await p._chartHistoryRecovery;
            assert.strictEqual(restarts, 3);
            assert.strictEqual(errors.length, 1);
            assert.strictEqual(errors[0].key, "lw.historyRecoveryFailed");
            assert.strictEqual(errors[0].message, t("en", "lw.historyRecoveryFailed"));
            assert.notStrictEqual(t("zh", "lw.historyRecoveryFailed"), errors[0].message);
            p._handleChartHistoryError(new Error("duplicate failure"));
            await p._chartHistoryRecovery;
            assert.strictEqual(restarts, 3, "no restart storm after exhaustion");
            assert.strictEqual(errors.length, 1);
            p._handleRawSamples(
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
        await p._flushPendingChartHistorySamples();
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
        _postLive: (message) => message.type === "chartHistoryLimited" && limited.push(message),
        _livePanels: new Map(),
        _seriesStyleStore: {},
        _samplingArchive: {
            clear() {
                clears++;
            }
        },
        _chartHistory: { request: async () => ({}) },
        _invalidateConsumerTypes() {},
        _renderWebview() {},
        _postProbeOperationStatus() {},
        _startLiveWatch: async () => {},
        _t: (key) => t("en", key)
    });
    resetProvider.openLiveWatchPanel();
    resetProvider._warnChartHistoryLimited();
    resetProvider._warnChartHistoryLimited();
    assert.strictEqual(limited.length, 1);
    assert.strictEqual(resetWarnings.length, 0, "the limit is a waveform notice, not a notification");
    await resetProvider.startLiveWatch([], 10);
    resetProvider._warnChartHistoryLimited();
    resetProvider._warnChartHistoryLimited();
    assert.strictEqual(limited.length, 2, "starting another run resets the warning");
    await receive({ type: "clearSamplingHistory", historyRevision: 1 });
    assert.strictEqual(clears, 1);
    resetProvider._warnChartHistoryLimited();
    resetProvider._warnChartHistoryLimited();
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

    const page = render(getLiveWatchContent({ backendHistory: true }, "en"));
    try {
        page.send({
            type: "chartHistoryStatus",
            revision: 1,
            bounds: { min: 2000, max: 3000 },
            variables: ["value"],
            limited: true,
            historyRevision: 0
        });
        assert.strictEqual(page.window.remoteHistory.status.limited, true);
        assert.strictEqual(page.window.retainedTimeBounds().min, 2000);
        assert.strictEqual(
            page.document.querySelector('#lwNotice [data-notice-id="history-limited"] .notice-text').textContent,
            t("en", "lw.memoryHistoryLimited")
        );
        page.window.remoteHistory.view = { series: [{ name: "stale" }] };
        page.window.remoteHistory.overview = { series: [{ name: "stale" }] };
        page.send({
            type: "chartHistoryStatus",
            revision: 2,
            bounds: null,
            variables: [],
            limited: true,
            historyRevision: 0
        });
        assert.strictEqual(page.window.retainedTimeBounds(), null);
        assert.strictEqual(page.window.remoteHistory.view, null);
        assert.strictEqual(page.window.remoteHistory.overview, null);
        page.assertHealthy();
    } finally {
        page.close();
    }
    console.log("Huge composite memory/queue pressure preserves sampling, full disk archive and once-only warning");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
