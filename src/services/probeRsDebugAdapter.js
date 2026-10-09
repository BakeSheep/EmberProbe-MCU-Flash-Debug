"use strict";

const { spawn } = require("node:child_process");

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 8192;

// Own the stdio process rather than relying on a VS Code session-terminated event
// to prove that the USB connection has closed.
class ProbeRsDebugAdapter {
    constructor({
        coordinator,
        executable,
        cwd,
        emitter,
        onExit = () => {},
        onError = (_error) => {},
        spawnProcess = spawn,
        startupTimeoutMs = 60000,
        exitTimeoutMs = 2000
    }) {
        this.coordinator = coordinator;
        this.executable = executable;
        this.cwd = cwd;
        this.emitter = emitter;
        this.onDidSendMessage = emitter.event;
        this.onExit = onExit;
        this.onError = onError;
        this.spawnProcess = spawnProcess;
        this.startupTimeoutMs = startupTimeoutMs;
        this.exitTimeoutMs = exitTimeoutMs;
        this.process = null;
        this.lease = null;
        this.buffer = Buffer.alloc(0);
        this.stderr = "";
        this.seq = 0;
        this.terminated = false;
        this.exited = false;
        this.stopping = null;
        this.startupTimer = null;
        this.exitPromise = new Promise((resolve) => {
            this.resolveExit = resolve;
        });
    }

    start() {
        if (this.lease || this.exited) throw new Error("probe-rs adapter has already been started");
        this.lease = this.coordinator.acquire("debugStart");
        try {
            this.process = this.spawnProcess(this.executable, ["dap-server"], {
                cwd: this.cwd,
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"]
            });
            this.process.once("close", () => this._finish());
            this.process.once("error", (error) => {
                if (!this.process.pid) this._finish(); // Failed spawn: no process ever held the probe.
                this._fail(error);
            });
            this.process.stdin.on("error", (error) => this._fail(error));
            this.process.stdout.on("data", (chunk) => this._receive(chunk));
            this.process.stderr.on("data", (chunk) => {
                this.stderr = (this.stderr + String(chunk)).slice(-2000);
            });
            this.startupTimer = setTimeout(
                () => this._fail(new Error("Timed out starting the probe-rs debug adapter")),
                this.startupTimeoutMs
            );
        } catch (error) {
            if (!this.process) this._finish();
            else void this.stop();
            throw error;
        }
        return this;
    }

    handleMessage(message) {
        if (!this.process || this.exited || this.stopping) return;
        const body = JSON.stringify(message);
        this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }

    _receive(chunk) {
        if (this.exited || this.stopping) return;
        try {
            if (this.buffer.length + chunk.length > MAX_FRAME_BYTES + MAX_HEADER_BYTES)
                throw new Error("probe-rs DAP buffer exceeds the byte budget");
            this.buffer = Buffer.concat([this.buffer, chunk]);
            while (this.buffer.length) {
                const headerEnd = this.buffer.indexOf("\r\n\r\n");
                if (headerEnd < 0) {
                    if (this.buffer.length > MAX_HEADER_BYTES) throw new Error("Invalid probe-rs DAP header");
                    break;
                }
                const header = this.buffer.toString("ascii", 0, headerEnd);
                const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
                const length = Number(lengths[0]?.[1]);
                if (headerEnd > MAX_HEADER_BYTES || lengths.length !== 1 || length < 1 || length > MAX_FRAME_BYTES)
                    throw new Error("Invalid probe-rs DAP frame length");
                const end = headerEnd + 4 + length;
                if (this.buffer.length < end) break;
                const message = JSON.parse(this.buffer.toString("utf8", headerEnd + 4, end));
                this.buffer = this.buffer.subarray(end);
                if (!message || !["event", "request", "response"].includes(message.type))
                    throw new Error("Invalid probe-rs DAP message");
                this.seq = Math.max(this.seq, Number(message.seq) || 0);
                if (message.type === "event" && message.event === "terminated") this.terminated = true;
                if (message.type === "response" && ["launch", "attach"].includes(message.command)) {
                    clearTimeout(this.startupTimer);
                    this.startupTimer = null;
                    if (message.success && this.lease.operation === "debugStart")
                        this.lease = this.lease.transition("debugServer");
                }
                this.emitter.fire(message);
                if (message.type === "response" && ["launch", "attach"].includes(message.command) && !message.success)
                    void this.stop(true);
            }
        } catch (error) {
            this._fail(error);
        }
    }

    _fail(error) {
        this.onError(error);
        if (!this.exited) {
            this.emitter.fire({ type: "event", seq: ++this.seq, event: "output", body: { output: error.message } });
            void this.stop();
        }
    }

    _finish() {
        if (this.exited) return;
        this.exited = true;
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
        this.buffer = Buffer.alloc(0);
        this.lease?.release();
        this.resolveExit(true);
        if (!this.terminated) this.emitter.fire({ type: "event", seq: ++this.seq, event: "terminated" });
        this.onExit();
    }

    async waitForExit(timeoutMs = this.exitTimeoutMs) {
        if (this.exited) return true;
        let timer;
        try {
            return await Promise.race([
                this.exitPromise,
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(false), timeoutMs);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    stop(graceful = false) {
        if (this.exited) return Promise.resolve(true);
        if (this.stopping) return this.stopping;
        this.stopping = (async () => {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
            if (graceful) {
                // A disconnect response can precede the Rust session's USB cleanup.
                // Let the single-session server exit normally before forcing a kill.
                this.process?.stdin.end();
                if (await this.waitForExit()) return true;
            }
            try {
                this.process?.kill();
            } catch (error) {
                this.onError(error);
            }
            // A failed kill or a timeout must keep the lease until the close event.
            return this.waitForExit();
        })().finally(() => {
            this.stopping = null;
        });
        return this.stopping;
    }

    dispose() {
        void this.stop(true).then((closed) => {
            if (closed) this.emitter.dispose();
            else this.onError(new Error("probe-rs process exit has not been confirmed; probe lease retained"));
        });
    }
}

module.exports = { ProbeRsDebugAdapter, MAX_FRAME_BYTES };
