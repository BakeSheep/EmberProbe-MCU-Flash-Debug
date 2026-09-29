"use strict";
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

console.log("C++ class layout tests passed");
