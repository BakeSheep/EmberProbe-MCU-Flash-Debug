"use strict";
// 通过 OpenOCD（服务模式）+ Tcl-RPC 在 Cortex-M 运行中非侵入读取 RAM，实现变量实时采样。
// 说明：受 MCUViewer（GPLv3）概念启发的独立实现，未使用其任何代码。
const net = require("net");
const { spawn } = require("child_process");
const { isSafeCfg } = require("./openocdRunner");

const SUB = "\x1a"; // Tcl-RPC 命令/响应分帧符 0x1A

// 解析 read_memory / ocd_read_memory 的返回值：支持十进制、0x 前缀，并剥离可能的地址标签
function parseMemoryValues(text) {
    if (!text) return [];
    const cleaned = String(text).replace(/\x1a/g, ' ').replace(/(^|\s)(0x)?[0-9a-fA-F]+:/g, ' ');
    const out = [];
    for (const tok of cleaned.trim().split(/\s+/)) {
        if (!tok) continue;
        let n;
        if (/^0x[0-9a-fA-F]+$/i.test(tok)) n = parseInt(tok, 16);
        else if (/^-?[0-9]+$/.test(tok)) n = parseInt(tok, 10);
        else continue;
        if (!Number.isNaN(n)) out.push(n);
    }
    return out;
}

// 复用 openocdRunner 的配置名白名单校验

class LiveWatchSession {
    // options: { executable, probe, target, cwd, port, intervalMs }
    // handlers: { onSample(samples,t), onStatus(msg), onError(msg) }
    constructor(vscode, options, handlers) {
        this.vscode = vscode;
        this.options = options || {};
        this.handlers = handlers || {};
        this.child = null;
        this.socket = null;
        this.timer = null;
        this.busy = false;
        this.stopped = false;
        this.pending = '';        // socket 响应缓冲
        this.queue = [];          // 待响应的命令（串行，单条在途）
        this.watch = [];          // [{name,address,size,type}]
        this.readCmd = 'ocd_read_memory'; // 主用命令，不可用时回退 read_memory
        this.altTried = false;
        this._lastReadError = '';
        this._notifiedError = '';
        this.connectionFailed = false;
        this._startReject = null; // start() 进行中时捕获的 reject，用于单通道上报连接期失败
    }

    setWatch(list) { this.watch = Array.isArray(list) ? list.slice() : []; }

    // 运行中动态调整采样间隔：重建定时器
    setIntervalMs(ms) {
        const interval = Math.max(20, Math.min(10000, Number(ms) || 100));
        this.options.intervalMs = interval;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (!this.stopped && this.socket && !this.socket.destroyed) {
            this.timer = setInterval(() => { this._sampleTick(); }, interval);
        }
    }

    _status(msg) { if (this.handlers.onStatus) this.handlers.onStatus(msg); }
    _error(msg) { if (this.handlers.onError) this.handlers.onError(msg); }

