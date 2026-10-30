"use strict";

const { scenario } = require("./helpers/scenario");

// Synthetic DWARF v4 for C++ symbol identities: unique linkage name matches, scope-chain qualified names, ambiguity
// diagnostics, and no scalar guessing for mangled names without DWARF types. Builds ELF32 + .debug_info/.debug_abbrev
// programmatically.
const assert = require("assert");
const { parseDwarf } = require("../src/dwarf");
const { buildVariableTypes, buildDisplayNames } = require("../src/dwarf/types");
const { ElfService } = require("../src/services/elfService");
const { cstr: str, u32 } = require("./helpers/dwarf-tree");

function loc(addr) {
    // DW_FORM_exprloc: length 5, DW_OP_addr (0x03) + 4-byte address
    return [5, 0x03, ...u32(addr)];
}

// .debug_info (@N marks section offsets referenced by ref4)
const di = [];
di.push(...u32(0)); // unit_length placeholder
di.push(4, 0); // version = 4
di.push(...u32(0)); // debug_abbrev_offset = 0
di.push(4); // address_size = 4
di.push(1); // @11 compile_unit
di.push(2, ...str("int"), 0x05, 4); // @12 base_type int (signed,4B)
di.push(3, ...str("ns")); // @19 namespace ns (with children)
di.push(4, ...str("Foo"), 4); // @23 class_type Foo (byte_size 4, with children)
di.push(5, ...str("value"), ...u32(12), 0); // @29 member value -> int@12, offset 0
// @41 static class member
di.push(6, ...str("staticMemb"), ...u32(12), ...str("_ZN2ns3Foo10staticMembE"), ...loc(0x20000010));
di.push(0); // end Foo children
di.push(6, ...str("nsVar"), ...u32(12), ...str("_ZN2ns5nsVarE"), ...loc(0x20000020)); // namespace variable
di.push(7, ...str("func"), ...str("_ZN2ns4funcEv")); // namespace function
di.push(0); // end namespace children
di.push(0); // end CU children
const unitLen = di.length - 4;
di[0] = unitLen & 0xff;
di[1] = (unitLen >>> 8) & 0xff;
di[2] = (unitLen >>> 16) & 0xff;
di[3] = (unitLen >>> 24) & 0xff;
const debugInfo = Buffer.from(di);

// .debug_abbrev (code, tag, has_children, [attr, form]..., 0, 0)
const abbrev = Buffer.from([
    1,
    0x11,
    1,
    0,
    0, // compile_unit
    2,
    0x24,
    0,
    0x03,
    0x08,
    0x3e,
    0x0b,
    0x0b,
    0x0b,
    0,
    0, // base_type: name,encoding,byte_size
    3,
    0x39,
    1,
    0x03,
    0x08,
    0,
    0, // namespace: name
    4,
    0x02,
    1,
    0x03,
    0x08,
    0x0b,
    0x0b,
    0,
    0, // class_type: name,byte_size
    5,
    0x0d,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0x38,
    0x0b,
    0,
    0, // member: name,type,data_member_location
    6,
    0x34,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0x6e,
    0x08,
    0x02,
    0x18,
    0,
    0, // variable: name,type,linkage_name,location
    7,
    0x2e,
    0,
    0x03,
    0x08,
    0x6e,
    0x08,
    0,
    0, // subprogram: name,linkage_name
    0
]);

