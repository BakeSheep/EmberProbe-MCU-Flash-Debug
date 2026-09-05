"use strict";
const {
    DW_TAG_array_type,
    DW_TAG_structure_type,
    DW_TAG_union_type,
    DW_TAG_enumeration_type,
    DW_TAG_pointer_type,
    DW_TAG_typedef,
    DW_TAG_base_type,
    DW_TAG_const_type,
    DW_TAG_volatile_type,
    DW_TAG_restrict_type,
    DW_TAG_variable,
    DW_TAG_member,
    DW_TAG_subrange_type,
    DW_AT_name,
    DW_AT_byte_size,
    DW_AT_abstract_origin,
    DW_AT_encoding,
    DW_AT_specification,
    DW_AT_type,
    DW_AT_location,
    DW_AT_declaration,
    DW_AT_str_offsets_base,
    DW_AT_data_member_location,
    DW_AT_bit_size,
    DW_AT_bit_offset,
    DW_AT_data_bit_offset,
    DW_AT_count,
    DW_AT_upper_bound,
    DW_ATE_boolean,
    DW_ATE_float,
    DW_ATE_signed,
    DW_ATE_signed_char,
    DW_ATE_unsigned,
    DW_ATE_unsigned_char
} = require("./constants");
const { readSections, parseAbbrev, readULEB } = require("./binary");
const { cstr } = require("./binary");
const { createFormReader } = require("./forms");
function _parseDwarfInternal(buffer) {
    const elf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const diagnostics = [];
    const sections = readSections(elf, diagnostics);
    const info = sections.get(".debug_info");
    const abbrevSec = sections.get(".debug_abbrev");
    if (!info || !abbrevSec)
        return {
            dies: new Map(),
            childrenMap: new Map(),
            variables: [],
            diagnostics: [
                ...diagnostics,
                { code: "DWARF_MISSING", stage: "sections", message: "Required DWARF sections are unavailable" }
            ]
        };
    const str = sections.get(".debug_str");
    const lineStr = sections.get(".debug_line_str");
    const strOffsets = sections.get(".debug_str_offsets");
    const buf = info.data;

    const resolveStrx = (index, base) => {
        if (!strOffsets || !str) return "";
        const entryOff = (base || 8) + index * 4;
        if (entryOff + 4 > strOffsets.size) return "";
        return cstr(str.data, strOffsets.data.readUInt32LE(entryOff));
    };

    // 读取单个属性值并推进游标
    const readFormValue = createFormReader({ buf, str, lineStr });

    const dies = new Map(); // 节内偏移 → DIE 记录
    const childrenMap = new Map(); // 父 DIE 偏移 → [子 DIE 偏移]
    const variableOffsets = []; // 所有变量 DIE；跨 CU 的 origin 继承需在完整解析后处理
    const infoStart = 0,
        infoEnd = info.size;
    const abbrevCache = new Map();
    let p = infoStart;
    while (p + 4 <= infoEnd) {
        const cuStart = p;
        const unitLength = buf.readUInt32LE(p);
        p += 4;
        if (unitLength === 0xffffffff || unitLength === 0) {
            diagnostics.push({
                code: "DWARF_UNSUPPORTED",
                stage: "header",
                offset: cuStart,
                message: "Unsupported DWARF unit length"
            });
            break;
        }
        const cuEnd = Math.min(cuStart + 4 + unitLength, infoEnd);
        try {
            const version = buf.readUInt16LE(p);
            p += 2;
            let addrSize, abbrevOff;
            if (version >= 5) {
                p += 1;
                addrSize = buf[p];
                p += 1;
                abbrevOff = buf.readUInt32LE(p);
                p += 4;
            } else {
                abbrevOff = buf.readUInt32LE(p);
                p += 4;
                addrSize = buf[p];
                p += 1;
            }
            let abbrev = abbrevCache.get(abbrevOff);
            if (!abbrev) {
                abbrev = parseAbbrev(abbrevSec.data, abbrevOff);
                abbrevCache.set(abbrevOff, abbrev);
            }
            const cuRel = cuStart - infoStart;
            let strOffsetsBase = 8;
            const cur = { p };
            try {
                let guard = 0;
                const parentStack = []; // { offset, dieOff } — 有子项的 DIE 栈，用于构建 childrenMap
                const MAX_DIES_PER_UNIT = 2000000;
                while (cur.p < cuEnd) {
                    if (guard++ >= MAX_DIES_PER_UNIT)
                        throw Object.assign(new Error("DWARF DIE budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
                    const dieOff = cur.p - infoStart;
                    const code = readULEB(buf, cur);
                    if (code === 0) {
                        // 兄弟链结束标记：弹出当前父级
                        if (parentStack.length) parentStack.pop();
                        continue;
                    }
                    const ab = abbrev.get(code);
                    if (!ab) throw new Error("unknown abbrev code");
                    // 记录父子关系
                    if (parentStack.length) {
                        const parent = parentStack[parentStack.length - 1];
                        let siblings = childrenMap.get(parent.dieOff);
                        if (!siblings) {
                            siblings = [];
                            childrenMap.set(parent.dieOff, siblings);
                        }
                        siblings.push(dieOff);
                    }
                    const rec = { tag: ab.tag };
                    for (const attr of ab.attrs) {
                        const v = readFormValue(cur, attr.form, { addrSize, cuRel, implicit: attr.implicit });
                        switch (attr.at) {
                            case DW_AT_name:
                                if (v && v.str !== undefined) rec.name = v.str;
                                else if (v && v.strx !== undefined) rec.strx = v.strx;
                                break;
                            case DW_AT_type:
                                if (v && v.ref !== undefined) rec.typeRef = v.ref;
                                break;
                            case DW_AT_abstract_origin:
                                if (v && v.ref !== undefined) rec.abstractOriginRef = v.ref;
                                break;
                            case DW_AT_specification:
                                if (v && v.ref !== undefined) rec.specificationRef = v.ref;
                                break;
                            case DW_AT_byte_size:
                                if (typeof v === "number") rec.byteSize = v;
                                break;
                            case DW_AT_encoding:
                                if (typeof v === "number") rec.encoding = v;
                                break;
                            case DW_AT_location:
                                if (v && v.block && v.block.length >= 1)
                                    rec.hasAddr = v.block[0] === 0x03 || v.block[0] === 0xa1;
                                else if (typeof v === "number") rec.hasAddr = v === 0x03 || v === 0xa1;
                                break;
                            case DW_AT_declaration:
                                rec.isDecl = !!v;
                                break;
                            case DW_AT_str_offsets_base:
                                if (typeof v === "number") strOffsetsBase = v;
                                break;
                            case DW_AT_data_member_location:
                                if (typeof v === "number") rec.memberOffset = v;
                                else if (v && v.block && v.block.length > 0) {
                                    // DW_OP_plus_uconst (0x23) 后跟 ULEB 常量；或纯 ULEB 常量
                                    let bp = 0;
                                    if (v.block[bp] === 0x23) bp++;
                                    if (bp < v.block.length) {
                                        let val = 0,
                                            sh = 0,
                                            b2;
                                        do {
                                            b2 = v.block[bp++];
                                            val += (b2 & 0x7f) * Math.pow(2, sh);
                                            sh += 7;
                                        } while (b2 & 0x80);
                                        rec.memberOffset = val;
                                    }
                                }
                                break;
                            case DW_AT_bit_size:
                                if (typeof v === "number") rec.bitSize = v;
                                break;
                            case DW_AT_bit_offset:
                                if (typeof v === "number") rec.bitOffset = v;
                                break;
                            case DW_AT_data_bit_offset:
                                if (typeof v === "number") rec.dataBitOffset = v;
                                break;
                            case DW_AT_count:
                                if (typeof v === "number") rec.subrangeCount = v;
                                break;
                            case DW_AT_upper_bound:
                                if (typeof v === "number") rec.subrangeUpperBound = v;
                                break;
                        }
                    }
                    rec.base = strOffsetsBase;
                    dies.set(dieOff, rec);
                    if (rec.tag === DW_TAG_variable) variableOffsets.push(dieOff);
                    // 有子项的 DIE 入栈
                    if (ab.hasChildren) {
                        parentStack.push({ offset: dieOff, dieOff });
                    }
                }
            } catch (e) {
                diagnostics.push({
                    code:
                        e.code === "DWARF_BUDGET_EXCEEDED"
                            ? e.code
                            : /unknown DWARF form/.test(e.message)
                              ? "DWARF_UNSUPPORTED"
                              : "DWARF_CU_INVALID",
                    stage: "attributes",
                    offset: p,
                    message: e.message
                });
            }
        } catch (e) {
            diagnostics.push({ code: "DWARF_CU_INVALID", stage: "header", offset: p, message: e.message });
        }
        p = cuEnd;
    }

    // 统一解析 strx 名称
    for (const d of dies.values()) {
        if (d.name === undefined && d.strx !== undefined) d.name = resolveStrx(d.strx, d.base);
    }

    // LTO 常把地址留在具体变量 DIE，而把名称和类型放进 abstract_origin/specification。
    // 所有 CU 都完成后再继承，才能正确解析 DW_FORM_ref_addr 的跨 CU 引用。
    const resolveVariableIdentity = (dieOff, seen = new Set()) => {
        if (seen.has(dieOff) || seen.size >= 16) return { name: "", typeRef: undefined };
        seen.add(dieOff);
        const die = dies.get(dieOff);
        if (!die) return { name: "", typeRef: undefined };
        let name = die.name || "";
        let typeRef = die.typeRef;
        for (const parentRef of [die.abstractOriginRef, die.specificationRef]) {
            if (parentRef === undefined || (name && typeRef !== undefined)) continue;
            const inherited = resolveVariableIdentity(parentRef, new Set(seen));
            if (!name) name = inherited.name;
            if (typeRef === undefined) typeRef = inherited.typeRef;
        }
        return { name, typeRef };
    };
    const variables = [];
    for (const dieOff of variableOffsets) {
        const concrete = dies.get(dieOff);
        if (!concrete?.hasAddr) continue;
        const identity = resolveVariableIdentity(dieOff);
        if (!identity.name || identity.typeRef === undefined) continue;
        variables.push({ ...concrete, name: identity.name, typeRef: identity.typeRef });
    }

    return { dies, childrenMap, resolveStrx, variables, diagnostics };
}
module.exports = { parseDwarfInternal: _parseDwarfInternal };