    async start() {
        if (!isSafeCfg(this.options.probe) || !isSafeCfg(this.options.target)) {
            throw new Error(`非法的 OpenOCD 配置名：${this.options.probe} / ${this.options.target}`);
        }
        const port = this.options.port || 6666;
        const interval = Math.max(20, this.options.intervalMs || 100);
        const args = [
            '-f', `interface/${this.options.probe}`,
            '-f', `target/${this.options.target}`,
            '-c', `tcl_port ${port}`,
            '-c', 'gdb_port disabled',
            '-c', 'telnet_port disabled',
            '-c', 'init' // 仅初始化，不 halt/不 reset，保持非侵入
        ];
        this._status({ key: 'lw.connecting' });
        try {
            this.child = spawn(this.options.executable, args, { cwd: this.options.cwd, windowsHide: true, shell: false });
        } catch (error) {
            throw error.code === 'ENOENT' ? Object.assign(new Error(`找不到 OpenOCD：${this.options.executable}`), { i18nKey: 'run.notFound', i18nParams: { path: this.options.executable } }) : new Error(error.message);
        }
        this.child.on('error', (error) => {
            const enoent = error.code === 'ENOENT';
            const e = new Error(enoent ? `找不到 OpenOCD：${this.options.executable}` : error.message);
            if (enoent) { e.i18nKey = 'run.notFound'; e.i18nParams = { path: this.options.executable }; }
            this._abortConnection(e);
        });
        const onLog = (chunk) => {
            const text = chunk.toString();
            for (const line of text.split(/\r?\n/)) {
                const clean = line.trim();
                if (!clean) continue;
                // Info : Unable to ... 可能只是降速等正常提示；非 Info 行仍识别常见连接失败。
                const isInfo = /\bInfo\s*:/i.test(clean);
                if (/\bError\s*:/i.test(clean) || (!isInfo && /failed|unable to|no device found|libusb|in use|denied|timed out/i.test(clean))) {
                    this._error(clean.replace(/^.*?Error\s*:\s*/i, '') || clean);
                }
            }
        };
        this.child.stdout.on('data', onLog);
        this.child.stderr.on('data', onLog);
        this.child.on('close', (code) => {
            const expected = this.stopped;
            this.child = null;
            if (this.timer) { clearInterval(this.timer); this.timer = null; }
            if (this.socket && !this.socket.destroyed) { try { this.socket.destroy(); } catch (e) { /* ignore */ } }
            this.socket = null;
            this.stopped = true;
            if (!expected) this._abortConnection(Object.assign(new Error(`OpenOCD 服务已退出（代码 ${code}）：可能探针被占用、配置错误或端口 ${port} 被占用`), { i18nKey: 'live.serviceExited', i18nParams: { code, port } }));
        });

        // start() 进行期间若子进程退出，_abortConnection 通过 _startReject 拒绝此 Promise，
        // 由调用方一次性上报；避免 onDisconnect 与 start() 抛出重复通知。
        try {
            await new Promise((resolve, reject) => {
                this._startReject = reject;
                if (this.stopped) { reject(new Error('OpenOCD 服务在连接过程中已退出')); return; }
                this._connectWithRetry(port, 6000).then(sock => {
                    this.socket = sock;
                    if (this.stopped) { reject(new Error('OpenOCD 服务在连接过程中已退出')); return; }
                    this._setupSocket();
                    this._status({ key: 'lw.connected' });
                    this.timer = setInterval(() => { this._sampleTick(); }, interval);
                    resolve();
                }, reject);
            });
        } finally {
            this._startReject = null;
        }
    }

