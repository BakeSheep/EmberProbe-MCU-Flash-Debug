"use strict";
const os = require("os");
const path = require("path");
const { CACHE_KEYS } = require("../cacheKeys");
const { toUiError } = require("../services/errorEnvelope");
const { appendMissingWatchItems } = require("../services/watchListStore");
const { displayWarnings } = require("../webview/elfDiagnostics");
const { SHARED_ROUTES, isWebviewMessage, routeFor } = require("./webviewRoutes");

// Requests the chart answers from its history worker, each with a "<type>Result" reply.
const CHART_HISTORY_REQUESTS = new Set(["chartViewport", "chartFreeze", "chartResume"]);

// Chart watch lists in panel order: mcu.watchList, then mcu.watchList.2, mcu.watchList.3, ...
function chartWatchLists(workspaceState) {
    const prefix = CACHE_KEYS.watchList + ".";
    const order = (key) => Number(key.slice(prefix.length)) || 1;
    return workspaceState
        .keys()
        .filter((key) => key === CACHE_KEYS.watchList || key.startsWith(prefix))
        .sort((a, b) => order(a) - order(b))
        .map((key) => workspaceState.get(key) || []);
}

async function ready({ host, entry, post, watchKey }) {
    entry.ready = true;
    await host._seriesStyleStore.initialize(chartWatchLists(host._context.workspaceState));
    post({ type: "seriesStyles", styles: host._seriesStyleStore.styles });
    post(host._chartBackgroundState());
    host.chartBackground().ready(entry);
    post(host._sampling.unlimitedState());
    post(host._sampling.pointerState());
    post({ type: "chartHistoryReady", historyRevision: entry.historyRevision || 0 });
    post({ type: "curveVisibility", hidden: host._curveVisibility(watchKey) });
    host._syncGraphTarget(entry);
    if (host._sampling.session) {
        const active = host._sampling.activeReadPlan();
        if (active.length) host._sampling.applySamplingPlan(host._sampling.session, active);
    }
    if (host._chartHistory) {
        const scope = host._debugSamplingScope(watchKey);
        const revision = entry.historyRevision || 0;
        host._historyFeed.flushAppend(entry);
        const status = await host._chartHistory.request("status", [scope]);
        if (scope === host._debugSamplingScope(watchKey) && revision === (entry.historyRevision || 0))
            post({ type: "chartHistoryStatus", ...status, historyRevision: revision });
    }
}

async function importVariables({ host, post }, message) {
    const wasLoading = !!host._elfService.resolveSymbols || !host._elfView.version(host._elfService.cache);
    const result = await host._elfService.load();
    if (wasLoading || message.version === host._elfView.version(result))
        post({ type: "variablesListDone", version: host._elfView.version(result), warnings: displayWarnings(result) });
    else host._elfView.sendSnapshot(post, "variablesList");
}

async function importSidebarWatch({ host, post, watchKey }, message) {
    const saved = host._scalarWatchList(watchKey);
    const current = appendMissingWatchItems(message.items, saved);
    const sidebarItems = host._scalarWatchList(CACHE_KEYS.sidebarWatchList);
    const merged = appendMissingWatchItems(current, sidebarItems);
    if (JSON.stringify(merged) !== JSON.stringify(saved)) await host._saveWatchList(watchKey, merged);
    post({ type: "sidebarImportResult", added: merged.length - current.length, sourceCount: sidebarItems.length });
}

async function clearSamplingHistory({ host, entry, post, watchKey }, message) {
    host._historyFeed.resetWarnings();
    host._historyFeed.discardAppend(entry);
    entry.historyClearedAt = Date.now();
    entry.historyRevision = message.historyRevision;
    host._samplingArchive.clear(host._debugSamplingScope(watchKey));
    entry.latestSamples.clear();
    if (entry._batchTimer) clearTimeout(entry._batchTimer);
    entry._batchTimer = null;
    entry._pendingScalars = [];
    entry._pendingComposites = [];
    if (host._chartHistory && !host._chartHistory.failed)
        await host._chartHistory.request("clear", [
            host._debugSamplingScope(watchKey),
            host._samplingArchive.generations?.get(host._debugSamplingScope(watchKey)) || 0
        ]);
    host._chartHistory?.archiveProgress(
        {
            dataPath: host._samplingArchive.dataPath,
            bytes: host._samplingArchive.indexedBytes,
            limited: host._samplingArchive.limitReached || !!host._samplingArchive.failed
        },
        true
    );
    post({ type: "samplingHistoryCleared", historyRevision: message.historyRevision });
}

