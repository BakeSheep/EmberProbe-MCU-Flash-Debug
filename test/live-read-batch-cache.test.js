"use strict";
const assert = require("assert");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

const BASE = 0x20000000;
const TICKS = 1000;

async function countReadCompilations(operation) {
    const originalSort = Array.prototype.sort;
    let count = 0;
    // compileReadBatches sorts a copy of the fixed items; count work without a production test hook.
    Array.prototype.sort = function (compare) {
        if (this.length && typeof this[0]?.address === "number") count++;
        return originalSort.call(this, compare);
    };
    try {
        await operation();
        return count;
    } finally {
        Array.prototype.sort = originalSort;
    }
}

function readerFixture() {
    const fixture = { fake: new FakeOpenOcdServer(), batches: new Set(), last: null };
    const session = new ManagedOpenOcdSession(
        null,
        {},
        {
            onSample: (samples, t, due) => {
                fixture.last = { samples, t, due };
            }
        }
    );
    fixture.session = session;
    // Exercise actual batch commands and parsing entirely in memory, without opening sockets or timers.
    session.socket = { destroyed: false };
    session._scheduleNext = () => {};
    session._recordCycle = () => {};
    session._sendCheckedCommand = async (command) => {
        const result = fixture.fake._execute(command);
        if (!result.ok) throw new Error(result.response);
        return result.response;
    };
    const readBatch = session._readBatchBytes.bind(session);
    session._readBatchBytes = async (batch) => {
        fixture.batches.add(batch);
        return readBatch(batch);
    };
    return fixture;
}

function assertFixedSamples(samples, items, fake, t) {
    assert.deepStrictEqual(
        samples,
        items.map((item) => ({ name: item.name, bytes: fake.bytes(item.address, item.size), t }))
    );
}

function runtimeItem(name, address) {
    return {
        name,
        address,
        size: 4,
        runtimeLayout: {
            root: 0,
            types: [{ kind: "scalar", typeName: "unsigned int", byteSize: 4, watchType: "u32" }]
        },
        runtimeRanges: [{ start: BASE, end: BASE + 8192 }]
    };
}

