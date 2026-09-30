"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const fsp = fs.promises;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const BACKPRESSURE_BYTES = 1024 * 1024;
const AGENT_CSV_MAX_BYTES = 64 * 1024 * 1024;

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

class SamplingArchive {
    constructor(options) {
        this.rootDir = path.resolve(options.rootDir);
        this.dataPath = path.join(this.rootDir, "samples.ndjson");
        this.maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
        this.onError = options.onError || (() => {});
        this.onBackpressure = options.onBackpressure || (() => {});
        this.queue = [];
        this.queuedBytes = 0;
        this.writtenBytes = 0;
        this.rows = 0;
        this.firstTimestampMs = null;
        this.lastTimestampMs = null;
        this.variables = new Set();
        this.scopes = new Map();
        this.handle = null;
        this.drainPromise = null;
        this.exportPromise = null;
        this.activeReads = new Set();
        this.closed = false;
        this.failed = null;
        this.limitReached = false;
        this.backpressured = false;
        this.lastSyncAt = 0;
        this.ready = this._reset().catch((error) => {
            this.failed = error;
            this.onError(error);
        });
    }

    async _reset() {
        await fsp.rm(this.rootDir, { recursive: true, force: true });
        await fsp.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
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
        const line = Buffer.from(`${JSON.stringify({ t: timestamp, v: values, scope })}\n`);
        if (this.writtenBytes + this.queuedBytes + line.length > this.maxBytes) {
            this.limitReached = true;
            this.onError(codedError("SAMPLING_ARCHIVE_FULL", "Sampling history reached its configured size limit"));
            return false;
        }
        this.queue.push(line);
        this.queuedBytes += line.length;
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
        this._ensureDrain();
        return true;
    }

    _setBackpressure(active) {
        if (this.backpressured === active) return;
        this.backpressured = active;
        this.onBackpressure(active);
    }

    _ensureDrain() {
        if (this.drainPromise) return this.drainPromise;
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
                if (this.queue.length && !this.failed && !this.closed) this._ensureDrain();
            });
        return this.drainPromise;
    }

    async _drain() {
        await this.ready;
        if (this.failed) throw this.failed;
        if (!this.handle) this.handle = await fsp.open(this.dataPath, "a+", 0o600);
        while (this.queue.length) {
            const batch = this.queue.splice(0, 64);
            const buffer = Buffer.concat(batch);
            this.queuedBytes -= buffer.length;
            await this.handle.write(buffer);
            this.writtenBytes += buffer.length;
            if (Date.now() - this.lastSyncAt >= 1000) {
                await this.handle.datasync();
                this.lastSyncAt = Date.now();
            }
        }
        this._setBackpressure(false);
    }

    async flush() {
        await this.ready;
        while (this.drainPromise) await this.drainPromise;
        if (this.queue.length && !this.failed) {
            this._ensureDrain();
            while (this.drainPromise) await this.drainPromise;
        }
        if (this.handle && !this.failed) await this.handle.datasync();
        try {
            return (await fsp.stat(this.dataPath)).size;
        } catch (error) {
            if (error.code === "ENOENT") return 0;
            throw error;
        }
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
        const available = this.status(scope).variables;
        const requested = Array.isArray(request.names) && request.names.length ? request.names : available;
        const names = [...new Set(requested.map(String))].filter((name) => available.includes(name));
        if (!names.length) throw codedError("CSV_EXPORT_EMPTY", "No recorded variables were selected");
        const cutoff = await this.flush();
        if (!cutoff) throw codedError("CSV_EXPORT_EMPTY", "No sampled data is available");

        const fromMs = Number.isFinite(Number(request.fromMs)) ? Number(request.fromMs) : -Infinity;
        const toMs = Number.isFinite(Number(request.toMs)) ? Number(request.toMs) : Infinity;
        if (fromMs > toMs) throw codedError("INVALID_CSV_RANGE", "CSV export time range is invalid");

        const temporaryPath = path.join(
            path.dirname(targetPath),
            `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
        );
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
            output = await fsp.open(temporaryPath, "wx", 0o600);
            const header = `\uFEFFtime,${names.map(csvHeaderField).join(",")}\r\n`;
            let outputBytes = Buffer.byteLength(header);
            if (outputBytes > maxOutputBytes) throw tooLarge();
            await output.write(header);
            const input = fs.createReadStream(this.dataPath, { start: 0, end: cutoff - 1 });
            const lines = readline.createInterface({ input, crlfDelay: Infinity });
            let batch = "";
            for await (const line of lines) {
                if (!line) continue;
                let record;
                try {
                    record = JSON.parse(line);
                } catch {
                    continue;
                }
                if (!Number.isFinite(record.t) || record.t < fromMs || record.t > toMs) continue;
                if ((record.scope || "") !== scope) continue;
                const values = record.v && typeof record.v === "object" ? record.v : {};
                const csvRow = `${new Date(record.t).toISOString()},${names.map((name) => csvField(values[name])).join(",")}\r\n`;
                outputBytes += Buffer.byteLength(csvRow);
                if (outputBytes > maxOutputBytes) throw tooLarge();
                batch += csvRow;
                rowCount += 1;
                if (names.some((name) => values[name] != null)) {
                    valueRows += 1;
                    firstValueTimestampMs =
                        firstValueTimestampMs === null ? record.t : Math.min(firstValueTimestampMs, record.t);
                    lastValueTimestampMs =
                        lastValueTimestampMs === null ? record.t : Math.max(lastValueTimestampMs, record.t);
                }
                firstTimestampMs = firstTimestampMs === null ? record.t : Math.min(firstTimestampMs, record.t);
                lastTimestampMs = lastTimestampMs === null ? record.t : Math.max(lastTimestampMs, record.t);
                if (batch.length >= 64 * 1024) {
                    await output.write(batch);
                    batch = "";
                }
            }
            if (batch) await output.write(batch);
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
            await fsp.rm(temporaryPath, { force: true }).catch(() => {});
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
