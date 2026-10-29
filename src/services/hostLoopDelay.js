"use strict";
const { monitorEventLoopDelay } = require("perf_hooks");

// Reports the longest extension-host event-loop stall of the last complete window. Sampling statistics use
// it to tell a busy host (another extension, a synchronous parse) apart from a slow probe.
class HostLoopDelay {
    constructor({ windowMs = 1000, now = Date.now, create = () => monitorEventLoopDelay({ resolution: 20 }) } = {}) {
        this.windowMs = windowMs;
        this.now = now;
        this.create = create;
        this.histogram = null;
        this.windowStart = 0;
        this.lastMaxMs = 0;
    }
    maxMs() {
        const now = this.now();
        if (!this.histogram) {
            this.histogram = this.create();
            this.histogram.enable();
            this.windowStart = now;
            return 0;
        }
        if (now - this.windowStart >= this.windowMs) {
            this.lastMaxMs = Math.round(this.histogram.max / 1e6);
            this.histogram.reset();
            this.windowStart = now;
        }
        return this.lastMaxMs;
    }
    dispose() {
        this.histogram?.disable();
        this.histogram = null;
    }
}

module.exports = { HostLoopDelay };
