"use strict";

const WINDOW_MS = 10000;
const MAX_SLOTS = 8192;
const METRIC = "non-idle-task-or-active-exception";

function failure(message) {
    return Object.assign(new Error(message), { code: "CPU_LAYOUT_UNSUPPORTED" });
}

function inRam(ranges, address, size) {
    return (
        Number.isSafeInteger(address) &&
        address >= 0x10000000 &&
        Number.isSafeInteger(size) &&
        size > 0 &&
        address + size <= 0x40000000 &&
        ranges.some((range) => address >= range.start && address + size <= range.end)
    );
}

function buildCpuLoadPlan(result, layout) {
    if (result.elf?.machine !== 40 || result.elf?.elfClass !== 1 || result.elf?.encoding !== 1)
        throw failure("CPU monitoring requires a little-endian ARM32 ELF");
    if (result.symbols.some((symbol) => symbol.name === "pxCurrentTCBs")) throw failure("FreeRTOS SMP is unsupported");
    const ranges = (result.memory?.sections || [])
        .filter(
            (section) =>
                (section.flags & 3) === 3 && inRam([{ start: 0x10000000, end: 0x40000000 }], section.addr, section.size)
        )
        .map((section) => ({ start: section.addr, end: section.addr + section.size }));
    const symbol = (name, required = false) => {
        const matches = result.symbols.filter((item) => item.name === name);
        if (!matches.length && !required) return null;
        if (
            matches.length !== 1 ||
            matches[0].size !== 4 ||
            matches[0].cppTypeUnavailable ||
            matches[0].addressAmbiguous ||
            !inRam(ranges, matches[0].address, 4)
        )
            throw failure(`${name} is missing, ambiguous or outside verified RAM`);
        return matches[0].address;
    };
    const currentAddress = symbol("pxCurrentTCB", true);
    const graph = layout?.runtimeLayout;
    const unwrap = (id) => {
        const seen = new Set();
        while (graph?.types?.[id]?.kind === "alias") {
            if (seen.has(id) || seen.size >= 32) throw failure("Cyclic TCB type");
            seen.add(id);
            id = graph.types[id].target;
        }
        const type = graph?.types?.[id];
        if (!type) throw failure("FreeRTOS kernel DWARF is unavailable");
        return type;
    };
    const pointer = unwrap(graph?.root);
    if (pointer.kind !== "pointer" || pointer.byteSize !== 4) throw failure("Expected an ARM32 TCB pointer");
    const tcb = unwrap(pointer.target);
    if (tcb.kind !== "class" || !Number.isInteger(tcb.byteSize) || tcb.byteSize < 16 || tcb.byteSize > 2048)
        throw failure("Unsupported TCB layout");
    const fields = {};
    for (const name of ["pxTopOfStack", "pxStack", "uxPriority", "pcTaskName", "uxTCBNumber"]) {
        const matches = (tcb.fields || []).filter((field) => field.name === name);
        if (!matches.length && name === "uxTCBNumber") continue;
        if (matches.length !== 1) throw failure(`Missing or ambiguous TCB.${name}`);
        const field = matches[0];
        const type = unwrap(field.type);
        const size = type.byteSize || (type.kind === "array" ? type.count * unwrap(type.target).byteSize : 0);
        if (
            !Number.isInteger(field.offset) ||
            field.offset < 0 ||
            !Number.isInteger(size) ||
            size < 1 ||
            field.offset + size > tcb.byteSize ||
            field.bitSize !== undefined
        )
            throw failure(`Invalid TCB.${name} bounds`);
        if (name === "pcTaskName") {
            if (type.kind !== "array" || size > 256 || unwrap(type.target).byteSize !== 1)
                throw failure("Invalid task name layout");
        } else if (size !== 4 || (name.startsWith("px") ? type.kind !== "pointer" : type.kind !== "scalar"))
            throw failure(`Unsupported TCB.${name} type`);
        fields[name] = { offset: field.offset, size };
    }
    return {
        image: result.elf.sha256,
        currentAddress,
        idleAddress: symbol("xIdleTaskHandle"),
        schedulerAddress: symbol("xSchedulerRunning"),
        ranges,
        tcb: { size: tcb.byteSize, fields },
        functions: (result.functions || [])
            .filter(
                (fn) =>
                    Number.isInteger(fn.address) &&
                    Number.isInteger(fn.size) &&
                    fn.size > 0 &&
                    fn.address + fn.size <= 0x100000000
            )
            .slice(0, 65536)
    };
}

function decodeTask(plan, address, bytes, time) {
    if (address % 4 || !inRam(plan.ranges, address, plan.tcb.size) || bytes.length !== plan.tcb.size) return null;
    const field = (name) => bytes.readUInt32LE(plan.tcb.fields[name].offset);
    const stack = field("pxStack"),
        saved = field("pxTopOfStack");
    if (!inRam(plan.ranges, stack, 4) || !inRam(plan.ranges, saved, 4) || field("uxPriority") > 255) return null;
    const nameField = plan.tcb.fields.pcTaskName;
    const nameBytes = bytes.subarray(nameField.offset, nameField.offset + nameField.size);
    const end = nameBytes.indexOf(0);
    if (end < 0) return null;
    const number = plan.tcb.fields.uxTCBNumber ? field("uxTCBNumber") : null;
    return {
        address,
        number,
        key: `${address.toString(16)}:${number ?? "unconfirmed"}`,
        name: nameBytes
            .subarray(0, end)
            .toString("utf8")
            .replace(/[\x00-\x1f\x7f]/g, ""),
        fingerprint: `${number}:${stack}:${nameBytes.toString("hex")}`,
        time,
        lifetimeConfirmed: number !== null
    };
}

