"use strict";
// 管理单一 OpenOCD 服务：独立模式仅开放 Tcl，调试模式同时开放 GDB，并通过 Tcl-RPC 只读采样 RAM。
// 说明：受 MCUViewer（GPLv3）概念启发的独立实现，未使用其任何代码。
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { isSafeCfg, quoteTclWord, diagnoseOpenOcdFailure } = require("./openocdRunner");
const { resolveOpenOcdLaunch } = require("./openocdScripts");
const { clampInteger } = require("./validation");

const SUB = "\x1a"; // Tcl-RPC 命令/响应分帧符 0x1A
const MAX_DEBUG_READ_BYTES = 4096;
const MAX_DEBUG_READ_COMMANDS = 32;
const MAX_DEBUG_CYCLE_MS = 1000;

// 让操作系统分配一个当前空闲的临时端口。OpenOCD 的 Tcl 端口无认证，固定端口会让
// 采样期间的任意本机进程都能连接并下发 halt/write_memory；未显式配置端口时应随机选用。
function findFreePort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once("error", () => resolve(0));
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = address && typeof address === "object" ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}

// 解析 read_memory / ocd_read_memory 的返回值：支持十进制、0x 前缀，并剥离可能的地址标签
function parseMemoryValues(text) {
    if (!text) return [];
    const cleaned = String(text)
        .replace(/\x1a/g, " ")
        .replace(/(^|\s)(0x)?[0-9a-fA-F]+:/g, " ");
    const out = [];
    for (const tok of cleaned.trim().split(/\s+/)) {
        if (!tok) continue;
        let n;
        if (/^0x[0-9a-fA-F]+$/i.test(tok)) n = parseInt(tok, 16);
        else if (/^-?[0-9]+$/.test(tok)) n = parseInt(tok, 10);
        else continue;
        if (Number.isInteger(n) && n >= 0 && n <= 255) out.push(n);
    }
    return out;
}

function parseMemoryElements(text, widthBits) {
    if (!text) return [];
    const max = widthBits === 32 ? 0xffffffff : widthBits === 16 ? 0xffff : 0xff;
    const cleaned = String(text)
        .replace(/\x1a/g, " ")
        .replace(/(^|\s)(0x)?[0-9a-fA-F]+:/g, " ");
    const out = [];
    for (const tok of cleaned.trim().split(/\s+/)) {
        if (!tok) continue;
        let n;
        if (/^0x[0-9a-fA-F]+$/i.test(tok)) n = parseInt(tok, 16);
        else if (/^[0-9a-fA-F]*[a-f][0-9a-fA-F]*$/i.test(tok)) n = parseInt(tok, 16);
        else if (/^-?[0-9]+$/.test(tok)) n = parseInt(tok, 10);
        else continue;
        if (Number.isInteger(n) && n < 0 && n >= -(2 ** (widthBits - 1))) n += 2 ** widthBits;
        if (Number.isInteger(n) && n >= 0 && n <= max) out.push(n >>> 0);
    }
    return out;
}

function transferShape(address, byteCount) {
    if ((address & 3) === 0 && byteCount % 4 === 0) return { widthBits: 32, elementBytes: 4, count: byteCount / 4 };
    if ((address & 1) === 0 && byteCount % 2 === 0) return { widthBits: 16, elementBytes: 2, count: byteCount / 2 };
    return { widthBits: 8, elementBytes: 1, count: byteCount };
}

function bytesToElements(bytes, elementBytes) {
    const elements = [];
    for (let offset = 0; offset < bytes.length; offset += elementBytes) {
        let value = 0;
        for (let index = 0; index < elementBytes; index++) value += (bytes[offset + index] & 0xff) * 2 ** (index * 8);
        elements.push(value >>> 0);
    }
    return elements;
}

function elementsToBytes(elements, elementBytes) {
    const bytes = [];
    for (const element of elements) {
        for (let index = 0; index < elementBytes; index++) bytes.push((element >>> (index * 8)) & 0xff);
    }
    return bytes;
}

function validateManagedReadPlan(items, maxBytes = MAX_DEBUG_READ_BYTES, maxCommands = MAX_DEBUG_READ_COMMANDS) {
    const ranges = (Array.isArray(items) ? items : [])
        .map((item) => ({ start: Number(item?.address), size: Number(item?.size) }))
        .filter((item) => Number.isInteger(item.start) && Number.isInteger(item.size) && item.size > 0)
        .sort((a, b) => a.start - b.start || a.size - b.size);
    let total = 0;
    let commandCount = 0;
    let current = null;
    for (const range of ranges) {
        const end = range.start + range.size;
        if (!Number.isSafeInteger(end) || range.start < 0 || end > 0x100000000) {
            throw Object.assign(new Error("Runtime read range overflows the 32-bit target address space"), {
                code: "LIVE_ADDRESS_NOT_RAM"
            });
        }
        if (current && range.start <= current.end) current.end = Math.max(current.end, end);
        else {
            if (current) {
                total += current.end - current.start;
                commandCount++;
            }
            current = { start: range.start, end };
        }
    }
    if (current) {
        total += current.end - current.start;
        commandCount++;
    }
    if (total > maxBytes || commandCount > maxCommands) {
        throw Object.assign(
            new Error(`Runtime read plan exceeds the per-cycle budget (${maxBytes} bytes / ${maxCommands} commands)`),
            {
                code: "LIVE_READ_BUDGET_EXCEEDED",
                details: { totalBytes: total, maxBytes, commandCount, maxCommands }
            }
        );
    }
    return total;
}

