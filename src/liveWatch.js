"use strict";
// Manages a single OpenOCD server: standalone mode opens only Tcl, debug mode also opens GDB. Tcl-RPC samples RAM and
// allows word writes without halting. An independent implementation inspired by MCUViewer (GPLv3) concepts, using none
// of its code.
const net = require("net");
const { isDeepStrictEqual } = require("util");
const { isSafeCfg, diagnoseOpenOcdFailure } = require("./openocdRunner");
const { clampInteger } = require("./validation");
const { SYSTEM_CLOCK, scheduleSamplingTick } = require("./samplingClock");
const { SamplingThroughput } = require("./samplingThroughput");
const { TclTransport } = require("./tclTransport");
const { windowsTimerResolution } = require("./windowsTimerResolution");
const { connectionDetails } = require("../skills/_emberprobe/openocd-diagnostics");
const { RuntimeObjectReader, RUNTIME_CYCLE_BYTES, RUNTIME_CYCLE_READS } = require("./services/runtimeObjectReader");
const { MultiRatePlan } = require("./services/multiRatePlan");
const { targetCheckMonitor } = require("./chip/targetIdentity");
const { OpenOcdProcess, managedServerLaunch, isFatalProbeLog } = require("./openocdProcess");
const { MemoryWriter, validateManagedWritePlan, peripheralTransaction } = require("./memoryWrite");
const { isNonHaltingWordWrite } = require("./writeAccess");
const {
    normalizeRamSectionRanges,
    parseMemoryElements,
    transferShape,
    elementsToBytes,
    sameConsumerItems,
    validateManagedReadPlan,
    compileReadBatches
} = require("./liveWatchReadPlan");

const MAX_DEBUG_CYCLE_MS = 1000;
const MAX_SCATTER_SEGMENTS = 64;
const MAX_SCATTER_BYTES = 4096;
const MAX_READ_BATCH_CACHE_ENTRIES = 8;

// Lets the OS pick a free ephemeral port. OpenOCD's Tcl port has no authentication, so a fixed port would let any local
// process connect during sampling and issue halt/write_memory; pick a random one unless a port is configured.
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

