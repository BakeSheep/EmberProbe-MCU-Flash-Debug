"use strict";
const { Worker } = require("worker_threads");
const path = require("path");
const { deserializeError } = require("./errorEnvelope");

const MAX_BACKLOG_BYTES = 16 * 1024 * 1024;

// Account for cloned values, property names and container overhead without building a JSON string.
// Saturate on excessive work/depth so malformed input cannot bypass the backlog limit.
function estimateHistoryBytes(value) {
    let bytes = 0;
    let visits = 0;
    const visit = (entry, depth) => {
        if (bytes > MAX_BACKLOG_BYTES) return;
        if (++visits > 262144 || depth > 64) {
            bytes = MAX_BACKLOG_BYTES + 1;
            return;
        }
        if (typeof entry === "string") bytes += 16 + entry.length * 2;
        else if (typeof entry === "number" || typeof entry === "bigint") bytes += 8;
        else if (!entry || typeof entry !== "object") bytes += 8;
        else if (ArrayBuffer.isView(entry) || entry instanceof ArrayBuffer) bytes += 32 + entry.byteLength;
        else if (Array.isArray(entry)) {
            bytes += 32 + entry.length * 8;
            for (const child of entry) {
                visit(child, depth + 1);
                if (bytes > MAX_BACKLOG_BYTES) break;
            }
        } else {
            bytes += 32;
            for (const key in entry) {
                if (!Object.hasOwn(entry, key)) continue;
                bytes += 16 + key.length * 2;
                visit(entry[key], depth + 1);
                if (bytes > MAX_BACKLOG_BYTES) break;
            }
        }
    };
    visit(value, 0);
    return Math.min(bytes, MAX_BACKLOG_BYTES + 1);
}

class ChartHistoryService {
    constructor(options = {}) {
        this.options = options;
        this.pending = new Map();
        this.nextId = 0;
        this.disposed = false;
        this.queuedBytes = 0;
        this.failed = null;
        this.worker = null;
        this.termination = null;
        this.limitedScopes = new Map();
    }
    start() {
        if (this.disposed || this.worker) return;
        this.failed = null;
        this.queuedBytes = 0;
        this.worker = new Worker(this.options.workerPath || path.join(__dirname, "../chartHistoryWorker.js"), {
            workerData: { maxBytes: this.options.maxBytes }
        });
        const worker = this.worker;
        worker.on("message", (message) => {
            if (worker !== this.worker) return;
            if (message.event === "updated") this.options.onUpdated?.(message);
            else if (message.event === "error") this.fail(deserializeError(message.error));
            else {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                this.queuedBytes -= pending.bytes;
                if (message.error) pending.reject(deserializeError(message.error));
                else pending.resolve(message.result);
            }
        });
        worker.on("error", (error) => {
            if (worker === this.worker) this.fail(error);
        });
        worker.on("exit", (code) => {
            if (!this.disposed && worker === this.worker && !this.failed) {
                // The exit event is already terminal; terminating here can leave restart waiting forever.
                this.worker = null;
                this.fail(new Error(`History worker exited (${code})`));
            }
        });
    }
    fail(error) {
        if (this.failed || this.disposed) return;
        this.failed = error;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        this.queuedBytes = 0;
        this.termination = this.worker?.terminate() || Promise.resolve();
        this.termination.catch(() => {});
        this.options.onError?.(error);
    }
    request(method, args = []) {
        if (this.failed || this.disposed) return Promise.reject(this.failed || new Error("History service disposed"));
        if (["clear", "remove"].includes(method)) this.limitedScopes.delete(args[0]);
        const bytes = method === "append" ? estimateHistoryBytes(args) : 0;
        if (this.queuedBytes + bytes > MAX_BACKLOG_BYTES)
            return this.limit(args[0], args[2]).then(() => ({ limited: true }));
        try {
            this.start();
        } catch (error) {
            this.fail(error);
            return Promise.reject(error);
        }
        const id = ++this.nextId;
        this.queuedBytes += bytes;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, bytes });
            try {
                this.worker.postMessage({ id, method, args });
            } catch (error) {
                this.pending.delete(id);
                this.queuedBytes -= bytes;
                reject(error);
            }
        });
    }
    limit(scope, tick) {
        // One small ordered gap marker per scope, regardless of the number of dropped batches.
        if (this.limitedScopes.has(scope)) return this.limitedScopes.get(scope);
        const task = this.request("markLimited", [scope, tick]).finally(() => {
            if (this.limitedScopes.get(scope) === task) this.limitedScopes.delete(scope);
        });
        this.limitedScopes.set(scope, task);
        return task;
    }
    async restart() {
        if (this.disposed) return;
        const worker = this.worker;
        this.worker = null;
        this.failed = new Error("History worker restarted");
        for (const request of this.pending.values()) request.reject(this.failed);
        this.pending.clear();
        this.queuedBytes = 0;
        this.limitedScopes.clear();
        this.termination = this.termination || worker?.terminate() || Promise.resolve();
        await this.termination;
        this.termination = null;
        if (this.disposed) return;
        this.failed = null;
        if (worker) this.start();
    }
    async dispose() {
        this.disposed = true;
        for (const request of this.pending.values()) request.reject(new Error("History service disposed"));
        this.pending.clear();
        this.queuedBytes = 0;
        await (this.termination || this.worker?.terminate());
    }
}
module.exports = { ChartHistoryService, estimateHistoryBytes, MAX_BACKLOG_BYTES };
