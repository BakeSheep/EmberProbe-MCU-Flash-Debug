"use strict";

const { scenario } = require("./helpers/scenario");

// 合成 DWARF v4 覆盖 C++ 符号身份：linkage name 唯一匹配、作用域链限定名、
// 歧义诊断、mangled 名无 DWARF 类型时不猜标量。程序化构造 ELF32 + .debug_info/.debug_abbrev。
const assert = require("assert");
const { parseDwarf } = require("../src/dwarf");
const { buildVariableTypes, buildDisplayNames } = require("../src/dwarf/types");
const { ElfService } = require("../src/services/elfService");

function str(s) {
    const b = [];
    for (const ch of Buffer.from(s, "latin1")) b.push(ch);
    b.push(0);
    return b;
}
function u32(v) {
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}
function loc(addr) {
    // DW_FORM_exprloc：长度 5，DW_OP_addr(0x03) + 4 字节地址
    return [5, 0x03, ...u32(addr)];
}

// —— .debug_info ——（@N 为节内偏移，供 ref4 引用）
const di = [];
di.push(...u32(0)); // unit_length 占位
di.push(4, 0); // version = 4
di.push(...u32(0)); // debug_abbrev_offset = 0
di.push(4); // address_size = 4
di.push(1); // @11 compile_unit
di.push(2, ...str("int"), 0x05, 4); // @12 base_type int (signed,4B)
di.push(3, ...str("ns")); // @19 namespace ns（有子）
di.push(4, ...str("Foo"), 4); // @23 class_type Foo (byte_size 4，有子)
di.push(5, ...str("value"), ...u32(12), 0); // @29 member value -> int@12, offset 0
di.push(6, ...str("staticMemb"), ...u32(12), ...str("_ZN2ns3Foo10staticMembE"), ...loc(0x20000010)); // @41 类静态成员
di.push(0); // end Foo children
di.push(6, ...str("nsVar"), ...u32(12), ...str("_ZN2ns5nsVarE"), ...loc(0x20000020)); // 命名空间变量
di.push(7, ...str("func"), ...str("_ZN2ns4funcEv")); // 命名空间函数
di.push(0); // end namespace children
di.push(0); // end CU children
const unitLen = di.length - 4;
di[0] = unitLen & 0xff;
di[1] = (unitLen >>> 8) & 0xff;
di[2] = (unitLen >>> 16) & 0xff;
di[3] = (unitLen >>> 24) & 0xff;
const debugInfo = Buffer.from(di);

// —— .debug_abbrev ——（code, tag, has_children, [attr, form]..., 0, 0）
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

// —— 组装 ELF32 LE（仅 .debug_info/.debug_abbrev/.shstrtab）——
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

// —— 解析：linkage name 键与限定名 ——
const parsed = parseDwarf(buf);
assert.strictEqual(
    parsed.displayNames.get("_ZN2ns3Foo10staticMembE"),
    "ns::Foo::staticMemb",
    "类静态成员限定名应由作用域链构造"
);
assert.strictEqual(parsed.displayNames.get("_ZN2ns5nsVarE"), "ns::nsVar", "命名空间变量限定名");
assert.strictEqual(parsed.displayNames.get("_ZN2ns4funcEv"), "ns::func", "函数限定名来自 subprograms");
assert.strictEqual(parsed.types.get("_ZN2ns3Foo10staticMembE").typeName, "int", "类型按 linkage name 建键");

// buildVariableTypes：同名不同型 → 歧义标记，不绑定类型
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
assert.strictEqual(ambiguousTypes.get("_Z1x").ambiguous, true, "同一 linkage name 命中冲突类型应标歧义");

// buildDisplayNames 合并变量与函数
const display = buildDisplayNames({
    variables: [{ name: "v", linkageName: "_Z1v", qualifiedName: "ns::v" }],
    subprograms: [{ name: "f", linkageName: "_Z1fv", qualifiedName: "ns::f" }]
});
assert.strictEqual(display.get("_Z1v"), "ns::v");
assert.strictEqual(display.get("_Z1fv"), "ns::f");

// —— ElfService 绑定 ——
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

// A：真实解析结果绑定，displayName/类型命中；mangled 无类型不猜标量
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
    assert.strictEqual(unresolved.isComposite, true, "mangled 名无 DWARF 类型不得猜成标量");
    assert.strictEqual(unresolved.compositeLayout, null);
    assert.ok(unresolved.unsupportedReason, "应给出不可用原因");
    assert.ok(
        res.diagnostics.some((d) => d.code === "CPP_TYPE_UNRESOLVED"),
        "应产出 CPP_TYPE_UNRESOLVED 诊断"
    );
    assert.strictEqual(res.functions[0].displayName, "ns::func", "函数附带显示名");
}

// B：歧义 linkage name → CPP_SYMBOL_AMBIGUOUS，不绑定类型
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
        "应产出 CPP_SYMBOL_AMBIGUOUS 诊断"
    );
}

