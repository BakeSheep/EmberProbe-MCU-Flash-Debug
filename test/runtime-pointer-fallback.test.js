"use strict";

const assert = require("assert");
const zlib = require("zlib");
const dwarf = require("../src/dwarf");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { formatPointer, summaryRoute } = require("../src/webview/runtime");
const fixture = require("./fixtures/pointer-classes/elf.json");

const base = 0x20000000;
const scalar = { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" };

function pointer(target, pointerTarget = "data", typeName = "int *", kind = "pointer") {
    return { kind, target, pointerTarget, typeName, byteSize: 4 };
}

function harness(types, root = 0) {
    const bytes = Buffer.alloc(16384);
    const reads = [];
    const item = {
        name: "object",
        address: base,
        runtimeLayout: { root, types },
        runtimeRanges: [{ start: base, end: base + bytes.length }]
    };
    const read = async (address, size) => {
        assert(address >= base && address + size <= base + bytes.length, "whitelist must precede every read");
        reads.push({ address, size });
        return bytes.subarray(address - base, address - base + size);
    };
    return {
        bytes,
        reads,
        item,
        read,
        word: (address, value) => bytes.writeUInt32LE(value >>> 0, address - base),
        reader: (overrides = {}, readMemory = read, budget = undefined, guard = undefined) =>
            new RuntimeObjectReader({ ...item, ...overrides }, readMemory, guard, budget)
    };
}

function leaf(typeName, pointerTarget, address, value, unavailable = undefined) {
    return {
        kind: "scalar",
        type: "u32",
        typeName,
        isPointer: true,
        pointerTarget,
        address,
        value,
        valueText: formatPointer(value),
        ...(unavailable ? { unavailable } : {})
    };
}

function vectorGraph(types, element) {
    const elementPointer = types.push(pointer(element, "data", "Element *")) - 1;
    const root =
        types.push({
            kind: "class",
            typeName: "std::vector<Element>",
            byteSize: 12,
            stl: "vector",
            args: [element],
            fields: ["_M_start", "_M_finish", "_M_end_of_storage"].map((name, index) => ({
                name,
                type: elementPointer,
                offset: index * 4
            }))
        }) - 1;
    return { types, root };
}

function vectorStorage(h, count, width) {
    h.word(base, base + 128);
    h.word(base + 4, base + 128 + count * width);
    h.word(base + 8, base + 128 + count * width);
}

function member(node, name) {
    const result = node.members.find((entry) => entry.name === name);
    assert(result, "missing member " + name);
    return result;
}

async function shapesAndOpaqueTargets() {
    for (const kind of ["pointer", "reference"]) {
        const typeName = kind === "pointer" ? "int *" : "int &";
        const h = harness([scalar, pointer(0, "data", typeName, kind)], 1);
        assert.deepStrictEqual(await h.reader().sample(), leaf(typeName, "data", base, 0));
        h.word(base, base + 128);
        h.word(base + 128, 42);
        assert.deepStrictEqual(
            await h.reader({ runtimeStaticPointers: true }).sample(),
            leaf(typeName, "data", base, base + 128)
        );
        const followed = await h.reader().sample();
        if (kind === "reference") assert.strictEqual(followed.value, 42, "readable references remain transparent");
        else {
            assert.deepStrictEqual(followed, {
                kind: "class",
                typeName,
                isPointer: true,
                pointerTarget: "data",
                address: base,
                pointerValue: base + 128,
                valueText: "0x20000080",
                members: [
                    {
                        name: "value",
                        kind: "scalar",
                        type: "i32",
                        typeName: "int",
                        address: base + 128,
                        value: 42,
                        valueText: null
                    }
                ]
            });
            assert(!Object.hasOwn(followed, "value"), "followed pointers must not look like picker leaves");
        }
        h.reads.length = 0;
        h.word(base, 0x40000000);
        assert.deepStrictEqual(await h.reader().sample(), leaf(typeName, "data", base, 0x40000000, "not-ram"));
        assert(
            h.reads.every((read) => read.address === base),
            "MMIO pointers must not trigger a target read"
        );
    }

    const graph = vectorGraph(
        [
            scalar,
            { kind: "unavailable" },
            pointer(1, "void", "void *"),
            pointer(1, "function", "function *"),
            pointer(1, "incomplete", "Opaque *"),
            {
                kind: "class",
                typeName: "Element",
                byteSize: 16,
                fields: [
                    { name: "context", type: 2, offset: 0 },
                    { name: "callback", type: 3, offset: 4 },
                    { name: "handle", type: 4, offset: 8 },
                    { name: "value", type: 0, offset: 12 }
                ]
            }
        ],
        5
    );
    const h = harness(graph.types, graph.root);
    vectorStorage(h, 1, 16);
    h.word(base + 128, base + 1024);
    h.word(base + 132, 0x08001235);
    h.word(base + 136, 0x40000000);
    h.word(base + 140, 73);
    const element = (await h.reader({ runtimeStaticPointers: true }).sample()).elements[0];
    for (const [name, offset, typeName, target, value] of [
        ["context", 0, "void *", "void", base + 1024],
        ["callback", 4, "function *", "function", 0x08001235],
        ["handle", 8, "Opaque *", "incomplete", 0x40000000]
    ])
        assert.deepStrictEqual(member(element, name), {
            name,
            ...leaf(typeName, target, base + 128 + offset, value, "opaque-pointee")
        });
    assert.strictEqual(member(element, "value").value, 73);
    assert(
        h.reads.every((read) => read.address < base + 144),
        "opaque pointees are never read"
    );

    for (const target of [
        { kind: "unavailable" },
        { kind: "class", byteSize: 4, unobservable: "depth-limit" },
        { kind: "scalar", byteSize: 4 }
    ]) {
        const opaque = harness([pointer(1), target]);
        opaque.word(base, base + 128);
        assert.deepStrictEqual(
            await opaque.reader().sample(),
            leaf("int *", "data", base, base + 128, "opaque-pointee")
        );
        assert(opaque.reads.every((read) => read.address === base));
    }
}

async function cyclesAndLimits() {
    const types = [
        scalar,
        pointer(2, "data", "Node *"),
        {
            kind: "class",
            typeName: "Node",
            byteSize: 8,
            fields: [
                { name: "peer", type: 1, offset: 0 },
                { name: "value", type: 0, offset: 4 }
            ]
        }
    ];
    const graph = vectorGraph(types, 2);
    const h = harness(graph.types, graph.root);
    vectorStorage(h, 2, 8);
    h.word(base + 128, base + 136);
    h.word(base + 132, 11);
    h.word(base + 136, base + 128);
    h.word(base + 140, 22);
    const tree = await h.reader().sample();
    for (const [index, address, other, value] of [
        [0, base + 128, base + 136, 11],
        [1, base + 136, base + 128, 22]
    ]) {
        const element = tree.elements[index];
        assert.strictEqual(member(element, "value").value, value);
        const followed = member(element, "peer");
        assert.strictEqual(followed.pointerValue, other);
        assert.strictEqual(followed.address, address);
        const cycle = member(member(followed, "value"), "peer");
        assert.deepStrictEqual(cycle, { name: "peer", ...leaf("Node *", "data", other, address, "cycle") });
    }

    // Long chains obey the depth limit without losing the variable or its sibling value.
    const chain = harness(types, 2);
    for (let index = 0; index < 40; index++) {
        chain.word(base + index * 8, base + (index + 1) * 8);
        chain.word(base + index * 8 + 4, index);
    }
    const limited = await chain.reader().sample();
    assert.strictEqual(member(limited, "value").value, 0);
    let node = member(limited, "peer");
    let followed = 0;
    while (node.kind === "class") {
        followed++;
        node = member(member(node, "value"), "peer");
    }
    assert(followed > 0 && followed <= 32);
    assert(["depth-limit", "expansion-budget"].includes(node.unavailable || node.unobservable));
    assert(node.kind === "unavailable" || node.isPointer === true);
}

async function expansionBudgets() {
    // Out of bytes, a later pointer whose small target still fits is followed; out of reads, it is not.
    for (const [chunkBytes, count, expectedCommands, expectedBytes, laterFollowed] of [
        [256, 16, 18, 3864, true],
        [16, 32, 32, 500, false]
    ]) {
        const h = harness(
            [
                scalar,
                {
                    kind: "class",
                    typeName: "Chunk",
                    byteSize: chunkBytes,
                    fields: [{ name: "value", type: 0, offset: 0 }]
                },
                { kind: "array", typeName: "Chunk[]", target: 1, count, byteSize: chunkBytes * count },
                pointer(2, "data", "Chunk *"),
                pointer(0),
                {
                    kind: "class",
                    typeName: "Holder",
                    byteSize: 12,
                    fields: [
                        { name: "large", type: 3, offset: 0 },
                        { name: "later", type: 4, offset: 4 },
                        { name: "marker", type: 0, offset: 8 }
                    ]
                }
            ],
            5
        );
        h.word(base, base + 128);
        h.word(base + 4, base + 8192);
        h.word(base + 8, 97);
        h.word(base + 8192, 123);
        const budget = { bytes: 0, commands: 0, deadline: Date.now() + 1000 };
        const reader = h.reader({}, undefined, budget);
        const tree = await reader.sample();
        // The target shows the chunks that fit; the rest are marked on their rows, not the whole object.
        const chunks = member(member(tree, "large"), "value").elements;
        assert.strictEqual(chunks.length, count);
        const unread = chunks.filter((chunk) => chunk.unavailableCode === "LIVE_READ_BUDGET_EXCEEDED");
        assert(unread.length > 0 && unread.length < count, `${unread.length} of ${count} chunks unread`);
        for (const chunk of chunks) if (!chunk.unavailableCode) assert.strictEqual(member(chunk, "value").type, "i32");
        if (laterFollowed) assert.strictEqual(member(member(tree, "later"), "value").value, 123);
        else
            assert.deepStrictEqual(member(tree, "later"), {
                name: "later",
                ...leaf("int *", "data", base + 4, base + 8192, "expansion-budget"),
                unavailableCode: "LIVE_READ_BUDGET_EXCEEDED"
            });
        assert.strictEqual(member(tree, "marker").value, 97);
        assert.strictEqual(budget.bytes, expectedBytes);
        assert.strictEqual(budget.commands, expectedCommands);
        assert(budget.bytes <= 4096 && budget.commands <= 32);
        // The two adjacent pointer words are verified in one fresh read.
        assert.deepStrictEqual(
            h.reads.slice(-1),
            [{ address: base, size: 8 }],
            "final descriptor verification must still read fresh memory"
        );
        assert.deepStrictEqual(reader.verificationBudget, { bytes: 0, commands: 0 });

        // A changed descriptor still withholds what it shaped, even with a locally exhausted expansion:
        // only that pointer is marked, its sibling keeps its value.
        const changed = await h
            .reader({}, async (address, size) => {
                const bytes = Buffer.from(await h.read(address, size));
                // Only the final verification reads both pointer words at once.
                if (address === base && size === 8) bytes.writeUInt32LE(base + 256);
                return bytes;
            })
            .sample();
        assert.deepStrictEqual(member(changed, "large"), {
            name: "large",
            kind: "class",
            typeName: "Chunk *",
            isPointer: true,
            pointerTarget: "data",
            address: base,
            members: [],
            unavailable: "changing",
            unavailableCode: "LIVE_OBJECT_CHANGED"
        });
        assert.strictEqual(member(changed, "marker").value, 97);
    }

    const h = harness([pointer(1), scalar]);
    h.word(base, base + 128);
    const budget = { bytes: 4092, commands: 0, deadline: Date.now() + 1000 };
    await assert.rejects(h.reader({}, undefined, budget).sample(), { code: "LIVE_READ_BUDGET_EXCEEDED" });
    assert.strictEqual(h.reads.length, 0, "a descriptor is not read unless its verification also fits");
    assert.strictEqual(budget.bytes, 4092, "rejected reads must not poison the shared cycle budget");
}

async function localErrorsAndGuards() {
    for (const [code, reason] of [
        ["LIVE_MEMORY_UNAVAILABLE", "memory-unavailable"],
        ["LIVE_LAYOUT_UNSUPPORTED", "layout-unsupported"],
        ["LIVE_OBJECT_CHANGED", "changing"],
        ["LIVE_MEMBER_MISSING", "member-missing"],
        ["LIVE_READ_BUDGET_EXCEEDED", "expansion-budget"],
        ["LIVE_NULL_POINTER", "null-pointer"],
        ["LIVE_NEW_DIAGNOSTIC", "new-diagnostic"]
    ]) {
        for (const kind of ["pointer", "reference"]) {
            const typeName = kind === "pointer" ? "int *" : "int &";
            const h = harness([pointer(1, "data", typeName, kind), scalar]);
            h.word(base, base + 128);
            assert.deepStrictEqual(
                await h
                    .reader({}, async (address, size) => {
                        if (address === base + 128) throw Object.assign(new Error("pointee failed"), { code });
                        return h.read(address, size);
                    })
                    .sample(),
                {
                    ...leaf(typeName, "data", base, base + 128, reason),
                    // Read-budget leaves keep their code so views name the budget.
                    ...(code === "LIVE_READ_BUDGET_EXCEEDED" ? { unavailableCode: code } : {})
                }
            );
        }
    }

    const h = harness([pointer(1), scalar]);
    h.word(base, base + 128);
    assert.deepStrictEqual(
        await h
            .reader({}, async (address, size) => (address === base + 128 ? Buffer.alloc(0) : h.read(address, size)))
            .sample(),
        leaf("int *", "data", base, base + 128, "memory-unavailable")
    );
    for (const error of [
        new Error("transport programming error"),
        Object.assign(new Error("resumed"), { code: "DEBUG_STATE_CHANGED" })
    ])
        await assert.rejects(
            h
                .reader({}, async (address, size) => {
                    if (address === base + 128) throw error;
                    return h.read(address, size);
                })
                .sample(),
            (actual) => actual === error
        );
    let changed = false;
    await assert.rejects(
        h
            .reader(
                {},
                async (address, size) => {
                    const bytes = await h.read(address, size);
                    if (address === base + 128) changed = true;
                    return bytes;
                },
                undefined,
                () => {
                    if (changed) throw Object.assign(new Error("resumed after read"), { code: "DEBUG_STATE_CHANGED" });
                }
            )
            .sample(),
        { code: "DEBUG_STATE_CHANGED" }
    );
    await assert.rejects(
        h
            .reader({}, async () => {
                throw Object.assign(new Error("storage failed"), { code: "LIVE_MEMORY_UNAVAILABLE" });
            })
            .sample(),
        { code: "LIVE_MEMORY_UNAVAILABLE" },
        "reading pointer storage is mandatory and remains a sample-level failure"
    );
    await assert.rejects(
        h.reader({}, undefined, { bytes: 0, commands: 0, deadline: Date.now() - 1 }).sample(),
        { code: "LIVE_READ_BUDGET_EXCEEDED" },
        "the hard time budget is unchanged"
    );

    const polymorphic = harness([
        pointer(1, "data", "Widget *"),
        { kind: "class", typeName: "Widget", byteSize: 4, fields: [{ name: "_vptr.Widget", type: 0, offset: 0 }] }
    ]);
    polymorphic.word(base, base + 128);
    polymorphic.word(base + 128, base + 1024);
    assert.deepStrictEqual(
        await polymorphic.reader().sample(),
        leaf("Widget *", "data", base, base + 128, "layout-unsupported")
    );
    await assert.rejects(
        polymorphic
            .reader({ address: base + 128, runtimeLayout: { ...polymorphic.item.runtimeLayout, root: 1 } })
            .sample(),
        { code: "LIVE_LAYOUT_UNSUPPORTED" },
        "unverified root dynamic identity must still reject the sample"
    );

    const graph = vectorGraph([scalar], 0);
    const corrupt = harness(graph.types, graph.root);
    vectorStorage(corrupt, 1, 4);
    corrupt.word(base + 4, base + 124);
    await assert.rejects(corrupt.reader().sample(), { code: "LIVE_LAYOUT_UNSUPPORTED" });
}

async function rolesAndSummaries() {
    const summary = { kind: "value", targets: ["_M_i"] };
    const h = harness(
        [
            scalar,
            {
                kind: "class",
                typeName: "std::__atomic_base<int>",
                byteSize: 4,
                fields: [{ name: "_M_i", type: 0, offset: 0, memberRole: "internal" }]
            },
            {
                kind: "class",
                typeName: "std::atomic<int>",
                byteSize: 16,
                stdSummary: summary,
                fields: [
                    { name: "@base0", type: 1, offset: 0, memberRole: "internal", isBase: true },
                    { name: "missing", type: 0, offset: 4, memberRole: "artificial", unobservable: "depth-limit" },
                    { name: "secret", type: 0, offset: 8, memberRole: "artificial" },
                    { name: "_vptr.Hidden", type: 0, offset: 12, memberRole: "artificial" }
                ]
            },
            { kind: "class", typeName: "Holder", byteSize: 16, fields: [{ name: "state", type: 2, offset: 0 }] }
        ],
        3
    );
    h.word(base, 7);
    const state = member(await h.reader().sample(), "state");
    assert.deepStrictEqual(state.stdSummary, summary);
    assert.deepStrictEqual(
        summaryRoute(state).map((entry) => entry.name),
        ["@base0", "_M_i"]
    );
    assert.strictEqual(member(state, "@base0").memberRole, "internal");
    assert.strictEqual(member(member(state, "@base0"), "_M_i").memberRole, "internal");
    assert.strictEqual(member(state, "missing").memberRole, "artificial");
    assert.strictEqual(member(state, "missing").unobservable, "depth-limit");
    assert.strictEqual(member(state, "secret").memberRole, "artificial");
    assert(!state.members.some((entry) => entry.name.startsWith("_vptr")), "existing vptr filtering is preserved");
    assert.strictEqual(
        (
            await h
                .reader({
                    runtimeSegments: ["state", "@base0", "_M_i"].map((name) => ({ kind: "member", name }))
                })
                .sample()
        ).value,
        7,
        "raw internal paths retain their identity"
    );

    const named = harness(
        [
            scalar,
            pointer(0),
            {
                kind: "class",
                typeName: "std::shared_ptr<int>",
                byteSize: 4,
                stl: "shared_ptr",
                args: [0],
                stdSummary: { kind: "value", targets: ["_M_ptr"] },
                fields: [{ name: "_M_ptr", type: 1, offset: 0 }]
            }
        ],
        2
    );
    assert.deepStrictEqual((await named.reader().sample()).stdSummary, named.item.runtimeLayout.types[2].stdSummary);
}

async function realFleetGraphs() {
    for (const version of [4, 5]) {
        const buffer = zlib.inflateSync(Buffer.from(fixture["dwarf" + version], "base64"));
        const graph = dwarf.parseDwarf(buffer, { runtime: true }).layouts.get("fleet").runtimeLayout;
        const h = harness(graph.types, graph.root);
        const reader = h.reader({ runtimeStaticPointers: true });
        const object = { address: base, type: graph.root };
        const nodes = await reader.field(object, "nodes");
        const nodeType = reader.type(nodes.type).args[0];
        const width = reader.size(nodeType);
        for (const [name, value] of [
            ["_M_start", base + 128],
            ["_M_finish", base + 128 + 2 * width],
            ["_M_end_of_storage", base + 128 + 2 * width]
        ])
            h.word((await reader.path(nodes, name, true)).address, value);
        for (let index = 0; index < 2; index++) {
            const node = { address: base + 128 + index * width, type: nodeType };
            for (const [name, value] of [
                ["peer", base + 128 + (1 - index) * width],
                ["ctx", 0x40000000 + index * 4],
                ["value", 31 + index]
            ])
                h.word((await reader.field(node, name)).address, value);
        }
        h.word((await reader.field(object, "owner")).address, 0x40000000);
        h.word((await reader.field(object, "handle")).address, base + 8192);
        h.word((await reader.field(object, "count")).address, 2);
        const tree = await reader.sample();
        const elements = member(tree, "nodes").elements;
        assert.strictEqual(elements.length, 2);
        assert.strictEqual(member(elements[0], "value").value, 31);
        assert.strictEqual(member(elements[1], "value").value, 32);
        assert.strictEqual(member(elements[0], "ctx").pointerTarget, "void");
        assert.strictEqual(member(elements[0], "ctx").unavailable, "opaque-pointee");
        const cycle = member(member(member(elements[0], "peer"), "value"), "peer");
        assert.strictEqual(cycle.unavailable, "cycle");
        assert.strictEqual(cycle.value, base + 128);
        assert.strictEqual(member(tree, "handle").pointerTarget, "incomplete", "typedef pointer metadata survives");
        assert.strictEqual(member(tree, "count").value, 2);
    }
}

(async () => {
    await shapesAndOpaqueTargets();
    await cyclesAndLimits();
    await expansionBudgets();
    await localErrorsAndGuards();
    await rolesAndSummaries();
    await realFleetGraphs();
    console.log(
        "Runtime pointer leaves, opaque pointees, local cycles/errors, verification budgets and member roles passed"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
