"use strict";
// Upper bound for a debug start that never reports initialization or termination.
const DEBUG_STARTUP_TIMEOUT_MS = 60000;

class DebugLifecycle {
    constructor({ schedule = setTimeout, cancel = clearTimeout } = {}) {
        this.schedule = schedule;
        this.cancel = cancel;
        this.pending = false;
        this.session = null;
        this.timeoutMs = 0;
        this.timer = null;
        this.resolve = null;
        this.generation = 0;
        this.initializedReceived = false;
        this.launchConfirmed = false;
    }
    arm(timeoutMs, onTimeout) {
        this.clear({ kind: "cancelled" });
        this.pending = true;
        this.initializedReceived = false;
        this.launchConfirmed = false;
        this.timeoutMs = timeoutMs;
        const generation = this.generation;
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.timer = this.schedule(() => {
                if (!this.pending || generation !== this.generation) return;
                resolve({ kind: "timeout" });
                Promise.resolve()
                    .then(onTimeout)
                    .catch((error) => console.error("Debug startup recovery failed:", error));
            }, timeoutMs);
        });
    }
    clear(outcome = { kind: "cancelled" }) {
        const resolve = this.resolve;
        if (this.timer !== null) this.cancel(this.timer);
        this.generation++;
        this.pending = false;
        this.session = null;
        this.timeoutMs = 0;
        this.timer = null;
        this.resolve = null;
        this.initializedReceived = false;
        this.launchConfirmed = false;
        resolve?.(outcome);
    }
    sessionMatches(session, matchesManaged) {
        if (!this.pending || (!this.session && !matchesManaged)) return false;
        if (this.session && session && this.session.id !== session.id) return false;
        return true;
    }
    markInitialized(session, matchesManaged) {
        if (!this.sessionMatches(session, matchesManaged)) return;
        this.initializedReceived = true;
        if (this.launchConfirmed && this.initializedReceived) {
            this.clear({ kind: "ready" });
        }
    }
    markLaunchResponse(session, matchesManaged, success, failureDetails = {}) {
        if (!this.sessionMatches(session, matchesManaged)) return;
        if (!success) {
            this.clear({ kind: "failed", ...failureDetails });
            return;
        }
        this.launchConfirmed = true;
        if (this.launchConfirmed && this.initializedReceived) {
            this.clear({ kind: "ready" });
        }
    }
    ready(session, matchesManaged) {
        if (!this.sessionMatches(session, matchesManaged)) return;
        this.clear({ kind: "ready" });
    }
}
module.exports = { DebugLifecycle, DEBUG_STARTUP_TIMEOUT_MS };
