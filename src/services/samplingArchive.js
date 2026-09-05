"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const fsp = fs.promises;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const BACKPRESSURE_BYTES = 1024 * 1024;

function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

function csvField(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvHeaderField(value) {
    const text = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return csvField(safe);
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
    if (sample.valueText != null) return String(sample.valueText);
    if (sample.value == null) return null;
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
        this.handle = null;
        this.drainPromise = null;
        this.exportPromise = null;
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

    status() {
        return {
            active: !this.closed && !this.failed && !this.limitReached,
            rows: this.rows,
            bytes: this.writtenBytes + this.queuedBytes,
            variables: Array.from(this.variables),
            firstTimestampMs: this.firstTimestampMs,
            lastTimestampMs: this.lastTimestampMs,
            error: this.failed?.message || null,
            limitReached: this.limitReached
        };
    }

    append(samples, timestampMs) {
        if (this.closed || this.failed || this.limitReached) return false;
        const values = Object.create(null);
        for (const sample of Array.isArray(samples) ? samples : []) {
            if (!sample || typeof sample.name !== "string") continue;
            values[sample.name] = sampleValueText(sample);
            this.variables.add(sample.name);
        }
        if (!Object.keys(values).length) return false;
        const timestamp = Number(timestampMs) || Date.now();
        const line = Buffer.from(`${JSON.stringify({ t: timestamp, v: values })}\n`);
        if (this.writtenBytes + this.queuedBytes + line.length > this.maxBytes) {
            this.limitReached = true;
            this.onError(codedError("SAMPLING_ARCHIVE_FULL", "Sampling history reached its configured size limit"));
            return false;
        }
        this.queue.push(line);
        this.queuedBytes += line.length;
        this.rows += 1;
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

    async _exportCsv(request) {
        const targetPath = path.resolve(String(request.outputPath || ""));
        if (!request.outputPath || path.extname(targetPath).toLowerCase() !== ".csv") {
            throw codedError("EXPORT_PATH_INVALID", "A CSV output path is required");
        }
        const available = Array.from(this.variables);
        const requested = Array.isArray(request.names) && request.names.length ? request.names : available;
        const names = [...new Set(requested.map(String))].filter((name) => this.variables.has(name));
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
        try {
            output = await fsp.open(temporaryPath, "wx", 0o600);
            await output.write(`\uFEFFtime,${names.map(csvHeaderField).join(",")}\r\n`);
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
                const values = record.v && typeof record.v === "object" ? record.v : {};
                batch += `${new Date(record.t).toISOString()},${names.map((name) => csvField(values[name])).join(",")}\r\n`;
                rowCount += 1;
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
            return { outputPath: targetPath, rows: rowCount, seriesCount: names.length };
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
