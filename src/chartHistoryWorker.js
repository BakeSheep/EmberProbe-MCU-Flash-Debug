"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const { WINDOW_MS } = require("./services/chartHistoryStore");
const { ArchiveChartHistoryStore } = require("./services/archiveChartHistoryStore");
const { readArchive } = require("./services/samplingArchiveFormat");
const { serializeError } = require("./services/errorEnvelope");
const { encodeViewport } = require("./webview/liveWatch/chartTransport");

async function restoreHistory(store, request) {
    if (!request.cutoff || !Number.isFinite(request.lastTimestampMs)) return store.status(request.scope);
    const state = store._scope(request.scope);
    const selected = request.names && new Set(request.names);
    store.latestTick = Math.max(store.latestTick, request.lastTimestampMs);
    for (const series of state.series.values()) if (series.viewed) series.lastViewportUse = store.latestTick;
    if (selected && !request.fromOffset) {
        // Replace only newly plotted, evicted channels; frozen/export references remain intact.
        for (const name of selected) {
            const series = state.series.get(name);
            if (!series) continue;
            const viewed = !!series.viewed;
            store._release(series, true);
            series.parts = [];
            series.count = 0;
            series.discontinuous = false;
            series.evicted = false;
            store._viewed(series, viewed);
        }
        state.revision++;
    }
    const names = new Map(
        [...state.series]
            .filter(([name]) => !selected || selected.has(name))
            .map(([name, s]) => [`${name} [${s.item.type}]`, name])
    );
    let expectedRevision = state.revision;
    if ((request.fromOffset || 0) >= request.cutoff) return store.status(request.scope);
    const checkUnchanged = () => {
        if (store.scopes.get(request.scope) !== state || state.revision !== expectedRevision)
            throw Object.assign(new Error("History changed while restoring"), {
                code: "CHART_HISTORY_RESTORE_CANCELLED"
            });
    };
    const records = readArchive(request.dataPath, {
        start: request.fromOffset ?? request.startOffset ?? 0,
        end: request.cutoff,
        dictionary: request.dictionary
    });
    try {
        for await (const record of records) {
            checkUnchanged();
            if (
                record.scope !== request.scope ||
                (record.generation || 0) !== request.generation ||
                !Number.isFinite(record.t) ||
                record.t < request.lastTimestampMs - WINDOW_MS
            )
                continue;
            const samples = Object.entries(record.v || {})
                .filter(([key]) => {
                    const name = names.get(key),
                        series = store._scope(request.scope).series.get(name);
                    return (
                        series &&
                        record.t >= (series.item.historyFromMs ?? -Infinity) &&
                        (!record.identities?.[key] || record.identities[key] === series.identity)
                    );
                })
                .map(([key, text]) => ({
                    name: names.get(key),
                    t: record.t,
                    value: text === null ? null : Number(text),
                    valueText: text
                }));
            store.append(request.scope, samples, record.t);
            expectedRevision = state.revision;
        }
        // A clear/configure handled while awaiting end-of-file discarded what was restored.
        checkUnchanged();
    } finally {
        await records.return(undefined);
    }
    return store.status(request.scope);
}

function run(port, options = {}) {
    const store = new ArchiveChartHistoryStore(options);
    const timers = new Map();
    const update = (scope) => {
        if (timers.has(scope)) return;
        timers.set(
            scope,
            setTimeout(() => {
                timers.delete(scope);
                port.postMessage({ event: "updated", scope, ...store.status(scope) });
            }, 80)
        );
    };
    port.on("message", async ({ id, method, args = [] }) => {
        try {
            let result;
            if (method === "restore") result = await restoreHistory(store, args[0]);
            else if (
                [
                    "configure",
                    "append",
                    "markLimited",
                    "markGap",
                    "status",
                    "viewport",
                    "touchViewport",
                    "freeze",
                    "resume",
                    "release",
                    "archiveProgress",
                    "clear",
                    "remove",
                    "setBudget"
                ].includes(method)
            ) {
                const operation =
                    method === "viewport" ? "archiveViewport" : method === "freeze" ? "freezeArchive" : method;
                result = await store[operation](...args);
                if (method === "configure") {
                    await store.resolveBounds(args[0]);
                    result = store.status(args[0]);
                }
                if (["markLimited", "configure", "clear"].includes(method)) update(args[0]);
                // An append can evict live blocks belonging to another panel under the shared budget.
                if (["append", "setBudget", "archiveProgress"].includes(method))
                    for (const scope of store.scopes.keys()) update(scope);
                if (method === "remove" && timers.has(args[0])) {
                    clearTimeout(timers.get(args[0]));
                    timers.delete(args[0]);
                }
            } else throw new Error("Unknown history operation");
            if (id) {
                if (method === "viewport") {
                    const { message, transfer } = encodeViewport(result);
                    port.postMessage({ id, result: message }, transfer);
                } else port.postMessage({ id, result });
            }
        } catch (error) {
            port.postMessage(
                id ? { id, error: serializeError(error) } : { event: "error", error: serializeError(error) }
            );
        }
    });
    port.on("close", () => {
        for (const timer of timers.values()) clearTimeout(timer);
    });
}
if (!isMainThread && require.main === module) run(parentPort, workerData);
module.exports = { run, restoreHistory };
