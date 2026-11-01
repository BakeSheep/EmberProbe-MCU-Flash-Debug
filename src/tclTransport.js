"use strict";
// One OpenOCD Tcl RPC connection. Requests and responses end with 0x1a and responses carry no ID, so they are matched to
// requests in order (one FIFO): after a timeout, a broken stream or a socket error a late response cannot be attributed,
// and the connection is reported to `onFailure` for the session to discard. Also probes whether results can come back
// without OpenOCD echoing them, and in debug mode reads results from a private file instead, because OpenOCD broadcasts
// non-empty Tcl results to GDB.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");
const { quoteTclWord } = require("./openocdRunner");

const SUB = "\x1a"; // Tcl-RPC command/response delimiter 0x1A
// More than 1 MiB without a delimiter means the response stream is broken.
const MAX_PENDING_CHARS = 1048576;

class TclTransport {
    // clock: the session clock. isClosed(): true once the session failed or stopped, so later data and closes are
    // ignored. onFailure(error): this connection can no longer be trusted.
    constructor({ clock, mode, rpcTimeoutMs, isClosed, onFailure }) {
        this.clock = clock;
        this.mode = mode;
        this.rpcTimeoutMs = rpcTimeoutMs;
        this.isClosed = isClosed;
        this.onFailure = onFailure;
        this.socket = null;
        this.pending = ""; // socket response buffer
        this.queue = []; // commands awaiting a response (serial, one in flight)
        this.noEchoResponses = false;
        // True while a capability query runs (see probe).
        this.probing = false;
        this._noEchoDetection = null;
        this._ready = null;
        this._responseDir = "";
        this._responseFile = "";
    }

    get connected() {
        return !!this.socket && !this.socket.destroyed;
    }

    // While held (the session is still connecting), commands wait for release() instead of failing.
    get held() {
        return !!this._ready;
    }

    hold() {
        let release;
        const promise = new Promise((resolve) => {
            release = resolve;
        });
        this._ready = { promise, release };
    }

    release() {
        const ready = this._ready;
        this._ready = null;
        ready?.release();
    }

    attach(socket) {
        this.socket = socket;
        this.pending = "";
        socket.setNoDelay(true);
        socket.on("data", (chunk) => {
            if (socket !== this.socket || this.isClosed()) return;
            this.pending += chunk.toString("latin1");
            let idx;
            while ((idx = this.pending.indexOf(SUB)) >= 0) {
                const resp = this.pending.slice(0, idx);
                this.pending = this.pending.slice(idx + 1);
                const q = this.queue.shift();
                if (q) q.resolve(resp);
                if (socket !== this.socket || this.isClosed()) return;
            }
            // Drop a runaway stream and reset the connection instead of growing forever.
            if (this.pending.length > MAX_PENDING_CHARS) {
                this.pending = "";
                this._fail(new Error("Invalid OpenOCD response stream: framing delimiter missing"));
            }
        });
        socket.on("error", (e) => {
            if (socket === this.socket) this._fail(e);
        });
        socket.on("close", () => {
            if (socket === this.socket && !this.isClosed()) this._fail(new Error("Tcl connection closed"));
        });
    }

    // Destroys `socket` (by default the current one) and forgets it if it is still current.
    close(socket = this.socket) {
        if (socket && !socket.destroyed) {
            try {
                socket.destroy();
            } catch (e) {
                /* ignore */
            }
        }
        if (this.socket === socket) this.socket = null;
    }

    rejectAll(error) {
        while (this.queue.length) {
            const q = this.queue.shift();
            q.reject(error);
        }
    }

    _fail(error) {
        if (!this.probing) return this.onFailure(error);
        // Capability probing is optional. Discard the ambiguous FIFO; the session reconnects. Acquisition timeouts still
        // go through the normal fatal connection path.
        const socket = this.socket;
        this.socket = null;
        this.pending = "";
        this.rejectAll(error);
        socket?.destroy();
    }

