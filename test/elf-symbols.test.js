"use strict";
const assert = require("assert");
const {
    parseElfSymbols,
    decodeValue,
    decodeValueText,
    encodeValue,
    typeByteLength,
    resolveVariableRequests
} = require("../src/elfSymbols");
const { parseMemoryValues } = require("../src/liveWatch");
const { encodingToWatchType, readULEB, readSLEB, parseDwarfVariableTypes } = require("../src/dwarf");
const liveSkill = require("../skills/mcu-variables/scripts/read");
const { buildElf32 } = require("./helpers/elf-fixture");

// 程序化构造最小 ELF32（小端，ARM），含 1 个 STT_OBJECT 符号 myGlobal。
function buildElf() {
    return buildElf32({
        symbols: [{ name: "myGlobal", value: 0x20000010, size: 4, info: 0x11, section: 1 }],
        layout: { includeSectionNames: false }
    });
}

const { symbols } = parseElfSymbols(buildElf());
assert.strictEqual(symbols.length, 1, "应解析出 1 个变量");
assert.strictEqual(symbols[0].name, "myGlobal");
assert.strictEqual(symbols[0].address, 0x20000010);
assert.strictEqual(symbols[0].size, 4);
assert.deepStrictEqual(liveSkill.parseSymbolsBuffer(buildElf()), [{ name: "myGlobal", address: 0x20000010, size: 4 }]);
assert.strictEqual(liveSkill.infer(8), "u64", "8-byte symbols should default to u64");

// decodeValue：各类型小端解码
assert.strictEqual(decodeValue([0xff], "u8"), 255);
assert.strictEqual(decodeValue([0xff], "i8"), -1);
assert.strictEqual(decodeValue([0x34, 0x12], "u16"), 0x1234);
assert.strictEqual(decodeValue([0x00, 0x00, 0xdc, 0x42], "f32"), 110); // 0x42DC0000 = 110.0f
assert.strictEqual(decodeValue([0xff, 0xff, 0xff, 0xff], "i32"), -1);
assert.strictEqual(decodeValue([0x78, 0x56, 0x34, 0x12], "u32"), 0x12345678);
assert.strictEqual(decodeValue([0x01], "u32"), null, "字节不足应返回 null");
assert.strictEqual(typeByteLength("f32"), 4);
assert.strictEqual(typeByteLength("u64"), 8);
assert.strictEqual(decodeValueText(encodeValue("18446744073709551615", "u64"), "u64"), "18446744073709551615");
assert.strictEqual(decodeValue(encodeValue("-9223372036854775808", "i64"), "i64"), Number(-9223372036854775808n));
assert.strictEqual(decodeValueText(encodeValue("-9223372036854775808", "i64"), "i64"), "-9223372036854775808");
assert.strictEqual(decodeValue(encodeValue(1.25, "f64"), "f64"), 1.25);
assert.strictEqual(decodeValueText(encodeValue("nan", "f64"), "f64"), "NaN");
assert.strictEqual(
    liveSkill.decodeText([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], "u64"),
    "18446744073709551615"
);
const resolvedRequests = resolveVariableRequests(
    [
        { name: "Tick", address: 0x20000000, size: 4, watchType: "u32", isComposite: false },
        { name: "sinx", address: 0x20000004, size: 4, watchType: "f32", isComposite: false }
    ],
    [{ name: "tick" }, { name: "sinx" }]
);
assert.deepStrictEqual(
    resolvedRequests.map((item) => [item.requestedName, item.name, item.type]),
    [
        ["tick", "Tick", "u32"],
        ["sinx", "sinx", "f32"]
    ]
);
assert.throws(() => resolveVariableRequests([], [{ name: "missing" }]), /not found/);

// 同一段原始字节按不同观察类型解码：图表与侧栏对同名变量选不同 type 时各自得到正确值
const shared = [0x34, 0x12, 0x00, 0x00];
assert.strictEqual(decodeValue(shared, "u16"), 0x1234); // 低 2 字节
assert.strictEqual(decodeValue(shared, "u32"), 0x00001234);
assert.strictEqual(decodeValue(shared, "i8"), 0x34); // 最低字节，正数

// parseMemoryValues：十进制、0x 前缀、含地址标签
assert.deepStrictEqual(parseMemoryValues("10 255 32 0"), [10, 255, 32, 0]);
assert.deepStrictEqual(parseMemoryValues("0x0a 0xff 0x20 0x00"), [10, 255, 32, 0]);
assert.deepStrictEqual(parseMemoryValues("0x20000000: 0x78 0x56"), [0x78, 0x56]);
assert.deepStrictEqual(parseMemoryValues(""), []);
assert.deepStrictEqual(parseMemoryValues("-1 256 0xff 12"), [255, 12], "memory bytes must stay in the u8 range");
assert.deepStrictEqual(liveSkill.memoryValues("-1 256 0xff 12"), [255, 12]);
assert.throws(() => liveSkill.args(["--port", "--list"]), /Missing value/);
assert.throws(() => liveSkill.boundedInteger("Infinity", 1, 1, 10, "--count"), /must be an integer/);

const malformedElf = buildElf();
malformedElf.writeUInt32LE(malformedElf.length - 4, 32);
assert.throws(() => parseElfSymbols(malformedElf), /节头表越界/);
assert.throws(() => liveSkill.parseSymbolsBuffer(malformedElf), /section table is out of bounds/);

// DWARF：基础类型编码 → 观察类型
assert.strictEqual(encodingToWatchType(0x04, 4), "f32"); // float
assert.strictEqual(encodingToWatchType(0x04, 8), "f64"); // double
assert.strictEqual(encodingToWatchType(0x05, 8), "i64");
assert.strictEqual(encodingToWatchType(0x07, 8), "u64");
assert.strictEqual(encodingToWatchType(0x05, 2), "i16"); // signed
assert.strictEqual(encodingToWatchType(0x07, 4), "u32"); // unsigned
assert.strictEqual(encodingToWatchType(0x08, 1), "u8"); // unsigned char
// DWARF：LEB128 解码
let leb = { p: 0 };
assert.strictEqual(readULEB(Buffer.from([0xe5, 0x8e, 0x26]), leb), 624485);
leb.p = 0;
assert.strictEqual(readULEB(Buffer.from([...Array(8).fill(0x80), 0x01]), leb), 2 ** 56);
leb = { p: 0 };
assert.strictEqual(readSLEB(Buffer.from([0x9b, 0xf1, 0x59]), leb), -624485);
leb.p = 0;
assert.strictEqual(readSLEB(Buffer.from([...Array(9).fill(0x80), 0x7f]), leb), -(2 ** 63));
// DWARF：无调试段时优雅降级为空表
assert.strictEqual(parseDwarfVariableTypes(buildElf()).size, 0);

console.log("ELF symbols & liveWatch parser tests passed");