// 复用 openocdRunner 的配置名白名单校验

class ManagedOpenOcdSession {
    // options: { executable, probe, target, cwd, port, gdbPort, intervalMs, mode }
    // handlers: { onSample(samples,t), onStatus(msg), onError(msg), onDegraded(error), onDisconnect(error) }
    constructor(vscode, options, handlers) {
        this.vscode = vscode;
        this.options = options || {};
        this.handlers = handlers || {};
        this.child = null;
        this.socket = null;
        this.connectingSocket = null;
        this.timer = null;
        this.busy = false;
        this.stopped = false;
        this.pending = ""; // socket 响应缓冲
        this.queue = []; // 待响应的命令（串行，单条在途）
        this.watch = []; // [{name,address,size,type}]
        this.readCmd = "ocd_read_memory"; // 主用命令，不可用时回退 read_memory
        this.altTried = false;
        this.writeCmd = "ocd_write_memory"; // 写入主用命令，不可用时回退 write_memory
        this.writeAltTried = false;
        this._lastReadError = "";
        this._notifiedError = "";
        this._sampleErrorActive = false;
        this.connectionFailed = false;
        this.connectionError = null;
        this._startReject = null; // start() 进行中时捕获的 reject，用于单通道上报连接期失败
        this._openOcdLogTail = [];
        this._openOcdRawTail = "";
        this._stopPromise = null;
        this.mode = this.options.mode === "debug" ? "debug" : "standalone";
        this.samplingEnabled = this.mode === "standalone";
        this._samplingRequested = this.samplingEnabled;
        this.sampleEpoch = 0;
        this._reconnectPromise = null;
        this._startCompleted = false;
        this._tclListening = false;
        this._silentResponseDir = "";
        this._silentResponseFile = "";
    }

    setWatch(list) {
        const next = Array.isArray(list) ? list.slice() : [];
        if (this.mode === "debug") validateManagedReadPlan(next);
        this.watch = next;
    }

