"use strict";

const { scenario } = require("./helpers/scenario");

// DWARF composite layout parsing: struct member names/offsets/types, array dimensions and element types. Builds a
// minimal ELF32 + DWARF v4 (.debug_info/.debug_abbrev) programmatically, without an external toolchain.
const assert = require("assert");
const { parseDwarf, parseCompositeLayout, parseDwarfVariableTypes, _debugSectionData } = require("../src/dwarf");
const { decodeComposite, expandCompositeLeaves } = require("../src/elfSymbols");
const { buildDwarfElf: dwarfElf } = require("./helpers/elf-fixture");
const { cstr: str, u32 } = require("./helpers/dwarf-tree");

// .debug_info (DWARF v4); @N in comments is the DIE's section offset referenced by ref4
const di = [];
di.push(...u32(0)); // unit_length placeholder (patched at the end)
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

// ELFCOMPRESS_ZSTD (type=2) must decompress directly on Node.js 20, which the extension supports. The payload is the
// zstd CLI's single-frame output for ASCII "DWARF-zstd-test"; the test needs no system zstd.
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

// Struct layout
const layouts = parseCompositeLayout(buf);
const sensor = layouts.get("sensorAlias");
assert.ok(sensor, "resolves the sensorAlias composite layout through typedef");
assert.strictEqual(sensor.kind, "struct");
assert.strictEqual(sensor.typeName, "SensorAlias");
assert.strictEqual(sensor.byteSize, 8);
assert.deepStrictEqual(
    sensor.members.map((m) => [m.name, m.offset, m.byteSize, m.watchType]),
    [
        ["x", 0, 4, "i32"],
        ["y", 4, 4, "f32"]
    ],
    "struct member names, offsets, widths and types"
);

// Array layout (guards DW_AT_upper_bound = 0x2f)
const bufArr = layouts.get("buf");
assert.ok(bufArr, "resolves the buf array layout");
assert.strictEqual(bufArr.kind, "array");
assert.deepStrictEqual(
    bufArr.dimensions,
    [4],
    "upper_bound=3 gives 4 elements (the constant must be 0x2f or the dimension is lost)"
);
assert.strictEqual(bufArr.totalElements, 4);
assert.strictEqual(bufArr.elementType.watchType, "i32");
assert.strictEqual(bufArr.elementType.byteSize, 4);
assert.strictEqual(bufArr.typeName, "int[]");

// Struct arrays keep each element's complete nested layout
const sensorArr = layouts.get("sensorArr");
assert.ok(sensorArr, "resolves the struct array");
assert.strictEqual(sensorArr.kind, "array");
assert.strictEqual(sensorArr.totalElements, 2);
assert.strictEqual(sensorArr.elementType.kind, "struct");
assert.ok(sensorArr.elementType.compositeLayout, "struct array elements keep their member layout");
assert.deepStrictEqual(
    sensorArr.elementType.compositeLayout.members.map((m) => m.name),
    ["x", "y"]
);

// parseDwarfVariableTypes recognizes the same composites
const types = parseDwarfVariableTypes(buf);
assert.strictEqual(types.get("sensorAlias").typeName, "SensorAlias");
assert.strictEqual(types.get("sensorAlias").kind, "struct", "the struct kind survives typedef/volatile");
assert.strictEqual(types.get("sensorAlias").watchType, "", "a whole struct cannot be watched as a scalar");
assert.strictEqual(types.get("buf").typeName, "int[]");
assert.strictEqual(types.get("buf").kind, "array");

// A real Debug ELF with SHF_COMPRESSED still decompresses DWARF and resolves volatile -> typedef -> struct.
const compressedLayouts = parseCompositeLayout(compressedBuf);
const compressedVolatile = compressedLayouts.get("sensorAlias");
assert.ok(compressedVolatile, "volatile composite variables in compressed DWARF keep their layout");
assert.strictEqual(compressedVolatile.typeName, "SensorAlias");
assert.deepStrictEqual(
    compressedVolatile.members.map((m) => m.name),
    ["x", "y"]
);

// DW_FORM_string advances the cursor by UTF-8 byte length, or non-ASCII names would misalign later DIEs.
const unicodeInfo = [];
unicodeInfo.push(...u32(0), 4, 0, ...u32(0), 4, 1);
const unicodeBaseOffset = unicodeInfo.length;
unicodeInfo.push(2, ...Buffer.from("int\0", "utf8"), 0x05, 4);
unicodeInfo.push(5, ...Buffer.from("éx\0", "utf8"), ...u32(unicodeBaseOffset), 5, 0x03, ...u32(0x20001000), 0);
const unicodeLength = unicodeInfo.length - 4;
unicodeInfo.splice(0, 4, ...u32(unicodeLength));
const unicodeBuffer = Buffer.from(unicodeInfo);
assert.strictEqual(parseDwarfVariableTypes(dwarfElf(unicodeBuffer, abbrev)).get("éx").watchType, "i32");

// When a later CU header is truncated, CUs parsed before it are kept instead of clearing all DWARF.
const truncatedSecondCu = Buffer.concat([unicodeBuffer, Buffer.from([...u32(8), 4])]);
assert.strictEqual(
    parseDwarfVariableTypes(dwarfElf(truncatedSecondCu, abbrev)).get("éx").watchType,
    "i32",
    "a truncated later CU must not discard variables from earlier healthy CUs"
);

// DW_AT_data_bit_offset + DW_AT_bit_size stay in the member layout and are shifted/masked when decoding.
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

