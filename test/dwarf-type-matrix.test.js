"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const c = require("../src/dwarf/constants");
const { buildVariableTypes, buildCompositeLayouts } = require("../src/dwarf/types");
const { decodeComposite, expandCompositeLeaves } = require("../src/elfSymbols");

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
