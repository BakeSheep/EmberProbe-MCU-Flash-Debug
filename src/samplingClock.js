"use strict";
const { performance } = require("perf_hooks");

const WINDOWS_TIMER_GRID_MS = 15.6;
const WINDOWS_ACTIVE_WAIT_MS = 12;
const HIGH_RESOLUTION_LEAD_MS = 1.5;

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

// When Windows cannot provide a fine timer, wake one coarse tick early and
// yield with setImmediate for the short remainder. This runs only in the
// sampling Worker and keeps its message queue responsive to pause/stop.
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
        } else if (highResolution && remainingMs <= HIGH_RESOLUTION_LEAD_MS) {
            handle = setImmediate(arm);
            kind = "immediate";
        } else if (!highResolution && remainingMs <= WINDOWS_ACTIVE_WAIT_MS) {
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

module.exports = { SYSTEM_CLOCK, scheduleSamplingTick };
