"use strict";

const { classifyCpuSample, CpuLoadWindow, decodeTask, inRam, METRIC } = require("./cpuLoadModel");
const { scheduleSamplingTick } = require("../samplingClock");
const { windowsTimerResolution } = require("../windowsTimerResolution");

// These registers are deliberately separate from the ordinary RAM read API.
const REGISTERS = Object.freeze({
    cpuid: 0xe000ed00,
    icsr: 0xe000ed04,
    demcr: 0xe000edfc,
    dwt: 0xe0001000,
    pcsr: 0xe000101c
});
const PARTS = new Map([
    [0xc20, "Cortex-M0"],
    [0xc60, "Cortex-M0+"],
    [0xc23, "Cortex-M3"],
    [0xc24, "Cortex-M4"],
    [0xc27, "Cortex-M7"]
]);
const mono = () => Number(process.hrtime.bigint()) / 1e6;

function word(text) {
    const token = String(text).trim();
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(token)) throw new Error("Invalid CPU memory response");
    const value = Number(token);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid CPU word");
    return value;
}

class CpuLoadSampler {
    constructor(owner, options = {}) {
        this.owner = owner;
        this.now = options.now || mono;
        this.random = options.random || Math.random;
        this.schedule = options.schedule || scheduleSamplingTick;
        this.epoch = 0;
        this.run = 0;
        this.tasks = new Map();
        this.costs = [];
        this.period = 5;
        this.lastDuration = 1;
        this.estimatedCostMs = 1;
        this.adaptationReason = "requested";
    }
    emit(state, extra = {}) {
        this.owner.handlers.onCpuLoad?.({
            state,
            metric: METRIC,
            experimental: true,
            requestedHz: 200,
            rateMode: "adaptive",
            adaptiveTargetHz: 1000 / this.period,
            effectivePeriodMs: this.period,
            samplingCostMs: this.estimatedCostMs,
            adaptationReason: this.adaptationReason,
            sleepPercent: null,
            identity: this.plan?.identity,
            generation: this.plan?.generation,
            runGeneration: this.run,
            capabilities: this.capabilities,
            ...extra
        });
    }
    cancel() {
        this.timer?.cancel();
        this.timer = null;
        if (this.resolution) windowsTimerResolution.release();
        this.resolution = false;
    }
    stop() {
        this.epoch++;
        this.cancel();
        this.plan = null;
        this.window = null;
        this.tasks.clear();
        this.costs = [];
        this.idle = null;
        this.manualIdle = null;
        this.target = null;
    }
    configure(plan) {
        this.stop();
        if (!plan) return;
        if (
            !plan.identity ||
            !Number.isSafeInteger(plan.generation) ||
            !inRam(plan.ranges, plan.currentAddress, 4) ||
            !Number.isInteger(plan.tcb?.size) ||
            plan.tcb.size > 2048
        )
            throw new Error("Invalid CPU read plan");
        this.plan = plan;
        this.functions = (plan.functions || []).slice().sort((a, b) => a.address - b.address);
        this.functionEnds = [];
        let lastEnd = 0;
        for (const fn of this.functions) {
            lastEnd = Math.max(lastEnd, fn.address + fn.size);
            this.functionEnds.push(lastEnd);
        }
        this.period = 5;
        this.lastDuration = 1;
        this.estimatedCostMs = 1;
        this.adaptationReason = "requested";
        this.capabilities = null;
        this.paused = false;
        this.awaitingScheduler = false;
        this.targetInactive = false;
        this.newWindow();
        this.emit("checking");
        this.scheduleNext(0);
    }
    newWindow() {
        this.run++;
        this.window = new CpuLoadWindow(this.now());
        this.tasks.clear();
        this.idle = null;
        this.manualIdle = null;
        this.nextSlot = this.now();
        this.lastEmit = this.nextSlot;
        this.lastIdleCheck = -Infinity;
    }
    pause(reason) {
        this.epoch++;
        this.cancel();
        this.paused = !!reason;
        this.window = null;
        this.tasks.clear();
        if (!this.plan) return;
        if (reason) this.emit("paused", { reason });
        else {
            this.capabilities = null;
            this.newWindow();
            this.scheduleNext(0);
        }
    }
    selectIdle(key) {
        const task = this.tasks.get(key);
        if (!task || this.now() - task.time > 1000) throw new Error("Idle selection requires a fresh verified task");
        // A selection lasts only for this measurement run; it never writes to the MCU.
        this.manualIdle = { key: task.key, fingerprint: task.fingerprint };
        this.idle = task.key;
        this.window = new CpuLoadWindow(this.now());
        this.emit("collecting");
    }
    scheduleNext(delay) {
        this.timer?.cancel();
        if (!this.plan || this.paused || this.owner.stopped) return;
        if (!this.resolution) this.resolution = windowsTimerResolution.acquire();
        this.timer = this.schedule(
            Math.max(0, delay),
            () => {
                this.timer = null;
                void this.tick();
            },
            { highResolution: this.resolution }
        );
    }
    read(address, size = 4) {
        if (!(size === 4 && Object.values(REGISTERS).includes(address)) && !inRam(this.plan.ranges, address, size))
            throw new Error("CPU read outside the dedicated whitelist");
        if (!this.target) throw new Error("CPU target has not been validated");
        return `${this.target} read_memory 0x${address.toString(16)} ${size === 4 ? 32 : 8} ${size === 4 ? 1 : size}`;
    }
    async command(command) {
        const epoch = this.epoch;
        const response = await this.owner._sendCheckedCommand(command);
        if (epoch !== this.epoch) throw Object.assign(new Error("Stale CPU response"), { code: "CPU_STALE" });
        return response;
    }
    async words(addresses) {
        const text = await this.command(
            `join [list ${addresses.map((address) => `[${this.read(address)}]`).join(" ")}] "\\n"`
        );
        const lines = text.trim().split(/\r?\n/);
        if (lines.length !== addresses.length) throw new Error("Incomplete CPU response");
        return lines.map(word);
    }
    async check() {
        // mem_ap is an auxiliary debug access target, not another processor.
        // Bound the inventory before inspecting types, and never change target selection.
        const inventory = await this.command(
            'set _ep_cpu_targets [target names]; if {[llength $_ep_cpu_targets] < 1 || [llength $_ep_cpu_targets] > 32} {error "Invalid CPU target inventory"}; set _ep_cpu_info [list [target current]]; foreach _ep_cpu_target $_ep_cpu_targets {lappend _ep_cpu_info $_ep_cpu_target [$_ep_cpu_target cget -type] [$_ep_cpu_target cget -endian]}; join $_ep_cpu_info "\\n"'
        );
        const lines = inventory.trim().split(/\r?\n/);
        if (lines.length < 4 || lines.length > 97 || (lines.length - 1) % 3)
            throw new Error("Invalid CPU target inventory");
        const targets = [];
        for (let index = 1; index < lines.length; index += 3) {
            const name = lines[index];
            if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name) || targets.some((entry) => entry.name === name))
                throw new Error("Invalid CPU target identity");
            targets.push({ name, type: lines[index + 1], endian: lines[index + 2] });
        }
        const cores = targets.filter((entry) => entry.type === "cortex_m");
        if (cores.length !== 1 || targets.some((entry) => !["cortex_m", "mem_ap"].includes(entry.type)))
            throw new Error("CPU monitoring requires exactly one Cortex-M core; only mem_ap auxiliaries are supported");
        if (cores[0].endian !== "little") throw new Error("CPU monitoring requires a little-endian Cortex-M target");
        if (lines[0] !== cores[0].name) throw new Error("The selected OpenOCD target is not the Cortex-M core");
        this.target = cores[0].name;
        const [cpuid] = await this.words([REGISTERS.cpuid]);
        const core = PARTS.get((cpuid >>> 4) & 0xfff);
        if (cpuid >>> 24 !== 0x41 || !core) throw new Error("Unsupported CPU: requires Cortex-M0/M0+/M3/M4/M7");
        let pcsr = false;
        let pcReason = "core-unsupported";
        if (!["Cortex-M0", "Cortex-M0+"].includes(core)) {
            try {
                const [demcr, dwt] = await this.words([REGISTERS.demcr, REGISTERS.dwt]);
                pcsr = !!(demcr & 0x01000000) && !(dwt & 0x01000000);
                pcReason = pcsr ? null : "trace-disabled-or-pc-unsupported";
            } catch {
                pcReason = "register-unavailable";
            }
        }
        this.capabilities = {
            core,
            coreTarget: this.target,
            auxiliaryTargets: targets.filter((entry) => entry.type === "mem_ap").map((entry) => entry.name),
            pcsr,
            pcReason,
            taskResidency: true,
            sleep: false
        };
    }
    async task(address, time) {
        if (address % 4 || !inRam(this.plan.ranges, address, this.plan.tcb.size)) return null;
        const cached = [...this.tasks.values()].find((entry) => entry.address === address && time - entry.time < 1000);
        if (cached) return cached;
        const text = await this.command(this.read(address, this.plan.tcb.size));
        const values = text.trim().split(/\s+/).map(word);
        if (values.some((value) => value > 255)) return null;
        const task = decodeTask(this.plan, address, Buffer.from(values), time);
        if (!task) return null;
        const previous = this.tasks.get(task.key);
        if (previous && previous.fingerprint !== task.fingerprint) {
            this.newWindow();
            this.emit("collecting", { reason: "task-identity-changed" });
        }
        for (const entry of this.tasks.values()) {
            if (entry.address === address && entry.key !== task.key) entry.time = -Infinity;
        }
        this.tasks.set(task.key, task);
        while (this.tasks.size > 256) this.tasks.delete(this.tasks.keys().next().value);
        return task;
    }
    async refreshIdle(time) {
        if (time - this.lastIdleCheck < 1000) return !this.awaitingScheduler;
        this.lastIdleCheck = time;
        if (this.plan.schedulerAddress) {
            const [running] = await this.words([this.plan.schedulerAddress]);
            if (running !== 1) {
                if (!this.awaitingScheduler) {
                    this.window = null;
                    this.tasks.clear();
                    this.idle = null;
                    this.emit("waiting", { reason: "scheduler-not-running" });
                }
                this.awaitingScheduler = true;
                return false;
            }
        }
        if (this.awaitingScheduler) {
            this.awaitingScheduler = false;
            this.newWindow();
            this.paused = true;
            this.cancel();
            this.emit("checking", { reason: "scheduler-resumed", needsMetadataRefresh: true });
            return false;
        }
        if (this.plan.idleAddress) {
            const previousIdle = this.idle;
            this.idle = null;
            const [before] = await this.words([this.plan.idleAddress]);
            const task = await this.task(before, time);
            const [after] = await this.words([this.plan.idleAddress]);
            const confirmed = before === after ? task?.key || null : null;
            if (confirmed !== previousIdle && this.window?.slots.length) {
                this.newWindow();
                if (task) this.tasks.set(task.key, task);
                this.lastIdleCheck = time;
                this.emit("collecting", { reason: "idle-identity-changed" });
            }
            this.idle = confirmed;
        } else if (this.manualIdle) {
            const selection = this.manualIdle;
            const task = this.tasks.get(selection.key);
            const refreshed = task && (await this.task(task.address, time));
            this.idle = refreshed?.fingerprint === selection.fingerprint ? refreshed.key : null;
        }
        return true;
    }
    hotspot(pc) {
        if (!Number.isInteger(pc) || !pc || pc === 0xffffffff) return null;
        const address = (pc & 0xfffffffe) >>> 0;
        // A shared function is a function hotspot, never a task identity.
        let lo = 0,
            hi = this.functions.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.functions[mid].address <= address) lo = mid + 1;
            else hi = mid;
        }
        const index = lo - 1,
            fn = this.functions[index];
        if (!fn || address >= fn.address + fn.size || (index > 0 && this.functionEnds[index - 1] > address))
            return null;
        return fn.displayName || fn.name;
    }
    async collect(period, time) {
        const pc = this.capabilities.pcsr
            ? `[set _ep_pc 0; catch {if {[${this.read(REGISTERS.demcr)}] & 0x01000000} {set _ep_pc [${this.read(REGISTERS.pcsr)}]}}; set _ep_pc]`
            : "0";
        // curstate uses OpenOCD's own state, avoiding sticky debug status reads.
        const state = `[if {[target current] eq {${this.target}}} {${this.target} curstate} else {set _ep_cpu_state target-changed}]`;
        const command = `join [list ${state} [${this.read(this.plan.currentAddress)}] [${this.read(REGISTERS.icsr)}] ${pc} [${this.read(REGISTERS.icsr)}] [${this.read(this.plan.currentAddress)}] ${state}] "\\n"`;
        const start = this.now();
        const text = await this.command(command);
        const durationMs = this.now() - start;
        const lines = text.trim().split(/\r?\n/);
        if (lines.length !== 7) throw new Error("Incomplete CPU bracket");
        const beforeTcb = word(lines[1]),
            afterTcb = word(lines[5]);
        const beforeException = word(lines[2]) & 0x1ff,
            afterException = word(lines[4]) & 0x1ff;
        if (lines[0] !== "running" || lines[6] !== "running")
            return { kind: "unknown", reason: "target-state", acquired: true, inactive: true };
        const task = !beforeException && beforeTcb === afterTcb ? await this.task(beforeTcb, time) : null;
        const classification = classifyCpuSample({
            beforeState: lines[0],
            afterState: lines[6],
            beforeTcb,
            afterTcb,
            beforeException,
            afterException,
            durationMs,
            periodMs: period,
            task,
            idle: this.idle
        });
        let pcValue = 0;
        try {
            pcValue = word(lines[3]);
        } catch {
            /* A malformed optional PC never invalidates the base sample. */
        }
        return { ...classification, acquired: true, pc: this.hotspot(pcValue) };
    }
    async tick() {
        if (!this.plan || this.paused || this.owner.stopped) return;
        const epoch = this.epoch;
        const start = this.now();
        const slotStart = this.nextSlot;
        const requestedPeriod = 5 * (0.8 + this.random() * 0.4);
        const period = (this.period * requestedPeriod) / 5;
        // A sample represents the planned adaptive slot, not a fixed 200 Hz slot.
        // Deliberate lower resolution is distinct from genuinely missed observations.
        const slotEnd = start + period;
        const nextDeadline = slotEnd;
        let classification = /** @type {any} */ ({ kind: "unknown", reason: "backpressure" });
        let owned = false;
        this.costs = this.costs.filter((cost) => cost.time > start - 1000);
        const spent = this.costs.reduce((sum, cost) => sum + cost.duration, 0);
        const sharedSpent = (this.owner._recentTclCosts || [])
            .filter((cost) => cost.time > start - 1000)
            .reduce((sum, cost) => sum + cost.duration, 0);
        const variableDue =
            this.owner.samplingEnabled &&
            this.owner.watch.length &&
            (this.owner.ratePlan
                ? this.owner.ratePlan.delay(start) <= Math.max(1, this.lastDuration)
                : start >= (this.owner._variableDeadline || 0));
        try {
            if (this.owner.busy || this.owner.queue.length || variableDue)
                classification.reason = "transaction-or-variable";
            else if (!this.owner.socket || this.owner.socket.destroyed) classification.reason = "disconnected";
            else if (spent + this.lastDuration > 200) classification.reason = "cpu-budget";
            else if (sharedSpent + this.lastDuration > (this.owner.mode === "debug" ? 400 : 700))
                classification.reason = "shared-budget";
            else if (
                (this.owner._pauseReason && !["paused", "debug_paused"].includes(this.owner._pauseReason)) ||
                this.owner._pollFailureLocked ||
                this.owner.cpuDeliveryBlocked
            )
                classification.reason = "backpressure";
            else {
                this.owner.busy = owned = true;
                if (!this.capabilities) await this.check();
                if (epoch !== this.epoch) return;
                const ready = await this.refreshIdle(start);
                if (epoch !== this.epoch) return;
                classification =
                    ready === false
                        ? { kind: "unknown", reason: "scheduler-not-running" }
                        : await this.collect(period, start);
            }
        } catch (error) {
            if (epoch !== this.epoch) return;
            classification = { kind: "unknown", reason: "read-failed" };
            if (!this.capabilities) {
                this.emit("unavailable", { reason: error.message });
                this.paused = true;
                this.cancel();
            }
        } finally {
            if (owned) {
                this.owner.busy = false;
                const duration = this.now() - start;
                if (epoch === this.epoch) {
                    this.costs.push({ time: this.now(), duration });
                    this.lastDuration = Math.max(0.1, duration);
                    this.estimatedCostMs =
                        this.costs.length === 1
                            ? this.lastDuration
                            : this.estimatedCostMs * 0.8 + this.lastDuration * 0.2;
                    // Reserve 10% of the 200 ms ceiling for jitter and metadata refresh.
                    // Back off immediately, recover gradually to avoid rate oscillations.
                    const costFloor = Math.max(this.estimatedCostMs, this.lastDuration) / 0.18;
                    const variableFloor = this.owner.watch.length ? this.owner.effectiveIntervalMs / 20 : 5;
                    const floor = Math.max(5, costFloor, variableFloor);
                    this.period = Math.min(1000, Math.max(floor, this.period * 0.8));
                    this.adaptationReason =
                        this.period <= 5
                            ? "requested"
                            : variableFloor > Math.max(5, costFloor)
                              ? "variable-pressure"
                              : "read-cost";
                }
            }
        }
        if (epoch !== this.epoch || !this.plan || this.paused) return;
        if (["cpu-budget", "shared-budget", "transaction-or-variable"].includes(classification.reason)) {
            this.period = Math.min(1000, this.period * 1.15);
            this.adaptationReason = classification.reason === "cpu-budget" ? "cpu-budget" : "variable-pressure";
        }
        if (classification.inactive) {
            this.window = null;
            this.tasks.clear();
            this.idle = null;
            if (!this.targetInactive) this.emit("paused", { reason: "target-state" });
            this.targetInactive = true;
        } else if (this.awaitingScheduler) {
            this.nextSlot = slotEnd;
        } else {
            if (!this.window || this.targetInactive) {
                this.targetInactive = false;
                this.capabilities = null;
                this.newWindow();
                this.paused = true;
                this.cancel();
                this.emit("checking", { reason: "target-resumed", needsMetadataRefresh: true });
            } else {
                const gapEnd = Math.min(start, slotEnd);
                if (gapEnd > slotStart + 1)
                    this.window.add(slotStart, gapEnd, { kind: "unknown", reason: "missed-slot" });
                this.window.add(start, slotEnd, classification, classification.pc);
                if (start - this.lastEmit >= 1000) {
                    this.lastEmit = start;
                    this.emit("running", this.window.summary(start, this.tasks, this.idle, this.capabilities));
                }
            }
        }
        this.nextSlot = nextDeadline;
        this.scheduleNext(this.targetInactive || this.awaitingScheduler ? 100 : Math.max(0, nextDeadline - this.now()));
    }
}

module.exports = { CpuLoadSampler, REGISTERS, word };
