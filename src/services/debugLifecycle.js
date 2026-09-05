"use strict";
// Cortex-Debug 1.12.1 on Windows may leave startDebugging unresolved.
// Keep this bounded recovery until that adapter version is no longer supported;
// remove only with a regression reproducing successful initialization/termination.
function debugStartupPolicy(platform, version) {
    const affected = platform === "win32" && version === "1.12.1";
    return {
        timeoutMs: affected ? 15000 : 60000,
        messageKey: affected ? "msg.debugStartTimeoutWin" : "msg.debugStartTimeout"
    };
}

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
    }
    arm(timeoutMs, onTimeout) {
        this.clear({ kind: "cancelled" });
        this.pending = true;
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
        resolve?.(outcome);
    }
    ready(session, matchesManaged) {
        if (!this.pending || (!this.session && !matchesManaged)) return;
        if (this.session && session && this.session.id !== session.id) return;
        this.clear({ kind: "ready" });
    }
}
module.exports = { DebugLifecycle, debugStartupPolicy };
