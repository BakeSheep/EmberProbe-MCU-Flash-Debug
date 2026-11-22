"use strict";
// Manages a single OpenOCD server: standalone mode opens only Tcl, debug mode also opens GDB. Tcl-RPC samples RAM and
// allows word writes without halting. An independent implementation inspired by MCUViewer (GPLv3) concepts, using none
// of its code.
const net = require("net");
const { isDeepStrictEqual } = require("util");
const { isSafeCfg, diagnoseOpenOcdFailure } = require("./openocdRunner");
const { clampInteger } = require("./validation");
const { clampSamplingIntervalMs } = require("./samplingFrequency");
const {
    SYSTEM_CLOCK,
    adaptiveReadCost,
    intervalForReadCost,
    nextDebugSamplingInterval,
    nextStandaloneSamplingInterval,
    p95SamplingDuration,
    scheduleSamplingTick
} = require("./samplingClock");
const { SamplingThroughput } = require("./samplingThroughput");
const { sampleTick } = require("./samplingCycle");
const { SamplingSpeedTuner } = require("./samplingSpeed");
const { TclTransport } = require("./tclTransport");
const { windowsTimerResolution } = require("./windowsTimerResolution");
const { connectionDetails } = require("../skills/_emberprobe/openocd-diagnostics");
const { RuntimeObjectReader, RUNTIME_CYCLE_BYTES, RUNTIME_CYCLE_READS } = require("./services/runtimeObjectReader");
const { MultiRatePlan, SIDEBAR_INTERVAL_MS } = require("./services/multiRatePlan");
const { targetCheckMonitor } = require("./chip/targetIdentity");
const { OpenOcdProcess, managedServerLaunch, isFatalProbeLog, isTransportProbeFailure } = require("./openocdProcess");
const {
    MemoryWriter,
    validateManagedWritePlan,
    peripheralTransaction,
    variableWriteTransaction
} = require("./memoryWrite");
const { rttControl } = require("./rttControl");
const { isNonHaltingWordWrite, assertSidebarWriteCurrent } = require("./writeAccess");
const { validateWritePreconditions } = require("./writePreconditions");
const {
    MAX_DEBUG_CYCLE_MS,
    normalizeRamSectionRanges,
    parseMemoryElements,
    transferShape,
    elementsToBytes,
    sameConsumerItems,
    validateManagedReadPlan,
    compileReadBatches
} = require("./liveWatchReadPlan");