function classifyCpuSample(sample) {
    if (sample.reason) return { kind: "unknown", reason: sample.reason };
    if (sample.beforeState !== "running" || sample.afterState !== "running")
        return { kind: "unknown", reason: "target-state" };
    if (sample.durationMs > sample.periodMs / 2) return { kind: "unknown", reason: "read-span" };
    if (sample.beforeTcb !== sample.afterTcb || sample.beforeException !== sample.afterException)
        return { kind: "unknown", reason: "transition" };
    if (sample.beforeException) return { kind: "exception", exception: sample.beforeException };
    if (!sample.task) return { kind: "unknown", reason: "task-unverified" };
    return { kind: sample.idle === sample.task.key ? "idle" : "task", taskKey: sample.task.key };
}

class CpuLoadWindow {
    constructor(start, windowMs = WINDOW_MS) {
        this.start = start;
        this.windowMs = windowMs;
        this.slots = [];
        this.history = [];
    }
    add(start, end, classification, pc = null) {
        start = Math.max(start, this.slots.at(-1)?.end ?? this.start);
        if (end <= start) return;
        this.slots.push({ start, end, ...classification, pc });
        while (this.slots.length > MAX_SLOTS) this.slots.shift();
    }
    summary(now, tasks, idle, capabilities) {
        const from = Math.max(this.start, now - this.windowMs);
        while (this.slots.length && this.slots[0].end <= from) this.slots.shift();
        const weights = { task: 0, idle: 0, exception: 0, unknown: 0 };
        const taskWeights = new Map(),
            pcs = new Map(),
            reasons = {},
            reasonWeights = {};
        let samples = 0,
            validSamples = 0,
            acquiredSamples = 0;
        for (const slot of this.slots) {
            const weight = Math.max(0, Math.min(now, slot.end) - Math.max(from, slot.start));
            if (!weight) continue;
            weights[slot.kind] += weight;
            samples++;
            if (slot.acquired) acquiredSamples++;
            if (slot.kind !== "unknown") validSamples++;
            else {
                const reason = slot.reason || "unobserved";
                reasons[reason] = (reasons[reason] || 0) + 1;
                reasonWeights[reason] = (reasonWeights[reason] || 0) + weight;
            }
            if (slot.taskKey) taskWeights.set(slot.taskKey, (taskWeights.get(slot.taskKey) || 0) + weight);
            if (slot.pc) pcs.set(slot.pc, (pcs.get(slot.pc) || 0) + weight);
        }
        const total = Math.max(0, now - from);
        const unobserved = Math.max(0, total - Object.values(weights).reduce((sum, value) => sum + value, 0));
        weights.unknown += unobserved;
        if (unobserved) reasonWeights.unobserved = (reasonWeights.unobserved || 0) + unobserved;
        const percent = (weight) => (total ? (weight * 100) / total : 0);
        const taskList = [...taskWeights]
            .sort((a, b) => b[1] - a[1])
            .map(([key, weight]) => {
                const task = tasks.get(key);
                const fresh = task && now - task.time <= 1000;
                return {
                    key,
                    address: task?.address,
                    number: task?.number,
                    name: fresh ? task.name : "",
                    verified: !!fresh,
                    lifetimeConfirmed: !!task?.lifetimeConfirmed,
                    percent: percent(weight)
                };
            });
        const hotspots = [...pcs].sort((a, b) => b[1] - a[1]);
        const coverage = percent(total - weights.unknown);
        const result = {
            metric: METRIC,
            window: { start: from, end: now, clock: "monotonic-ms" },
            windowMs: total,
            requestedWindowMs: this.windowMs,
            state: total < this.windowMs ? "collecting" : coverage < 80 ? "low-coverage" : "running",
            workloadPercent: idle ? percent(weights.task + weights.exception) : null,
            taskPercent: idle ? percent(weights.task) : null,
            idlePercent: idle ? percent(weights.idle) : null,
            exceptionPercent: percent(weights.exception),
            unknownPercent: percent(weights.unknown),
            coveragePercent: coverage,
            samples,
            validSamples,
            acquiredSamples,
            actualHz: total ? (acquiredSamples * 1000) / total : 0,
            unknownReasons: reasons,
            unknownReasonPercent: Object.fromEntries(
                Object.entries(reasonWeights).map(([reason, weight]) => [reason, percent(weight)])
            ),
            tasks: taskList.slice(0, 32),
            otherTaskPercent: taskList.slice(32).reduce((sum, task) => sum + task.percent, 0),
            hotspots: hotspots.slice(0, 20).map(([name, weight]) => ({ name, percent: percent(weight) })),
            otherHotspotPercent: percent(hotspots.slice(20).reduce((sum, entry) => sum + entry[1], 0)),
            capabilities
        };
        this.history.push({ t: now, workloadPercent: result.workloadPercent, unknownPercent: result.unknownPercent });
        if (this.history.length > 120) this.history.shift();
        return { ...result, history: [...this.history] };
    }
}

module.exports = { buildCpuLoadPlan, decodeTask, inRam, classifyCpuSample, CpuLoadWindow, WINDOW_MS, METRIC };
