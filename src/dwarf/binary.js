"use strict";
const elfFormat = require("../elfFormat");
const zlib = require("zlib");
const { Decompress: ZstdDecompress } = require("fzstd");
const MAX_ATTRS_PER_ABBREV = 1000;
const MAX_DWARF_SECTION_BYTES = 32 * 1024 * 1024;
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
// 解析一个 zstd 帧头；contentSize 为 null 表示帧未声明输出大小。
// 仅用于解码前拒绝声明超大窗口 / 内容大小的帧，避免 fzstd 按帧头预分配巨量内存。
function zstdFrameHeader(dat) {
    // Zstandard magic 0xFD2FB528，小端字节序为 28 B5 2F FD。
    if (dat.length < 6 || dat[0] !== 0x28 || dat[1] !== 0xb5 || dat[2] !== 0x2f || dat[3] !== 0xfd) return null;
    const flags = dat[4];
    if (flags & 0x08) return null; // 保留位必须为 0，否则帧非法。
    const singleSegment = (flags >> 5) & 1;
    const contentSizeFlag = flags >> 6;
    const dictFlag = flags & 3;
    let pos = singleSegment ? 5 : 6;
    pos += dictFlag === 3 ? 4 : dictFlag;
    const contentSizeBytes = contentSizeFlag ? 1 << contentSizeFlag : singleSegment;
    let contentSize = null;
    if (contentSizeBytes) {
        if (dat.length < pos + contentSizeBytes) return null;
        let value = 0;
        for (let i = 0; i < contentSizeBytes; i++) value += dat[pos + i] * Math.pow(2, 8 * i);
        contentSize = contentSizeFlag === 1 ? value + 256 : value;
    }
    let windowSize;
    if (singleSegment) windowSize = contentSize || 0;
    else {
        const base = 2 ** (10 + (dat[5] >> 3));
        windowSize = base + (base / 8) * (dat[5] & 7);
    }
    const headerSize = pos + contentSizeBytes;
    if (dat.length < headerSize) return null;
    return { windowSize, contentSize, headerSize, checksumSize: flags & 4 ? 4 : 0 };
}

// Walk block lengths, not magic bytes inside payloads, to isolate exactly one frame.
function zstdFrameEnd(input, start, header) {
    let end = start + header.headerSize;
    let last = false;
    while (!last) {
        if (input.length - end < 3) throw new Error("Truncated zstd block header");
        const block = input.readUIntLE(end, 3);
        const type = (block >> 1) & 3;
        if (type === 3) throw new Error("Invalid zstd block type");
        last = (block & 1) !== 0;
        end += 3 + (type === 1 ? 1 : block >>> 3);
        if (end > input.length) throw new Error("Truncated zstd block");
    }
    end += header.checksumSize;
    if (end > input.length) throw new Error("Truncated zstd checksum");
    return end;
}

// 用流式 Decompress 逐块计数解码 zstd：输出累计超过 limit 立即中止，返回真实长度的 Buffer。
// 绝不按 ch_size 预分配输出缓冲区——fzstd 会直接回传该缓冲区，使长度校验形同虚设。
function decompressZstdBounded(input, limit) {
    let total = 0;
    const chunks = [];
    let offset = 0;
    while (offset < input.length) {
        if (input.length - offset < 4) throw new Error("Truncated zstd frame magic");
        const magic = input.readUInt32LE(offset);
        if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
            if (input.length - offset < 8) throw new Error("Truncated zstd skippable header");
            offset += 8 + input.readUInt32LE(offset + 4);
            if (offset > input.length) throw new Error("Truncated zstd skippable frame");
            continue;
        }
        const header = zstdFrameHeader(input.subarray(offset));
        if (!header) throw new Error("Invalid or truncated zstd frame header");
        if (header.windowSize > limit) throw budgetExceeded("zstd window");
        if (header.contentSize !== null && header.contentSize > limit - total)
            throw budgetExceeded("zstd content size");
        const end = zstdFrameEnd(input, offset, header);
        // Never let fzstd discover another frame and allocate its unchecked window.
        const stream = new ZstdDecompress((chunk) => {
            total += chunk.length;
            if (total > limit) throw budgetExceeded("zstd output");
            chunks.push(Buffer.from(chunk));
        });
        stream.push(input.subarray(offset, end), true);
        offset = end;
    }
    return Buffer.concat(chunks, total);
}