(async () => {
    const plain = readerFixture();
    const right = { name: "right", address: BASE + 32, size: 4 };
    const left = { name: "left", address: BASE, size: 4 };
    const alias = { name: "alias", address: BASE, size: 2 };
    const overlap = { name: "overlap", address: BASE + 2, size: 4 };
    plain.session.setWatch([right, left, alias, overlap]);
    const plainCompilations = await countReadCompilations(async () => {
        for (let tick = 0; tick < TICKS; tick++) {
            plain.fake.seed(BASE, [tick & 0xff, 2, 3, 4, 5, 6]);
            plain.fake.seed(BASE + 32, [(tick + 1) & 0xff, 8, 9, 10]);
            await plain.session._sampleTick();
            assertFixedSamples(plain.last.samples, [left, alias, overlap, right], plain.fake, plain.last.t);
        }
    });
    assert.strictEqual(plainCompilations, 0, "plain ticks must reuse the batches compiled by setWatch");
    assert.strictEqual(plain.batches.size, 1, "each tick must pass the same batch object to the reader");
    assert.strictEqual(plain.fake.commands.length, TICKS);
    assert.strictEqual(
        plain.fake.commands[0],
        'join [list [ocd_read_memory 0x20000000 16 3] [ocd_read_memory 0x20000020 32 1]] "\\n"'
    );
    assert.ok(plain.fake.commands.every((command) => command === plain.fake.commands[0]));

    const originalNow = Date.now;
    try {
        Date.now = () => {
            throw new Error("Fixed reads must not allocate a runtime deadline");
        };
        assertFixedSamples(
            (await plain.session._readItems(plain.session.watch, 1)).samples,
            [left, alias, overlap, right],
            plain.fake,
            1
        );
    } finally {
        Date.now = originalNow;
    }

    const renamed = { name: "renamed", address: BASE + 64, size: 2 };
    const resized = { name: "right", address: BASE + 32, size: 2 };
    plain.fake.seed(renamed.address, [7, 8]);
    plain.fake.seed(resized.address, [11, 12]);
    const replacementCompilations = await countReadCompilations(async () => {
        plain.session.setWatch([renamed, resized]);
        for (let tick = 0; tick < 100; tick++) {
            await plain.session._sampleTick();
            assertFixedSamples(plain.last.samples, [resized, renamed], plain.fake, plain.last.t);
        }
    });
    assert.strictEqual(replacementCompilations, 1, "watch replacement compiles once and returns only the new items");
    assert.strictEqual(plain.batches.size, 2);
    const previousBatch = [...plain.batches].at(-1);
    plain.session.setWatch(plain.session.watch);
    await plain.session._sampleTick();
    assert.notStrictEqual([...plain.batches].at(-1), previousBatch, "setWatch invalidates even an identical list");

    const layered = readerFixture();
    const sidebar = { name: "sidebar", address: BASE + 16, size: 4 };
    layered.session.setSamplingPlan({ graphItems: [right, left], sidebarItems: [sidebar], graphIntervalMs: 7 });
    layered.session.effectiveIntervalMs = 7;
    const plan = layered.session.ratePlan;
    const due = plan.due.bind(plan);
    let clock = 0;
    layered.session.ratePlan.due = (_clock, interval) => due(clock, interval);
    const subsets = new Set();
    const layeredCompilations = await countReadCompilations(async () => {
        for (let tick = 0; tick < TICKS; tick++) {
            for (const item of plan.items) layered.fake.seed(item.address, [tick & 0xff, 2, 3, 4]);
            await layered.session._sampleTick();
            const current = layered.last.due;
            subsets.add(current.graphNames.length ? (current.sidebarNames.length ? "both" : "graph") : "sidebar");
            const names = [...new Set([...current.graphNames, ...current.sidebarNames])];
            assertFixedSamples(
                layered.last.samples,
                names.map((name) => plan.byName.get(name)),
                layered.fake,
                layered.last.t
            );
            clock += plan.delay(clock);
        }
    });
    assert.strictEqual(subsets.size, 3, "exercise graph-only, sidebar-only and combined reads");
    assert.strictEqual(layeredCompilations, 3, "fresh due arrays must compile each ordered subset only once");
    assert.strictEqual(layered.batches.size, 3, "multi-rate reads must reuse the same three batch objects");
    const next = { name: "next", address: BASE + 96, size: 2 };
    layered.fake.seed(next.address, [41, 42]);
    const newPlanCompilations = await countReadCompilations(async () => {
        layered.session.setSamplingPlan({ graphItems: [next], sidebarItems: [], graphIntervalMs: 7 });
        const nextDue = layered.session.ratePlan.due(0, 7);
        assertFixedSamples((await layered.session._readItems(nextDue.items, 2)).samples, [next], layered.fake, 2);
    });
    assert.strictEqual(newPlanCompilations, 1, "sampling-plan replacement must seed a fresh cache");

    const mutable = readerFixture();
    const item = { name: "mutable", address: BASE, size: 4 };
    mutable.session.setWatch([item]);
    mutable.fake.seed(BASE, [1, 2, 3, 4]);
    mutable.fake.seed(BASE + 128, [5, 6, 7, 8]);
    const mutationCompilations = await countReadCompilations(async () => {
        for (const [key, value] of [
            ["name", "changed"],
            ["address", BASE + 128],
            ["size", 2]
        ]) {
            item[key] = value;
            for (let tick = 0; tick < 10; tick++) {
                assertFixedSamples(
                    (await mutable.session._readItems([item], tick)).samples,
                    [item],
                    mutable.fake,
                    tick
                );
            }
        }
        Object.assign(item, { name: "mutable", address: BASE, size: 4 });
        assertFixedSamples((await mutable.session._readItems([item], 0)).samples, [item], mutable.fake, 0);
    });
    assert.strictEqual(mutationCompilations, 3, "name, address and size changes invalidate identity matches");
    const reorderedCompilations = await countReadCompilations(async () => {
        for (const items of [
            [left, alias],
            [alias, left],
            [left, alias]
        ]) {
            assertFixedSamples((await mutable.session._readItems(items, 0)).samples, items, mutable.fake, 0);
        }
    });
    assert.strictEqual(reorderedCompilations, 2, "equal-address variables retain each subset input order");
    const churnCompilations = await countReadCompilations(async () => {
        for (let index = 0; index < 16; index++) {
            await mutable.session._readItems([{ name: "one-shot-" + index, address: BASE + index * 8, size: 1 }], 0);
        }
        assertFixedSamples((await mutable.session._readItems([item], 0)).samples, [item], mutable.fake, 0);
    });
    assert.strictEqual(churnCompilations, 17, "one-shot reads must evict old subsets from the bounded cache");

    const fallback = readerFixture();
    fallback.session.setWatch([right, left]);
    fallback.fake.rejectBatchCommand = true;
    fallback.fake.seed(left.address, [1, 2, 3, 4]);
    fallback.fake.seed(right.address, [5, 6, 7, 8]);
    const fallbackCompilations = await countReadCompilations(async () => {
        for (let tick = 0; tick < 20; tick++) {
            await fallback.session._sampleTick();
            assertFixedSamples(fallback.last.samples, [left, right], fallback.fake, fallback.last.t);
        }
    });
    assert.strictEqual(fallbackCompilations, 0);
    assert.strictEqual(fallback.session._batchUnsupported, true);
    assert.strictEqual(fallback.fake.commands.filter((command) => command.startsWith("join [list")).length, 1);
    assert.strictEqual(fallback.fake.commands.length, 41, "fallback reads the same groups separately on every tick");

    for (const mode of ["debug", "standalone"]) {
        const runtime = readerFixture();
        runtime.session.mode = mode;
        const big = { name: "big", address: BASE, size: 1536 };
        const bigAlias = { name: "big-alias", address: BASE, size: 4 };
        const tail = { name: "tail", address: BASE + 2048, size: 4 };
        const firstRuntime = runtimeItem("runtime-a", BASE + 3072);
        const secondRuntime = runtimeItem("runtime-b", BASE + 3076);
        runtime.session.setWatch([big, firstRuntime, bigAlias, secondRuntime, tail]);
        runtime.fake.seed(
            BASE,
            Array.from({ length: big.size }, (_, index) => index & 0xff)
        );
        const deadline = Date.now() + 30000;
        const budgets = [];
        const originalSample = RuntimeObjectReader.prototype.sample;
        RuntimeObjectReader.prototype.sample = async function () {
            budgets.push({ budget: this.budget, bytes: this.budget.bytes, commands: this.budget.commands });
            return originalSample.call(this);
        };
        let runtimeCompilations;
        try {
            runtimeCompilations = await countReadCompilations(async () => {
                for (let tick = 0; tick < 100; tick++) {
                    runtime.fake.seed(firstRuntime.address, [tick, 0, 0, 0]);
                    runtime.fake.seed(secondRuntime.address, [tick + 1, 0, 0, 0]);
                    const result = await runtime.session._readItems(runtime.session.watch, tick, {
                        epoch: runtime.session.sampleEpoch,
                        deadline
                    });
                    assert.strictEqual(result.ok, 5);
                    assert.deepStrictEqual(
                        result.samples.slice(0, 2).map((sample) => sample.name),
                        ["runtime-a", "runtime-b"]
                    );
                    assert.deepStrictEqual(
                        result.samples.slice(0, 2).map((sample) => sample.runtimeTree.value),
                        [tick, tick + 1]
                    );
                    assertFixedSamples(result.samples.slice(2), [big, bigAlias, tail], runtime.fake, tick);
                }
            });
        } finally {
            RuntimeObjectReader.prototype.sample = originalSample;
        }
        assert.strictEqual(
            runtimeCompilations,
            0,
            "runtime budgeting and fixed reads reuse the precompiled fixed subset"
        );
        for (let tick = 0; tick < 100; tick++) {
            const first = budgets[tick * 2];
            const second = budgets[tick * 2 + 1];
            // Debug mode reserves fixed reads in the per-cycle budget; standalone fixed reads are unbudgeted.
            const fixedBytes = mode === "debug" ? 1544 : 0;
            const fixedCommands = mode === "debug" ? 3 : 0;
            assert.strictEqual(first.bytes, fixedBytes, "debug budget reserves item sizes even for overlapping items");
            assert.strictEqual(first.commands, fixedCommands, "debug budget counts split transfer units");
            assert.strictEqual(second.bytes, fixedBytes + 4);
            assert.strictEqual(second.commands, fixedCommands + 1);
            assert.strictEqual(first.budget, second.budget, "runtime items share the per-cycle budget");
            assert.strictEqual(first.budget.deadline, deadline);
            if (tick) assert.notStrictEqual(first.budget, budgets[(tick - 1) * 2].budget, "budgets reset each tick");
        }
    }

    for (const fixedItems of [
        [{ name: "all-bytes", address: BASE, size: 4096 }],
        Array.from({ length: 32 }, (_, index) => ({ name: "command-" + index, address: BASE + index * 8, size: 1 }))
    ]) {
        const watch = [...fixedItems, runtimeItem("limited-runtime", BASE + 6144)];
        const limited = readerFixture();
        limited.session.mode = "debug";
        // Debug planning would reject this plan; the cycle itself must still stop the runtime read.
        limited.session.watch = watch;
        limited.session._readBatchCache = [];
        const result = await limited.session._readItems(limited.session.watch, 0);
        assert.strictEqual(result.samples[0].diagnostic.code, "LIVE_READ_BUDGET_EXCEEDED");
        assert.ok(result.samples.slice(1).every((sample) => sample.bytes?.length > 0));
        assert.ok(limited.fake.commands.every((command) => !command.includes("0x20001800")));

        const standalone = readerFixture();
        standalone.session.setWatch(watch);
        standalone.fake.seed(BASE + 6144, [7, 0, 0, 0]);
        const independent = await standalone.session._readItems(standalone.session.watch, 0);
        assert.strictEqual(
            independent.samples[0].runtimeTree.value,
            7,
            "standalone fixed reads leave the runtime budget"
        );
        assert.ok(independent.samples.slice(1).every((sample) => sample.bytes?.length > 0));
    }

    const guarded = readerFixture();
    guarded.session.setWatch(
        Array.from({ length: 10 }, (_, index) => ({
            name: "guarded-" + index,
            address: BASE + index * 8,
            size: 1
        }))
    );
    const guardedBatch = guarded.session._readBatchBytes.bind(guarded.session);
    guarded.session._readBatchBytes = async (batch) => {
        const bytes = await guardedBatch(batch);
        guarded.session.sampleEpoch++;
        return bytes;
    };
    const guardedCompilations = await countReadCompilations(async () => {
        await assert.rejects(
            guarded.session._readItems(guarded.session.watch, 0, {
                epoch: guarded.session.sampleEpoch,
                requireSampling: true,
                deadline: Date.now() + 1000
            }),
            { code: "LIVE_READ_CANCELLED" }
        );
    });
    assert.strictEqual(guardedCompilations, 0);
    assert.strictEqual(guarded.fake.commands.length, 1, "cached batches still stop after a generation change");
    await assert.rejects(
        guarded.session._readItems(guarded.session.watch, 0, {
            epoch: guarded.session.sampleEpoch,
            deadline: Date.now() - 1
        }),
        { code: "LIVE_READ_BUDGET_EXCEEDED" }
    );
    assert.strictEqual(guarded.fake.commands.length, 1, "an expired guard must prevent every cached batch read");

    console.log(
        "Read-batch cache: " +
            TICKS +
            " plain ticks compiled " +
            plainCompilations +
            " times; " +
            TICKS +
            " multi-rate ticks compiled " +
            layeredCompilations +
            " times"
    );
    console.log("Read-batch cache invalidation, ordering, fallback, runtime budgets and guards passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