    _connectWithRetry(port, timeoutMs) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const attempt = () => {
                if (this.stopped) return reject(new Error('已停止'));
                const sock = net.connect({ host: '127.0.0.1', port });
                sock.once('connect', () => resolve(sock));
                sock.once('error', () => {
                    try { sock.destroy(); } catch (e) { /* ignore */ }
                    if (Date.now() > deadline) reject(new Error(`无法连接 OpenOCD Tcl 端口 ${port}`));
                    else setTimeout(attempt, 200);
                });
            };
            attempt();
        });
    }

    _setupSocket() {
        this.socket.setNoDelay(true);
        this.socket.on('data', (chunk) => {
            this.pending += chunk.toString('latin1');
            let idx;
            while ((idx = this.pending.indexOf(SUB)) >= 0) {
                const resp = this.pending.slice(0, idx);
                this.pending = this.pending.slice(idx + 1);
                const q = this.queue.shift();
                if (q) q.resolve(resp);
            }
            // 失控流兜底：若缓冲累积超过 1MB 仍未出现分帧符，说明响应流异常，丢弃并重置连接，避免无限增长
            if (this.pending.length > 1048576) {
                this.pending = '';
                this._abortConnection(new Error('OpenOCD 响应流异常：未收到分帧符'));
            }
        });
        this.socket.on('error', (e) => this._abortConnection(e));
        this.socket.on('close', () => {
            if (!this.stopped) this._abortConnection(new Error('Tcl 连接已关闭'));
        });
    }

    _rejectQueue(error) {
        while (this.queue.length) {
            const q = this.queue.shift();
            q.reject(error);
        }
    }

    // 响应是无 ID 的 FIFO 流。任一请求超时后无法判断迟到响应属于谁，只能废弃整条连接。
    _abortConnection(error) {
        const err = error instanceof Error ? error : new Error(String(error || '连接已断开'));
        if (this.connectionFailed) return;
        this.connectionFailed = true;
        this.stopped = true;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this._rejectQueue(err);
        if (this.socket && !this.socket.destroyed) { try { this.socket.destroy(); } catch (e) { /* ignore */ } }
        this.socket = null;
        if (this.child && !this.child.killed) { try { this.child.kill(); } catch (e) { /* ignore */ } }
        // start() 仍在进行中时，以拒绝其 Promise 作为唯一通知通道，避免 onDisconnect 重复上报
        if (this._startReject) {
            const reject = this._startReject; this._startReject = null;
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
            if (!this.socket || this.socket.destroyed) return reject(new Error('socket 未连接'));
            const entry = {};
            const timer = setTimeout(() => {
                if (this.queue.includes(entry)) this._abortConnection(new Error('OpenOCD 响应超时，采样连接已重置'));
            }, 2000);
            entry.resolve = (v) => { clearTimeout(timer); resolve(v); };
            entry.reject = (e) => { clearTimeout(timer); reject(e); };
            this.queue.push(entry);
            try { this.socket.write(cmd + SUB); } catch (e) { this._abortConnection(e); }
        });
    }

    // 读取内存字节（width=8），返回 number[] 或 null；主用 ocd_read_memory，不可用时回退 read_memory
    async _readMemoryBytes(addr, count) {
        const hex = '0x' + (addr >>> 0).toString(16);
        const build = (cmd) => `${cmd} ${hex} 8 ${count}`;
        let resp = await this._sendCommand(build(this.readCmd));
        let vals = parseMemoryValues(resp);
        if (vals.length < count && !this.altTried) {
            this.altTried = true; // 首次读取失败时切换命令名并锁定
            this.readCmd = this.readCmd === 'ocd_read_memory' ? 'read_memory' : 'ocd_read_memory';
            resp = await this._sendCommand(build(this.readCmd));
            vals = parseMemoryValues(resp);
        }
        if (vals.length < count) {
            this._lastReadError = (resp || '').replace(/\x1a/g, '').trim().slice(0, 200);
            return null;
        }
        return vals.slice(0, count);
    }

    async _sampleTick() {
        if (this.busy || this.stopped || !this.socket || this.socket.destroyed || !this.watch.length) return;
        this.busy = true;
        const t = Date.now();
        const samples = [];
        let ok = 0;
        try {
            // 按地址排序后将地址连续的变量合并为一次读取，减少 Tcl 往返，提升有效采样率
            const sorted = this.watch.slice().sort((a, b) => (a.address >>> 0) - (b.address >>> 0));
            const groups = [];
            for (const v of sorted) {
                const last = groups[groups.length - 1];
                if (last && v.address === last.end) { last.vars.push(v); last.end += v.size; }
                else { groups.push({ start: v.address, end: v.address + v.size, vars: [v] }); }
            }
            for (const g of groups) {
                const bytes = await this._readMemoryBytes(g.start, g.end - g.start);
                if (bytes) {
                    for (const v of g.vars) {
                        const off = v.address - g.start;
                        samples.push({ name: v.name, bytes: bytes.slice(off, off + v.size), t }); ok++;
                    }
                } else {
                    for (const v of g.vars) samples.push({ name: v.name, bytes: null, t });
                }
            }
            if (this.handlers.onSample) this.handlers.onSample(samples, t);
            if (ok === 0 && this._lastReadError && this._lastReadError !== this._notifiedError) {
                this._notifiedError = this._lastReadError;
                this._error('读取内存失败：' + this._lastReadError + '（运行中读取失败时可尝试降低采样率或确认目标状态）');
            }
        } catch (e) {
            this._error(e.message);
        } finally {
            this.busy = false;
        }
    }

    stop() {
        this.stopped = true;
        this.connectionFailed = true;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this._rejectQueue(new Error('采样已停止'));
        if (this.socket && !this.socket.destroyed) {
            try { this.socket.write('shutdown' + SUB); } catch (e) { /* ignore */ }
            try { this.socket.destroy(); } catch (e) { /* ignore */ }
        }
        this.socket = null;
        if (this.child && !this.child.killed) { try { this.child.kill(); } catch (e) { /* ignore */ } }
        this.child = null;
    }
}

module.exports = { LiveWatchSession, parseMemoryValues, isSafeCfg };
