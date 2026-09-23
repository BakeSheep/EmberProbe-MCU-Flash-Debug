"use strict";
const path = require("path");
const { Worker } = require("worker_threads");
const { clampInteger } = require("./validation");
const { deserializeError } = require("./services/errorEnvelope");
class SamplingSession {
    constructor(options, handlers = {}, workerPath = path.join(__dirname, "samplingWorker.js")) {
        this.options = options;
        this.handlers = handlers;
        this.mode = options.mode === "debug" ? "debug" : "standalone";
        this.samplingEnabled = false;
        this.deliveryEnabled = this.mode !== "debug";
        this.stopped = false;
        this.generation = 0;
        this.nextId = 0;
        this.pending = new Map();
        this.worker = new Worker(workerPath, {
            workerData: { ...options, isolated: false }
        });
        this.worker.on("message", (message) => {
            if (message.state) {
                this.childPid = message.state.childPid;
                this.stopped = message.state.stopped;
                this.pollingFailed = message.state.pollingFailed === true;
                if (message.state.generation === this.generation) this.samplingEnabled = message.state.samplingEnabled;
            }
            if (message.event === "samples") {
                try {
                    for (const batch of message.batch)
                        if (batch.generation === this.generation && this.deliveryEnabled && !this.stopping)
                            this.handlers.onSample?.(batch.samples, batch.t);
                } finally {
                    this.worker.postMessage({ ack: true });
                }
            } else if (message.event) {
                if (message.event === "onConnectionConfirmed" && (this.stopping || this.stopped)) return;
                if (message.event === "onDisconnect" || message.event === "onDegraded") this.samplingEnabled = false;
                if (["onDisconnect", "onDegraded", "onError"].includes(message.event) && message.args[0]?.message)
                    message.args[0] = deserializeError(message.args[0]);
                this.handlers[message.event]?.(...message.args);
            } else {
                const request = this.pending.get(message.id);
                if (!request) return;
                this.pending.delete(message.id);
                if (message.error) request.reject(deserializeError(message.error));
                else request.resolve({ result: message.result, state: message.state });
            }
        });
        this.worker.on("error", (error) => this.fail(error));
        this.worker.on("exit", (code) => {
            this.exited = true;
            if (this.pending.size || !this.stopping) this.fail(new Error(`Sampling worker exited (${code})`));
        });
    }
    fail(error) {
        this.stopped = true;
        this.samplingEnabled = false;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
        if (this.childPid) {
            try {
                process.kill(this.childPid);
            } catch {
                /* Child already exited. */
            }
        }
        if (!this.stopping) this.handlers.onDisconnect?.(error);
    }
    request(method, args = []) {
        if (this.stopped && method !== "stop") return Promise.reject(new Error("Sampling session stopped"));
        if (this.exited) return Promise.reject(new Error("Sampling worker exited"));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.worker.postMessage({ id, method, args, generation: this.generation });
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }
    notify(method, args) {
        this.request(method, args).catch((error) => this.handlers.onError?.(error.message));
    }
    setWatch(items) {
        if (this.mode === "debug") require("./liveWatch").validateManagedReadPlan(items);
        this.notify("setWatch", [items]);
    }
    setIntervalMs(value) {
        this.options.intervalMs = clampInteger(value, 100, this.mode === "debug" ? 100 : 20, 10000);
        this.notify("setIntervalMs", [this.options.intervalMs]);
    }
    setSamplingEnabled(enabled) {
        if (enabled && this.pollingFailed) return false;
        if (enabled && this.samplingEnabled) return true;
        this.generation++;
        this.deliveryEnabled = !!enabled;
        this.samplingEnabled = !!enabled && !this.stopped;
        this.notify("setSamplingEnabled", [enabled]);
        return this.samplingEnabled;
    }
    async start() {
        const response = await this.request("start");
        this.samplingEnabled = response.state.samplingEnabled;
        return response.result;
    }
    async readOnce(...args) {
        return (await this.request("readOnce", args)).result;
    }
    async writeOnce(...args) {
        return (await this.request("writeOnce", args)).result;
    }
    async writeAndVerify(...args) {
        return (await this.request("writeAndVerify", args)).result;
    }
    async waitForIdle(...args) {
        return (await this.request("waitForIdle", args)).result;
    }
    async waitForExit(...args) {
        return (await this.request("waitForExit", args)).result;
    }
    stop(...args) {
        if (this.exited) return Promise.resolve();
        if (!this.stopping) {
            this.samplingEnabled = false;
            this.generation++;
            this.stopping = this.request("stop", args)
                .then((response) => response.result)
                .finally(async () => {
                    this.stopped = true;
                    await this.worker.terminate();
                });
        }
        return this.stopping;
    }
}
module.exports = { SamplingSession };
