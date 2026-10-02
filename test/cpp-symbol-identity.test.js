"use strict";
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

console.log("C++ symbol identity tests passed");
