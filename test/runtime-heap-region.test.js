"use strict";
// Runtime objects whose STL storage lives on the newlib heap beyond `._user_heap_stack`, and member
// failures that must not take the whole object down.
const assert = require("assert");
const { parseElfSections } = require("../src/elfSymbols");
const { filterRuntimeRamPlan, runtimePointerRanges } = require("../src/services/liveWatchService");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { buildMemoryElf } = require("./helpers/memory-fixture");

const DTCM = 0x20000000;
// Like the H750 CubeMX layout: .data, .bss, then the reserved minimum heap + stack.
const sections = [
    { name: ".text", type: 1, flags: 6, addr: 0x08000000, size: 64 },
    { name: ".data", type: 1, flags: 3, addr: DTCM, size: 0x40 },
    { name: ".bss", type: 8, flags: 3, addr: DTCM + 0x40, size: 0x7c0 },
    { name: "._user_heap_stack", type: 8, flags: 3, addr: DTCM + 0x800, size: 0x604 }
];
const linker = [
    { name: "_end", value: DTCM + 0x800 },
    { name: "_estack", value: DTCM + 0x20000 }
];

{
    const memory = parseElfSections(buildMemoryElf(sections, linker));
    assert.deepStrictEqual(memory.runtimeRegions, [{ name: "heap-stack", start: DTCM + 0x800, end: DTCM + 0x20000 }]);
    // `end` stands in for `_end`.
    assert.deepStrictEqual(
        parseElfSections(buildMemoryElf(sections, [{ name: "end", value: DTCM + 0x800 }, linker[1]])).runtimeRegions,
        [{ name: "heap-stack", start: DTCM + 0x800, end: DTCM + 0x20000 }]
    );
    // Without both symbols, or when the region is not anchored in RAM or overlaps another section, nothing is added.
    for (const symbols of [
        [linker[0]],
        [linker[1]],
        [{ name: "_end", value: 0x08000010 }, linker[1]],
        [{ name: "_end", value: DTCM + 0x100000 }, linker[1]],
        [linker[0], { name: "_estack", value: DTCM + 0x800 }]
    ])
        assert.strictEqual(parseElfSections(buildMemoryElf(sections, symbols)).runtimeRegions, undefined);
    const readOnlyInside = [...sections, { name: ".rodata", type: 1, flags: 2, addr: DTCM + 0x10000, size: 16 }];
    assert.strictEqual(parseElfSections(buildMemoryElf(readOnlyInside, linker)).runtimeRegions, undefined);

    // The region widens pointer targets only; watched objects must still lie in writable sections.
    const regions = memory.runtimeRegions;
    const ranges = runtimePointerRanges(memory.sections, regions);
    assert(ranges.some((range) => range.start === DTCM + 0x800 && range.end === DTCM + 0x20000));
    const object = { name: "obj", address: DTCM + 0x40, size: 16, runtimeLayout: { root: 0, types: [] } };
    const onHeap = { name: "heap", address: DTCM + 0x1000, size: 4 };
    const plan = filterRuntimeRamPlan([object, onHeap], memory.sections, regions);
    assert.deepStrictEqual(
        plan.allowed.map((item) => item.name),
        ["obj"]
    );
    assert.deepStrictEqual(
        plan.denied.map((item) => item.name),
        ["heap"]
    );
    assert.deepStrictEqual(plan.allowed[0].runtimeRanges, ranges);
    assert(!plan.ranges.some((range) => range.end > DTCM + 0x1000), "writable watch ranges are unchanged");
}

(async () => {
    // struct { std::vector<int> values; int marker; } with the vector's storage on the heap.
    const scalar = { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" };
    const pointer = { kind: "pointer", typeName: "int *", target: 0, byteSize: 4 };
    const vector = {
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
    };
    const holder = {
        kind: "class",
        byteSize: 16,
        typeName: "Holder",
        fields: [
            { name: "values", type: 2, offset: 0 },
            { name: "marker", type: 0, offset: 12 }
        ]
    };
    const ram = Buffer.alloc(0x20000);
    const storage = DTCM + 0x1000;
    ram.writeUInt32LE(storage, 0x40);
    ram.writeUInt32LE(storage + 8, 0x44);
    ram.writeUInt32LE(storage + 8, 0x48);
    ram.writeInt32LE(77, 0x4c);
    ram.writeInt32LE(5, 0x1000);
    ram.writeInt32LE(6, 0x1004);
    const read = async (address, size) => ram.subarray(address - DTCM, address - DTCM + size);
    const item = (runtimeRanges) => ({
        name: "holder",
        address: DTCM + 0x40,
        size: 16,
        runtimeLayout: { root: 3, types: [scalar, pointer, vector, holder] },
        runtimeRanges
    });
    const budget = () => ({ bytes: 0, commands: 0, deadline: Date.now() + 1000 });
    const member = (tree, name) => tree.members.find((entry) => entry.name === name);

    // With the heap region the vector's elements are read.
    const memory = parseElfSections(buildMemoryElf(sections, linker));
    const withHeap = await new RuntimeObjectReader(
        item(runtimePointerRanges(memory.sections, memory.runtimeRegions)),
        read,
        () => {},
        budget()
    ).sample();
    assert.deepStrictEqual(
        member(withHeap, "values").elements.map((entry) => entry.value),
        [5, 6]
    );
    assert.strictEqual(member(withHeap, "marker").value, 77);

    // Without it only the vector is marked; its sibling still samples.
    const sectionsOnly = await new RuntimeObjectReader(
        item(runtimePointerRanges(memory.sections)),
        read,
        () => {},
        budget()
    ).sample();
    assert.deepStrictEqual(member(sectionsOnly, "values"), {
        name: "values",
        kind: "class",
        typeName: "std::vector<int>",
        members: [],
        unavailable: "not-ram",
        unavailableCode: "LIVE_ADDRESS_NOT_RAM"
    });
    assert.strictEqual(member(sectionsOnly, "marker").value, 77);

    // A root that cannot be read still fails as a whole.
    await assert.rejects(
        new RuntimeObjectReader(item([{ start: DTCM + 0x800, end: DTCM + 0x900 }]), read, () => {}, budget()).sample(),
        { code: "LIVE_ADDRESS_NOT_RAM" }
    );
    // A vector header that changes during the sample withholds the vector only.
    let reads = 0;
    const moved = await new RuntimeObjectReader(
        item(runtimePointerRanges(memory.sections, memory.runtimeRegions)),
        async (address, size) => {
            const bytes = Buffer.from(await read(address, size));
            if (++reads > 1 && address === DTCM + 0x40) bytes.writeUInt32LE(storage + 4);
            return bytes;
        },
        () => {},
        budget()
    ).sample();
    assert.strictEqual(member(moved, "values").unavailableCode, "LIVE_OBJECT_CHANGED");
    assert.deepStrictEqual(member(moved, "values").members, []);
    assert.strictEqual(member(moved, "marker").value, 77);

    console.log("Runtime heap region and member failure isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
