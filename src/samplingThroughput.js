"use strict";

const WINDOW_MS = 1000;

class SamplingThroughput {
    constructor() {
        this.reset();
    }

    reset() {
        this.startedAt = null;
        this.recordedAt = null;
        this.bytes = 0;
        this.bytesPerSecond = 0;
    }

    record(bytes, startedAt, completedAt) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(startedAt) || !Number.isFinite(completedAt))
            return;
        if (completedAt < startedAt) return;
        if (this.startedAt === null) this.startedAt = startedAt;
        this.bytes += bytes;
        this.recordedAt = completedAt;
        const elapsed = completedAt - this.startedAt;
        if (elapsed < WINDOW_MS) return;
        this.bytesPerSecond = (this.bytes * 1000) / elapsed;
        this.bytes = 0;
        this.startedAt = completedAt;
    }

    rate(now) {
        return this.recordedAt === null || now - this.recordedAt >= WINDOW_MS ? 0 : this.bytesPerSecond;
    }
}

module.exports = { SamplingThroughput };