// Assemble ELF32 LE (only .debug_info/.debug_abbrev/.shstrtab)
const names = ["", ".debug_info", ".debug_abbrev", ".shstrtab"];
const nameOff = {};
const shBytes = [];
for (const nm of names) {
    nameOff[nm] = shBytes.length;
    for (const ch of Buffer.from(nm, "latin1")) shBytes.push(ch);
    shBytes.push(0);
}
const shstrtab = Buffer.from(shBytes);
const diOff = 52;
const abOff = diOff + debugInfo.length;
const shstrOff = abOff + abbrev.length;
const shoff = (shstrOff + shstrtab.length + 3) & ~3;
const shnum = 4;
const buf = Buffer.alloc(shoff + shnum * 40);
buf[0] = 0x7f;
buf[1] = 0x45;
buf[2] = 0x4c;
buf[3] = 0x46;
buf[4] = 1;
buf[5] = 1;
buf[6] = 1;
buf.writeUInt16LE(2, 16);
buf.writeUInt16LE(0x28, 18);
buf.writeUInt32LE(1, 20);
buf.writeUInt32LE(shoff, 32);
buf.writeUInt16LE(52, 40);
buf.writeUInt16LE(40, 46);
buf.writeUInt16LE(shnum, 48);
buf.writeUInt16LE(3, 50);
debugInfo.copy(buf, diOff);
abbrev.copy(buf, abOff);
shstrtab.copy(buf, shstrOff);
const sh = (i) => shoff + i * 40;
buf.writeUInt32LE(nameOff[".debug_info"], sh(1) + 0);
buf.writeUInt32LE(1, sh(1) + 4);
buf.writeUInt32LE(diOff, sh(1) + 16);
buf.writeUInt32LE(debugInfo.length, sh(1) + 20);
buf.writeUInt32LE(nameOff[".debug_abbrev"], sh(2) + 0);
buf.writeUInt32LE(1, sh(2) + 4);
buf.writeUInt32LE(abOff, sh(2) + 16);
buf.writeUInt32LE(abbrev.length, sh(2) + 20);
buf.writeUInt32LE(nameOff[".shstrtab"], sh(3) + 0);
buf.writeUInt32LE(3, sh(3) + 4);
buf.writeUInt32LE(shstrOff, sh(3) + 16);
buf.writeUInt32LE(shstrtab.length, sh(3) + 20);

// Parse: linkage name keys and qualified names
const parsed = parseDwarf(buf);
assert.strictEqual(
    parsed.displayNames.get("_ZN2ns3Foo10staticMembE"),
    "ns::Foo::staticMemb",
    "static class member qualified names come from the scope chain"
);
assert.strictEqual(parsed.displayNames.get("_ZN2ns5nsVarE"), "ns::nsVar", "namespace variable qualified name");
assert.strictEqual(
    parsed.displayNames.get("_ZN2ns4funcEv"),
    "ns::func",
    "function qualified names come from subprograms"
);
assert.strictEqual(parsed.types.get("_ZN2ns3Foo10staticMembE").typeName, "int", "types are keyed by linkage name");

// buildVariableTypes: same name with different types -> marked ambiguous, no type bound
const ambiguousTypes = buildVariableTypes({
    dies: new Map([
        [1, { tag: 0x24, name: "int", encoding: 0x05, byteSize: 4 }],
        [2, { tag: 0x24, name: "float", encoding: 0x04, byteSize: 4 }]
    ]),
    childrenMap: new Map(),
    variables: [
        { name: "x", linkageName: "_Z1x", typeRef: 1 },
        { name: "x", linkageName: "_Z1x", typeRef: 2 }
    ]
});
assert.strictEqual(
    ambiguousTypes.get("_Z1x").ambiguous,
    true,
    "one linkage name with conflicting types is marked ambiguous"
);

// buildDisplayNames merges variables and functions
const display = buildDisplayNames({
    variables: [{ name: "v", linkageName: "_Z1v", qualifiedName: "ns::v" }],
    subprograms: [{ name: "f", linkageName: "_Z1fv", qualifiedName: "ns::f" }]
});
assert.strictEqual(display.get("_Z1v"), "ns::v");
assert.strictEqual(display.get("_Z1fv"), "ns::f");

// ElfService binding
function makeService(symbols, functions, dwarfResult) {
    return new ElfService({
        context: { workspaceState: { get: () => "/fake/x.elf" } },
        cacheKey: "elf",
        fs: {
            statSync: () => ({ size: buf.length, mtimeMs: 1 }),
            readFileSync: () => buf
        },
        crypto: require("crypto"),
        cleanPath: (v) => v,
        t: (key) => key,
        elfSymbols: {
            parseElfSections: () => ({ sections: [], programHeaders: [] }),
            parseElfSymbols: () => ({ symbols, functions, warnings: [] }),
            defaultType: (size) => (size === 8 ? "u64" : "u32")
        },
        dwarf: { parseDwarf: () => dwarfResult }
    });
}

