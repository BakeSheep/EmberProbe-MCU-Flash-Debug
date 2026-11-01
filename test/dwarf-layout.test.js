"use strict";
// DWARF types and composite layouts: struct and array layouts, scalar, enum and pointer types, deep C++ layouts
// and their consumers, and layout expansion handles through the ELF Worker and service.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseDwarf, parseCompositeLayout, parseDwarfVariableTypes, _debugSectionData } = require("../src/dwarf");
const elf = require("../src/elfSymbols");
const { decodeComposite, expandCompositeLeaves } = require("../src/elfSymbols");
const c = require("../src/dwarf/constants");
const {
    buildVariableTypes,
    buildCompositeLayouts,
    createCompositeLayoutResolver,
    EXPANSION_TYPE_REF
} = require("../src/dwarf/types");
const {
    MAX_COMPOSITE_DEPTH,
    MAX_COMPOSITE_NODES,
    MAX_TYPE_ALIASES,
    MAX_TYPE_INFO_DEPTH
} = require("../src/dwarf/layoutLimits");
const { validateComposite } = require("../src/compositeValidation");
const { normalizeWatchList } = require("../src/validation");
const runtime = require("../src/webview/runtime");
const { buildActiveReadPlan } = require("../src/services/liveWatchService");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { createLayoutExpansion } = require("../src/dwarf/layoutExpansion");
const { writePlan } = require("../src/services/agentPlans");
const { scenario } = require("./helpers/scenario");
const { buildDwarfElf: dwarfElf, buildElf32, buildDebugSections } = require("./helpers/elf-fixture");
const { cstr: str, u32 } = require("./helpers/dwarf-tree");
const { render } = require("./helpers/render-webview");
const { loadProvider } = require("./helpers/load-provider");
const { createWorkerElfService } = require("./helpers/elf-service");

// Struct member names, offsets and types, bitfields, array dimensions and element types
async function composites() {
    // DWARF composite layout parsing: struct member names/offsets/types, array dimensions and element types. Builds a
    // minimal ELF32 + DWARF v4 (.debug_info/.debug_abbrev) programmatically, without an external toolchain.

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
        1, 0x11, 1, 0, 0, 2, 0x24, 0, 0x03, 0x08, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0, 3, 0x13, 1, 0x03, 0x08, 0x0b, 0x0b, 0,
        0, 4, 0x0d, 0, 0x03, 0x08, 0x49, 0x13, 0x6b, 0x0b, 0x0d, 0x0b, 0, 0, 5, 0x34, 0, 0x03, 0x08, 0x49, 0x13, 0x02,
        0x18, 0, 0, 0
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
    assert.strictEqual(
        mdLayout.elementType.compositeLayout.totalElements,
        4,
        "the inner layout keeps its own dimension"
    );
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
                    assert.strictEqual(
                        parsed.dies.get(f.offsets.get("range")).subrangeCount,
                        0,
                        "all-ones upper bound"
                    );
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
                const runtimeArray = result.layouts
                    .get("pa")
                    .runtimeLayout.types.find((entry) => entry.kind === "array");
                assert.strictEqual(runtimeArray.count, count);
                assert.ok(!result.diagnostics.some((entry) => entry.stage === "runtime-layouts"));
            }
        }
        zeroArrayTests();
    });

    console.log("DWARF composite layout tests passed");
}

