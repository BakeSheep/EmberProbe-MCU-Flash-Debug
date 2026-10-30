"use strict";

const { scenario } = require("./helpers/scenario");

// Path parsing, leaf expansion, decoding and tree navigation of composite types (structs/arrays). All pure function
// tests driven by hand-written layouts and byte buffers, with no ELF/DWARF.
const assert = require("assert");
const {
    parseMemberPath,
    expandCompositeLeaves,
    decodeComposite,
    navigateCompositeTree,
    isScalarLeafNode
} = require("../src/elfSymbols");

// —— parseMemberPath ——
assert.deepStrictEqual(parseMemberPath("sensor.x"), { base: "sensor", segments: [{ kind: "member", name: "x" }] });
assert.deepStrictEqual(parseMemberPath("buf[0]"), { base: "buf", segments: [{ kind: "index", index: 0 }] });
assert.deepStrictEqual(parseMemberPath("buf[1:5]"), { base: "buf", segments: [{ kind: "range", start: 1, end: 5 }] });
assert.deepStrictEqual(parseMemberPath("buf[*]"), { base: "buf", segments: [{ kind: "all" }] });
assert.deepStrictEqual(parseMemberPath("s.pos.y"), {
    base: "s",
    segments: [
        { kind: "member", name: "pos" },
        { kind: "member", name: "y" }
    ]
});
assert.strictEqual(parseMemberPath(""), null);
assert.strictEqual(parseMemberPath("buf[abc]"), null, "non-numeric indexes are invalid");
assert.strictEqual(parseMemberPath("buf[-1]"), null, "negative indexes are invalid");
assert.strictEqual(parseMemberPath("buf[1x]"), null, "indexes with trailing characters are invalid");
assert.strictEqual(parseMemberPath("buf[3:1]"), null, "reversed or empty ranges are invalid");

// Struct layout: struct Sensor { i32 x@0; f32 y@4; u16 flags@8; }
const sensorLayout = {
    kind: "struct",
    typeName: "struct Sensor",
    byteSize: 12,
    members: [
        { name: "x", offset: 0, byteSize: 4, watchType: "i32", typeName: "int" },
        { name: "y", offset: 4, byteSize: 4, watchType: "f32", typeName: "float" },
        { name: "flags", offset: 8, byteSize: 2, watchType: "u16", typeName: "unsigned short" }
    ]
};
// x = -1 (0xFFFFFFFF), y = 110.0f (0x42DC0000), flags = 0x1234
const sensorBytes = [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0xdc, 0x42, 0x34, 0x12, 0x00, 0x00];

const sym = { name: "sensor", address: 0x20000100, size: 12 };
// No path: expand every scalar leaf
const allLeaves = expandCompositeLeaves(sym, sensorLayout, null);
assert.deepStrictEqual(
    allLeaves.map((l) => [l.path, l.address, l.size, l.type]),
    [
        ["sensor.x", 0x20000100, 4, "i32"],
        ["sensor.y", 0x20000104, 4, "f32"],
        ["sensor.flags", 0x20000108, 2, "u16"]
    ]
);
// Single member path sensor.y -> one leaf at base + 4
const yLeaf = expandCompositeLeaves(sym, sensorLayout, parseMemberPath("sensor.y"));
assert.deepStrictEqual(yLeaf, [
    { name: "sensor", path: "sensor.y", address: 0x20000104, size: 4, type: "f32", typeName: "float" }
]);

// decodeComposite: struct decoding with absolute offsets
const sensorTree = decodeComposite(sensorBytes, sensorLayout);
assert.strictEqual(sensorTree.kind, "struct");
assert.strictEqual(sensorTree.members.length, 3);
assert.deepStrictEqual(sensorTree.members[0], {
    name: "x",
    offset: 0,
    value: -1,
    valueText: null,
    type: "i32",
    typeName: "int"
});
assert.deepStrictEqual(sensorTree.members[1], {
    name: "y",
    offset: 4,
    value: 110,
    valueText: null,
    type: "f32",
    typeName: "float"
});
assert.deepStrictEqual(sensorTree.members[2], {
    name: "flags",
    offset: 8,
    value: 0x1234,
    valueText: null,
    type: "u16",
    typeName: "unsigned short"
});