// A: real parse results bind displayName and type; mangled names without types are not guessed as scalars
{
    const res = makeService(
        [
            { name: "_ZN2ns3Foo10staticMembE", size: 4, address: 0x20000010 },
            { name: "_ZN2ns5nsVarE", size: 4, address: 0x20000020 },
            { name: "_ZN2ns9unresolvedE", size: 16, address: 0x20000040 }
        ],
        [{ name: "_ZN2ns4funcEv", address: 0x08000100, size: 16 }],
        parsed
    ).read();
    const staticMemb = res.symbols.find((s) => s.name === "_ZN2ns3Foo10staticMembE");
    assert.strictEqual(staticMemb.displayName, "ns::Foo::staticMemb");
    assert.strictEqual(staticMemb.isComposite, false);
    assert.strictEqual(staticMemb.watchType, "i32");
    assert.strictEqual(res.symbols.find((s) => s.name === "_ZN2ns5nsVarE").displayName, "ns::nsVar");
    const unresolved = res.symbols.find((s) => s.name === "_ZN2ns9unresolvedE");
    assert.strictEqual(unresolved.isComposite, true, "mangled names without a DWARF type are not guessed as scalars");
    assert.strictEqual(unresolved.compositeLayout, null);
    assert.ok(unresolved.unsupportedReason, "gives the reason it is unavailable");
    assert.ok(
        res.diagnostics.some((d) => d.code === "CPP_TYPE_UNRESOLVED"),
        "reports a CPP_TYPE_UNRESOLVED diagnostic"
    );
    assert.strictEqual(res.functions[0].displayName, "ns::func", "functions carry display names");
}

// B: ambiguous linkage name -> CPP_SYMBOL_AMBIGUOUS, no type bound
{
    const res = makeService([{ name: "_Z3amb", size: 4, address: 0x20000080 }], [], {
        types: new Map([["_Z3amb", { ambiguous: true, typeName: "", watchType: "" }]]),
        layouts: new Map(),
        displayNames: new Map([["_Z3amb", "ns::amb"]]),
        diagnostics: []
    }).read();
    const sym = res.symbols[0];
    assert.strictEqual(sym.isComposite, true);
    assert.strictEqual(sym.compositeLayout, null);
    assert.strictEqual(sym.watchType, "");
    assert.ok(
        res.diagnostics.some((d) => d.code === "CPP_SYMBOL_AMBIGUOUS"),
        "reports a CPP_SYMBOL_AMBIGUOUS diagnostic"
    );
}

// C: DWARF matches the symbol but its type is unknown, so no observable scalar is guessed from the size.
{
    const res = makeService([{ name: "_Z7unknown", size: 4, address: 0x20000084 }], [], {
        types: new Map([["_Z7unknown", { kind: "unknown", typeName: "", watchType: "" }]]),
        layouts: new Map(),
        displayNames: new Map(),
        diagnostics: []
    }).read();
    assert.strictEqual(res.symbols[0].isComposite, true);
    assert.strictEqual(res.symbols[0].watchType, "");
    assert.ok(res.diagnostics.some((d) => d.code === "CPP_TYPE_UNRESOLVED"));
}

scenario("Resolve structurally identical inline objects across compilation units", () => {
    const c = require("../src/dwarf/constants");
    const { createCompositeLayoutResolver } = require("../src/dwarf/types");
    {
        // CU1 and CU2 each have a Widget DIE with the same name and structure but different typeRefs
        const dies = new Map([
            [1, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 }],
            // Widget in CU1
            [100, { tag: c.DW_TAG_structure_type, name: "Widget", byteSize: 8 }],
            [101, { tag: c.DW_TAG_member, name: "w", typeRef: 1, memberOffset: 0 }],
            [102, { tag: c.DW_TAG_member, name: "h", typeRef: 1, memberOffset: 4 }],
            // Widget in CU2
            [200, { tag: c.DW_TAG_structure_type, name: "Widget", byteSize: 8 }],
            [201, { tag: c.DW_TAG_member, name: "w", typeRef: 1, memberOffset: 0 }],
            [202, { tag: c.DW_TAG_member, name: "h", typeRef: 1, memberOffset: 4 }]
        ]);
        const childrenMap = new Map([
            [100, [101, 102]],
            [200, [201, 202]]
        ]);
        const parsed = {
            dies,
            childrenMap,
            variables: [
                { name: "state", typeRef: 100 },
                { name: "state", typeRef: 200 }
            ]
        };
        const resolver = createCompositeLayoutResolver(parsed);
        const layout = resolver("state");
        assert.ok(layout, "identical inline objects across CUs must not be marked ambiguous or dropped");
        assert.strictEqual(layout.members.length, 2);
        for (const [index, name] of ["w", "h"].entries()) {
            assert.strictEqual(layout.members[index].name, name, `cross-CU inline member: ${index}`);
        }
    }
});

