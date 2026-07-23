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
    { name: "state", address: 0x20000030, size: 8, watchType: "", isComposite: true }
];
assert.deepStrictEqual(
    normalizeWatchList([
        { name: "counter", address: 0xDEADBEEF, size: 1, type: "i32" },
        { name: "counter", address: 1, type: "u8" },
        { name: "state", address: 2, type: "u32" },
        { name: "missing", address: 3, type: "u32" }
    ], symbols),
    [{ name: "counter", address: 0x20000020, size: 4, type: "i32" }]
);
assert.deepStrictEqual(
    normalizeWatchList([{ name: "tiny", address: 1, size: 1, type: "u32" }], [
        { name: "tiny", address: 0x20000040, size: 1, watchType: "u8", isComposite: false }
    ]),
    [],
    "a selected type must not read beyond the symbol"
);

console.log("Validation tests passed");
