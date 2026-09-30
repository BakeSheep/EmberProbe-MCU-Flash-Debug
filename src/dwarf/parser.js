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
    DW_TAG_class_type,
    DW_TAG_inheritance,
    DW_TAG_namespace,
    DW_TAG_subprogram,
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
    DW_AT_linkage_name,
    DW_AT_virtuality,
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

    const dies = new Map(); // 节内偏移 → DIE 记录
    const childrenMap = new Map(); // 父 DIE 偏移 → [子 DIE 偏移]
    const parentOf = new Map(); // 子 DIE 偏移 → 父 DIE 偏移（构造 C++ 限定名用）
    const variableOffsets = []; // 所有变量 DIE；跨 CU 的 origin 继承需在完整解析后处理
    const subprogramOffsets = []; // 所有子程序 DIE（函数显示名用）
    const infoStart = 0,
        infoEnd = info.size;
    // §2：缩写缓存改为有界 LRU，并以全局预算约束跨 CU 的缩写/属性总量。
    // abbrevOff 是文件可控的 u32，旧实现以它为键无界缓存，N 个不同偏移
    // 就能让 N 份完整缩写表同时存活，直至扩展宿主 OOM。
    const MAX_ABBREV_CACHE_ENTRIES = 8;
    const abbrevCache = new Map();
    const abbrevBudget = { abbrevs: 0, attrs: 0, maxAbbrevs: 20000, maxAttrs: 200000 };
    const abbrevCacheGet = (key) => {
        if (!abbrevCache.has(key)) return undefined;
        const value = abbrevCache.get(key);
        abbrevCache.delete(key);
        abbrevCache.set(key, value); // 移到末尾（最近使用）
        return value;
    };
    const abbrevCacheSet = (key, value) => {
        if (abbrevCache.has(key)) abbrevCache.delete(key);
        abbrevCache.set(key, value);
        while (abbrevCache.size > MAX_ABBREV_CACHE_ENTRIES) abbrevCache.delete(abbrevCache.keys().next().value);
    };
    // §3：DIE 预算改为整个解析全局。旧实现 guard 定义在 CU 循环内，每个 CU 都重置，
    // 而 dies/childrenMap/variableOffsets 从不重置，因此预算只约束单个 CU。
    const MAX_DIES_TOTAL = 2000000;
    let totalDies = 0;
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
        const cuBuffer = buf.subarray(0, cuEnd);
        const readFormValue = createFormReader({ buf: cuBuffer, str, lineStr });
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
            if (cuStart + 4 + unitLength > infoEnd || p > cuEnd) throw new Error("Truncated DWARF unit");
            let abbrev = abbrevCacheGet(abbrevOff);
            if (!abbrev) {
                abbrev = parseAbbrev(abbrevSec.data, abbrevOff, abbrevBudget);
                abbrevCacheSet(abbrevOff, abbrev);
            }
            const cuRel = cuStart - infoStart;
            let strOffsetsBase = 8;
            const cur = { p };
            try {
                const parentStack = []; // { offset, dieOff } — 有子项的 DIE 栈，用于构建 childrenMap
                while (cur.p < cuEnd) {
                    if (++totalDies > MAX_DIES_TOTAL)
                        throw Object.assign(new Error("DWARF DIE budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
                    const dieOff = cur.p - infoStart;
                    const code = readULEB(cuBuffer, cur);
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
                        parentOf.set(dieOff, parent.dieOff);
                    }
                    const rec = { tag: ab.tag };
                    for (const attr of ab.attrs) {
                        const v = readFormValue(cur, attr.form, { addrSize, cuRel, implicit: attr.implicit });
                        switch (attr.at) {
                            case DW_AT_name:
                                if (v && v.str !== undefined) rec.name = v.str;
                                else if (v && v.strx !== undefined) rec.strx = v.strx;
                                break;
                            case DW_AT_linkage_name:
                                if (v && v.str !== undefined) rec.linkageName = v.str;
                                else if (v && v.strx !== undefined) rec.linkageStrx = v.strx;
                                break;
                            case DW_AT_virtuality:
                                if (typeof v === "number") rec.virtuality = v;
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
                                if (v && v.block && v.block.length >= 1) {
                                    rec.hasAddr = v.block[0] === 0x03 || v.block[0] === 0xa1;
                                    if (addrSize === 4 && v.block[0] === 0x03 && v.block.length === 5)
                                        rec.address = v.block.readUInt32LE(1);
                                } else if (typeof v === "number") rec.hasAddr = v === 0x03 || v === 0xa1;
                                break;
                            case DW_AT_declaration:
                                rec.isDecl = !!v;
                                break;
                            case DW_AT_str_offsets_base:
                                if (typeof v === "number") strOffsetsBase = v;
                                break;
                            case DW_AT_data_member_location:
                                if (typeof v === "number") {
                                    rec.memberOffset = v;
                                } else if (v && v.block && v.block.length > 1 && v.block[0] === 0x23) {
                                    // 仅当整段表达式唯一定义为 DW_OP_plus_uconst (0x23) + ULEB 常量时，才认定为固定成员偏移；
                                    // 包含运行期取指针/计算的复杂表达式（如虚基类位置）不作静态数值误判。
                                    let bp = 1;
                                    let val = 0,
                                        sh = 0,
                                        b2;
                                    do {
                                        if (bp >= v.block.length) break;
                                        b2 = v.block[bp++];
                                        val += (b2 & 0x7f) * Math.pow(2, sh);
                                        sh += 7;
                                    } while (b2 & 0x80);
                                    if (
                                        bp === v.block.length &&
                                        !(b2 & 0x80) &&
                                        Number.isSafeInteger(val) &&
                                        sh <= 56
                                    ) {
                                        rec.memberOffset = val;
                                    }
                                }
                                if (!Number.isSafeInteger(rec.memberOffset) || rec.memberOffset < 0) {
                                    delete rec.memberOffset;
                                    rec.memberLocationUnsupported = true;
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
                    if (rec.tag === DW_TAG_subprogram) subprogramOffsets.push(dieOff);
                    // 有子项的 DIE 入栈
                    if (ab.hasChildren) {
                        parentStack.push({ offset: dieOff, dieOff });
                    }
                }
            } catch (e) {
                // 全局预算耗尽必须中止整个解析，而不是吞掉后继续下一个 CU 累积内存。
                if (e.code === "DWARF_BUDGET_EXCEEDED") throw e;
                diagnostics.push({
                    code: /unknown DWARF form/.test(e.message) ? "DWARF_UNSUPPORTED" : "DWARF_CU_INVALID",
                    stage: "attributes",
                    offset: p,
                    message: e.message
                });
            }
        } catch (e) {
            if (e.code === "DWARF_BUDGET_EXCEEDED") throw e;
            diagnostics.push({ code: "DWARF_CU_INVALID", stage: "header", offset: p, message: e.message });
        }
        p = cuEnd;
    }

    // 统一解析 strx 名称
    for (const d of dies.values()) {
        if (d.name === undefined && d.strx !== undefined) d.name = resolveStrx(d.strx, d.base);
        if (d.linkageName === undefined && d.linkageStrx !== undefined)
            d.linkageName = resolveStrx(d.linkageStrx, d.base);
    }

    // 作用域链（namespace/class/struct/union 祖先）构造 C++ 限定名；遇到 CU 根自然终止。
    const SCOPE_TAGS = new Set([DW_TAG_namespace, DW_TAG_class_type, DW_TAG_structure_type, DW_TAG_union_type]);
    const scopePrefix = (dieOff) => {
        const parts = [];
        let cur = parentOf.get(dieOff);
        let guard = 0;
        while (cur !== undefined && guard++ < 64) {
            const d = dies.get(cur);
            if (!d) break;
            if (SCOPE_TAGS.has(d.tag) && d.name) parts.push(d.name);
            cur = parentOf.get(cur);
        }
        return parts.reverse();
    };
    const buildQualifiedName = (scopeDieOff, name) => {
        let parts = scopePrefix(scopeDieOff);
        if (!parts.length) {
            // 具体 DIE 直接挂在 CU 下（如类静态成员的地址 DIE）时，回落到声明 DIE 的作用域。
            const d = dies.get(scopeDieOff);
            for (const ref of [d?.specificationRef, d?.abstractOriginRef]) {
                if (ref === undefined) continue;
                const alt = scopePrefix(ref);
                if (alt.length) {
                    parts = alt;
                    break;
                }
            }
        }
        return parts.length ? parts.join("::") + "::" + name : name;
    };

    // LTO 常把地址留在具体变量 DIE，而把名称和类型放进 abstract_origin/specification。
    // 所有 CU 都完成后再继承，才能正确解析 DW_FORM_ref_addr 的跨 CU 引用。
    const resolveVariableIdentity = (dieOff, seen = new Set()) => {
        if (seen.has(dieOff) || seen.size >= 16)
            return { name: "", typeRef: undefined, linkageName: "", scopeDieOff: dieOff };
        seen.add(dieOff);
        const die = dies.get(dieOff);
        if (!die) return { name: "", typeRef: undefined, linkageName: "", scopeDieOff: dieOff };
        let name = die.name || "";
        let typeRef = die.typeRef;
        let linkageName = die.linkageName || "";
        let scopeDieOff = dieOff;
        for (const parentRef of [die.abstractOriginRef, die.specificationRef]) {
            if (parentRef === undefined) continue;
            const inherited = resolveVariableIdentity(parentRef, new Set(seen));
            if (!name) {
                name = inherited.name;
                scopeDieOff = inherited.scopeDieOff;
            }
            if (typeRef === undefined) typeRef = inherited.typeRef;
            if (!linkageName) linkageName = inherited.linkageName;
        }
        return { name, typeRef, linkageName, scopeDieOff };
    };
    const variables = [];
    for (const dieOff of variableOffsets) {
        const concrete = dies.get(dieOff);
        if (!concrete?.hasAddr) continue;
        const identity = resolveVariableIdentity(dieOff);
        if (!identity.name || identity.typeRef === undefined) continue;
        variables.push({
            ...concrete,
            name: identity.name,
            typeRef: identity.typeRef,
            linkageName: identity.linkageName,
            qualifiedName: buildQualifiedName(identity.scopeDieOff, identity.name)
        });
    }

    // 函数显示名：以 linkage name（ELF 中的 mangled 名）为键关联限定名。
    const subprograms = [];
    for (const dieOff of subprogramOffsets) {
        const identity = resolveVariableIdentity(dieOff);
        if (!identity.name) continue;
        subprograms.push({
            name: identity.name,
            linkageName: identity.linkageName,
            qualifiedName: buildQualifiedName(identity.scopeDieOff, identity.name)
        });
    }

    return { dies, childrenMap, parentOf, resolveStrx, variables, subprograms, diagnostics };
}
module.exports = { parseDwarfInternal: _parseDwarfInternal };