// Scalar, enum, pointer and multidimensional array types
async function typeMatrix() {
    const dies = new Map([
        [1, { tag: c.DW_TAG_base_type, name: "uint32_t", encoding: c.DW_ATE_unsigned, byteSize: 4 }],
        [2, { tag: c.DW_TAG_base_type, name: "int16_t", encoding: c.DW_ATE_signed, byteSize: 2 }],
        [3, { tag: c.DW_TAG_base_type, name: "float", encoding: c.DW_ATE_float, byteSize: 4 }],
        [4, { tag: c.DW_TAG_base_type, name: "_Bool", encoding: c.DW_ATE_boolean, byteSize: 1 }],
        [5, { tag: c.DW_TAG_enumeration_type, name: "Flags", encoding: c.DW_ATE_unsigned, byteSize: 4, typeRef: 1 }],
        [6, { tag: c.DW_TAG_typedef, name: "FlagAlias", typeRef: 5 }],
        [7, { tag: c.DW_TAG_enumeration_type, name: "SmallFlags", byteSize: 1, typeRef: 1 }],
        [9, { tag: c.DW_TAG_enumeration_type, name: "UnknownFlags", byteSize: 4 }],
        [8, { tag: c.DW_TAG_pointer_type, typeRef: 20, byteSize: 4 }],
        [20, { tag: c.DW_TAG_structure_type, name: "Sensor", byteSize: 4 }],
        [21, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 0 }],
        [30, { tag: c.DW_TAG_array_type, typeRef: 1 }],
        [31, { tag: c.DW_TAG_subrange_type, subrangeCount: 2 }],
        [32, { tag: c.DW_TAG_subrange_type, subrangeCount: 3 }],
        [40, { tag: c.DW_TAG_structure_type, name: "Switch", byteSize: 1 }],
        [41, { tag: c.DW_TAG_member, name: "enabled", typeRef: 4, memberOffset: 0 }]
    ]);
    const parsed = {
        dies,
        childrenMap: new Map([
            [20, [21]],
            [30, [31, 32]],
            [40, [41]]
        ]),
        variables: [
            { name: "unsigned", typeRef: 1 },
            { name: "signed", typeRef: 2 },
            { name: "float", typeRef: 3 },
            { name: "boolean", typeRef: 4 },
            { name: "enumAlias", typeRef: 6 },
            { name: "smallEnum", typeRef: 7 },
            { name: "unknownEnum", typeRef: 9 },
            { name: "pointer", typeRef: 8 },
            { name: "matrix", typeRef: 30 },
            { name: "switch", typeRef: 40 }
        ]
    };
    const types = buildVariableTypes(parsed);
    for (const [name, kind, watchType] of [
        ["unsigned", "scalar", "u32"],
        ["signed", "scalar", "i16"],
        ["float", "scalar", "f32"],
        ["boolean", "scalar", "u8"],
        ["enumAlias", "scalar", "u32"],
        ["smallEnum", "scalar", "u8"],
        ["unknownEnum", "scalar", ""],
        ["pointer", "scalar", "u32"],
        ["matrix", "array", ""]
    ]) {
        assert.strictEqual(types.get(name).kind, kind, `${name} kind`);
        assert.strictEqual(types.get(name).watchType, watchType, `${name} watch type`);
    }
    assert.strictEqual(types.get("matrix").typeName, "uint32_t[][]");
    assert.strictEqual(types.get("pointer").typeName, "struct Sensor *");
    assert.strictEqual(types.get("boolean").isBoolean, true);
    assert.strictEqual(
        expandCompositeLeaves(
            { name: "switch", address: 0x20000100, size: 1 },
            buildCompositeLayouts(parsed).get("switch")
        )[0].isBoolean,
        true
    );

    const matrix = buildCompositeLayouts(parsed).get("matrix");
    assert.deepStrictEqual(matrix.dimensions, [2]);
    assert.strictEqual(matrix.elementType.byteSize, 12, "each row must have a 12-byte stride");
    assert.deepStrictEqual(matrix.elementType.compositeLayout.dimensions, [3]);
    const bytes = Buffer.alloc(24);
    for (let index = 0; index < 6; index++) bytes.writeUInt32LE(index + 1, index * 4);
    const tree = decodeComposite(bytes, matrix);
    assert.deepStrictEqual(
        tree.elements[1].elements.map((element) => element.value),
        [4, 5, 6]
    );
    const leaves = expandCompositeLeaves({ name: "matrix", address: 0x20000000, size: 24 }, matrix);
    assert.deepStrictEqual(
        leaves.map((leaf) => leaf.path),
        ["matrix[0][0]", "matrix[0][1]", "matrix[0][2]", "matrix[1][0]", "matrix[1][1]", "matrix[1][2]"]
    );
    assert.strictEqual(leaves[3].address, 0x2000000c);

    scenario("Preserve UTF, reference, member pointer and const member metadata", () => {
        const { buildVariableTypes, buildCompositeLayouts, encodingToWatchType } = require("../src/dwarf/types");
        const { expandCompositeLeaves } = require("../src/elfSymbols");
        // UTF character encodings
        for (const [bytes, watchType] of [
            [1, "u8"],
            [2, "u16"],
            [4, "u32"]
        ]) {
            assert.strictEqual(encodingToWatchType(c.DW_ATE_UTF, bytes), watchType, `UTF character width: ${bytes}`);
        }

        // Reference types and member pointers
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
        for (const [name, expected] of [
            ["lref", { typeName: "int &", watchType: "u32", kind: "scalar" }],
            ["rref", { typeName: "int &&", watchType: "u32" }],
            ["pmem", { watchType: "u32" }]
        ]) {
            for (const [key, value] of Object.entries(expected)) {
                assert.strictEqual(types.get(name)[key], value, `${name}: ${key}`);
            }
        }

        assert.strictEqual(types.get("cval").isConst, true);

        const dataLayout = buildCompositeLayouts(parsed).get("data");
        const dataLeaves = expandCompositeLeaves({ name: "data", address: 0x20000000, size: 6 }, dataLayout, null);
        assert.strictEqual(dataLeaves.length, 2, "char16_t member must not disappear during expansion");
        assert.strictEqual(dataLeaves[0].path, "data.ch");
        assert.strictEqual(dataLeaves[0].type, "u16");

        assert.strictEqual(dataLeaves[1].path, "data.ro");
        assert.strictEqual(dataLeaves[1].isConst, true, "const member must retain isConst flag");
    });

    console.log("DWARF scalar, enum, pointer and multidimensional array type tests passed");
}

