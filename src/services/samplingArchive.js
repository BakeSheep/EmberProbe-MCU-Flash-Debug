"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ArchiveEncoder, FILE_HEADER, scanArchive } = require("./samplingArchiveFormat");

const fsp = fs.promises;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const BACKPRESSURE_BYTES = 1024 * 1024;
const DRAIN_BATCH_BYTES = 256 * 1024;
const DRAIN_DELAY_MS = 150;
const AGENT_CSV_MAX_BYTES = 64 * 1024 * 1024;
const INDEX_BLOCK_BYTES = 64 * 1024;
const HISTORY_WINDOW_MS = 30 * 60 * 1000;

function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Keep these rules in step with buildCsv's esc() in src/liveWatchView.js, which is serialized into
// the live-watch page and therefore cannot import from here.
const NUMERIC_CELL = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function quoteCsv(text) {
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Data cells are dominated by negative readings, so a leading "-" only counts as a formula when
// the rest is not a plain number. Header names never contain numbers, hence the blanket rule below.
function dataCellSafe(text) {
    if (/^[=+@\t\r]/.test(text)) return `'${text}`;
    return text.startsWith("-") && !NUMERIC_CELL.test(text) ? `'${text}` : text;
}

function csvField(value) {
    return quoteCsv(dataCellSafe(String(value ?? "")));
}

function csvHeaderField(value) {
    const text = String(value ?? "");
    return quoteCsv(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
}

function processIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error && error.code === "EPERM";
    }
}

function cleanupStaleSamplingArchives(parentDir, currentPid = process.pid, isAlive = processIsAlive) {
    let names;
    try {
        names = fs.readdirSync(parentDir);
    } catch {
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        const match = /^sampling-history-(\d+)-[0-9a-f]+$/i.exec(name);
        if (!match) continue;
        const pid = Number(match[1]);
        if (pid === currentPid || isAlive(pid)) continue;
        try {
            fs.rmSync(path.join(parentDir, name), { recursive: true, force: true });
            removed++;
        } catch {
            // 清理失败不影响当前采样会话。
        }
    }
    return removed;
}

function sampleValueText(sample) {
    if (sample.value == null && (sample.valueText == null || sample.valueText === "-")) return null;
    if (sample.valueText != null) return String(sample.valueText);
    if (typeof sample.value === "number" && Object.is(sample.value, -0)) return "-0";
    return String(sample.value);
}

// Every CSV export starts with this header prefix; it identifies an interrupted export's ".part" leftover.
const CSV_PART_SIGNATURE = Buffer.from("﻿time,", "utf8");

async function isCsvExportLeftover(file) {
    try {
        if (!(await fsp.lstat(file)).isFile()) return false;
        const handle = await fsp.open(file, "r");
        try {
            const head = Buffer.alloc(CSV_PART_SIGNATURE.length);
            const { bytesRead } = await handle.read(head, 0, head.length, 0);
            return bytesRead === head.length && head.equals(CSV_PART_SIGNATURE);
        } finally {
            await handle.close();
        }
    } catch {
        return false;
    }
}

