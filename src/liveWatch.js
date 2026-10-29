"use strict";
const { buildOpenOcdConfigArgs, buildOpenOcdRtosArgs, buildOpenOcdTargetArgs } = require("./openocdScripts");
// 管理单一 OpenOCD 服务：独立模式仅开放 Tcl，调试模式同时开放 GDB，Tcl-RPC 采样 RAM 并允许不暂停的字写入。
// 说明：受 MCUViewer（GPLv3）概念启发的独立实现，未使用其任何代码。
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");
const { spawn } = require("child_process");
const { createLineDecoder } = require("../skills/_emberprobe/tool-output");
const { randomBytes } = require("crypto");
const { performance } = require("perf_hooks");
const { normalizeAdapterSpeed } = require("../skills/_emberprobe/probe-connection");
const { isSafeCfg, quoteTclWord, diagnoseOpenOcdFailure } = require("./openocdRunner");
const { resolveOpenOcdLaunch } = require("./openocdScripts");
const { clampInteger } = require("./validation");
const { scheduleSamplingTick } = require("./samplingClock");
const { SamplingThroughput } = require("./samplingThroughput");
const { windowsTimerResolution } = require("./windowsTimerResolution");
const { connectionDetails } = require("../skills/_emberprobe/openocd-diagnostics");
const { RuntimeObjectReader, RUNTIME_CYCLE_BYTES, RUNTIME_CYCLE_READS } = require("./services/runtimeObjectReader");
const { MultiRatePlan } = require("./services/multiRatePlan");
const { withTargetCheck, targetCheckMonitor } = require("./chip/targetIdentity");
const { isNonHaltingWordWrite, runtimeWriteDisabledError } = require("./writeAccess");

const SUB = "\x1a"; // Tcl-RPC 命令/响应分帧符 0x1A
const MAX_DEBUG_READ_BYTES = 4096;
const MAX_DEBUG_READ_COMMANDS = 32;
const MAX_DEBUG_CYCLE_MS = 1000;
const MAX_BATCH_GROUPS = 8;
const MAX_BATCH_BYTES = 1024;
const MAX_SCATTER_SEGMENTS = 64;
const MAX_SCATTER_BYTES = 4096;
const MAX_READ_BATCH_CACHE_ENTRIES = 8;
const MAX_READ_GAP_BYTES = 32;
const MAX_RAM_SECTION_RANGES = 4096;

function normalizeRamSectionRanges(ranges) {
    return (Array.isArray(ranges) ? ranges.slice(0, MAX_RAM_SECTION_RANGES) : [])
        .filter(
            (range) =>
                Number.isInteger(range?.start) &&
                Number.isInteger(range?.end) &&
                range.start >= 0 &&
                range.end <= 0x100000000 &&
                range.start < range.end
        )
        .map(({ start, end }) => ({ start, end }));
}

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

