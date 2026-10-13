"use strict";

const { scenario } = require("./helpers/scenario");

// 合成 DWARF 覆盖 C++ 类/继承布局：普通类、单继承、多继承同名歧义、虚基类不可观测、
// 嵌套对象与数组、@baseN 路径导航、非法布局与预算拒绝。
const assert = require("assert");
const c = require("../src/dwarf/constants");
const { buildCompositeLayouts } = require("../src/dwarf/types");
const { validateComposite } = require("../src/compositeValidation");
const { parseMemberPath, expandCompositeLeaves, decodeComposite, navigateCompositeTree } = require("../src/elfSymbols");

// 构造 { dies, childrenMap, variables } fixture 的小工具。
function builder() {
    const dies = new Map();
    const childrenMap = new Map();
    const add = (off, rec) => dies.set(off, rec);
    const children = (off, kids) => childrenMap.set(off, kids);
    return { dies, childrenMap, add, children };
}
const intDie = () => ({ tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 });

function leavesOf(name, address, size, layout, pathStr) {
    const symbol = { name, address, size };
    const pathSpec = pathStr ? parseMemberPath(pathStr) : null;
    return expandCompositeLeaves(symbol, layout, pathSpec);
}

// —— 单继承：Derived : Base，@base0.value 与自身 extra 各自地址正确 ——
{
    const b = builder();
    b.add(1, intDie());
    b.add(10, { tag: c.DW_TAG_class_type, name: "Base", byteSize: 4 });
    b.add(11, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 0 });
    b.children(10, [11]);
    b.add(20, { tag: c.DW_TAG_class_type, name: "Derived", byteSize: 8 });
    b.add(21, { tag: c.DW_TAG_inheritance, typeRef: 10, memberOffset: 0 });
    b.add(22, { tag: c.DW_TAG_member, name: "extra", typeRef: 1, memberOffset: 4 });
    b.children(20, [21, 22]);
    const layouts = buildCompositeLayouts({
        dies: b.dies,
        childrenMap: b.childrenMap,
        variables: [{ name: "object", typeRef: 20 }]
    });
    const layout = layouts.get("object");
    assert.strictEqual(layout.kind, "class", "class 布局 kind 应为 class");
    assert.strictEqual(layout.members[0].name, "@base0", "基类合成成员应置于自身成员之前");
    assert.strictEqual(layout.members[0].isBase, true);
    validateComposite(layout, 8);
    const leaves = leavesOf("object", 0x20000000, 8, layout);
    const paths = leaves.map((l) => l.path).sort();
    assert.deepStrictEqual(paths, ["object.@base0.value", "object.extra"]);
    const baseLeaf = leaves.find((l) => l.path === "object.@base0.value");
    assert.strictEqual(baseLeaf.address >>> 0, 0x20000000);
    assert.strictEqual(leaves.find((l) => l.path === "object.extra").address >>> 0, 0x20000004);

    // 显式 @base0 路径导航命中同一地址。
    const nav = leavesOf("object", 0x20000000, 8, layout, "object.@base0.value");
    assert.strictEqual(nav.length, 1);
    assert.strictEqual(nav[0].address >>> 0, 0x20000000);

    // 解码与树导航复用 @baseN 段。
    const bytes = Buffer.alloc(8);
    bytes.writeInt32LE(11, 0);
    bytes.writeInt32LE(22, 4);
    const tree = decodeComposite(bytes, layout);
    const node = navigateCompositeTree(tree, parseMemberPath("object.@base0.value"));
    assert.strictEqual(node.value, 11);
}

