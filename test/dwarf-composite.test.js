"use strict";

const { scenario } = require("./helpers/scenario");

// 验证 DWARF 复合类型布局解析：结构体成员名/偏移/类型、数组维度与元素类型。
// 程序化构造最小 ELF32 + DWARF v4 调试段（.debug_info/.debug_abbrev），无需外部工具链。
const assert = require("assert");
const { parseDwarf, parseCompositeLayout, parseDwarfVariableTypes, _debugSectionData } = require("../src/dwarf");
const { decodeComposite, expandCompositeLeaves, parseMemberPath } = require("../src/elfSymbols");
const { buildDwarfElf: dwarfElf } = require("./helpers/elf-fixture");

function str(s) {
    const b = [];
    for (const c of Buffer.from(s, "latin1")) b.push(c);
    b.push(0);
    return b;
}
function u32(v) {
    return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

// —— .debug_info（DWARF v4）——  注释中的 @N 为该 DIE 在节内的偏移，供 ref4 引用
const di = [];
di.push(...u32(0)); // unit_length 占位（末尾回填）
di.push(4, 0); // version = 4
di.push(...u32(0)); // debug_abbrev_offset = 0
di.push(4); // address_size = 4
di.push(1); // @11 compile_unit
di.push(2, ...str("int"), 0x05, 4); // @12 base_type int (signed, 4B)
di.push(2, ...str("float"), 0x04, 4); // @19 base_type float (float, 4B)
di.push(3, ...str("Sensor"), 8); // @28 structure_type Sensor (byte_size 8)
di.push(4, ...str("x"), ...u32(12), 0); // @37   member x -> int@12, offset 0
di.push(4, ...str("y"), ...u32(19), 4); // @45   member y -> float@19, offset 4
di.push(0); // @53   end Sensor children
di.push(8, ...str("SensorAlias"), ...u32(28)); // @54 typedef SensorAlias -> Sensor@28
di.push(9, ...u32(54)); // @71 volatile_type -> SensorAlias@54
di.push(6, ...u32(12), 16); // @76 array_type of int@12 (byte_size 16)
di.push(7, 3); // @82   subrange upper_bound = 3 -> 4 elements
di.push(0); // @84   end array children
di.push(6, ...u32(28), 16); // @85 array_type of Sensor@28 (byte_size 16)
di.push(7, 1); // @91   subrange upper_bound = 1 -> 2 elements
di.push(0); // @93   end array children
di.push(5, ...str("sensorAlias"), ...u32(71), 5, 0x03, ...u32(0x20000100)); // @94 volatile typedef variable
di.push(5, ...str("sensorArr"), ...u32(85), 5, 0x03, ...u32(0x20000200)); // @117 Sensor[2]
di.push(5, ...str("buf"), ...u32(76), 5, 0x03, ...u32(0x20000300)); // @138 int[4]
di.push(0); // @153 end CU children
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
    0, // base_type: name(str) encoding(data1) byte_size(data1)
    3,
    0x13,
    1,
    0x03,
    0x08,
    0x0b,
    0x0b,
    0,
    0, // structure_type: name(str) byte_size(data1)
    4,
    0x0d,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0x38,
    0x0b,
    0,
    0, // member: name(str) type(ref4) data_member_location(data1)
    5,
    0x34,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0x02,
    0x18,
    0,
    0, // variable: name(str) type(ref4) location(exprloc)
    6,
    0x01,
    1,
    0x49,
    0x13,
    0x0b,
    0x0b,
    0,
    0, // array_type: type(ref4) byte_size(data1)
    7,
    0x21,
    0,
    0x2f,
    0x0b,
    0,
    0, // subrange_type: upper_bound(0x2f, data1)
    8,
    0x16,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0,
    0, // typedef: name(str) type(ref4)
    9,
    0x35,
    0,
    0x49,
    0x13,
    0,
    0, // volatile_type: type(ref4)
    0
]);

const buf = dwarfElf(debugInfo, abbrev);

