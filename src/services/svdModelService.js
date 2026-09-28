"use strict";
const { Worker } = require("worker_threads");

class SvdModelService {
    constructor(options) {
        this.workerPath = options.workerPath;
        this.Worker = options.Worker || Worker;
        this.timeoutMs = options.timeoutMs || 10000;
        this.pending = new Map();
        this.disposed = false;
    }
    parse(buffer, sourcePath, sha256) {
        if (this.disposed) return Promise.reject(new Error("SVD parser disposed"));
        const key = JSON.stringify([sha256, sourcePath]);
        if (this.pending.has(key)) return this.pending.get(key).promise;
        if (this.pending.size >= 4)
            return Promise.reject(Object.assign(new Error("SVD parser is busy"), { code: "SVD_PARSER_BUSY" }));
        let finish;
        const promise = new Promise((resolve, reject) => {
            let worker;
            let timer;
            let settled = false;
            finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.pending.delete(key);
                if (worker) worker.terminate().catch(() => {});
                if (error) reject(Object.assign(new Error(error.message), { code: error.code || "SVD_PARSE_FAILED" }));
                else resolve(result);
            };
            try {
                worker = new this.Worker(this.workerPath, {
                    workerData: { buffer, sourcePath },
                    resourceLimits: { maxOldGenerationSizeMb: 256 }
                });
                timer = setTimeout(
                    () => finish({ code: "SVD_PARSE_TIMEOUT", message: "SVD parsing exceeded 10 seconds" }),
                    this.timeoutMs
                );
                worker.once("message", (message) => finish(message.error, message.model));
                worker.once("error", finish);
                worker.once("exit", () => finish({ message: "SVD parser exited without a result" }));
            } catch (error) {
                finish(error);
            }
        });
        this.pending.set(key, { promise, finish });
        // Construction can fail synchronously, before the pending entry is set.
        promise
            .catch(() => {})
            .finally(() => {
                if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
            });
        return promise;
    }
    dispose() {
        this.disposed = true;
        for (const entry of this.pending.values()) entry.finish({ message: "SVD parser disposed" });
        this.pending.clear();
    }
}

module.exports = { SvdModelService };