// Deep C++ layouts, cache order, runtime partial graphs and localized consumer safety
async function deepLayouts() {
    function fixture() {
        const dies = new Map();
        const childrenMap = new Map();
        const variables = [];
        let next = 1;
        const add = (die, children = []) => {
            const ref = next++;
            dies.set(ref, die);
            childrenMap.set(ref, children);
            return ref;
        };
        const integer = add({ tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 });
        const member = (name, typeRef, memberOffset = 0) => add({ tag: c.DW_TAG_member, name, typeRef, memberOffset });
        const struct = (name, children, byteSize = 8, tag = c.DW_TAG_structure_type) =>
            add({ tag, name, byteSize }, children);
        const chain = (count, target = integer) => {
            for (let index = count - 1; index >= 0; index--) target = struct("S" + index, [member("next", target)]);
            return target;
        };
        const variable = (name, typeRef) => variables.push({ name, typeRef });
        const array = (typeRef, count = 1) =>
            add({ tag: c.DW_TAG_array_type, typeRef }, [add({ tag: c.DW_TAG_subrange_type, subrangeCount: count })]);
        const aliases = (target, count) => {
            const tags = [c.DW_TAG_typedef, c.DW_TAG_const_type, c.DW_TAG_volatile_type, c.DW_TAG_restrict_type];
            for (let index = 0; index < count; index++)
                target = add({ tag: tags[index % tags.length], typeRef: target });
            return target;
        };
        return { dies, childrenMap, variables, add, integer, member, struct, chain, variable, array, aliases };
    }
    function nodes(layout) {
        if (!layout) return 0;
        const entries = layout.kind === "array" ? [layout.elementType] : layout.members || [];
        return 1 + entries.reduce((count, entry) => count + 1 + nodes(entry?.compositeLayout), 0);
    }
    function limits(layout) {
        const entries = layout.kind === "array" ? [layout.elementType] : layout.members || [];
        return entries.flatMap((entry) => [
            ...(entry.unobservable ? [entry] : []),
            ...(entry.compositeLayout ? limits(entry.compositeLayout) : [])
        ]);
    }
    function symbol(layout, name = "root") {
        return { name, address: 0x20000000, size: layout.byteSize, isComposite: true, compositeLayout: layout };
    }

    // A limit belongs to one branch; scalar and composite siblings remain observable.
    {
        const f = fixture();
        const shallow = f.struct("Shallow", [f.member("value", f.integer)], 4);
        const root = f.struct("Root", [f.member("deep", f.chain(50)), f.member("shallow", shallow, 4)], 12);
        f.variable("root", root);
        const layout = buildCompositeLayouts(f).get("root");
        assert.strictEqual(layout.truncated, true);
        assert.deepStrictEqual(
            limits(layout).map((entry) => entry.unobservable),
            ["depth-limit"]
        );
        assert.strictEqual(layout.members[1].compositeLayout.members[0].watchType, "i32");
        assert.ok(nodes(layout) <= MAX_COMPOSITE_NODES);
        validateComposite(layout, 12);
        const leaves = elf.expandCompositeLeaves(symbol(layout), layout);
        assert.deepStrictEqual(
            leaves.map((leaf) => leaf.path),
            ["root.shallow.value"]
        );
        assert.deepStrictEqual(elf.expandCompositeLeaves(symbol(layout), layout, elf.parseMemberPath("root.deep")), []);
        assert.deepStrictEqual(normalizeWatchList([{ name: "root.deep", type: "u32" }], [symbol(layout)]), []);
        const decoded = elf.decodeComposite(Buffer.alloc(12), layout);
        assert.strictEqual(decoded.truncated, true);
        assert.strictEqual(decoded.members[1].members[0].value, 0);
    }

    // libstdc++ variant bases, recursive alternatives and cv/typedef wrappers inside Axis axes[1].
    {
        const f = fixture();
        let union = f.struct("_Variadic_union<>", [], 4, c.DW_TAG_union_type);
        for (let alternative = 0; alternative < 12; alternative++) {
            const initialized = f.struct(
                "_Uninitialized<T" + alternative + ">",
                [f.member("_M_storage", f.integer)],
                4
            );
            union = f.struct(
                "_Variadic_union<T...>",
                [f.member("_M_first", f.aliases(initialized, 8)), f.member("_M_rest", f.aliases(union, 8))],
                4,
                c.DW_TAG_union_type
            );
        }
        let type = f.struct("_Variant_storage", [f.member("_M_u", union)], 4, c.DW_TAG_class_type);
        for (const name of [
            "_Copy_ctor_base",
            "_Move_ctor_base",
            "_Copy_assign_base",
            "_Move_assign_base",
            "_Variant_base",
            "variant"
        ]) {
            const base = f.add({ tag: c.DW_TAG_inheritance, typeRef: f.aliases(type, 8), memberOffset: 0 });
            type = f.struct(name, [base], 4, c.DW_TAG_class_type);
        }
        const axis = f.struct("Axis", [f.member("state", type), f.member("position", f.integer, 4)], 8);
        f.variable("axes", f.array(axis));
        const layout = buildCompositeLayouts(f).get("axes");
        assert.strictEqual(layout.truncated, undefined);
        assert.deepStrictEqual(limits(layout), []);
        validateComposite(layout, 8);
        const leaves = elf.expandCompositeLeaves(symbol(layout, "axes"), layout);
        assert.strictEqual(leaves.length, 13, "deep variant alternatives remain visible to consumers");
        assert.ok(leaves.some((leaf) => leaf.path.endsWith("._M_storage")));
    }

    // Original reproduction and a new limit-crossing reproduction, in either order and after eviction.
    for (const count of [8, MAX_COMPOSITE_DEPTH + 1]) {
        const f = fixture();
        const refs = [f.integer];
        for (let index = count - 1; index >= 0; index--)
            refs.unshift(f.struct("S" + index, [f.member("next", refs[0])]));
        f.variable("warm", refs[0]);
        const target = refs[3];
        f.variable("inner", target);
        f.variable("deep", f.chain(5, target));
        for (let index = 0; index < 70; index++)
            f.variable("evict" + index, f.struct("Evict" + index, [f.member("value", f.integer)], 4));
        const cold = createCompositeLayoutResolver(f);
        const expected = JSON.stringify(cold("deep"));
        const fullInner = JSON.stringify(cold("inner"));
        assert.strictEqual(limits(cold("inner")).length, 0, "truncated entries are not cached as complete types");
        const warm = createCompositeLayoutResolver(f);
        warm("warm");
        assert.strictEqual(JSON.stringify(warm("deep")), expected);
        for (let index = 0; index < 70; index++) warm("evict" + index);
        assert.strictEqual(JSON.stringify(warm("deep")), expected, "LRU eviction cannot change expansion");
        assert.strictEqual(JSON.stringify(warm("inner")), fullInner);
    }

    // Fair shares make a fresh build stricter than "cached cost fits": a type completed
    // as a root must not be reused complete inside a tighter sibling share.
    {
        const f = fixture();
        const big = f.struct(
            "Big",
            Array.from({ length: 5000 }, (_, index) => f.member("a" + index, f.integer)),
            4
        );
        const pair = f.struct(
            "Pair",
            [f.member("big", big), f.member("small", f.struct("Small", [f.member("b", f.integer)], 4))],
            8
        );
        const outer = f.struct(
            "Outer",
            [f.member("pair", pair), f.member("other", f.struct("Other", [f.member("u", f.integer)], 4))],
            16
        );
        f.variable("pair", pair);
        f.variable("outer", outer);
        const expected = JSON.stringify(createCompositeLayoutResolver(f)("outer"));
        assert.ok(expected.includes('"expansion-budget"'), "the fixture must cross a fair-share boundary");
        const warm = createCompositeLayoutResolver(f);
        assert.strictEqual(limits(warm("pair")).length, 0);
        assert.strictEqual(JSON.stringify(warm("outer")), expected, "budget-limited expansion is order independent");
    }

    // Array metadata must stay deterministic even when a long outer chain warms inner types.
    for (const count of [70, MAX_TYPE_INFO_DEPTH + 20]) {
        const f = fixture();
        const refs = [f.integer];
        for (let index = 0; index < count; index++) refs.push(f.array(refs.at(-1)));
        f.variable("warmArray", refs.at(-1));
        f.variable("innerArray", refs[20]);
        for (let index = 0; index < 70; index++)
            f.variable("evictArray" + index, f.array(f.struct("ArrayValue" + index, [f.member("v", f.integer)], 4)));
        const cold = createCompositeLayoutResolver(f);
        const expected = cold("innerArray");
        assert.strictEqual(expected.byteSize, 4);
        const warm = createCompositeLayoutResolver(f);
        warm("warmArray");
        assert.deepStrictEqual(warm("innerArray"), expected);
        for (let index = 0; index < 70; index++) warm("evictArray" + index);
        assert.deepStrictEqual(warm("innerArray"), expected);
        validateComposite(expected, 4);
    }

    // Wrappers have their own generous iterative bound and never consume composite depth.
    {
        const f = fixture();
        f.variable("alias", f.aliases(f.chain(MAX_COMPOSITE_DEPTH), 200));
        const layout = buildCompositeLayouts(f).get("alias");
        assert.deepStrictEqual(limits(layout), []);
        assert.strictEqual(layout.isConst, true);
        assert.strictEqual(buildVariableTypes(f).get("alias").kind, "struct");
        f.variable("oversizedAlias", f.aliases(f.integer, MAX_TYPE_ALIASES + 4000));
        assert.strictEqual(buildVariableTypes(f).get("oversizedAlias").watchType, "");
    }

    // Malformed by-value recursion is distinct from a depth limit, including aliases and bases.
    {
        const f = fixture();
        const cycle = f.struct("Cycle", [], 4);
        f.childrenMap.set(cycle, [
            f.add({ tag: c.DW_TAG_inheritance, typeRef: f.aliases(cycle, 3), memberOffset: 0 }),
            f.member("value", f.integer)
        ]);
        const root = f.struct("Root", [f.member("bad", cycle), f.member("good", f.integer, 4)]);
        f.variable("root", root);
        const layout = buildCompositeLayouts(f).get("root");
        assert.strictEqual(layout.truncated, true);
        const bad = layout.members[0].compositeLayout.members[0];
        assert.strictEqual(bad.unobservable, "type-cycle");
        assert.strictEqual(bad.compositeLayout, undefined);
        assert.deepStrictEqual(
            elf.expandCompositeLeaves(symbol(layout), layout).map((leaf) => leaf.path),
            ["root.bad.value", "root.good"]
        );
    }

    // A wide branch cannot exhaust sibling work; cache hits account for the same per-root cost.
    {
        const f = fixture();
        const huge = f.struct(
            "Huge",
            Array.from({ length: 10000 }, (_, index) => f.member("m" + index, f.integer)),
            4
        );
        const shallow = f.struct("Shallow", [f.member("value", f.integer)], 4);
        const root = f.struct("Root", [f.member("huge", huge), f.member("small", shallow, 4)], 8);
        f.variable("root", root);
        f.variable("warm", huge);
        const cold = createCompositeLayoutResolver(f);
        const layout = cold("root");
        assert.strictEqual(layout.members[0].unobservable, "expansion-budget");
        assert.strictEqual(layout.members[0].compositeLayout, undefined);
        assert.strictEqual(layout.members[1].compositeLayout.members[0].watchType, "i32");
        assert.strictEqual(layout.truncated, true);
        assert.ok(nodes(layout) <= MAX_COMPOSITE_NODES);
        const warm = createCompositeLayoutResolver(f);
        assert.strictEqual(warm("warm").truncated, undefined);
        assert.deepStrictEqual(warm("root"), layout);
        assert.deepStrictEqual(
            elf.expandCompositeLeaves(symbol(layout), layout).map((leaf) => leaf.path),
            ["root.small.value"]
        );
    }

    // Metadata size is bounded before serialization, including when a warm cache cannot fit.
    {
        const f = fixture();
        const big = f.struct(
            "Big",
            Array.from({ length: 60 }, (_, index) => f.member("x".repeat(20000) + index, f.integer)),
            4
        );
        const small = f.struct("Small", [f.member("value", f.integer)], 4);
        f.variable("root", f.struct("Root", [f.member("big", big), f.member("small", small, 4)], 8));
        f.variable("warm", big);
        const cold = createCompositeLayoutResolver(f)("root");
        assert.strictEqual(cold.members[0].unobservable, "expansion-budget");
        assert.strictEqual(cold.members[1].compositeLayout.members[0].watchType, "i32");
        const warm = createCompositeLayoutResolver(f);
        assert.strictEqual(warm("warm").truncated, undefined);
        assert.deepStrictEqual(warm("root"), cold);
    }

    // Every consumer ignores unobservable entries even if stale/hostile watchType/layout data is attached.
    {
        const leaf = { kind: "scalar", typeName: "int", watchType: "i32", byteSize: 4 };
        const layout = {
            kind: "struct",
            byteSize: 8,
            truncated: true,
            members: [
                {
                    ...leaf,
                    name: "bad",
                    offset: 0,
                    unobservable: "depth-limit",
                    compositeLayout: { kind: "struct", byteSize: 4, members: [{ ...leaf, name: "fake", offset: 0 }] }
                },
                { ...leaf, name: "good", offset: 4 }
            ]
        };
        const sym = symbol(layout);
        assert.deepStrictEqual(
            elf.expandCompositeLeaves(sym, layout).map((entry) => entry.path),
            ["root.good"]
        );
        assert.deepStrictEqual(elf.expandCompositeLeaves(sym, layout, elf.parseMemberPath("root.bad.fake")), []);
        assert.strictEqual(normalizeWatchList([{ name: "root.bad", type: "i32" }], [sym]).length, 0);
        const tree = elf.decodeComposite(Buffer.alloc(8), layout);
        assert.strictEqual(tree.members[0].unobservable, "depth-limit");
        assert.strictEqual(tree.members[0].value, undefined);
        assert.strictEqual(tree.members[0].offset, undefined, "unavailable decoded rows carry no writable address");
        const array = {
            kind: "array",
            byteSize: 4,
            dimensions: [1],
            totalElements: 1,
            elementType: { ...leaf, unobservable: "expansion-budget" }
        };
        assert.deepStrictEqual(elf.expandCompositeLeaves(symbol(array), array), []);
        assert.deepStrictEqual(elf.expandCompositeLeaves(symbol(array), array, elf.parseMemberPath("root[0]")), []);
        assert.deepStrictEqual(buildActiveReadPlan([[symbol(array)]], elf), []);
        assert.strictEqual(elf.decodeComposite(Buffer.alloc(4), array).elements.length, 0);
        // Both webviews' leaf collectors skip unobservable members, exercised on the rendered pages.
        for (const view of [render(getModernWebviewContent({}, "en")), render(getLiveWatchContent({}, "en"))]) {
            try {
                const { collectLeaves: collect } = view.window.eval("valueTree");
                assert.deepStrictEqual(
                    JSON.parse(JSON.stringify(collect(layout, "root", 0x20000000))).map((entry) => entry.path),
                    ["root.good"]
                );
                assert.strictEqual(collect(array, "root", 0x20000000).length, 0);
                view.assertHealthy();
            } finally {
                view.close();
            }
        }
        assert.strictEqual(runtime.MAX_COMPOSITE_DEPTH, MAX_COMPOSITE_DEPTH);
        assert.strictEqual(
            runtime.unobservableReason("type-cycle", (key) => key),
            "lw.layoutTypeCycle"
        );
    }

    // Both localized views expose unavailable rows without leaf controls, including imports.
    {
        const layout = {
            kind: "struct",
            typeName: "struct Partial",
            byteSize: 8,
            truncated: true,
            members: [
                ...["depth-limit", "expansion-budget", "type-cycle"].map((code, index) => ({
                    name: "limited" + index,
                    offset: 0,
                    byteSize: 4,
                    kind: "struct",
                    unobservable: code,
                    watchType: "i32"
                })),
                { name: "good", offset: 4, byteSize: 4, watchType: "i32", typeName: "int" }
            ]
        };
        for (const lang of ["en", "zh"]) {
            const table = require("../src/i18n/" + lang);
            const sidebar = render(getModernWebviewContent({}, lang));
            const graph = render(getLiveWatchContent({ panelId: 1 }, lang));
            try {
                sidebar.send({ type: "availableVariables", symbols: [symbol(layout)] });
                sidebar.document.querySelector(".available-row.comp .av-arrow").click();
                assert.strictEqual(sidebar.document.querySelectorAll(".available-row.leaf").length, 1);
                sidebar.send({ type: "sidebarWatchList", items: [symbol(layout)] });
                assert.strictEqual(sidebar.document.querySelectorAll(".sb-mrow").length, 1);
                graph.document.getElementById("import").click();
                graph.send({ type: "variablesList", symbols: [symbol(layout)] });
                graph.document.querySelector(".imp-row .imp-arrow").click();
                assert.strictEqual(graph.document.querySelectorAll(".imp-row.leaf").length, 1);
                graph.send({ type: "watchList", items: [symbol(layout)] });
                assert.strictEqual(graph.document.querySelectorAll(".member-row").length, 1);
                for (const key of [
                    "lw.layoutDepthLimit",
                    "lw.layoutExpansionBudget",
                    "lw.layoutTypeCycle",
                    "lw.layoutPartial"
                ]) {
                    assert.ok(sidebar.document.getElementById("availableVars").textContent.includes(table[key]));
                    assert.ok(sidebar.document.getElementById("liveValues").textContent.includes(table[key]));
                    assert.ok(graph.document.getElementById("impList").textContent.includes(table[key]));
                    assert.ok(
                        graph.document
                            .querySelector(".comp-content > .variable-notices")
                            .textContent.includes(table[key])
                    );
                }
                sidebar.assertHealthy();
                graph.assertHealthy();
            } finally {
                sidebar.close();
                graph.close();
            }
        }
    }

    // Array elements past the first 16 stay reachable: "show more" reveals the next page in both views.
    {
        const elementType = { kind: "base", typeName: "uint8_t", byteSize: 1, watchType: "u8" };
        const array = (count) => ({
            kind: "array",
            typeName: "uint8_t[" + count + "]",
            byteSize: count,
            elementType,
            totalElements: count,
            dimensions: [count]
        });
        const sidebar = render(getModernWebviewContent({}, "zh"));
        const graph = render(getLiveWatchContent({ panelId: 1 }, "zh"));
        try {
            const rows = (view, selector) => view.document.querySelectorAll(selector).length;
            const more = (view) => view.document.querySelector(".array-more button");
            sidebar.send({ type: "sidebarWatchList", items: [symbol(array(25), "sbus_buf")] });
            assert.strictEqual(rows(sidebar, ".sb-mrow"), 16);
            assert.ok(sidebar.document.querySelector(".array-more").textContent.includes("其余 9 个元素未显示"));
            more(sidebar).click();
            assert.strictEqual(rows(sidebar, ".sb-mrow"), 25);
            assert.strictEqual(more(sidebar), null);
            sidebar.send({ type: "sidebarWatchList", items: [symbol(array(100), "big")] });
            assert.strictEqual(rows(sidebar, ".sb-mrow"), 16);
            more(sidebar).click();
            assert.strictEqual(rows(sidebar, ".sb-mrow"), 80);
            more(sidebar).click();
            assert.strictEqual(rows(sidebar, ".sb-mrow"), 100);
            graph.send({ type: "watchList", items: [symbol(array(25), "sbus_buf")] });
            assert.strictEqual(rows(graph, ".member-row"), 16);
            more(graph).click();
            assert.strictEqual(rows(graph, ".member-row"), 25);
            assert.strictEqual(more(graph), null);
            sidebar.assertHealthy();
            graph.assertHealthy();
        } finally {
            sidebar.close();
            graph.close();
        }
    }

    const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
    const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
    const readTree = (graph) =>
        new RuntimeObjectReader(
            {
                address: 0x20000000,
                size: 12,
                runtimeLayout: graph,
                runtimeStaticPointers: true,
                runtimeRanges: [{ start: 0x20000000, end: 0x2000000c }]
            },
            async (_address, size) => Buffer.alloc(size)
        );
    // Runtime metadata and sampled trees preserve shallow siblings across their distinct limits.
    for (const mode of ["depth", "nodes", "cycle"]) {
        const f = fixture();
        let deep;
        if (mode === "depth") deep = f.chain(160);
        else if (mode === "nodes") {
            deep = f.struct(
                "Huge",
                Array.from({ length: 4500 }, (_, index) =>
                    f.member("p" + index, f.add({ tag: c.DW_TAG_pointer_type, typeRef: f.integer }))
                ),
                4
            );
        } else {
            deep = f.struct("Cycle", [], 4);
            f.childrenMap.set(deep, [f.member("self", f.aliases(deep, 20))]);
        }
        const pointer = f.add({ tag: c.DW_TAG_pointer_type, typeRef: f.integer });
        const root = f.struct(
            "Root",
            [f.member("deep", deep), f.member("good", f.integer, 4), f.member("ptr", pointer, 8)],
            12
        );
        f.variable("root", f.aliases(root, 200));
        const diagnostics = [];
        const graph = createRuntimeLayoutResolver(f)("root", (_name, error) => diagnostics.push(error.code));
        assert.strictEqual(graph.truncated, true);
        assert.ok(graph.types.length <= 4096);
        assert.ok(Buffer.byteLength(JSON.stringify(graph)) < 2 * 1024 * 1024);
        const reader = readTree(graph);
        const good = reader.type(reader.type(graph.root).fields.find((field) => field.name === "good").type);
        assert.strictEqual(good.watchType, "i32");
        assert.ok(
            graph.types.some(
                (type) =>
                    type.unobservable ===
                    (mode === "depth" ? "depth-limit" : mode === "cycle" ? "type-cycle" : "expansion-budget")
            )
        );
        assert.ok(diagnostics.includes(mode === "cycle" ? "DWARF_TYPE_CYCLE" : "DWARF_BUDGET_EXCEEDED"));
        const tree = await reader.sample();
        assert.strictEqual(tree.truncated, true);
        assert.strictEqual(tree.members.find((member) => member.name === "good").value, 0);
        assert.ok(reader.nodes <= 256, "runtime sampling visits remain bounded");
        const unavailable = graph.types.findIndex((type) => type.unobservable);
        await assert.rejects(
            reader.member({ address: 0x20000000, type: graph.root }, { type: unavailable, name: "bad", offset: 0 }),
            { code: "LIVE_LAYOUT_UNSUPPORTED" }
        );
    }
    console.log("Deep C++ layout, cache order, runtime partial graphs and localized consumer safety tests passed");
}