// ELFCOMPRESS_ZSTD（type=2）必须在扩展支持的 Node.js 20 上直接解压。
// payload 是 zstd CLI 对 ASCII "DWARF-zstd-test" 的单帧输出；测试不依赖系统 zstd。
const zstdPayload = Buffer.from("28b52ffd045879000044574152462d7a7374642d746573741a9e4eec", "hex");
const zstdSection = Buffer.alloc(12 + zstdPayload.length);
zstdSection.writeUInt32LE(2, 0);
zstdSection.writeUInt32LE(15, 4);
zstdSection.writeUInt32LE(1, 8);
zstdPayload.copy(zstdSection, 12);
assert.strictEqual(
    _debugSectionData(zstdSection, { offset: 0, size: zstdSection.length, flags: 0x800 }, ".debug_info").toString(),
    "DWARF-zstd-test"
);

const compressedBuf = dwarfElf(debugInfo, abbrev, { compress: true });

// —— 断言：结构体布局 ——
const layouts = parseCompositeLayout(buf);
const sensor = layouts.get("sensorAlias");
assert.ok(sensor, "应穿透 typedef 并解析出 sensorAlias 复合布局");
assert.strictEqual(sensor.kind, "struct");
assert.strictEqual(sensor.typeName, "SensorAlias");
assert.strictEqual(sensor.byteSize, 8);
assert.deepStrictEqual(
    sensor.members.map((m) => [m.name, m.offset, m.byteSize, m.watchType]),
    [
        ["x", 0, 4, "i32"],
        ["y", 4, 4, "f32"]
    ],
    "结构体成员名/偏移/宽度/类型应正确解析"
);

// —— 断言：数组布局（回归守护 DW_AT_upper_bound = 0x2f）——
const bufArr = layouts.get("buf");
assert.ok(bufArr, "应解析出 buf 数组布局");
assert.strictEqual(bufArr.kind, "array");
assert.deepStrictEqual(bufArr.dimensions, [4], "upper_bound=3 应得到 4 个元素（常量必须为 0x2f，否则维度丢失）");
assert.strictEqual(bufArr.totalElements, 4);
assert.strictEqual(bufArr.elementType.watchType, "i32");
assert.strictEqual(bufArr.elementType.byteSize, 4);
assert.strictEqual(bufArr.typeName, "int[]");

// —— 断言：结构体数组保留元素的完整嵌套布局 ——
const sensorArr = layouts.get("sensorArr");
assert.ok(sensorArr, "应解析出结构体数组");
assert.strictEqual(sensorArr.kind, "array");
assert.strictEqual(sensorArr.totalElements, 2);
assert.strictEqual(sensorArr.elementType.kind, "struct");
assert.ok(sensorArr.elementType.compositeLayout, "结构体数组元素应保留成员布局");
assert.deepStrictEqual(
    sensorArr.elementType.compositeLayout.members.map((m) => m.name),
    ["x", "y"]
);

// —— 断言：parseDwarfVariableTypes 一致识别复合类型 ——
const types = parseDwarfVariableTypes(buf);
assert.strictEqual(types.get("sensorAlias").typeName, "SensorAlias");
assert.strictEqual(types.get("sensorAlias").kind, "struct", "typedef/volatile 之后仍须保留结构体类别");
assert.strictEqual(types.get("sensorAlias").watchType, "", "结构体整体不可作为标量观察");
assert.strictEqual(types.get("buf").typeName, "int[]");
assert.strictEqual(types.get("buf").kind, "array");

// SHF_COMPRESSED 的真实 Debug ELF 仍应解压 DWARF，并穿透 volatile -> typedef -> struct。
const compressedLayouts = parseCompositeLayout(compressedBuf);
const compressedVolatile = compressedLayouts.get("sensorAlias");
assert.ok(compressedVolatile, "压缩 DWARF 中的 volatile 复合变量应保留布局");
assert.strictEqual(compressedVolatile.typeName, "SensorAlias");
assert.deepStrictEqual(
    compressedVolatile.members.map((m) => m.name),
    ["x", "y"]
);

