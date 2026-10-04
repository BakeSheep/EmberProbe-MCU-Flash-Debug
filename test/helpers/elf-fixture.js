"use strict";
function minimalElf(payload = "firmware") {
    const header = Buffer.alloc(52);
    header.writeUInt32BE(0x7f454c46, 0);
    header[4] = header[5] = header[6] = 1;
    header.writeUInt16LE(0x28, 18);
    header.writeUInt32LE(1, 20);
    header.writeUInt16LE(52, 40);
    return Buffer.concat([header, Buffer.from(payload)]);
}

function align(value, boundary) {
    return (value + boundary - 1) & ~(boundary - 1);
}

function buildStringTable(strings) {
    const parts = [];
    const offsets = new Map();
    let length = 0;
    for (const value of ["", ...strings]) {
        if (offsets.has(value)) continue;
        offsets.set(value, length);
        const bytes = Buffer.from(value + "\0", "latin1");
        parts.push(bytes);
        length += bytes.length;
    }
    return { data: Buffer.concat(parts), offsets };
}

// Layout overrides preserve offsets, section ordering and padding in migrated fixtures.
// Symbol info accepts both global and local STT_OBJECT entries for static variables.
function buildElf32({ sections = [], symbols = [], programHeaders = [], machine = 0x28, layout = {} } = {}) {
    const userSections = sections.map((section) => ({
        name: section.name,
        type: section.type ?? 1,
        flags: section.flags ?? 0,
        addr: section.addr ?? 0,
        data: Buffer.from(section.data ?? Buffer.alloc(section.size ?? 0)),
        size: section.size,
        offset: section.offset,
        link: section.link ?? 0,
        info: section.info ?? 0,
        addralign: section.addralign ?? 0,
        entsize: section.entsize ?? 0
    }));
    const { data: strtab, offsets: stringOffsets } = buildStringTable(symbols.map((symbol) => symbol.name));
    let generated = [...userSections];
    if (symbols.length) {
        const symbolBytes = Buffer.alloc((symbols.length + 1) * 16);
        symbols.forEach((symbol, index) => {
            const offset = (index + 1) * 16;
            symbolBytes.writeUInt32LE(stringOffsets.get(symbol.name), offset);
            symbolBytes.writeUInt32LE(symbol.value >>> 0, offset + 4);
            symbolBytes.writeUInt32LE(symbol.size >>> 0, offset + 8);
            symbolBytes[offset + 12] = symbol.info ?? 0x11;
            symbolBytes.writeUInt16LE(symbol.section ?? 1, offset + 14);
        });
        generated.push({ name: ".strtab", type: 3, data: strtab });
        generated.push({ name: ".symtab", type: 2, data: symbolBytes, entsize: 16 });
    }
    const includeNames = layout.includeSectionNames !== false;
    if (includeNames) generated.push({ name: ".shstrtab", type: 3 });
    if (layout.sectionOrder) {
        generated = layout.sectionOrder.map((name) => {
            const section = generated.find((entry) => entry.name === name);
            if (!section) throw new Error("Unknown fixture section: " + name);
            return section;
        });
    }
    const { data: nameBytes, offsets: nameOffsets } = buildStringTable(generated.map((section) => section.name));
    if (includeNames) {
        generated.find((section) => section.name === ".shstrtab").data = nameBytes;
    }

    const headerSize = 52;
    const phoff = programHeaders.length ? (layout.programHeaderOffset ?? headerSize) : 0;
    const phentsize = 32;
    const dataAlignment = layout.dataAlignment ?? 4;
    let offset = layout.programHeaderOffset === undefined ? headerSize + programHeaders.length * phentsize : headerSize;
    const sectionEntries = [{ name: "", type: 0, data: Buffer.alloc(0), size: 0, addralign: 0 }];
    for (const section of generated) {
        const data = section.type === 8 ? Buffer.alloc(0) : section.data;
        const sectionOffset =
            layout.sectionOffsets?.[section.name] ?? section.offset ?? (section.type === 8 ? 0 : offset);
        if (section.type !== 8) offset = align(Math.max(offset, sectionOffset + data.length), dataAlignment);
        sectionEntries.push({ ...section, data, offset: sectionOffset, size: section.size ?? data.length });
    }
    const shoff = layout.sectionHeaderOffset ?? align(offset, layout.tableAlignment ?? 4);
    const shentsize = 40;
    const shnum = sectionEntries.length;
    const buffer = Buffer.alloc(shoff + shnum * shentsize);
    buffer.write("\x7fELF", 0, "binary");
    buffer[4] = 1;
    buffer[5] = 1;
    buffer[6] = 1;
    buffer.writeUInt16LE(layout.type ?? 2, 16);
    buffer.writeUInt16LE(machine, 18);
    buffer.writeUInt32LE(layout.version ?? 1, 20);
    buffer.writeUInt32LE(phoff, 28);
    buffer.writeUInt32LE(shoff, 32);
    buffer.writeUInt16LE(52, 40);
    buffer.writeUInt16LE(programHeaders.length ? phentsize : 0, 42);
    buffer.writeUInt16LE(programHeaders.length, 44);
    buffer.writeUInt16LE(shentsize, 46);
    buffer.writeUInt16LE(shnum, 48);
    buffer.writeUInt16LE(includeNames ? sectionEntries.findIndex((section) => section.name === ".shstrtab") : 0, 50);

    for (const section of sectionEntries) {
        if (section.data.length) section.data.copy(buffer, section.offset);
    }
    programHeaders.forEach((header, index) => {
        const base = phoff + index * phentsize;
        buffer.writeUInt32LE(header.type ?? 1, base);
        buffer.writeUInt32LE(header.offset ?? 0, base + 4);
        buffer.writeUInt32LE(header.vaddr ?? 0, base + 8);
        buffer.writeUInt32LE(header.paddr ?? header.vaddr ?? 0, base + 12);
        buffer.writeUInt32LE(header.filesz ?? 0, base + 16);
        buffer.writeUInt32LE(header.memsz ?? header.filesz ?? 0, base + 20);
        buffer.writeUInt32LE(header.flags ?? 0, base + 24);
        buffer.writeUInt32LE(header.align ?? 0, base + 28);
    });
    sectionEntries.forEach((section, index) => {
        const base = shoff + index * shentsize;
        buffer.writeUInt32LE(includeNames ? (nameOffsets.get(section.name) ?? 0) : 0, base);
        buffer.writeUInt32LE(section.type ?? 0, base + 4);
        buffer.writeUInt32LE(section.flags ?? 0, base + 8);
        buffer.writeUInt32LE(section.addr ?? 0, base + 12);
        buffer.writeUInt32LE(section.offset ?? 0, base + 16);
        buffer.writeUInt32LE(section.size ?? 0, base + 20);
        const link =
            section.name === ".symtab"
                ? sectionEntries.findIndex((entry) => entry.name === ".strtab")
                : (section.link ?? 0);
        buffer.writeUInt32LE(link, base + 24);
        buffer.writeUInt32LE(section.info ?? 0, base + 28);
        buffer.writeUInt32LE(section.addralign ?? 0, base + 32);
        buffer.writeUInt32LE(section.entsize ?? 0, base + 36);
    });
    return buffer;
}

