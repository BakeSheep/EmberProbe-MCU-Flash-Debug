"use strict";
const assert = require("assert");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

const base = 0x20000000;
const word = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const scalar = { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" };
const pointer = { kind: "pointer", target: 0, byteSize: 4 };
const vector = {
    kind: "class",
    byteSize: 12,
    typeName: "std::vector<int>",
    stl: "vector",
    args: [0],
    fields: ["_M_start", "_M_finish", "_M_end_of_storage"].map((name, index) => ({ name, offset: index * 4, type: 1 }))
};
const item = () => ({
    name: "values[1]",
    address: base,
    size: 12,
    runtimeLayout: { root: 2, types: [scalar, pointer, vector] },
    runtimeSegments: [{ kind: "index", index: 1 }],
    runtimeRanges: [{ start: base, end: base + 0x4000 }]
});

// A vector of three ints whose storage starts at `storage`.
function seedVector(fake, storage, values) {
    fake.seed(base, [...word(storage), ...word(storage + values.length * 4), ...word(storage + values.length * 4)]);
    values.forEach((value, index) => fake.seed(storage + index * 4, word(value)));
}

async function fixture(scatterVersion = "1") {
    const fake = new FakeOpenOcdServer();
    fake.scatterVersion = scatterVersion;
    await fake.start();
    const session = new ManagedOpenOcdSession(null, { mode: "standalone" }, {});
    session._scheduleNext = () => {};
    session.socket = await fake.connect();
    session._setupSocket();
    session.noEchoResponses = true;
    await session._detectScatter();
    return { fake, session };
}

async function close({ fake, session }) {
    await session.stop(50);
    await fake.stop();
}

const scatterCount = (fake) => fake.commands.filter((cmd) => cmd.startsWith("emberprobe_read_scatter {")).length;
const singleCount = (fake) => fake.commands.filter((cmd) => /^(?:ocd_)?read_memory /.test(cmd)).length;

async function cycle(context, watched) {
    const { fake } = context;
    fake.commands.length = 0;
    const { samples } = await context.session._readItems([watched], Date.now());
    return {
        tree: samples[0].runtimeTree,
        diagnostic: samples[0].diagnostic,
        scatter: scatterCount(fake),
        single: singleCount(fake)
    };
}

(async () => {
    // Steady state: the second cycle prefetches the previous reads in one request and verifies at once.
    {
        const context = await fixture();
        try {
            const watched = item();
            seedVector(context.fake, base + 0x100, [10, 20, 30]);
            const first = await cycle(context, watched);
            assert.strictEqual(first.tree.value, 20);
            assert.ok(first.single >= 2, "the first cycle has no plan and reads one block at a time");
            const second = await cycle(context, watched);
            assert.strictEqual(second.tree.value, 20);
            assert.strictEqual(second.single, 0, "every read comes from the prefetched plan");
            assert.ok(second.scatter <= 2, "one prefetch and at most one descriptor check");

            context.fake.seed(base + 0x104, word(21));
            assert.strictEqual((await cycle(context, watched)).tree.value, 21, "prefetched values are current");

            // Moved storage: the stale plan misses, the new element is read alone and becomes the next plan.
            seedVector(context.fake, base + 0x800, [40, 50, 60]);
            const moved = await cycle(context, watched);
            assert.strictEqual(moved.tree.value, 50);
            assert.ok(moved.single >= 1);
            const settled = await cycle(context, watched);
            assert.strictEqual(settled.tree.value, 50);
            assert.strictEqual(settled.single, 0);

            // A new watch list forgets plans.
            context.session.setWatch([watched]);
            assert.ok((await cycle(context, watched)).single >= 2);
            context.session.invalidateTarget();
            assert.ok((await cycle(context, watched)).single >= 2);
        } finally {
            await close(context);
        }
    }

    // A stale plan that pushes the shared cycle budget over is dropped and the object is read again.
    {
        const context = await fixture();
        try {
            const watched = item();
            seedVector(context.fake, base + 0x100, [1, 2, 3]);
            // The plan costs 28 bytes (16 read, 12 descriptor check); after the move a stale prefetch costs
            // 32, which no longer fits, while a plain read of 28 still does.
            const budget = () => ({ bytes: 4096 - 30, commands: 0, deadline: Date.now() + 1000 });
            assert.strictEqual((await context.session._sampleRuntimeItem(watched, null, budget())).value, 2);
            seedVector(context.fake, base + 0x900, [7, 8, 9]);
            const shared = budget();
            context.fake.commands.length = 0;
            const sampleRuntimeItem = context.session._sampleRuntimeItem.bind(context.session);
            let attempts = 0;
            context.session._sampleRuntimeItem = (...args) => {
                attempts++;
                return sampleRuntimeItem(...args);
            };
            assert.strictEqual((await context.session._sampleRuntimeItem(watched, null, shared)).value, 8);
            context.session._sampleRuntimeItem = sampleRuntimeItem;
            assert.strictEqual(attempts, 2, "the stale plan is dropped and the object read again");
            assert.ok(scatterCount(context.fake) >= 1);
            assert.deepStrictEqual(
                [shared.bytes, shared.commands],
                // The three adjacent descriptor words are checked in one read.
                [4096 - 30 + 28, 5],
                "charged from the saved budget"
            );
            // A plan that no longer fits the remaining budget is not prefetched.
            context.fake.commands.length = 0;
            const tight = { bytes: 4096 - 20, commands: 0, deadline: Date.now() + 1000 };
            await assert.rejects(context.session._sampleRuntimeItem(watched, null, tight), {
                code: "LIVE_READ_BUDGET_EXCEEDED"
            });
            assert.strictEqual(scatterCount(context.fake), 0);
        } finally {
            await close(context);
        }
    }

    // Without the patched OpenOCD nothing changes: every cycle reads block by block.
    {
        const context = await fixture(null);
        try {
            const watched = item();
            seedVector(context.fake, base + 0x100, [10, 20, 30]);
            const first = await cycle(context, watched);
            const second = await cycle(context, watched);
            assert.strictEqual(second.tree.value, 20);
            assert.strictEqual(second.scatter, 0);
            assert.strictEqual(second.single, first.single);
        } finally {
            await close(context);
        }
    }

    // Scatter refusing the prefetch falls back to single reads without failing the sample.
    {
        const context = await fixture();
        try {
            const watched = item();
            seedVector(context.fake, base + 0x100, [10, 20, 30]);
            await cycle(context, watched);
            context.fake.scatterFailures = 1;
            const refused = await cycle(context, watched);
            assert.strictEqual(refused.tree.value, 20);
            assert.ok(refused.single >= 2);
            assert.strictEqual(context.session.scatterReads, true, "one refusal keeps scatter enabled");
        } finally {
            await close(context);
        }
    }

    // Reader level: one combined descriptor check still detects changed storage and falls back when refused.
    {
        const memory = Buffer.alloc(0x1000);
        const put = (address, values) => Buffer.from(values).copy(memory, address - base);
        put(base, [...word(base + 0x100), ...word(base + 0x10c), ...word(base + 0x10c)]);
        put(base + 0x100, [...word(10), ...word(20), ...word(30)]);
        const read = async (address, size) => memory.subarray(address - base, address - base + size);
        let batches = 0;
        const readMany = async (ranges) => {
            batches++;
            return ranges.map(({ address, size }) =>
                Buffer.from(memory.subarray(address - base, address - base + size))
            );
        };
        const reader = new RuntimeObjectReader(item(), read, () => {}, undefined, { readMany });
        assert.strictEqual((await reader.sample()).value, 20);
        assert.strictEqual(batches, reader.descriptors.size > 1 ? 1 : 0);
        assert.deepStrictEqual(reader.verificationBudget, { bytes: 0, commands: 0 });
        assert.ok(reader.reads.length >= 2 && reader.reads.some((entry) => entry.descriptor));

        const changing = new RuntimeObjectReader(item(), read, () => {}, undefined, {
            readMany: async (ranges) => ranges.map(({ size }) => Buffer.alloc(size, 0xee))
        });
        await assert.rejects(changing.sample(), { code: "LIVE_OBJECT_CHANGED" });
        const short = new RuntimeObjectReader(item(), read, () => {}, undefined, {
            readMany: async (ranges) => ranges.map(() => Buffer.alloc(1))
        });
        await assert.rejects(short.sample(), { code: "LIVE_MEMORY_UNAVAILABLE" });
        let singles = 0;
        const refused = new RuntimeObjectReader(
            item(),
            async (address, size) => {
                singles++;
                return read(address, size);
            },
            () => {},
            undefined,
            { readMany: async () => null }
        );
        assert.strictEqual((await refused.sample()).value, 20);
        assert.ok(singles > reader.reads.length, "refused batches re-read each descriptor");

        // Prefetched blocks serve exact reads only, are charged up front and paused readers ignore them.
        const plan = reader.reads.map(({ address, size }) => ({
            address,
            bytes: Buffer.from(memory.subarray(address - base, address - base + size))
        }));
        let fresh = 0;
        const budget = { bytes: 0, commands: 0, deadline: Date.now() + 1000 };
        const planned = new RuntimeObjectReader(
            item(),
            async (address, size) => {
                fresh++;
                return read(address, size);
            },
            () => {},
            budget,
            { prefetched: plan }
        );
        assert.strictEqual((await planned.sample()).value, 20);
        assert.strictEqual(planned.prefetchStale(), false);
        // Only the descriptor check goes out: one read for the three adjacent vector words.
        assert.strictEqual(planned.verificationSpans().length, 1);
        assert.strictEqual(fresh, 1, "only the descriptor check goes out");
        assert.ok(budget.commands >= plan.length + 1);
        const frozen = new RuntimeObjectReader(item(), read, () => {}, undefined, {
            frozen: true,
            prefetched: plan,
            readMany
        });
        assert.strictEqual(frozen.prefetched.length, 0);
        assert.strictEqual(frozen.readMany, null);
    }
    console.log("Runtime object scatter prefetch tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