// Resolves true on the first "exit" or "close": once the process has exited its USB handle is
// released, while "close" also waits for stdio, which Windows can hold open past the stop budget.
function waitForChildExit(child, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (exited) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.removeListener("exit", onExit);
            child.removeListener("close", onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", onExit);
        child.once("close", onExit);
        if (child.exitCode !== null || child.signalCode != null) finish(true);
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
    if (!text || ![8, 16, 32].includes(widthBits)) return [];
    const max = widthBits === 32 ? 0xffffffff : widthBits === 16 ? 0xffff : 0xff;
    const cleaned = String(text).replace(/(^|\s)(0x)?[0-9a-fA-F]+:/g, " ");
    const out = [];
    for (const tok of cleaned.trim().split(/\s+/)) {
        if (!tok) continue;
        let n;
        if (/^0x[0-9a-fA-F]+$/i.test(tok)) n = parseInt(tok, 16);
        else if (/^[0-9a-fA-F]*[a-f][0-9a-fA-F]*$/i.test(tok)) n = parseInt(tok, 16);
        else if (/^-?[0-9]+$/.test(tok)) n = parseInt(tok, 10);
        else return [];
        if (Number.isInteger(n) && n < 0 && n >= -(2 ** (widthBits - 1))) n += 2 ** widthBits;
        if (!Number.isInteger(n) || n < 0 || n > max) return [];
        out.push(n >>> 0);
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

// Split a byte range into naturally aligned 8/16/32-bit accesses, merging equal widths.
function naturalWriteChunks(address, bytes) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length;) {
        const at = address + offset;
        const remaining = bytes.length - offset;
        const width = at % 4 === 0 && remaining >= 4 ? 4 : at % 2 === 0 && remaining >= 2 ? 2 : 1;
        const last = chunks[chunks.length - 1];
        const part = bytes.slice(offset, offset + width);
        if (last && last.width === width && last.address + last.bytes.length === at) last.bytes.push(...part);
        else chunks.push({ address: at, width, bytes: part });
        offset += width;
    }
    return chunks;
}

function elementsToBytes(elements, elementBytes) {
    const bytes = [];
    for (const element of elements) {
        for (let index = 0; index < elementBytes; index++) bytes.push((element >>> (index * 8)) & 0xff);
    }
    return bytes;
}

// Read batches are compiled by address and samples are keyed by name, so consumer order never affects a plan.
function sameConsumerItems(a, b) {
    const byName = (items) => [...items].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    return a.length === b.length && isDeepStrictEqual(byName(a), byName(b));
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

// Sampling keeps every item that fits the per-cycle budget. Smaller items are admitted first so one
// oversized struct cannot starve the rest; the result keeps the input order of each side.
function partitionManagedReadPlan(items, maxBytes = MAX_DEBUG_READ_BYTES, maxCommands = MAX_DEBUG_READ_COMMANDS) {
    const list = Array.isArray(items) ? items : [];
    const order = list
        .map((item, index) => ({ item, index }))
        .sort((a, b) => Number(a.item?.size) - Number(b.item?.size) || a.index - b.index);
    const admitted = [];
    const rejected = new Set();
    for (const entry of order) {
        try {
            validateManagedReadPlan([...admitted, entry.item], maxBytes, maxCommands);
            admitted.push(entry.item);
        } catch (error) {
            if (error.code !== "LIVE_READ_BUDGET_EXCEEDED") throw error;
            rejected.add(entry.item);
        }
    }
    return {
        allowed: list.filter((item) => !rejected.has(item)),
        overBudget: list.filter((item) => rejected.has(item))
    };
}

function validateManagedWritePlan(items) {
    if (!items.every(isNonHaltingWordWrite)) throw runtimeWriteDisabledError();
    for (const item of items) {
        if (!Number.isInteger(item.address) || item.address < 0 || item.address + 4 > 0x100000000)
            throw Object.assign(new Error("Runtime write range overflows the 32-bit target address space"), {
                code: "LIVE_ADDRESS_NOT_RAM"
            });
        if (Array.from(item.bytes).some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
            throw Object.assign(new Error("Runtime writes require integer bytes in the range 0..255"), {
                code: "INVALID_WRITE_VALUE"
            });
    }
    validateManagedReadPlan(items.map((item) => ({ address: item.address, size: item.bytes.length })));
    // Reads may merge adjacent ranges; each word write still requires its own Tcl command.
    if (items.length > MAX_DEBUG_READ_COMMANDS)
        throw Object.assign(new Error("Runtime write plan exceeds the per-cycle command budget"), {
            code: "LIVE_WRITE_BUDGET_EXCEEDED",
            details: { commandCount: items.length, maxCommands: MAX_DEBUG_READ_COMMANDS }
        });
}

function compileReadBatches(items, ramSectionRanges = [], debug = false, reservedBytes = 0) {
    if (!Array.isArray(items) || !items.length) return [];
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
    let totalBytes = groups.reduce((total, group) => total + group.end - group.start, reservedBytes);
    let commands = groups.reduce((total, group) => total + Math.ceil((group.end - group.start) / MAX_BATCH_BYTES), 0);
    const mergeNeighbours = () => {
        for (let index = 1; index < groups.length;) {
            const previous = groups[index - 1];
            const group = groups[index];
            const gap = Math.max(0, group.start - previous.end);
            const end = Math.max(previous.end, group.end);
            const nextCommands =
                commands -
                Math.ceil((previous.end - previous.start) / MAX_BATCH_BYTES) -
                Math.ceil((group.end - group.start) / MAX_BATCH_BYTES) +
                Math.ceil((end - previous.start) / MAX_BATCH_BYTES);
            if (
                gap <= MAX_READ_GAP_BYTES &&
                ramSectionRanges.some((range) => previous.start >= range.start && end <= range.end) &&
                (!debug || (totalBytes + gap <= MAX_DEBUG_READ_BYTES && nextCommands <= MAX_DEBUG_READ_COMMANDS))
            ) {
                previous.end = end;
                previous.vars.push(...group.vars);
                groups.splice(index, 1);
                totalBytes += gap;
                commands = nextCommands;
            } else index++;
        }
    };
    mergeNeighbours();
    for (const group of groups) {
        const start = Math.floor(group.start / 4) * 4;
        const end = Math.ceil(group.end / 4) * 4;
        const extra = end - start - (group.end - group.start);
        const nextCommands =
            commands -
            Math.ceil((group.end - group.start) / MAX_BATCH_BYTES) +
            Math.ceil((end - start) / MAX_BATCH_BYTES);
        if (
            extra &&
            ramSectionRanges.some((range) => start >= range.start && end <= range.end) &&
            (!debug || (totalBytes + extra <= MAX_DEBUG_READ_BYTES && nextCommands <= MAX_DEBUG_READ_COMMANDS))
        ) {
            group.start = start;
            group.end = end;
            totalBytes += extra;
            commands = nextCommands;
        }
    }
    mergeNeighbours();
    const batches = [];
    let currentBatch = [];
    let currentBatchBytes = 0;
    for (const g of groups) {
        g.byteCount = g.end - g.start;
        for (let start = g.start; start < g.end; start += MAX_BATCH_BYTES) {
            const byteCount = Math.min(MAX_BATCH_BYTES, g.end - start);
            if (
                currentBatch.length >= MAX_BATCH_GROUPS ||
                (currentBatch.length > 0 && currentBatchBytes + byteCount > MAX_BATCH_BYTES)
            ) {
                batches.push(currentBatch);
                currentBatch = [];
                currentBatchBytes = 0;
            }
            currentBatch.push({ start, byteCount, shape: transferShape(start, byteCount), group: g, vars: g.vars });
            currentBatchBytes += byteCount;
        }
    }
    if (currentBatch.length) batches.push(currentBatch);
    return batches;
}

// 复用 openocdRunner 的配置名白名单校验

class ManagedOpenOcdSession {
    // options: { executable, probe, target, cwd, port, gdbPort, intervalMs, mode }
    // handlers: { onSample(samples,t), onStatus(msg), onError(msg), onDegraded(error), onDisconnect(error) }
    constructor(vscode, options, handlers) {
        if (options?.isolated)
            return /** @type {any} */ (new (require("./samplingSession").SamplingSession)(options, handlers));
        this.vscode = vscode;
        this.options = options || {};
        this.handlers = handlers || {};
        this.child = null;
        this.socket = null;
        this.connectingSocket = null;
        this.timer = null;
        this.busy = false;
        this._exclusiveWaiters = [];
        this._samplingTickDeferred = false;
        this.unlimited = false;
        this._hostHold = false;
        this._hostHoldSince = null;
        this._hostHoldSpans = [];
        this._hostWindowStartedAt = Number(process.hrtime.bigint()) / 1e6;
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
        this._lastErrorAt = 0;
        this._lastReportedError = "";
        this._lastErrorPostedAt = 0;
        this._successfulReads = 0;
        this._pollFailureSince = null;
        this._pollFailureCount = 0;
        this._pollFailureLocked = false;
        this.now = this.options.now || Date.now;
        this.sampleNow = this.options.sampleNow || (() => performance.timeOrigin + performance.now());
        this.rpcTimeoutMs = this.options.backendKind === "tcp" ? 5000 : 2000;
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
        // One-shot transactions keep their own plan; only target/connection changes invalidate them.
        this.targetEpoch = 0;
        this._reconnectPromise = null;
        this._startCompleted = false;
        this._tclListening = false;
        this._silentResponseDir = "";
        this._silentResponseFile = "";
        this.noEchoResponses = false;
        this.scatterReads = false;
        this._scatterFailures = 0;
        this._detectingScatter = false;
        this._initializing = false;
        this.ramSectionRanges = [];
        this.targetIntervalMs = clampInteger(this.options.intervalMs, 100, 5, 10000);
        this.effectiveIntervalMs = Math.max(100, this.targetIntervalMs);
        this._recentDurations = [];
        this._consecutiveSuccesses = 0;
        this._warmingUp = true;
        this._lastAdaptiveEvalAt = 0;
        this._lastBackoffOrErrorAt = 0;
        this._missedDeadlines = 0;
        this._pauseReason = null;
        this._compiledBatches = [];
        this._readBatchCache = [];
        // Per watch item: the reads its last successful runtime sample needed (see _sampleRuntimeItem).
        this._runtimePlans = new WeakMap();
        this._batchUnsupported = false;
        this._recentCycleTimestamps = [];
        this._memoryReadBytes = 0;
        this._samplingThroughput = new SamplingThroughput();
        this._timerResolutionHeld = false;
    }

    get unlimitedActive() {
        return this.unlimited && this.mode !== "debug" && !!this.ratePlan?.graphItems.length;
    }

    _tryAcquireExclusive() {
        if (this.busy || this._exclusiveWaiters.length || this.stopped || this.connectionFailed) return false;
        this.busy = true;
        return true;
    }

    _acquireExclusive(deadlineMs) {
        if (this.stopped || this.connectionFailed)
            return Promise.reject(this.connectionError || new Error("Sampling session stopped"));
        if (this._tryAcquireExclusive()) return Promise.resolve();
        const timeoutError = () =>
            Object.assign(new Error("Timed out waiting for the sampling connection to become idle"), {
                code: "PROBE_CONNECTION_BUSY_TIMEOUT"
            });
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) return Promise.reject(timeoutError());
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null, deadlineMs };
            waiter.timer = setTimeout(() => {
                const index = this._exclusiveWaiters.indexOf(waiter);
                if (index < 0) return;
                this._exclusiveWaiters.splice(index, 1);
                reject(timeoutError());
                if (this._samplingTickDeferred) this._resumeDeferredSamplingTick();
            }, remainingMs);
            this._exclusiveWaiters.push(waiter);
        });
    }

    _releaseExclusive() {
        // Keep busy true during handoff: neither a tick nor a new caller can steal ownership.
        while (this._exclusiveWaiters.length) {
            const waiter = this._exclusiveWaiters.shift();
            clearTimeout(waiter.timer);
            if (Date.now() >= waiter.deadlineMs) {
                waiter.reject(
                    Object.assign(new Error("Timed out waiting for the sampling connection to become idle"), {
                        code: "PROBE_CONNECTION_BUSY_TIMEOUT"
                    })
                );
                continue;
            }
            waiter.resolve();
            return;
        }
        this.busy = false;
        if (this._samplingTickDeferred) this._resumeDeferredSamplingTick();
    }

    _resumeDeferredSamplingTick() {
        if (!this._samplingTickDeferred || this.busy || this._exclusiveWaiters.length) return;
        this._samplingTickDeferred = false;
        this._scheduleNext(0);
    }

    _rejectExclusiveWaiters(error) {
        for (const waiter of this._exclusiveWaiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        if (this._samplingTickDeferred) this._resumeDeferredSamplingTick();
    }

    _resetHostHold() {
        this._hostHold = false;
        this._hostHoldSince = null;
        this._hostHoldSpans = [];
        this._hostWindowStartedAt = Number(process.hrtime.bigint()) / 1e6;
    }

    setHostHold(held) {
        const next = held === true && this.unlimitedActive && this.samplingEnabled && !this.stopped;
        if (next === this._hostHold) return;
        const now = Number(process.hrtime.bigint()) / 1e6;
        if (next) {
            this._hostHoldSince = now;
            this._clearSamplingTimer();
        } else {
            this._hostHoldSpans.push({ start: this._hostHoldSince, end: now });
            this._hostHoldSince = null;
        }
        this._hostHold = next;
        this._hostHoldSpans = this._hostHoldSpans.filter((span) => span.end > now - 1000);
        if (!next) this._scheduleNext(0);
    }

    _hostHoldStats() {
        if (!this.unlimitedActive) return { hostHoldMs: 0, limitedBy: null };
        const now = Number(process.hrtime.bigint()) / 1e6;
        const cutoff = Math.max(now - 1000, this._hostWindowStartedAt);
        this._hostHoldSpans = this._hostHoldSpans.filter((span) => span.end > cutoff);
        let heldMs = this._hostHoldSpans.reduce((total, span) => total + span.end - Math.max(span.start, cutoff), 0);
        if (this._hostHoldSince !== null) heldMs += now - Math.max(this._hostHoldSince, cutoff);
        return {
            hostHoldMs: Number(heldMs.toFixed(2)),
            limitedBy: heldMs >= Math.max(1, now - cutoff) * 0.2 ? "host" : "probe"
        };
    }

    _warmUp() {
        this._samplingThroughput.reset();
        this.effectiveIntervalMs = this.unlimitedActive ? 0 : Math.max(100, this.targetIntervalMs);
        this._recentDurations = [];
        this._consecutiveSuccesses = 0;
        this._warmingUp = !this.unlimitedActive;
        const nowMonoMs = Number(process.hrtime.bigint() / 1000000n);
        this._lastAdaptiveEvalAt = nowMonoMs;
        this._lastBackoffOrErrorAt = nowMonoMs;
        this._recentCycleTimestamps = [];
    }

    _clearSamplingTimer() {
        this._samplingTickDeferred = false;
        if (this.timer) {
            this.timer.cancel();
            this.timer = null;
        }
    }

    _releaseTimerResolution() {
        if (!this._timerResolutionHeld) return;
        windowsTimerResolution.release();
        this._timerResolutionHeld = false;
    }

    _scheduleNext(delayMs) {
        this._clearSamplingTimer();
        if (this._initializing) return;
        if (!this.samplingEnabled || this.stopped || this._hostHold || !this.socket || this.socket.destroyed) return;
        if (this.unlimitedActive) {
            delayMs = 0;
            this._releaseTimerResolution();
        } else if (!this._timerResolutionHeld) this._timerResolutionHeld = windowsTimerResolution.acquire();
        this._variableDeadline = Number(process.hrtime.bigint()) / 1e6 + delayMs;
        this.timer = scheduleSamplingTick(
            delayMs,
            () => {
                this.timer = null;
                this._sampleTick(true);
            },
            { highResolution: this._timerResolutionHeld, immediate: this.unlimitedActive }
        );
    }

    setWatch(list, ramSectionRanges = []) {
        const deferred = this._samplingTickDeferred;
        if (deferred) this._clearSamplingTimer();
        this.ratePlan = null;
        this.unlimited = false;
        this._resetHostHold();
        const next = Array.isArray(list) ? list.slice() : [];
        if (this.mode === "debug") validateManagedReadPlan(next);
        this.watch = next;
        this.ramSectionRanges = normalizeRamSectionRanges(ramSectionRanges);
        this._readBatchCache = [];
        this._runtimePlans = new WeakMap();
        this._compiledBatches = this._getReadBatches(
            this.watch.filter((entry) => !entry.runtimeLayout),
            this.watch.filter((entry) => entry.runtimeLayout).reduce((sum, item) => sum + item.size, 0)
        );
        this._warmUp();
        if (
            this.samplingEnabled &&
            !this.stopped &&
            this.socket &&
            !this.socket.destroyed &&
            !this.timer &&
            (!this.busy || deferred)
        ) {
            this._scheduleNext(0);
        }
    }

    setIntervalMs(ms) {
        if (this.ratePlan) {
            const interval = clampInteger(ms, 33, 5, 10000);
            const changed = interval !== this.ratePlan.graphIntervalMs;
            if (changed) {
                this.ratePlan.graphIntervalMs = interval;
                this.ratePlan.nextGraph = 0;
                if (!this.unlimitedActive) this.ratePlan.graphTicks = [];
            }
            return this._setClockInterval(this.ratePlan.requestedIntervalMs, changed && !this.unlimitedActive);
        }
        return this._setClockInterval(ms);
    }

    setSamplingPlan(plan) {
        const ramSectionRanges = normalizeRamSectionRanges(plan.ramSectionRanges);
        const ratePlan = new MultiRatePlan({ ...plan, unlimited: plan.unlimited === true && this.mode !== "debug" });
        const previous = this.ratePlan;
        const sameConsumers =
            previous &&
            isDeepStrictEqual(this.ramSectionRanges, ramSectionRanges) &&
            sameConsumerItems(previous.graphItems, ratePlan.graphItems) &&
            sameConsumerItems(previous.sidebarItems, ratePlan.sidebarItems);
        if (sameConsumers) {
            if (previous.graphIntervalMs === ratePlan.graphIntervalMs && this.unlimited === (plan.unlimited === true))
                return;
            // Changing only the rate does not invalidate measured probe costs or cached sidebar values.
            ratePlan.latest = previous.latest;
            ratePlan.nextSidebar = previous.nextSidebar;
            ratePlan.sidebarTicks = previous.sidebarTicks;
            this.ratePlan = ratePlan;
            this.unlimited = plan.unlimited === true;
            this._resetHostHold();
            this._setClockInterval(ratePlan.requestedIntervalMs, true);
            return;
        }
        this.sampleEpoch++;
        this.setWatch(ratePlan.items, ramSectionRanges);
        this.ratePlan = ratePlan;
        this.unlimited = plan.unlimited === true;
        this._setClockInterval(ratePlan.requestedIntervalMs === Infinity ? 50 : ratePlan.requestedIntervalMs);
        this._warmUp();
        this._clearSamplingTimer();
        if (this.samplingEnabled && !this.stopped && this.socket && !this.socket.destroyed) this._scheduleNext(0);
    }

    _setClockInterval(ms, force = false) {
        const interval = clampInteger(ms, 100, 5, 10000);
        if (interval === this.targetIntervalMs && !force) return;
        this.sampleEpoch++;
        this.options.intervalMs = interval;
        this.targetIntervalMs = interval;
        const { duration, threshold } = this._adaptiveCost();
        this.effectiveIntervalMs = this.unlimitedActive
            ? 0
            : this._recentDurations.length >= 4
              ? Math.min(10000, Math.max(interval, Math.ceil(duration / threshold)))
              : Math.max(100, interval);
        this._warmingUp = !this.unlimitedActive && this._recentDurations.length < 4;
        this._consecutiveSuccesses = 0;
        this._lastAdaptiveEvalAt = Number(process.hrtime.bigint() / 1000000n);
        this._recentCycleTimestamps = [];
        this._samplingThroughput.reset();
        this._clearSamplingTimer();
        if (this.samplingEnabled && !this.stopped && this.socket && !this.socket.destroyed) {
            this._scheduleNext(0);
        }
    }

    // Pausing sampling (backpressure, plan errors, user stop) keeps one-shot transactions valid;
    // only execution, session or connection changes invalidate them.
    invalidateTarget() {
        this.targetEpoch++;
        this._runtimePlans = new WeakMap();
        this._samplingThroughput.reset();
    }

    setSamplingEnabled(enabled) {
        if (enabled && this._pollFailureLocked) return false;
        const nextEnabled = !!enabled && !this.stopped && !!this.socket && !this.socket.destroyed;
        if (
            enabled &&
            this._samplingRequested &&
            this.samplingEnabled === nextEnabled &&
            (this.timer || this._hostHold || this._samplingTickDeferred)
        )
            return this.samplingEnabled;
        this._resetHostHold();
        this._samplingRequested = !!enabled;
        this._samplingThroughput.reset();
        this.sampleEpoch++;
        this.samplingEnabled = !!enabled && !this.stopped && !!this.socket && !this.socket.destroyed;
        this._clearSamplingTimer();
        if (this.samplingEnabled) {
            this._pauseReason = null;
            this._warmUp();
            if (this.ratePlan) {
                this.ratePlan.nextGraph = this.ratePlan.nextSidebar = 0;
                this.ratePlan.latest.clear();
                this.ratePlan.graphTicks = [];
                this.ratePlan.sidebarTicks = [];
            }
            this._scheduleNext(0);
        } else {
            this._releaseTimerResolution();
            this._pauseReason = this.stopped ? "stopped" : this.mode === "debug" ? "debug_paused" : "paused";
            if (enabled && this.mode === "debug" && !this.stopped && this.child) {
                this._reconnectDebugTcl();
            }
        }
        return this.samplingEnabled;
    }

    setPauseReason(reason) {
        this._pauseReason = reason || null;
        if (reason) {
            this._lastBackoffOrErrorAt = Number(process.hrtime.bigint() / 1000000n);
            this._consecutiveSuccesses = 0;
        }
    }

    _computeP95Duration() {
        if (!this._recentDurations.length) return 0;
        const sorted = this._recentDurations.slice().sort((a, b) => a - b);
        const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
        return sorted[index];
    }

    _adaptiveCost() {
        return this.mode === "debug"
            ? { duration: this._computeP95Duration(), threshold: 0.4 }
            : {
                  duration:
                      this._recentDurations.reduce((sum, value) => sum + value, 0) /
                      (this._recentDurations.length || 1),
                  threshold: 0.85
              };
    }

    _computeActualHz() {
        if (!this.samplingEnabled || this._recentCycleTimestamps.length < 2) return 0;
        const first = this._recentCycleTimestamps[0];
        const last = this._recentCycleTimestamps[this._recentCycleTimestamps.length - 1];
        const spanMs = last - first;
        if (spanMs <= 0) return 0;
        const count = this._recentCycleTimestamps.length - 1;
        return Number(((count * 1000) / spanMs).toFixed(1));
    }

    stats() {
        const p95 = this._computeP95Duration();
        const consumers = this.ratePlan?.stats();
        const actualHz = consumers ? consumers.graphHz : this._computeActualHz();
        return {
            unlimited: this.unlimited,
            unlimitedActive: this.unlimitedActive,
            unlimitedSuppressedReason: this.unlimited && this.mode === "debug" ? "debug" : null,
            ...this._hostHoldStats(),
            targetIntervalMs: this.targetIntervalMs,
            effectiveIntervalMs: this.effectiveIntervalMs,
            actualHz,
            bytesPerSecond: this.samplingEnabled
                ? this._samplingThroughput.rate(Number(process.hrtime.bigint()) / 1e6)
                : 0,
            consumers,
            noEchoResponses: this.noEchoResponses,
            scatterReads: this.scatterReads,
            p95DurationMs: Number(p95.toFixed(2)),
            missedDeadlines: this._missedDeadlines,
            pauseReason: this._pauseReason
        };
    }

    _recordCycle(durationMs, success = true, timestamp = Date.now()) {
        const nowMonoMs = Number(process.hrtime.bigint() / 1000000n);
        this._recentCycleTimestamps.push(timestamp);
        while (
            this._recentCycleTimestamps.length > 2 &&
            (this._recentCycleTimestamps.length > 256 || this._recentCycleTimestamps[0] < timestamp - 1500)
        ) {
            this._recentCycleTimestamps.shift();
        }
        this._recentDurations.push(durationMs);
        if (this._recentDurations.length > 32) this._recentDurations.shift();

        if (!this.unlimitedActive && durationMs > this.effectiveIntervalMs) {
            this._missedDeadlines++;
        }

        if (success) {
            this._consecutiveSuccesses++;
        } else {
            this._consecutiveSuccesses = 0;
            this._lastBackoffOrErrorAt = nowMonoMs;
        }

        if ((this._warmingUp && this._consecutiveSuccesses >= 4) || nowMonoMs - this._lastAdaptiveEvalAt >= 1000) {
            this._evaluateAdaptiveSchedule(nowMonoMs);
            this._lastAdaptiveEvalAt = nowMonoMs;
        }
    }

    _evaluateAdaptiveSchedule(nowMonoMs = Number(process.hrtime.bigint() / 1000000n)) {
        if (this.unlimitedActive || this._recentDurations.length < 4) return;
        const { duration, threshold } = this._adaptiveCost();
        const target = this.targetIntervalMs;

        if (this._warmingUp && this._consecutiveSuccesses >= 4) {
            this.effectiveIntervalMs = Math.min(10000, Math.max(target, Math.ceil(duration / threshold)));
            this._warmingUp = false;
            this._consecutiveSuccesses = 0;
            this._recentCycleTimestamps = [];
            return;
        }

        if (duration > this.effectiveIntervalMs * threshold) {
            const requiredInterval = Math.ceil(duration / threshold);
            const nextInterval = Math.min(
                10000,
                Math.max(this.effectiveIntervalMs + 5, requiredInterval, Math.round(this.effectiveIntervalMs * 1.25))
            );
            if (nextInterval > this.effectiveIntervalMs) {
                this.effectiveIntervalMs = nextInterval;
                this._consecutiveSuccesses = 0;
                this._lastBackoffOrErrorAt = nowMonoMs;
            }
        } else if (
            this._consecutiveSuccesses >= 32 &&
            nowMonoMs - this._lastBackoffOrErrorAt >= 2000 &&
            this.effectiveIntervalMs > target
        ) {
            const stepDown = Math.max(target, Math.round(this.effectiveIntervalMs * 0.85));
            if (duration <= stepDown * threshold) {
                this.effectiveIntervalMs = stepDown;
                this._consecutiveSuccesses = 0;
            }
        }
    }

    _status(msg) {
        if (this.handlers.onStatus) this.handlers.onStatus(msg);
    }
    _error(msg) {
        this._lastErrorAt = this.now();
        this._successfulReads = 0;
        const duplicate =
            this._sampleErrorActive && (this._lastReportedError === msg || this.now() - this._lastErrorPostedAt < 2000);
        this._sampleErrorActive = true;
        if (duplicate) return;
        this._lastReportedError = msg;
        this._lastErrorPostedAt = this.now();
        if (this.handlers.onError) this.handlers.onError(msg);
    }
    _handlePollingFailure(message) {
        if (this._pollFailureLocked) return;
        const now = this.now();
        if (this._pollFailureSince === null || now - this._lastErrorAt > 5000) {
            this._pollFailureSince = now;
            this._pollFailureCount = 0;
        }
        this._pollFailureCount++;
        this._error(message);
        if (this._pollFailureCount < 3 || now - this._pollFailureSince < 3000) return;
        this._pollFailureLocked = true;
        this.invalidateTarget();
        this.setSamplingEnabled(false);
        const error = Object.assign(new Error(message), {
            code: "LIVE_TARGET_POLL_FAILED",
            i18nKey: "live.targetPollingFailed"
        });
        if (this.mode === "debug") {
            // Keep GDB's server alive, but do not reconnect/re-enable runtime reads.
            this._status({ key: error.i18nKey });
            this.handlers.onDegraded?.(error);
        } else this._abortConnection(error);
    }
    // 采样中拔出调试器的致命日志特征（USB 读写失败 / 设备丢失），用于自动停止采样
    _isFatalProbeLog(line) {
        return /WriteFile|ReadFile|LIBUSB_ERROR_(?:NO_DEVICE|IO|PIPE)|error (?:writing|reading) data|target communication error/i.test(
            String(line || "")
        );
    }

    async start() {
        if (!isSafeCfg(this.options.probe) || !isSafeCfg(this.options.target)) {
            throw new Error(`Invalid OpenOCD configuration：${this.options.probe} / ${this.options.target}`);
        }
        const port = clampInteger(this.options.port, 6666, 1, 65535);
        this.targetIntervalMs = clampInteger(this.options.intervalMs, 100, 5, 10000);
        this.options.intervalMs = this.targetIntervalMs;
        const gdbPort = this.mode === "debug" ? clampInteger(this.options.gdbPort, 0, 1, 65535) : 0;
        if (this.mode === "debug" && !gdbPort) throw new Error("Managed debug OpenOCD requires a GDB port");
        if (/(^|\/)gd32vf103\.cfg$/i.test(this.options.target)) {
            throw Object.assign(
                new Error("GD32VF103 does not support debugger memory access while the CPU is running"),
                {
                    code: "LIVE_MEMORY_UNSUPPORTED"
                }
            );
        }
        const launch = resolveOpenOcdLaunch(
            this.options.executable,
            this.options.probe,
            this.options.target,
            this.options.transport
        );
        const args = [
            ...buildOpenOcdConfigArgs(launch, this.options.transport, {
                ...this.options,
                adapterSpeedKhz:
                    this.mode === "standalone"
                        ? normalizeAdapterSpeed(this.options.samplingAdapterSpeedKhz) || this.options.adapterSpeedKhz
                        : this.options.adapterSpeedKhz
            }),
            "-c",
            "bindto 127.0.0.1",
            "-c",
            `tcl_port ${port}`,
            "-c",
            this.mode === "debug" ? `gdb_port ${gdbPort}` : "gdb_port disabled",
            "-c",
            "telnet_port disabled",
            ...(this.mode === "debug" ? buildOpenOcdTargetArgs(this.options, this.options.gdbPorts) : []),
            // RTOS 感知只在调试模式下配置：独立采样是非侵入轮询，让 OpenOCD 遍历内核数据结构会改变采样行为。
            ...(this.mode === "debug" ? buildOpenOcdRtosArgs(this.options.rtos, !!this.options.serverGroup) : []),
            ...(this.mode === "debug"
                ? ["-c", "foreach _ep_target [target names] { $_ep_target configure -work-area-backup 1 }"]
                : []),
            // 仅初始化，不 halt/不 reset，保持非侵入；自动模式下随后校验目标芯片
            ...withTargetCheck(["init"], this.options.targetCheck, this.options.target).flatMap((command) => [
                "-c",
                command
            ]),
            ...(this.mode === "standalone" && this.options.backendKind === "tcp"
                ? ["-c", "if {[llength [info commands poll_interval]]} { poll_interval 500 }"]
                : [])
        ];
        const targetCheck = targetCheckMonitor(this.options.targetCheck);
        this._status({ key: "lw.connecting" });
        try {
            this.child = spawn(launch.executable, args, { cwd: launch.cwd, windowsHide: true, shell: false });
        } catch (error) {
            const spawnError = /** @type {NodeJS.ErrnoException} */ (error);
            throw spawnError.code === "ENOENT"
                ? Object.assign(new Error(`OpenOCD not found：${this.options.executable}`), {
                      i18nKey: "run.notFound",
                      i18nParams: { path: this.options.executable }
                  })
                : new Error(spawnError.message);
        }
        this.child.on("error", (error) => {
            const childError = /** @type {NodeJS.ErrnoException} */ (error);
            const enoent = childError.code === "ENOENT";
            const e = enoent
                ? Object.assign(new Error(`OpenOCD not found：${this.options.executable}`), {
                      i18nKey: "run.notFound",
                      i18nParams: { path: this.options.executable }
                  })
                : new Error(childError.message);
            this._abortConnection(e);
        });
        const readyPattern = new RegExp(`Listening on port\\s+${port}\\s+for tcl connections`, "i");
        const onLog = (chunk) => {
            const text = chunk.toString();
            for (const line of text.split(/\r?\n/)) {
                const clean = line.trim();
                if (!clean) continue;
                if (clean.startsWith("EP_OK:") || this._observeNoEchoLog(clean)) continue;
                if (targetCheck.line(clean)) {
                    // A Worker forwards the observation to the extension host, which records it after success.
                    if (targetCheck.observed && !targetCheck.mismatched)
                        this.handlers.onTargetIdentity?.(this.options.targetCheck.checkId, targetCheck.observed);
                    continue;
                }
                // OpenOCD's own error output after a failed check repeats it; the close handler reports it once.
                if (targetCheck.mismatched) continue;
                this._openOcdRawTail = (this._openOcdRawTail + clean + "\n").slice(-2000);
                if (!this._tclListening && readyPattern.test(this._openOcdRawTail)) this._tclListening = true;
                this._openOcdLogTail.push(clean.slice(0, 500));
                if (this._openOcdLogTail.length > 4096) this._openOcdLogTail.shift();
                // 采样中拔出调试器：USB 读写失败等致命信号 → 自动停止采样，避免错误反复刷屏
                if (this._isFatalProbeLog(clean)) {
                    if (!this.stopped && !this.connectionFailed) {
                        this._abortConnection(
                            Object.assign(
                                new Error("Debugger disconnected; live sampling stopped"),
                                diagnoseOpenOcdFailure(this._openOcdLogTail, connectionDetails(this.options)),
                                {
                                    i18nKey: "live.probeDisconnected"
                                }
                            )
                        );
                    }
                    return;
                }
                if (this.connectionFailed) continue;
                if (/\bPolling failed\b/i.test(clean)) {
                    this._handlePollingFailure(clean);
                    continue;
                }
                // A GDB/telnet/Tcl client closing its socket (WSA 10054, connection reset) is not a target fault.
                if (/^Error on socket '/i.test(clean)) continue;
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
        const pendingLogs = { stdout: createLineDecoder(onLog), stderr: createLineDecoder(onLog) };
        this.child.stdout.on("data", (chunk) => pendingLogs.stdout.write(chunk));
        this.child.stderr.on("data", (chunk) => pendingLogs.stderr.write(chunk));
        this.child.on("close", (code) => {
            for (const stream of ["stdout", "stderr"]) pendingLogs[stream].end();
            const expected = this.stopped;
            this.child = null;
            this._clearSamplingTimer();
            this._releaseTimerResolution();
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
                const diagnostic = diagnoseOpenOcdFailure(this._openOcdLogTail, {
                    ...connectionDetails(this.options),
                    exitCode: code,
                    port
                });
                const error =
                    targetCheck.error() ||
                    Object.assign(new Error(diagnostic.message), diagnostic, {
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
        let ready;
        try {
            this._initializing = true;
            this._tclReady = new Promise((resolve) => {
                ready = resolve;
            });
            await new Promise((resolve, reject) => {
                this._startReject = reject;
                if (this.stopped) {
                    reject(this.connectionError || new Error("OpenOCD exited during connection startup"));
                    return;
                }
                this._waitForTclListening(6000)
                    .then(() => this._connectWithRetry(port, 1000))
                    .then(async (sock) => {
                        if (this.stopped) {
                            try {
                                sock.destroy();
                            } catch (e) {
                                /* ignore */
                            }
                            reject(this.connectionError || new Error("OpenOCD exited during connection startup"));
                            return;
                        }
                        this.socket = sock;
                        let reusable = false;
                        try {
                            reusable = await this._detectNoEcho(sock);
                        } catch {
                            this.noEchoResponses = false;
                        }
                        if (!reusable) {
                            // A partial reply cannot be reused in the untagged FIFO protocol.
                            sock.destroy();
                            this.socket = await this._connectWithRetry(port, 1000);
                        }
                        if (this.stopped) throw this.connectionError || new Error("Stopped");
                        this._setupSocket();
                        this._initializing = false;
                        ready();
                        await this._detectScatter();
                        if (!this.socket && !this.stopped) {
                            // No-echo support belongs to the OpenOCD binary, so it survives this reconnect.
                            this.socket = await this._connectWithRetry(port, 1000);
                            this._setupSocket();
                        }
                        if (this.stopped) throw this.connectionError || new Error("Stopped");
                        this._status({ key: "lw.connected" });
                        if (this._samplingRequested) {
                            this.samplingEnabled = true;
                            this._pauseReason = null;
                            this._warmUp();
                            this._scheduleNext(0);
                        }
                        resolve(undefined);
                    })
                    .catch(reject);
            });
        } finally {
            this._initializing = false;
            ready?.();
            this._startReject = null;
        }
        this._startCompleted = true;
        let targetNames;
        if (this.options.serverGroup) {
            targetNames = String(await this._sendCheckedCommand("target names"))
                .trim()
                .split(/\s+/);
            if (
                targetNames.length !== this.options.numberOfProcessors ||
                targetNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name))
            )
                throw new Error("OpenOCD did not return the configured shared target names");
        }
        return Object.freeze({
            gdbTarget: this.mode === "debug" ? `127.0.0.1:${gdbPort}` : null,
            ...(this.options.gdbPorts
                ? { gdbTargets: this.options.gdbPorts.map((value) => `127.0.0.1:${value}`) }
                : {}),
            tclPort: port,
            ...(targetNames ? { targetNames } : {}),
            mode: this.mode
        });
    }

    // "exit" already proves the process released the probe; "close" can lag while stdio drains.
    waitForExit(timeoutMs = 1200) {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode != null) return Promise.resolve(true);
        return waitForChildExit(child, Math.max(100, Number(timeoutMs) || 1200));
    }

    async _waitForTclListening(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (!this._tclListening) {
            if (this.stopped) throw this.connectionError || new Error("OpenOCD service exited before Tcl was ready");
            if (!this.child || Date.now() >= deadline) {
                const diagnostic = diagnoseOpenOcdFailure(this._openOcdLogTail, {
                    ...connectionDetails(this.options),
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
                if (this.stopped) return reject(this.connectionError || new Error("Stopped"));
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
                        reject(this.connectionError || new Error("Stopped"));
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
                    if (this.stopped) reject(this.connectionError || new Error("Stopped"));
                    else if (Date.now() > deadline) {
                        const diagnostic = diagnoseOpenOcdFailure(this._openOcdLogTail, {
                            ...connectionDetails(this.options),
                            port
                        });
                        reject(Object.assign(new Error(diagnostic.message), diagnostic));
                    } else setTimeout(attempt, 200);
                };
                sock.once("connect", onConnect);
                sock.once("error", onInitialError);
            };
            attempt();
        });
    }

    _observeNoEchoLog(line) {
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
                clearTimeout(timer);
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
            const timer = setTimeout(() => finish(replies === 2 && !pending && !socket.destroyed), 500);
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

    _setupSocket() {
        const socket = this.socket;
        socket.setNoDelay(true);
        socket.on("data", (chunk) => {
            if (socket !== this.socket || this.connectionFailed || this.stopped) return;
            this.pending += chunk.toString("latin1");
            let idx;
            while ((idx = this.pending.indexOf(SUB)) >= 0) {
                const resp = this.pending.slice(0, idx);
                this.pending = this.pending.slice(idx + 1);
                const q = this.queue.shift();
                if (q) q.resolve(resp);
                if (socket !== this.socket || this.connectionFailed || this.stopped) return;
            }
            // 失控流兜底：若缓冲累积超过 1MB 仍未出现分帧符，说明响应流异常，丢弃并重置连接，避免无限增长
            if (this.pending.length > 1048576) {
                this.pending = "";
                this._handleRpcFailure(new Error("Invalid OpenOCD response stream: framing delimiter missing"));
            }
        });
        socket.on("error", (e) => {
            if (socket === this.socket) this._handleRpcFailure(e);
        });
        socket.on("close", () => {
            if (socket === this.socket && !this.stopped) this._handleRpcFailure(new Error("Tcl connection closed"));
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
                    await this._detectScatter();
                    if (!this.socket) continue;
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
        const err = /** @type {Error & { i18nKey?: string }} */ (
            error instanceof Error ? error : new Error(String(error || "Connection disconnected"))
        );
        if (this.connectionFailed) return;
        this.connectionFailed = true;
        this.targetEpoch++;
        this.connectionError = err;
        this._rejectExclusiveWaiters(err);
        this._resetHostHold();
        if (
            this.mode === "debug" &&
            this.child &&
            !this.stopped &&
            this._startCompleted &&
            err.i18nKey !== "live.probeDisconnected"
        ) {
            this.sampleEpoch++;
            this.samplingEnabled = false;
            this._clearSamplingTimer();
            this._releaseTimerResolution();
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
        this.sampleEpoch++;
        this.samplingEnabled = false;
        this._samplingRequested = false;
        this._clearSamplingTimer();
        this._releaseTimerResolution();
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
    _handleRpcFailure(error) {
        if (!this._detectingScatter) return this._abortConnection(error);
        // Capability probing is optional. Discard an ambiguous FIFO before reconnecting;
        // acquisition timeouts still go through the normal fatal connection path.
        const socket = this.socket;
        this.socket = null;
        this.pending = "";
        this._rejectQueue(error);
        socket?.destroy();
    }

    _sendCommand(cmd) {
        if (this._initializing) return this._tclReady.then(() => this._sendCommand(cmd));
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) return reject(new Error("Socket is not connected"));
            const entry = {};
            const deadline = Date.now() + this.rpcTimeoutMs;
            const timer = setTimeout(() => {
                if (this.queue.includes(entry))
                    this._handleRpcFailure(
                        Object.assign(new Error("OpenOCD response timed out; sampling connection reset"), {
                            code: "OPENOCD_RPC_TIMEOUT"
                        })
                    );
            }, this.rpcTimeoutMs);
            entry.resolve = (v) => {
                clearTimeout(timer);
                // A wake-up or busy event loop may dispatch data before the overdue timeout callback.
                if (Date.now() >= deadline) {
                    const error = Object.assign(new Error("OpenOCD response timed out; sampling connection reset"), {
                        code: "OPENOCD_RPC_TIMEOUT"
                    });
                    reject(error);
                    this._handleRpcFailure(error);
                    return;
                }
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
                this._handleRpcFailure(e);
            }
        });
    }

    async _detectScatter() {
        this.scatterReads = false;
        this._scatterFailures = 0;
        this._detectingScatter = true;
        const timeout = this.rpcTimeoutMs;
        this.rpcTimeoutMs = Math.min(timeout, 500);
        try {
            this.scatterReads = (await this._sendCheckedCommand("emberprobe_read_scatter version")) === "1";
        } catch (error) {
            // Unsupported commands, malformed results and a bounded lost probe disable it. The patched
            // command also refuses before the target is examined, so ask once more after a good cycle.
            this._scatterRecheck = String(error?.message || "").startsWith("EMBERPROBE_SCATTER_UNSUPPORTED");
        } finally {
            this.rpcTimeoutMs = timeout;
            this._detectingScatter = false;
        }
    }

    async _sendCheckedCommand(cmd) {
        if (this._initializing) await this._tclReady;
        if (this.mode === "debug" && !this.noEchoResponses) return this._sendSilentDebugCommand(cmd);
        const result = this.noEchoResponses ? "return -code exit $_ep_out" : "set _ep_out";
        const wrapped = `set _ep_rc [catch {${cmd}} _ep_msg]; if {$_ep_rc} {set _ep_out "EP_ERR:\${_ep_msg}"} else {set _ep_out "EP_OK:\${_ep_msg}"}; ${result}`;
        const response = String((await this._sendCommand(wrapped)) || "").replace(/\x1a/g, "");
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

    async _ensureSilentResponseFile() {
        if (this._silentResponseFile) return this._silentResponseFile;
        this._silentResponseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "emberprobe-openocd-"));
        this._silentResponseFile = path.join(this._silentResponseDir, "response");
        return this._silentResponseFile;
    }

    // OpenOCD 会把 Tcl RPC 的非空返回值广播给 GDB，导致调试控制台持续刷出
    // EP_OK:<value>。调试模式把机器响应写入扩展创建的私有临时文件，让 Tcl RPC 本身返回空串。
    async _sendSilentDebugCommand(cmd) {
        const responseFile = await this._ensureSilentResponseFile();
        const wrapped = `set _ep_rc [catch {${cmd}} _ep_msg]; set _ep_file [open ${quoteTclWord(responseFile)} w]; puts -nonewline $_ep_file "\${_ep_rc}\\n"; puts -nonewline $_ep_file $_ep_msg; close $_ep_file; set _ep_msg ""`;
        const rpcResponse = String((await this._sendCommand(wrapped)) || "").replace(/\x1a/g, "");
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

    // 按地址/长度选择 32/16/8 bit 传输，再统一解包为小端字节。
    async _readMemoryBytes(addr, count) {
        const hex = "0x" + (addr >>> 0).toString(16);
        const shape = transferShape(addr, count);
        const build = (cmd) => `${cmd} ${hex} ${shape.widthBits} ${shape.count}`;
        let resp;
        try {
            resp = await this._sendCheckedCommand(build(this.readCmd));
        } catch (error) {
            if (
                !this.altTried &&
                new RegExp(`(?:invalid command name|unknown command)\\s+["']?${this.readCmd}(?:["'\\s]|$)`, "i").test(
                    error.message
                )
            ) {
                this.altTried = true;
                this.readCmd = this.readCmd === "ocd_read_memory" ? "read_memory" : "ocd_read_memory";
                resp = await this._sendCheckedCommand(build(this.readCmd));
            } else throw error;
        }
        const values = parseMemoryElements(resp, shape.widthBits);
        if (values.length !== shape.count) {
            this._lastReadError = String(resp || "")
                .trim()
                .slice(0, 200);
            return null;
        }
        const bytes = elementsToBytes(values, shape.elementBytes);
        this._memoryReadBytes += bytes.length;
        return bytes;
    }

    _assertReadGuard(guard) {
        if (!guard) return;
        const epochChanged =
            guard.targetEpoch === undefined ? guard.epoch !== this.sampleEpoch : guard.targetEpoch !== this.targetEpoch;
        if (epochChanged || (guard.requireSampling && !this.samplingEnabled)) {
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

    async _readBatchBytes(batch) {
        if (batch.length === 1) {
            const g = batch[0];
            const bytes = await this._readMemoryBytes(g.start, g.byteCount);
            return [bytes];
        }
        const calls = batch.map((g) => {
            const hex = "0x" + (g.start >>> 0).toString(16);
            return `[${this.readCmd} ${hex} ${g.shape.widthBits} ${g.shape.count}]`;
        });
        const cmd = `join [list ${calls.join(" ")}] "\\n"`;
        let resp;
        try {
            resp = await this._sendCheckedCommand(cmd);
        } catch (error) {
            if (
                !this.altTried &&
                new RegExp(`(?:invalid command name|unknown command)\\s+["']?${this.readCmd}(?:["'\\s]|$)`, "i").test(
                    error.message
                )
            ) {
                this.altTried = true;
                this.readCmd = this.readCmd === "ocd_read_memory" ? "read_memory" : "ocd_read_memory";
                const retryCalls = batch.map((g) => {
                    const hex = "0x" + (g.start >>> 0).toString(16);
                    return `[${this.readCmd} ${hex} ${g.shape.widthBits} ${g.shape.count}]`;
                });
                const retryCmd = `join [list ${retryCalls.join(" ")}] "\\n"`;
                resp = await this._sendCheckedCommand(retryCmd);
            } else {
                throw error;
            }
        }
        const lines = String(resp || "").split(/\r?\n/);
        if (lines.length !== batch.length)
            throw Object.assign(new Error("Batch memory read response has an unexpected number of groups"), {
                code: "OPENOCD_TCL_PROTOCOL_ERROR"
            });
        const result = [];
        for (let i = 0; i < batch.length; i++) {
            const g = batch[i];
            const line = lines[i];
            const values = parseMemoryElements(line, g.shape.widthBits);
            if (values.length !== g.shape.count) {
                result.push(null);
            } else {
                const bytes = elementsToBytes(values, g.shape.elementBytes);
                if (bytes.length === g.byteCount) this._memoryReadBytes += bytes.length;
                result.push(bytes.length === g.byteCount ? bytes : null);
            }
        }
        return result;
    }

    _getReadBatches(items, reservedBytes = 0) {
        // Multi-rate ticks allocate new arrays but retain the ordered watch-item identities.
        const cached = this._readBatchCache.find(
            (entry) =>
                entry.ranges === this.ramSectionRanges &&
                entry.mode === this.mode &&
                entry.reservedBytes === reservedBytes &&
                entry.items.length === items.length &&
                entry.items.every((saved, index) => {
                    const item = items[index];
                    return (
                        saved.item === item &&
                        saved.name === item.name &&
                        saved.address === item.address &&
                        saved.size === item.size
                    );
                })
        );
        if (cached) return cached.batches;
        const batches = compileReadBatches(items, this.ramSectionRanges, this.mode === "debug", reservedBytes);
        if (this._readBatchCache.length >= MAX_READ_BATCH_CACHE_ENTRIES) this._readBatchCache.shift();
        this._readBatchCache.push({
            ranges: this.ramSectionRanges,
            mode: this.mode,
            reservedBytes,
            items: items.map((item) => ({ item, name: item.name, address: item.address, size: item.size })),
            batches
        });
        return batches;
    }

    async _readScatterBytes(batches, guard) {
        const units = batches.flat();
        const results = new Map();
        for (let offset = 0; offset < units.length;) {
            const segments = [];
            let byteCount = 0;
            while (
                offset < units.length &&
                segments.length < MAX_SCATTER_SEGMENTS &&
                byteCount + units[offset].byteCount <= MAX_SCATTER_BYTES
            ) {
                const unit = units[offset++];
                segments.push(unit);
                byteCount += unit.byteCount;
            }
            this._assertReadGuard(guard);
            const args = segments.map(
                (unit) => `{0x${unit.start.toString(16)} ${unit.shape.widthBits} ${unit.shape.count}}`
            );
            const response = await this._sendCheckedCommand(`emberprobe_read_scatter ${args.join(" ")}`);
            this._assertReadGuard(guard);
            const lines = String(response).split("\n");
            if (
                lines.length !== segments.length ||
                lines.some((line, index) => line.length !== segments[index].byteCount * 2 || !/^[0-9a-f]+$/.test(line))
            ) {
                throw Object.assign(new Error("Scatter memory read returned invalid hex segments"), {
                    code: "OPENOCD_TCL_PROTOCOL_ERROR"
                });
            }
            for (let index = 0; index < segments.length; index++)
                results.set(segments[index], Array.from(Buffer.from(lines[index], "hex")));
            this._memoryReadBytes += byteCount;
        }
        return results;
    }

    _isConnectionError(error) {
        return (
            error.code?.startsWith("LIVE_") ||
            this.connectionFailed ||
            ["OPENOCD_RPC_TIMEOUT", "ECONNRESET", "ECONNABORTED", "EPIPE", "ENOTCONN", "ETIMEDOUT"].includes(
                error.code
            ) ||
            /^(?:Socket is not connected|Tcl connection closed)/.test(error.message)
        );
    }

    // Ordered `{ address, size }` ranges in scatter requests, or null when scatter is off or refused
    // them (callers then read one range at a time). Connection failures still end the cycle.
    async _scatterRanges(ranges, guard) {
        if (!this.scatterReads || !ranges.length) return null;
        const units = ranges.map(({ address, size }) => ({
            start: address,
            byteCount: size,
            shape: transferShape(address, size)
        }));
        try {
            const results = await this._readScatterBytes([units], guard);
            this._scatterFailures = 0;
            return units.map((unit) => Buffer.from(results.get(unit)));
        } catch (error) {
            if (this._isConnectionError(error)) throw error;
            this._assertReadGuard(guard);
            if (error.message.startsWith("EMBERPROBE_SCATTER_UNSUPPORTED") || ++this._scatterFailures >= 3)
                this.scatterReads = false;
            return null;
        }
    }

    // With scatter, a runtime object first fetches every block its previous sample read in one request
    // and walks those; only reads the plan lacks (the object moved) go out one at a time, and the
    // descriptor check at the end is one request too. The plan is charged to the budget up front. When a
    // stale plan pushed the cycle over budget, the object is read once more without it. Any other
    // failure keeps the plan, so one bad cycle does not slow the next one down to single reads (a
    // longer read-to-verify window that makes changing descriptors miss again).
    async _sampleRuntimeItem(item, guard, budget) {
        const plan = this.scatterReads ? this._runtimePlans.get(item) : null;
        const before = { bytes: budget.bytes, commands: budget.commands };
        let prefetched = null;
        if (plan) {
            const bytes = plan.reduce((sum, read) => sum + read.size * (read.descriptor ? 2 : 1), 0);
            const commands = plan.reduce((sum, read) => sum + (read.descriptor ? 2 : 1), 0);
            if (
                budget.bytes + bytes <= (budget.maxBytes || RUNTIME_CYCLE_BYTES) &&
                budget.commands + commands <= (budget.maxReads || RUNTIME_CYCLE_READS)
            ) {
                const blocks = await this._scatterRanges(plan, guard);
                if (blocks) prefetched = plan.map((read, index) => ({ address: read.address, bytes: blocks[index] }));
            }
        }
        const reader = new RuntimeObjectReader(
            item,
            (address, size) => this._readMemoryBytes(address, size),
            () => this._assertReadGuard(guard),
            budget,
            {
                prefetched,
                readMany: this.scatterReads ? (ranges) => this._scatterRanges(ranges, guard) : null
            }
        );
        try {
            const tree = await reader.sample();
            if (this.scatterReads) this._runtimePlans.set(item, reader.reads);
            return tree;
        } catch (error) {
            if (!prefetched || error.code !== "LIVE_READ_BUDGET_EXCEEDED" || !reader.prefetchStale()) throw error;
            this._assertReadGuard(guard);
            this._runtimePlans.delete(item);
            Object.assign(budget, before);
            return this._sampleRuntimeItem(item, guard, budget);
        }
    }

    async _readItems(items, t, guard = null) {
        const samples = [];
        let ok = 0;
        const fixedItems = items.filter((entry) => !entry.runtimeLayout);
        const runtimeItems = items.filter((entry) => entry.runtimeLayout);
        const batches = this._getReadBatches(
            fixedItems,
            runtimeItems.reduce((sum, item) => sum + item.size, 0)
        );
        // Debug mode bounds the whole cycle, so fixed reads are reserved first. Standalone fixed reads
        // have no per-cycle budget and must not consume the runtime objects' own one.
        const shared = this.mode === "debug";
        const runtimeBudget = runtimeItems.length
            ? {
                  bytes: shared
                      ? Math.max(
                            // Throughput and shared runtime budgets count gap bytes actually transferred.
                            batches.reduce(
                                (sum, batch) => batch.reduce((total, unit) => total + unit.byteCount, sum),
                                0
                            ),
                            fixedItems.reduce((total, entry) => total + entry.size, 0)
                        )
                      : 0,
                  commands: shared ? batches.reduce((total, batch) => total + batch.length, 0) : 0,
                  deadline: guard?.deadline || Date.now() + MAX_DEBUG_CYCLE_MS
              }
            : null;
        for (const item of runtimeItems) {
            this._assertReadGuard(guard);
            try {
                const runtimeTree = await this._sampleRuntimeItem(item, guard, runtimeBudget);
                samples.push({ name: item.name, runtimeTree, t });
                ok++;
            } catch (error) {
                this._assertReadGuard(guard);
                if (!error.code?.startsWith("LIVE_")) throw error;
                samples.push({
                    name: item.name,
                    bytes: null,
                    diagnostic: {
                        code: error.code || "LIVE_LAYOUT_UNSUPPORTED",
                        message: error.message,
                        ...(error.details?.reason ? { reason: error.details.reason } : {})
                    },
                    t
                });
                this._lastReadError = error.message;
                ok++;
            }
        }
        const assembled = new Map();
        let scatterBytes = null;
        let scatterFailed = false;
        if (this.scatterReads && batches.length) {
            try {
                scatterBytes = await this._readScatterBytes(batches, guard);
                this._scatterFailures = 0;
            } catch (error) {
                if (this._isConnectionError(error)) throw error;
                this._assertReadGuard(guard);
                scatterFailed = true;
                if (error.message.startsWith("EMBERPROBE_SCATTER_UNSUPPORTED") || ++this._scatterFailures >= 3)
                    this.scatterReads = false;
            }
        }
        for (const batch of batches) {
            this._assertReadGuard(guard);
            let batchBytes = scatterBytes ? batch.map((unit) => scatterBytes.get(unit)) : null;
            if (!batchBytes && !this._batchUnsupported) {
                try {
                    batchBytes = await this._readBatchBytes(batch);
                } catch (error) {
                    const incompatible =
                        batch.length > 1 &&
                        (error?.code === "OPENOCD_TCL_PROTOCOL_ERROR" ||
                            /(?:invalid command name|unknown command)\s+["']?(?:join|list)(?:["'\s]|$)/i.test(
                                String(error?.message || "")
                            ));
                    if (!incompatible && !(scatterFailed && error.code === "OPENOCD_TCL_ERROR")) throw error;
                    if (incompatible) this._batchUnsupported = true;
                }
            }
            this._assertReadGuard(guard);
            if (!batchBytes) {
                batchBytes = [];
                for (const g of batch) {
                    this._assertReadGuard(guard);
                    let bytes;
                    try {
                        bytes = await this._readMemoryBytes(g.start, g.byteCount);
                    } catch (error) {
                        if (!scatterFailed || error.code !== "OPENOCD_TCL_ERROR") throw error;
                        this._lastReadError = error.message;
                        bytes = null;
                    }
                    this._assertReadGuard(guard);
                    batchBytes.push(bytes);
                }
            }
            for (let i = 0; i < batch.length; i++) {
                const unit = batch[i];
                const g = unit.group;
                const bytes = batchBytes[i];
                let result = assembled.get(g);
                if (!result) {
                    result = { bytes: new Array(g.byteCount), received: 0, failed: false };
                    assembled.set(g, result);
                }
                if (!bytes || bytes.length !== unit.byteCount) result.failed = true;
                else {
                    for (let offset = 0; offset < bytes.length; offset++)
                        result.bytes[unit.start - g.start + offset] = bytes[offset];
                    result.received += bytes.length;
                }
            }
        }
        for (const [g, result] of assembled) {
            const bytes = !result.failed && result.received === g.byteCount ? result.bytes : null;
            if (!bytes) this._lastReadError = "memory read returned invalid or incomplete data";
            for (const v of g.vars) {
                const off = v.address - g.start;
                samples.push({
                    name: v.name,
                    bytes: bytes ? bytes.slice(off, off + v.size) : null,
                    ...(!bytes && {
                        diagnostic: { code: "OPENOCD_MEMORY_RESPONSE_ERROR", message: this._lastReadError }
                    }),
                    t
                });
                if (bytes) ok++;
            }
        }
        if (ok && !this.stopped && !this._connectionConfirmed) {
            this._assertReadGuard(guard);
            this._connectionConfirmed = true;
            this.handlers.onConnectionConfirmed?.();
        }
        return { samples, ok };
    }

    // 在现有 Tcl 连接上读取一组变量一次，不改变 UI 的观察列表或采样定时器。
    async readOnce(items, timeoutMs = 2500) {
        if (!Array.isArray(items) || !items.length) return [];
        if (this.mode === "debug") validateManagedReadPlan(items);
        if (this.stopped || !this.socket || this.socket.destroyed)
            throw new Error("OpenOCD Tcl service is not connected");
        const requestEpoch = this.targetEpoch;
        const deadline = Date.now() + timeoutMs;
        await this._acquireExclusive(deadline);
        try {
            if (this.stopped || !this.socket || this.socket.destroyed)
                throw new Error("OpenOCD Tcl service is not connected");
            const guard =
                this.mode === "debug"
                    ? {
                          targetEpoch: requestEpoch,
                          requireSampling: false,
                          deadline: Math.min(deadline, Date.now() + MAX_DEBUG_CYCLE_MS)
                      }
                    : null;
            return (await this._readItems(items, Date.now(), guard)).samples;
        } finally {
            this._releaseExclusive();
        }
    }

    // 对齐的单字直接写入。其他变量先按自然宽度只写变量自身的字节，避免 halt 期间 DMA/外设
    // 刚更新的相邻字节被旧值覆盖；回读发现窄写被丢弃（某些 Cortex-M7/AHB-AP 的 byte-lane）
    // 时，再退回对齐的 32-bit 读-改-写。
    async _writeMemoryBytes(addr, bytes) {
        if (this.mode === "debug") validateManagedWritePlan([{ address: addr, bytes }]);
        const address = addr >>> 0;
        const input = Array.from(bytes || [], (value) => value & 0xff);
        if (!input.length) return true;
        const alignedStart = (address & 0xfffffffc) >>> 0;
        const alignedEnd = Math.ceil((address + input.length) / 4) * 4;
        if (alignedStart === address && alignedEnd - alignedStart === input.length) {
            await this._writeMemoryElements(alignedStart, 4, input);
            return true;
        }
        let narrowError = null;
        try {
            for (const chunk of naturalWriteChunks(address, input))
                await this._writeMemoryElements(chunk.address, chunk.width, chunk.bytes);
        } catch (error) {
            narrowError = error;
        }
        const words = await this._readMemoryBytes(alignedStart, alignedEnd - alignedStart);
        if (!words) {
            if (narrowError) throw narrowError;
            throw new Error("Memory write failed: cannot read back the written bytes");
        }
        const offset = address - alignedStart;
        if (!narrowError && input.every((value, index) => words[offset + index] === value)) return true;
        const writeBytes = words.slice();
        writeBytes.splice(offset, input.length, ...input);
        await this._writeMemoryElements(alignedStart, 4, writeBytes);
        return true;
    }

    async _writeMemoryElements(address, width, bytes) {
        const hex = "0x" + (address >>> 0).toString(16);
        const data = bytesToElements(bytes, width)
            .map((value) => "0x" + value.toString(16))
            .join(" ");
        const build = (cmd) => `${cmd} ${hex} ${width * 8} {${data}}`;
        try {
            await this._sendCheckedCommand(build(this.writeCmd));
        } catch (error) {
            if (!this.writeAltTried && /invalid command name|unknown command/i.test(error.message)) {
                this.writeAltTried = true;
                this.writeCmd = this.writeCmd === "ocd_write_memory" ? "write_memory" : "ocd_write_memory";
                try {
                    await this._sendCheckedCommand(build(this.writeCmd));
                } catch (fallbackError) {
                    throw Object.assign(new Error("Memory write failed: " + fallbackError.message), {
                        cause: fallbackError
                    });
                }
            } else {
                throw Object.assign(new Error("Memory write failed: " + error.message), { cause: error });
            }
        }
    }

    async _waitUntilIdle(timeoutMs) {
        await this._acquireExclusive(Date.now() + timeoutMs);
        this._releaseExclusive();
    }

    async waitForIdle(timeoutMs = 2000) {
        try {
            await this._waitUntilIdle(timeoutMs);
            return true;
        } catch {
            return false;
        }
    }

    // 全部为对齐单字时不查询或改变运行状态；其他事务保持 halt、读-改-写、校验及恢复。
    async writeAndVerify(items, timeoutMs = 5000) {
        if (!Array.isArray(items) || !items.length) return { before: [], after: [], halted: false };
        const nonHalting = items.every(isNonHaltingWordWrite);
        if (this.mode === "debug") validateManagedWritePlan(items);
        if (this.stopped || !this.socket || this.socket.destroyed)
            throw new Error("OpenOCD Tcl service is not connected");
        const requestEpoch = this.targetEpoch;
        const deadline = Date.now() + timeoutMs;
        await this._acquireExclusive(deadline);
        let haltedByUs = false;
        let primaryError = null;
        let result = null;
        let writtenItems = 0;
        try {
            // Ownership is reserved synchronously by the arbiter before connection checks.
            if (this.stopped || !this.socket || this.socket.destroyed)
                throw new Error("OpenOCD Tcl service is not connected");
            if (!nonHalting) {
                const state = (await this._sendCheckedCommand("[target current] curstate")).trim();
                if (state !== "halted") {
                    await this._sendCheckedCommand("halt");
                    haltedByUs = true;
                }
            }
            const guard =
                this.mode === "debug"
                    ? {
                          targetEpoch: requestEpoch,
                          requireSampling: false,
                          deadline: Math.min(deadline, Date.now() + MAX_DEBUG_CYCLE_MS)
                      }
                    : null;
            const readItems = items.map((item) => ({
                name: item.name,
                address: item.address,
                size: item.bytes.length
            }));
            const before = (await this._readItems(readItems, Date.now(), guard)).samples;
            for (const item of items) {
                this._assertReadGuard(guard);
                await this._writeMemoryBytes(item.address, item.bytes);
                writtenItems++;
            }
            this._assertReadGuard(guard);
            const after = (await this._readItems(readItems, Date.now(), guard)).samples;
            this._assertReadGuard(guard);
            result = { before, after, halted: !nonHalting };
        } catch (error) {
            // Callers must know whether a cancelled transaction already changed target memory.
            if (error?.code === "LIVE_READ_CANCELLED")
                error.details = { ...error.details, writtenItems, totalItems: items.length };
            primaryError = error;
        }
        try {
            if (haltedByUs) {
                try {
                    await this._sendCheckedCommand("resume");
                } catch (resumeError) {
                    if (!primaryError) primaryError = resumeError;
                }
            }
        } finally {
            this._releaseExclusive();
        }
        if (primaryError) throw primaryError;
        return result;
    }

    async _sampleTick(fromScheduler = false) {
        if (this._initializing || this._detectingScatter) return;
        if (!this.samplingEnabled || this.stopped || this._hostHold || !this.socket || this.socket.destroyed) return;
        if (!this.watch.length) return;
        if (!this._tryAcquireExclusive()) {
            // A read/write transaction owns the Tcl connection. Dropping the tick here would
            // break the self-rescheduling chain, freezing the watch list until sampling restarts.
            if (fromScheduler) {
                if (this.unlimitedActive) this._samplingTickDeferred = true;
                else this._scheduleNext(this.effectiveIntervalMs);
            }
            return;
        }
        const epoch = this.sampleEpoch;
        const startNs = process.hrtime.bigint();
        const targetEpoch = this.targetEpoch;
        const readBytesBefore = this._memoryReadBytes;
        const startedAt = Date.now();
        const deadline = startedAt + MAX_DEBUG_CYCLE_MS;
        const cycleStart = this.sampleNow();
        const clockMs = Number(startNs) / 1e6;
        let readSuccess = false;
        try {
            const due = this.ratePlan?.due(clockMs, this.effectiveIntervalMs);
            const items = due ? due.items : this.watch;
            const guard = this.mode === "debug" ? { epoch, requireSampling: true, deadline } : null;
            const { samples, ok } = items.length
                ? await this._readItems(items, cycleStart, guard)
                : { samples: [], ok: 0 };
            if (epoch !== this.sampleEpoch || !this.samplingEnabled) return;
            // One sub-millisecond stamp per cycle, centred on its reads, keeps every cycle a single archive/CSV row.
            const t = (cycleStart + this.sampleNow()) / 2;
            for (const sample of samples) sample.t = t;
            const delivered = due ? this.ratePlan.deliver(samples, t, due) : samples;
            if (this.handlers.onSample) this.handlers.onSample(delivered, t, due);
            if (ok === items.length) {
                readSuccess = true;
                if (this._scatterRecheck) {
                    this._scatterRecheck = false;
                    try {
                        this.scatterReads = (await this._sendCheckedCommand("emberprobe_read_scatter version")) === "1";
                    } catch {
                        // Still unsupported (for example an HLA target): keep the batch path.
                    }
                }
                if (this._sampleErrorActive) {
                    // One successful memory read does not prove target polling recovered.
                    this._successfulReads++;
                    if (this._successfulReads >= 3 && this.now() - this._lastErrorAt >= 2000) {
                        this._sampleErrorActive = false;
                        this._lastReportedError = "";
                        this._pollFailureSince = null;
                        this._pollFailureCount = 0;
                        this._lastReadError = "";
                        this._notifiedError = "";
                        this._status({ key: "sb.sampling" });
                    }
                }
            } else if (ok === 0 && this._lastReadError && this._lastReadError !== this._notifiedError) {
                this._notifiedError = this._lastReadError;
                this._error(
                    "读取内存失败：" + this._lastReadError + "（运行中读取失败时可尝试降低采样率或确认目标状态）"
                );
            }
        } catch (e) {
            if (epoch === this.sampleEpoch && this.samplingEnabled && !this.connectionFailed) this._error(e.message);
        } finally {
            this._releaseExclusive();
            const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
            if (epoch === this.sampleEpoch && targetEpoch === this.targetEpoch && this.samplingEnabled)
                this._samplingThroughput.record(
                    this._memoryReadBytes - readBytesBefore,
                    Number(startNs) / 1e6,
                    Number(startNs) / 1e6 + durationMs
                );
            if (epoch === this.sampleEpoch) this._recordCycle(durationMs, readSuccess, startedAt);
            if (fromScheduler && epoch === this.sampleEpoch && this.samplingEnabled && !this.stopped) {
                const nextDelay = this.ratePlan
                    ? this.ratePlan.delay(Number(process.hrtime.bigint()) / 1e6)
                    : Math.max(0, Math.round(this.effectiveIntervalMs - durationMs));
                this._scheduleNext(nextDelay);
            }
        }
    }

    stop(timeoutMs = 1200) {
        if (this._stopPromise) return this._stopPromise;
        const child = this.child;
        const socket = this.socket;
        const childExited = child ? this.waitForExit(timeoutMs) : Promise.resolve(true);
        this.stopped = true;
        this._pauseReason = "stopped";
        this.sampleEpoch++;
        this.targetEpoch++;
        this.samplingEnabled = false;
        this._samplingRequested = false;
        this.connectionFailed = true;
        this._clearSamplingTimer();
        this._releaseTimerResolution();
        this._resetHostHold();
        const stoppedError = new Error("采样Stopped");
        this._rejectExclusiveWaiters(stoppedError);
        this._rejectQueue(stoppedError);
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
                closed = await waitForChildExit(child, 400);
            }
            if (!closed && childRunning()) {
                const forcedExit = this.waitForExit(400);
                try {
                    child.kill("SIGKILL");
                } catch (e) {
                    /* ignore */
                }
                closed = await forcedExit;
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
            if (!closed) this._stopPromise = null;
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
    compileReadBatches,
    MAX_BATCH_GROUPS,
    MAX_BATCH_BYTES,
    parseMemoryValues,
    parseMemoryElements,
    transferShape,
    bytesToElements,
    elementsToBytes,
    validateManagedReadPlan,
    partitionManagedReadPlan,
    validateManagedWritePlan,
    MAX_DEBUG_READ_BYTES,
    MAX_DEBUG_READ_COMMANDS,
    MAX_DEBUG_CYCLE_MS,
    isSafeCfg,
    findFreePort
};