const bitfieldLayout = {
    kind: "struct",
    typeName: "struct Flags",
    byteSize: 4,
    members: [
        { name: "a", offset: 0, byteSize: 4, watchType: "u32", typeName: "unsigned int", bitOffset: 0, bitSize: 4 },
        { name: "b", offset: 0, byteSize: 4, watchType: "u32", typeName: "unsigned int", bitOffset: 4, bitSize: 4 }
    ]
};
const bitfieldTree = decodeComposite([0xba, 0, 0, 0], bitfieldLayout);
assert.deepStrictEqual(
    bitfieldTree.members.map((member) => member.value),
    [0x0a, 0x0b]
);
assert.deepStrictEqual(
    expandCompositeLeaves({ name: "flags", address: 0x20000400, size: 4 }, bitfieldLayout, null).map((leaf) => [
        leaf.path,
        leaf.address,
        leaf.bitOffset,
        leaf.bitSize
    ]),
    [
        ["flags.a", 0x20000400, 0, 4],
        ["flags.b", 0x20000400, 4, 4]
    ],
    "bitfield leaves must preserve their containing word and bit slice"
);

// —— navigateCompositeTree + isScalarLeafNode ——
assert.strictEqual(navigateCompositeTree(sensorTree, null), sensorTree, "no path returns the whole tree");
const nodeY = navigateCompositeTree(sensorTree, parseMemberPath("sensor.y"));
assert.ok(isScalarLeafNode(nodeY));
assert.strictEqual(nodeY.value, 110);
assert.strictEqual(nodeY.offset, 4);
assert.strictEqual(
    navigateCompositeTree(sensorTree, parseMemberPath("sensor.missing")),
    null,
    "a missing member returns null"
);
assert.strictEqual(isScalarLeafNode(sensorTree), false, "a struct node is not a scalar leaf");

// Array layout: u32 buf[4]
const arrayLayout = {
    kind: "array",
    typeName: "unsigned int[]",
    byteSize: 16,
    elementType: { typeName: "unsigned int", watchType: "u32", byteSize: 4, kind: "scalar" },
    dimensions: [4],
    totalElements: 4
};
// [10, 20, 300, 40000]
const arrBytes = [10, 0, 0, 0, 20, 0, 0, 0, 0x2c, 0x01, 0, 0, 0x40, 0x9c, 0, 0];
const arrTree = decodeComposite(arrBytes, arrayLayout);
assert.strictEqual(arrTree.kind, "array");
assert.deepStrictEqual(
    arrTree.elements.map((e) => [e.index, e.offset, e.value]),
    [
        [0, 0, 10],
        [1, 4, 20],
        [2, 8, 300],
        [3, 12, 40000]
    ]
);
// buf[2] -> scalar leaf
const el2 = navigateCompositeTree(arrTree, parseMemberPath("buf[2]"));
assert.ok(isScalarLeafNode(el2));
assert.strictEqual(el2.value, 300);
assert.strictEqual(el2.offset, 8);
// buf[1:3] -> synthesized array subtree with only indexes 1 and 2
const rng = navigateCompositeTree(arrTree, parseMemberPath("buf[1:3]"));
assert.strictEqual(rng.kind, "array");
assert.deepStrictEqual(
    rng.elements.map((e) => e.index),
    [1, 2]
);
assert.strictEqual(rng.offset, 4, "a range subtree takes the first element's offset");
// buf[*] -> the whole array
const allEl = navigateCompositeTree(arrTree, parseMemberPath("buf[*]"));
assert.strictEqual(allEl, arrTree);

// Array leaf expansion: buf[1:3]
const arrSym = { name: "buf", address: 0x20000200, size: 16 };
const rngLeaves = expandCompositeLeaves(arrSym, arrayLayout, parseMemberPath("buf[1:3]"));
assert.deepStrictEqual(
    rngLeaves.map((l) => [l.path, l.address, l.type]),
    [
        ["buf[1]", 0x20000204, "u32"],
        ["buf[2]", 0x20000208, "u32"]
    ]
);
assert.deepStrictEqual(
    expandCompositeLeaves(arrSym, arrayLayout, parseMemberPath("buf[4]")),
    [],
    "an index equal to the array length is rejected"
);
assert.deepStrictEqual(
    expandCompositeLeaves(arrSym, arrayLayout, parseMemberPath("buf[1:5]")),
    [],
    "a range past the array length is rejected"
);

