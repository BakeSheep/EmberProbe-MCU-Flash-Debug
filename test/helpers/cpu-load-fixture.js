"use strict";
const { buildCpuLoadPlan } = require("../../src/services/cpuLoadModel");
const { CpuLoadSampler, REGISTERS } = require("../../src/services/cpuLoadSampler");

function metadata(shift = 0, numbered = true) {
    const result = {
        elf: { machine: 40, elfClass: 1, encoding: 1, sha256: "image" },
        memory: { sections: [{ flags: 3, addr: 0x20000000, size: 0x10000 }] },
        symbols: ["pxCurrentTCB", "xIdleTaskHandle", "xSchedulerRunning"].map((name, index) => ({
            name,
            address: 0x20000000 + index * 4,
            size: 4
        })),
        functions: [{ name: "shared", address: 0x08001000, size: 100 }]
    };
    const types = [
        { kind: "alias", target: 1 },
        { kind: "pointer", byteSize: 4, target: 2 },
        {
            kind: "class",
            byteSize: 36 + shift,
            fields: [
                { name: "pxTopOfStack", offset: 0, type: 3 },
                { name: "pxStack", offset: 4 + shift, type: 3 },
                { name: "uxPriority", offset: 8 + shift, type: 4 },
                { name: "pcTaskName", offset: 12 + shift, type: 5 },
                ...(numbered ? [{ name: "uxTCBNumber", offset: 32 + shift, type: 4 }] : [])
            ]
        },
        { kind: "pointer", byteSize: 4, target: 4 },
        { kind: "scalar", byteSize: 4 },
        { kind: "array", count: 20, target: 6 },
        { kind: "scalar", byteSize: 1 }
    ];
    return { result, layout: { runtimeLayout: { root: 0, types } } };
}

function taskBytes(plan, name, number = 1) {
    const bytes = Buffer.alloc(plan.tcb.size);
    for (const [field, value] of [
        ["pxTopOfStack", 0x20008040],
        ["pxStack", 0x20008000],
        ["uxPriority", 0]
    ])
        bytes.writeUInt32LE(value, plan.tcb.fields[field].offset);
    if (plan.tcb.fields.uxTCBNumber) bytes.writeUInt32LE(number, plan.tcb.fields.uxTCBNumber.offset);
    bytes.write(name, plan.tcb.fields.pcTaskName.offset);
    return bytes;
}

function samplerFixture({ core = 0xc24, numbered = true, idle = true, pcsr = false } = {}) {
    const data = metadata(0, numbered);
    if (!idle) data.result.symbols = data.result.symbols.filter((entry) => entry.name !== "xIdleTaskHandle");
    const plan = { ...buildCpuLoadPlan(data.result, data.layout), identity: { connection: 1 }, generation: 1 };
    let clock = 0;
    const state = {
        tcb: 0x20000100,
        exception: 0,
        afterTcb: null,
        afterException: null,
        target: "running",
        scheduler: 1,
        pc: 0x08001001,
        latency: 0.05,
        fail: false,
        targets: "cpu",
        currentTarget: null,
        targetTypes: {},
        targetEndians: {},
        inventory: null
    };
    const memory = new Map([
        [0x20000100, taskBytes(plan, "Idle", 1)],
        [0x20000200, taskBytes(plan, "Worker", 2)]
    ]);
    const events = [],
        commands = [],
        delays = [];
    const owner = {
        handlers: { onCpuLoad: (result) => events.push(result) },
        busy: false,
        queue: [],
        watch: [],
        samplingEnabled: false,
        stopped: false,
        socket: { destroyed: false },
        readCmd: "ocd_read_memory",
        effectiveIntervalMs: 5,
        _sendCheckedCommand: async (command) => {
            commands.push(command);
            clock += state.latency;
            if (state.fail) throw new Error("read failed");
            if (command.includes("cget -type")) {
                const names = state.targets.trim().split(/\s+/).filter(Boolean);
                return (
                    state.inventory ??
                    [
                        state.currentTarget ?? names[0],
                        ...names.flatMap((name) => [
                            name,
                            state.targetTypes[name] || "cortex_m",
                            state.targetEndians[name] || "little"
                        ])
                    ].join("\n")
                );
            }
            if (command.includes("curstate"))
                return [
                    state.currentTarget && state.currentTarget !== sampler.target ? "target-changed" : state.target,
                    state.tcb,
                    state.exception,
                    state.pc,
                    state.afterException ?? state.exception,
                    state.afterTcb ?? state.tcb,
                    state.currentTarget && state.currentTarget !== sampler.target ? "target-changed" : state.target
                ].join("\n");
            const reads = [...command.matchAll(/(?:ocd_)?read_memory 0x([\da-f]+) (8|32) (\d+)/gi)];
            return reads
                .map((read) => {
                    const address = parseInt(read[1], 16);
                    if (read[2] === "8") return [...(memory.get(address) || [])].join(" ");
                    const values = new Map([
                        [REGISTERS.cpuid, 0x41000000 | (core << 4)],
                        [REGISTERS.demcr, pcsr ? 0x01000000 : 0],
                        [REGISTERS.dwt, 0],
                        [plan.currentAddress, state.tcb],
                        [plan.idleAddress, 0x20000100],
                        [plan.schedulerAddress, state.scheduler]
                    ]);
                    return String(values.get(address) ?? 0);
                })
                .join("\n");
        }
    };
    const sampler = new CpuLoadSampler(owner, {
        now: () => clock,
        random: () => 0.5,
        schedule: (delay) => {
            delays.push(delay);
            return { cancel() {} };
        }
    });
    sampler.configure(plan);
    return {
        sampler,
        owner,
        plan,
        state,
        memory,
        events,
        commands,
        delays,
        get time() {
            return clock;
        },
        advance: (ms) => {
            clock += ms;
        },
        setTime: (ms) => {
            clock = ms;
        }
    };
}
module.exports = { metadata, taskBytes, samplerFixture };