async function chartHistoryRequest({ host, entry, post, watchKey }, message) {
    if (!host._chartHistory) return;
    if ((message.historyRevision || 0) !== (entry.historyRevision || 0)) return;
    const scope = host._debugSamplingScope(watchKey);
    const revision = entry.historyRevision || 0;
    host._historyFeed.flushAppend(entry);
    let result;
    if (message.type === "chartViewport") {
        const watched = new Set((entry.historyItems || host._scalarWatchList(watchKey)).map((item) => item.name));
        const names = Array.isArray(message.names) ? message.names.filter((name) => watched.has(name)) : [];
        const previousNames = new Set(entry.historyViewportNames || []);
        if (!message.snapshotId) entry.historyViewportNames = names;
        result = await host._chartHistory.request("viewport", [
            scope,
            names,
            message.range,
            message.width,
            message.snapshotId
        ]);
        const restoreNames = (result.evictedNames || []).filter((name) => !previousNames.has(name));
        if (!message.snapshotId && restoreNames.length && !host._historyFeed.recovery) {
            await host._historyFeed.restore(entry, restoreNames);
            result = await host._chartHistory.request("viewport", [scope, names, message.range, message.width]);
        }
    } else if (message.type === "chartFreeze") result = await host._chartHistory.request("freeze", [scope]);
    else result = await host._chartHistory.request("resume", [scope]);
    if (scope === host._debugSamplingScope(watchKey) && revision === (entry.historyRevision || 0))
        post({
            type: message.type + "Result",
            ...result,
            requestId: message.requestId,
            historyRevision: revision,
            snapshotId: result?.snapshotId || message.snapshotId
        });
}

