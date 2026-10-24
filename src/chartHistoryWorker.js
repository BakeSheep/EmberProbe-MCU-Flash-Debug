"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { WINDOW_MS } = require("./services/chartHistoryStore");
const { ArchiveChartHistoryStore } = require("./services/archiveChartHistoryStore");
const { csvField, csvHeaderField } = require("./services/samplingArchive");
const { createSampleTimeFormatter } = require("./services/sampleTime");
const { readArchive } = require("./services/samplingArchiveFormat");
const { serializeError } = require("./services/errorEnvelope");
const { encodeViewport } = require("./webview/liveWatch/chartTransport");

async function exportHistory(store, request) {
    const capture = store.freeze(request.scope, "export", request.snapshotId);
    const source = store._source(request.scope, capture.snapshotId);
    const names = [...new Set(request.names)].filter((name) => source.series.get(name)?.count);
    const outputPath = path.resolve(request.outputPath);
    if (path.extname(outputPath).toLowerCase() !== ".csv") {
        store.release(capture.snapshotId);
        throw new Error("A CSV output path is required");
    }
    const temporary = path.join(
        path.dirname(outputPath),
        `.${path.basename(outputPath)}.${crypto.randomBytes(8).toString("hex")}.tmp`
    );
    let output;
    try {
        if (!names.length)
            throw Object.assign(new Error("No retained samples are available"), { code: "CSV_EXPORT_EMPTY" });
        const from = request.fromMs ?? -Infinity,
            to = request.toMs ?? Infinity;
        if (from > to) throw new Error("Invalid CSV range");
        output = await fsp.open(temporary, "wx", 0o600);
        let bytes = 0,
            batch = "",
            rows = 0;
        const write = async (text) => {
            bytes += Buffer.byteLength(text);
            if (bytes > 64 * 1024 * 1024)
                throw Object.assign(new Error("Chart CSV exceeds 64 MiB; use the archive export"), {
                    code: "CSV_EXPORT_TOO_LARGE"
                });
            await output.write(text);
        };
        const displayNames = new Map(request.displayNames || []);
        await write(
            "\uFEFFtime," + names.map((name) => csvHeaderField(displayNames.get(name) || name)).join(",") + "\r\n"
        );
        const iterators = names.map((name) => store.points(source.series.get(name)));
        const current = iterators.map((iterator) => iterator.next());
        const iso = createSampleTimeFormatter();
        while (current.some((entry) => !entry.done)) {
            const time = Math.min(...current.map((entry) => (entry.done ? Infinity : entry.value.t)));
            const cells = current.map((entry, i) => {
                if (entry.done || entry.value.t !== time) return "";
                let point = entry.value;
                do {
                    current[i] = iterators[i].next();
                    if (!current[i].done && current[i].value.t === time) point = current[i].value;
                } while (!current[i].done && current[i].value.t === time);
                return point.v === null ? "" : csvField(point.valueText ?? point.v);
            });
            if (time < from || time > to) continue;
            batch += `${iso(time)},${cells.join(",")}\r\n`;
            rows++;
            if (batch.length >= 65536) {
                await write(batch);
                batch = "";
            }
        }
        if (batch) await write(batch);
        await output.datasync();
        await output.close();
        output = null;
        await fsp.rename(temporary, outputPath);
        return { rows, seriesCount: names.length, outputPath };
    } finally {
        if (output) await output.close().catch(() => {});
        await fsp.rm(temporary, { force: true }).catch(() => {});
        store.release(capture.snapshotId);
    }
}

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
            if (method === "export") result = await exportHistory(store, args[0]);
            else if (method === "restore") result = await restoreHistory(store, args[0]);
            else if (
                [
                    "configure",
                    "append",
                    "markLimited",
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
module.exports = { run, exportHistory, restoreHistory };