function buildElf64(payload = "fixture") {
    const header = Buffer.alloc(64);
    header.write("\x7fELF", 0, "binary");
    header[4] = 2;
    header[5] = 1;
    header[6] = 1;
    header.writeUInt16LE(2, 16);
    header.writeUInt16LE(0x3e, 18);
    header.writeUInt32LE(1, 20);
    header.writeUInt16LE(64, 52);
    return Buffer.concat([header, Buffer.from(payload)]);
}

function buildDebugSections({ info = Buffer.alloc(0), abbrev = Buffer.alloc(0), compress = false } = {}) {
    const zlib = require("zlib");
    const encode = (data) => {
        if (!compress) return Buffer.from(data);
        const payload = zlib.deflateSync(data);
        const header = Buffer.alloc(12);
        header.writeUInt32LE(1, 0);
        header.writeUInt32LE(data.length, 4);
        header.writeUInt32LE(1, 8);
        return Buffer.concat([header, payload]);
    };
    return [
        { name: ".debug_info", type: 1, flags: compress ? 0x800 : 0, data: encode(info) },
        { name: ".debug_abbrev", type: 1, flags: compress ? 0x800 : 0, data: encode(abbrev) }
    ];
}

function buildDwarfElf(info, abbrev, options = {}) {
    return buildElf32({
        sections: buildDebugSections({ info, abbrev, compress: options.compress }),
        layout: { dataAlignment: 1, ...options.layout },
        machine: options.machine ?? 0x28
    });
}

module.exports = { buildDebugSections, buildDwarfElf, buildElf32, buildElf64, buildStringTable, minimalElf };