// Treats webview input as a file name, never as a relative or absolute path; anything else gets a timestamped name.
function csvExportFileName(requested, now = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    const defaultName = `emberprobe-live-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;
    const name = typeof requested === "string" ? requested.trim().replace(/\.csv$/i, "") : "";
    return name &&
        name.length <= 180 &&
        !/[<>:"/\\|?*\u0000-\u001f]/.test(name) &&
        !/[. ]$/.test(name) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
        ? name + ".csv"
        : defaultName;
}

async function exportCsv({ host, entry, post, watchKey, vscode }, message) {
    const archiveScope = host._debugSamplingScope(watchKey);
    const historyRevision = entry.historyRevision || 0;
    const displayNames = host._displayNamesForSeries(
        watchKey,
        Array.isArray(message.names) && message.names.length
            ? message.names
            : host._samplingArchive.status(archiveScope).variables
    );
    const name = csvExportFileName(message.fileName);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
        defaultUri: folder
            ? vscode.Uri.joinPath(folder, name)
            : vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), name),
        filters: { CSV: ["csv"] }
    });
    if (!target) {
        post({ type: "exportCsvResult", ok: false, cancelled: true });
        return;
    }
    try {
        if (
            archiveScope !== host._debugSamplingScope(watchKey) ||
            historyRevision !== (entry.historyRevision || 0) ||
            (message.historyRevision !== undefined && message.historyRevision !== historyRevision)
        )
            throw new Error("History changed before export");
        const result = await host._exportArchiveCsvWithProgress(post, {
            scope: archiveScope,
            outputPath: target.fsPath,
            names: message.names,
            displayNames,
            fromMs: message.fromMs,
            toMs: message.toMs
        });
        // The panel's notice offers "reveal in folder" for the file it just wrote.
        entry._lastCsvExport = target;
        post({
            type: "exportCsvResult",
            ok: true,
            file: path.basename(target.fsPath),
            seriesCount: result.seriesCount,
            rowCount: result.rows
        });
    } catch (error) {
        if (error.code === "CSV_EXPORT_CANCELLED")
            post({ type: "exportCsvResult", ok: false, cancelled: true, aborted: true });
        else post({ type: "exportCsvResult", ok: false, message: error.message });
    }
}

const LIVE_PANEL_ROUTES = {
    ...SHARED_ROUTES,
    ready,
    importVariables,
    importSidebarWatch,
    clearSamplingHistory,
    ...Object.fromEntries([...CHART_HISTORY_REQUESTS].map((type) => [type, chartHistoryRequest])),
    exportCsv,
    chartBackgroundIconImported: ({ host, entry }, message) => host.chartBackground().imported(entry, message),
    saveCurveVisibility: ({ host, watchKey }, message) => host._saveCurveVisibility(watchKey, message.hidden),
    setPointerExpandedOnly: async ({ host, post }, message) => {
        try {
            await host._sampling.setPointerExpandedOnly(message.enabled);
        } finally {
            post(host._sampling.pointerState());
        }
    },
    setSeriesStyle: async ({ host }, message) => {
        const styles = await host._seriesStyleStore.update(message.name, message.style);
        for (const target of host._livePanels.values()) target.post({ type: "seriesStyles", styles });
    },
    resolveVariable: ({ host, post }, message) => host._resolveLiveVariable(message, post),
    saveWatch: ({ host, watchKey }, message) => host._saveWatchList(watchKey, message.items || []),
    start: async ({ host, watchKey }, message) => {
        await host._saveWatchList(watchKey, message.items || []);
        if (message.frequencyHz !== undefined) await host._sampling.saveFrequency(message.frequencyHz);
        await host._sampling.start(message.items || [], host._sampling.intervalMs, "graph");
    },
    stop: ({ host }) => {
        if (host._agentOps.readRunning) host._agentOps.stopReadIfRunning();
        else host._sampling.stop({ variablesOnly: true });
    },
    setInterval: ({ host }, message) => host._sampling.setIntervalMs(message.intervalMs),
    setFrequency: ({ host }, message) => host._sampling.saveFrequency(message.frequencyHz),
    setUnlimitedSampling: async ({ host, post }, message) => {
        try {
            await host._sampling.setUnlimited(message.enabled);
        } finally {
            // Resynchronise the toggle even when the request was rejected.
            post(host._sampling.unlimitedState());
        }
    },
    samplingArchiveInfo: ({ host, post, watchKey }, message) => {
        const history = host._samplingArchive.status(host._debugSamplingScope(watchKey));
        post({
            type: "samplingArchiveInfo",
            historyRevision: message.historyRevision,
            openExport: message.openExport === true,
            ...history,
            displayNames: Object.fromEntries(host._displayNamesForSeries(watchKey, history.variables))
        });
    },
    revealCsvExport: ({ entry, vscode }) => {
        if (entry._lastCsvExport) vscode.commands.executeCommand("revealFileInOS", entry._lastCsvExport);
    }
};

// The message handler of one chart panel. Messages wait until the panel's identity is stored; one naming another
// panel is refused, and a failed one comes back to the panel as liveError.
function createLivePanelHandler(host, entry, vscode) {
    const page = { host, entry, vscode, post: entry.post, watchKey: entry.watchKey };
    return async (message) => {
        if (!isWebviewMessage(message)) return;
        try {
            if (entry.initializing) await entry.initialized;
            if (entry.disposed) return;
            if (entry.initializationError) throw entry.initializationError;
            if (message.panelId !== undefined && Number(message.panelId) !== entry.panelId) {
                throw Object.assign(new Error("Live panel identity mismatch"), { code: "INVALID_PANEL_ID" });
            }
            const route = routeFor(LIVE_PANEL_ROUTES, message);
            if (route) await route(page, message);
        } catch (error) {
            if (CHART_HISTORY_REQUESTS.has(message.type)) {
                if (host._chartHistory?.failed || host._historyFeed.recovery) return;
                page.post({
                    type: message.type + "Result",
                    requestId: message.requestId,
                    historyRevision: message.historyRevision,
                    error: error.message
                });
            }
            page.post({ type: "liveError", ...toUiError(error) });
        }
    };
}

module.exports = { LIVE_PANEL_ROUTES, createLivePanelHandler, csvExportFileName };
