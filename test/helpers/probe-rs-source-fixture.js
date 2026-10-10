"use strict";

const path = require("node:path");
const { buildElf32 } = require("./elf-fixture");

const u16 = (value) => {
    const result = Buffer.alloc(2);
    result.writeUInt16LE(value);
    return result;
};
const u32 = (value) => {
    const result = Buffer.alloc(4);
    result.writeUInt32LE(value);
    return result;
};
const string = (value) => Buffer.from(value + "\0");
const bytes = (...values) => Buffer.from(values);

// GCC C++14 language, DWARF 3 rows and no prologue_end marker.
function buildSourceElf(source, options = {}) {
    const directory = /^[a-z]:/i.test(source) ? path.win32.dirname(source) : path.dirname(source);
    const name = /^[a-z]:/i.test(source) ? path.win32.basename(source) : path.basename(source);
    const cu = Buffer.concat([bytes(1), string(source), string(directory), u32(0), u16(33)]);
    const typeOffset = 11 + cu.length;
    const content = Buffer.concat([
        u16(4),
        u32(0),
        bytes(4),
        cu,
        bytes(2),
        string("unsigned int"),
        bytes(7, 4),
        bytes(3),
        string("GAIN"),
        u32(typeOffset),
        bytes(5, 3),
        u32(0x20000000),
        bytes(3),
        string("TUNE"),
        u32(typeOffset),
        bytes(5, 3),
        u32(0x20000004),
        bytes(0)
    ]);
    const abbrev = bytes(
        1,
        0x11,
        1,
        3,
        8,
        0x1b,
        8,
        0x10,
        0x17,
        0x13,
        5,
        0,
        0,
        2,
        0x24,
        0,
        3,
        8,
        0x3e,
        0x0b,
        0x0b,
        0x0b,
        0,
        0,
        3,
        0x34,
        0,
        3,
        8,
        0x49,
        0x13,
        2,
        0x0a,
        0,
        0,
        0
    );
    const version = options.version || 3;
    const v5Paths = Buffer.concat([
        bytes(1, 1, 8, 1),
        string(directory),
        bytes(2, 1, 8, 2, 0x0f, 2),
        string(name),
        bytes(0),
        string(name),
        bytes(0)
    ]);
    const legacyPaths = Buffer.concat([string(directory), bytes(0), string(name), bytes(1, 0, 0, 0)]);
    const lineHeader = Buffer.concat([
        bytes(2),
        version >= 4 ? bytes(1) : bytes(),
        bytes(1, 251, 14, 13, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1),
        version === 5 ? v5Paths : legacyPaths
    ]);
    const program =
        options.program ||
        Buffer.concat([
            bytes(0, 5, 2),
            u32(0x08000100),
            bytes(3, 1, 5, 9, 1),
            bytes(2, 2, 3, 1, 1),
            bytes(2, 2, 3, 1, 6, 1),
            bytes(0, 1, 1)
        ]);
    const lineContent = Buffer.concat([
        u16(version),
        version === 5 ? bytes(4, 0) : bytes(),
        u32(lineHeader.length),
        lineHeader,
        program
    ]);
    return buildElf32({
        sections: [
            { name: ".text", type: 1, flags: 6, addr: 0x08000100, data: Buffer.alloc(32) },
            { name: ".data", type: 1, flags: 3, addr: 0x20000000, data: Buffer.alloc(8) },
            { name: ".debug_info", type: 1, data: Buffer.concat([u32(content.length), content]) },
            { name: ".debug_abbrev", type: 1, data: abbrev },
            { name: ".debug_line", type: 1, data: Buffer.concat([u32(lineContent.length), lineContent]) }
        ],
        symbols: [
            { name: "GAIN", value: 0x20000000, size: 4, section: 2 },
            { name: "TUNE", value: 0x20000004, size: 4, section: 2 }
        ]
    });
}

module.exports = { buildSourceElf };