// Array of structs: expansion, decoding and deep path navigation
const sensorArrayLayout = {
    kind: "array",
    typeName: "struct Sensor[]",
    byteSize: 24,
    elementType: {
        typeName: "struct Sensor",
        watchType: "",
        byteSize: 12,
        kind: "struct",
        compositeLayout: sensorLayout
    },
    dimensions: [2],
    totalElements: 2
};
const structWithArrayLayout = {
    kind: "struct",
    typeName: "struct WithArray",
    byteSize: 20,
    members: [
        { name: "tag", offset: 0, byteSize: 4, watchType: "u32", typeName: "unsigned int" },
        {
            name: "arr",
            offset: 4,
            byteSize: 16,
            watchType: "",
            typeName: "unsigned int[]",
            compositeLayout: arrayLayout
        }
    ]
};
assert.deepStrictEqual(
    expandCompositeLeaves(
        { name: "s", address: 0x20000300, size: 20 },
        structWithArrayLayout,
        parseMemberPath("s.arr[1:3]")
    ).map((leaf) => [leaf.path, leaf.address]),
    [
        ["s.arr[1]", 0x20000308],
        ["s.arr[2]", 0x2000030c]
    ],
    "a range below a struct member must be consumed exactly once"
);
const sensorArrayBytes = Buffer.concat([Buffer.from(sensorBytes), Buffer.from(sensorBytes)]);
const sensorArrayTree = decodeComposite(sensorArrayBytes, sensorArrayLayout);
assert.strictEqual(sensorArrayTree.elements[1].members[1].value, 110);
assert.strictEqual(sensorArrayTree.elements[1].members[1].offset, 16);
const arrayMember = navigateCompositeTree(sensorArrayTree, parseMemberPath("sensors[1].y"));
assert.ok(isScalarLeafNode(arrayMember));
assert.strictEqual(arrayMember.offset, 16);
assert.deepStrictEqual(
    expandCompositeLeaves(
        { name: "sensors", address: 0x20000400, size: 24 },
        sensorArrayLayout,
        parseMemberPath("sensors[1].y")
    ).map((l) => [l.path, l.address, l.type]),
    [["sensors[1].y", 0x20000410, "f32"]]
);
// A member access after a range or all selection of composite elements has no single layout to navigate, so nothing is
// produced; this pins that behaviour so no wrong address is ever generated.
assert.deepStrictEqual(
    expandCompositeLeaves(
        { name: "sensors", address: 0x20000400, size: 24 },
        sensorArrayLayout,
        parseMemberPath("sensors[0:2].y")
    ),
    []
);

// Too few bytes decode a scalar as null without throwing
const shortTree = decodeComposite([0xff, 0xff], sensorLayout);
assert.strictEqual(shortTree.members[0].value, null);

const wideLayout = {
    kind: "struct",
    typeName: "struct Wide",
    byteSize: 16,
    members: [
        { name: "count", offset: 0, byteSize: 8, watchType: "u64", typeName: "unsigned long long" },
        { name: "delta", offset: 8, byteSize: 8, watchType: "i64", typeName: "long long" }
    ]
};
const wideBytes = Buffer.alloc(16);
wideBytes.writeBigUInt64LE(18446744073709551615n, 0);
wideBytes.writeBigInt64LE(-9223372036854775808n, 8);
const wideTree = decodeComposite(wideBytes, wideLayout);
assert.strictEqual(wideTree.members[0].valueText, "18446744073709551615");
assert.strictEqual(wideTree.members[1].valueText, "-9223372036854775808");

// Skill script variableSpecs: path syntax is not split at ':' into a type
const liveSkill = require("../skills/mcu-variables/scripts/read");
assert.deepStrictEqual(liveSkill.variableSpecs("sensor.x,buf[1:5],buf[*],counter,temp:f32"), [
    { name: "sensor.x" },
    { name: "buf[1:5]" },
    { name: "buf[*]" },
    { name: "counter" },
    { name: "temp", type: "f32" }
]);
assert.throws(() => liveSkill.variableSpecs("counter:bogus"), /Unsupported variable type/);
assert.deepStrictEqual(liveSkill.variableSpecs("ns::value,ns::Foo::member,ns::count:u32"), [
    { name: "ns::value" },
    { name: "ns::Foo::member" },
    { name: "ns::count", type: "u32" }
]);

scenario("Reject invalid composite paths and out-of-bounds expansion", () => {
    const { expandCompositeLeaves, parseMemberPath } = require("../src/elfSymbols");
    const symbol = { name: "sensor", address: 0x20000000, size: 4 };
    const layout = { kind: "struct", byteSize: 4, members: [{ name: "x", offset: 0, byteSize: 4, watchType: "u32" }] };
    assert.deepStrictEqual(expandCompositeLeaves(symbol, layout, parseMemberPath("sensor.x.invalid")), []);
    const array = {
        kind: "array",
        byteSize: 4,
        totalElements: 4,
        elementType: { byteSize: 1, watchType: "u8", kind: "scalar" }
    };
    assert.deepStrictEqual(expandCompositeLeaves(symbol, array, parseMemberPath("sensor[0].x")), []);
    assert.throws(() => expandCompositeLeaves(symbol, { ...array, totalElements: 100000000 }, null), /budget/);
    assert.throws(() => expandCompositeLeaves({ ...symbol, address: 0xffffffff }, layout, null), /budget/);
    assert.throws(
        () => expandCompositeLeaves(symbol, { ...layout, members: [{ ...layout.members[0], offset: 4 }] }, null),
        /budget/
    );
});

