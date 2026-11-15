"use strict";
const { spawn } = require("child_process");
const { SYSTEM_CLOCK } = require("./samplingClock");
const { ProbeRsDecoder, encodeRequest, protocolError } = require("./probeRsProtocol");

class ProbeRsProcess {
    constructor(options, handlers = {}, dependencies = {}) {
        this.options = options;
        this.handlers = handlers;
        this.clock = { ...SYSTEM_CLOCK, ...options.clock };
        this.spawn = dependencies.spawn || spawn;
        this.pending = new Map();
        this.nextId = 0;
        this.stderr = "";
        this.decoder = new ProbeRsDecoder((message) => this.receive(message));
    }
    async start(params) {
        if (this.child) throw new Error("Native sampling process already started");
        this.exitPromise = new Promise((resolve) => {
            this.resolveExit = resolve;
        });
        this.child = this.spawn(this.options.nativeExecutable, this.options.nativeArgs || [], {
            cwd: this.options.cwd,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"]
        });
        this.child.once("error", (error) => this.fail(error));
        this.child.once("close", (code) => {
            this.exited = true;
            this.resolveExit(true);
            if (!this.closing)
                this.fail(
                    Object.assign(new Error(`Native sampler exited (${code}): ${this.stderr}`), {
                        code: "PROBE_RS_EXITED"
                    })
                );
            else this.rejectPending(new Error("Native sampling process stopped"));
        });
        this.child.stdin.on("error", (error) => {
            if (!this.closing) this.fail(error);
        });
        this.child.stderr.on("data", (chunk) => {
            this.stderr = (this.stderr + String(chunk)).slice(-8000);
        });
        this.child.stdout.on("data", (chunk) => {
            try {
                this.decoder.receive(chunk);
            } catch (error) {
                this.fail(error);
            }
        });
        return this.request("start", params, 30000);
    }
    request(method, params, timeoutMs = 5000) {
        if (this.failed) return Promise.reject(this.failed);
        if (!this.child || this.exited) return Promise.reject(new Error("Native sampling process is not running"));
        if (this.pending.size >= 64) return Promise.reject(protocolError("Too many native requests in flight"));
        const id = ++this.nextId;
        let frame;
        try {
            frame = encodeRequest(id, method, params);
        } catch (error) {
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            const timer = this.clock.schedule(() => {
                this.fail(
                    Object.assign(new Error(`Native ${method} timed out`), {
                        code: "PROBE_RS_TIMEOUT",
                        retryable: false,
                        details: { method, timeoutMs, resultUnknown: true }
                    })
                );
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.child.stdin.write(frame);
            } catch (error) {
                this.fail(error);
            }
        });
    }
    receive(message) {
        if (this.exited || this.failed || (this.closing && message.type === "samples")) return;
        if (message.type === "samples") return this.handlers.onSamples?.(message);
        const value = message.value;
        if (value.event === "failure") return this.fail(this.error(value.error));
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id);
        this.clock.cancel(request.timer);
        if (value.ok === true) request.resolve(value.result);
        else if (value.ok === false) request.reject(this.error(value.error));
        else {
            request.reject(protocolError("Native response is missing success status"));
        }
    }
    error(error) {
        return Object.assign(new Error(String(error?.message || "Native sampling failed")), {
            code: String(error?.code || "PROBE_RS_REQUEST_FAILED"),
            retryable: false,
            details: { nativeTail: this.stderr }
        });
    }
    rejectPending(error) {
        for (const pending of this.pending.values()) {
            this.clock.cancel(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    fail(error) {
        if (this.failed || this.closing) return;
        this.failed = error;
        this.rejectPending(error);
        this.handlers.onFailure?.(error);
    }
    waitForExit(timeoutMs = 1200) {
        if (!this.child || this.exited) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = this.clock.schedule(() => resolve(false), timeoutMs);
            this.exitPromise.then(() => {
                this.clock.cancel(timer);
                resolve(true);
            });
        });
    }
    stop(timeoutMs = 1200) {
        if (this.stopping) return this.stopping;
        this.stopping = (async () => {
            if (!this.child || this.exited) return true;
            if (!this.failed) {
                try {
                    await this.request("stop", null, timeoutMs);
                } catch {
                    /* Still confirm physical exit below. */
                }
            }
            this.closing = true;
            this.rejectPending(new Error("Native sampling process stopped"));
            this.child.stdin.end();
            if (await this.waitForExit(timeoutMs)) return true;
            try {
                this.child.kill();
            } catch {
                /* A failed kill cannot establish exit. */
            }
            return this.waitForExit(timeoutMs);
        })().finally(() => {
            this.stopping = null;
        });
        return this.stopping;
    }
}
module.exports = { ProbeRsProcess };