class ManagedOpenOcdSession {
    // options: { executable, probe, target, cwd, port, gdbPort, intervalMs, mode }
    // handlers: { onSample(samples,t), onStatus(msg), onError(msg), onDegraded(error), onDisconnect(error) }
    constructor(options, handlers) {
        if (options?.isolated)
            return /** @type {any} */ (new (require("./samplingSession").SamplingSession)(options, handlers));
        this.options = options || {};
        this.clock = { ...SYSTEM_CLOCK, ...this.options.clock };
        this.handlers = handlers || {};
        this.server = new OpenOcdProcess(this.clock);
        this.connectingSocket = null;
        this.timer = null;
        this.busy = false;
        this._exclusiveWaiters = [];
        this._samplingTickDeferred = false;
        this.unlimited = false;
        this._hostHold = false;
        this._hostHoldSince = null;
        this._hostHoldSpans = [];
        this._hostWindowStartedAt = this.clock.monotonicMs();
        this.stopped = false;
        this.watch = []; // [{name,address,size,type}]
        this.readCmd = "ocd_read_memory"; // preferred read command, falling back to read_memory
        this.altTried = false;
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
        this.connectionFailed = false;
        this.connectionError = null;
        // reject captured while start() runs, so connection failures are reported on one channel
        this._startReject = null;
        this._stopPromise = null;
        this.mode = this.options.mode === "debug" ? "debug" : "standalone";
        this.tcl = new TclTransport({
            clock: this.clock,
            mode: this.mode,
            rpcTimeoutMs: this.options.backendKind === "tcp" ? 5000 : 2000,
            isClosed: () => this.connectionFailed || this.stopped,
            onFailure: (error) => this._abortConnection(error)
        });
        this.writer = new MemoryWriter({
            tcl: this.tcl,
            mode: this.mode,
            readBytes: (address, count) => this._readMemoryBytes(address, count)
        });
        this.samplingEnabled = this.mode === "standalone";
        this._samplingRequested = this.samplingEnabled;
        this.sampleEpoch = 0;
        // One-shot transactions keep their own plan; only target/connection changes invalidate them.
        this.targetEpoch = 0;
        this._reconnectPromise = null;
        this._startCompleted = false;
        this.scatterReads = false;
        this._scatterFailures = 0;
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
        const remainingMs = deadlineMs - this.clock.now();
        if (remainingMs <= 0) return Promise.reject(timeoutError());
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null, deadlineMs };
            waiter.timer = this.clock.schedule(() => {
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
            this.clock.cancel(waiter.timer);
            if (this.clock.now() >= waiter.deadlineMs) {
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
            this.clock.cancel(waiter.timer);
            waiter.reject(error);
        }
        if (this._samplingTickDeferred) this._resumeDeferredSamplingTick();
    }

    _resetHostHold() {
        this._hostHold = false;
        this._hostHoldSince = null;
        this._hostHoldSpans = [];
        this._hostWindowStartedAt = this.clock.monotonicMs();
    }

    setHostHold(held) {
        const next = held === true && this.unlimitedActive && this.samplingEnabled && !this.stopped;
        if (next === this._hostHold) return;
        const now = this.clock.monotonicMs();
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
        const now = this.clock.monotonicMs();
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
        const nowMonoMs = this.clock.monotonicMs();
        this._lastAdaptiveEvalAt = nowMonoMs;
        this._lastBackoffOrErrorAt = nowMonoMs;
        this._recentCycleTimestamps = [];
        this._measuredTargetEpoch = this.targetEpoch;
    }

    // A pause with an unchanged plan and target keeps the measured read cost and adapted interval, so
    // resuming does not fall back to the 100 ms warm-up clock; only the rate windows restart.
    _resumeMeasured() {
        if (
            this.unlimitedActive ||
            this._warmingUp ||
            this._recentDurations.length < 4 ||
            this._measuredTargetEpoch !== this.targetEpoch
        )
            return false;
        this._samplingThroughput.reset();
        this._consecutiveSuccesses = 0;
        this._lastAdaptiveEvalAt = this.clock.monotonicMs();
        this._recentCycleTimestamps = [];
        return true;
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
        if (this.tcl.held) return;
        if (!this.samplingEnabled || this.stopped || this._hostHold || !this.tcl.connected) return;
        if (this.unlimitedActive) {
            delayMs = 0;
            this._releaseTimerResolution();
        } else if (!this._timerResolutionHeld) this._timerResolutionHeld = windowsTimerResolution.acquire();
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
        // Compiles the scalar batches now, so the first tick finds them in the cache.
        this._getReadBatches(
            this.watch.filter((entry) => !entry.runtimeLayout),
            this.watch.filter((entry) => entry.runtimeLayout).reduce((sum, item) => sum + item.size, 0)
        );
        this._warmUp();
        if (this.samplingEnabled && !this.stopped && this.tcl.connected && !this.timer && (!this.busy || deferred)) {
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
        if (this.samplingEnabled && !this.stopped && this.tcl.connected) this._scheduleNext(0);
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
        this._lastAdaptiveEvalAt = this.clock.monotonicMs();
        this._recentCycleTimestamps = [];
        this._samplingThroughput.reset();
        this._clearSamplingTimer();
        if (this.samplingEnabled && !this.stopped && this.tcl.connected) {
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
        const nextEnabled = !!enabled && !this.stopped && this.tcl.connected;
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
        this.samplingEnabled = !!enabled && !this.stopped && this.tcl.connected;
        this._clearSamplingTimer();
        if (this.samplingEnabled) {
            this._pauseReason = null;
            if (!this._resumeMeasured()) this._warmUp();
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
            if (enabled && this.mode === "debug" && !this.stopped && this.server.child) {
                this._reconnectDebugTcl();
            }
        }
        return this.samplingEnabled;
    }

    setPauseReason(reason) {
        this._pauseReason = reason || null;
        if (reason) {
            this._lastBackoffOrErrorAt = this.clock.monotonicMs();
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
            bytesPerSecond: this.samplingEnabled ? this._samplingThroughput.rate(this.clock.monotonicMs()) : 0,
            consumers,
            noEchoResponses: this.tcl.noEchoResponses,
            scatterReads: this.scatterReads,
            p95DurationMs: Number(p95.toFixed(2)),
            missedDeadlines: this._missedDeadlines,
            pauseReason: this._pauseReason
        };
    }

    _recordCycle(durationMs, success = true, timestamp = this.clock.now()) {
        const nowMonoMs = this.clock.monotonicMs();
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

    _evaluateAdaptiveSchedule(nowMonoMs = this.clock.monotonicMs()) {
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
        this._lastErrorAt = this.clock.now();
        this._successfulReads = 0;
        const duplicate =
            this._sampleErrorActive &&
            (this._lastReportedError === msg || this.clock.now() - this._lastErrorPostedAt < 2000);
        this._sampleErrorActive = true;
        if (duplicate) return;
        this._lastReportedError = msg;
        this._lastErrorPostedAt = this.clock.now();
        if (this.handlers.onError) this.handlers.onError(msg);
    }
    _handlePollingFailure(message) {
        if (this._pollFailureLocked) return;
        const now = this.clock.now();
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
        const launch = managedServerLaunch(this.options, this.mode, port, gdbPort);
        const targetCheck = targetCheckMonitor(this.options.targetCheck);
        this._status({ key: "lw.connecting" });
        this.server.start(launch, {
            port,
            executable: this.options.executable,
            onLine: (line) => this._handleServerLog(line, targetCheck),
            onError: (error) => this._abortConnection(error),
            onClose: (code) => this._handleServerClose(code, targetCheck, port)
        });

        // If the child process exits while start() runs, _abortConnection rejects this promise through _startReject and
        // the caller reports it once, so onDisconnect and start() do not both notify.
        try {
            this.tcl.hold();
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
                        if (!(await this.tcl.detectNoEcho(sock))) {
                            sock.destroy();
                            sock = await this._connectWithRetry(port, 1000);
                        }
                        if (this.stopped) throw this.connectionError || new Error("Stopped");
                        this.tcl.attach(sock);
                        this.tcl.release();
                        await this._detectScatter();
                        if (!this.tcl.socket && !this.stopped) {
                            // No-echo support belongs to the OpenOCD binary, so it survives this reconnect.
                            this.tcl.attach(await this._connectWithRetry(port, 1000));
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
            this.tcl.release();
            this._startReject = null;
        }
        this._startCompleted = true;
        let targetNames;
        if (this.options.serverGroup) {
            targetNames = String(await this.tcl.sendChecked("target names"))
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

    // What an OpenOCD log line means for the session: probe loss ends it, repeated polling failures lock it, and errors
    // are reported once. The no-echo probe's markers and target-check lines are not diagnostics.
    _handleServerLog(clean, targetCheck) {
        if (clean.startsWith("EP_OK:") || this.tcl.observeLog(clean)) return;
        if (targetCheck.line(clean)) {
            // A Worker forwards the observation to the extension host, which records it after success.
            if (targetCheck.observed && !targetCheck.mismatched)
                this.handlers.onTargetIdentity?.(this.options.targetCheck.checkId, targetCheck.observed);
            return;
        }
        // OpenOCD's own error output after a failed check repeats it; the close handler reports it once.
        if (targetCheck.mismatched) return;
        this.server.record(clean);
        // Probe unplugged while sampling: fatal signals such as USB read/write failures stop sampling
        // automatically instead of repeating errors
        if (isFatalProbeLog(clean)) {
            if (!this.stopped && !this.connectionFailed) {
                this._abortConnection(
                    Object.assign(
                        new Error("Debugger disconnected; live sampling stopped"),
                        diagnoseOpenOcdFailure(this.server.logTail, connectionDetails(this.options)),
                        {
                            i18nKey: "live.probeDisconnected"
                        }
                    )
                );
            }
            return;
        }
        if (this.connectionFailed) return;
        if (/\bPolling failed\b/i.test(clean)) {
            this._handlePollingFailure(clean);
            return;
        }
        // A GDB/telnet/Tcl client closing its socket (WSA 10054, connection reset) is not a target fault.
        // OpenOCD prints it via LOG_ERROR, so the line arrives as "Error: Error on socket 'GDB': ...".
        if (/^(?:Error\s*:\s*)?Error on socket '/i.test(clean)) return;
        // "Info : Unable to ..." may just be a normal hint such as a speed reduction; non-Info lines still
        // detect common connection failures.
        const isInfo = /\bInfo\s*:/i.test(clean);
        if (
            /\bError\s*:/i.test(clean) ||
            (!isInfo && /failed|unable to|no device found|libusb|in use|denied|timed out/i.test(clean))
        ) {
            this._error(clean.replace(/^.*?Error\s*:\s*/i, "") || clean);
        }
    }

    // OpenOCD exited. Unless the session was stopping, this is the one report of the failure: through start() while it
    // runs, otherwise onDisconnect.
    _handleServerClose(code, targetCheck, port) {
        const expected = this.stopped;
        this._clearSamplingTimer();
        this._releaseTimerResolution();
        this.tcl.close();
        this.stopped = true;
        if (expected) return;
        const diagnostic = diagnoseOpenOcdFailure(this.server.logTail, {
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
        this.tcl.rejectAll(error);
        if (this._startReject) {
            const reject = this._startReject;
            this._startReject = null;
            reject(error);
        } else if (this.handlers.onDisconnect) this.handlers.onDisconnect(error);
        else this._error(error.message);
    }

    // "exit" already proves the process released the probe; "close" can lag while stdio drains.
    waitForExit(timeoutMs = 1200) {
        return this.server.waitForExit(timeoutMs);
    }

    async _waitForTclListening(timeoutMs) {
        const deadline = this.clock.now() + timeoutMs;
        while (!this.server.listening) {
            if (this.stopped) throw this.connectionError || new Error("OpenOCD service exited before Tcl was ready");
            if (!this.server.child || this.clock.now() >= deadline) {
                const diagnostic = diagnoseOpenOcdFailure(this.server.logTail, {
                    ...connectionDetails(this.options),
                    port: clampInteger(this.options.port, 6666, 1, 65535)
                });
                throw Object.assign(new Error(diagnostic.message), diagnostic);
            }
            await new Promise((resolve) => this.clock.schedule(resolve, 20));
        }
    }

    _connectWithRetry(port, timeoutMs) {
        return new Promise((resolve, reject) => {
            const deadline = this.clock.now() + timeoutMs;
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
                    else if (this.clock.now() > deadline) {
                        const diagnostic = diagnoseOpenOcdFailure(this.server.logTail, {
                            ...connectionDetails(this.options),
                            port
                        });
                        reject(Object.assign(new Error(diagnostic.message), diagnostic));
                    } else this.clock.schedule(attempt, 200);
                };
                sock.once("connect", onConnect);
                sock.once("error", onInitialError);
            };
            attempt();
        });
    }

    _reconnectDebugTcl() {
        if (this._reconnectPromise || this.mode !== "debug" || this.stopped) return this._reconnectPromise;
        const delays = [250, 500, 1000];
        const port = clampInteger(this.options.port, 6666, 1, 65535);
        this._reconnectPromise = (async () => {
            for (const delayMs of delays) {
                await new Promise((resolve) => this.clock.schedule(resolve, delayMs));
                if (this.stopped || !this.server.child) return false;
                try {
                    const socket = await this._connectWithRetry(port, 400);
                    if (this.stopped || !this.server.child) {
                        try {
                            socket.destroy();
                        } catch {
                            /* ignore */
                        }
                        return false;
                    }
                    this.connectionFailed = false;
                    this.connectionError = null;
                    this.tcl.attach(socket);
                    await this._detectScatter();
                    if (!this.tcl.socket) continue;
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

    // Responses are an ID-less FIFO stream. After any request times out a late response cannot be attributed, so the
    // whole connection is discarded.
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
            this.server.child &&
            !this.stopped &&
            this._startCompleted &&
            err.i18nKey !== "live.probeDisconnected"
        ) {
            this.sampleEpoch++;
            this.samplingEnabled = false;
            this._clearSamplingTimer();
            this._releaseTimerResolution();
            this.tcl.rejectAll(err);
            this.tcl.close();
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
        this.tcl.rejectAll(err);
        this.tcl.close();
        if (this.connectingSocket && !this.connectingSocket.destroyed) {
            try {
                this.connectingSocket.destroy();
            } catch (e) {
                /* ignore */
            }
        }
        this.connectingSocket = null;
        this.server.kill();
        // While start() is still running, rejecting its promise is the only notification, so onDisconnect does not
        // report twice
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

    async _detectScatter() {
        this.scatterReads = false;
        this._scatterFailures = 0;
        try {
            this.scatterReads = (await this.tcl.probe("emberprobe_read_scatter version", 500)) === "1";
        } catch (error) {
            // Unsupported commands, malformed results and a bounded lost probe disable it. The patched
            // command also refuses before the target is examined, so ask once more after a good cycle.
            this._scatterRecheck = String(error?.message || "").startsWith("EMBERPROBE_SCATTER_UNSUPPORTED");
        }
    }

    // Chooses 32/16/8-bit transfers by address and length, then unpacks everything into little-endian bytes.
    async _readMemoryBytes(addr, count) {
        const hex = "0x" + (addr >>> 0).toString(16);
        const shape = transferShape(addr, count);
        const build = (cmd) => `${cmd} ${hex} ${shape.widthBits} ${shape.count}`;
        let resp;
        try {
            resp = await this.tcl.sendChecked(build(this.readCmd));
        } catch (error) {
            if (
                !this.altTried &&
                new RegExp(`(?:invalid command name|unknown command)\\s+["']?${this.readCmd}(?:["'\\s]|$)`, "i").test(
                    error.message
                )
            ) {
                this.altTried = true;
                this.readCmd = this.readCmd === "ocd_read_memory" ? "read_memory" : "ocd_read_memory";
                resp = await this.tcl.sendChecked(build(this.readCmd));
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
        if (Number.isFinite(guard.deadline) && this.clock.now() >= guard.deadline) {
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
            resp = await this.tcl.sendChecked(cmd);
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
                resp = await this.tcl.sendChecked(retryCmd);
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
            const response = await this.tcl.sendChecked(`emberprobe_read_scatter ${args.join(" ")}`);
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
                  deadline: guard?.deadline || this.clock.now() + MAX_DEBUG_CYCLE_MS
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

    // Reads a set of variables once over the existing Tcl connection without changing the UI watch list or sampling
    // timer.
    async readOnce(items, timeoutMs = 2500) {
        if (!Array.isArray(items) || !items.length) return [];
        if (this.mode === "debug") validateManagedReadPlan(items);
        if (this.stopped || !this.tcl.connected) throw new Error("OpenOCD Tcl service is not connected");
        const requestEpoch = this.targetEpoch;
        const deadline = this.clock.now() + timeoutMs;
        await this._acquireExclusive(deadline);
        try {
            if (this.stopped || !this.tcl.connected) throw new Error("OpenOCD Tcl service is not connected");
            const guard =
                this.mode === "debug"
                    ? {
                          targetEpoch: requestEpoch,
                          requireSampling: false,
                          deadline: Math.min(deadline, this.clock.now() + MAX_DEBUG_CYCLE_MS)
                      }
                    : null;
            return (await this._readItems(items, this.clock.now(), guard)).samples;
        } finally {
            this._releaseExclusive();
        }
    }

    peripheralTransaction(request, timeoutMs = 5000) {
        return peripheralTransaction(this, request, timeoutMs);
    }

    async _waitUntilIdle(timeoutMs) {
        await this._acquireExclusive(this.clock.now() + timeoutMs);
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

    // When every write is an aligned single word the run state is neither queried nor changed; other transactions halt,
    // read-modify-write, verify and resume.
    async writeAndVerify(items, timeoutMs = 5000) {
        if (!Array.isArray(items) || !items.length) return { before: [], after: [], halted: false };
        const nonHalting = items.every(isNonHaltingWordWrite);
        if (this.mode === "debug") validateManagedWritePlan(items);
        if (this.stopped || !this.tcl.connected) throw new Error("OpenOCD Tcl service is not connected");
        const requestEpoch = this.targetEpoch;
        const deadline = this.clock.now() + timeoutMs;
        await this._acquireExclusive(deadline);
        try {
            // Ownership is reserved synchronously by the arbiter before connection checks.
            if (this.stopped || !this.tcl.connected) throw new Error("OpenOCD Tcl service is not connected");
            return await this.writer.withHalt(nonHalting, async () => {
                const guard =
                    this.mode === "debug"
                        ? {
                              targetEpoch: requestEpoch,
                              requireSampling: false,
                              deadline: Math.min(deadline, this.clock.now() + MAX_DEBUG_CYCLE_MS)
                          }
                        : null;
                const readItems = items.map((item) => ({
                    name: item.name,
                    address: item.address,
                    size: item.bytes.length
                }));
                let writtenItems = 0;
                try {
                    const before = (await this._readItems(readItems, this.clock.now(), guard)).samples;
                    for (const item of items) {
                        this._assertReadGuard(guard);
                        await this.writer.writeBytes(item.address, item.bytes);
                        writtenItems++;
                    }
                    this._assertReadGuard(guard);
                    const after = (await this._readItems(readItems, this.clock.now(), guard)).samples;
                    this._assertReadGuard(guard);
                    return { before, after, halted: !nonHalting };
                } catch (error) {
                    // Callers must know whether a cancelled transaction already changed target memory.
                    if (error?.code === "LIVE_READ_CANCELLED")
                        error.details = { ...error.details, writtenItems, totalItems: items.length };
                    throw error;
                }
            });
        } finally {
            this._releaseExclusive();
        }
    }

    async _sampleTick(fromScheduler = false) {
        if (this.tcl.held || this.tcl.probing) return;
        if (!this.samplingEnabled || this.stopped || this._hostHold || !this.tcl.connected) return;
        if (!this.watch.length) return;
        if (!this._tryAcquireExclusive()) {
            // A read/write transaction owns the Tcl connection. The tick runs at its release: dropping it would
            // freeze the watch list, and waiting a whole interval lets frequent peripheral reads starve sampling.
            if (fromScheduler) this._samplingTickDeferred = true;
            return;
        }
        const epoch = this.sampleEpoch;
        const startMs = this.clock.monotonicMs();
        const targetEpoch = this.targetEpoch;
        const readBytesBefore = this._memoryReadBytes;
        const startedAt = this.clock.now();
        const deadline = startedAt + MAX_DEBUG_CYCLE_MS;
        const cycleStart = this.clock.sampleNow();
        let readSuccess = false;
        try {
            const due = this.ratePlan?.due(startMs, this.effectiveIntervalMs);
            const items = due ? due.items : this.watch;
            const guard = this.mode === "debug" ? { epoch, requireSampling: true, deadline } : null;
            const { samples, ok } = items.length
                ? await this._readItems(items, cycleStart, guard)
                : { samples: [], ok: 0 };
            if (epoch !== this.sampleEpoch || !this.samplingEnabled) return;
            // One sub-millisecond stamp per cycle, centred on its reads, keeps every cycle a single archive/CSV row.
            const t = (cycleStart + this.clock.sampleNow()) / 2;
            for (const sample of samples) sample.t = t;
            const delivered = due ? this.ratePlan.deliver(samples, t, due) : samples;
            if (this.handlers.onSample) this.handlers.onSample(delivered, t, due);
            if (ok === items.length) {
                readSuccess = true;
                if (this._scatterRecheck) {
                    this._scatterRecheck = false;
                    try {
                        this.scatterReads = (await this.tcl.sendChecked("emberprobe_read_scatter version")) === "1";
                    } catch {
                        // Still unsupported (for example an HLA target): keep the batch path.
                    }
                }
                if (this._sampleErrorActive) {
                    // One successful memory read does not prove target polling recovered.
                    this._successfulReads++;
                    if (this._successfulReads >= 3 && this.clock.now() - this._lastErrorAt >= 2000) {
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
            const durationMs = this.clock.monotonicMs() - startMs;
            if (epoch === this.sampleEpoch && targetEpoch === this.targetEpoch && this.samplingEnabled)
                this._samplingThroughput.record(this._memoryReadBytes - readBytesBefore, startMs, startMs + durationMs);
            if (epoch === this.sampleEpoch) this._recordCycle(durationMs, readSuccess, startedAt);
            if (fromScheduler && epoch === this.sampleEpoch && this.samplingEnabled && !this.stopped) {
                const nextDelay = this.ratePlan
                    ? this.ratePlan.delay(this.clock.monotonicMs())
                    : Math.max(0, Math.round(this.effectiveIntervalMs - durationMs));
                this._scheduleNext(nextDelay);
            }
        }
    }

    stop(timeoutMs = 1200) {
        if (this._stopPromise) return this._stopPromise;
        const child = this.server.child;
        const socket = this.tcl.socket;
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
        this.tcl.rejectAll(stoppedError);
        if (this.connectingSocket && !this.connectingSocket.destroyed) {
            try {
                this.connectingSocket.destroy();
            } catch (e) {
                /* ignore */
            }
        }
        this.connectingSocket = null;
        const sendShutdown = this.tcl.shutdown();
        this._stopPromise = (async () => {
            const closed = await this.server.terminate(child, await sendShutdown, childExited);
            this.tcl.close(socket);
            await this.tcl.removeResponseFile();
            if (!closed) this._stopPromise = null;
            return closed;
        })();
        return this._stopPromise;
    }
}

module.exports = { ManagedOpenOcdSession, findFreePort };
