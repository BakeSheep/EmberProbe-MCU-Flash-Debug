"use strict";
// 解析 ELF 的 DWARF 调试信息，提取"变量名 → C 类型"映射，用于在导入列表中显示类型并推断默认观察类型。
// 独立实现，防御式：任何解析异常都优雅降级（返回已解析部分或空表），不影响基于符号表的导入。

// —— LEB128 ——
function readULEB(buf, cur) {
    let result = 0, shift = 0, byte;
    do {
        byte = buf[cur.p++];
        result += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while (byte & 0x80);
    return result;
}
function readSLEB(buf, cur) {
    let result = 0, shift = 0, byte;
    do {
        byte = buf[cur.p++];
        result += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
    } while (byte & 0x80);
    if (shift < 64 && (byte & 0x40)) result -= Math.pow(2, shift);
    return result;
}

// DWARF tag / attribute / encoding 常量（仅列出所需）
const DW_TAG_variable = 0x34, DW_TAG_base_type = 0x24, DW_TAG_typedef = 0x16, DW_TAG_pointer_type = 0x0f,
    DW_TAG_const_type = 0x26, DW_TAG_volatile_type = 0x35, DW_TAG_restrict_type = 0x37,
    DW_TAG_structure_type = 0x13, DW_TAG_union_type = 0x17, DW_TAG_enumeration_type = 0x04, DW_TAG_array_type = 0x01;
const DW_AT_name = 0x03, DW_AT_byte_size = 0x0b, DW_AT_encoding = 0x3e, DW_AT_type = 0x49,
    DW_AT_location = 0x02, DW_AT_declaration = 0x3c, DW_AT_str_offsets_base = 0x72;
const DW_ATE_boolean = 0x02, DW_ATE_float = 0x04, DW_ATE_signed = 0x05, DW_ATE_signed_char = 0x06,
    DW_ATE_unsigned = 0x07, DW_ATE_unsigned_char = 0x08;

// 基础类型编码 + 字节宽度 → 观察类型（u8…f32）；不支持者返回 ''
function encodingToWatchType(encoding, size) {
    if (encoding === DW_ATE_float) return size === 4 ? 'f32' : '';
    if (encoding === DW_ATE_signed || encoding === DW_ATE_signed_char) {
        if (size === 1) return 'i8'; if (size === 2) return 'i16'; if (size === 4) return 'i32'; return '';
    }
    if (encoding === DW_ATE_unsigned || encoding === DW_ATE_unsigned_char || encoding === DW_ATE_boolean) {
        if (size === 1) return 'u8'; if (size === 2) return 'u16'; if (size === 4) return 'u32'; return '';
    }
    return '';
}

function cstr(buf, off) {
    if (off < 0 || off >= buf.length) return '';
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('utf8', off, end);
}
function readAddr(buf, cur, size) {
    const s = size || 4;
    if (s === 8) { const v = buf.readUInt32LE(cur.p); cur.p += 8; return v; }
    const v = buf.readUIntLE(cur.p, s); cur.p += s; return v;
}

// 读取带名称的节表：name → { offset, size }
function readSections(buf) {
    const map = new Map();
    if (buf.length < 52 || buf[4] !== 1 || buf[5] !== 1) return map; // 仅 ELF32 LE
    const eShoff = buf.readUInt32LE(32);
    const eShentsize = buf.readUInt16LE(46) || 40;
    const eShnum = buf.readUInt16LE(48);
    const eShstrndx = buf.readUInt16LE(50);
    if (!eShoff || !eShnum || eShstrndx >= eShnum) return map;
    const shOff = (i) => eShoff + i * eShentsize;
    const strOff = shOff(eShstrndx);
    if (strOff + 40 > buf.length) return map;
    const shstrBase = buf.readUInt32LE(strOff + 16);
    for (let i = 0; i < eShnum; i++) {
        const off = shOff(i);
        if (off + 40 > buf.length) break;
        const name = cstr(buf, shstrBase + buf.readUInt32LE(off + 0));
        map.set(name, { offset: buf.readUInt32LE(off + 16), size: buf.readUInt32LE(off + 20) });
    }
    return map;
}

// 解析一个 .debug_abbrev 缩写表：code → { tag, attrs: [{ at, form, implicit }] }
function parseAbbrev(buf, start) {
    const map = new Map();
    const cur = { p: start };
    let guard = 0;
    while (cur.p < buf.length && guard++ < 100000) {
        const code = readULEB(buf, cur);
        if (code === 0) break;
        const tag = readULEB(buf, cur);
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
        map.set(code, { tag, attrs });
    }
    return map;
}

// 主入口：返回 Map<变量名, { typeName, watchType }>
function parseDwarfVariableTypes(buffer) {
    try {
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const sections = readSections(buf);
        const info = sections.get('.debug_info');
        const abbrevSec = sections.get('.debug_abbrev');
        if (!info || !abbrevSec) return new Map();
        const str = sections.get('.debug_str');
        const lineStr = sections.get('.debug_line_str');
        const strOffsets = sections.get('.debug_str_offsets');

        const resolveStrx = (index, base) => {
            if (!strOffsets || !str) return '';
            const entryOff = strOffsets.offset + (base || 8) + index * 4;
            if (entryOff + 4 > strOffsets.offset + strOffsets.size) return '';
            return cstr(buf, str.offset + buf.readUInt32LE(entryOff));
        };

        // 读取单个属性值并推进游标
        const readFormValue = function readForm(cur, form, ctx) {
            switch (form) {
                case 0x01: return readAddr(buf, cur, ctx.addrSize);          // addr
                case 0x03: { const n = buf.readUInt16LE(cur.p); cur.p += 2; const b = buf.subarray(cur.p, cur.p + n); cur.p += n; return { block: b }; }
                case 0x04: { const n = buf.readUInt32LE(cur.p); cur.p += 4; const b = buf.subarray(cur.p, cur.p + n); cur.p += n; return { block: b }; }
                case 0x05: { const v = buf.readUInt16LE(cur.p); cur.p += 2; return v; }
                case 0x06: { const v = buf.readUInt32LE(cur.p); cur.p += 4; return v; }
                case 0x07: { cur.p += 8; return 0; }                         // data8
                case 0x08: { const s = cstr(buf, cur.p); cur.p += s.length + 1; return { str: s }; }
                case 0x09: { const n = readULEB(buf, cur); const b = buf.subarray(cur.p, cur.p + n); cur.p += n; return { block: b }; }
                case 0x0a: { const n = buf[cur.p]; cur.p += 1; const b = buf.subarray(cur.p, cur.p + n); cur.p += n; return { block: b }; }
                case 0x0b: { const v = buf[cur.p]; cur.p += 1; return v; }
                case 0x0c: { const v = buf[cur.p]; cur.p += 1; return v !== 0; }
                case 0x0d: return readSLEB(buf, cur);
                case 0x0e: { const off = buf.readUInt32LE(cur.p); cur.p += 4; return { str: str ? cstr(buf, str.offset + off) : '' }; }
                case 0x0f: return readULEB(buf, cur);
                case 0x10: { const off = buf.readUInt32LE(cur.p); cur.p += 4; return { ref: off }; } // ref_addr（节内偏移）
                case 0x11: { const v = buf[cur.p]; cur.p += 1; return { ref: ctx.cuRel + v }; }
                case 0x12: { const v = buf.readUInt16LE(cur.p); cur.p += 2; return { ref: ctx.cuRel + v }; }
                case 0x13: { const v = buf.readUInt32LE(cur.p); cur.p += 4; return { ref: ctx.cuRel + v }; }
                case 0x14: { const lo = buf.readUInt32LE(cur.p); cur.p += 8; return { ref: ctx.cuRel + lo }; }
                case 0x15: { const v = readULEB(buf, cur); return { ref: ctx.cuRel + v }; }
                case 0x16: { const f = readULEB(buf, cur); return readForm(cur, f, ctx); } // indirect
                case 0x17: { const v = buf.readUInt32LE(cur.p); cur.p += 4; return v; }     // sec_offset
                case 0x18: { const n = readULEB(buf, cur); const b = buf.subarray(cur.p, cur.p + n); cur.p += n; return { block: b }; }
                case 0x19: return true;                                       // flag_present
                case 0x1a: return { strx: readULEB(buf, cur) };
                case 0x1b: { readULEB(buf, cur); return 0; }                  // addrx
                case 0x1c: { cur.p += 4; return 0; }
                case 0x1d: { cur.p += 4; return { str: '' }; }
                case 0x1e: { const b = buf.subarray(cur.p, cur.p + 16); cur.p += 16; return { block: b }; }
                case 0x1f: { const off = buf.readUInt32LE(cur.p); cur.p += 4; return { str: lineStr ? cstr(buf, lineStr.offset + off) : '' }; }
                case 0x20: { cur.p += 8; return 0; }
                case 0x21: return (ctx.implicit !== undefined ? ctx.implicit : 0); // implicit_const
                case 0x22: { readULEB(buf, cur); return 0; }
                case 0x23: { readULEB(buf, cur); return 0; }
                case 0x24: { cur.p += 8; return 0; }
                case 0x25: { const v = buf[cur.p]; cur.p += 1; return { strx: v }; }
                case 0x26: { const v = buf.readUInt16LE(cur.p); cur.p += 2; return { strx: v }; }
                case 0x27: { const v = buf.readUIntLE(cur.p, 3); cur.p += 3; return { strx: v }; }
                case 0x28: { const v = buf.readUInt32LE(cur.p); cur.p += 4; return { strx: v }; }
                case 0x29: { cur.p += 1; return 0; }
                case 0x2a: { cur.p += 2; return 0; }
                case 0x2b: { cur.p += 3; return 0; }
                case 0x2c: { cur.p += 4; return 0; }
                default: throw new Error('unknown DWARF form 0x' + form.toString(16));
            }
        };

        const dies = new Map();   // 节内偏移 → DIE 记录
        const variables = [];     // 具有固定地址的变量 DIE
        const infoStart = info.offset, infoEnd = info.offset + info.size;
        const abbrevCache = new Map();
        let p = infoStart;
        while (p + 4 <= infoEnd) {
            const cuStart = p;
            const unitLength = buf.readUInt32LE(p); p += 4;
            if (unitLength === 0xffffffff || unitLength === 0) break; // 不支持 64 位 DWARF
            const cuEnd = Math.min(cuStart + 4 + unitLength, infoEnd);
            const version = buf.readUInt16LE(p); p += 2;
            let addrSize, abbrevOff;
            if (version >= 5) { p += 1; addrSize = buf[p]; p += 1; abbrevOff = buf.readUInt32LE(p); p += 4; }
            else { abbrevOff = buf.readUInt32LE(p); p += 4; addrSize = buf[p]; p += 1; }
            let abbrev = abbrevCache.get(abbrevOff);
            if (!abbrev) { abbrev = parseAbbrev(buf, abbrevSec.offset + abbrevOff); abbrevCache.set(abbrevOff, abbrev); }
            const cuRel = cuStart - infoStart;
            let strOffsetsBase = 8;
            const cur = { p };
            try {
                let guard = 0;
                while (cur.p < cuEnd && guard++ < 2000000) {
                    const dieOff = cur.p - infoStart;
                    const code = readULEB(buf, cur);
                    if (code === 0) continue; // 兄弟链结束标记
                    const ab = abbrev.get(code);
                    if (!ab) throw new Error('unknown abbrev code');
                    const rec = { tag: ab.tag };
                    for (const attr of ab.attrs) {
                        const v = readFormValue(cur, attr.form, { addrSize, cuRel, implicit: attr.implicit });
                        switch (attr.at) {
                            case DW_AT_name: if (v && v.str !== undefined) rec.name = v.str; else if (v && v.strx !== undefined) rec.strx = v.strx; break;
                            case DW_AT_type: if (v && v.ref !== undefined) rec.typeRef = v.ref; break;
                            case DW_AT_byte_size: if (typeof v === 'number') rec.byteSize = v; break;
                            case DW_AT_encoding: if (typeof v === 'number') rec.encoding = v; break;
                            case DW_AT_location: if (v && v.block && v.block.length >= 1) rec.hasAddr = (v.block[0] === 0x03 || v.block[0] === 0xa1); break;
                            case DW_AT_declaration: rec.isDecl = !!v; break;
                            case DW_AT_str_offsets_base: if (typeof v === 'number') strOffsetsBase = v; break;
                        }
                    }
                    rec.base = strOffsetsBase;
                    dies.set(dieOff, rec);
                    if (rec.tag === DW_TAG_variable && rec.typeRef !== undefined && rec.hasAddr && (rec.name !== undefined || rec.strx !== undefined)) {
                        variables.push(rec);
                    }
                }
            } catch (e) { /* 单个 CU 解析失败：跳过，继续其余 CU */ }
            p = cuEnd;
        }

        // 统一解析 strx 名称
        for (const d of dies.values()) {
            if (d.name === undefined && d.strx !== undefined) d.name = resolveStrx(d.strx, d.base);
        }

        const resolveType = (refKey, depth) => {
            if (depth > 16) return { typeName: '', watchType: '' };
            const d = dies.get(refKey);
            if (!d) return { typeName: '', watchType: '' };
            const nm = d.name || '';
            switch (d.tag) {
                case DW_TAG_base_type:
                    return { typeName: nm || 'base', watchType: encodingToWatchType(d.encoding, d.byteSize || 0) };
                case DW_TAG_typedef: {
                    const inner = d.typeRef !== undefined ? resolveType(d.typeRef, depth + 1) : { typeName: '', watchType: '' };
                    return { typeName: nm || inner.typeName, watchType: inner.watchType };
                }
                case DW_TAG_const_type:
                case DW_TAG_volatile_type:
                case DW_TAG_restrict_type:
                    return d.typeRef !== undefined ? resolveType(d.typeRef, depth + 1) : { typeName: '', watchType: '' };
                case DW_TAG_pointer_type: {
                    const inner = d.typeRef !== undefined ? resolveType(d.typeRef, depth + 1) : { typeName: 'void', watchType: '' };
                    return { typeName: (inner.typeName || 'void') + ' *', watchType: 'u32' };
                }
                case DW_TAG_structure_type: return { typeName: nm ? 'struct ' + nm : 'struct', watchType: '' };
                case DW_TAG_union_type: return { typeName: nm ? 'union ' + nm : 'union', watchType: '' };
                case DW_TAG_enumeration_type: return { typeName: nm ? 'enum ' + nm : 'enum', watchType: encodingToWatchType(DW_ATE_signed, d.byteSize || 4) };
                case DW_TAG_array_type: {
                    const inner = d.typeRef !== undefined ? resolveType(d.typeRef, depth + 1) : { typeName: '', watchType: '' };
                    return { typeName: (inner.typeName || '') + '[]', watchType: '' };
                }
                default: return { typeName: nm, watchType: '' };
            }
        };

        const result = new Map();
        for (const v of variables) {
            const name = v.name || '';
            if (!name || result.has(name)) continue;
            const t = v.typeRef !== undefined ? resolveType(v.typeRef, 0) : { typeName: '', watchType: '' };
            result.set(name, { typeName: t.typeName || '', watchType: t.watchType || '' });
        }
        return result;
    } catch (e) {
        return new Map(); // 任意异常一律降级为空表
    }
}

module.exports = { parseDwarfVariableTypes, encodingToWatchType, readULEB, readSLEB };