scenario("Navigate template-qualified and promoted anonymous union paths", () => {
    const {
        parseMemberPath,
        expandCompositeLeaves,
        decodeComposite,
        navigateCompositeTree
    } = require("../src/elfSymbols");
    {
        // Template member paths
        const parsedTmpl = parseMemberPath("Holder<int>::object.a");
        assert.deepStrictEqual(parsedTmpl, {
            base: "Holder<int>::object",
            segments: [{ kind: "member", name: "a" }]
        });

        const parsedComplex = parseMemberPath("ns::Matrix<float, 3, 3>::identity[0][1]");
        assert.deepStrictEqual(parsedComplex, {
            base: "ns::Matrix<float, 3, 3>::identity",
            segments: [
                { kind: "index", index: 0 },
                { kind: "index", index: 1 }
            ]
        });

        // Anonymous union expansion and path navigation
        const anonLayout = {
            kind: "struct",
            typeName: "struct Container",
            byteSize: 8,
            members: [
                { name: "id", offset: 0, byteSize: 4, watchType: "u32", typeName: "unsigned int" },
                {
                    name: "",
                    offset: 4,
                    byteSize: 4,
                    kind: "union",
                    typeName: "union",
                    compositeLayout: {
                        kind: "union",
                        typeName: "union",
                        byteSize: 4,
                        members: [
                            { name: "a", offset: 0, byteSize: 4, watchType: "i32", typeName: "int" },
                            { name: "b", offset: 0, byteSize: 4, watchType: "f32", typeName: "float" }
                        ]
                    }
                }
            ]
        };

        const sym = { name: "anon", address: 0x20000000, size: 8 };

        // Full leaf expansion must not contain '?'
        const allLeaves = expandCompositeLeaves(sym, anonLayout, null);
        assert.deepStrictEqual(
            allLeaves.map((l) => l.path),
            ["anon.id", "anon.a", "anon.b"],
            "anonymous union leaves must have natural paths without '?'"
        );

        // Natural path navigation: anon.a
        const leafA = expandCompositeLeaves(sym, anonLayout, parseMemberPath("anon.a"));
        assert.strictEqual(leafA.length, 1);
        assert.strictEqual(leafA[0].path, "anon.a");
        assert.strictEqual(leafA[0].address, 0x20000004);
        assert.strictEqual(leafA[0].type, "i32");

        // Explicit anonymous segment navigation still works: anon.?.a
        const leafAnonA = expandCompositeLeaves(sym, anonLayout, parseMemberPath("anon.?.a"));
        assert.strictEqual(leafAnonA.length, 1);
        assert.strictEqual(leafAnonA[0].address, 0x20000004);

        // Tree navigation
        const tree = decodeComposite([1, 0, 0, 0, 42, 0, 0, 0], anonLayout);
        const nodeA = navigateCompositeTree(tree, parseMemberPath("anon.a"));
        assert.ok(nodeA);
        assert.strictEqual(nodeA.value, 42);

        const nodeAnonA = navigateCompositeTree(tree, parseMemberPath("anon.?.a"));
        assert.ok(nodeAnonA);
        assert.strictEqual(nodeAnonA.value, 42);
    }
});

scenario("Decode real ARM bitfields, UTF characters and anonymous union members", () => {
    const zlib = require("zlib");
    const dwarf = require("../src/dwarf");
    const elf = require("../src/elfSymbols");
    const { ElfService } = require("../src/services/elfService");
    const fixtures = require("./fixtures/cpp-review/elf.json");
    // Use real GCC DWARF output without requiring a compiler or connected board in CI.
    for (const version of [4, 5]) {
        const buffer = zlib.inflateSync(Buffer.from(fixtures[`dwarf${version}`], "base64"));
        const parsed = dwarf.parseDwarf(buffer);
        const result = elf.parseElfSymbols(buffer);
        new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
            result,
            parsed.types,
            parsed.layouts,
            parsed.displayNames
        );
        const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
        const bytesOf = (name) => {
            const symbol = byName.get(name);
            const section = elf
                .parseElfSections(buffer)
                .sections.find(
                    (section) => symbol.address >= section.addr && symbol.address < section.addr + section.size
                );
            const offset = section.offset + symbol.address - section.addr;
            return buffer.subarray(offset, offset + symbol.size);
        };
        assert.deepStrictEqual(
            elf.decodeComposite(bytesOf("bits"), parsed.layouts.get("bits")).members.map((member) => member.value),
            [1, 2, 3]
        );
        assert.deepStrictEqual(
            elf.decodeComposite(bytesOf("packed"), parsed.layouts.get("packed")).members.map((member) => member.value),
            [3, -2]
        );
        assert.deepStrictEqual(
            elf.decodeComposite(bytesOf("utfbox"), parsed.layouts.get("utfbox")).members.map((member) => member.value),
            [90, 90]
        );
        const anon = byName.get("anon");
        assert.strictEqual(
            elf.expandCompositeLeaves(anon, anon.compositeLayout, elf.parseMemberPath("anon.a"))[0].address,
            anon.address
        );
        assert.strictEqual(
            elf.navigateCompositeTree(
                elf.decodeComposite(bytesOf("anon"), anon.compositeLayout),
                elf.parseMemberPath("anon.a")
            ).value,
            7
        );
    }
});

