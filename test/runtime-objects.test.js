"use strict";

const assert = require("assert");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { runtimeWatchEntry } = require("../src/services/runtimeWatch");
const { normalizeWatchList } = require("../src/validation");
const { parseMemberPath } = require("../src/elfSymbols");
const { LiveWatchService, buildActiveReadPlan, filterRuntimeRamPlan } = require("../src/services/liveWatchService");
const elf = require("../src/elfSymbols");

(async () => {
    const memory = Buffer.alloc(8192);
    const base = 0x20000000;
    const word = (address, value) => memory.writeUInt32LE(value >>> 0, address - base);
    const scalar = { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" };
    const pointer = { kind: "pointer", target: 0, byteSize: 4 };
    const types = [
        scalar,
        pointer,
        {
            kind: "class",
            byteSize: 12,
            typeName: "std::vector<int>",
            stl: "vector",
            args: [0],
            fields: ["_M_start", "_M_finish", "_M_end_of_storage"].map((name, index) => ({
                name,
                offset: index * 4,
                type: 1
            }))
        }
    ];
    const item = {
        name: "values[1]",
        address: base,
        size: 12,
        runtimeLayout: { root: 2, types },
        runtimeSegments: [{ kind: "index", index: 1 }],
        runtimeRanges: [{ start: base, end: base + memory.length }]
    };
    let reads = 0;
    const read = async (address, size) => {
        reads++;
        return memory.subarray(address - base, address - base + size);
    };
    word(base, base + 128);
    word(base + 4, base + 140);
    word(base + 8, base + 144);
    word(base + 128, 10);
    word(base + 132, 20);
    word(base + 136, 30);
    assert.strictEqual((await new RuntimeObjectReader(item, read).sample()).value, 20);
    word(base, base + 256);
    word(base + 4, base + 268);
    word(base + 8, base + 272);
    word(base + 260, 42);
    assert.strictEqual(
        (await new RuntimeObjectReader(item, read).sample()).value,
        42,
        "each sample re-resolves reallocated storage"
    );
    word(base + 4, base + 256);
    await assert.rejects(new RuntimeObjectReader(item, read).sample(), { code: "LIVE_MEMBER_MISSING" });
    word(base + 4, base + 268);
    let mutated = false;
    await assert.rejects(
        new RuntimeObjectReader(item, async (address, size) => {
            const bytes = Buffer.from(await read(address, size));
            if (address === base + 260 && !mutated) {
                word(base, base + 512);
                mutated = true;
            }
            return bytes;
        }).sample(),
        { code: "LIVE_OBJECT_CHANGED" }
    );
    word(base, 0x40000000);
    word(base + 4, 0x4000000c);
    word(base + 8, 0x40000010);
    let forbidden = false;
    await assert.rejects(
        new RuntimeObjectReader(item, async (address, size) => {
            if (address >= 0x40000000) forbidden = true;
            return read(address, size);
        }).sample(),
        { code: "LIVE_ADDRESS_NOT_RAM" }
    );
    assert(!forbidden, "MMIO must be rejected before reading");
    word(base, base + 128);
    word(base + 4, base + 140);
    word(base + 8, base + 144);
    const graph = { root: 2, types };
    const symbol = { name: "values", address: base, size: 12, runtimeLayout: graph };
    const watch = normalizeWatchList([{ name: "values[1]" }], [symbol]);
    assert.strictEqual(watch[0].type, "i32");
    assert.strictEqual(buildActiveReadPlan([watch], elf)[0].runtimeLayout, graph);
    const allowed = filterRuntimeRamPlan(watch, [{ addr: base, size: memory.length, flags: 3 }]).allowed;
    assert.deepStrictEqual(allowed[0].runtimeRanges, [{ start: base, end: base + memory.length }]);
    assert.strictEqual(runtimeWatchEntry("values.bad", symbol, [{ kind: "member", name: "bad" }]), null);
    const service = new LiveWatchService(elf);
    const decoded = service.decodeConsumerSamples(
        [{ name: item.name, runtimeTree: await new RuntimeObjectReader(item, read).sample() }],
        1,
        new Map([[item.name, "i32"]])
    );
    assert.strictEqual(decoded.scalarSamples[0].value, 20);
    const failed = service.decodeConsumerSamples(
        [{ name: item.name, diagnostic: { code: "LIVE_OBJECT_CHANGED", message: "changed" } }],
        2,
        new Map([[item.name, "i32"]])
    );
    assert.strictEqual(failed.scalarSamples[0].value, null, "failed samples clear old values");
    const refs = { root: 1, types: [scalar, { kind: "reference", target: 0, byteSize: 4 }] };
    word(base + 32, base + 128);
    assert.strictEqual(
        (
            await new RuntimeObjectReader(
                { ...item, address: base + 32, runtimeLayout: refs, runtimeSegments: [] },
                read
            ).sample()
        ).value,
        10
    );
    const ptr = { root: 1, types: [scalar, { kind: "pointer", target: 0, byteSize: 4 }] };
    assert.strictEqual(
        (
            await new RuntimeObjectReader(
                {
                    ...item,
                    address: base + 32,
                    runtimeLayout: ptr,
                    runtimeSegments: [{ kind: "member", name: "value" }]
                },
                read
            ).sample()
        ).value,
        10
    );
    word(base + 32, 0);
    await assert.rejects(
        new RuntimeObjectReader(
            { ...item, address: base + 32, runtimeLayout: refs, runtimeSegments: [] },
            read
        ).sample(),
        { code: "LIVE_NULL_POINTER" }
    );
    const cycle = { root: 0, types: [{ kind: "pointer", byteSize: 4, target: 0 }] };
    word(base + 32, base + 32);
    await assert.rejects(
        new RuntimeObjectReader(
            { ...item, address: base + 32, runtimeLayout: cycle, runtimeSegments: [] },
            read
        ).sample(),
        { code: "LIVE_POINTER_CYCLE" }
    );
    const virtual = {
        root: 1,
        types: [
            scalar,
            {
                kind: "class",
                byteSize: 4,
                typeName: "Diamond",
                fields: [
                    { name: "@base0", type: 0, expression: [0x12, 0x06, 0x10, 12, 0x1c, 0x06, 0x22], virtual: true }
                ]
            }
        ]
    };
    word(base + 40, base + 1000);
    word(base + 988, 16);
    word(base + 56, 73);
    assert.strictEqual(
        (
            await new RuntimeObjectReader(
                {
                    ...item,
                    address: base + 40,
                    runtimeLayout: virtual,
                    runtimeSegments: [{ kind: "member", name: "@base0" }]
                },
                read
            ).sample()
        ).value,
        73
    );
    const cancelled = new RuntimeObjectReader(item, read, () => {
        throw Object.assign(new Error("resumed"), { code: "DEBUG_STATE_CHANGED" });
    });
    await assert.rejects(cancelled.sample(), { code: "DEBUG_STATE_CHANGED" });
    await assert.rejects(
        new RuntimeObjectReader(item, read, undefined, {
            bytes: 4096,
            commands: 0,
            deadline: Date.now() + 1000
        }).sample(),
        { code: "LIVE_READ_BUDGET_EXCEEDED" }
    );
    assert.deepStrictEqual(
        parseMemberPath("owner->nested->value").segments.map((segment) => segment.kind),
        ["dereference", "member", "dereference", "member"]
    );
    assert(reads > 0);
    console.log("Runtime C++ relocation, references, pointer chains, virtual offsets, races and read limits passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