    // Sends one Tcl command serially and waits for the response (with a timeout).
    send(cmd) {
        if (this._ready) return this._ready.promise.then(() => this.send(cmd));
        return new Promise((resolve, reject) => {
            if (!this.connected) return reject(new Error("Socket is not connected"));
            const entry = {};
            const deadline = this.clock.now() + this.rpcTimeoutMs;
            const timer = this.clock.schedule(() => {
                if (this.queue.includes(entry))
                    this._fail(
                        Object.assign(new Error("OpenOCD response timed out; sampling connection reset"), {
                            code: "OPENOCD_RPC_TIMEOUT"
                        })
                    );
            }, this.rpcTimeoutMs);
            entry.resolve = (v) => {
                this.clock.cancel(timer);
                // A wake-up or busy event loop may dispatch data before the overdue timeout callback.
                if (this.clock.now() >= deadline) {
                    const error = Object.assign(new Error("OpenOCD response timed out; sampling connection reset"), {
                        code: "OPENOCD_RPC_TIMEOUT"
                    });
                    reject(error);
                    this._fail(error);
                    return;
                }
                resolve(v);
            };
            entry.reject = (e) => {
                this.clock.cancel(timer);
                reject(e);
            };
            this.queue.push(entry);
            try {
                this.socket.write(cmd + SUB);
            } catch (e) {
                this._fail(e);
            }
        });
    }

    // Runs `cmd` inside catch and returns its result, or throws OPENOCD_TCL_ERROR with OpenOCD's message.
    async sendChecked(cmd) {
        if (this._ready) await this._ready.promise;
        if (this.mode === "debug" && !this.noEchoResponses) return this._sendSilent(cmd);
        const result = this.noEchoResponses ? "return -code exit $_ep_out" : "set _ep_out";
        const wrapped = `set _ep_rc [catch {${cmd}} _ep_msg]; if {$_ep_rc} {set _ep_out "EP_ERR:\${_ep_msg}"} else {set _ep_out "EP_OK:\${_ep_msg}"}; ${result}`;
        const response = String((await this.send(wrapped)) || "").replace(/\x1a/g, "");
        if (response.startsWith("EP_OK:")) return response.slice(6);
        if (response.startsWith("EP_ERR:")) {
            throw Object.assign(new Error(response.slice(7).trim() || `OpenOCD command failed：${cmd}`), {
                code: "OPENOCD_TCL_ERROR"
            });
        }
        throw Object.assign(new Error(`Unrecognized OpenOCD Tcl response：${response.slice(0, 200)}`), {
            code: "OPENOCD_TCL_PROTOCOL_ERROR"
        });
    }

    // A capability query: it gets at most `timeoutMs`, and a failure discards the connection instead of reporting it.
    async probe(cmd, timeoutMs) {
        const timeout = this.rpcTimeoutMs;
        this.rpcTimeoutMs = Math.min(timeout, timeoutMs);
        this.probing = true;
        try {
            return await this.sendChecked(cmd);
        } finally {
            this.rpcTimeoutMs = timeout;
            this.probing = false;
        }
    }

    async _ensureResponseFile() {
        if (this._responseFile) return this._responseFile;
        this._responseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-openocd-"));
        this._responseFile = path.join(this._responseDir, "response");
        return this._responseFile;
    }

