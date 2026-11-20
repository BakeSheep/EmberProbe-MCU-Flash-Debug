"use strict";
const { performance } = require("perf_hooks");

const WINDOWS_TIMER_GRID_MS = 15.6;
const WINDOWS_ACTIVE_WAIT_MS = 12;
const HIGH_RESOLUTION_LEAD_MS = 1.5;
const STANDALONE_READ_BUDGET_RATIO = 0.85;

function intervalForReadCost(target, duration, threshold = STANDALONE_READ_BUDGET_RATIO) {
    return Math.min(10000, Math.max(target, Math.ceil(duration / threshold)));
}

function p95SamplingDuration(durations) {
    if (!durations.length) return 0;
    const sorted = durations.slice().sort((a, b) => a - b);
    return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

function adaptiveReadCost(mode, durations) {
    return mode === "debug"
        ? { duration: p95SamplingDuration(durations), threshold: 0.4 }
        : {
              duration: durations.reduce((sum, value) => sum + value, 0) / (durations.length || 1),
              threshold: STANDALONE_READ_BUDGET_RATIO
          };
}

function nextDebugSamplingInterval(current, target, required, successes, stableForMs) {
    if (required > current) return Math.min(10000, Math.max(current + 5, required, Math.round(current * 1.25)));
    if (successes < 32 || stableForMs < 2000 || current <= target) return current;
    const recovered = Math.max(target, Math.round(current * 0.85));
    return required <= recovered ? recovered : current;
}

function nextStandaloneSamplingInterval(current, target, durations, required, successes, stableForMs) {
    // A full window of successful reads can absorb one isolated latency spike.
    if (durations.length === 32 && successes >= durations.length) {
        const total = durations.reduce((sum, duration) => sum + duration, 0);
        const duration = (total - Math.max(...durations)) / (durations.length - 1);
        required = intervalForReadCost(target, duration);
    }
    return required >= current || (successes >= 4 && stableForMs >= 2000) ? required : current;
}

// Wall time (deadlines, error throttling, cycle timestamps), monotonic milliseconds (cycle durations, adaptive
// interval, rate windows), sub-millisecond sample stamps, and the timers behind every wait. An OpenOCD session's
// `options.clock` replaces any member, so tests drive time without patching globals.
const SYSTEM_CLOCK = Object.freeze({
    now: () => Date.now(),
    monotonicMs: () => Number(process.hrtime.bigint()) / 1e6,
    sampleNow: () => performance.timeOrigin + performance.now(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (timer) => clearTimeout(timer)
});

// For short waits on Windows, yield with setImmediate so a late timer wake-up cannot skip a 5 ms period.
// For longer waits without a fine timer, wake one coarse tick early. The Worker stays responsive to pause/stop.
function scheduleSamplingTick(delayMs, callback, options = {}) {
    if (options.immediate === true) {
        const handle = setImmediate(callback);
        return { cancel: () => clearImmediate(handle) };
    }
    const platform = options.platform || process.platform;
    const highResolution = options.highResolution === true;
    if (platform !== "win32") {
        const handle = setTimeout(callback, Math.max(0, delayMs));
        return { cancel: () => clearTimeout(handle) };
    }
    const nowNs = options.nowNs || (() => process.hrtime.bigint());
    const deadlineNs = nowNs() + BigInt(Math.round(Math.max(0, delayMs) * 1e6));
    let handle = null;
    let kind = null;
    let cancelled = false;

    const arm = () => {
        if (cancelled) return;
        const remainingMs = Number(deadlineNs - nowNs()) / 1e6;
        if (remainingMs <= 0) {
            handle = setImmediate(() => {
                if (!cancelled) callback();
            });
            kind = "immediate";
        } else if (remainingMs <= WINDOWS_ACTIVE_WAIT_MS) {
            handle = setImmediate(arm);
            kind = "immediate";
        } else {
            const requestedMs = Math.max(
                1,
                Math.floor(remainingMs - (highResolution ? HIGH_RESOLUTION_LEAD_MS : WINDOWS_TIMER_GRID_MS))
            );
            handle = setTimeout(arm, requestedMs);
            kind = "timeout";
        }
    };
    arm();

    return {
        cancel() {
            cancelled = true;
            if (kind === "immediate") clearImmediate(handle);
            else if (kind === "timeout") clearTimeout(handle);
            handle = null;
        }
    };
}

module.exports = {
    SYSTEM_CLOCK,
    STANDALONE_READ_BUDGET_RATIO,
    adaptiveReadCost,
    intervalForReadCost,
    nextDebugSamplingInterval,
    nextStandaloneSamplingInterval,
    p95SamplingDuration,
    scheduleSamplingTick
};