    // 运行中动态调整采样间隔：重建定时器
    setIntervalMs(ms) {
        const minimum = this.mode === "debug" ? 100 : 20;
        const interval = clampInteger(ms, 100, minimum, 10000);
        this.options.intervalMs = interval;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.samplingEnabled && !this.stopped && this.socket && !this.socket.destroyed) {
            this.timer = setInterval(() => {
                this._sampleTick();
            }, interval);
        }
    }

    setSamplingEnabled(enabled) {
        this._samplingRequested = !!enabled;
        this.sampleEpoch++;
        this.samplingEnabled = !!enabled && !this.stopped && !!this.socket && !this.socket.destroyed;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.samplingEnabled) {
            const minimum = this.mode === "debug" ? 100 : 20;
            const interval = clampInteger(this.options.intervalMs, 100, minimum, 10000);
            this.timer = setInterval(() => {
                this._sampleTick();
            }, interval);
        } else if (enabled && this.mode === "debug" && !this.stopped && this.child) {
            this._reconnectDebugTcl();
        }
        return this.samplingEnabled;
    }

    _status(msg) {
        if (this.handlers.onStatus) this.handlers.onStatus(msg);
    }
    _error(msg) {
        this._sampleErrorActive = true;
        if (this.handlers.onError) this.handlers.onError(msg);
    }
    // 采样中拔出调试器的致命日志特征（USB 读写失败 / 设备丢失），用于自动停止采样
    _isFatalProbeLog(line) {
        return /WriteFile|ReadFile|LIBUSB_ERROR_(?:NO_DEVICE|IO|PIPE)|error (?:writing|reading) data|target communication error/i.test(
            String(line || "")
        );
    }

    async start() {
        if (!isSafeCfg(this.options.probe) || !isSafeCfg(this.options.target)) {
            throw new Error(`非法的 OpenOCD 配置名：${this.options.probe} / ${this.options.target}`);
        }
        const port = clampInteger(this.options.port, 6666, 1, 65535);
        const interval = clampInteger(this.options.intervalMs, 100, this.mode === "debug" ? 100 : 20, 10000);
        const gdbPort = this.mode === "debug" ? clampInteger(this.options.gdbPort, 0, 1, 65535) : 0;
        if (this.mode === "debug" && !gdbPort) throw new Error("Managed debug OpenOCD requires a GDB port");
        if (/(^|\/)gd32vf103\.cfg$/i.test(this.options.target)) {
            throw Object.assign(new Error("GD32VF103 在 CPU 运行时不支持调试器内存访问，无法启用非侵入实时变量"), {
                code: "LIVE_MEMORY_UNSUPPORTED"
            });
        }
        const launch = resolveOpenOcdLaunch(this.options.executable, this.options.probe, this.options.target);
        const args = [
            "-s",
            launch.scriptsRoot,
            "-f",
            launch.probePath,
            "-f",
            launch.targetPath,
            "-c",
            "bindto 127.0.0.1",
            "-c",
            `tcl_port ${port}`,
            "-c",
            this.mode === "debug" ? `gdb_port ${gdbPort}` : "gdb_port disabled",
            "-c",
            "telnet_port disabled",
            ...(this.mode === "debug"
                ? ["-c", "foreach _ep_target [target names] { $_ep_target configure -work-area-backup 1 }"]
                : []),
            "-c",
            "init" // 仅初始化，不 halt/不 reset，保持非侵入
        ];
        this._status({ key: "lw.connecting" });
        try {
            this.child = spawn(launch.executable, args, { cwd: launch.cwd, windowsHide: true, shell: false });
        } catch (error) {
            const spawnError = /** @type {NodeJS.ErrnoException} */ (error);
            throw spawnError.code === "ENOENT"
                ? Object.assign(new Error(`找不到 OpenOCD：${this.options.executable}`), {
                      i18nKey: "run.notFound",
                      i18nParams: { path: this.options.executable }
                  })
                : new Error(spawnError.message);
        }
        this.child.on("error", (error) => {
            const childError = /** @type {NodeJS.ErrnoException} */ (error);
            const enoent = childError.code === "ENOENT";
            const e = enoent
                ? Object.assign(new Error(`找不到 OpenOCD：${this.options.executable}`), {
                      i18nKey: "run.notFound",
                      i18nParams: { path: this.options.executable }
                  })
                : new Error(childError.message);
            this._abortConnection(e);
        });
        const onLog = (chunk) => {
            const text = chunk.toString();
            this._openOcdRawTail = (this._openOcdRawTail + text).slice(-2000);
            const readyPattern = new RegExp(`Listening on port\\s+${port}\\s+for tcl connections`, "i");
            if (readyPattern.test(this._openOcdRawTail)) this._tclListening = true;
            for (const line of text.split(/\r?\n/)) {
                const clean = line.trim();
                if (!clean) continue;
                this._openOcdLogTail.push(clean.slice(0, 500));
                if (this._openOcdLogTail.length > 20) this._openOcdLogTail.shift();
                // 采样中拔出调试器：USB 读写失败等致命信号 → 自动停止采样，避免错误反复刷屏
                if (this._isFatalProbeLog(clean)) {
                    if (!this.stopped && !this.connectionFailed) {
                        this._abortConnection(
                            Object.assign(new Error("Debugger disconnected; live sampling stopped"), {
                                i18nKey: "live.probeDisconnected"
                            })
                        );
                    }
                    return;
                }
                if (this.connectionFailed) continue;
                // Info : Unable to ... 可能只是降速等正常提示；非 Info 行仍识别常见连接失败。
                const isInfo = /\bInfo\s*:/i.test(clean);
                if (
                    /\bError\s*:/i.test(clean) ||
                    (!isInfo && /failed|unable to|no device found|libusb|in use|denied|timed out/i.test(clean))
                ) {
                    this._error(clean.replace(/^.*?Error\s*:\s*/i, "") || clean);
                }
            }
        };
        this.child.stdout.on("data", onLog);
        this.child.stderr.on("data", onLog);
        this.child.on("close", (code) => {
            const expected = this.stopped;
            this.child = null;
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
            if (this.socket && !this.socket.destroyed) {
                try {
                    this.socket.destroy();
                } catch (e) {
                    /* ignore */
                }
            }
            this.socket = null;
            this.stopped = true;
            if (!expected) {
                const diagnostic = diagnoseOpenOcdFailure(this._openOcdLogTail, { exitCode: code, port });
                const error = Object.assign(new Error(diagnostic.message), diagnostic, {
                    i18nKey: "live.serviceExited",
                    i18nParams: { code, port }
                });
                this.connectionFailed = true;
                this.connectionError = error;
                this._rejectQueue(error);
                if (this._startReject) {
                    const reject = this._startReject;
                    this._startReject = null;
                    reject(error);
                } else if (this.handlers.onDisconnect) this.handlers.onDisconnect(error);
                else this._error(error.message);
            }
        });

        // start() 进行期间若子进程退出，_abortConnection 通过 _startReject 拒绝此 Promise，
        // 由调用方一次性上报；避免 onDisconnect 与 start() 抛出重复通知。
        try {
            await new Promise((resolve, reject) => {
                this._startReject = reject;
                if (this.stopped) {
                    reject(this.connectionError || new Error("OpenOCD 服务在连接过程中已退出"));
                    return;
                }
                this._waitForTclListening(6000)
                    .then(() => this._connectWithRetry(port, 1000))
                    .then((sock) => {
                        if (this.stopped) {
                            try {
                                sock.destroy();
                            } catch (e) {
                                /* ignore */
                            }
                            reject(this.connectionError || new Error("OpenOCD 服务在连接过程中已退出"));
                            return;
                        }
                        this.socket = sock;
                        this._setupSocket();
                        this._status({ key: "lw.connected" });
                        if (this._samplingRequested) {
                            this.samplingEnabled = true;
                            this.timer = setInterval(() => {
                                this._sampleTick();
                            }, interval);
                        }
                        resolve(undefined);
                    }, reject);
            });
        } finally {
            this._startReject = null;
        }
        this._startCompleted = true;
        return Object.freeze({
            gdbTarget: this.mode === "debug" ? `127.0.0.1:${gdbPort}` : null,
            tclPort: port,
            mode: this.mode
        });
    }

    waitForExit(timeoutMs = 1200) {
        const child = this.child;
        if (!child || child.exitCode !== null) return Promise.resolve(true);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (closed) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child.removeListener("close", onClose);
                resolve(closed);
            };
            const onClose = () => finish(true);
            const timer = setTimeout(() => finish(false), Math.max(100, Number(timeoutMs) || 1200));
            child.once("close", onClose);
        });
    }

    async _waitForTclListening(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (!this._tclListening) {
            if (this.stopped) throw this.connectionError || new Error("OpenOCD service exited before Tcl was ready");
            if (!this.child || Date.now() >= deadline) {
                const diagnostic = diagnoseOpenOcdFailure(this._openOcdLogTail, {
                    port: clampInteger(this.options.port, 6666, 1, 65535)
                });
                throw Object.assign(new Error(diagnostic.message), diagnostic);
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }

    _connectWithRetry(port, timeoutMs) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const attempt = () => {
                if (this.stopped) return reject(this.connectionError || new Error("已停止"));
                const sock = net.connect({ host: "127.0.0.1", port });
                this.connectingSocket = sock;
                const onConnect = () => {
                    sock.removeListener("error", onInitialError);
                    if (this.connectingSocket === sock) this.connectingSocket = null;
                    if (this.stopped) {
                        try {
                            sock.destroy();
                        } catch (e) {
                            /* ignore */
                        }
                        reject(this.connectionError || new Error("已停止"));
                        return;
                    }
                    resolve(sock);
                };
                const onInitialError = () => {
                    sock.removeListener("connect", onConnect);
                    if (this.connectingSocket === sock) this.connectingSocket = null;
                    try {
                        sock.destroy();
                    } catch (e) {
                        /* ignore */
                    }
                    if (this.stopped) reject(this.connectionError || new Error("已停止"));
                    else if (Date.now() > deadline) {
                        const diagnostic = diagnoseOpenOcdFailure(this._openOcdLogTail, { port });
                        reject(Object.assign(new Error(diagnostic.message), diagnostic));
                    } else setTimeout(attempt, 200);
                };
                sock.once("connect", onConnect);
                sock.once("error", onInitialError);
            };
            attempt();
        });
    }

    _setupSocket() {
        this.socket.setNoDelay(true);
        this.socket.on("data", (chunk) => {
            this.pending += chunk.toString("latin1");
            let idx;
            while ((idx = this.pending.indexOf(SUB)) >= 0) {
                const resp = this.pending.slice(0, idx);
                this.pending = this.pending.slice(idx + 1);
                const q = this.queue.shift();
                if (q) q.resolve(resp);
            }
            // 失控流兜底：若缓冲累积超过 1MB 仍未出现分帧符，说明响应流异常，丢弃并重置连接，避免无限增长
            if (this.pending.length > 1048576) {
                this.pending = "";
                this._abortConnection(new Error("OpenOCD 响应流异常：未收到分帧符"));
            }
        });
        this.socket.on("error", (e) => this._abortConnection(e));
        this.socket.on("close", () => {
            if (!this.stopped) this._abortConnection(new Error("Tcl 连接已关闭"));
        });
    }

    _rejectQueue(error) {
        while (this.queue.length) {
            const q = this.queue.shift();
            q.reject(error);
        }
    }

    _reconnectDebugTcl() {
        if (this._reconnectPromise || this.mode !== "debug" || this.stopped) return this._reconnectPromise;
        const delays = [250, 500, 1000];
        const port = clampInteger(this.options.port, 6666, 1, 65535);
        this._reconnectPromise = (async () => {
            for (const delayMs of delays) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                if (this.stopped || !this.child) return false;
                try {
                    const socket = await this._connectWithRetry(port, 400);
                    if (this.stopped || !this.child) {
                        try {
                            socket.destroy();
                        } catch {
                            /* ignore */
                        }
                        return false;
                    }
                    this.socket = socket;
                    this.pending = "";
                    this.connectionFailed = false;
                    this.connectionError = null;
                    this._setupSocket();
                    this.setSamplingEnabled(this._samplingRequested);
                    this._status({ key: "live.debugRuntimeSampling" });
                    return true;
                } catch {
                    /* retry */
                }
            }
            if (this.handlers.onDegraded) this.handlers.onDegraded(this.connectionError);
            return false;
        })().finally(() => {
            this._reconnectPromise = null;
        });
        return this._reconnectPromise;
    }

    // 响应是无 ID 的 FIFO 流。任一请求超时后无法判断迟到响应属于谁，只能废弃整条连接。
    _abortConnection(error) {
        const err = error instanceof Error ? error : new Error(String(error || "连接已断开"));
        if (this.connectionFailed) return;
        this.connectionFailed = true;
        this.connectionError = err;
        if (this.mode === "debug" && this.child && !this.stopped && this._startCompleted) {
            this.sampleEpoch++;
            this.samplingEnabled = false;
            if (this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
            this._rejectQueue(err);
            if (this.socket && !this.socket.destroyed) {
                try {
                    this.socket.destroy();
                } catch (e) {
                    /* ignore */
                }
            }
            this.socket = null;
            if (this.connectingSocket && !this.connectingSocket.destroyed) {
                try {
                    this.connectingSocket.destroy();
                } catch (e) {
                    /* ignore */
                }
            }
            this.connectingSocket = null;
            this._status({ key: "live.debugTclDegraded" });
            this._reconnectDebugTcl();
            return;
        }
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this._rejectQueue(err);
        if (this.socket && !this.socket.destroyed) {
            try {
                this.socket.destroy();
            } catch (e) {
                /* ignore */
            }
        }
        this.socket = null;
        if (this.connectingSocket && !this.connectingSocket.destroyed) {
            try {
                this.connectingSocket.destroy();
            } catch (e) {
                /* ignore */
            }
        }
        this.connectingSocket = null;
        if (this.child && !this.child.killed) {
            try {
                this.child.kill();
            } catch (e) {
                /* ignore */
            }
        }
        // start() 仍在进行中时，以拒绝其 Promise 作为唯一通知通道，避免 onDisconnect 重复上报
        if (this._startReject) {
            const reject = this._startReject;
            this._startReject = null;
            reject(err);
        } else if (this.handlers.onDisconnect) {
            this.handlers.onDisconnect(err);
        } else {
            this._error(err.message);
        }
    }

    // 串行发送单条 Tcl 命令并等待响应（带超时）
    _sendCommand(cmd) {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) return reject(new Error("socket 未连接"));
            const entry = {};
            const timer = setTimeout(() => {
                if (this.queue.includes(entry)) this._abortConnection(new Error("OpenOCD 响应超时，采样连接已重置"));
            }, 2000);
            entry.resolve = (v) => {
                clearTimeout(timer);
                resolve(v);
            };
            entry.reject = (e) => {
                clearTimeout(timer);
                reject(e);
            };
            this.queue.push(entry);
            try {
                this.socket.write(cmd + SUB);
            } catch (e) {
                this._abortConnection(e);
            }
        });
    }

    async _sendCheckedCommand(cmd) {
        if (this.mode === "debug") return this._sendSilentDebugCommand(cmd);
        const wrapped = `set _ep_rc [catch {${cmd}} _ep_msg]; if {$_ep_rc} {set _ep_out "EP_ERR:\${_ep_msg}"} else {set _ep_out "EP_OK:\${_ep_msg}"}; set _ep_out`;
        const response = String((await this._sendCommand(wrapped)) || "").replace(/\x1a/g, "");
        if (response.startsWith("EP_OK:")) return response.slice(6);
        if (response.startsWith("EP_ERR:")) {
            throw Object.assign(new Error(response.slice(7).trim() || `OpenOCD 命令失败：${cmd}`), {
                code: "OPENOCD_TCL_ERROR"
            });
        }
        throw Object.assign(new Error(`OpenOCD 返回了无法识别的 Tcl 响应：${response.slice(0, 200)}`), {
            code: "OPENOCD_TCL_PROTOCOL_ERROR"
        });
    }

    async _ensureSilentResponseFile() {
        if (this._silentResponseFile) return this._silentResponseFile;
        this._silentResponseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-openocd-"));
        this._silentResponseFile = path.join(this._silentResponseDir, "response");
        return this._silentResponseFile;
    }

    // OpenOCD 会把 Tcl RPC 的非空返回值广播给 GDB，导致 Cortex-Debug 控制台持续刷出
    // EP_OK:<value>。调试模式把机器响应写入扩展创建的私有临时文件，让 Tcl RPC 本身返回空串。
    async _sendSilentDebugCommand(cmd) {
        const responseFile = await this._ensureSilentResponseFile();
        const wrapped = `set _ep_rc [catch {${cmd}} _ep_msg]; set _ep_file [open ${quoteTclWord(responseFile)} w]; puts -nonewline $_ep_file "\${_ep_rc}\\n"; puts -nonewline $_ep_file $_ep_msg; close $_ep_file; set _ep_msg ""`;
        const rpcResponse = String((await this._sendCommand(wrapped)) || "").replace(/\x1a/g, "");
        if (rpcResponse) {
            throw Object.assign(new Error(`OpenOCD 返回了非预期的 Tcl 响应：${rpcResponse.slice(0, 200)}`), {
                code: "OPENOCD_TCL_PROTOCOL_ERROR"
            });
        }
        let payload;
        try {
            payload = await fs.promises.readFile(responseFile, "utf8");
        } catch (error) {
            throw Object.assign(new Error(`无法读取 OpenOCD Tcl 响应：${error.message}`), {
                code: "OPENOCD_TCL_PROTOCOL_ERROR",
                cause: error
            });
        }
        const separator = payload.indexOf("\n");
        if (separator < 0 || (payload[0] !== "0" && payload[0] !== "1")) {
            throw Object.assign(new Error("OpenOCD 返回了无法识别的静默 Tcl 响应"), {
                code: "OPENOCD_TCL_PROTOCOL_ERROR"
            });
        }
        const response = payload.slice(separator + 1);
        if (payload[0] === "0") return response;
        throw Object.assign(new Error(response.trim() || `OpenOCD 命令失败：${cmd}`), { code: "OPENOCD_TCL_ERROR" });
    }

    // 按地址/长度选择 32/16/8 bit 传输，再统一解包为小端字节。
    async _readMemoryBytes(addr, count) {
        const hex = "0x" + (addr >>> 0).toString(16);
        const shape = transferShape(addr, count);
        const build = (cmd) => `${cmd} ${hex} ${shape.widthBits} ${shape.count}`;
        let resp;
        try {
            resp = await this._sendCheckedCommand(build(this.readCmd));
        } catch (error) {
            if (!this.altTried && /invalid command name|unknown command/i.test(error.message)) {
                this.altTried = true;
                this.readCmd = this.readCmd === "ocd_read_memory" ? "read_memory" : "ocd_read_memory";
                resp = await this._sendCheckedCommand(build(this.readCmd));
            } else throw error;
        }
        const values = parseMemoryElements(resp, shape.widthBits);
        if (values.length < shape.count) {
            this._lastReadError = String(resp || "")
                .trim()
                .slice(0, 200);
            return null;
        }
        return elementsToBytes(values.slice(0, shape.count), shape.elementBytes).slice(0, count);
    }

    _assertReadGuard(guard) {
        if (!guard) return;
        if (guard.epoch !== this.sampleEpoch || (guard.requireSampling && !this.samplingEnabled)) {
            throw Object.assign(new Error("Runtime read was cancelled by a target state change"), {
                code: "LIVE_READ_CANCELLED"
            });
        }
        if (Number.isFinite(guard.deadline) && Date.now() >= guard.deadline) {
            throw Object.assign(new Error(`Runtime read exceeded the ${MAX_DEBUG_CYCLE_MS} ms per-cycle budget`), {
                code: "LIVE_READ_BUDGET_EXCEEDED",
                details: { maxCycleMs: MAX_DEBUG_CYCLE_MS }
            });
        }
    }

    async _readItems(items, t, guard = null) {
        const samples = [];
        let ok = 0;
        // 按地址排序后将地址连续的变量合并为一次读取，减少 Tcl 往返。
        const sorted = items.slice().sort((a, b) => (a.address >>> 0) - (b.address >>> 0));
        const groups = [];
        for (const v of sorted) {
            const last = groups[groups.length - 1];
            if (last && v.address <= last.end) {
                last.vars.push(v);
                last.end = Math.max(last.end, v.address + v.size);
            } else {
                groups.push({ start: v.address, end: v.address + v.size, vars: [v] });
            }
        }
        for (const g of groups) {
            this._assertReadGuard(guard);
            const bytes = await this._readMemoryBytes(g.start, g.end - g.start);
            this._assertReadGuard(guard);
            if (bytes) {
                for (const v of g.vars) {
                    const off = v.address - g.start;
                    samples.push({ name: v.name, bytes: bytes.slice(off, off + v.size), t });
                    ok++;
                }
            } else {
                for (const v of g.vars) samples.push({ name: v.name, bytes: null, t });
            }
        }
        return { samples, ok };
    }

    // 在现有 Tcl 连接上读取一组变量一次，不改变 UI 的观察列表或采样定时器。
    async readOnce(items, timeoutMs = 2500) {
        if (!Array.isArray(items) || !items.length) return [];
        if (this.mode === "debug") validateManagedReadPlan(items);
        if (this.stopped || !this.socket || this.socket.destroyed) throw new Error("OpenOCD Tcl 服务未连接");
        const requestEpoch = this.sampleEpoch;
        const deadline = Date.now() + timeoutMs;
        while (this.busy) {
            if (Date.now() >= deadline) throw new Error("等待实时采样连接空闲超时");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        this.busy = true;
        try {
            const guard =
                this.mode === "debug"
                    ? {
                          epoch: requestEpoch,
                          requireSampling: false,
                          deadline: Math.min(deadline, Date.now() + MAX_DEBUG_CYCLE_MS)
                      }
                    : null;
            return (await this._readItems(items, Date.now(), guard)).samples;
        } finally {
            this.busy = false;
        }
    }

    // 变量写入统一转换为对齐的 32-bit 读-改-写。某些 Cortex-M7/AHB-AP 组合下
    // debugger 的 byte-lane 写入会被丢弃；字写可避开该问题并保留相邻字节。
    async _writeMemoryBytes(addr, bytes) {
        if (this.mode === "debug") {
            throw Object.assign(new Error("Runtime writes are disabled for managed debug sessions"), {
                code: "RUNTIME_WRITE_DISABLED"
            });
        }
        const address = addr >>> 0;
        const input = Array.from(bytes || [], (value) => value & 0xff);
        if (!input.length) return true;
        const alignedStart = (address & 0xfffffffc) >>> 0;
        const alignedEnd = Math.ceil((address + input.length) / 4) * 4;
        let writeBytes = input;
        if (alignedStart !== address || alignedEnd - alignedStart !== input.length) {
            const existing = await this._readMemoryBytes(alignedStart, alignedEnd - alignedStart);
            if (!existing) throw new Error("写入内存失败：无法读取相邻字节以执行 32 位对齐写入");
            writeBytes = existing.slice();
            writeBytes.splice(address - alignedStart, input.length, ...input);
        }
        const hex = "0x" + alignedStart.toString(16);
        const data = bytesToElements(writeBytes, 4)
            .map((value) => "0x" + value.toString(16))
            .join(" ");
        const build = (cmd) => `${cmd} ${hex} 32 {${data}}`;
        try {
            await this._sendCheckedCommand(build(this.writeCmd));
        } catch (error) {
            if (!this.writeAltTried && /invalid command name|unknown command/i.test(error.message)) {
                this.writeAltTried = true;
                this.writeCmd = this.writeCmd === "ocd_write_memory" ? "write_memory" : "ocd_write_memory";
                try {
                    await this._sendCheckedCommand(build(this.writeCmd));
                } catch (fallbackError) {
                    throw Object.assign(new Error("写入内存失败：" + fallbackError.message), { cause: fallbackError });
                }
            } else {
                throw Object.assign(new Error("写入内存失败：" + error.message), { cause: error });
            }
        }
        return true;
    }

    async _waitUntilIdle(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (this.busy) {
            if (Date.now() >= deadline) throw new Error("等待实时采样连接空闲超时");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }

    async waitForIdle(timeoutMs = 2000) {
        try {
            await this._waitUntilIdle(timeoutMs);
            return true;
        } catch {
            return false;
        }
    }

    // 显式写入默认采用安全事务：记录状态、必要时短暂 halt、写前/写后读取，再恢复运行。
    async writeAndVerify(items, timeoutMs = 5000) {
        if (this.mode === "debug") {
            throw Object.assign(new Error("Runtime writes are disabled for managed debug sessions"), {
                code: "RUNTIME_WRITE_DISABLED"
            });
        }
        if (!Array.isArray(items) || !items.length) return { before: [], after: [] };
        if (this.stopped || !this.socket || this.socket.destroyed) throw new Error("OpenOCD Tcl 服务未连接");
        const deadline = Date.now() + timeoutMs;
        while (this.busy) {
            if (Date.now() >= deadline) throw new Error("等待实时采样连接空闲超时");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // Check and acquire without yielding, including when multiple writers arrive while idle.
        if (this.stopped || !this.socket || this.socket.destroyed) throw new Error("OpenOCD Tcl 服务未连接");
        this.busy = true;
        let haltedByUs = false;
        let primaryError = null;
        let result = null;
        try {
            const state = (await this._sendCheckedCommand("[target current] curstate")).trim();
            if (state !== "halted") {
                await this._sendCheckedCommand("halt");
                haltedByUs = true;
            }
            const readItems = items.map((item) => ({
                name: item.name,
                address: item.address,
                size: item.bytes.length
            }));
            const before = (await this._readItems(readItems, Date.now())).samples;
            for (const item of items) await this._writeMemoryBytes(item.address, item.bytes);
            const after = (await this._readItems(readItems, Date.now())).samples;
            result = { before, after };
        } catch (error) {
            primaryError = error;
        }
        if (haltedByUs) {
            try {
                await this._sendCheckedCommand("resume");
            } catch (resumeError) {
                if (!primaryError) primaryError = resumeError;
            }
        }
        this.busy = false;
        if (primaryError) throw primaryError;
        return result;
    }

    // 在现有 Tcl 连接上写入一组变量一次（items: [{address, bytes}]），语义同 readOnce。
    async writeOnce(items, timeoutMs = 2500) {
        if (this.mode === "debug") {
            throw Object.assign(new Error("Runtime writes are disabled for managed debug sessions"), {
                code: "RUNTIME_WRITE_DISABLED"
            });
        }
        if (!Array.isArray(items) || !items.length) return 0;
        if (this.stopped || !this.socket || this.socket.destroyed) throw new Error("OpenOCD Tcl 服务未连接");
        const deadline = Date.now() + timeoutMs;
        while (this.busy) {
            if (Date.now() >= deadline) throw new Error("等待实时采样连接空闲超时");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        this.busy = true;
        try {
            let written = 0;
            for (const item of items) {
                await this._writeMemoryBytes(item.address, item.bytes);
                written++;
            }
            return written;
        } finally {
            this.busy = false;
        }
    }

    async _sampleTick() {
        if (
            !this.samplingEnabled ||
            this.busy ||
            this.stopped ||
            !this.socket ||
            this.socket.destroyed ||
            !this.watch.length
        )
            return;
        this.busy = true;
        const epoch = this.sampleEpoch;
        const t = Date.now();
        try {
            const guard =
                this.mode === "debug" ? { epoch, requireSampling: true, deadline: t + MAX_DEBUG_CYCLE_MS } : null;
            const { samples, ok } = await this._readItems(this.watch, t, guard);
            if (epoch !== this.sampleEpoch || !this.samplingEnabled) return;
            if (this.handlers.onSample) this.handlers.onSample(samples, t);
            if (ok === this.watch.length && this._sampleErrorActive) {
                // 芯片复位会造成一次短暂的 MEM-AP 读取失败；后续完整采样成功即恢复正常状态，
                // 避免错误提示和灰显一直粘滞到用户手动重启采样。
                this._sampleErrorActive = false;
                this._lastReadError = "";
                this._notifiedError = "";
                this._status({ key: "sb.sampling" });
            } else if (ok === 0 && this._lastReadError && this._lastReadError !== this._notifiedError) {
                this._notifiedError = this._lastReadError;
                this._error(
                    "读取内存失败：" + this._lastReadError + "（运行中读取失败时可尝试降低采样率或确认目标状态）"
                );
            }
        } catch (e) {
            if (epoch === this.sampleEpoch && this.samplingEnabled && !this.connectionFailed) this._error(e.message);
        } finally {
            this.busy = false;
        }
    }

    stop(timeoutMs = 1200) {
        if (this._stopPromise) return this._stopPromise;
        const child = this.child;
        const socket = this.socket;
        const childExited = child ? this.waitForExit(timeoutMs) : Promise.resolve(true);
        this.stopped = true;
        this.sampleEpoch++;
        this.samplingEnabled = false;
        this._samplingRequested = false;
        this.connectionFailed = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this._rejectQueue(new Error("采样已停止"));
        if (this.connectingSocket && !this.connectingSocket.destroyed) {
            try {
                this.connectingSocket.destroy();
            } catch (e) {
                /* ignore */
            }
        }
        this.connectingSocket = null;
        const sendShutdown = new Promise((resolve) => {
            if (!socket || socket.destroyed) return resolve(false);
            let settled = false;
            const finish = (sent) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(sent);
            };
            const timer = setTimeout(() => finish(false), 150);
            try {
                socket.write("shutdown" + SUB, () => finish(true));
            } catch (e) {
                finish(false);
            }
        });
        this._stopPromise = (async () => {
            const childRunning = () => !!child && child.exitCode == null && child.signalCode == null;
            const sent = await sendShutdown;
            if (!sent && childRunning()) {
                try {
                    child.kill();
                } catch (e) {
                    /* ignore */
                }
            }
            let closed = await childExited;
            if (!closed && childRunning()) {
                try {
                    child.kill();
                } catch (e) {
                    /* ignore */
                }
                closed = await new Promise((resolve) => {
                    let settled = false;
                    const finish = (value) => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        child.removeListener("close", onClose);
                        resolve(value);
                    };
                    const onClose = () => finish(true);
                    const timer = setTimeout(() => finish(false), 400);
                    child.once("close", onClose);
                });
            }
            if (!closed && childRunning()) {
                try {
                    child.kill("SIGKILL");
                } catch (e) {
                    /* ignore */
                }
            }
            if (socket && !socket.destroyed) {
                try {
                    socket.destroy();
                } catch (e) {
                    /* ignore */
                }
            }
            if (this.socket === socket) this.socket = null;
            if (this.child === child && (closed || child?.exitCode !== null)) this.child = null;
            const responseDir = this._silentResponseDir;
            this._silentResponseDir = "";
            this._silentResponseFile = "";
            if (responseDir) {
                try {
                    await fs.promises.rm(responseDir, { recursive: true, force: true });
                } catch {
                    /* ignore */
                }
            }
            return closed;
        })();
        return this._stopPromise;
    }
}

// Backward-compatible name retained for standalone live watch and existing callers.
const LiveWatchSession = ManagedOpenOcdSession;

module.exports = {
    ManagedOpenOcdSession,
    LiveWatchSession,
    parseMemoryValues,
    parseMemoryElements,
    transferShape,
    bytesToElements,
    elementsToBytes,
    validateManagedReadPlan,
    MAX_DEBUG_READ_BYTES,
    MAX_DEBUG_READ_COMMANDS,
    MAX_DEBUG_CYCLE_MS,
    isSafeCfg,
    findFreePort
};
