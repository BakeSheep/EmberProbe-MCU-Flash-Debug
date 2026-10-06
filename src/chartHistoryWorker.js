"use strict";
const { parentPort, workerData, isMainThread } = require("worker_threads");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { ChartHistoryStore, WINDOW_MS } = require("./services/chartHistoryStore");
const { csvField, csvHeaderField } = require("./services/samplingArchive");
const { serializeError } = require("./services/errorEnvelope");

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
            batch += `${new Date(time).toISOString()},${cells.join(",")}\r\n`;
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
    const names = new Map(
        [...store._scope(request.scope).series].map(([name, s]) => [`${name} [${s.item.type}]`, name])
    );
    const state = store._scope(request.scope);
    let expectedRevision = state.revision;
    const input = fs.createReadStream(request.dataPath, { end: request.cutoff - 1 });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (store.scopes.get(request.scope) !== state || state.revision !== expectedRevision)
                throw Object.assign(new Error("History changed while restoring"), {
                    code: "CHART_HISTORY_RESTORE_CANCELLED"
                });
            let record;
            try {
                record = JSON.parse(line);
            } catch {
                continue;
            }
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
    } finally {
        lines.close();
        input.destroy();
    }
    return store.status(request.scope);
}

function run(port, options = {}) {
    const store = new ChartHistoryStore(options.maxBytes);
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
                    "status",
                    "viewport",
                    "freeze",
                    "resume",
                    "clear",
                    "remove",
                    "setBudget"
                ].includes(method)
            ) {
                result = store[method](...args);
                if (["append", "configure", "clear"].includes(method)) update(args[0]);
                if (method === "remove" && timers.has(args[0])) {
                    clearTimeout(timers.get(args[0]));
                    timers.delete(args[0]);
                }
            } else throw new Error("Unknown history operation");
            if (id) port.postMessage({ id, result });
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