// DW_FORM_string 必须按 UTF-8 字节长度推进游标，否则非 ASCII 名称会使后续 DIE 错位。
const unicodeInfo = [];
unicodeInfo.push(...u32(0), 4, 0, ...u32(0), 4, 1);
const unicodeBaseOffset = unicodeInfo.length;
unicodeInfo.push(2, ...Buffer.from("int\0", "utf8"), 0x05, 4);
unicodeInfo.push(5, ...Buffer.from("éx\0", "utf8"), ...u32(unicodeBaseOffset), 5, 0x03, ...u32(0x20001000), 0);
const unicodeLength = unicodeInfo.length - 4;
unicodeInfo.splice(0, 4, ...u32(unicodeLength));
const unicodeBuffer = Buffer.from(unicodeInfo);
assert.strictEqual(parseDwarfVariableTypes(dwarfElf(unicodeBuffer, abbrev)).get("éx").watchType, "i32");

// 后续 CU header 截断时，之前已解析的 CU 必须保留，不能整个 DWARF 清空。
const truncatedSecondCu = Buffer.concat([unicodeBuffer, Buffer.from([...u32(8), 4])]);
assert.strictEqual(
    parseDwarfVariableTypes(dwarfElf(truncatedSecondCu, abbrev)).get("éx").watchType,
    "i32",
    "a truncated later CU must not discard variables from earlier healthy CUs"
);

// DW_AT_data_bit_offset + DW_AT_bit_size 应保留为成员布局，并在解码时移位/掩码。
const bitInfo = [];
bitInfo.push(...u32(0), 4, 0, ...u32(0), 4, 1);
const bitBaseOffset = bitInfo.length;
bitInfo.push(2, ...Buffer.from("unsigned int\0"), 0x07, 4);
const bitStructOffset = bitInfo.length;
bitInfo.push(3, ...Buffer.from("Bits\0"), 4);
bitInfo.push(4, ...Buffer.from("a\0"), ...u32(bitBaseOffset), 0, 4);
bitInfo.push(4, ...Buffer.from("b\0"), ...u32(bitBaseOffset), 4, 4, 0);
bitInfo.push(5, ...Buffer.from("bits\0"), ...u32(bitStructOffset), 5, 0x03, ...u32(0x20002000), 0);
bitInfo.splice(0, 4, ...u32(bitInfo.length - 4));
const bitAbbrev = Buffer.from([
    1, 0x11, 1, 0, 0, 2, 0x24, 0, 0x03, 0x08, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0, 3, 0x13, 1, 0x03, 0x08, 0x0b, 0x0b, 0, 0, 4,
    0x0d, 0, 0x03, 0x08, 0x49, 0x13, 0x6b, 0x0b, 0x0d, 0x0b, 0, 0, 5, 0x34, 0, 0x03, 0x08, 0x49, 0x13, 0x02, 0x18, 0, 0,
    0
]);
const bitLayout = parseCompositeLayout(dwarfElf(Buffer.from(bitInfo), bitAbbrev)).get("bits");
assert.deepStrictEqual(
    bitLayout.members.map((member) => [member.name, member.offset, member.bitOffset, member.bitSize]),
    [
        ["a", 0, 0, 4],
        ["b", 0, 4, 4]
    ]
);
const bitTree = decodeComposite(Buffer.from([0xba, 0, 0, 0]), bitLayout);
assert.deepStrictEqual(
    bitTree.members.map((member) => member.value),
    [10, 11]
);

