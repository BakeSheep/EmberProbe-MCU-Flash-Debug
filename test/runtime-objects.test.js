"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const zlib = require("zlib");
const { parseDwarf } = require("../src/dwarf");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
const c = require("../src/dwarf/constants");
const dwarfTree = require("./helpers/dwarf-tree");
const { ElfService } = require("../src/services/elfService");
const { readPlan, decodeSample } = require("../src/services/agentPlans");
const { placeholderRuntimeTree, runtimeSelection } = require("../src/webview/runtime");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { runtimeWatchEntry } = require("../src/services/runtimeWatch");
const { normalizeWatchList } = require("../src/validation");
const { parseMemberPath } = require("../src/elfSymbols");
const { LiveWatchService, buildActiveReadPlan, filterRuntimeRamPlan } = require("../src/services/liveWatchService");
const elf = require("../src/elfSymbols");

async function checkReferenceFixture(buffer) {
    const parsed = parseDwarf(buffer, { runtime: true });
    const result = elf.parseElfSymbols(buffer);
    const { sections } = elf.parseElfSections(buffer);
    new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
        result,
        parsed.types,
        parsed.layouts,
        parsed.displayNames
    );
    const names = ["reference", "rvalueReference", "refbox", "refbox.ref", "refbox.own", "reference.value"];
    const watches = normalizeWatchList(
        names.map((name) => ({ name, type: "u32" })),
        result.symbols
    );
    const byName = new Map(watches.map((item) => [item.name, item]));
    assert.deepStrictEqual(
        watches.map((item) => item.name),
        names
    );
    assert.strictEqual(byName.get("reference").typeName, "int &");
    assert.strictEqual(byName.get("rvalueReference").typeName, "int &&");
    assert.strictEqual(byName.get("refbox.ref").type, "i32");
    assert.strictEqual(byName.get("refbox.own").runtimeLayout, undefined);
    const box = result.symbols.find((item) => item.name === "refbox");
    assert.strictEqual(runtimeSelection(box).entries.find((item) => item.path === "refbox.ref").isReference, true);
    const placeholder = placeholderRuntimeTree(byName.get("refbox"));
    assert.strictEqual(placeholder.members.find((node) => node.name === "ref").type, "i32");
    const read = async (address, size) => {
        const section = sections.find(
            (entry) => entry.flags & 2 && address >= entry.addr && address + size <= entry.addr + entry.size
        );
        assert(section, "read must remain in verified fixture storage");
        const offset = section.offset + address - section.addr;
        return buffer.subarray(offset, offset + size);
    };
    const sample = async (item) => ({
        name: item.name,
        ...(item.runtimeLayout
            ? { runtimeTree: await new RuntimeObjectReader(item, read).sample() }
            : { bytes: await read(item.address, item.size) })
    });
    const { allowed, denied } = filterRuntimeRamPlan(
        [...buildActiveReadPlan([watches], elf), { name: "rawSlot", address: watches[0].address, size: 4 }],
        sections
    );
    assert(
        sections.some(
            (entry) =>
                entry.name === ".rodata" &&
                watches[0].address >= entry.addr &&
                watches[0].address + 4 <= entry.addr + entry.size
        )
    );
    assert.deepStrictEqual(
        denied.map((entry) => entry.name),
        ["rawSlot"]
    );
    const service = new LiveWatchService(elf);
    const decoded = service.decodeConsumerSamples(
        await Promise.all(allowed.map(sample)),
        1,
        new Map(watches.filter((item) => !item.isComposite).map((item) => [item.name, item])),
        new Map([[box.name, byName.get(box.name)]])
    );
    for (const name of names.filter((name) => name !== box.name)) {
        const value = decoded.scalarSamples.find((item) => item.name === name);
        assert.strictEqual(value.value, name === "refbox.own" ? 31 : 17, name);
        assert(!value.isPointer, name);
    }
    const boxMembers = decoded.compositeSamples[0].tree.members;
    assert.deepStrictEqual(
        boxMembers.map(({ name, value }) => [name, value]),
        [
            ["ref", 17],
            ["own", 31]
        ]
    );
    const agent = readPlan({ variables: ["reference", "rvalueReference", "refbox.ref"] }, () => result);
    const agentItems = filterRuntimeRamPlan(agent.compositePlan, sections).allowed;
    const report = decodeSample(agent.plan, await Promise.all(agentItems.map(sample)), agent.compositePlan);
    for (const value of Object.values(report.values)) {
        assert.strictEqual(value.type, "i32");
        assert.strictEqual(value.value, 17);
    }
    const withoutGraph = {
        ...box,
        runtimeLayout: null,
        compositeLayout: { ...box.compositeLayout, runtimeLayout: null }
    };
    assert.deepStrictEqual(normalizeWatchList([{ name: "refbox.ref" }], [withoutGraph]), []);
    assert.throws(() => readPlan({ variables: ["refbox.ref"] }, () => ({ symbols: [withoutGraph] })), {
        code: "INVALID_VARIABLE_PATH"
    });
}

