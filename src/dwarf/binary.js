"use strict";
const elfFormat = require("../elfFormat");
const zlib = require("zlib");
const { decompress: decompressZstd } = require("fzstd");
const MAX_DWARF_SECTION_BYTES = 128 * 1024 * 1024;
const REQUIRED_DWARF_SECTIONS = new Set([
    ".debug_info",
    ".debug_abbrev",
    ".debug_str",
    ".debug_line_str",
    ".debug_str_offsets"
]);
function readULEB(buf, cur) {
    let result = 0,
        shift = 0,
        byte;
    do {
        if (cur.p >= buf.length || shift >= 56) throw new Error("Truncated or oversized LEB128 value");
        byte = buf[cur.p++];
        result += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while (byte & 0x80);
    return result;
}
function readSLEB(buf, cur) {
    let result = 0,
        shift = 0,
        byte;
    do {
        if (cur.p >= buf.length || shift >= 56) throw new Error("Truncated or oversized LEB128 value");
        byte = buf[cur.p++];
        result += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while (byte & 0x80);
    if (shift < 64 && byte & 0x40) result -= Math.pow(2, shift);
    return result;
}
function cstr(buf, off) {
    if (off < 0 || off >= buf.length) return "";
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString("utf8", off, end);
}
function readAddr(buf, cur, size) {
    const s = size || 4;
    // 本解析器的 ELF 格式层只允许 ELF32；显式拒绝其他 DWARF 地址宽度，
    // 防止未来放开 ELF64 头校验后静默截断 64 位地址。
    if (s !== 4) throw new Error(`ELF32 DWARF address size must be 4, got ${s}`);
    const v = buf.readUIntLE(cur.p, s);
    cur.p += s;
    return v;
}
function debugSectionData(buf, entry, name) {
    if (entry.offset > buf.length || entry.size > buf.length - entry.offset)
        throw new Error(`DWARF section is outside the ELF: ${name}`);
    let data = buf.subarray(entry.offset, entry.offset + entry.size);
    // ELF gABI SHF_COMPRESSED, ELF32_Chdr = type/u32 size/u32 align/u32.
    if ((entry.flags & 0x800) !== 0) {
        if (data.length < 12) throw new Error(`Compressed DWARF section header is truncated: ${name}`);
        const compressionType = data.readUInt32LE(0);
        const expectedSize = data.readUInt32LE(4);
        if (expectedSize > MAX_DWARF_SECTION_BYTES) throw new Error(`Compressed DWARF section is too large: ${name}`);
        if (compressionType === 1) {
            data = zlib.inflateSync(data.subarray(12), { maxOutputLength: MAX_DWARF_SECTION_BYTES });
        } else if (compressionType === 2) {
            // ELFCOMPRESS_ZSTD。传入按 ELF ch_size 预分配的输出缓冲区，既支持
            // Node.js 20，也避免解压器根据恶意 frame 自行申请超出上限的内存。
            data = Buffer.from(decompressZstd(data.subarray(12), new Uint8Array(expectedSize)));
        } else {
            throw new Error(`Unsupported DWARF compression type ${compressionType}: ${name}`);
        }
        if (data.length !== expectedSize) throw new Error(`Compressed DWARF section size mismatch: ${name}`);
    } else if (name.startsWith(".zdebug_") && data.subarray(0, 4).toString("ascii") === "ZLIB") {
        // Legacy GNU .zdebug_* format: "ZLIB" + 8-byte big-endian size + zlib stream.
        if (data.length < 12) throw new Error(`Legacy compressed DWARF section is truncated: ${name}`);
        const expectedSize = Number(data.readBigUInt64BE(4));
        if (!Number.isSafeInteger(expectedSize) || expectedSize > MAX_DWARF_SECTION_BYTES)
            throw new Error(`Compressed DWARF section is too large: ${name}`);
        data = zlib.inflateSync(data.subarray(12), { maxOutputLength: MAX_DWARF_SECTION_BYTES });
        if (data.length !== expectedSize) throw new Error(`Legacy compressed DWARF section size mismatch: ${name}`);
    }
    return data;
}
function readSections(buf, diagnostics = []) {
    const map = new Map();
    let header, entries;
    try {
        header = elfFormat.readElf32Header(buf);
        entries = elfFormat.readSectionEntries(buf, header);
    } catch (e) {
        diagnostics.push({ code: "DWARF_INVALID_ELF", stage: "sections", message: e.message });
        return map;
    }
    const names = elfFormat.readSectionNames(buf, entries, header.shstrndx);
    for (let i = 0; i < entries.length; i++) {
        const originalName = names[i];
        if (!originalName) continue;
        if (!originalName.startsWith(".debug_") && !originalName.startsWith(".zdebug_")) continue;
        const name = originalName.startsWith(".zdebug_") ? `.debug_${originalName.slice(8)}` : originalName;
        if (!REQUIRED_DWARF_SECTIONS.has(name)) continue;
        try {
            const data = debugSectionData(buf, entries[i], originalName);
            map.set(name, { data, size: data.length });
        } catch (error) {
            diagnostics.push({
                code: /unsupported/i.test(error.message) ? "DWARF_UNSUPPORTED" : "DWARF_SECTION_INVALID",
                stage: "sections",
                section: originalName,
                message: error.message
            });
            // 单个调试节损坏或使用当前运行时不支持的压缩算法时，
            // 保留其余健康节；主入口会在必需节缺失时安全降级。
        }
    }
    return map;
}
function parseAbbrev(buf, start) {
    const map = new Map();
    const cur = { p: start };
    let guard = 0;
    const MAX_ABBREVIATIONS = 100000;
    while (cur.p < buf.length) {
        if (guard++ >= MAX_ABBREVIATIONS)
            throw Object.assign(new Error("DWARF abbreviation budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
        const code = readULEB(buf, cur);
        if (code === 0) break;
        const tag = readULEB(buf, cur);
        const hasChildren = buf[cur.p] !== 0;
        cur.p += 1; // has_children
        const attrs = [];
        while (true) {
            const at = readULEB(buf, cur);
            const form = readULEB(buf, cur);
            let implicit;
            if (form === 0x21) implicit = readSLEB(buf, cur); // DW_FORM_implicit_const
            if (at === 0 && form === 0) break;
            attrs.push({ at, form, implicit });
        }
        map.set(code, { tag, hasChildren, attrs });
    }
    return map;
}
module.exports = { readULEB, readSLEB, cstr, readAddr, debugSectionData, readSections, parseAbbrev };