// —— 多继承：跨基类同名成员 value 经 @base0/@base1 消除歧义 ——
{
    const b = builder();
    b.add(1, intDie());
    b.add(10, { tag: c.DW_TAG_class_type, name: "B1", byteSize: 4 });
    b.add(11, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 0 });
    b.children(10, [11]);
    b.add(20, { tag: c.DW_TAG_class_type, name: "B2", byteSize: 4 });
    b.add(21, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 0 });
    b.children(20, [21]);
    b.add(30, { tag: c.DW_TAG_class_type, name: "Multi", byteSize: 8 });
    b.add(31, { tag: c.DW_TAG_inheritance, typeRef: 10, memberOffset: 0 });
    b.add(32, { tag: c.DW_TAG_inheritance, typeRef: 20, memberOffset: 4 });
    b.children(30, [31, 32]);
    const layout = buildCompositeLayouts({
        dies: b.dies,
        childrenMap: b.childrenMap,
        variables: [{ name: "m", typeRef: 30 }]
    }).get("m");
    validateComposite(layout, 8);
    const b0 = leavesOf("m", 0x20001000, 8, layout, "m.@base0.value");
    const b1 = leavesOf("m", 0x20001000, 8, layout, "m.@base1.value");
    assert.strictEqual(b0[0].address >>> 0, 0x20001000, "@base0.value 落在第一条基类路径");
    assert.strictEqual(b1[0].address >>> 0, 0x20001004, "@base1.value 落在第二条基类路径");
}

// —— 嵌套对象与数组成员 ——
{
    const b = builder();
    b.add(1, intDie());
    b.add(10, { tag: c.DW_TAG_structure_type, name: "Inner", byteSize: 4 });
    b.add(11, { tag: c.DW_TAG_member, name: "v", typeRef: 1, memberOffset: 0 });
    b.children(10, [11]);
    b.add(40, { tag: c.DW_TAG_array_type, typeRef: 1 });
    b.add(41, { tag: c.DW_TAG_subrange_type, subrangeUpperBound: 2 });
    b.children(40, [41]);
    b.add(20, { tag: c.DW_TAG_class_type, name: "Holder", byteSize: 16 });
    b.add(21, { tag: c.DW_TAG_member, name: "inner", typeRef: 10, memberOffset: 0 });
    b.add(22, { tag: c.DW_TAG_member, name: "arr", typeRef: 40, memberOffset: 4 });
    b.children(20, [21, 22]);
    const layout = buildCompositeLayouts({
        dies: b.dies,
        childrenMap: b.childrenMap,
        variables: [{ name: "h", typeRef: 20 }]
    }).get("h");
    validateComposite(layout, 16);
    const leaves = leavesOf("h", 0x20002000, 16, layout);
    const paths = leaves.map((l) => l.path).sort();
    assert.deepStrictEqual(paths, ["h.arr[0]", "h.arr[1]", "h.arr[2]", "h.inner.v"]);
    assert.strictEqual(leaves.find((l) => l.path === "h.arr[2]").address >>> 0, 0x20002000 + 4 + 8);
}

// —— 虚基类：静态阶段无叶子产出、显式路径返回 []、成员标 unobservable ——
{
    const b = builder();
    b.add(1, intDie());
    b.add(40, { tag: c.DW_TAG_class_type, name: "VBase", byteSize: 4 });
    b.add(41, { tag: c.DW_TAG_member, name: "vval", typeRef: 1, memberOffset: 0 });
    b.children(40, [41]);
    b.add(50, { tag: c.DW_TAG_class_type, name: "VDerived", byteSize: 8 });
    b.add(51, { tag: c.DW_TAG_inheritance, typeRef: 40, memberOffset: 0, virtuality: 1 });
    b.add(52, { tag: c.DW_TAG_member, name: "own", typeRef: 1, memberOffset: 4 });
    b.children(50, [51, 52]);
    const layout = buildCompositeLayouts({
        dies: b.dies,
        childrenMap: b.childrenMap,
        variables: [{ name: "v", typeRef: 50 }]
    }).get("v");
    const base = layout.members[0];
    assert.strictEqual(base.name, "@base0");
    assert.strictEqual(base.virtual, true, "虚基类合成成员应标 virtual");
    assert.ok(base.unobservable, "虚基类应标 unobservable");
    assert.strictEqual(base.byteSize, 0);
    assert.strictEqual(base.compositeLayout, undefined, "虚基类静态阶段不生成嵌套布局");
    validateComposite(layout, 8, 0x20003000);
    const leaves = leavesOf("v", 0x20003000, 8, layout);
    assert.deepStrictEqual(
        leaves.map((l) => l.path),
        ["v.own"],
        "虚基类分支不产叶子"
    );
    assert.deepStrictEqual(leavesOf("v", 0x20003000, 8, layout, "v.@base0.vval"), [], "指向虚基类子路径返回空");
    assert.deepStrictEqual(leavesOf("v", 0x20003000, 8, layout, "v.@base0"), [], "指向虚基类成员本身返回空");
}