const MAX_SCATTER_SEGMENTS = 64;
const MAX_SCATTER_BYTES = 4096;
const MAX_SCATTER_READ_GAP_BYTES = 4;
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
        this._starting = false;
        this._startCompleted = false;
        this.scatterReads = false;
        this._scatterFailures = 0;
        this.ramSectionRanges = [];
        this.targetIntervalMs = clampSamplingIntervalMs(this.options.intervalMs, 100);
        this.effectiveIntervalMs = Math.max(100, this.targetIntervalMs);
        this._recentDurations = [];
        this._consecutiveSuccesses = 0;
        this._warmingUp = true;
        this._adaptiveDirection = 0;
        this._adaptiveMeasurements = 0;
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
        this._speedTuner = new SamplingSpeedTuner({ options: this.options, mode: this.mode, clock: this.clock });
        this._timerResolutionHeld = false;
    }

    get unlimitedActive() {
        return this.unlimited && this.mode !== "debug" && !!this.ratePlan?.graphItems.length;
    }

    get primarySamplingItems() {
        return this.ratePlan?.graphPriority ? this.ratePlan.graphReadItems : this.watch;
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

    _warmUp(frameDurationMs = null, retimePlan = true) {
        this._samplingThroughput.reset();
        const interval = this.unlimitedActive
            ? 0
            : frameDurationMs === null
              ? Math.max(100, this.targetIntervalMs)
              : intervalForReadCost(this.targetIntervalMs, frameDurationMs);
        if (retimePlan) this.ratePlan?.retime(this.effectiveIntervalMs, interval);
        else if (this.ratePlan?.graphPriority && interval !== this.effectiveIntervalMs)
            this.ratePlan.resetGraphDeadline(this.ratePlan.nextGraph);
        if (this.ratePlan) {
            this.ratePlan.sidebarDurations = [];
            this.ratePlan.mergedDurations = [];
            this.ratePlan.graphDurations = [];
        }
        this.effectiveIntervalMs = interval;
        this._recentDurations = [];
        this._consecutiveSuccesses = 0;
        this._warmingUp = !this.unlimitedActive && frameDurationMs === null;
        this._adaptiveDirection = 0;
        this._adaptiveMeasurements = 0;
        const nowMonoMs = this.clock.monotonicMs();
        this._lastAdaptiveEvalAt = nowMonoMs;
        this._lastBackoffOrErrorAt = this.mode === "debug" ? nowMonoMs : -Infinity;
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
        this._adaptiveDirection = 0;
        this._adaptiveMeasurements = 0;
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
        if (this.tcl.held || this._starting) return;
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
            { highResolution: this._timerResolutionHeld, immediate: this.unlimitedActive, clock: this.clock }
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
            const interval = clampSamplingIntervalMs(ms, 1000 / 30);
            const changed = interval !== this.ratePlan.graphIntervalMs;
            if (changed) {
                this.ratePlan.graphIntervalMs = interval;
                this.ratePlan.resetGraphDeadline();
                if (!this.unlimitedActive) this.ratePlan.graphTicks = [];
            }
            return this._setClockInterval(
                this.ratePlan.requestedIntervalMs === Infinity
                    ? SIDEBAR_INTERVAL_MS
                    : this.ratePlan.requestedIntervalMs,
                changed && !this.unlimitedActive && this.ratePlan.graphItems.length > 0
            );
        }
        return this._setClockInterval(ms);
    }

    setSamplingPlan(plan) {
        const ramSectionRanges = normalizeRamSectionRanges(plan.ramSectionRanges);
        const ratePlan = new MultiRatePlan({
            ...plan,
            graphIntervalMs: clampSamplingIntervalMs(plan.graphIntervalMs, 1000 / 30),
            unlimited: plan.unlimited === true && this.mode !== "debug",
            prioritizeGraph: this.mode === "standalone"
        });
        const previous = this.ratePlan;
        const sameRanges = previous && isDeepStrictEqual(this.ramSectionRanges, ramSectionRanges);
        const sameConsumers =
            sameRanges &&
            sameConsumerItems(previous.graphItems, ratePlan.graphItems) &&
            sameConsumerItems(previous.sidebarItems, ratePlan.sidebarItems);
        if (sameConsumers) {
            if (this.unlimited === (plan.unlimited === true)) return this.setIntervalMs(ratePlan.graphIntervalMs);
            previous.graphIntervalMs = ratePlan.graphIntervalMs;
            previous.unlimited = ratePlan.unlimited;
            previous.resetGraphDeadline();
            previous.graphTicks = [];
            this.unlimited = plan.unlimited === true;
            this._resetHostHold();
            this._setClockInterval(
                previous.requestedIntervalMs === Infinity ? SIDEBAR_INTERVAL_MS : previous.requestedIntervalMs,
                true
            );
            return;
        }
        this.sampleEpoch++;
        if (
            sameRanges &&
            previous.graphPriority &&
            ratePlan.graphPriority &&
            previous.graphIntervalMs === ratePlan.graphIntervalMs &&
            sameConsumerItems(previous.graphReadItems, ratePlan.graphReadItems)
        ) {
            // A sidebar edit invalidates old batches without restarting an identical waveform timer or clock probe.
            ratePlan.preserveGraph(previous);
            this.ratePlan = ratePlan;
            this.watch = ratePlan.items;
            this._scheduleNext(0);
            return;
        }
        this.setWatch(ratePlan.items, ramSectionRanges);
        this.ratePlan = ratePlan;
        this.unlimited = plan.unlimited === true;
        this._setClockInterval(
            ratePlan.requestedIntervalMs === Infinity ? SIDEBAR_INTERVAL_MS : ratePlan.requestedIntervalMs
        );
        this._warmUp();
        this._clearSamplingTimer();
        if (this.samplingEnabled && !this.stopped && this.tcl.connected) this._scheduleNext(0);
    }

    _setClockInterval(ms, force = false) {
        const interval = clampSamplingIntervalMs(ms, 100);
        if (interval === this.targetIntervalMs && !force) return;
        this.sampleEpoch++;
        this.options.intervalMs = interval;
        this.targetIntervalMs = interval;
        const { duration, threshold } = adaptiveReadCost(this.mode, this._recentDurations);
        this.effectiveIntervalMs = this.unlimitedActive
            ? 0
            : this._recentDurations.length >= 4
              ? intervalForReadCost(interval, duration, threshold)
              : Math.max(100, interval);
        this._warmingUp = !this.unlimitedActive && this._recentDurations.length < 4;
        this._consecutiveSuccesses = 0;
        this._adaptiveDirection = 0;
        this._adaptiveMeasurements = 0;
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
                this.ratePlan.resetGraphDeadline();
                this.ratePlan.nextSidebar = this.ratePlan.nextSidebarShared = 0;
                this.ratePlan.latest.clear();
                this.ratePlan.sidebarPublished.clear();
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
        const p95 = p95SamplingDuration(this._recentDurations);
        const consumers = this.ratePlan?.stats(this.clock.monotonicMs(), this.effectiveIntervalMs);
        if (consumers && !this.samplingEnabled) consumers.graphHz = consumers.sidebarHz = 0;
        const actualHz = consumers
            ? this.ratePlan.graphItems.length
                ? consumers.graphHz
                : consumers.sidebarHz
            : this._computeActualHz();
        return {
            unlimited: this.unlimited,
            unlimitedActive: this.unlimitedActive,
            unlimitedSuppressedReason: this.unlimited && this.mode === "debug" ? "debug" : null,
            ...this._hostHoldStats(),
            targetIntervalMs: this.targetIntervalMs,
            effectiveIntervalMs: this.effectiveIntervalMs,
            actualHz: this.samplingEnabled ? actualHz : 0,
            bytesPerSecond: this.samplingEnabled ? this._samplingThroughput.rate(this.clock.monotonicMs()) : 0,
            consumers,
            noEchoResponses: this.tcl.noEchoResponses,
            scatterReads: this.scatterReads,
            p95DurationMs: Number(p95.toFixed(2)),
            missedDeadlines: this._missedDeadlines,
            pauseReason: this._pauseReason,
            ...this._speedTuner.stats()
        };
    }

    async _ensureTclConnected(timeoutMs = 1000) {
        if (this.tcl.connected || this.stopped || this.connectionFailed) return;
        const sock = await this._connectWithRetry(clampInteger(this.options.port, 6666, 1, 65535), timeoutMs);
        if (this.stopped || this.connectionFailed) {
            sock.destroy();
            return;
        }
        this.tcl.attach(sock);
    }

    _recordCycle(durationMs, success = true, timestamp = this.clock.now()) {
        const nowMonoMs = this.clock.monotonicMs();
        if (success) this._recentCycleTimestamps.push(timestamp);
        while (
            this._recentCycleTimestamps.length > 2 &&
            (this._recentCycleTimestamps.length > 256 || this._recentCycleTimestamps[0] < timestamp - 1500)
        ) {
            this._recentCycleTimestamps.shift();
        }
        this._recentDurations.push(durationMs);
        if (this._recentDurations.length > 32) this._recentDurations.shift();

        if (!this.unlimitedActive && !this.ratePlan?.graphPriority && durationMs > this.effectiveIntervalMs) {
            this._missedDeadlines++;
        }

        if (success) {
            this._consecutiveSuccesses++;
            this._adaptiveMeasurements++;
        } else {
            this._consecutiveSuccesses = 0;
            this._lastBackoffOrErrorAt = nowMonoMs;
        }

        const evaluate =
            this.mode === "debug"
                ? nowMonoMs - this._lastAdaptiveEvalAt >= 1000
                : this._adaptiveMeasurements >= 4 && nowMonoMs - this._lastAdaptiveEvalAt >= 500;
        if ((this._warmingUp && this._consecutiveSuccesses >= 4) || evaluate) {
            this._evaluateAdaptiveSchedule(nowMonoMs);
            this._lastAdaptiveEvalAt = nowMonoMs;
            this._adaptiveMeasurements = 0;
        }
    }

    _evaluateAdaptiveSchedule(nowMonoMs = this.clock.monotonicMs()) {
        if (this.unlimitedActive || this._recentDurations.length < 4) return;
        const { duration, threshold } = adaptiveReadCost(this.mode, this._recentDurations);
        const current = this.effectiveIntervalMs;
        const target = this.targetIntervalMs;
        const successes = this._consecutiveSuccesses;
        const stableForMs = nowMonoMs - this._lastBackoffOrErrorAt;
        const calibrated = this._warmingUp && successes >= 4;
        const required = intervalForReadCost(target, duration, threshold);
        const next = calibrated
            ? required
            : this.mode === "debug"
              ? nextDebugSamplingInterval(current, target, required, successes, stableForMs)
              : nextStandaloneSamplingInterval(
                    current,
                    target,
                    this._recentDurations,
                    required,
                    successes,
                    stableForMs
                );
        if (!calibrated && this.mode === "standalone") {
            const direction = Math.abs(next - current) > 1e-6 ? Math.sign(next - current) : 0;
            const stable = direction !== 0 && direction === this._adaptiveDirection;
            this._adaptiveDirection = direction;
            if (!stable) return;
        }
        if (calibrated) this._warmingUp = false;
        if (!calibrated && current === next) return;
        if (this.mode === "debug" && next > current) this._lastBackoffOrErrorAt = nowMonoMs;
        this.effectiveIntervalMs = next;
        this.ratePlan?.retime(current, next);
        this._consecutiveSuccesses = 0;
        this._adaptiveDirection = 0;
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
        if (this._pollFailureCount === 2 && this._speedTuner.canStepDown()) this._speedTuner.requestStepDown();
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
        this.targetIntervalMs = clampSamplingIntervalMs(this.options.intervalMs, 100);
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
        this._starting = true;
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
                            sock.destroy();
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
                        await this._ensureTclConnected();
                        const frameDurationMs = this._speedTuner.shouldTuneAtStart(this.watch)
                            ? await this._speedTuner.tune(this)
                            : null;
                        if (this.stopped) throw this.connectionError || new Error("Stopped");
                        this._starting = false;
                        this._startCompleted = true;
                        this._status({ key: "lw.connected" });
                        if (this._samplingRequested) {
                            this.samplingEnabled = true;
                            this._pauseReason = null;
                            this._warmUp(frameDurationMs);
                            this._scheduleNext(0);
                        }
                        resolve(undefined);
                    })
                    .catch(reject);
            });
        } finally {
            this._starting = false;
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
        this._speedTuner.observeLog(clean);
        if (!isTransportProbeFailure(clean) && this._speedTuner.handleTentativeLog(clean)) return;
        // End the session on a confirmed probe transport failure before issuing another read.
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
            const deadline = this.clock.monotonicMs() + timeoutMs;
            const rejectTimeout = () => {
                const diagnostic = diagnoseOpenOcdFailure(this.server.logTail, {
                    ...connectionDetails(this.options),
                    port
                });
                reject(Object.assign(new Error(diagnostic.message), diagnostic));
            };
            const attempt = () => {
                if (this.stopped) return reject(this.connectionError || new Error("Stopped"));
                const remainingMs = deadline - this.clock.monotonicMs();
                if (remainingMs <= 0) return rejectTimeout();
                const sock = net.connect({ host: "127.0.0.1", port });
                this.connectingSocket = sock;
                const onConnect = () => {
                    cleanup();
                    if (this.stopped || this.clock.monotonicMs() >= deadline) {
                        sock.destroy();
                        return this.stopped ? reject(this.connectionError || new Error("Stopped")) : rejectTimeout();
                    }
                    resolve(sock);
                };
                const onInitialError = () => {
                    cleanup();
                    sock.destroy();
                    if (this.stopped) reject(this.connectionError || new Error("Stopped"));
                    else this.clock.schedule(attempt, Math.max(0, Math.min(200, deadline - this.clock.monotonicMs())));
                };
                const timer = this.clock.schedule(() => {
                    cleanup();
                    sock.destroy();
                    rejectTimeout();
                }, remainingMs);
                const cleanup = () => {
                    this.clock.cancel(timer);
                    sock.removeListener("connect", onConnect);
                    sock.removeListener("error", onInitialError);
                    sock.removeListener("close", onInitialError);
                    if (this.connectingSocket === sock) this.connectingSocket = null;
                };
                sock.once("connect", onConnect);
                sock.once("error", onInitialError);
                sock.once("close", onInitialError);
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
                        socket.destroy();
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
        Object.assign(err, {
            details: {
                ...error?.details,
                mode: this.mode,
                scatterReads: this.scatterReads,
                noEchoResponses: this.tcl.noEchoResponses,
                readCommand: this.readCmd,
                openocdTail: this.server.logTail.slice(-20).map((line) => line.slice(0, 512))
            }
        });
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
            this.connectingSocket?.destroy();
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
        this.connectingSocket?.destroy();
        this.connectingSocket = null;
        this.server.kill();
        // While start() is still running, rejecting its promise is the only notification, so onDisconnect does not
        // report twice
        if (this._startReject) {
            const reject = this._startReject;
            this._startReject = null;
            reject(err);
        } else if (this.handlers.onDisconnect) this.handlers.onDisconnect(err);
        else this._error(err.message);
    }

    async _detectScatter() {
        this.scatterReads = false;
        this._scatterFailures = 0;
        // Internal diagnostic override: compare ordinary reads without changing link speed or retrying a failed RPC.
        if (this.options.scatterReads === false) return;
        try {
            this.scatterReads = (await this.tcl.probe("emberprobe_read_scatter version", 500)) === "1";
        } catch (error) {
            // Unsupported commands, malformed results and a bounded lost probe disable it. The patched
            // command also refuses before the target is examined, so ask once more after a good cycle.
            this._scatterRecheck = String(error?.message || "").startsWith("EMBERPROBE_SCATTER_UNSUPPORTED");
        }
    }

    _sendReadCommand(cmd, guard) {
        return guard?.probe ? guard.probe(cmd) : this.tcl.sendChecked(cmd);
    }

    // Chooses 32/16/8-bit transfers by address and length, then unpacks everything into little-endian bytes.
    async _readMemoryBytes(addr, count, guard = null) {
        const hex = "0x" + (addr >>> 0).toString(16);
        const shape = transferShape(addr, count);
        const build = (cmd) => `${cmd} ${hex} ${shape.widthBits} ${shape.count}`;
        let resp;
        try {
            resp = await this._sendReadCommand(build(this.readCmd), guard);
        } catch (error) {
            if (
                !this.altTried &&
                new RegExp(`(?:invalid command name|unknown command)\\s+["']?${this.readCmd}(?:["'\\s]|$)`, "i").test(
                    error.message
                )
            ) {
                this.altTried = true;
                this.readCmd = this.readCmd === "ocd_read_memory" ? "read_memory" : "ocd_read_memory";
                resp = await this._sendReadCommand(build(this.readCmd), guard);
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

    async _readBatchBytes(batch, guard = null) {
        if (batch.length === 1) {
            const g = batch[0];
            const bytes = await this._readMemoryBytes(g.start, g.byteCount, guard);
            return [bytes];
        }
        const calls = batch.map((g) => {
            const hex = "0x" + (g.start >>> 0).toString(16);
            return `[${this.readCmd} ${hex} ${g.shape.widthBits} ${g.shape.count}]`;
        });
        const cmd = `join [list ${calls.join(" ")}] "\\n"`;
        let resp;
        try {
            resp = await this._sendReadCommand(cmd, guard);
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
                resp = await this._sendReadCommand(retryCmd, guard);
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

    _getReadBatches(items, reservedBytes = 0, scatterReads = this.scatterReads, reservedCommands = 0) {
        // Multi-rate ticks allocate new arrays but retain the ordered watch-item identities.
        const cached = this._readBatchCache.find(
            (entry) =>
                entry.ranges === this.ramSectionRanges &&
                entry.scatterReads === scatterReads &&
                entry.mode === this.mode &&
                entry.reservedBytes === reservedBytes &&
                entry.reservedCommands === reservedCommands &&
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
        // Scatter queues separate ranges in one DAP run. Limit gap expansion to one RAM word;
        // larger gaps add transfers without saving an RPC. Ordinary reads retain their broader heuristic.
        const batches = compileReadBatches(
            items,
            this.ramSectionRanges,
            this.mode === "debug",
            reservedBytes,
            scatterReads ? MAX_SCATTER_READ_GAP_BYTES : undefined,
            reservedCommands
        );
        if (this._readBatchCache.length >= MAX_READ_BATCH_CACHE_ENTRIES) this._readBatchCache.shift();
        this._readBatchCache.push({
            ranges: this.ramSectionRanges,
            scatterReads,
            mode: this.mode,
            reservedBytes,
            reservedCommands,
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
            const response = await this._sendReadCommand(`emberprobe_read_scatter ${args.join(" ")}`, guard);
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
            [
                "PROBE_COMMUNICATION_FAILED",
                "OPENOCD_RPC_TIMEOUT",
                "ECONNRESET",
                "ECONNABORTED",
                "EPIPE",
                "ENOTCONN",
                "ETIMEDOUT"
            ].includes(error.code) ||
            /^(?:Socket is not connected|Tcl connection closed)/.test(error.message)
        );
    }

    _handleScatterFailure(error, guard) {
        // The native DAP failure reply can reach Tcl before the corresponding stderr line. End
        // this read without another transfer. A definite transport log separately ends the session.
        if (
            guard?.probe ||
            this._isConnectionError(error) ||
            (error.code === "OPENOCD_TCL_ERROR" && /^scatter memory read failed \(-?\d+\)$/.test(error.message.trim()))
        ) {
            throw error;
        }
        this._assertReadGuard(guard);
        if (error.message.startsWith("EMBERPROBE_SCATTER_UNSUPPORTED") || ++this._scatterFailures >= 3)
            this.scatterReads = false;
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
            this._handleScatterFailure(error, guard);
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
                try {
                    const blocks = await this._scatterRanges(plan, guard);
                    if (blocks)
                        prefetched = plan.map((read, index) => ({ address: read.address, bytes: blocks[index] }));
                } catch (error) {
                    this._runtimePlans.delete(item);
                    throw error;
                }
            }
        }
        const reader = new RuntimeObjectReader(
            item,
            (address, size) => this._readMemoryBytes(address, size, guard),
            () => this._assertReadGuard(guard),
            budget,
            {
                clock: this.clock,
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
        const plannedScatter = this.scatterReads;
        const reservedBytes = runtimeItems.reduce((sum, item) => sum + item.size, 0);
        let batches = this._getReadBatches(fixedItems, reservedBytes, plannedScatter);
        // Debug mode bounds the whole cycle, so fixed reads are reserved first. Standalone fixed reads
        // have no per-cycle budget and must not consume the runtime objects' own one.
        const shared = this.mode === "debug";
        const fixedUnits = shared && runtimeItems.length ? batches.flat() : [];
        const fixedBytes = fixedUnits.length
            ? Math.max(
                  fixedUnits.reduce((total, unit) => total + unit.byteCount, 0),
                  fixedItems.reduce((total, entry) => total + entry.size, 0)
              )
            : 0;
        const runtimeBudget = runtimeItems.length
            ? {
                  bytes: fixedBytes,
                  commands: fixedUnits.length,
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
                this._handleScatterFailure(error, guard);
                scatterFailed = true;
            }
        }
        if (plannedScatter && !scatterBytes) {
            const usedRuntime = shared ? runtimeBudget : null;
            batches = this._getReadBatches(
                fixedItems,
                usedRuntime ? Math.max(reservedBytes, usedRuntime.bytes - fixedBytes) : reservedBytes,
                false,
                usedRuntime ? usedRuntime.commands - fixedUnits.length : 0
            );
        }
        for (const batch of batches) {
            this._assertReadGuard(guard);
            let batchBytes = scatterBytes ? batch.map((unit) => scatterBytes.get(unit)) : null;
            if (!batchBytes && !this._batchUnsupported) {
                try {
                    batchBytes = await this._readBatchBytes(batch, guard);
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
                        bytes = await this._readMemoryBytes(g.start, g.byteCount, guard);
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
        if (ok && !guard?.probe && !this.stopped && !this._connectionConfirmed) {
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

    rttControl(request, timeoutMs = 5000) {
        return rttControl(this, request, timeoutMs);
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
    async writeAndVerify(items, timeoutMs = 5000, preconditions = [], expectedTargetEpoch, sidebarGuard) {
        if (!Array.isArray(items) || !items.length) return { before: [], after: [], halted: false };
        validateWritePreconditions(preconditions, items);
        const requestEpoch = expectedTargetEpoch ?? this.targetEpoch;
        if (requestEpoch !== this.targetEpoch)
            throw Object.assign(new Error("Dynamic write plan belongs to an old target generation"), {
                code: "WRITE_TARGET_CHANGED",
                retryable: false,
                details: { written: false, writtenItems: 0, resultUnknown: false }
            });
        const nonHalting = items.every(isNonHaltingWordWrite);
        if (this.mode === "debug") validateManagedWritePlan(items);
        if (this.stopped || !this.tcl.connected) throw new Error("OpenOCD Tcl service is not connected");
        const deadline = this.clock.now() + timeoutMs;
        await this._acquireExclusive(deadline);
        try {
            assertSidebarWriteCurrent(sidebarGuard);
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
                return variableWriteTransaction(this, items, {
                    preconditions,
                    requestEpoch,
                    deadline,
                    guard,
                    nonHalting,
                    sidebarGuard
                });
            });
        } finally {
            this._releaseExclusive();
        }
    }

    _sampleTick(fromScheduler = false) {
        return sampleTick(this, fromScheduler);
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
        this.connectingSocket?.destroy();
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