// A GNU extension form in a CU (GNU_addr_index 0x1f01 in split-DWARF builds) must not abort the whole CU, or every
// later variable in it loses its composite layout
const di2 = [];
di2.push(...u32(0), 4, 0, ...u32(0), 4); // header (unit_length patched later)
di2.push(1, 0x2a); // @11 compile_unit + GNU_addr_index value (ULEB)
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
    // compile_unit: GNU extension attribute. at=0x2131 and form=0x1f01 both exceed 255 and must be written as ULEB byte
    // sequences (0xb1 0x42 / 0x81 0x3e); writing the raw numbers would truncate them
    1,
    0x11,
    1,
    0xb1,
    0x42,
    0x81,
    0x3e,
    0,
    0, // compile_unit: GNU attribute + GNU_addr_index form
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
assert.ok(gnuVar, "later composite layouts in a CU still resolve after a GNU extension form");
assert.strictEqual(gnuVar.kind, "struct");
assert.deepStrictEqual(
    gnuVar.members.map((m) => [m.name, m.offset, m.watchType]),
    [["v", 0, "i32"]]
);

// LTO: the concrete variable DIE has only the address; name and type are inherited through a cross-CU abstract_origin
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

// Multi-dimensional arrays: GCC/Clang emit array_type without DW_AT_byte_size (the size comes from subranges), so
// nested element byteSize must be derived per dimension; otherwise the row stride is 0 and every row decodes as row 0
const mdInfo = [];
const mdAt = () => mdInfo.length;
mdInfo.push(...u32(0), 4, 0, ...u32(0), 4, 1); // v4 header + compile_unit
const mdIntOff = mdAt();
mdInfo.push(2, ...str("int"), 0x05, 4); // base_type int
const mdInnerOff = mdAt();
mdInfo.push(3, ...u32(mdIntOff)); // inner array int[4] (no byte_size)
mdInfo.push(4, 3, 0); //   subrange upper_bound=3 -> 4
const mdOuterOff = mdAt();
mdInfo.push(3, ...u32(mdInnerOff)); // outer array int[3][4] (no byte_size)
mdInfo.push(4, 2, 0); //   subrange upper_bound=2 -> 3
mdInfo.push(5, ...str("m"), ...u32(mdOuterOff), 5, 0x03, ...u32(0x20000000)); // variable m
mdInfo.push(0);
const mdLen = mdInfo.length - 4;
mdInfo[0] = mdLen & 0xff;
mdInfo[1] = (mdLen >>> 8) & 0xff;
mdInfo[2] = (mdLen >>> 16) & 0xff;
mdInfo[3] = (mdLen >>> 24) & 0xff;
const mdDebugInfo = Buffer.from(mdInfo);
// array_type (code 3) has only a type attribute and no byte_size, as real toolchains emit
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
    0, // array_type: type(ref4), no byte_size
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
assert.ok(mdLayout, "resolves the layout of the multi-dimensional array m");
assert.strictEqual(mdLayout.kind, "array");
assert.deepStrictEqual(mdLayout.dimensions, [3], "the outer array counts only its own subrange dimension");
assert.strictEqual(mdLayout.totalElements, 3);
assert.strictEqual(mdLayout.elementType.kind, "array", "the outer element type is the inner array");
assert.strictEqual(mdLayout.elementType.byteSize, 16, "inner int[4] size is derived as 16 (the row stride)");
assert.strictEqual(mdLayout.elementType.compositeLayout.totalElements, 4, "the inner layout keeps its own dimension");
assert.strictEqual(mdLayout.byteSize, 48, "total size is 3x16=48, not 0");
assert.strictEqual(parseDwarfVariableTypes(mdBuf).get("m").typeName, "int[][]");

const mdBytes = Buffer.alloc(48);
for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) mdBytes.writeUInt32LE(row * 1000 + col, row * 16 + col * 4);
}
const mdTree = decodeComposite(mdBytes, mdLayout);
assert.deepStrictEqual(
    mdTree.elements.map((e) => e.offset),
    [0, 16, 32],
    "row decode offsets advance by the 16-byte stride instead of all landing at 0"
);
assert.deepStrictEqual(
    mdTree.elements[1].elements.map((e) => e.value),
    [1000, 1001, 1002, 1003],
    "m[1] reads row 1, not a copy of row 0"
);
const mdLeaves = expandCompositeLeaves({ name: "m", address: 0x20000000, size: 48 }, mdLayout, null);
assert.strictEqual(mdLeaves.length, 12, "full expansion gives 3x4 leaves");
assert.deepStrictEqual(
    mdLeaves
        .filter((l) => l.path === "m[0][0]" || l.path === "m[1][0]" || l.path === "m[2][3]")
        .map((l) => [l.path, l.address]),
    [
        ["m[0][0]", 0x20000000],
        ["m[1][0]", 0x20000010],
        ["m[2][3]", 0x2000002c]
    ],
    "leaf addresses advance by the row stride"
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
        // Common 8+8+16 bit-field layout (4 bytes total)
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
        // validateComposite must not throw INVALID_COMPOSITE_LAYOUT
        assert.doesNotThrow(() => validateComposite(regLayout, 4, 0x20000000));

        // Decoding
        const regBytes = [0x12, 0x34, 0x78, 0x56];
        const regTree = decodeComposite(regBytes, regLayout);
        for (const [index, value] of [0x12, 0x34, 0x5678].entries()) {
            assert.strictEqual(regTree.members[index].value, value, `8+8+16 bitfield member: ${index}`);
        }

        // 1-byte packed bit-fields (3 + 5 bits)
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
    const { validateComposite } = require("../src/compositeValidation");
    const { expandCompositeLeaves } = require("../src/elfSymbols");
    const {
        attr,
        base,
        composite,
        fixture,
        member,
        node,
        pointer,
        typeAttr,
        variable
    } = require("./helpers/dwarf-tree");
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