// —— 非法布局：越界 offset 被 validateComposite 拒绝 ——
{
    const bad = {
        kind: "class",
        typeName: "class Bad",
        byteSize: 4,
        members: [{ name: "x", offset: 8, byteSize: 4, watchType: "i32", kind: "scalar" }]
    };
    assert.throws(() => validateComposite(bad, 4), { code: "INVALID_COMPOSITE_LAYOUT" });
}

// —— 前向声明或缺少大小的类型不生成可导入布局；完整空类仍可识别 ——
{
    const b = builder();
    b.add(10, { tag: c.DW_TAG_class_type, name: "Declared", isDecl: true });
    b.add(20, { tag: c.DW_TAG_class_type, name: "NoSize" });
    b.add(30, { tag: c.DW_TAG_class_type, name: "Empty", byteSize: 1 });
    const layouts = buildCompositeLayouts({
        dies: b.dies,
        childrenMap: b.childrenMap,
        variables: [
            { name: "declared", typeRef: 10 },
            { name: "noSize", typeRef: 20 },
            { name: "empty", typeRef: 30 }
        ]
    });
    assert.strictEqual(layouts.has("declared"), false);
    assert.strictEqual(layouts.has("noSize"), false);
    assert.deepStrictEqual(layouts.get("empty").members, []);
}

// —— 超预算：巨量成员触发 DWARF_BUDGET_EXCEEDED ——
{
    const b = builder();
    b.add(1, intDie());
    b.add(20, { tag: c.DW_TAG_class_type, name: "Huge", byteSize: 8192 });
    const kids = [];
    for (let i = 0; i < 16384; i++) {
        const off = 100 + i;
        b.add(off, { tag: c.DW_TAG_member, name: "m" + i, typeRef: 1, memberOffset: i * 4 });
        kids.push(off);
    }
    b.children(20, kids);
    assert.throws(
        () =>
            buildCompositeLayouts({
                dies: b.dies,
                childrenMap: b.childrenMap,
                variables: [{ name: "huge", typeRef: 20 }]
            }),
        { code: "DWARF_BUDGET_EXCEEDED" }
    );
}

// 同一 ELF 名绑定不同布局时不能任选一个布局供观察或写入。
{
    const b = builder();
    b.add(10, { tag: c.DW_TAG_class_type, name: "First", byteSize: 4 });
    b.add(20, { tag: c.DW_TAG_class_type, name: "Second", byteSize: 8 });
    const layouts = buildCompositeLayouts({
        dies: b.dies,
        childrenMap: b.childrenMap,
        variables: [
            { name: "item", linkageName: "_Z4item", typeRef: 10 },
            { name: "item", linkageName: "_Z4item", typeRef: 20 }
        ]
    });
    assert.strictEqual(layouts.has("_Z4item"), false);
}