function debugSectionData(buf, entry, name, budget) {
    if (entry.offset > buf.length || entry.size > buf.length - entry.offset)
        throw new Error(`DWARF section is outside the ELF: ${name}`);
    // budget 为可选的跨节共享计数器 { decoded, max }；直接调用时退化为单节预算。
    const shared = budget || { decoded: 0, max: MAX_DWARF_SECTION_BYTES };
    let data = buf.subarray(entry.offset, entry.offset + entry.size);
    let decompressed = false;
    // ELF gABI SHF_COMPRESSED, ELF32_Chdr = type/u32 size/u32 align/u32.
    if ((entry.flags & 0x800) !== 0) {
        if (data.length < 12) throw new Error(`Compressed DWARF section header is truncated: ${name}`);
        const compressionType = data.readUInt32LE(0);
        const expectedSize = data.readUInt32LE(4);
        if (expectedSize > MAX_DWARF_SECTION_BYTES) throw new Error(`Compressed DWARF section is too large: ${name}`);
        if (compressionType === 1) {
            data = zlib.inflateSync(data.subarray(12), { maxOutputLength: MAX_DWARF_SECTION_BYTES });
        } else if (compressionType === 2) {
            // ELFCOMPRESS_ZSTD。按真实解码字节计数，绝不把 ch_size 当作输出长度。
            data = decompressZstdBounded(data.subarray(12), MAX_DWARF_SECTION_BYTES);
        } else {
            throw new Error(`Unsupported DWARF compression type ${compressionType}: ${name}`);
        }
        if (data.length !== expectedSize) throw new Error(`Compressed DWARF section size mismatch: ${name}`);
        decompressed = true;
    } else if (name.startsWith(".zdebug_") && data.subarray(0, 4).toString("ascii") === "ZLIB") {
        // Legacy GNU .zdebug_* format: "ZLIB" + 8-byte big-endian size + zlib stream.
        if (data.length < 12) throw new Error(`Legacy compressed DWARF section is truncated: ${name}`);
        const expectedSize = Number(data.readBigUInt64BE(4));
        if (!Number.isSafeInteger(expectedSize) || expectedSize > MAX_DWARF_SECTION_BYTES)
            throw new Error(`Compressed DWARF section is too large: ${name}`);
        data = zlib.inflateSync(data.subarray(12), { maxOutputLength: MAX_DWARF_SECTION_BYTES });
        if (data.length !== expectedSize) throw new Error(`Legacy compressed DWARF section size mismatch: ${name}`);
        decompressed = true;
    }
    if (decompressed) {
        // §17.1：跨节共享预算，杜绝「每节各自 32MiB」被多个必需节放大成数百 MiB。
        shared.decoded += data.length;
        if (shared.decoded > shared.max) throw budgetExceeded("decompressed section");
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
    // 解压预算在同一个 ELF 的所有调试节之间共享，而非每节独立。
    const budget = { decoded: 0, max: MAX_DWARF_SECTION_BYTES };
    for (let i = 0; i < entries.length; i++) {
        const originalName = names[i];
        if (!originalName) continue;
        if (!originalName.startsWith(".debug_") && !originalName.startsWith(".zdebug_")) continue;
        const name = originalName.startsWith(".zdebug_") ? `.debug_${originalName.slice(8)}` : originalName;
        if (!REQUIRED_DWARF_SECTIONS.has(name)) continue;
        try {
            const data = debugSectionData(buf, entries[i], originalName, budget);
            map.set(name, { data, size: data.length });
        } catch (error) {
            // 解压预算耗尽属于内存安全问题，必须中止整个解析而非仅跳过单节。
            if (error.code === "DWARF_BUDGET_EXCEEDED") throw error;
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
function budgetExceeded(what) {
    return Object.assign(new Error(`DWARF ${what} budget exceeded`), { code: "DWARF_BUDGET_EXCEEDED" });
}
// budget 为可选的跨调用全局计数器 { abbrevs, attrs, maxAbbrevs, maxAttrs }。
// §2：缩写表以文件可控的 abbrevOff 为键被重复解析，若每次调用独立计数，
// N 个不同偏移就能让 N 份完整缩写表同时存活。传入共享 budget 后总量受控。
function parseAbbrev(buf, start, budget) {
    const map = new Map();
    const cur = { p: start };
    let guard = 0;
    const MAX_ABBREVIATIONS = 100000;
    while (cur.p < buf.length) {
        if (guard++ >= MAX_ABBREVIATIONS) throw budgetExceeded("abbreviation");
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
            if (attrs.length >= MAX_ATTRS_PER_ABBREV) throw budgetExceeded("abbreviation attribute");
            if (budget && ++budget.attrs > budget.maxAttrs) throw budgetExceeded("global attribute");
            attrs.push({ at, form, implicit });
        }
        if (budget && ++budget.abbrevs > budget.maxAbbrevs) throw budgetExceeded("global abbreviation");
        map.set(code, { tag, hasChildren, attrs });
    }
    return map;
}
module.exports = { readULEB, readSLEB, cstr, readAddr, debugSectionData, readSections, parseAbbrev };