// —— 回归守护：CU 中出现 GNU 扩展 form（split-dwarf 场景的 GNU_addr_index 0x1f01）
// 时解析不能中止整个 CU，否则该 CU 后续所有变量都会丢失复合布局 ——
const di2 = [];
di2.push(...u32(0), 4, 0, ...u32(0), 4); // header（unit_length 回填）
di2.push(1, 0x2a); // @11 compile_unit + GNU_addr_index 值(ULEB)
di2.push(2, ...str("int"), 0x05, 4); // @13 base_type int
di2.push(3, ...str("S"), 4); // @20 structure_type S
di2.push(4, ...str("v"), ...u32(13), 0); // @24 member v -> int@13
di2.push(0); // @32 end struct children
di2.push(5, ...str("s"), ...u32(20), 5, 0x03, ...u32(0x20000000)); // @33 variable s -> S@20
di2.push(0); // @46 end CU
const len2 = di2.length - 4;
di2[0] = len2 & 0xff;
di2[1] = (len2 >>> 8) & 0xff;
di2[2] = (len2 >>> 16) & 0xff;
di2[3] = (len2 >>> 24) & 0xff;
const debugInfo2 = Buffer.from(di2);
const abbrev2 = Buffer.from([
    // compile_unit：GNU 扩展属性。at=0x2131 与 form=0x1f01 均超 255，
    // 必须按 ULEB 字节序列写入（0xb1 0x42 / 0x81 0x3e），直接写数值会被截断
    1,
    0x11,
    1,
    0xb1,
    0x42,
    0x81,
    0x3e,
    0,
    0, // compile_unit：GNU 属性 + GNU_addr_index form
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
    0, // base_type
    3,
    0x13,
    1,
    0x03,
    0x08,
    0x0b,
    0x0b,
    0,
    0, // structure_type
    4,
    0x0d,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0x38,
    0x0b,
    0,
    0, // member
    5,
    0x34,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0x02,
    0x18,
    0,
    0, // variable
    0
]);
const buf2 = dwarfElf(debugInfo2, abbrev2);

const gnuVar = parseCompositeLayout(buf2).get("s");
assert.ok(gnuVar, "GNU 扩展 form 出现在 CU 中时，后续变量的复合布局仍应被解析");
assert.strictEqual(gnuVar.kind, "struct");
assert.deepStrictEqual(
    gnuVar.members.map((m) => [m.name, m.offset, m.watchType]),
    [["v", 0, "i32"]]
);

// —— LTO 回归：具体变量 DIE 只有地址，名称和类型经跨 CU abstract_origin 继承 ——
const ltoInfo = [];
const patchU32 = (bytes, at, value) => {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >>> 8) & 0xff;
    bytes[at + 2] = (value >>> 16) & 0xff;
    bytes[at + 3] = (value >>> 24) & 0xff;
};
const beginCu = (bytes) => {
    const start = bytes.length;
    bytes.push(...u32(0), 4, 0, ...u32(0), 4, 1); // v4 header + compile_unit
    return start;
};
const endCu = (bytes, start) => {
    bytes.push(0);
    patchU32(bytes, start, bytes.length - start - 4);
};
const concreteVariable = (bytes, address) => {
    bytes.push(2);
    const originPatch = bytes.length;
    bytes.push(...u32(0), 5, 0x03, ...u32(address));
    return originPatch;
};

const concreteCu = beginCu(ltoInfo);
const fsmOriginPatch = concreteVariable(ltoInfo, 0x20000000);
const f32OriginPatch = concreteVariable(ltoInfo, 0x20000010);
const f64OriginPatch = concreteVariable(ltoInfo, 0x20000018);
endCu(ltoInfo, concreteCu);

const originCu = beginCu(ltoInfo);
const floatOff = ltoInfo.length;
ltoInfo.push(3, ...str("float"), 0x04, 4);
const doubleOff = ltoInfo.length;
ltoInfo.push(3, ...str("double"), 0x04, 8);
const structOff = ltoInfo.length;
ltoInfo.push(4, ...str("Fsm"), 4);
ltoInfo.push(5, ...str("state"), ...u32(floatOff - originCu), 0);
ltoInfo.push(0);
const typedefOff = ltoInfo.length;
ltoInfo.push(6, ...str("Fsm_t"), ...u32(structOff - originCu));
const volatileStructOff = ltoInfo.length;
ltoInfo.push(7, ...u32(typedefOff - originCu));
const volatileFloatOff = ltoInfo.length;
ltoInfo.push(7, ...u32(floatOff - originCu));
const volatileDoubleOff = ltoInfo.length;
ltoInfo.push(7, ...u32(doubleOff - originCu));
const fsmOriginOff = ltoInfo.length;
ltoInfo.push(8, ...str("g_fsm"), ...u32(volatileStructOff - originCu));
const f32OriginOff = ltoInfo.length;
ltoInfo.push(8, ...str("g_f32"), ...u32(volatileFloatOff - originCu));
const f64OriginOff = ltoInfo.length;
ltoInfo.push(8, ...str("g_f64"), ...u32(volatileDoubleOff - originCu));
endCu(ltoInfo, originCu);
patchU32(ltoInfo, fsmOriginPatch, fsmOriginOff);
patchU32(ltoInfo, f32OriginPatch, f32OriginOff);
patchU32(ltoInfo, f64OriginPatch, f64OriginOff);

