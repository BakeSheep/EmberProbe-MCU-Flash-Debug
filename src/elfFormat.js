"use strict";
// ELF32 (little-endian, Cortex-M) format layer shared by elfSymbols and dwarf: header validation and section header and
// name reading.

// Validates and reads an ELF32 LE header; invalid files throw
function readElf32Header(buf) {
    if (buf.length < 52) throw new Error("文件过小，不是有效的 ELF");
    if (!(buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)) {
        throw new Error("不是有效的 ELF 文件（魔数不匹配）");
    }
    if (buf[4] !== 1) throw new Error("仅支持 32 位 ELF（Cortex-M）");
    if (buf[5] !== 1) throw new Error("仅支持小端 ELF（Cortex-M）");
    return {
        machine: buf.readUInt16LE(18),
        phoff: buf.readUInt32LE(28),
        shoff: buf.readUInt32LE(32),
        phentsize: buf.readUInt16LE(42) || 32,
        shentsize: buf.readUInt16LE(46) || 40,
        phnum: buf.readUInt16LE(44),
        shnum: buf.readUInt16LE(48),
        shstrndx: buf.readUInt16LE(50)
    };
}

// Reads every section header entry (names need shstrtab and are resolved on demand by readSectionNames)
function readSectionEntries(buf, header) {
    const { shoff, shentsize, shnum } = header;
    if (!shoff || !shnum) throw new Error("缺少节头表，可能已被 strip（请用 Debug 构建）");
    if (shentsize < 40 || shoff + shnum * shentsize > buf.length) {
        throw new Error("ELF 节头表越界或条目大小无效");
    }
    const entries = [];
    for (let i = 0; i < shnum; i++) {
        const off = shoff + i * shentsize;
        if (off + 40 > buf.length) break;
        entries.push({
            nameOffset: buf.readUInt32LE(off + 0),
            type: buf.readUInt32LE(off + 4),
            flags: buf.readUInt32LE(off + 8),
            addr: buf.readUInt32LE(off + 12) >>> 0,
            offset: buf.readUInt32LE(off + 16),
            size: buf.readUInt32LE(off + 20),
            link: buf.readUInt32LE(off + 24),
            entsize: buf.readUInt32LE(off + 36)
        });
    }
    return entries;
}

// Resolves section names through shstrtab; a missing shstrtab or out-of-range offset yields '' so a bad name is not
// fatal
function readSectionNames(buf, entries, shstrndx) {
    const shstr = entries[shstrndx];
    const readName = (rel) => {
        if (!shstr || rel < 0) return "";
        const p = shstr.offset + rel;
        const limit = shstr.offset + shstr.size;
        if (p >= limit || limit > buf.length) return "";
        let end = p;
        while (end < limit && buf[end] !== 0) end++;
        return buf.toString("utf8", p, end);
    };
    return entries.map((entry) => readName(entry.nameOffset));
}

module.exports = {
    readSectionNames,
    readElf32Header,
    readSectionEntries
};
