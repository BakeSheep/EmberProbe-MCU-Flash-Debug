"use strict";
const assert = require("assert");
const { cleanWindowsPath, clampInteger, normalizeWatchList } = require("../src/validation");

assert.strictEqual(cleanWindowsPath("/C:\\work\\app.elf"), "C:/work/app.elf");
assert.strictEqual(cleanWindowsPath("\\\\server\\share\\app.elf"), "//server/share/app.elf");
assert.strictEqual(clampInteger(Infinity, 100, 20, 10000), 100);
assert.strictEqual(clampInteger(12.8, 100, 20, 10000), 20);
assert.strictEqual(clampInteger(70000, 6666, 1, 65535), 65535);

const symbols = [
    { name: "counter", address: 0x20000020, size: 4, watchType: "u32", isComposite: false },
    {
        name: "state",
        address: 0x20000030,
        size: 8,
        watchType: "",
        isComposite: true,
        compositeLayout: { kind: "struct", typeName: "struct State", byteSize: 8, members: [] }
    }
];
// Scalars are checked against their type width and deduplicated; composites (structs/arrays) keep their layout and skip
// scalar type checks.
assert.deepStrictEqual(
    normalizeWatchList(
        [
            { name: "counter", address: 0xdeadbeef, size: 1, type: "i32" },
            { name: "counter", address: 1, type: "u8" },
            { name: "state", address: 2, type: "u32" },
            { name: "missing", address: 3, type: "u32" }
        ],
        symbols
    ),
    [
        { name: "counter", address: 0x20000020, size: 4, type: "i32" },
        {
            name: "state",
            address: 0x20000030,
            size: 8,
            type: "",
            isComposite: true,
            compositeLayout: { kind: "struct", typeName: "struct State", byteSize: 8, members: [] }
        }
    ]
);
assert.deepStrictEqual(
    normalizeWatchList(
        [{ name: "tiny", address: 1, size: 1, type: "u32" }],
        [{ name: "tiny", address: 0x20000040, size: 1, watchType: "u8", isComposite: false }]
    ),
    [],
    "a selected type must not read beyond the symbol"
);

// A composite member path (sensor.y) resolves to a scalar leaf at base address + member offset
const compositeSymbols = [
    {
        name: "sensor",
        address: 0x20000100,
        size: 12,
        watchType: "",
        isComposite: true,
        compositeLayout: {
            kind: "struct",
            typeName: "struct Sensor",
            byteSize: 12,
            members: [
                { name: "x", offset: 0, byteSize: 4, watchType: "i32", typeName: "int" },
                { name: "y", offset: 4, byteSize: 4, watchType: "f32", typeName: "float" }
            ]
        }
    }
];
assert.deepStrictEqual(
    normalizeWatchList([{ name: "sensor.y" }], compositeSymbols),
    [{ name: "sensor.y", address: 0x20000104, size: 4, type: "f32" }],
    "struct member path resolves to a scalar leaf"
);
assert.deepStrictEqual(
    normalizeWatchList([{ name: "sensor.missing" }], compositeSymbols),
    [],
    "unknown member path is dropped"
);

const arraySymbols = [
    {
        name: "buf",
        address: 0x20000200,
        size: 16,
        watchType: "",
        isComposite: true,
        compositeLayout: {
            kind: "array",
            typeName: "unsigned int[]",
            byteSize: 16,
            elementType: { typeName: "unsigned int", watchType: "u32", byteSize: 4, kind: "scalar" },
            dimensions: [4],
            totalElements: 4
        }
    }
];
assert.deepStrictEqual(
    normalizeWatchList([{ name: "buf[4]" }], arraySymbols),
    [],
    "out-of-range array index is dropped"
);
assert.deepStrictEqual(
    normalizeWatchList([{ name: "buf[1:5]" }], arraySymbols),
    [],
    "out-of-range array slice is dropped"
);

console.log("Validation tests passed");
