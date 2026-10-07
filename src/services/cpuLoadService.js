"use strict";

const { METRIC } = require("./cpuLoadModel");

// Host-side intent and identity owner. Only the sampling worker touches the target.
class CpuLoadService {
    constructor(options) {
        this.options = options;
        this.intent = false;
        this.generation = 0;
        this.connections = new WeakMap();
        this.nextConnection = 0;
        this.latest = { state: "stopped" };
    }
    status() {
        return { type: "cpuLoad", metric: METRIC, experimental: true, ...this.latest, intentEnabled: this.intent };
    }
    publish(result) {
        this.latest = result;
        this.options.post(this.status());
    }
    async start() {
        this.intent = true;
        await this.suspend("starting");
        await this.reconcile(true);
    }
    async stop() {
        this.intent = false;
        await this.suspend("stopped");
        await this.options.release?.();
    }
    suspend(reason) {
        this.generation++;
        clearInterval(this.integrityTimer);
        this.integrityTimer = null;
        const runtime = this.runtime;
        this.runtime = null;
        this.binding = null;
        this.publish({
            state: reason === "stopped" || !this.intent ? "stopped" : "paused",
            reason: this.intent ? reason : undefined
        });
        return Promise.resolve(runtime?.setCpuLoadPlan(null)).catch(() => {});
    }
    async reconcile(connect = false) {
        if (!this.intent) return;
        if (this.pending) {
            this.again = true;
            return this.pending;
        }
        this.pending = this.bind(connect).finally(() => {
            this.pending = null;
            if (this.again) {
                this.again = false;
                void this.reconcile().catch(() => {});
            }
        });
        return this.pending;
    }
    async bind(connect) {
        let expected = this.generation;
        try {
            const context = await this.options.context(connect);
            if (!this.intent || expected !== this.generation) {
                if (connect && !this.intent) await this.options.release?.();
                return;
            }
            if (context.reason || !context.runtime) {
                if (this.runtime) await this.suspend(context.reason || "disconnected");
                else
                    this.publish({
                        state: context.unsupported ? "unavailable" : "paused",
                        reason: context.reason || "disconnected"
                    });
                return;
            }
            const key = JSON.stringify(context.identity);
            if (this.runtime === context.runtime && this.binding?.key === key) return;
            await this.suspend("checking");
            const generation = this.generation;
            expected = generation;
            const plan = await this.options.elf.cpuLoadPlan();
            if (!this.intent || generation !== this.generation) return;
            const current = await this.options.context(false);
            if (current.runtime !== context.runtime || current.reason || JSON.stringify(current.identity) !== key)
                return;
            if (!this.connections.has(context.runtime)) this.connections.set(context.runtime, ++this.nextConnection);
            const identity = {
                ...context.identity,
                connection: this.connections.get(context.runtime),
                image: plan.image
            };
            this.runtime = context.runtime;
            this.binding = { key, identity, generation };
            this.publish({ state: "checking", identity, generation });
            await this.runtime.setCpuLoadPlan({ ...plan, identity, generation });
            if (generation !== this.generation) return;
            this.integrityTimer = setInterval(() => {
                try {
                    if (this.options.elf.read().elf.sha256 !== identity.image) throw new Error("ELF identity changed");
                    void this.reconcile();
                } catch {
                    void this.suspend("image-changed")
                        .then(() => this.reconcile())
                        .catch(() => {});
                }
            }, 1000);
            this.integrityTimer.unref?.();
        } catch (error) {
            if (this.intent && expected === this.generation) {
                await this.suspend("unavailable");
                this.publish({ state: "unavailable", reason: error.message });
            }
        }
    }
    accept(runtime, result) {
        if (
            !this.intent ||
            runtime !== this.runtime ||
            result.generation !== this.generation ||
            JSON.stringify(result.identity) !== JSON.stringify(this.binding?.identity)
        )
            return false;
        this.publish(result);
        if (result.needsMetadataRefresh) {
            void this.suspend("runtime-revalidation")
                .then(() => this.reconcile())
                .catch(() => {});
        }
        return true;
    }
    async selectIdle(key) {
        if (typeof key !== "string" || key.length > 80 || !this.runtime) throw new Error("No active CPU measurement");
        await this.runtime.selectCpuIdleTask(key);
    }
}

module.exports = { CpuLoadService };