const ltoAbbrev = Buffer.from([
    1,
    0x11,
    1,
    0,
    0, // compile_unit
    2,
    0x34,
    0,
    0x31,
    0x10,
    0x02,
    0x18,
    0,
    0, // concrete variable: abstract_origin(ref_addr), location
    3,
    0x24,
    0,
    0x03,
    0x08,
    0x3e,
    0x0b,
    0x0b,
    0x0b,
    0,
    0, // base_type
    4,
    0x13,
    1,
    0x03,
    0x08,
    0x0b,
    0x0b,
    0,
    0, // structure_type
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
    0, // member
    6,
    0x16,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0,
    0, // typedef
    7,
    0x35,
    0,
    0x49,
    0x13,
    0,
    0, // volatile_type
    8,
    0x34,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0,
    0, // origin variable: name, type
    0
]);
const ltoDebugInfo = Buffer.from(ltoInfo);
const ltoBuf = dwarfElf(ltoDebugInfo, ltoAbbrev);

const ltoTypes = parseDwarfVariableTypes(ltoBuf);
assert.strictEqual(ltoTypes.get("g_f32").watchType, "f32");
assert.strictEqual(ltoTypes.get("g_f64").watchType, "f64");
const ltoFsm = parseCompositeLayout(ltoBuf).get("g_fsm");
assert.ok(ltoFsm, "LTO concrete variables should inherit composite types from abstract_origin");
assert.strictEqual(ltoFsm.typeName, "Fsm_t");
assert.deepStrictEqual(
    ltoFsm.members.map((member) => [member.name, member.watchType]),
    [["state", "f32"]]
);

// —— 多维数组回归：GCC/Clang 的 array_type 不发 DW_AT_byte_size（尺寸由 subrange 推导），
// 嵌套数组元素的 byteSize 必须按维度推导，否则行 stride 恒为 0、所有行都解码到第 0 行 ——
const mdInfo = [];
const mdAt = () => mdInfo.length;
mdInfo.push(...u32(0), 4, 0, ...u32(0), 4, 1); // v4 header + compile_unit
const mdIntOff = mdAt();
mdInfo.push(2, ...str("int"), 0x05, 4); // base_type int
const mdInnerOff = mdAt();
mdInfo.push(3, ...u32(mdIntOff)); // 内层 array int[4]（无 byte_size）
mdInfo.push(4, 3, 0); //   subrange upper_bound=3 -> 4
const mdOuterOff = mdAt();
mdInfo.push(3, ...u32(mdInnerOff)); // 外层 array int[3][4]（无 byte_size）
mdInfo.push(4, 2, 0); //   subrange upper_bound=2 -> 3
mdInfo.push(5, ...str("m"), ...u32(mdOuterOff), 5, 0x03, ...u32(0x20000000)); // 变量 m
mdInfo.push(0);
const mdLen = mdInfo.length - 4;
mdInfo[0] = mdLen & 0xff;
mdInfo[1] = (mdLen >>> 8) & 0xff;
mdInfo[2] = (mdLen >>> 16) & 0xff;
mdInfo[3] = (mdLen >>> 24) & 0xff;
const mdDebugInfo = Buffer.from(mdInfo);
// array_type（code 3）只有 type 属性、无 byte_size —— 与真实工具链输出一致
const mdAbbrev = Buffer.from([
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
    0, // base_type
    3,
    0x01,
    1,
    0x49,
    0x13,
    0,
    0, // array_type: type(ref4) 无 byte_size
    4,
    0x21,
    0,
    0x2f,
    0x0b,
    0,
    0, // subrange_type: upper_bound(data1)
    5,
    0x34,
    0,
    0x03,
    0x08,
    0x49,
    0x13,
    0x02,
    0x18,
    0,
    0, // variable
    0
]);
const mdBuf = dwarfElf(mdDebugInfo, mdAbbrev);