// C：DWARF 命中符号但类型未知，仍不得按大小猜成可观察标量。
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
        // CU1 和 CU2 各有相同名称和结构的 Widget DIE，但 typeRef 不同
        const dies = new Map([
            [1, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 }],
            // CU1 中的 Widget
            [100, { tag: c.DW_TAG_structure_type, name: "Widget", byteSize: 8 }],
            [101, { tag: c.DW_TAG_member, name: "w", typeRef: 1, memberOffset: 0 }],
            [102, { tag: c.DW_TAG_member, name: "h", typeRef: 1, memberOffset: 4 }],
            // CU2 中的 Widget
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
    const { buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
    function fixed(value, width = 4) {
        const bytes = Buffer.alloc(8);
        bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)));
        return Array.from(bytes.subarray(0, width));
    }
    function leb(value, signed = false) {
        let remaining = BigInt(value);
        const bytes = [];
        do {
            let byte = Number(remaining & 127n);
            remaining >>= 7n;
            const last = signed
                ? (remaining === 0n && !(byte & 64)) || (remaining === -1n && !!(byte & 64))
                : remaining === 0n;
            if (!last) byte |= 128;
            bytes.push(byte);
            if (last) break;
        } while (true);
        return bytes;
    }
    const node = (id, tag, attrs = [], children = []) => ({ id, tag, attrs, children });
    const attr = (at, form, value) => [at, form, value];
    const nameAttr = (name) => attr(c.DW_AT_name, 8, name);
    const typeAttr = (ref) => attr(c.DW_AT_type, 0x13, ref);
    const base = (id, name = "int", size = 4, encoding = c.DW_ATE_signed) =>
        node(id, c.DW_TAG_base_type, [
            nameAttr(name),
            attr(c.DW_AT_byte_size, 0x0b, size),
            attr(c.DW_AT_encoding, 0x0b, encoding)
        ]);
    const composite = (id, name, size, children = [], tag = c.DW_TAG_class_type) =>
        node(id, tag, [...(name ? [nameAttr(name)] : []), attr(c.DW_AT_byte_size, 6, size)], children);
    const member = (id, name, type, offset) =>
        node(id, c.DW_TAG_member, [nameAttr(name), typeAttr(type), attr(c.DW_AT_data_member_location, 6, offset)]);
    const variable = (name, type, address = 0x20000000, expression) =>
        node("var-" + name, c.DW_TAG_variable, [
            nameAttr(name),
            typeAttr(type),
            attr(c.DW_AT_location, 0x18, expression || [3, ...fixed(address)])
        ]);
    function fixture(units, { version = 4, symbols = [], sections = [] } = {}) {
        const info = [],
            abbrev = [],
            definitions = new Map(),
            offsets = new Map(),
            references = [];
        const value = (form, input, cuStart) => {
            if ([0x13, 0x10].includes(form)) {
                references.push({ offset: info.length, label: input, cuStart: form === 0x13 ? cuStart : 0 });
                info.push(0, 0, 0, 0);
            } else if ([0x0b, 5, 6, 7].includes(form)) info.push(...fixed(input, { 0x0b: 1, 5: 2, 6: 4, 7: 8 }[form]));
            else if (form === 8) info.push(...Buffer.from(input + "\0"));
            else if (form === 0x18) info.push(...leb(input.length), ...input);
            else if ([0x0f, 0x0d].includes(form)) info.push(...leb(input, form === 0x0d));
            else if (form === 0x16) {
                info.push(...leb(input.form));
                value(input.form, input.value, cuStart);
            } else if (![0x19, 0x21].includes(form)) throw new Error("Unsupported fixture form " + form);
        };
        const emit = (die, cuStart) => {
            offsets.set(die.id, info.length);
            const key = JSON.stringify([
                die.tag,
                !!die.children.length,
                die.attrs.map(([at, form, v]) => [at, form, form === 0x21 ? v : null])
            ]);
            if (!definitions.has(key)) {
                const code = definitions.size + 1;
                definitions.set(key, code);
                abbrev.push(...leb(code), ...leb(die.tag), Number(!!die.children.length));
                for (const [at, form, v] of die.attrs) {
                    abbrev.push(...leb(at), ...leb(form));
                    if (form === 0x21) abbrev.push(...leb(v, true));
                }
                abbrev.push(0, 0);
            }
            info.push(...leb(definitions.get(key)));
            for (const [, form, v] of die.attrs) value(form, v, cuStart);
            for (const child of die.children) emit(child, cuStart);
            if (die.children.length) info.push(0);
        };
        for (let index = 0; index < units.length; index++) {
            const cuStart = info.length;
            info.push(0, 0, 0, 0, version, 0);
            if (version === 5) info.push(1, 4, 0, 0, 0, 0);
            else info.push(0, 0, 0, 0, 4);
            const unit = Array.isArray(units[index]) ? node("cu-" + index, 0x11, [], units[index]) : units[index];
            emit(unit, cuStart);
            fixed(info.length - cuStart - 4).forEach((byte, offset) => {
                info[cuStart + offset] = byte;
            });
        }
        for (const ref of references) {
            assert(offsets.has(ref.label), "Unknown reference " + ref.label);
            fixed(offsets.get(ref.label) - ref.cuStart).forEach((byte, offset) => {
                info[ref.offset + offset] = byte;
            });
        }
        abbrev.push(0);
        return {
            buffer: buildElf32({
                sections: [
                    ...buildDebugSections({ info: Buffer.from(info), abbrev: Buffer.from(abbrev) }),
                    ...sections
                ],
                symbols
            }),
            offsets
        };
    }
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