scenario("Exclude static members from instance layout and addresses", () => {
    const { parseMemberPath, expandCompositeLeaves } = require("../src/elfSymbols");
    {
        const dies = new Map([
            [1, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 }],
            [10, { tag: c.DW_TAG_structure_type, name: "Plain", byteSize: 4 }],
            // 静态成员声明：无 memberOffset 且 isDecl 为 true
            [11, { tag: c.DW_TAG_member, name: "shared", typeRef: 1, isDecl: true }],
            // 实例成员
            [12, { tag: c.DW_TAG_member, name: "x", typeRef: 1, memberOffset: 0 }],
            // 全局静态成员变量定义
            [20, { tag: c.DW_TAG_variable, name: "shared", typeRef: 1, hasAddr: true, specificationRef: 11 }]
        ]);
        const childrenMap = new Map([[10, [11, 12]]]);
        const parsed = {
            dies,
            childrenMap,
            variables: [
                { name: "plain", typeRef: 10 },
                { name: "Plain::shared", typeRef: 1 }
            ]
        };

        const layouts = buildCompositeLayouts(parsed);
        const plainLayout = layouts.get("plain");
        assert.ok(plainLayout, "plain layout must be generated");
        assert.strictEqual(plainLayout.members.length, 1, "static member 'shared' must not be in instance layout");
        assert.strictEqual(plainLayout.members[0].name, "x");
        assert.strictEqual(plainLayout.members[0].offset, 0);

        const leaves = expandCompositeLeaves({ name: "plain", address: 0x20000004, size: 4 }, plainLayout, null);
        assert.strictEqual(leaves.length, 1);
        assert.strictEqual(leaves[0].path, "plain.x");
        assert.strictEqual(leaves[0].address, 0x20000004);

        // 访问 plain.shared 应该返回空（非实例成员）
        const sharedLeaf = expandCompositeLeaves(
            { name: "plain", address: 0x20000004, size: 4 },
            plainLayout,
            parseMemberPath("plain.shared")
        );
        assert.deepStrictEqual(sharedLeaf, [], "plain.shared must not resolve to plain.x");
    }
});

scenario("Parse virtual inheritance without inventing constant offsets", () => {
    const { parseDwarfInternal } = require("../src/dwarf/parser");
    const { buildDwarfElf } = require("./helpers/elf-fixture");
    {
        assert.strictEqual(c.DW_AT_virtuality, 0x4c, "DW_AT_virtuality must be 0x4c per DWARF standard");

        // 构造包含 DW_AT_virtuality=1 以及复杂 DW_AT_data_member_location 表达式的 DWARF
        function u32(v) {
            return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
        }
        const di = [];
        di.push(...u32(0)); // unit_length 占位
        di.push(4, 0); // version = 4
        di.push(...u32(0)); // abbrev_offset = 0
        di.push(4); // address_size = 4
        di.push(1); // CU abbrev 1
        di.push(2, 4); // base class: byte_size=4
        // inheritance: typeRef=@12, virtuality=1, data_member_location = exprloc [0x12, 0x06] (DW_OP_dup, DW_OP_deref)
        di.push(3, ...u32(12), 1, 2, 0x12, 0x06);
        di.push(4, 8); // derived class: byte_size=8, childrenMap=[14]
        di.push(0); // end CU
        const unitLen = di.length - 4;
        di[0] = unitLen & 0xff;
        di[1] = (unitLen >>> 8) & 0xff;
        di[2] = (unitLen >>> 16) & 0xff;
        di[3] = (unitLen >>> 24) & 0xff;

        const abbrev = Buffer.from([
            1,
            0x11,
            1,
            0,
            0, // compile_unit
            2,
            0x02,
            0,
            0x0b,
            0x0b,
            0,
            0, // class_type: byte_size(data1)
            3,
            0x1c,
            0,
            0x49,
            0x13,
            0x4c,
            0x0b,
            0x38,
            0x18,
            0,
            0, // inheritance: typeRef(ref4), virtuality(data1), data_member_location(exprloc)
            4,
            0x02,
            1,
            0x0b,
            0x0b,
            0,
            0, // class_type: byte_size(data1) with children
            0
        ]);

        const debugInfo = Buffer.from(di);
        const elf = buildDwarfElf(debugInfo, abbrev, { layout: { tableAlignment: 1 } });

        const parsedElf = parseDwarfInternal(elf);
        const inheritanceDie = parsedElf.dies.get(14);
        assert.ok(inheritanceDie, "inheritance DIE must be parsed");
        assert.strictEqual(inheritanceDie.virtuality, 1, "virtuality attribute 0x4c must be parsed as 1");
        assert.strictEqual(
            inheritanceDie.memberOffset,
            undefined,
            "complex exprloc must not be erroneously parsed as ULEB 18"
        );
    }
});