const mdLayout = parseCompositeLayout(mdBuf).get("m");
assert.ok(mdLayout, "多维数组 m 的布局应被解析");
assert.strictEqual(mdLayout.kind, "array");
assert.deepStrictEqual(mdLayout.dimensions, [3], "外层数组只统计自身的 subrange 维度");
assert.strictEqual(mdLayout.totalElements, 3);
assert.strictEqual(mdLayout.elementType.kind, "array", "外层元素类型应为内层数组");
assert.strictEqual(mdLayout.elementType.byteSize, 16, "内层 int[4] 大小应推导为 16（行 stride）");
assert.strictEqual(mdLayout.elementType.compositeLayout.totalElements, 4, "内层布局应保留自身维度");
assert.strictEqual(mdLayout.byteSize, 48, "整体大小应为 3×16=48 而非 0");
assert.strictEqual(parseDwarfVariableTypes(mdBuf).get("m").typeName, "int[][]");

const mdBytes = Buffer.alloc(48);
for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) mdBytes.writeUInt32LE(row * 1000 + col, row * 16 + col * 4);
}
const mdTree = decodeComposite(mdBytes, mdLayout);
assert.deepStrictEqual(
    mdTree.elements.map((e) => e.offset),
    [0, 16, 32],
    "三行的解码偏移必须按行 stride 16 递进，而不是全部落在 0"
);
assert.deepStrictEqual(
    mdTree.elements[1].elements.map((e) => e.value),
    [1000, 1001, 1002, 1003],
    "m[1] 一行应读到第 1 行的值，而非重复第 0 行"
);
const mdLeaves = expandCompositeLeaves({ name: "m", address: 0x20000000, size: 48 }, mdLayout, null);
assert.strictEqual(mdLeaves.length, 12, "全量展开应得到 3×4 个叶子");
assert.deepStrictEqual(
    mdLeaves
        .filter((l) => l.path === "m[0][0]" || l.path === "m[1][0]" || l.path === "m[2][3]")
        .map((l) => [l.path, l.address]),
    [
        ["m[0][0]", 0x20000000],
        ["m[1][0]", 0x20000010],
        ["m[2][3]", 0x2000002c]
    ],
    "叶子地址必须按行 stride 展开"
);

// A damaged later CU must not discard the healthy first CU.
const partial = parseDwarf(dwarfElf(Buffer.concat([debugInfo, Buffer.from([1, 0, 0, 0, 255])]), abbrev));
assert.ok(partial.layouts.has("sensorAlias"));
assert.ok(partial.diagnostics.some((item) => item.code === "DWARF_CU_INVALID" && item.offset >= debugInfo.length));
assert.ok(parseDwarf(null).diagnostics.some((item) => item.code === "DWARF_PARSE_FAILED"));

scenario("Decode ordinary and packed bitfield layouts", () => {
    const c = require("../src/dwarf/constants");
    const { buildCompositeLayouts } = require("../src/dwarf/types");
    const { decodeComposite } = require("../src/elfSymbols");
    const { validateComposite } = require("../src/compositeValidation");
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
        for (const [index, value] of [0x12, 0x34, 0x5678].entries()) {
            assert.strictEqual(regTree.members[index].value, value, `8+8+16 bitfield member: ${index}`);
        }

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
        for (const [index, value] of [3, 5].entries()) {
            assert.strictEqual(pkTree.members[index].value, value, `packed bitfield member: ${index}`);
        }
    }
});

