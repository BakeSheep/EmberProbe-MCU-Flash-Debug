"use strict";
const assert = require("assert");
const { samplerFixture, taskBytes } = require("./helpers/cpu-load-fixture");
const { REGISTERS, word } = require("../src/services/cpuLoadSampler");

(async () => {
    for (const core of [0xc20, 0xc60, 0xc23, 0xc24, 0xc27]) {
        const f = samplerFixture({ core, pcsr: true });
        try {
            await f.sampler.tick();
            assert(f.sampler.capabilities.core.startsWith("Cortex-M"));
            assert.strictEqual(f.sampler.window.slots.at(-1).kind, "idle");
            const basic = ![0xc20, 0xc60].includes(core);
            assert.strictEqual(f.sampler.capabilities.pcsr, basic);
            f.state.exception = 15;
            f.setTime(f.sampler.nextSlot);
            await f.sampler.tick();
            assert.strictEqual(f.sampler.window.slots.at(-1).kind, "exception");
            f.state.exception = 0;
            f.state.tcb = 0x20000200;
            f.setTime(f.sampler.nextSlot);
            await f.sampler.tick();
            assert.strictEqual(f.sampler.window.slots.at(-1).kind, "task");
            f.state.pc = 0xffffffff;
            f.setTime(f.sampler.nextSlot);
            await f.sampler.tick();
            assert.strictEqual(
                f.sampler.window.slots.at(-1).kind,
                "task",
                "invalid PC preserves the base classification"
            );
            assert.strictEqual(f.sampler.window.slots.at(-1).pc, null);
            f.state.afterTcb = 0x20000100;
            f.setTime(f.sampler.nextSlot);
            await f.sampler.tick();
            assert.strictEqual(f.sampler.window.slots.at(-1).reason, "transition");
            assert.throws(() => f.sampler.read(0xe000edf0), /whitelist/);
            assert.throws(() => f.sampler.read(REGISTERS.icsr, 8), /whitelist/);
            assert(
                f.commands.every((command) => !/write_memory|\bhalt\b|\bresume\b|\bprofile\b|e000edf0/i.test(command))
            );
        } finally {
            f.sampler.stop();
        }
    }
    // H7 creates a mem_ap access target in addition to its single Cortex-M CPU.
    // Classify by type, regardless of names or target ordering.
    for (const names of ["stm32h7x.ap2 stm32h7x.cpu0", "stm32h7x.cpu0 stm32h7x.ap2", "cpu ap2"]) {
        const f = samplerFixture({ core: 0xc27 });
        try {
            const cpu = names === "cpu ap2" ? "ap2" : "stm32h7x.cpu0";
            const auxiliary = names === "cpu ap2" ? "cpu" : "stm32h7x.ap2";
            f.state.targets = names;
            f.state.currentTarget = cpu;
            f.state.targetTypes[auxiliary] = "mem_ap";
            await f.sampler.tick();
            assert.strictEqual(f.sampler.capabilities.core, "Cortex-M7");
            assert.strictEqual(f.sampler.capabilities.coreTarget, cpu);
            assert.deepStrictEqual(f.sampler.capabilities.auxiliaryTargets, [auxiliary]);
            assert.strictEqual(f.sampler.window.slots.at(-1).kind, "idle");
            assert(f.commands.some((command) => command.includes(`${cpu} read_memory`)));
            assert(!f.commands.some((command) => command.includes(`${auxiliary} read_memory`)));
            assert(
                f.commands.every((command) => !/\btargets\s|configure|write_memory|\bhalt\b|\bresume\b/.test(command))
            );
            f.state.currentTarget = auxiliary;
            f.setTime(f.sampler.nextSlot);
            await f.sampler.tick();
            assert.strictEqual(f.sampler.window, null, "a selection change ends the window");
            assert.strictEqual(f.events.at(-1).state, "paused");
            f.sampler.stop();
            assert.strictEqual(f.sampler.target, null, "stop clears the target binding");
        } finally {
            f.sampler.stop();
        }
    }
    for (const inventory of [
        "cpu0\ncpu0\ncortex_m\nlittle\ncpu1\ncortex_m\nlittle",
        "cpu\ncpu\ncortex_m\nlittle\nother\nriscv\nlittle",
        "ap2\nap2\nmem_ap\nlittle\ncpu\ncortex_m\nlittle",
        "cpu\ncpu\nmem_ap\nlittle",
        "cpu\ncpu\ncortex_m\nbig",
        "cpu\ncpu\ncortex_m\nlittle\ncpu\nmem_ap\nlittle",
        "cpu\ncpu;halt\ncortex_m\nlittle",
        "cpu\ncpu\ncortex_m",
        "",
        ["cpu", ...Array.from({ length: 33 }, (_, index) => [`cpu${index}`, "cortex_m", "little"]).flat()].join("\n")
    ]) {
        const f = samplerFixture();
        try {
            f.state.inventory = inventory;
            await f.sampler.tick();
            assert.strictEqual(f.events.at(-1).state, "unavailable", inventory);
            assert.strictEqual(f.commands.length, 1, "invalid inventory must not read target memory");
        } finally {
            f.sampler.stop();
        }
    }
    for (const mode of [
        "busy",
        "variable",
        "budget",
        "shared-budget",
        "backpressure",
        "latency",
        "failure",
        "disconnected"
    ]) {
        const f = samplerFixture();
        try {
            await f.sampler.tick();
            if (mode === "busy") f.owner.busy = true;
            if (mode === "variable") {
                f.owner.samplingEnabled = true;
                f.owner.watch = [{}];
            }
            if (mode === "budget") f.sampler.costs = [{ time: f.time, duration: 200 }];
            if (mode === "shared-budget") f.owner._recentTclCosts = [{ time: f.time, duration: 700 }];
            if (mode === "backpressure") f.owner.cpuDeliveryBlocked = true;
            if (mode === "latency") f.state.latency = 20;
            if (mode === "failure") f.state.fail = true;
            if (mode === "disconnected") f.owner.socket.destroyed = true;
            f.setTime(f.sampler.nextSlot);
            await f.sampler.tick();
            assert.strictEqual(f.sampler.window.slots.at(-1).kind, "unknown", mode);
            if (mode === "latency") assert(f.sampler.period >= 100);
            f.advance(50);
            await f.sampler.tick();
            assert(f.sampler.window.slots.some((slot) => slot.reason === "missed-slot"));
        } finally {
            f.sampler.stop();
        }
    }
    const manual = samplerFixture({ idle: false, numbered: false });
    try {
        await manual.sampler.tick();
        assert.strictEqual(manual.sampler.idle, null);
        const key = [...manual.sampler.tasks.keys()][0];
        manual.sampler.selectIdle(key);
        assert.strictEqual(manual.sampler.idle, key);
        manual.memory.set(0x20000100, taskBytes(manual.plan, "Reused"));
        manual.advance(1001);
        const run = manual.sampler.run;
        await manual.sampler.tick();
        assert(manual.sampler.run > run, "address reuse ends the old window");
        assert.strictEqual(manual.sampler.idle, null);
        assert.throws(() => manual.sampler.selectIdle("missing"), /verified/);
        manual.sampler.pause("debug-control");
        assert.strictEqual(manual.sampler.window, null);
        manual.sampler.pause(null);
        assert(manual.sampler.window);
    } finally {
        manual.sampler.stop();
    }
    const inactive = samplerFixture();
    try {
        inactive.state.scheduler = 0;
        await inactive.sampler.tick();
        assert.strictEqual(inactive.events.at(-1).state, "waiting");
        inactive.state.scheduler = 1;
        inactive.advance(1001);
        await inactive.sampler.tick();
        assert(inactive.events.at(-1).needsMetadataRefresh);
        inactive.sampler.configure(inactive.plan);
        inactive.state.target = "halted";
        inactive.advance(10);
        await inactive.sampler.tick();
        assert.strictEqual(inactive.sampler.window, null);
        inactive.state.target = "running";
        inactive.advance(100);
        await inactive.sampler.tick();
        assert(inactive.sampler.window);
    } finally {
        inactive.sampler.stop();
    }
    const numbered = samplerFixture({ idle: false });
    try {
        await numbered.sampler.tick();
        const oldKey = [...numbered.sampler.tasks.keys()][0];
        numbered.memory.set(0x20000100, taskBytes(numbered.plan, "New task", 10));
        numbered.advance(1001);
        await numbered.sampler.tick();
        assert.strictEqual(numbered.sampler.tasks.get(oldKey).time, -Infinity);
        assert.throws(() => numbered.sampler.selectIdle(oldKey), /fresh/);
        numbered.owner._pauseReason = "paused";
        numbered.setTime(numbered.sampler.nextSlot);
        await numbered.sampler.tick();
        assert.strictEqual(numbered.sampler.window.slots.at(-1).kind, "task", "variable pause must not pause CPU");
        numbered.sampler.period = 20;
        numbered.setTime(numbered.sampler.nextSlot);
        await numbered.sampler.tick();
        const adaptiveSlot = numbered.sampler.window.slots.at(-1);
        assert.strictEqual(adaptiveSlot.kind, "task", "planned adaptive slots remain valid observations");
        assert.strictEqual(adaptiveSlot.end - adaptiveSlot.start, 20);
    } finally {
        numbered.sampler.stop();
    }
    const adaptive = samplerFixture();
    try {
        adaptive.state.latency = 2.5;
        while (adaptive.time < 22000) {
            adaptive.setTime(adaptive.sampler.nextSlot);
            await adaptive.sampler.tick();
        }
        const summary = adaptive.sampler.window.summary(
            adaptive.time,
            adaptive.sampler.tasks,
            adaptive.sampler.idle,
            {}
        );
        assert(summary.actualHz > 50 && summary.actualHz < 100, "adapt to the simulated slow link");
        assert(summary.coveragePercent > 95, "deliberate lower resolution is not lost coverage");
        assert(summary.idlePercent > 95);
        assert.strictEqual(summary.workloadPercent, 0);
        assert(!summary.unknownReasons["rate-limited"]);
        assert(adaptive.sampler.costs.reduce((sum, cost) => sum + cost.duration, 0) <= 200);
        const slowedPeriod = adaptive.sampler.period;
        adaptive.state.latency = 0.1;
        const recoverUntil = adaptive.time + 4000;
        while (adaptive.time < recoverUntil) {
            adaptive.setTime(adaptive.sampler.nextSlot);
            await adaptive.sampler.tick();
        }
        assert(adaptive.sampler.period < slowedPeriod, "recover when transport becomes faster");
        assert.strictEqual(adaptive.sampler.period, 5, "200 Hz remains the upper limit");
        adaptive.owner.busy = true;
        adaptive.setTime(adaptive.sampler.nextSlot);
        await adaptive.sampler.tick();
        assert.strictEqual(adaptive.sampler.window.slots.at(-1).reason, "transaction-or-variable");
        assert(adaptive.sampler.period > 5, "back off for transaction pressure");
        adaptive.owner.busy = false;
        adaptive.setTime(adaptive.sampler.nextSlot + 50);
        await adaptive.sampler.tick();
        assert(
            adaptive.sampler.window.slots.some((slot) => slot.reason === "missed-slot"),
            "real lateness stays unknown"
        );
    } finally {
        adaptive.sampler.stop();
    }
    for (const configure of [
        (f) => {
            f.state.targets = "cpu0 cpu1";
        },
        (f) => {
            f.state.fail = true;
        }
    ]) {
        const f = samplerFixture();
        try {
            configure(f);
            await f.sampler.tick();
            assert.strictEqual(f.events.at(-1).state, "unavailable");
        } finally {
            f.sampler.stop();
        }
    }
    assert.strictEqual(word("0xffffffff"), 0xffffffff);
    const stale = samplerFixture();
    try {
        let finish;
        stale.owner._sendCheckedCommand = () =>
            new Promise((resolve) => {
                finish = resolve;
            });
        const oldRead = stale.sampler.tick();
        stale.sampler.configure({ ...stale.plan, generation: 2 });
        finish("cpu");
        await oldRead;
        assert.strictEqual(stale.sampler.tasks.size, 0);
        assert.strictEqual(stale.sampler.period, 5);
        assert(!stale.events.some((event) => event.generation === 2 && event.state === "unavailable"));
    } finally {
        stale.sampler.stop();
    }
    for (const value of ["bad", "-1", "4294967296", "1 2"]) assert.throws(() => word(value));
    console.log("CPU sampler capabilities, read safety, scheduling and identity tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