scenario("Preserve cross-CU ambiguity and independent type comparison budgets", () => {
    const c = require("../src/dwarf/constants");
    const { createTypeComparer } = require("../src/dwarf/typeIdentity");
    const { base, composite, fixture, member, variable } = require("./helpers/dwarf-tree");
    function ambiguityTests() {
        for (const sameSize of [false, true]) {
            const f = fixture([
                [
                    base("int"),
                    composite("a", "", 4, [member("x", "x", "int", 0)], c.DW_TAG_structure_type),
                    variable("ctx", "a")
                ],
                [
                    base("double", "double", sameSize ? 4 : 8, c.DW_ATE_float),
                    composite("b", "", sameSize ? 4 : 16, [member("y", "y", "double", 0)], c.DW_TAG_structure_type),
                    variable("ctx", "b", 0x20000000)
                ]
            ]);
            const result = parseDwarf(f.buffer);
            assert.strictEqual(result.types.get("ctx").ambiguous, true);
            assert.strictEqual(result.layouts.has("ctx"), false);
            const enriched = { symbols: [{ name: "ctx", address: 0x20000000, size: 16 }] };
            new ElfService({ t: (key) => key })._enrich(enriched, result.types, result.layouts);
            assert.match(enriched.symbols[0].unsupportedReason, /ambiguous/i);
        }
        // Same-named, same-typed statics in different CUs (static int state;) keep their type.
        const statics = fixture([
            [base("int"), variable("state", "int", 0x20000000)],
            [base("int"), variable("state", "int", 0x20000004)]
        ]);
        const staticResult = parseDwarf(statics.buffer);
        assert.strictEqual(staticResult.types.get("state").ambiguous, undefined);
        assert.strictEqual(staticResult.types.get("state").watchType, "i32");
    }
    function comparisonBudgetTests() {
        // One oversized comparison must not starve later, unrelated comparisons.
        const dies = new Map();
        const childrenMap = new Map();
        for (const root of [1, 2]) {
            dies.set(root, { tag: c.DW_TAG_structure_type, name: "Big", byteSize: 4 });
            const kids = [];
            for (let index = 0; index < 20000; index++) {
                const off = root * 100000 + index;
                dies.set(off, { tag: c.DW_TAG_member, name: "m" + index, memberOffset: 0 });
                kids.push(off);
            }
            childrenMap.set(root, kids);
        }
        dies.set(3, { tag: c.DW_TAG_base_type, name: "int", byteSize: 4, encoding: c.DW_ATE_signed });
        dies.set(4, { tag: c.DW_TAG_base_type, name: "int", byteSize: 4, encoding: c.DW_ATE_signed });
        const equivalent = createTypeComparer({ dies, childrenMap });
        assert.strictEqual(equivalent(1, 2), false, "oversized comparison falls back");
        assert.strictEqual(equivalent(3, 4), true, "later comparison has its own budget");
    }
    scenario("Conflicting anonymous types and same-named statics", ambiguityTests);
    scenario("Independent type comparison budgets", comparisonBudgetTests);
});

scenario("Reject conflicting CU layouts and unknown member addresses", () => {
    const c = require("../src/dwarf/constants");
    const elf = require("../src/elfSymbols");
    const { buildCompositeLayouts } = require("../src/dwarf/types");
    // Equal outer names and sizes do not make conflicting CU definitions interchangeable.
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
    assert.strictEqual(buildCompositeLayouts(parsed).has("state"), false);
    dies.set(30, { tag: c.DW_TAG_structure_type, name: "UnknownLocation", byteSize: 4 });
    dies.set(31, { tag: c.DW_TAG_member, name: "value", typeRef: 1 });
    parsed.childrenMap.set(30, [31]);
    parsed.variables = [{ name: "unknown", typeRef: 30 }];
    assert.deepStrictEqual(
        elf.expandCompositeLeaves(
            { name: "unknown", size: 4, address: 0x20000000 },
            buildCompositeLayouts(parsed).get("unknown")
        ),
        []
    );
});

console.log("C++ symbol identity tests passed");
