"use strict";
const assert = require("assert");
const { parseElfSymbols, decodeValue, typeByteLength } = require("../src/elfSymbols");
const { parseMemoryValues } = require("../src/liveWatch");
const { encodingToWatchType, readULEB, readSLEB, parseDwarfVariableTypes } = require("../src/dwarf");
const liveSkill = require("../skills/mcu-live-watch/scripts/read-live");

// 程序化构造最小 ELF32（小端，ARM），含 1 个 STT_OBJECT 符号 myGlobal
function buildElf() {
    const strtab = Buffer.from("\0myGlobal\0", "latin1"); // myGlobal 的 st_name = 1
    const strtabOff = 52;
    const strtabSize = strtab.length; // 10
    let symtabOff = strtabOff + strtabSize;
    symtabOff = (symtabOff + 3) & ~3; // 4 字节对齐 → 64
    const symCount = 2;               // 索引 0 为空符号
    const symtabSize = symCount * 16;
    const shoff = symtabOff + symtabSize;
    const shnum = 3;                  // null / .strtab / .symtab
    const buf = Buffer.alloc(shoff + shnum * 40);

    // ELF 头
    buf[0] = 0x7f; buf[1] = 0x45; buf[2] = 0x4c; buf[3] = 0x46; // 魔数
    buf[4] = 1; buf[5] = 1; buf[6] = 1;                          // 32 位 / 小端 / 版本
    buf.writeUInt16LE(2, 16);      // e_type ET_EXEC
    buf.writeUInt16LE(0x28, 18);   // e_machine ARM
    buf.writeUInt32LE(1, 20);      // e_version
    buf.writeUInt32LE(shoff, 32);  // e_shoff
    buf.writeUInt16LE(52, 40);     // e_ehsize
    buf.writeUInt16LE(40, 46);     // e_shentsize
    buf.writeUInt16LE(shnum, 48);  // e_shnum
    buf.writeUInt16LE(0, 50);      // e_shstrndx（本解析器不使用）

    // .strtab 内容
    strtab.copy(buf, strtabOff);

    // .symtab：索引 1 = myGlobal
    const s1 = symtabOff + 16;
    buf.writeUInt32LE(1, s1 + 0);            // st_name
    buf.writeUInt32LE(0x20000010, s1 + 4);   // st_value（地址）
    buf.writeUInt32LE(4, s1 + 8);            // st_size
    buf[s1 + 12] = 0x11;                     // st_info: STB_GLOBAL<<4 | STT_OBJECT
    buf[s1 + 13] = 0;                        // st_other
    buf.writeUInt16LE(1, s1 + 14);           // st_shndx（非零）

    // 节头表
    const sh = (i) => shoff + i * 40;
    // 索引 0：空节（全 0）
    // 索引 1：.strtab（type=3 STRTAB）
    buf.writeUInt32LE(3, sh(1) + 4);
    buf.writeUInt32LE(strtabOff, sh(1) + 16);
    buf.writeUInt32LE(strtabSize, sh(1) + 20);
    // 索引 2：.symtab（type=2 SYMTAB，link 指向 strtab 索引 1，entsize=16）
    buf.writeUInt32LE(2, sh(2) + 4);
    buf.writeUInt32LE(symtabOff, sh(2) + 16);
    buf.writeUInt32LE(symtabSize, sh(2) + 20);
    buf.writeUInt32LE(1, sh(2) + 24);
    buf.writeUInt32LE(16, sh(2) + 36);
    return buf;
}

const { symbols } = parseElfSymbols(buildElf());
assert.strictEqual(symbols.length, 1, "应解析出 1 个变量");
assert.strictEqual(symbols[0].name, "myGlobal");
assert.strictEqual(symbols[0].address, 0x20000010);
assert.strictEqual(symbols[0].size, 4);
assert.deepStrictEqual(liveSkill.parseSymbolsBuffer(buildElf()), [{ name: "myGlobal", address: 0x20000010, size: 4 }]);
assert.strictEqual(liveSkill.infer(8), "", "large aggregate-like symbols must not be guessed as u32");

// decodeValue：各类型小端解码
assert.strictEqual(decodeValue([0xff], "u8"), 255);
assert.strictEqual(decodeValue([0xff], "i8"), -1);
assert.strictEqual(decodeValue([0x34, 0x12], "u16"), 0x1234);
assert.strictEqual(decodeValue([0x00, 0x00, 0xdc, 0x42], "f32"), 110); // 0x42DC0000 = 110.0f
assert.strictEqual(decodeValue([0xff, 0xff, 0xff, 0xff], "i32"), -1);
assert.strictEqual(decodeValue([0x78, 0x56, 0x34, 0x12], "u32"), 0x12345678);
assert.strictEqual(decodeValue([0x01], "u32"), null, "字节不足应返回 null");
assert.strictEqual(typeByteLength("f32"), 4);

// parseMemoryValues：十进制、0x 前缀、含地址标签
assert.deepStrictEqual(parseMemoryValues("10 255 32 0"), [10, 255, 32, 0]);
assert.deepStrictEqual(parseMemoryValues("0x0a 0xff 0x20 0x00"), [10, 255, 32, 0]);
assert.deepStrictEqual(parseMemoryValues("0x20000000: 0x78 0x56"), [0x78, 0x56]);
assert.deepStrictEqual(parseMemoryValues(""), []);

// DWARF：基础类型编码 → 观察类型
assert.strictEqual(encodingToWatchType(0x04, 4), "f32"); // float
assert.strictEqual(encodingToWatchType(0x04, 8), "");    // double 不支持
assert.strictEqual(encodingToWatchType(0x05, 2), "i16"); // signed
assert.strictEqual(encodingToWatchType(0x07, 4), "u32"); // unsigned
assert.strictEqual(encodingToWatchType(0x08, 1), "u8");  // unsigned char
// DWARF：LEB128 解码
let leb = { p: 0 };
assert.strictEqual(readULEB(Buffer.from([0xe5, 0x8e, 0x26]), leb), 624485);
leb = { p: 0 };
assert.strictEqual(readSLEB(Buffer.from([0x9b, 0xf1, 0x59]), leb), -624485);
// DWARF：无调试段时优雅降级为空表
assert.strictEqual(parseDwarfVariableTypes(buildElf()).size, 0);

console.log("ELF symbols & liveWatch parser tests passed");
