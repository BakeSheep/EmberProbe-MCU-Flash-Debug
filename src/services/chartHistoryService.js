"use strict";
const { Worker } = require("worker_threads");
const path = require("path");
const { deserializeError } = require("./errorEnvelope");

class ChartHistoryService {
    constructor(options = {}) {
        this.options = options;
        this.pending = new Map();
        this.nextId = 0;
        this.disposed = false;
        this.queuedBytes = 0;
        this.start();
    }
    start() {
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
            if (!this.disposed && worker === this.worker && !this.failed)
                this.fail(new Error(`History worker exited (${code})`));
        });
    }
    fail(error) {
        if (this.failed || this.disposed) return;
        this.failed = error;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        this.queuedBytes = 0;
        this.termination = this.worker.terminate();
        this.termination.catch(() => {});
        this.options.onError?.(error);
    }
    request(method, args = []) {
        if (this.failed || this.disposed) return Promise.reject(this.failed || new Error("History service disposed"));
        const bytes = method === "append" ? Buffer.byteLength(JSON.stringify(args)) : 0;
        if (this.queuedBytes + bytes > 16 * 1024 * 1024) {
            const error = Object.assign(new Error("History worker backlog reached its limit; sampling paused"), {
                code: "CHART_HISTORY_BACKPRESSURE"
            });
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
    async restart() {
        const worker = this.worker;
        await (this.termination || worker.terminate());
        this.termination = null;
        for (const request of this.pending.values()) request.reject(new Error("History worker restarted"));
        this.pending.clear();
        this.start();
    }
    async dispose() {
        this.disposed = true;
        for (const request of this.pending.values()) request.reject(new Error("History service disposed"));
        this.pending.clear();
        await (this.termination || this.worker.terminate());
    }
}
module.exports = { ChartHistoryService };