(async () => {
    await scenario("Observe ELF references through the managed read plan and Agent", async () => {
        const fixtures = require("./fixtures/cpp-review/elf.json");
        for (const version of [4, 5])
            await checkReferenceFixture(zlib.inflateSync(Buffer.from(fixtures["dwarf" + version], "base64")));
    });
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
    await scenario("Follow class, array and pointer references by their C++ paths", async () => {
        const refTypes = [
            scalar,
            { kind: "class", typeName: "Holder", byteSize: 4, fields: [{ name: "value", type: 0, offset: 0 }] },
            { kind: "array", typeName: "int[2]", byteSize: 8, target: 0, count: 2 },
            pointer,
            { kind: "reference", typeName: "Holder &", byteSize: 4, target: 1 },
            { kind: "reference", typeName: "int (&)[2]", byteSize: 4, target: 2 },
            { kind: "reference", typeName: "int * &", byteSize: 4, target: 3 }
        ];
        word(base + 240, base + 256);
        word(base + 256, 123);
        word(base + 260, 456);
        for (const [name, root, path, type, expected] of [
            ["holder", 4, "holder.value", "i32", 123],
            ["array", 5, "array[1]", "i32", 456],
            ["pointer", 6, "pointer", "u32", base + 128],
            ["pointer", 6, "pointer.value", "i32", 10]
        ]) {
            const symbol = {
                name,
                address: base + 240,
                size: 4,
                isReference: true,
                runtimeLayout: { root, types: refTypes }
            };
            if (root === 6) word(base + 256, base + 128);
            const [watch] = normalizeWatchList([{ name: path }], [symbol]);
            assert.strictEqual(watch.type, type, path);
            const tree = await new RuntimeObjectReader({ ...watch, runtimeRanges: item.runtimeRanges }, read).sample();
            assert.strictEqual(tree.value, expected, path);
            assert.strictEqual(Boolean(tree.isPointer), path === "pointer");
            if (root === 5) {
                assert.deepStrictEqual(normalizeWatchList([{ name: "array[*]" }], [symbol]), []);
                const [whole] = normalizeWatchList([{ name: "array" }], [symbol]);
                assert.deepStrictEqual(
                    placeholderRuntimeTree(whole).elements.map((element) => element.type),
                    ["i32", "i32"]
                );
            }
        }
    });
    await scenario("Keep DWARF array dimensions and migrate saved flat reference indices", async () => {
        const { node, attr, typeAttr, base: integer, variable, fixture } = dwarfTree;
        const address = base + 1024;
        const data = base + 1040;
        const elfFixture = fixture([
            [
                integer("number"),
                node(
                    "array",
                    c.DW_TAG_array_type,
                    [typeAttr("number")],
                    [2, 3].map((count) =>
                        node("range-" + count, c.DW_TAG_subrange_type, [attr(c.DW_AT_count, 0x0b, count)])
                    )
                ),
                node("reference", c.DW_TAG_reference_type, [typeAttr("array")]),
                variable("matrix", "reference", address)
            ]
        ]);
        const symbol = {
            name: "matrix",
            address,
            size: 4,
            isReference: true,
            runtimeLayout: createRuntimeLayoutResolver(parseDwarfInternal(elfFixture.buffer))("matrix")
        };
        word(address, data);
        [11, 12, 13, 21, 22, 23].forEach((value, index) => word(data + index * 4, value));
        const watches = normalizeWatchList(
            [{ name: "matrix" }, { name: "matrix[1][2]" }, { name: "matrix[2][0]" }],
            [symbol]
        );
        assert.deepStrictEqual(
            watches.map(({ name }) => name),
            ["matrix", "matrix[1][2]"]
        );
        assert.strictEqual(watches[0].typeName, "int (&)[2][3]");
        const sample = (watch) =>
            new RuntimeObjectReader({ ...watch, runtimeRanges: item.runtimeRanges }, read).sample();
        const tree = await sample(watches[0]);
        assert.deepStrictEqual(
            tree.elements.map((row) => row.elements.map((cell) => cell.value)),
            [
                [11, 12, 13],
                [21, 22, 23]
            ]
        );
        assert.strictEqual((await sample(watches[1])).value, 23);
        const [migrated] = normalizeWatchList([{ name: "matrix.value[5]", type: "i32" }], [symbol], {
            migrateLegacyRuntimePaths: true
        });
        assert.strictEqual(migrated.name, "matrix[1][2]");
        assert.strictEqual(migrated.runtimePathVersion, 1);
        const [row] = normalizeWatchList([{ name: "matrix[1]", type: "" }], [symbol], {
            migrateLegacyRuntimePaths: true
        });
        assert.strictEqual(row.name, "matrix[1]");
        assert.strictEqual(row.isComposite, true);
    });
    await scenario("Keep STL pointer reference watches scalar for null and live pointers", async () => {
        const address = base + 1100;
        const data = base + 1140;
        const types = [
            scalar,
            pointer,
            { kind: "reference", target: 1, byteSize: 4 },
            {
                kind: "class",
                stl: "pair",
                typeName: "std::pair<int *&, int>",
                args: [2, 0],
                byteSize: 8,
                fields: [
                    { name: "first", type: 2, offset: 0 },
                    { name: "second", type: 0, offset: 4 }
                ]
            }
        ];
        const symbol = { name: "pair", address, size: 8, runtimeLayout: { root: 3, types } };
        const [watch] = normalizeWatchList([{ name: "pair.first" }], [symbol]);
        assert.strictEqual(watch.isComposite, false);
        assert.strictEqual(watch.isPointer, true);
        word(address, address + 12);
        word(data, 41);
        for (const expected of [data, 0]) {
            word(address + 12, expected);
            const tree = await new RuntimeObjectReader({ ...watch, runtimeRanges: item.runtimeRanges }, read).sample();
            const decoded = service.decodeConsumerSamples(
                [{ name: watch.name, runtimeTree: tree }],
                1,
                new Map([[watch.name, watch]])
            );
            assert.strictEqual(decoded.scalarSamples[0].value, expected);
            assert.strictEqual(decoded.scalarSamples[0].isPointer, true);
            assert.strictEqual(decoded.compositeSamples.length, 0);
        }
        word(address + 12, data);
        const [target] = normalizeWatchList([{ name: "pair.first.value" }], [symbol]);
        assert.strictEqual(
            (await new RuntimeObjectReader({ ...target, runtimeRanges: item.runtimeRanges }, read).sample()).value,
            41
        );
    });
    await scenario("Migrate only stored reference expansions and persist their current identities", async () => {
        const { WatchListStore } = require("../src/services/watchListStore");
        const { loadProvider } = require("./helpers/load-provider");
        const types = [
            scalar,
            pointer,
            { kind: "reference", target: 1, byteSize: 4 },
            { kind: "class", byteSize: 4, fields: [{ name: "value", type: 0, offset: 0 }] },
            { kind: "reference", target: 3, byteSize: 4 }
        ];
        const symbols = [
            { name: "ptr", address: base, size: 4, isReference: true, runtimeLayout: { root: 2, types } },
            { name: "box", address: base + 4, size: 4, isReference: true, runtimeLayout: { root: 4, types } }
        ];
        const currentOptions = { migrateLegacyRuntimePaths: true };
        let stored = [
            { name: "ptr.value", type: "u32" },
            { name: "ptr.value.value", type: "i32" },
            { name: "box.value", type: "" },
            { name: "box.value.value", type: "i32" },
            { name: "box.invalid.value", type: "i32" }
        ];
        const store = new WatchListStore({
            state: {
                get: () => stored,
                update: async (_key, items) => {
                    stored = items;
                }
            },
            symbols: () => symbols,
            normalize: (items, known, _key, fromStorage) =>
                normalizeWatchList(items, known, fromStorage ? currentOptions : {}),
            onChanged() {},
            onError: (error) => {
                throw error;
            },
            serialize: loadProvider().prototype._watchIdentities
        });
        const expected = ["ptr", "ptr.value", "box", "box.value"];
        assert.deepStrictEqual(
            store.read("sidebar").map(({ name }) => name),
            expected
        );
        await store.rebind(["sidebar"], symbols);
        assert.deepStrictEqual(
            stored.map(({ name }) => name),
            expected
        );
        assert.strictEqual(stored[1].runtimePathVersion, 1);
        assert.strictEqual(stored[3].runtimePathVersion, 1);
        await store.rebind(["sidebar"], symbols);
        assert.deepStrictEqual(
            stored.map(({ name }) => name),
            expected
        );
        const [fresh] = normalizeWatchList([{ name: "box.value", type: "" }], symbols);
        assert.strictEqual(fresh.name, "box.value");
        const [actual] = normalizeWatchList([{ name: "box.value", type: "i32" }], symbols, currentOptions);
        assert.strictEqual(actual.name, "box.value");

        const nested = [
            scalar,
            { kind: "class", byteSize: 4, fields: [{ name: "x", type: 0, offset: 0 }] },
            {
                kind: "class",
                byteSize: 8,
                fields: [
                    { name: "x", type: 0, offset: 0 },
                    { name: "value", type: 1, offset: 4 }
                ]
            },
            { kind: "reference", target: 2, byteSize: 4 }
        ];
        const symbol = { name: "ref", address: base, size: 4, runtimeLayout: { root: 3, types: nested } };
        const [nestedValue] = normalizeWatchList([{ name: "ref.value.x", type: "i32" }], [symbol], currentOptions);
        assert.strictEqual(nestedValue.name, "ref.value.x", "an equally typed real member wins over legacy syntax");
    });
    await scenario("Read inherited members independently of a watched reference object", async () => {
        const symbol = {
            name: "derived",
            address: base + 288,
            size: 4,
            isReference: true,
            runtimeLayout: {
                root: 3,
                types: [
                    scalar,
                    { kind: "class", byteSize: 4, fields: [{ name: "inherited", type: 0, offset: 0 }] },
                    {
                        kind: "class",
                        byteSize: 8,
                        fields: [
                            { name: "@base0", isBase: true, type: 1, offset: 0 },
                            { name: "own", type: 0, offset: 4 }
                        ]
                    },
                    { kind: "reference", byteSize: 4, target: 2 }
                ]
            }
        };
        word(symbol.address, base + 320);
        word(base + 320, 17);
        word(base + 324, 29);
        const watches = normalizeWatchList(
            ["derived", "derived.inherited", "derived.own"].map((name) => ({ name })),
            [symbol]
        );
        const plan = buildActiveReadPlan([watches], elf, [{ derived: [] }]);
        assert.deepStrictEqual(
            plan.map(({ name }) => name),
            ["derived", "derived.inherited"]
        );
        const samples = await Promise.all(
            plan.map(async (entry) => ({
                name: entry.name,
                runtimeTree: await new RuntimeObjectReader(
                    { ...entry, runtimeRanges: item.runtimeRanges },
                    read
                ).sample()
            }))
        );
        const decoded = service.decodeConsumerSamples(
            samples,
            1,
            new Map(watches.slice(1).map((entry) => [entry.name, entry])),
            new Map([[watches[0].name, watches[0]]])
        );
        assert.deepStrictEqual(
            decoded.scalarSamples.map(({ name, value }) => [name, value]),
            [
                ["derived.inherited", 17],
                ["derived.own", 29]
            ]
        );
    });
    await scenario("Allow reference members in verified read-only ELF data", async () => {
        const address = base + 512;
        const symbol = {
            name: "frozen",
            address,
            size: 8,
            isComposite: true,
            runtimeLayout: {
                root: 3,
                types: [
                    ...refs.types,
                    pointer,
                    {
                        kind: "class",
                        byteSize: 8,
                        fields: [
                            { name: "ref", type: 1, offset: 0 },
                            { name: "ptr", type: 2, offset: 4 }
                        ]
                    }
                ]
            }
        };
        word(address, base + 128);
        word(address + 4, base + 128);
        const watches = normalizeWatchList(
            ["frozen", "frozen.ref", "frozen.ptr.value"].map((name) => ({ name })),
            [symbol]
        );
        assert.strictEqual(watches.length, 3);
        const ram = { addr: base, size: 512, flags: 3, type: 1 };
        const rodata = { addr: address, size: 8, flags: 2, type: 1 };
        const { allowed, denied } = filterRuntimeRamPlan(
            [...watches, { name: "rawSlot", address, size: 4 }],
            [ram, rodata]
        );
        assert.deepStrictEqual(
            allowed.map(({ name }) => name),
            ["frozen", "frozen.ref"]
        );
        assert.deepStrictEqual(
            denied.map(({ name }) => name),
            ["frozen.ptr.value", "rawSlot"]
        );
        for (const deniedSection of [
            { ...rodata, flags: 6 },
            { ...rodata, size: 4 },
            { ...rodata, type: 8 }
        ])
            assert.strictEqual(filterRuntimeRamPlan(watches, [ram, deniedSection]).allowed.length, 0);
        assert.deepStrictEqual(allowed[1].runtimeWriteRanges, [{ name: "", start: base, end: address }]);
        const tree = await new RuntimeObjectReader(allowed[1], read).sample();
        assert.strictEqual(tree.value, 10);
    });
    await scenario("Keep a null reference member diagnostic without losing its sibling", async () => {
        const box = {
            kind: "class",
            typeName: "RefBox",
            byteSize: 8,
            fields: [
                { name: "ref", type: 1, offset: 0 },
                { name: "own", type: 0, offset: 4 }
            ]
        };
        word(base + 296, 0);
        word(base + 300, 31);
        const symbol = {
            name: "box",
            address: base + 296,
            size: 8,
            isComposite: true,
            runtimeLayout: { root: 2, types: [...refs.types, box] }
        };
        const [root, member] = normalizeWatchList([{ name: "box" }, { name: "box.ref" }], [symbol]);
        const plan = buildActiveReadPlan([[root, member]], elf);
        assert.deepStrictEqual(
            plan.map(({ name }) => name),
            ["box"]
        );
        const tree = await new RuntimeObjectReader({ ...plan[0], runtimeRanges: item.runtimeRanges }, read).sample();
        const [ref, own] = tree.members;
        assert.strictEqual(ref.value, null);
        assert.strictEqual(ref.isPointer, undefined);
        assert.strictEqual(ref.unavailableCode, "LIVE_NULL_POINTER");
        assert.strictEqual(own.value, 31);
        const { scalarSamples } = service.decodeConsumerSamples(
            [{ name: root.name, runtimeTree: tree }],
            1,
            new Map([[member.name, member]]),
            new Map([[root.name, root]])
        );
        assert.strictEqual(scalarSamples[0].value, null);
        assert.deepStrictEqual(scalarSamples[0].diagnostic, {
            code: "LIVE_NULL_POINTER",
            message: "Runtime pointer is null"
        });
    });
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
    const cycleTree = await new RuntimeObjectReader(
        { ...item, address: base + 32, runtimeLayout: cycle, runtimeSegments: [] },
        read
    ).sample();
    assert.strictEqual(cycleTree.kind, "scalar");
    assert.strictEqual(cycleTree.isPointer, true);
    assert.strictEqual(cycleTree.address, base + 32);
    assert.strictEqual(cycleTree.value, base + 32);
    assert.strictEqual(cycleTree.valueText, "0x20000020");
    assert.strictEqual(cycleTree.unavailable, "cycle");
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

    await scenario("Display opaque MMIO pointers and retain static scalar watches", async () => {
        const pointerMemory = Buffer.alloc(8);
        pointerMemory.writeUInt32LE(0x40000000, 0);
        pointerMemory.writeInt32LE(7, 4);
        const pointerGraph = {
            root: 2,
            types: [
                { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" },
                { kind: "pointer", typeName: "Driver", byteSize: 4, target: 0 },
                {
                    kind: "class",
                    typeName: "Ina226",
                    byteSize: 8,
                    fields: [
                        { name: "driver", type: 1, offset: 0 },
                        { name: "reading", type: 0, offset: 4 }
                    ]
                }
            ]
        };
        const pointerTree = await new RuntimeObjectReader(
            {
                name: "pwr",
                address: 0x20000000,
                size: 8,
                runtimeLayout: pointerGraph,
                runtimeRanges: [{ start: 0x20000000, end: 0x20000008 }]
            },
            async (address, size) => pointerMemory.subarray(address - 0x20000000, address - 0x20000000 + size)
        ).sample();
        assert.strictEqual(pointerTree.members[0].valueText, "0x40000000");
        assert.strictEqual(pointerTree.members[0].value, 0x40000000);
        assert.strictEqual(pointerTree.members[1].value, 7);

        const pointerSymbol = {
            name: "pwr",
            address: 0x20000000,
            size: 8,
            isComposite: true,
            compositeLayout: {
                kind: "class",
                members: [
                    { name: "driver", offset: 0, byteSize: 4, watchType: "u32" },
                    { name: "reading", offset: 4, byteSize: 4, watchType: "i32" }
                ]
            },
            runtimeLayout: pointerGraph
        };
        assert.strictEqual(runtimeWatchEntry("pwr", pointerSymbol), null);
        const staticItems = normalizeWatchList([{ name: "pwr" }], [pointerSymbol]);
        assert.strictEqual(staticItems.length, 1);
        assert.ok(staticItems[0].compositeLayout);
        assert.strictEqual(staticItems[0].runtimeLayout, undefined);
    });

    console.log("Runtime C++ relocation, references, pointer chains, virtual offsets, races and read limits passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