scenario("Resolve safe scoped declarations to class definitions", () => {
    const { parseDwarf } = require("../src/dwarf");
    const { parseDwarfInternal } = require("../src/dwarf/parser");
    const { buildCompositeLayouts, buildVariableTypes } = require("../src/dwarf/types");
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
    const declaration = (id, name, tag = c.DW_TAG_class_type) =>
        node(id, tag, [nameAttr(name), attr(c.DW_AT_declaration, 0x19, true)]);
    const member = (id, name, type, offset) =>
        node(id, c.DW_TAG_member, [nameAttr(name), typeAttr(type), attr(c.DW_AT_data_member_location, 6, offset)]);
    const pointer = (id, type) => node(id, c.DW_TAG_pointer_type, [typeAttr(type)]);
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
    function declarationTests() {
        for (const version of [4, 5]) {
            const inner = composite(
                "inner-def",
                "",
                8,
                [member("x", "x", "int-a", 0), member("y", "y", "short", 4)],
                c.DW_TAG_structure_type
            );
            inner.attrs.push(attr(c.DW_AT_specification, 0x13, "inner-decl"));
            const f = fixture(
                [
                    [
                        base("int-a"),
                        base("short", "short int", 2),
                        declaration("axis-decl", "Axis"),
                        node(
                            "axis-array",
                            c.DW_TAG_array_type,
                            [typeAttr("axis-decl")],
                            [node("axis-range", c.DW_TAG_subrange_type, [attr(c.DW_AT_count, 0x0b, 1)])]
                        ),
                        node("alias", c.DW_TAG_typedef, [nameAttr("AxisAlias"), typeAttr("axis-decl")]),
                        pointer("inner-ptr", "inner-decl"),
                        composite(
                            "outer",
                            "Outer",
                            8,
                            [
                                declaration("inner-decl", "Inner", c.DW_TAG_structure_type),
                                member("p", "p", "inner-ptr", 0),
                                member("k", "k", "int-a", 4)
                            ],
                            c.DW_TAG_structure_type
                        ),
                        inner,
                        variable("axes", "axis-array"),
                        variable("alias_g", "alias", 0x20000020),
                        variable("inner_g", "inner-def", 0x20000030),
                        variable("outer_g", "outer", 0x20000040)
                    ],
                    [
                        base("int-b"),
                        base("float", "float", 4, c.DW_ATE_float),
                        composite("axis-def", "Axis", 12, [member("a", "a", "int-b", 4), member("b", "b", "float", 8)])
                    ]
                ],
                { version }
            );
            const parsed = parseDwarfInternal(f.buffer);
            assert.strictEqual(parsed.dies.get(f.offsets.get("axis-array")).typeRef, f.offsets.get("axis-def"));
            assert.strictEqual(parsed.dies.get(f.offsets.get("alias")).typeRef, f.offsets.get("axis-def"));
            assert.strictEqual(
                parsed.dies.get(f.offsets.get("axis-decl")).tag,
                c.DW_TAG_class_type,
                "retain declaration tag"
            );
            const result = parseDwarf(f.buffer, { runtime: true });
            assert.deepStrictEqual(result.diagnostics, []);
            const axis = result.layouts.get("axes").elementType;
            assert.strictEqual(axis.byteSize, 12);
            assert.deepStrictEqual(
                axis.compositeLayout.members.map((entry) => entry.name),
                ["a", "b"]
            );
            assert.strictEqual(result.types.get("inner_g").typeName, "struct Outer::Inner");
            assert.strictEqual(result.layouts.get("inner_g").typeName, "struct Outer::Inner");
            const runtime = result.layouts.get("outer_g").runtimeLayout;
            assert(
                runtime.types.some(
                    (entry) => entry.kind === "class" && entry.typeName === "Outer::Inner" && entry.byteSize === 8
                )
            );
        }
        const candidateFixture = ({
            sizes = [4],
            fieldKinds = [],
            tags = [],
            local = null,
            definitionLocal = null,
            sameCU = false,
            count = sizes.length,
            memberCount = 1
        } = {}) => {
            const decl = declaration("decl", "Thing");
            const wrap = (die, kind, id) =>
                !kind
                    ? die
                    : node(
                          id,
                          kind === "anonymous" ? c.DW_TAG_namespace : kind === "function" ? c.DW_TAG_subprogram : 0x0b,
                          [],
                          [die]
                      );
            const scoped = [decl];
            if (sameCU) scoped.push(composite("same", "Thing", 4, [member("same-x", "x", "first-int", 0)]));
            const first = [
                base("first-int"),
                ...(local ? [wrap(scoped[0], local, "private-decl")] : scoped),
                variable("thing", "decl")
            ];
            if (local && sameCU) first[1].children.push(scoped[1]);
            const units = [first];
            for (let index = 0; index < count; index++)
                units.push([
                    base(
                        "int-" + index,
                        fieldKinds[index] || "int",
                        4,
                        fieldKinds[index] === "float" ? c.DW_ATE_float : c.DW_ATE_signed
                    ),
                    wrap(
                        composite(
                            "def-" + index,
                            "Thing",
                            sizes[index % sizes.length],
                            Array.from({ length: memberCount }, (_, field) =>
                                member(
                                    "field-" + index + "-" + field,
                                    field ? "x" + field : "x",
                                    "int-" + index,
                                    field * 4
                                )
                            ),
                            tags[index] || c.DW_TAG_class_type
                        ),
                        definitionLocal,
                        "private-def-" + index
                    )
                ]);
            return fixture(units);
        };
        for (const options of [
            {},
            { sizes: [4, 4] },
            { sizes: [4, 4], tags: [c.DW_TAG_structure_type, c.DW_TAG_class_type] },
            { sizes: [8], sameCU: true },
            { sizes: [4], sameCU: true, local: "anonymous" }
        ]) {
            const f = candidateFixture(options);
            const layout = parseDwarf(f.buffer).layouts.get("thing");
            assert(layout, JSON.stringify(options));
            assert.strictEqual(layout.byteSize, 4);
            assert.strictEqual(layout.members[0].name, "x");
        }
        for (const options of [
            { sizes: [4, 8] },
            { sizes: [4, 4], fieldKinds: ["int", "float"] },
            { local: "anonymous" },
            { local: "function" },
            { local: "block" },
            { definitionLocal: "anonymous" },
            { sizes: [4], tags: [c.DW_TAG_union_type] },
            { sizes: [4], count: 65 },
            { sizes: [36000, 36000], memberCount: 9000 }
        ]) {
            const f = candidateFixture(options);
            const parsed = parseDwarfInternal(f.buffer);
            assert.strictEqual(
                parsed.variables[0].typeRef,
                f.offsets.get("decl"),
                "unsafe or over-budget association " + JSON.stringify(options)
            );
            assert.strictEqual(parsed.dies.get(f.offsets.get("decl")).isDecl, true);
        }
        // Same-CU lookup must retain the actual anonymous/function scope identity.
        const distinctScope = fixture([
            [
                base("int"),
                node("anon", c.DW_TAG_namespace, [], [declaration("decl", "Thing")]),
                composite("public", "Thing", 4, [member("x", "x", "int", 0)]),
                variable("private", "decl")
            ]
        ]);
        assert.strictEqual(parseDwarf(distinctScope.buffer).layouts.has("private"), false);
        const enumeration = fixture([
            [declaration("enum-decl", "Mode", c.DW_TAG_enumeration_type), variable("mode", "enum-decl")],
            [
                node(
                    "enum-def",
                    c.DW_TAG_enumeration_type,
                    [nameAttr("Mode"), attr(c.DW_AT_byte_size, 0x0b, 4), attr(c.DW_AT_encoding, 0x0b, c.DW_ATE_signed)],
                    [node("enum-value", c.DW_TAG_enumerator, [nameAttr("negative"), attr(0x1c, 0x0d, -1)])]
                )
            ]
        ]);
        assert.strictEqual(parseDwarf(enumeration.buffer).types.get("mode").enumInfo.entries[0].value, "-1");

        // Direct DIE consumers also prefer the sole definition before comparing size.
        for (const reversed of [false, true]) {
            const dies = new Map([
                [1, { tag: c.DW_TAG_class_type, name: "Thing", isDecl: true }],
                [2, { tag: c.DW_TAG_class_type, name: "Thing", byteSize: 4 }]
            ]);
            const variables = [
                { name: "thing", typeRef: 1 },
                { name: "thing", typeRef: 2 }
            ];
            if (reversed) variables.reverse();
            const parsed = { dies, childrenMap: new Map(), variables };
            assert.strictEqual(buildCompositeLayouts(parsed).get("thing").byteSize, 4);
            assert.strictEqual(buildVariableTypes(parsed).get("thing").ambiguous, undefined);
        }
    }
    declarationTests();
});

