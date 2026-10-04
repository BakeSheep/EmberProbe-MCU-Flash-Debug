"use strict";

const assert = require("assert");
const c = require("../src/dwarf/constants");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { buildDwarfElf } = require("./helpers/elf-fixture");
const {
    buildVariableTypes,
    buildCompositeLayouts,
    createCompositeLayoutResolver,
    encodingToWatchType
} = require("../src/dwarf/types");
const { parseMemberPath, expandCompositeLeaves, decodeComposite, navigateCompositeTree } = require("../src/elfSymbols");
const { validateComposite } = require("../src/compositeValidation");

// ======================================================================
// [P1] Issue 1: 静态成员排除与写入地址
// ======================================================================
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

// ======================================================================
// [P1] Issue 2: 虚继承常量与复杂表达式解析
// ======================================================================
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

// ======================================================================
// [P2] Issue 3: 位域计算与 packed 位域支持
// ======================================================================
{
    // 测试常见 8+8+16 位域（总计 4 字节）
    const dies8816 = new Map([
        [1, { tag: c.DW_TAG_base_type, name: "unsigned int", encoding: c.DW_ATE_unsigned, byteSize: 4 }],
        [10, { tag: c.DW_TAG_structure_type, name: "Reg", byteSize: 4 }],
        [11, { tag: c.DW_TAG_member, name: "a", typeRef: 1, dataBitOffset: 0, bitSize: 8 }],
        [12, { tag: c.DW_TAG_member, name: "b", typeRef: 1, dataBitOffset: 8, bitSize: 8 }],
        [13, { tag: c.DW_TAG_member, name: "c", typeRef: 1, dataBitOffset: 16, bitSize: 16 }]
    ]);
    const parsed8816 = {
        dies: dies8816,
        childrenMap: new Map([[10, [11, 12, 13]]]),
        variables: [{ name: "reg", typeRef: 10 }]
    };
    const regLayout = buildCompositeLayouts(parsed8816).get("reg");
    assert.ok(regLayout, "reg layout must be created");
    // 验证 validateComposite 不会抛出 INVALID_COMPOSITE_LAYOUT
    assert.doesNotThrow(() => validateComposite(regLayout, 4, 0x20000000));

    // 解码验证
    const regBytes = [0x12, 0x34, 0x78, 0x56];
    const regTree = decodeComposite(regBytes, regLayout);
    assert.strictEqual(regTree.members[0].value, 0x12);
    assert.strictEqual(regTree.members[1].value, 0x34);
    assert.strictEqual(regTree.members[2].value, 0x5678);

    // 测试 1 字节 packed 位域 (3 + 5 位)
    const diesPacked = new Map([
        [1, { tag: c.DW_TAG_base_type, name: "unsigned int", encoding: c.DW_ATE_unsigned, byteSize: 4 }],
        [20, { tag: c.DW_TAG_structure_type, name: "Packed", byteSize: 1 }],
        [21, { tag: c.DW_TAG_member, name: "f1", typeRef: 1, dataBitOffset: 0, bitSize: 3 }],
        [22, { tag: c.DW_TAG_member, name: "f2", typeRef: 1, dataBitOffset: 3, bitSize: 5 }]
    ]);
    const parsedPacked = {
        dies: diesPacked,
        childrenMap: new Map([[20, [21, 22]]]),
        variables: [{ name: "pk", typeRef: 20 }]
    };
    const pkLayout = buildCompositeLayouts(parsedPacked).get("pk");
    assert.ok(pkLayout, "packed layout must be created");
    assert.doesNotThrow(() => validateComposite(pkLayout, 1, 0x20000000));

    // 0x2b = 00101 011 -> f1 = 3, f2 = 5
    const pkTree = decodeComposite([0x2b], pkLayout);
    assert.strictEqual(pkTree.members[0].value, 3);
    assert.strictEqual(pkTree.members[1].value, 5);
}

// ======================================================================
// [P2] Issue 4: 跨编译单元 inline 对象布局解析
// ======================================================================
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
    assert.strictEqual(layout.members[0].name, "w");
    assert.strictEqual(layout.members[1].name, "h");
}