scenario("Retain array constness and nested anonymous member identity", () => {
    const c = require("../src/dwarf/constants");
    const elf = require("../src/elfSymbols");
    const { buildCompositeLayouts, buildVariableTypes } = require("../src/dwarf/types");
    const dies = new Map([
        [1, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 }],
        [10, { tag: c.DW_TAG_structure_type, name: "Same", byteSize: 8 }],
        [11, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 0 }],
        [20, { tag: c.DW_TAG_structure_type, name: "Same", byteSize: 8 }],
        [21, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 4 }]
    ]);
    const parsed = {
        dies,
        childrenMap: new Map([
            [10, [11]],
            [20, [21]]
        ]),
        variables: [
            { name: "state", typeRef: 10 },
            { name: "state", typeRef: 20 }
        ]
    };
    // Array element constness must survive layout construction, including explicit index paths.
    dies.set(40, { tag: c.DW_TAG_const_type, typeRef: 1 });
    dies.set(41, { tag: c.DW_TAG_array_type, typeRef: 40 });
    dies.set(42, { tag: c.DW_TAG_subrange_type, subrangeCount: 2 });
    parsed.childrenMap.set(41, [42]);
    parsed.variables = [{ name: "array", typeRef: 41 }];
    assert.strictEqual(buildVariableTypes(parsed).get("array").isConst, true);
    const array = buildCompositeLayouts(parsed).get("array");
    const arraySymbol = { name: "array", size: 8, address: 0x20000000 };
    assert.ok(elf.expandCompositeLeaves(arraySymbol, array).every((leaf) => leaf.isConst));
    assert.strictEqual(elf.expandCompositeLeaves(arraySymbol, array, elf.parseMemberPath("array[1]"))[0].isConst, true);

    const scalar = { name: "value", offset: 0, byteSize: 4, watchType: "i32" };
    const innermost = { kind: "union", byteSize: 4, members: [scalar] };
    const anonymous = {
        kind: "struct",
        byteSize: 4,
        members: [{ name: "", offset: 0, byteSize: 4, compositeLayout: innermost }]
    };
    const root = {
        kind: "struct",
        byteSize: 8,
        isConst: true,
        members: [{ name: "", offset: 4, byteSize: 4, compositeLayout: anonymous }]
    };
    const rootSymbol = { name: "root", size: 8, address: 0x20000000 };
    assert.strictEqual(
        elf.expandCompositeLeaves(rootSymbol, root, elf.parseMemberPath("root.value"))[0].address,
        0x20000004
    );
    assert.strictEqual(elf.expandCompositeLeaves(rootSymbol, root, elf.parseMemberPath("root.value"))[0].isConst, true);
    assert.strictEqual(
        elf.navigateCompositeTree(
            elf.decodeComposite([0, 0, 0, 0, 7, 0, 0, 0], root),
            elf.parseMemberPath("root.value")
        ).value,
        7
    );
    const ambiguous = { ...root, members: [...root.members, { ...root.members[0], offset: 0 }] };
    assert.deepStrictEqual(elf.expandCompositeLeaves(rootSymbol, ambiguous, elf.parseMemberPath("root.value")), []);
    assert.strictEqual(
        elf.navigateCompositeTree(
            elf.decodeComposite([0, 0, 0, 0, 7, 0, 0, 0], ambiguous),
            elf.parseMemberPath("root.value")
        ),
        null
    );
    assert.strictEqual(elf.parseMemberPath("name+1"), null);
    assert.ok(elf.parseMemberPath("ns::Holder<std::array<std::array<int, 2>, 3>>::object.value"));
});

console.log("Composite decode & navigation tests passed");
