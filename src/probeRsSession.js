"use strict";
const { SYSTEM_CLOCK } = require("./samplingClock");
const { ProbeRsProcess } = require("./probeRsProcess");
const { nativeRecipe, nativePlan, unpackRecipe } = require("./probeRsReadPlan");
const CAPABILITIES = Object.freeze({ read: true, write: false, peripherals: false, rtt: false });
const unsupported = () =>
    Object.assign(new Error("This operation requires the OpenOCD sampling backend"), {
        code: "BACKEND_UNSUPPORTED",
        retryable: false
    });

class ProbeRsSamplingSession {
    constructor(options, handlers = {}, dependencies = {}) {
        this.options = options;
        this.handlers = handlers;
        this.clock = { ...SYSTEM_CLOCK, ...options.clock };
        this.capabilities = CAPABILITIES;
        this.mode = "standalone";
        this.stopped = false;
        this._pollFailureLocked = false;
        this.samplingEnabled = true;
        this.targetEpoch = 0;
        this.generation = 0;
        this.points = [];
        this.hostHoldMs = 0;
        this.planInput = {
            graphItems: [],
            sidebarItems: [],
            ramSectionRanges: [],
            graphIntervalMs: options.intervalMs || 33
        };
        this.plan = nativePlan(this.planInput);
        this.client = new ProbeRsProcess(
            options,
            {
                onSamples: (message) => this.onSamples(message),
                onFailure: (error) => this.fail(error)
            },
            dependencies
        );
        this.server = { child: null };
    }
    get unlimitedActive() {
        return this.plan.rate.unlimitedActive;
    }
    async start() {
        if (this.stopped) throw new Error("Native session already stopped");
        const pending = this.client.start(this.options.native);
        this.server.child = this.client.child;
        try {
            const ready = await pending;
            if (ready?.protocol !== 1 || ready.elfSha256 !== this.options.native.elfSha256)
                throw Object.assign(new Error("Native sampler identity or protocol mismatch"), {
                    code: "PROBE_RS_PROTOCOL_ERROR"
                });
            if (this.stopped) throw new Error("Native startup cancelled");
            this.ramRanges = ready.ramRanges;
            this.linkSpeedKhz = ready.speedKhz;
            this.ready = true;
            await this.publishPlan();
            this.handlers.onConnectionConfirmed?.();
            return ready;
        } catch (error) {
            this.fail(error);
            throw error;
        }
    }
    fail(error) {
        if (this.connectionFailed || this.stopped) return;
        this.connectionFailed = true;
        this._pollFailureLocked = true;
        this.connectionError = error;
        this.samplingEnabled = false;
        this.targetEpoch++;
        this.generation++;
        void this.client.stop().catch(() => {});
        this.handlers.onDisconnect?.(error);
    }
    setWatch(items, ramSectionRanges = []) {
        return this.setSamplingPlan({
            graphItems: items,
            sidebarItems: [],
            ramSectionRanges,
            graphIntervalMs: this.planInput.graphIntervalMs,
            unlimited: this.planInput.unlimited
        });
    }
    setSamplingPlan(plan) {
        this.generation++;
        try {
            const next = nativePlan(plan);
            this.planInput = plan;
            this.plan = next;
            this.points = [];
            return this.publishPlan(false);
        } catch (error) {
            this.fail(error);
            throw error;
        }
    }
    publishPlan(invalidate = true) {
        if (invalidate) this.generation++;
        if (!this.ready || this.stopped || this.connectionFailed) return Promise.resolve();
        const { rate, recipes } = this.plan;
        return this.client.request("plan", {
            generation: this.generation,
            recipes: recipes.map((recipe) => recipe.groups.map(({ address, count }) => ({ address, count }))),
            graph: rate.graphItems.length > 0,
            sidebar: rate.sidebarItems.length > 0,
            graphIntervalMs: rate.graphIntervalMs,
            unlimited: rate.unlimitedActive,
            enabled: this.samplingEnabled
        });
    }
    setIntervalMs(intervalMs) {
        const interval = Math.max(5, Math.min(10000, Number(intervalMs) || 33));
        this.options.intervalMs = interval;
        return this.setSamplingPlan({ ...this.planInput, graphIntervalMs: interval });
    }
    setSamplingEnabled(enabled) {
        this.samplingEnabled = !!enabled && !this.stopped && !this.connectionFailed;
        this.publishPlan().catch((error) => this.fail(error));
        return this.samplingEnabled;
    }
    setHostHold(held) {
        if (!!held === !!this.held) return;
        const now = this.clock.monotonicMs();
        if (this.heldSince !== undefined) this.hostHoldMs += now - this.heldSince;
        this.held = !!held;
        this.heldSince = held ? now : undefined;
        if (this.ready && !this.stopped) this.client.request("hold", this.held).catch((error) => this.fail(error));
    }
    setPauseReason(reason) {
        this.pauseReason = reason || null;
    }
    invalidateTarget() {
        this.targetEpoch++;
        return this.publishPlan();
    }
    onSamples(message) {
        if (this.stopped || this.connectionFailed || !this.samplingEnabled || message.generation !== this.generation)
            return;
        const recipe = this.plan.recipes[message.recipe];
        const graphNames = message.recipe & 1 ? this.plan.rate.graphItems.map((item) => item.name) : [];
        const sidebarNames = message.recipe & 2 ? this.plan.rate.sidebarItems.map((item) => item.name) : [];
        try {
            for (const entry of message.samples) {
                if (this.lastTimestamp !== undefined && entry.t < this.lastTimestamp)
                    throw new Error("Native time moved backwards");
                this.lastTimestamp = entry.t;
                const samples = unpackRecipe(recipe, entry.bytes, entry.t);
                const due = { clock: entry.t, graphNames, sidebarNames };
                const delivered = this.plan.rate.deliver(samples, entry.t, due);
                this.totalBytes = (this.totalBytes || 0) + message.byteCount;
                this.points.push({ t: entry.t, duration: entry.durationMs, totalBytes: this.totalBytes });
                this.handlers.onSample?.(delivered, entry.t, due);
            }
            const minimum = this.points.at(-1).t - 3000;
            const first = this.points.findIndex((point) => point.t >= minimum);
            if (first > 0) this.points.splice(0, first);
            if (this.points.length > 16384) this.points.splice(0, this.points.length - 16384);
        } catch (error) {
            this.fail(error);
        }
    }
    stats() {
        const points = this.points;
        const span = points.length > 1 ? points.at(-1).t - points[0].t : 0;
        const durations = points
            .slice(-128)
            .map((point) => point.duration)
            .sort((a, b) => a - b);
        const holding = this.heldSince === undefined ? 0 : this.clock.monotonicMs() - this.heldSince;
        return {
            backend: "probe-rs",
            linkSpeedKhz: this.linkSpeedKhz,
            unlimited: this.planInput.unlimited === true,
            unlimitedActive: this.unlimitedActive,
            unlimitedSuppressedReason: null,
            limitedBy: this.held ? "host" : "probe",
            hostHoldMs: this.hostHoldMs + holding,
            targetIntervalMs: this.plan.rate.requestedIntervalMs,
            effectiveIntervalMs: this.unlimitedActive ? 0 : this.plan.rate.requestedIntervalMs,
            actualHz: span > 0 ? ((points.length - 1) * 1000) / span : 0,
            bytesPerSecond: span > 0 ? ((points.at(-1).totalBytes - points[0].totalBytes) * 1000) / span : 0,
            p95DurationMs: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : 0,
            missedDeadlines: 0,
            pauseReason: this.pauseReason || (this.stopped ? "stopped" : null),
            consumers: this.plan.rate.stats()
        };
    }
    async readOnce(items) {
        const epoch = this.targetEpoch;
        if (!this.ready || this.stopped || this.connectionFailed)
            throw new Error("Native sampling session is not ready");
        const recipe = nativeRecipe(items, this.ramRanges || this.plan.ranges);
        const result = await this.client.request(
            "read",
            recipe.groups.map(({ address, count }) => ({ address, count }))
        );
        if (epoch !== this.targetEpoch || this.stopped || this.connectionFailed)
            throw Object.assign(new Error("Native read belongs to an old target generation"), {
                code: "LIVE_READ_CANCELLED"
            });
        if (
            !Number.isFinite(result.t) ||
            !Array.isArray(result.bytes) ||
            result.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
        )
            throw new Error("Native read returned invalid bytes");
        return unpackRecipe(recipe, Buffer.from(result.bytes), result.t);
    }
    writeAndVerify() {
        return Promise.reject(unsupported());
    }
    peripheralTransaction() {
        return Promise.reject(unsupported());
    }
    rttControl() {
        return Promise.reject(unsupported());
    }
    waitForIdle() {
        return this.ready ? this.client.request("read", []).then(() => true) : Promise.resolve(true);
    }
    waitForExit(timeoutMs) {
        return this.client.waitForExit(timeoutMs);
    }
    stop(timeoutMs) {
        this.stopped = true;
        this.samplingEnabled = false;
        this.targetEpoch++;
        this.generation++;
        return this.client.stop(timeoutMs);
    }
}
module.exports = { ProbeRsSamplingSession, CAPABILITIES };
