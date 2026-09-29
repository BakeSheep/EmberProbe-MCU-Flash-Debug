"use strict";
// 验证复合类型（结构体/数组）的路径解析、叶子展开、解码与树形导航。
// 全部为纯函数测试，无需构造 ELF/DWARF，直接以手写布局与字节缓冲驱动。
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
assert.strictEqual(parseMemberPath("buf[abc]"), null, "非数字下标应视为非法");
assert.strictEqual(parseMemberPath("buf[-1]"), null, "负数下标应视为非法");
assert.strictEqual(parseMemberPath("buf[1x]"), null, "带尾随字符的下标应视为非法");
assert.strictEqual(parseMemberPath("buf[3:1]"), null, "反向或空范围应视为非法");

// —— 结构体布局：struct Sensor { i32 x@0; f32 y@4; u16 flags@8; } ——
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
// 无路径：展开全部标量叶子
const allLeaves = expandCompositeLeaves(sym, sensorLayout, null);
assert.deepStrictEqual(
    allLeaves.map((l) => [l.path, l.address, l.size, l.type]),
    [
        ["sensor.x", 0x20000100, 4, "i32"],
        ["sensor.y", 0x20000104, 4, "f32"],
        ["sensor.flags", 0x20000108, 2, "u16"]
    ]
);
// 单成员路径 sensor.y → 单个叶子，地址 = 基址 + 4
const yLeaf = expandCompositeLeaves(sym, sensorLayout, parseMemberPath("sensor.y"));
assert.deepStrictEqual(yLeaf, [
    { name: "sensor", path: "sensor.y", address: 0x20000104, size: 4, type: "f32", typeName: "float" }
]);

// —— decodeComposite：结构体解码含绝对偏移 ——
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
assert.strictEqual(navigateCompositeTree(sensorTree, null), sensorTree, "无路径返回整棵树");
const nodeY = navigateCompositeTree(sensorTree, parseMemberPath("sensor.y"));
assert.ok(isScalarLeafNode(nodeY));
assert.strictEqual(nodeY.value, 110);
assert.strictEqual(nodeY.offset, 4);
assert.strictEqual(navigateCompositeTree(sensorTree, parseMemberPath("sensor.missing")), null, "不存在的成员返回 null");
assert.strictEqual(isScalarLeafNode(sensorTree), false, "结构体节点不是标量叶子");

// —— 数组布局：u32 buf[4] ——
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
// buf[2] → 标量叶子
const el2 = navigateCompositeTree(arrTree, parseMemberPath("buf[2]"));
assert.ok(isScalarLeafNode(el2));
assert.strictEqual(el2.value, 300);
assert.strictEqual(el2.offset, 8);
// buf[1:3] → 合成数组子树，仅含 index 1,2
const rng = navigateCompositeTree(arrTree, parseMemberPath("buf[1:3]"));
assert.strictEqual(rng.kind, "array");
assert.deepStrictEqual(
    rng.elements.map((e) => e.index),
    [1, 2]
);
assert.strictEqual(rng.offset, 4, "range 子树偏移取首元素偏移");
// buf[*] → 整棵数组
const allEl = navigateCompositeTree(arrTree, parseMemberPath("buf[*]"));
assert.strictEqual(allEl, arrTree);

// 数组叶子展开：buf[1:3]
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
    "等于数组长度的下标必须被拒绝"
);
assert.deepStrictEqual(
    expandCompositeLeaves(arrSym, arrayLayout, parseMemberPath("buf[1:5]")),
    [],
    "超出数组长度的范围必须被拒绝"
);

// —— 结构体数组：展开、解码及深层路径导航 ——
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
// 范围/全选后继续访问复合元素成员缺少可供导航的单一布局，历史行为是不输出。
// 这是 P1.4 删除空循环分支的行为锁，防止未来误生成错误地址。
assert.deepStrictEqual(
    expandCompositeLeaves(
        { name: "sensors", address: 0x20000400, size: 24 },
        sensorArrayLayout,
        parseMemberPath("sensors[0:2].y")
    ),
    []
);

// 字节不足时标量解码为 null（不抛异常）
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

// —— 技能脚本 variableSpecs：路径语法不被 ':' 误拆为类型 ——
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

console.log("Composite decode & navigation tests passed");
