"use strict";

const { METRIC } = require("./cpuLoadModel");
const { serializeError } = require("./errorEnvelope");

// A measurement owns one physical lease and one standalone worker through confirmed exit.
class CpuLoadService {
    constructor(options) {
        this.options = options;
        this.intent = false;
        this.generation = 0;
        this.latest = { state: "stopped" };
        /** @type {{ supported: boolean, reason?: { code?: string, i18nKey: string, message?: string } }} */
        this.support = { supported: false, reason: { code: "CPU_CHECKING", i18nKey: "cpu.checkingSupport" } };
    }
    status() {
        const blockedReason = this.options.blocked?.() || (!this.support.supported ? this.support.reason : null);
        return {
            type: "cpuLoad",
            metric: METRIC,
            experimental: true,
            ...this.latest,
            intentEnabled: this.intent,
            ownsProbe: !!this.run,
            canStart: !this.run && !blockedReason,
            canStop: !!this.run && !this.stopping,
            blockedReason
        };
    }
    publish(result = this.latest) {
        this.latest = result;
        this.options.post(this.status());
    }
    async refreshSupport() {
        const revision = (this.supportRevision = (this.supportRevision || 0) + 1);
        this.support = { supported: false, reason: { code: "CPU_CHECKING", i18nKey: "cpu.checkingSupport" } };
        this.publish();
        try {
            await this.options.elf.cpuLoadPlan();
            if (revision === this.supportRevision) this.support = { supported: true };
        } catch (error) {
            if (revision === this.supportRevision)
                this.support = {
                    supported: false,
                    reason: { ...serializeError(error), i18nKey: "cpu.unsupportedProject" }
                };
        }
        if (revision === this.supportRevision) this.publish();
    }
    start() {
        if (this.stopping || (this.run && !this.intent))
            return Promise.reject(Object.assign(new Error("CPU connection is still closing"), { code: "PROBE_BUSY" }));
        if (this.run) return this.run.starting;
        let lease;
        try {
            this.options.assertAvailable();
            lease = this.options.coordinator.acquire("cpuLoad");
        } catch (error) {
            this.publish({ state: "stopped", diagnostic: serializeError(error) });
            return Promise.reject(error);
        }
        const run = { lease, generation: ++this.generation, runtime: null };
        this.run = run;
        this.intent = true;
        this.publish({ state: "checking" });
        run.starting = this.begin(run);
        return run.starting;
    }
    current(run) {
        return this.run === run && this.intent && run.generation === this.generation;
    }
    async begin(run) {
        let metadataReady = false;
        try {
            const plan = await this.options.elf.cpuLoadPlan();
            if (!this.current(run)) return;
            metadataReady = true;
            this.support = { supported: true };
            if (this.options.elf.read().elf.sha256 !== plan.image) throw new Error("ELF identity changed");
            run.runtime = await this.options.create(
                (result) => this.accept(run.runtime, result),
                () => {
                    if (this.current(run)) void this.stop("disconnected").catch(() => {});
                },
                () => this.current(run)
            );
            if (!this.current(run)) return;
            if (!run.runtime) throw new Error("CPU connection was cancelled");
            run.runtime.setSamplingEnabled(false);
            await run.runtime.start();
            if (!this.current(run)) return;
            if (this.options.elf.read().elf.sha256 !== plan.image) throw new Error("ELF identity changed");
            this.runtime = run.runtime;
            this.binding = {
                identity: {
                    session: "cpu",
                    connection: run.generation,
                    image: plan.image,
                    target: run.runtime.options?.target
                }
            };
            await run.runtime.setCpuLoadPlan({ ...plan, identity: this.binding.identity, generation: run.generation });
            if (!this.current(run)) return;
            this.integrityTimer = setInterval(() => {
                try {
                    if (this.options.elf.read().elf.sha256 !== plan.image) throw new Error("ELF identity changed");
                } catch {
                    void this.stop("image-changed").catch(() => {});
                }
            }, 1000);
            this.integrityTimer.unref?.();
        } catch (error) {
            if (this.current(run)) {
                if (!metadataReady)
                    this.support = {
                        supported: false,
                        reason: {
                            ...serializeError(error),
                            code: error.code || "CPU_LAYOUT_UNSUPPORTED",
                            i18nKey: "cpu.unsupportedProject"
                        }
                    };
                this.intent = false;
                this.generation++;
                this.publish({ state: "unavailable", reason: error.message, diagnostic: serializeError(error) });
                await this.close(run);
                this.publish();
                throw error;
            }
        }
    }
    stop(reason = "stopped") {
        this.intent = false;
        this.generation++;
        clearInterval(this.integrityTimer);
        this.integrityTimer = null;
        this.runtime = null;
        this.binding = null;
        if (this.stopping) return this.stopping;
        const run = this.run;
        if (!run) {
            this.publish({ state: "stopped", reason: reason === "stopped" ? undefined : reason });
            return Promise.resolve();
        }
        this.publish({ state: "stopping", reason });
        this.stopping = (async () => {
            await run.starting.catch(() => {});
            await this.close(run);
            this.publish({ state: "stopped", reason: reason === "stopped" ? undefined : reason });
        })().finally(() => {
            this.stopping = null;
            this.publish();
        });
        this.publish();
        return this.stopping;
    }
    async close(run) {
        if (run.closing) return run.closing;
        run.closing = (async () => {
            if (run.runtime) {
                await Promise.resolve(run.runtime.setCpuLoadPlan(null)).catch(() => {});
                if ((await run.runtime.stop()) !== true) {
                    const error = Object.assign(new Error("OpenOCD exit has not been confirmed"), {
                        code: "CPU_EXIT_UNCONFIRMED",
                        i18nKey: "cpu.exitUnconfirmed"
                    });
                    this.publish({ state: "unavailable", reason: error.message, diagnostic: serializeError(error) });
                    throw error;
                }
            }
            run.lease.release();
            if (this.run === run) this.run = null;
        })().finally(() => {
            run.closing = null;
        });
        return run.closing;
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
        if (result.state === "unavailable") void this.stop(result.reason || "unavailable").catch(() => {});
        else if (result.needsMetadataRefresh) {
            const run = this.run;
            const identity = this.binding.identity;
            run.generation = ++this.generation;
            this.publish({ state: "checking" });
            void runtime
                .setCpuLoadPlan(null)
                .then(() => this.options.elf.cpuLoadPlan())
                .then(async (plan) => {
                    if (!this.current(run)) return;
                    if (plan.image !== identity.image) throw new Error("ELF identity changed");
                    await runtime.setCpuLoadPlan({ ...plan, identity, generation: run.generation });
                })
                .catch(() => {
                    if (this.current(run)) return this.stop("image-changed");
                })
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