scenario("Accept only complete constant member location expressions", () => {
    const { parseDwarfInternal } = require("../src/dwarf/parser");
    const { buildDwarfElf } = require("./helpers/elf-fixture");
    function memberExpressionElf(expression) {
        const info = Buffer.concat([
            Buffer.from([0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 4, 1, 2, expression.length]),
            Buffer.from(expression),
            Buffer.from([0])
        ]);
        info.writeUInt32LE(info.length - 4);
        const abbrev = Buffer.from([1, 0x11, 1, 0, 0, 2, 0x0d, 0, 0x38, 0x18, 0, 0, 0]);
        return buildDwarfElf(info, abbrev, {
            machine: 0,
            layout: { type: 0, version: 0, tableAlignment: 1 }
        });
    }
    for (const { name, expression, offset } of [
        { name: "zero constant offset", expression: [0x23, 0], offset: 0 },
        { name: "multi-byte constant offset", expression: [0x23, 0x80, 1], offset: 128 }
    ]) {
        assert.strictEqual(parseDwarfInternal(memberExpressionElf(expression)).dies.get(12).memberOffset, offset, name);
    }
    for (const expression of [
        [0x23],
        [0x23, 0x80],
        [0x23, 0, 0x06],
        [0x12, 0x06],
        [0x23, ...Array(9).fill(0xff), 0x01]
    ]) {
        const member = parseDwarfInternal(memberExpressionElf(expression)).dies.get(12);
        assert.strictEqual(member.memberOffset, undefined);
        assert.strictEqual(member.memberLocationUnsupported, true);
    }
});

scenario("Read real ARM DWARF4/5 static, inline, virtual and pointer metadata", () => {
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
        assert.deepStrictEqual(parsed.diagnostics, []);
        assert.deepStrictEqual(
            parsed.layouts.get("plain").members.map((member) => member.name),
            ["x"]
        );
        assert.deepStrictEqual(
            parsed.layouts.get("inlinePacket").members.map((member) => member.name),
            ["value"]
        );
        assert.ok(parsed.layouts.get("virtualObject").members[0].unobservable);
        for (const name of ["reference", "rvalueReference", "memberPointer", "methodPointer"]) {
            assert.strictEqual(byName.get(name).hasDwarfWriteType, false);
        }
        assert.strictEqual(byName.get("methodPointer").watchType, "u64", "ARM member function pointers occupy 8 bytes");
    }
});

console.log("C++ class layout tests passed");