    async removeResponseFile() {
        const responseDir = this._responseDir;
        this._responseDir = "";
        this._responseFile = "";
        if (!responseDir) return;
        try {
            await fs.promises.rm(responseDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }

    // OpenOCD broadcasts non-empty Tcl RPC results to GDB, flooding the debug console with EP_OK:<value>. In debug mode
    // machine responses go to a private temporary file the extension creates, and the Tcl RPC itself returns an empty
    // string.
    async _sendSilent(cmd) {
        const responseFile = await this._ensureResponseFile();
        const wrapped = `set _ep_rc [catch {${cmd}} _ep_msg]; set _ep_file [open ${quoteTclWord(responseFile)} w]; puts -nonewline $_ep_file "\${_ep_rc}\\n"; puts -nonewline $_ep_file $_ep_msg; close $_ep_file; set _ep_msg ""`;
        const rpcResponse = String((await this.send(wrapped)) || "").replace(/\x1a/g, "");
        if (rpcResponse) {
            throw Object.assign(new Error(`Unexpected OpenOCD Tcl response：${rpcResponse.slice(0, 200)}`), {
                code: "OPENOCD_TCL_PROTOCOL_ERROR"
            });
        }
        let payload;
        try {
            payload = await fs.promises.readFile(responseFile, "utf8");
        } catch (error) {
            throw Object.assign(new Error(`Cannot read OpenOCD Tcl response：${error.message}`), {
                code: "OPENOCD_TCL_PROTOCOL_ERROR",
                cause: error
            });
        }
        const separator = payload.indexOf("\n");
        if (separator < 0 || (payload[0] !== "0" && payload[0] !== "1")) {
            throw Object.assign(new Error("Unrecognized OpenOCD silent Tcl response"), {
                code: "OPENOCD_TCL_PROTOCOL_ERROR"
            });
        }
        const response = payload.slice(separator + 1);
        if (payload[0] === "0") return response;
        throw Object.assign(new Error(response.trim() || `OpenOCD command failed：${cmd}`), {
            code: "OPENOCD_TCL_ERROR"
        });
    }

    // Returns true for the probe's own marker lines in the OpenOCD log, so the session does not report them; seeing the
    // marker before the sync line means OpenOCD echoes Tcl results.
    observeLog(line) {
        const detection = this._noEchoDetection;
        if (detection) {
            if (!detection.synced && line.includes(detection.marker)) detection.echoed = true;
            if (line.includes(detection.sync)) {
                detection.synced = true;
                detection.check();
            }
        }
        return /EP_(?:NOECHO|SYNC)_[a-f0-9]+/.test(line);
    }

    // Probes `socket`, which is the connection meanwhile so stopping the session closes it. Resolves whether the socket
    // can be reused: a partial reply cannot be in the untagged FIFO protocol.
    async detectNoEcho(socket) {
        this.socket = socket;
        try {
            return await this._detectNoEcho(socket);
        } catch {
            this.noEchoResponses = false;
            return false;
        }
    }

    _detectNoEcho(socket) {
        this.noEchoResponses = false;
        const nonce = randomBytes(12).toString("hex");
        return new Promise((resolve) => {
            let pending = "",
                replies = 0,
                settled = false;
            const detection = {
                marker: `EP_NOECHO_${nonce}`,
                sync: `EP_SYNC_${nonce}`,
                echoed: false,
                synced: false,
                check: () => {}
            };
            this._noEchoDetection = detection;
            const finish = (usable) => {
                if (settled) return;
                settled = true;
                this.clock.cancel(timer);
                socket.removeListener("data", onData);
                socket.removeListener("error", onClosed);
                socket.removeListener("close", onClosed);
                this._noEchoDetection = null;
                this.noEchoResponses = usable && !detection.echoed && (detection.synced || this.mode !== "debug");
                resolve(usable);
            };
            detection.check = () => {
                if (replies === 2 && !pending && detection.synced) finish(true);
            };
            const onClosed = () => finish(false);
            const onData = (chunk) => {
                pending += chunk.toString("latin1");
                let boundary;
                while ((boundary = pending.indexOf(SUB)) >= 0) {
                    const reply = pending.slice(0, boundary);
                    pending = pending.slice(boundary + 1);
                    if (reply !== (replies === 0 ? detection.marker : detection.sync)) return finish(false);
                    replies++;
                    if (replies === 1) {
                        try {
                            socket.write(`set _ep_sync ${detection.sync}${SUB}`);
                        } catch {
                            return finish(false);
                        }
                    } else detection.check();
                }
                if (pending.length > 4096) finish(false);
            };
            const timer = this.clock.schedule(() => finish(replies === 2 && !pending && !socket.destroyed), 500);
            socket.on("data", onData);
            socket.on("error", onClosed);
            socket.on("close", onClosed);
            try {
                socket.write(`return -code exit ${detection.marker}${SUB}`);
            } catch {
                finish(false);
            }
        });
    }

    // Asks OpenOCD to exit; resolves whether the request was written within 150 ms.
    shutdown() {
        const socket = this.socket;
        return new Promise((resolve) => {
            if (!socket || socket.destroyed) return resolve(false);
            let settled = false;
            const finish = (sent) => {
                if (settled) return;
                settled = true;
                this.clock.cancel(timer);
                resolve(sent);
            };
            const timer = this.clock.schedule(() => finish(false), 150);
            try {
                socket.write("shutdown" + SUB, () => finish(true));
            } catch (e) {
                finish(false);
            }
        });
    }
}

module.exports = { TclTransport };