// Reuses "<target>.part" left by an interrupted export of the same target. Any other file with that name
// is not ours to delete, so the export then writes beside it under a unique ".part" name.
async function openCsvPart(targetPath) {
    const preferred = `${targetPath}.part`;
    const open = async (file) => ({ path: file, handle: await fsp.open(file, "wx", 0o600) });
    try {
        return await open(preferred);
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }
    if (await isCsvExportLeftover(preferred)) {
        await fsp.rm(preferred, { force: true });
        try {
            return await open(preferred);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    }
    return open(`${targetPath}.${crypto.randomBytes(4).toString("hex")}.part`);
}

class SamplingArchive {
    constructor(options) {
        this.rootDir = path.resolve(options.rootDir);
        this.dataPath = path.join(this.rootDir, "samples.bin");
        this.encoder = new ArchiveEncoder();
        this.timeIndex = [];
        this.indexedBytes = 0;
        this.maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
        this.onError = options.onError || (() => {});
        this.onBackpressure = options.onBackpressure || (() => {});
        this.onWritten = options.onWritten || (() => {});
        this.queue = [];
        this.queuedBytes = 0;
        this.writtenBytes = 0;
        this.rows = 0;
        this.firstTimestampMs = null;
        this.lastTimestampMs = null;
        this.variables = new Set();
        this.scopes = new Map();
        this.generations = new Map();
        this.handle = null;
        this.drainPromise = null;
        this.drainTimer = null;
        this.exportPromise = null;
        this.activeReads = new Set();
        this.closed = false;
        this.failed = null;
        this.limitReached = false;
        this.backpressured = false;
        this.ready = this._reset().catch((error) => {
            this.failed = error;
            this.onError(error);
        });
    }

    async _reset() {
        await fsp.rm(this.rootDir, { recursive: true, force: true });
        await fsp.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    }

    // Raising the limit lets a session that hit it record again; lowering it never discards written data.
    setMaxBytes(bytes) {
        this.maxBytes = Math.max(1024 * 1024, Number(bytes) || DEFAULT_MAX_BYTES);
        if (this.limitReached && this.writtenBytes + this.queuedBytes < this.maxBytes) this.limitReached = false;
        return this.status();
    }

    status(scope = "") {
        const history = this.scopes.get(scope);
        return {
            active: !this.closed && !this.failed && !this.limitReached,
            rows: history?.rows || 0,
            bytes: this.writtenBytes + this.queuedBytes,
            variables: Array.from(history?.variables || []),
            firstTimestampMs: history?.firstTimestampMs ?? null,
            lastTimestampMs: history?.lastTimestampMs ?? null,
            error: this.failed?.message || null,
            limitReached: this.limitReached
        };
    }

    clear(scope = "") {
        // Logical reset isolates this consumer without disrupting other panels or active disk writes.
        this.generations.set(scope, (this.generations.get(scope) || 0) + 1);
        this.scopes.delete(scope);
    }

    append(samples, timestampMs, scope = "") {
        if (this.closed || this.failed || this.limitReached) return false;
        const values = Object.create(null);
        for (const sample of Array.isArray(samples) ? samples : []) {
            if (!sample || typeof sample.name !== "string") continue;
            values[sample.name] = sampleValueText(sample);
            this.variables.add(sample.name);
        }
        if (!Object.keys(values).length) return false;
        const timestamp = Number(timestampMs) || Date.now();
        const generation = this.generations.get(scope) || 0;
        const identities = Object.fromEntries(
            (Array.isArray(samples) ? samples : [])
                .filter((sample) => sample?.historyIdentity)
                .map((sample) => [sample.name, sample.historyIdentity])
        );
        let buffer;
        try {
            buffer = this.encoder.encodeRow({
                t: timestamp,
                scope,
                generation,
                values: Object.entries(values).map(([key, text]) => ({
                    key,
                    text,
                    identity: Object.hasOwn(identities, key) ? identities[key] : undefined
                }))
            });
        } catch (error) {
            this.failed = error;
            this.onError(error);
            return false;
        }
        const header = this.rows === 0 ? FILE_HEADER : Buffer.alloc(0);
        if (this.writtenBytes + this.queuedBytes + header.length + buffer.length > this.maxBytes) {
            this.limitReached = true;
            this.onError(codedError("SAMPLING_ARCHIVE_FULL", "Sampling history reached its configured size limit"));
            return false;
        }
        if (header.length) buffer = Buffer.concat([header, buffer]);
        this.queue.push({ buffer, t: timestamp });
        this.queuedBytes += buffer.length;
        this.rows += 1;
        let history = this.scopes.get(scope);
        if (!history) {
            history = { rows: 0, variables: new Set(), firstTimestampMs: timestamp, lastTimestampMs: timestamp };
            this.scopes.set(scope, history);
        }
        history.rows++;
        for (const name of Object.keys(values)) history.variables.add(name);
        history.firstTimestampMs = Math.min(history.firstTimestampMs, timestamp);
        history.lastTimestampMs = Math.max(history.lastTimestampMs, timestamp);
        this.firstTimestampMs = this.firstTimestampMs == null ? timestamp : Math.min(this.firstTimestampMs, timestamp);
        this.lastTimestampMs = this.lastTimestampMs == null ? timestamp : Math.max(this.lastTimestampMs, timestamp);
        if (this.queuedBytes >= BACKPRESSURE_BYTES) this._setBackpressure(true);
        this._scheduleDrain();
        return true;
    }

    _setBackpressure(active) {
        if (this.backpressured === active) return;
        this.backpressured = active;
        this.onBackpressure(active);
    }

    _scheduleDrain() {
        if (this.drainPromise || !this.queue.length || this.failed || this.closed) return;
        if (this.queuedBytes >= DRAIN_BATCH_BYTES) {
            this._ensureDrain();
        } else if (!this.drainTimer) {
            this.drainTimer = setTimeout(() => {
                this.drainTimer = null;
                this._ensureDrain();
            }, DRAIN_DELAY_MS);
        }
    }

    _ensureDrain() {
        if (this.drainTimer) clearTimeout(this.drainTimer);
        this.drainTimer = null;
        if (this.drainPromise) return this.drainPromise;
        if (!this.queue.length || this.failed) return null;
        this.drainPromise = this._drain()
            .catch((error) => {
                this.failed = error;
                this.queue.length = 0;
                this.queuedBytes = 0;
                this._setBackpressure(false);
                this.onError(error);
            })
            .finally(() => {
                this.drainPromise = null;
                this._scheduleDrain();
            });
        return this.drainPromise;
    }

    async _drain() {
        await this.ready;
        if (this.failed) throw this.failed;
        if (!this.handle) this.handle = await fsp.open(this.dataPath, "a+", 0o600);
        const batch = this.queue;
        this.queue = [];
        const buffer = Buffer.concat(batch.map((entry) => entry.buffer));
        const batchStart = this.writtenBytes;
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesWritten } = await this.handle.write(buffer, offset, buffer.length - offset);
            if (!bytesWritten)
                throw codedError("SAMPLING_ARCHIVE_WRITE_FAILED", "Sampling history write made no progress");
            offset += bytesWritten;
            // In-flight bytes remain budgeted until the write completes.
            this.queuedBytes -= bytesWritten;
            this.writtenBytes += bytesWritten;
        }
        let recordOffset = batchStart;
        for (const entry of batch) {
            let block = this.timeIndex[this.timeIndex.length - 1];
            if (!block || recordOffset - block.offset >= INDEX_BLOCK_BYTES) {
                block = { offset: recordOffset, tMin: entry.t, tMax: entry.t };
                this.timeIndex.push(block);
            }
            block.tMin = Math.min(block.tMin, entry.t);
            block.tMax = Math.max(block.tMax, entry.t);
            recordOffset += entry.buffer.length;
        }
        this.indexedBytes = recordOffset;
        this.onWritten(this.indexedBytes);
        this._setBackpressure(this.queuedBytes >= BACKPRESSURE_BYTES);
    }

    async flush() {
        await this.ready;
        // A flush bypasses the batching delay, including bytes appended during an active write.
        while (this.drainPromise || (this.queue.length && !this.failed)) await this._ensureDrain();
        try {
            return (await fsp.stat(this.dataPath)).size;
        } catch (error) {
            if (error.code === "ENOENT") return 0;
            throw error;
        }
    }
    async historySource(scope) {
        const generation = this.generations.get(scope) || 0;
        const lastTimestampMs = this.status(scope).lastTimestampMs;
        await this.flush();
        // A new drain can start while flush's stat is pending. Its partial write must never
        // become a catch-up boundary; only fully written, indexed batches are seekable.
        const cutoff = this.indexedBytes;
        const block =
            lastTimestampMs == null
                ? null
                : this.timeIndex.find((entry) => entry.tMax >= lastTimestampMs - HISTORY_WINDOW_MS);
        return {
            scope,
            generation,
            lastTimestampMs,
            cutoff,
            dataPath: this.dataPath,
            dictionary: this.encoder.dictionary(),
            startOffset: block?.offset ?? 0
        };
    }

    exportCsv(request) {
        if (this.exportPromise) throw codedError("EXPORT_IN_PROGRESS", "A sampling history export is already running");
        this.exportPromise = this._exportCsv(request).finally(() => {
            this.exportPromise = null;
        });
        return this.exportPromise;
    }

    readCsv(request) {
        if (this.closed) return Promise.reject(codedError("SAMPLING_ARCHIVE_CLOSED", "Sampling history is closed"));
        const task = this._readCsv(request).finally(() => this.activeReads.delete(task));
        this.activeReads.add(task);
        return task;
    }

    async _readCsv(request) {
        const outputPath = path.join(this.rootDir, `agent-export-${crypto.randomBytes(8).toString("hex")}.csv`);
        try {
            // Deliberately bypasses exportCsv's lock: that guard serialises user-facing exports to a
            // chosen path, whereas an Agent read writes to a unique temporary file and must not fail
            // just because the user happens to be exporting. flush() is reentrant, so this is safe.
            const result = await this._exportCsv({ ...request, outputPath, maxOutputBytes: AGENT_CSV_MAX_BYTES });
            if (!result.valueRows) throw codedError("CSV_EXPORT_EMPTY", "The selected range has no chart samples");
            return { ...result, csv: await fsp.readFile(outputPath, "utf8"), limitReached: this.limitReached };
        } finally {
            await fsp.rm(outputPath, { force: true }).catch(() => {});
        }
    }

    async _exportCsv(request) {
        const targetPath = path.resolve(String(request.outputPath || ""));
        if (!request.outputPath || path.extname(targetPath).toLowerCase() !== ".csv") {
            throw codedError("EXPORT_PATH_INVALID", "A CSV output path is required");
        }
        const scope = request.scope || "";
        const generation = this.generations.get(scope) || 0;
        const available = this.status(scope).variables;
        const requested = Array.isArray(request.names) && request.names.length ? request.names : available;
        const names = [...new Set(requested.map(String))].filter((name) => available.includes(name));
        if (!names.length) throw codedError("CSV_EXPORT_EMPTY", "No recorded variables were selected");
        const cutoff = await this.flush();
        if (!cutoff) throw codedError("CSV_EXPORT_EMPTY", "No sampled data is available");

        const fromMs = Number.isFinite(Number(request.fromMs)) ? Number(request.fromMs) : -Infinity;
        const toMs = Number.isFinite(Number(request.toMs)) ? Number(request.toMs) : Infinity;
        if (fromMs > toMs) throw codedError("INVALID_CSV_RANGE", "CSV export time range is invalid");

        // A visible ".part" name tells users the file is still being written; it is renamed atomically when done.
        let temporaryPath = "";
        const onProgress = typeof request.onProgress === "function" ? request.onProgress : null;
        const isCancelled = typeof request.isCancelled === "function" ? request.isCancelled : () => false;
        const cancelled = () => codedError("CSV_EXPORT_CANCELLED", "CSV export was cancelled");
        let output;
        let rowCount = 0;
        let valueRows = 0;
        let firstTimestampMs = null;
        let lastTimestampMs = null;
        let firstValueTimestampMs = null;
        let lastValueTimestampMs = null;
        const maxOutputBytes = Number.isFinite(request.maxOutputBytes) ? request.maxOutputBytes : Infinity;
        const tooLarge = () =>
            codedError("CSV_EXPORT_TOO_LARGE", "CSV result exceeds 64 MiB; use the chart's archive export");
        try {
            ({ path: temporaryPath, handle: output } = await openCsvPart(targetPath));
            // Display labels affect only the header; archived values stay keyed by ELF identity.
            const header = `﻿time,${names
                .map((name) => {
                    const label = request.displayNames?.get(name);
                    return csvHeaderField(typeof label === "string" && label ? label : name);
                })
                .join(",")}\r\n`;
            let outputBytes = Buffer.byteLength(header);
            if (outputBytes > maxOutputBytes) throw tooLarge();
            await output.write(header);
            const columns = new Map(names.map((name, index) => [name, index])),
                cells = new Array(names.length).fill(""),
                present = new Array(names.length).fill(false),
                channelColumn = [];
            let scopeId = -1,
                rowTime = 0,
                lines = [],
                pendingChars = 0,
                second = NaN,
                secondPrefix = "";
            // ISO text is computed once per second; out-of-range years keep Date's own formatting.
            const iso = (t) => {
                if (!(t >= 0 && t < 253402300800000)) return new Date(t).toISOString();
                const whole = Math.floor(t / 1000);
                if (whole !== second) {
                    second = whole;
                    secondPrefix = new Date(whole * 1000).toISOString().slice(0, 20);
                }
                const ms = Math.floor(t - whole * 1000);
                return secondPrefix + (ms < 10 ? "00" : ms < 100 ? "0" : "") + ms + "Z";
            };
            const writeLines = async () => {
                if (!lines.length) return;
                const text = lines.join("");
                lines = [];
                pendingChars = 0;
                outputBytes += Buffer.byteLength(text);
                if (outputBytes > maxOutputBytes) throw tooLarge();
                await output.write(text);
            };
            const visitor = {
                // Duplicate keys within a row keep the last value, like the former JSON records.
                lastValueOnly: true,
                definition(type, id, state) {
                    if (type === 1 && state.scopes[id] === scope) scopeId = id;
                    if (type === 2) channelColumn[id] = columns.get(state.channels[id].key) ?? -1;
                },
                row(at, next, rowScope, rowGeneration, t) {
                    if (rowScope !== scopeId || rowGeneration !== generation || t < fromMs || t > toMs) return false;
                    rowTime = t;
                    cells.fill("");
                    present.fill(false);
                    return true;
                },
                select: (id) => channelColumn[id] >= 0,
                value(id, kind, number, text) {
                    const column = channelColumn[id];
                    present[column] = kind !== 0;
                    // Finite numbers never need quoting or formula guards; other text keeps the CSV rules.
                    cells[column] =
                        kind === 0
                            ? ""
                            : kind === 4
                              ? csvField(text)
                              : Number.isFinite(number)
                                ? String(number)
                                : csvField(String(number));
                },
                rowEnd() {
                    const line = iso(rowTime) + "," + cells.join(",") + "\r\n";
                    lines.push(line);
                    pendingChars += line.length;
                    rowCount += 1;
                    if (present.includes(true)) {
                        valueRows += 1;
                        firstValueTimestampMs =
                            firstValueTimestampMs === null ? rowTime : Math.min(firstValueTimestampMs, rowTime);
                        lastValueTimestampMs =
                            lastValueTimestampMs === null ? rowTime : Math.max(lastValueTimestampMs, rowTime);
                    }
                    firstTimestampMs = firstTimestampMs === null ? rowTime : Math.min(firstTimestampMs, rowTime);
                    lastTimestampMs = lastTimestampMs === null ? rowTime : Math.max(lastTimestampMs, rowTime);
                }
            };
            let reported = -1;
            await scanArchive(
                this.dataPath,
                {
                    end: cutoff,
                    onChunk: async (position, total) => {
                        if (isCancelled()) throw cancelled();
                        if (pendingChars >= 1024 * 1024) await writeLines();
                        const fraction = total ? position / total : 1;
                        if (onProgress && fraction - reported >= 0.01) {
                            reported = fraction;
                            onProgress(fraction);
                        }
                    }
                },
                visitor
            );
            if (isCancelled()) throw cancelled();
            await writeLines();
            await output.datasync();
            await output.close();
            output = null;
            await fsp.rename(temporaryPath, targetPath);
            return {
                outputPath: targetPath,
                rows: rowCount,
                valueRows,
                seriesCount: names.length,
                firstTimestampMs,
                lastTimestampMs,
                firstValueTimestampMs,
                lastValueTimestampMs
            };
        } catch (error) {
            if (output) await output.close().catch(() => {});
            if (temporaryPath) await fsp.rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }
    }

    async dispose() {
        if (this.closed) return;
        this.closed = true;
        if (this.exportPromise) await this.exportPromise.catch(() => {});
        await Promise.allSettled([...this.activeReads]);
        await this.flush().catch(() => {});
        if (this.handle) await this.handle.close().catch(() => {});
        this.handle = null;
        await fsp.rm(this.rootDir, { recursive: true, force: true });
    }
}

module.exports = {
    SamplingArchive,
    csvField,
    csvHeaderField,
    sampleValueText,
    cleanupStaleSamplingArchives,
    processIsAlive
};
