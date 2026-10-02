"use strict";

const { parseElfSections } = require("../../src/elfSymbols");

function buildMemoryElf(specs) {
    const names = Buffer.from("\0.shstrtab\0.strtab\0.symtab\0" + specs.map((s) => s.name + "\0").join(""));
    const loads = specs.filter((s) => s.type !== 8 && s.size);
    const namesOffset = 52 + loads.length * 32;
    const strtabOffset = namesOffset + names.length;
    const symtabOffset = (strtabOffset + 4) & ~3;
    let offset = symtabOffset + 16;
    const entries = specs.map((s) => {
        const entry = { ...s, offset };
        if (s.type !== 8) offset += s.size;
        return entry;
    });
    const shoff = (offset + 3) & ~3;
    const buf = Buffer.alloc(shoff + (specs.length + 4) * 40);
    buf.writeUInt32BE(0x7f454c46, 0);
    buf[4] = buf[5] = buf[6] = 1;
    buf.writeUInt16LE(2, 16);
    buf.writeUInt16LE(0x28, 18);
    buf.writeUInt32LE(1, 20);
    buf.writeUInt32LE(loads.length ? 52 : 0, 28);
    buf.writeUInt32LE(shoff, 32);
    buf.writeUInt16LE(52, 40);
    buf.writeUInt16LE(32, 42);
    buf.writeUInt16LE(loads.length, 44);
    buf.writeUInt16LE(40, 46);
    buf.writeUInt16LE(specs.length + 4, 48);
    buf.writeUInt16LE(1, 50);
    names.copy(buf, namesOffset);
    const sh = (index, name, type, flags, addr, fileOffset, size) => {
        [name, type, flags, addr, fileOffset, size].forEach((v, i) => buf.writeUInt32LE(v, shoff + index * 40 + i * 4));
        buf.writeUInt32LE(1, shoff + index * 40 + 32);
    };
    sh(1, 1, 3, 0, 0, namesOffset, names.length);
    sh(2, 11, 3, 0, 0, strtabOffset, 1);
    sh(3, 19, 2, 0, 0, symtabOffset, 16);
    buf.writeUInt32LE(2, shoff + 3 * 40 + 24);
    buf.writeUInt32LE(16, shoff + 3 * 40 + 36);
    let name = 27,
        ph = 0;
    entries.forEach((s, i) => {
        sh(i + 4, name, s.type, s.flags, s.addr, s.offset, s.size);
        name += Buffer.byteLength(s.name) + 1;
        if (s.type !== 8 && s.size) {
            [1, s.offset, s.addr, s.lma ?? s.addr, s.size, s.size, 7, 1].forEach((v, j) =>
                buf.writeUInt32LE(v, 52 + ph * 32 + j * 4)
            );
            ph++;
        }
    });
    return buf;
}

function snapshot(buffer, file = "firmware.elf") {
    return {
        elf: { path: file, sha256: require("crypto").createHash("sha256").update(buffer).digest("hex") },
        memory: parseElfSections(buffer),
        functions: [],
        symbols: [],
        warnings: []
    };
}

function memoryMap(regions, sections) {
    return (
        "Memory Configuration\n\nName Origin Length Attributes\n" +
        regions.map((r) => `${r.name} 0x${r.origin.toString(16)} 0x${r.capacity.toString(16)} xr\n`).join("") +
        "*default* 0x00000000 0xffffffff\n\nLinker script and memory map\n\n" +
        sections
            .filter((s) => s.flags & 2)
            .map((s) => `${s.name} 0x${s.addr.toString(16)} 0x${s.size.toString(16)}\n`)
            .join("")
    );
}

const h750Regions = [
    { name: "DTCMRAM", origin: 0x20000000, capacity: 128 * 1024 },
    { name: "RAM", origin: 0x24000000, capacity: 512 * 1024 },
    { name: "RAM_D2", origin: 0x30000000, capacity: 288 * 1024 },
    { name: "RAM_D3", origin: 0x38000000, capacity: 64 * 1024 },
    { name: "ITCMRAM", origin: 0, capacity: 64 * 1024 },
    { name: "FLASH", origin: 0x08000000, capacity: 128 * 1024 }
];
const f407Regions = [
    { name: "RAM", origin: 0x20000000, capacity: 128 * 1024 },
    { name: "CCMRAM", origin: 0x10000000, capacity: 64 * 1024 },
    { name: "FLASH", origin: 0x08000000, capacity: 1024 * 1024 }
];

module.exports = { buildMemoryElf, snapshot, memoryMap, h750Regions, f407Regions };