// Worker and service expansion handles, stale ELF rejection and write safety
async function expansion() {
    function deepElf(count = 50) {
        const info = [0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 4, 1];
        const u32 = (value) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];
        const str = (value) => Array.from(Buffer.from(value + "\0"));
        const integer = info.length;
        info.push(2, ...str("int"), 5, 4);
        let target = integer;
        for (let index = count - 1; index >= 0; index--) {
            const ref = info.length;
            info.push(3, ...str("S" + index), 4, 4, ...str("next"), ...u32(target), 0, 0);
            target = ref;
        }
        const root = info.length;
        info.push(3, ...str("Root"), 8, 4, ...str("deep"), ...u32(target), 0, 4, ...str("good"), ...u32(integer), 4, 0);
        info.push(5, ...str("root"), ...u32(root), 5, 3, ...u32(0x20000000), 0);
        const bytes = Buffer.from(info);
        bytes.writeUInt32LE(bytes.length - 4);
        const abbrev = Buffer.from([
            1, 0x11, 1, 0, 0, 2, 0x24, 0, 3, 8, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0, 3, 0x13, 1, 3, 8, 0x0b, 0x0b, 0, 0, 4,
            0x0d, 0, 3, 8, 0x49, 0x13, 0x38, 0x0b, 0, 0, 5, 0x34, 0, 3, 8, 0x49, 0x13, 2, 0x18, 0, 0, 0
        ]);
        return buildElf32({
            sections: [
                { name: ".data", flags: 3, addr: 0x20000000, data: Buffer.alloc(8) },
                ...buildDebugSections({ info: bytes, abbrev })
            ],
            symbols: [{ name: "root", value: 0x20000000, size: 8 }]
        });
    }
    function limitedMember(layout) {
        const pending = [layout];
        while (pending.length) {
            const node = pending.pop();
            if (node.unobservable) return node;
            for (const member of node.members || []) pending.push(member);
            if (node.compositeLayout) pending.push(node.compositeLayout);
            if (node.elementType) pending.push(node.elementType);
        }
        return null;
    }
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-deep-layout-"));
    const file = path.join(temp, "deep.elf");
    fs.writeFileSync(file, deepElf());
    const service = createWorkerElfService(file);
    try {
        await service.ready();
        const layout = await service.layout("root");
        const member = limitedMember(layout);
        assert.strictEqual(member.unobservable, "depth-limit");
        assert.ok(member.expansionHandle);
        const generation = layout.expansionGeneration;
        const expanded = await service.expandLayout(member.expansionHandle, generation);
        assert.strictEqual(expanded.kind, "struct");
        assert.strictEqual(expanded.truncated, undefined, "a fresh budget can fully resolve the remaining branch");
        assert.strictEqual(expanded.expansionGeneration, generation);
        assert.deepStrictEqual(await service.expandLayout(member.expansionHandle, generation), expanded);
        assert.strictEqual(member.compositeLayout, undefined, "expansion must not mutate the cached bounded root");
        assert.strictEqual(await service.layout("root"), layout);
        assert.strictEqual(service.layoutErrors.size, 0, "partial layouts are successful results");

        for (const invalid of [null, {}, 1, "type:42", member.expansionHandle + "x", "x".repeat(10000)])
            await assert.rejects(service.expandLayout(invalid, generation), { code: "INVALID_LAYOUT_HANDLE" });
        await assert.rejects(service.expandLayout(member.expansionHandle, "1"), { code: "INVALID_LAYOUT_HANDLE" });
        const forged = member.expansionHandle.slice(0, -1) + (member.expansionHandle.endsWith("a") ? "b" : "a");
        await assert.rejects(service.expandLayout(forged, generation), { code: "INVALID_LAYOUT_HANDLE" });
        assert.strictEqual(service.layoutErrors.size, 0, "invalid handles never poison symbol failure caching");

        const workerReply = new Promise((resolve) => {
            const listener = (message) => {
                if (message.id !== 98765) return;
                service.worker.removeListener("message", listener);
                resolve(message);
            };
            service.worker.on("message", listener);
        });
        service.worker.postMessage({ type: "expandLayout", id: 98765, handle: member.expansionHandle, generation: {} });
        assert.strictEqual((await workerReply).error.code, "INVALID_LAYOUT_HANDLE");

        const provider = Object.create(loadProvider().prototype);
        provider.readElfSymbols = () => service.read();
        provider._elfView.prepareLayouts = async () => {};
        const sym = service.symbolByName.get("root");
        const truncatedPath = "root.deep" + ".next".repeat(32);
        assert.deepStrictEqual(elf.expandCompositeLeaves(sym, layout, elf.parseMemberPath(truncatedPath)), []);
        for (const name of [truncatedPath, truncatedPath + ".next"]) {
            assert.throws(() => writePlan([{ name, value: 1 }], () => provider.readElfSymbols()), {
                code: "INVALID_VARIABLE_PATH"
            });
            await assert.rejects(provider._agentOps.addWatch({ variables: [name] }), { code: "INVALID_VARIABLE_PATH" });
        }
        assert.strictEqual(
            writePlan([{ name: "root.good", value: 1 }], () => provider.readElfSymbols()).items.length,
            1,
            "a shallow sibling retains its normal typed write authorization path"
        );

        const previousHandle = member.expansionHandle;
        service.invalidate();
        await assert.rejects(service.expandLayout(previousHandle, generation), { code: "STALE_LAYOUT_HANDLE" });
        await service.ready();
        const nextLayout = await service.layout("root");
        await assert.rejects(service.expandLayout(previousHandle, nextLayout.expansionGeneration), {
            code: "STALE_LAYOUT_HANDLE"
        });
        fs.writeFileSync(file, deepElf(60));
        await assert.rejects(
            service.expandLayout(limitedMember(nextLayout).expansionHandle, nextLayout.expansionGeneration),
            { code: "STALE_LAYOUT_HANDLE" }
        );
        assert.strictEqual(service.layoutErrors.size, 0);
    } finally {
        service.invalidate();
        fs.rmSync(temp, { recursive: true, force: true });
    }

    // Unknown signed references still fail lookup; raw references are never accepted as handles.
    const parsed = {
        dies: new Map([[1, { tag: c.DW_TAG_structure_type, name: "S", byteSize: 4 }]]),
        childrenMap: new Map(),
        variables: [{ name: "s", typeRef: 1 }]
    };
    const resolver = createCompositeLayoutResolver(parsed);
    const expansion = createLayoutExpansion(resolver);
    const unavailable = { unobservable: "expansion-budget" };
    Object.defineProperty(unavailable, EXPANSION_TYPE_REF, { value: 999 });
    const token = expansion.annotate(unavailable).expansionHandle;
    assert.throws(() => expansion.expand(token), { code: "INVALID_LAYOUT_HANDLE" });
    assert.throws(() => expansion.expand({ typeRef: 1 }), { code: "INVALID_LAYOUT_HANDLE" });
    assert.strictEqual(expansion.annotate(null), null);
    const cycle = { unobservable: "type-cycle" };
    Object.defineProperty(cycle, EXPANSION_TYPE_REF, { value: 1 });
    assert.strictEqual(expansion.annotate(cycle).expansionHandle, undefined, "cycles cannot be lazily expanded");
    console.log("DWARF Worker/service expansion handles, stale ELF rejection and write safety tests passed");
}

(async () => {
    await scenario("Struct member names, offsets and types, bitfields, array dimensions and element types", composites);
    await scenario("Scalar, enum, pointer and multidimensional array types", typeMatrix);
    await scenario("Deep C++ layouts, cache order, runtime partial graphs and localized consumer safety", deepLayouts);
    await scenario("Worker and service expansion handles, stale ELF rejection and write safety", expansion);
    console.log("DWARF type, composite, deep layout and expansion tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