// ======================================================================
// [P2] Issue 5: 模板限定名与匿名 union 路径
// ======================================================================
{
    // 模板成员路径
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

    // 匿名 union 展开与路径导航
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

    // 全量展开叶子：不应包含 '?'
    const allLeaves = expandCompositeLeaves(sym, anonLayout, null);
    assert.deepStrictEqual(
        allLeaves.map((l) => l.path),
        ["anon.id", "anon.a", "anon.b"],
        "anonymous union leaves must have natural paths without '?'"
    );

    // 自然路径导航: anon.a
    const leafA = expandCompositeLeaves(sym, anonLayout, parseMemberPath("anon.a"));
    assert.strictEqual(leafA.length, 1);
    assert.strictEqual(leafA[0].path, "anon.a");
    assert.strictEqual(leafA[0].address, 0x20000004);
    assert.strictEqual(leafA[0].type, "i32");

    // 显式匿名段导航兼容: anon.?.a
    const leafAnonA = expandCompositeLeaves(sym, anonLayout, parseMemberPath("anon.?.a"));
    assert.strictEqual(leafAnonA.length, 1);
    assert.strictEqual(leafAnonA[0].address, 0x20000004);

    // 树形导航
    const tree = decodeComposite([1, 0, 0, 0, 42, 0, 0, 0], anonLayout);
    const nodeA = navigateCompositeTree(tree, parseMemberPath("anon.a"));
    assert.ok(nodeA);
    assert.strictEqual(nodeA.value, 42);

    const nodeAnonA = navigateCompositeTree(tree, parseMemberPath("anon.?.a"));
    assert.ok(nodeAnonA);
    assert.strictEqual(nodeAnonA.value, 42);
}

// ======================================================================
// [P2] Issue 6: 引用、UTF 字符及 const 写入拦截
// ======================================================================
{
    // UTF 编码
    assert.strictEqual(encodingToWatchType(c.DW_ATE_UTF, 1), "u8");
    assert.strictEqual(encodingToWatchType(c.DW_ATE_UTF, 2), "u16");
    assert.strictEqual(encodingToWatchType(c.DW_ATE_UTF, 4), "u32");

    // 引用类型与成员指针
    const dies = new Map([
        [1, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 }],
        [2, { tag: c.DW_TAG_reference_type, typeRef: 1 }],
        [3, { tag: c.DW_TAG_rvalue_reference_type, typeRef: 1 }],
        [4, { tag: c.DW_TAG_ptr_to_member_type, typeRef: 1 }],
        [5, { tag: c.DW_TAG_base_type, name: "char16_t", encoding: c.DW_ATE_UTF, byteSize: 2 }],
        [6, { tag: c.DW_TAG_const_type, typeRef: 1 }],
        [10, { tag: c.DW_TAG_structure_type, name: "Data", byteSize: 6 }],
        [11, { tag: c.DW_TAG_member, name: "ch", typeRef: 5, memberOffset: 0 }],
        [12, { tag: c.DW_TAG_member, name: "ro", typeRef: 6, memberOffset: 2 }]
    ]);
    const parsed = {
        dies,
        childrenMap: new Map([[10, [11, 12]]]),
        variables: [
            { name: "lref", typeRef: 2 },
            { name: "rref", typeRef: 3 },
            { name: "pmem", typeRef: 4 },
            { name: "cval", typeRef: 6 },
            { name: "data", typeRef: 10 }
        ]
    };

    const types = buildVariableTypes(parsed);
    assert.strictEqual(types.get("lref").typeName, "int &");
    assert.strictEqual(types.get("lref").watchType, "u32");
    assert.strictEqual(types.get("lref").kind, "scalar");

    assert.strictEqual(types.get("rref").typeName, "int &&");
    assert.strictEqual(types.get("rref").watchType, "u32");

    assert.strictEqual(types.get("pmem").watchType, "u32");

    assert.strictEqual(types.get("cval").isConst, true);

    const dataLayout = buildCompositeLayouts(parsed).get("data");
    const dataLeaves = expandCompositeLeaves({ name: "data", address: 0x20000000, size: 6 }, dataLayout, null);
    assert.strictEqual(dataLeaves.length, 2, "char16_t member must not disappear during expansion");
    assert.strictEqual(dataLeaves[0].path, "data.ch");
    assert.strictEqual(dataLeaves[0].type, "u16");

    assert.strictEqual(dataLeaves[1].path, "data.ro");
    assert.strictEqual(dataLeaves[1].isConst, true, "const member must retain isConst flag");

    // 验证 _agentWritePlan 对 const 变量及 const 复合成员的写入拦截
    const { loadProvider } = require("./helpers/load-provider");
    const Provider = loadProvider();
    const provider = Object.create(Provider.prototype);
    provider.readElfSymbols = () => ({
        elf: { path: "dummy" },
        symbols: [
            {
                name: "constScalar",
                address: 0x20000000,
                size: 4,
                watchType: "u32",
                hasDwarfWriteType: true,
                isConst: true
            },
            {
                name: "data",
                address: 0x20000010,
                size: 6,
                isComposite: true,
                compositeLayout: dataLayout
            }
        ]
    });

    assert.throws(
        () => provider._agentWritePlan([{ name: "constScalar", value: 1 }], { refreshSymbols: false }),
        (err) => err.code === "WRITE_NOT_ALLOWED" && /const \/ read-only/.test(err.message),
        "const scalar must reject write plan"
    );

    assert.throws(
        () => provider._agentWritePlan([{ name: "data.ro", value: 1 }], { refreshSymbols: false }),
        (err) => err.code === "WRITE_NOT_ALLOWED" && /const \/ read-only/.test(err.message),
        "const composite member must reject write plan"
    );
}

console.log("All DWARF and symbol issue fixes passed successfully!");