scenario("Distinguish empty-array sentinels from ordinary form-width bounds", () => {
    const c = require("../src/dwarf/constants");
    const { parseDwarf } = require("../src/dwarf");
    const { parseDwarfInternal } = require("../src/dwarf/parser");
    const { buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
    const { validateComposite } = require("../src/compositeValidation");
    const { expandCompositeLeaves } = require("../src/elfSymbols");
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
    function zeroArrayTests() {
        const bounds = [
            [6, 4294967295],
            [7, 18446744073709551615n],
            [0x0d, -1],
            [0x21, -1],
            [0x16, { form: 6, value: 4294967295 }]
        ];
        for (const version of [4, 5])
            for (const [form, upper] of bounds) {
                const f = fixture(
                    [
                        [
                            base("int"),
                            base("char", "char", 1, c.DW_ATE_signed_char),
                            pointer("ptr", "int"),
                            node(
                                "empty",
                                c.DW_TAG_array_type,
                                [typeAttr("char")],
                                [node("range", c.DW_TAG_subrange_type, [attr(c.DW_AT_upper_bound, form, upper)])]
                            ),
                            composite(
                                "Z",
                                "Z",
                                4,
                                [member("n", "n", "int", 0), member("tail", "tail", "empty", 4)],
                                c.DW_TAG_structure_type
                            ),
                            composite("Outer", "Outer", 8, [member("z", "z", "Z", 0), member("p", "p", "ptr", 4)]),
                            variable("zl", "Z"),
                            variable("outer", "Outer", 0x20000010)
                        ]
                    ],
                    { version }
                );
                const parsed = parseDwarfInternal(f.buffer);
                assert.strictEqual(parsed.dies.get(f.offsets.get("range")).subrangeCount, 0, "all-ones upper bound");
                const result = parseDwarf(f.buffer, { runtime: true });
                assert.deepStrictEqual(result.diagnostics, []);
                const layout = result.layouts.get("zl");
                const tail = layout.members.find((entry) => entry.name === "tail");
                assert.strictEqual(tail.byteSize, 0);
                assert.deepStrictEqual(tail.compositeLayout.dimensions, [0]);
                assert.strictEqual(tail.compositeLayout.totalElements, 0);
                validateComposite(layout, 4);
                assert.deepStrictEqual(
                    expandCompositeLeaves({ name: "zl", address: 0x20000000, size: 4 }, layout).map(
                        (entry) => entry.path
                    ),
                    ["zl.n"]
                );
                const outer = result.layouts.get("outer");
                assert.strictEqual(outer.members[0].compositeLayout.members.length, 2);
                assert.strictEqual(outer.members[1].name, "p");
                const empty = outer.runtimeLayout.types.find((entry) => entry.kind === "array");
                assert.strictEqual(empty.count, 0);
                assert.strictEqual(empty.byteSize, 0);
            }
        // The sentinel is form-width-specific, not any integer ending in FF. GCC emits
        // uint8_t a[256] as data1 0xff and a[65536] as data2 0xffff: ordinary bounds.
        for (const [form, upper, count] of [
            [6, 255, 256],
            [0x0b, 255, 256],
            [5, 65535, 65536]
        ]) {
            const f = fixture([
                [
                    base("char", "char", 1, c.DW_ATE_signed_char),
                    pointer("ptr", "char"),
                    node(
                        "a",
                        c.DW_TAG_array_type,
                        [typeAttr("char")],
                        [node("r", c.DW_TAG_subrange_type, [attr(c.DW_AT_upper_bound, form, upper)])]
                    ),
                    node(
                        "pa",
                        c.DW_TAG_array_type,
                        [typeAttr("ptr")],
                        [node("pr", c.DW_TAG_subrange_type, [attr(c.DW_AT_upper_bound, form, upper)])]
                    ),
                    variable("a", "a"),
                    variable("pa", "pa", 0x20010000)
                ]
            ]);
            const result = parseDwarf(f.buffer, { runtime: true });
            assert.strictEqual(result.layouts.get("a").totalElements, count, "form 0x" + form.toString(16));
            assert.strictEqual(result.layouts.get("a").byteSize, count);
            // Runtime nodes describe large arrays without expanding them.
            const runtimeArray = result.layouts.get("pa").runtimeLayout.types.find((entry) => entry.kind === "array");
            assert.strictEqual(runtimeArray.count, count);
            assert.ok(!result.diagnostics.some((entry) => entry.stage === "runtime-layouts"));
        }
    }
    zeroArrayTests();
});

console.log("DWARF composite layout tests passed");
