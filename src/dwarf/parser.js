"use strict";
const { appendDiagnostic } = require("./diagnostics");
const { isEmptyUpperBound } = require("./subranges");
const { normalizeTypeDeclarations } = require("./typeIdentity");
const {
    DW_TAG_array_type,
    DW_TAG_structure_type,
    DW_TAG_union_type,
    DW_TAG_enumeration_type,
    DW_TAG_enumerator,
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
    DW_AT_artificial,
    DW_ATE_boolean,
    DW_ATE_float,
    DW_ATE_signed,
    DW_ATE_signed_char,
    DW_ATE_unsigned,
    DW_ATE_unsigned_char
} = require("./constants");
// These DIEs describe execution state. Watch metadata only consumes static-address variables,
// types (including every type child), subprogram identities, and their scope/reference chains.
const LOCAL_TAGS = new Set([0x05, 0x0a, 0x0b, 0x18, 0x1d, 0x48, 0x49, 0x4109, 0x410a, DW_TAG_variable]);
const LOCAL_SCOPES = new Set([...LOCAL_TAGS, DW_TAG_subprogram]);
const UNIT_TAGS = new Set([0x11, 0x3c, 0x4a]); // compile, partial and skeleton units
// Display/filter metadata only: the path is never opened, so it is normalized lexically.
function unitSourceFile(unit) {
    const name = unit?.sourceName || unit?.input?.parent?.sourceName || "";
    if (!name) return "";
    const compDir = unit.compDir || unit.input?.parent?.compDir || "";
    const absolute = (value) => /^(?:[a-zA-Z]:)?[\\/]/.test(value);
    const joined = absolute(name) || !compDir || /[\x00-\x1f]/.test(compDir) ? name : compDir + "/" + name;
    return require("path").posix.normalize(joined.replace(/\\/g, "/"));
}
const UNIT_ATTRIBUTES = new Set([0x1b, 0x76, 0x2130, 0x2131, 0x73, 0x2133, DW_AT_str_offsets_base]);
function hasStaticLocation(value, addrSize) {
    const block = value?.block;
    if (!block?.length) return false;
    if (addrSize === 4 && block[0] === 0x03 && block.length === 5) return true;
    if ([0xa1, 0xfb].includes(block[0])) {
        const cursor = { p: 1 };
        readULEB(block, cursor);
        return cursor.p === block.length;
    }
    return false;
}

const { readSections, parseAbbrev, readULEB } = require("./binary");
const { cstr } = require("./binary");
const { createFormReader } = require("./forms");
// Whole-parse safety budgets. Tests may lower them through options.budgets to exercise degradation
// without millions of DIEs; an override can never raise a budget above its production value.
const DEFAULT_BUDGETS = Object.freeze({
    dies: 2000000,
    units: 20000,
    abbrevs: 20000,
    attrs: 200000,
    sectionBytes: 32 * 1024 * 1024,
    companionBytes: 64 * 1024 * 1024
});
function parseBudgets(overrides) {
    const budgets = { ...DEFAULT_BUDGETS };
    for (const key of Object.keys(DEFAULT_BUDGETS)) {
        const value = overrides?.[key];
        if (Number.isSafeInteger(value) && value > 0 && value < DEFAULT_BUDGETS[key]) budgets[key] = value;
    }
    return budgets;
}
// Counts unit headers from `from` without decoding DIEs; used only to report what a partial parse dropped.
function countUnits(data, from, end) {
    let count = 0;
    let p = from;
    while (p + 4 <= end) {
        let length = data.readUInt32LE(p);
        let header = 4;
        if (length === 0xffffffff) {
            if (p + 12 > end) break;
            const length64 = data.readBigUInt64LE(p + 4);
            if (length64 > BigInt(Number.MAX_SAFE_INTEGER)) break;
            length = Number(length64);
            header = 12;
        }
        if (!length) break;
        count++;
        p += header + length;
    }
    return count;
}
function _parseDwarfInternal(buffer, options = {}) {
    const elf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const diagnostics = [];
    const budgets = parseBudgets(options.budgets);
    let totalUnits = 0;
    const sectionBudget = { decoded: 0, max: budgets.sectionBytes };
    const sections = readSections(elf, diagnostics, sectionBudget);
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
    let str, lineStr, strOffsets;
    const resolveStrx = (index, base, width = 4, strings = { str, strOffsets }) => {
        const { str, strOffsets } = strings;
        if (!strOffsets || !str) return "";
        const entryOff = base + index * width;
        if (!Number.isSafeInteger(entryOff) || entryOff < 0 || entryOff + width > strOffsets.size) return "";
        const value =
            width === 8 ? strOffsets.data.readBigUInt64LE(entryOff) : BigInt(strOffsets.data.readUInt32LE(entryOff));
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? cstr(str.data, Number(value)) : "";
    };

    // 读取单个属性值并推进游标

    const dies = new Map(); // 节内偏移 → DIE 记录
    const childrenMap = new Map(); // 父 DIE 偏移 → [子 DIE 偏移]
    const parentOf = new Map(); // 子 DIE 偏移 → 父 DIE 偏移（构造 C++ 限定名用）
    const variableOffsets = []; // 所有变量 DIE；跨 CU 的 origin 继承需在完整解析后处理
    const subprogramOffsets = []; // 所有子程序 DIE（函数显示名用）
    const signatures = new Map();
    const units = [];
    const skippedOffsets = []; // Sorted offsets only; skipped DIEs allocate no records or relationship entries.
    const inputs = [{ sections, filePath: options.filePath, parent: null }];
    let sectionBase = 0;
    let externalBytes = 0;
    const loaded = new Set();
    const companions = [];
    // §2：缩写缓存改为有界 LRU，并以全局预算约束跨 CU 的缩写/属性总量。
    // abbrevOff 是文件可控的 u32，旧实现以它为键无界缓存，N 个不同偏移
    // 就能让 N 份完整缩写表同时存活，直至扩展宿主 OOM。
    const MAX_ABBREV_CACHE_ENTRIES = 8;
    const abbrevCache = new Map();
    const abbrevBudget = { abbrevs: 0, attrs: 0, maxAbbrevs: budgets.abbrevs, maxAttrs: budgets.attrs };
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
    const MAX_DIES_TOTAL = budgets.dies;
    let totalDies = 0;
    // A budget error keeps every complete unit: the journal records what the unit being parsed added,
    // so that unit alone is rolled back and nothing half-parsed can reach type or layout building.
    let journal = null;
    let partial = null;
    const position = { inputIndex: 0, sectionName: null, offset: 0 };
    const rollbackUnit = () => {
        if (!journal) return;
        for (const key of journal.keys) {
            dies.delete(key);
            childrenMap.delete(key);
            parentOf.delete(key);
        }
        units.length = journal.units;
        variableOffsets.length = journal.variables;
        subprogramOffsets.length = journal.subprograms;
        skippedOffsets.length = journal.skipped;
        if (journal.signature !== undefined) signatures.delete(journal.signature);
        for (const [input, parent] of journal.parents) input.parent = parent;
        journal = null;
    };
    // A retry reuses decoded sections and companion inputs. Each pass counts every DIE
    // (including terminators) with the original budgets, and there can be at most two passes.
    let retainLocals = false;
    const wasSkipped = (ref) => {
        let left = 0;
        let right = skippedOffsets.length;
        while (left < right) {
            const middle = Math.floor((left + right) / 2);
            if (skippedOffsets[middle] < ref) left = middle + 1;
            else right = middle;
        }
        return skippedOffsets[left] === ref;
    };
    for (let pass = 0; pass < 2; pass++) {
        const passDiagnostics = pass === 0 ? diagnostics : [];
        try {
            for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
                const input = inputs[inputIndex];
                str = input.sections.get(".debug_str");
                lineStr = input.sections.get(".debug_line_str");
                strOffsets = input.sections.get(".debug_str_offsets");
                for (const sectionName of [".debug_info", ".debug_types"]) {
                    const section = input.sections.get(sectionName);
                    if (!section) continue;
                    const buf = section.data;
                    const infoEnd = section.size;
                    const abbrevSec = input.sections.get(".debug_abbrev");
                    if (!abbrevSec) continue;
                    abbrevCache.clear();
                    let p = 0;
                    while (p + 4 <= infoEnd) {
                        Object.assign(position, { inputIndex, sectionName, offset: p });
                        if (++totalUnits > budgets.units)
                            throw Object.assign(new Error("DWARF compilation unit budget exceeded"), {
                                code: "DWARF_BUDGET_EXCEEDED"
                            });
                        const cuStart = p;
                        journal = {
                            units: units.length,
                            variables: variableOffsets.length,
                            subprograms: subprogramOffsets.length,
                            skipped: skippedOffsets.length,
                            keys: [],
                            signature: undefined,
                            parents: []
                        };
                        let unitLength = buf.readUInt32LE(p);
                        p += 4;
                        let offsetSize = 4;
                        if (unitLength === 0xffffffff) {
                            if (p + 8 > infoEnd) {
                                appendDiagnostic(passDiagnostics, {
                                    code: "DWARF_CU_INVALID",
                                    stage: "header",
                                    offset: cuStart,
                                    message: "Truncated DWARF64 header"
                                });
                                break;
                            }
                            const length64 = buf.readBigUInt64LE(p);
                            p += 8;
                            if (length64 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Oversized DWARF64 unit");
                            unitLength = Number(length64);
                            offsetSize = 8;
                        }
                        const headerSize = offsetSize === 8 ? 12 : 4;
                        if (unitLength === 0) {
                            appendDiagnostic(passDiagnostics, {
                                code: "DWARF_UNSUPPORTED",
                                stage: "header",
                                offset: cuStart,
                                message: "Unsupported DWARF unit length"
                            });
                            break;
                        }
                        const cuEnd = Math.min(cuStart + headerSize + unitLength, infoEnd);
                        const cuBuffer = buf.subarray(0, cuEnd);
                        const readFormValue = createFormReader({ buf: cuBuffer, str, lineStr });
                        try {
                            const version = buf.readUInt16LE(p);
                            p += 2;
                            if (![2, 3, 4, 5].includes(version))
                                throw new Error("Unsupported DWARF version " + version);
                            const readOffset = () => {
                                const value = offsetSize === 8 ? buf.readBigUInt64LE(p) : BigInt(buf.readUInt32LE(p));
                                p += offsetSize;
                                if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Oversized DWARF offset");
                                return Number(value);
                            };
                            let addrSize,
                                abbrevOff,
                                unitType = sectionName === ".debug_types" ? 2 : 1;
                            if (version >= 5) {
                                unitType = buf[p++];
                                addrSize = buf[p];
                                p += 1;
                                abbrevOff = readOffset();
                            } else {
                                abbrevOff = readOffset();
                                addrSize = buf[p];
                                p += 1;
                            }
                            const unit = {
                                sectionBase,
                                cuStart,
                                version,
                                offsetSize,
                                input,
                                strings: { str, strOffsets },
                                addrSize
                            };
                            unit.isType = [2, 6].includes(unitType);
                            if ([2, 6].includes(unitType)) {
                                const signature = buf.subarray(p, p + 8).toString("hex");
                                p += 8;
                                const target = sectionBase + cuStart + readOffset();
                                if (signatures.has(signature) && signatures.get(signature) !== target) {
                                    // Identical type units can occur in multiple split files; the signature is their identity.
                                    unit.duplicateSignature = signature;
                                } else {
                                    if (!signatures.has(signature)) journal.signature = signature;
                                    signatures.set(signature, target);
                                }
                            } else if ([4, 5].includes(unitType)) {
                                unit.dwoId = buf.readBigUInt64LE(p).toString();
                                p += 8;
                            } else if (![1, 3].includes(unitType))
                                throw new Error("Unsupported DWARF unit type " + unitType);
                            if (cuStart + headerSize + unitLength > infoEnd || p > cuEnd)
                                throw new Error("Truncated DWARF unit");
                            unit.addrBase = input.parent?.addrBase || 0;
                            unit.addresses = input.sections.get(".debug_addr") || input.parent?.addresses;
                            units.push(unit);
                            if (retainLocals)
                                for (const companionInput of inputs) {
                                    const parent = companionInput.parent;
                                    if (
                                        parent?.input === input &&
                                        parent.sectionBase === sectionBase &&
                                        parent.cuStart === cuStart
                                    ) {
                                        journal.parents.push([companionInput, parent]);
                                        companionInput.parent = unit;
                                    }
                                }
                            let abbrev = abbrevCacheGet(abbrevOff);
                            if (!abbrev) {
                                abbrev = parseAbbrev(abbrevSec.data, abbrevOff, abbrevBudget);
                                abbrevCacheSet(abbrevOff, abbrev);
                            }
                            const cuRel = sectionBase + cuStart;
                            let strOffsetsBase = input.parent && version < 5 ? 0 : offsetSize === 8 ? 16 : 8;
                            const readRecord = (cur, ab) => {
                                const rec = { tag: ab.tag, unit };
                                for (const attr of ab.attrs) {
                                    const formContext = {
                                        addrSize,
                                        cuRel,
                                        sectionBase,
                                        offsetSize,
                                        exactInteger: attr.at === 0x1c,
                                        implicit: attr.implicit
                                    };
                                    const raw = readFormValue(cur, attr.form, formContext);
                                    const v =
                                        raw?.integer64 &&
                                        BigInt(raw.integer64) >= BigInt(Number.MIN_SAFE_INTEGER) &&
                                        BigInt(raw.integer64) <= BigInt(Number.MAX_SAFE_INTEGER)
                                            ? Number(raw.integer64)
                                            : raw;
                                    switch (attr.at) {
                                        case 0x1b: // DW_AT_comp_dir
                                            if (v?.str !== undefined) unit.compDir = v.str;
                                            else if (v?.strx !== undefined) unit.compDirIndex = v.strx;
                                            break;
                                        case 0x76: // DW_AT_dwo_name
                                        case 0x2130: // DW_AT_GNU_dwo_name
                                            if (v?.str !== undefined) unit.dwoName = v.str;
                                            else if (v?.strx !== undefined) unit.dwoNameIndex = v.strx;
                                            break;
                                        case 0x2131: // DW_AT_GNU_dwo_id
                                            unit.dwoId = raw?.integer64;
                                            break;
                                        case 0x73: // DW_AT_addr_base
                                        case 0x2133: // DW_AT_GNU_addr_base
                                            unit.addrBase = v;
                                            break;
                                        case 0x1c: // DW_AT_const_value (enumerator or template argument)
                                            rec.constantValue = v;
                                            break;
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
                                        case DW_AT_artificial:
                                            rec.isArtificial = !!v;
                                            break;
                                        case DW_AT_type:
                                            if (v && v.ref !== undefined) rec.typeRef = v.ref;
                                            else if (v?.signature) rec.typeSignature = v.signature;
                                            break;
                                        case 0x69: // DW_AT_signature: a declaration redirects to its type unit.
                                            rec.definitionSignature = v?.signature;
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
                                        case 0x6d: // DW_AT_enum_class
                                            rec.enumClass = !!v;
                                            break;
                                        case DW_AT_location:
                                            if (v && v.block && v.block.length >= 1) {
                                                rec.hasAddr = false;
                                                if (addrSize === 4 && v.block[0] === 0x03 && v.block.length === 5) {
                                                    rec.address = v.block.readUInt32LE(1);
                                                    rec.hasAddr = true;
                                                } else if ([0xa1, 0xfb].includes(v.block[0])) {
                                                    const cursor = { p: 1 };
                                                    const index = readULEB(v.block, cursor);
                                                    if (cursor.p === v.block.length) {
                                                        rec.addressIndex = index;
                                                        rec.hasAddr = true;
                                                    }
                                                }
                                            }
                                            break;
                                        case DW_AT_declaration:
                                            rec.isDecl = !!v;
                                            break;
                                        case DW_AT_str_offsets_base:
                                            if (typeof v === "number") strOffsetsBase = v;
                                            break;
                                        case DW_AT_data_member_location:
                                            if (v?.block) rec.memberExpression = Array.from(v.block);
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
                                            if (isEmptyUpperBound(raw, formContext.form)) rec.subrangeCount ??= 0;
                                            else if (typeof v === "number") rec.subrangeUpperBound = v;
                                            else if (raw?.integer64) rec.subrangeUpperBound = Infinity;
                                            break;
                                    }
                                }
                                return rec;
                            };
                            const readSkippedAttributes = (cur, ab) => {
                                let keep = false;
                                for (const attr of ab.attrs) {
                                    const raw = readFormValue(cur, attr.form, {
                                        addrSize,
                                        cuRel,
                                        sectionBase,
                                        offsetSize,
                                        exactInteger: attr.at === 0x1c,
                                        implicit: attr.implicit
                                    });
                                    // Read every form, including indirect/block forms, with the usual validation.
                                    // Static locals and signature-bearing records retain their original metadata.
                                    if (
                                        raw?.signature ||
                                        (attr.at === DW_AT_location && hasStaticLocation(raw, addrSize))
                                    )
                                        keep = true;
                                }
                                return keep;
                            };
                            const storeRecord = (dieOff, rec, parentOff) => {
                                dies.set(dieOff, rec);
                                journal.keys.push(dieOff);
                                if (rec.tag === DW_TAG_variable) variableOffsets.push(dieOff);
                                if (rec.tag === DW_TAG_subprogram) subprogramOffsets.push(dieOff);
                                if (parentOff === undefined) return;
                                let siblings = childrenMap.get(parentOff);
                                if (!siblings) {
                                    childrenMap.set(parentOff, (siblings = []));
                                    journal.keys.push(parentOff);
                                }
                                siblings.push(dieOff);
                                parentOf.set(dieOff, parentOff);
                            };
                            const cur = { p };
                            try {
                                const parentStack = []; // Deferred scope frames; no relationship entry until needed.
                                while (cur.p < cuEnd) {
                                    if (++totalDies > MAX_DIES_TOTAL)
                                        throw Object.assign(new Error("DWARF DIE budget exceeded"), {
                                            code: "DWARF_BUDGET_EXCEEDED"
                                        });
                                    const dieOff = sectionBase + cur.p;
                                    const code = readULEB(cuBuffer, cur);
                                    if (code === 0) {
                                        // 兄弟链结束标记：弹出当前父级
                                        if (parentStack.length) parentStack.pop();
                                        continue;
                                    }
                                    const ab = abbrev.get(code);
                                    if (!ab) throw new Error("unknown abbrev code");
                                    const parent = parentStack[parentStack.length - 1];
                                    const attrStart = cur.p;
                                    const skipLocal =
                                        !retainLocals &&
                                        parent?.inSubprogram &&
                                        LOCAL_SCOPES.has(parent.ab.tag) &&
                                        LOCAL_TAGS.has(ab.tag) &&
                                        !ab.attrs.some((attr) => UNIT_ATTRIBUTES.has(attr.at));
                                    let rec;
                                    try {
                                        if (!skipLocal) rec = readRecord(cur, ab);
                                        else if (readSkippedAttributes(cur, ab)) rec = readRecord({ p: attrStart }, ab);
                                    } catch (error) {
                                        // The original parser reserves this relationship before reading attributes.
                                        // Keep malformed type-child counts identical for conservative layout budgets.
                                        if (!skipLocal && parent) {
                                            let siblings = childrenMap.get(parent.dieOff);
                                            if (!siblings) childrenMap.set(parent.dieOff, (siblings = []));
                                            siblings.push(dieOff);
                                            parentOf.set(dieOff, parent.dieOff);
                                            journal.keys.push(parent.dieOff, dieOff);
                                        }
                                        throw error;
                                    }
                                    unit.strBase = strOffsetsBase;
                                    if (rec) {
                                        // Restore only ancestors needed by a kept local/type. Lexical blocks must
                                        // remain in parentOf for local type identity, even though they have no name.
                                        let first = parentStack.length;
                                        while (first > 0 && !dies.has(parentStack[first - 1].dieOff)) first--;
                                        for (let index = first; index < parentStack.length; index++) {
                                            const frame = parentStack[index];
                                            const ancestor = readRecord({ p: frame.attrStart }, frame.ab);
                                            ancestor.base = frame.base;
                                            storeRecord(frame.dieOff, ancestor, parentStack[index - 1]?.dieOff);
                                        }
                                        rec.base = strOffsetsBase;
                                        storeRecord(dieOff, rec, parent?.dieOff);
                                    } else skippedOffsets.push(dieOff);
                                    if (ab.hasChildren)
                                        parentStack.push({
                                            dieOff,
                                            ab,
                                            attrStart,
                                            base: strOffsetsBase,
                                            inSubprogram: parent?.inSubprogram || ab.tag === DW_TAG_subprogram
                                        });
                                }
                            } catch (e) {
                                // 全局预算耗尽必须停止继续解析，交由外层回滚当前 CU，而不是吞掉后继续累积内存。
                                if (e.code === "DWARF_BUDGET_EXCEEDED") throw e;
                                appendDiagnostic(passDiagnostics, {
                                    code: /unknown DWARF form/.test(e.message)
                                        ? "DWARF_UNSUPPORTED"
                                        : "DWARF_CU_INVALID",
                                    stage: "attributes",
                                    offset: p,
                                    message: e.message
                                });
                            }
                        } catch (e) {
                            if (e.code === "DWARF_BUDGET_EXCEEDED") throw e;
                            appendDiagnostic(passDiagnostics, {
                                code: "DWARF_CU_INVALID",
                                stage: "header",
                                offset: p,
                                message: e.message
                            });
                        }
                        p = cuEnd;
                        journal = null;
                    }
                    journal = null;
                    sectionBase += infoEnd + 1;
                }
                position.sectionName = null;
                for (const unit of units.filter(
                    (entry) => entry.input === input && (entry.dwoName || entry.dwoNameIndex !== undefined)
                )) {
                    unit.dwoName ||= resolveStrx(unit.dwoNameIndex, unit.strBase, unit.offsetSize, unit.strings);
                    unit.compDir ||= resolveStrx(unit.compDirIndex, unit.strBase, unit.offsetSize, unit.strings);
                    if (retainLocals) continue; // Reuse companion sections without repeating I/O or decompression.
                    if (!options.filePath) {
                        appendDiagnostic(passDiagnostics, {
                            code: "DWARF_COMPANION_MISSING",
                            stage: "sections",
                            message: "Split DWARF requires the ELF path and its matching .dwo file"
                        });
                        continue;
                    }
                    try {
                        if (inputs.length >= 33) throw new Error("Split DWARF companion count exceeds 32");
                        const companion = require("./files").readCompanion(
                            unit,
                            options.filePath,
                            budgets.companionBytes - externalBytes
                        );
                        if (loaded.has(companion.path)) continue;
                        loaded.add(companion.path);
                        companions.push(companion.identity);
                        externalBytes += companion.buffer.length;
                        inputs.push({
                            sections: readSections(companion.buffer, diagnostics, sectionBudget),
                            filePath: companion.path,
                            parent: unit
                        });
                    } catch (error) {
                        // A companion over the shared file or section budget ends the parse like any other budget.
                        if (error.code === "DWARF_BUDGET_EXCEEDED") throw error;
                        if (error.paths) companions.push(...error.paths);
                        appendDiagnostic(passDiagnostics, {
                            code: error.code || "DWARF_COMPANION_MISSING",
                            stage: "sections",
                            message: error.message
                        });
                    }
                }
            }
        } catch (error) {
            if (error.code !== "DWARF_BUDGET_EXCEEDED") throw error;
            rollbackUnit();
            partial = { reason: error.message, ...position };
        }
        // Any retained reference to a skipped DIE requires full retention. Most producers never
        // need this retry; it also covers backwards, cross-CU and cyclic origin/specification graphs.
        let needsLocals = false;
        if (skippedOffsets.length)
            for (const die of dies.values()) {
                if (
                    [
                        die.typeRef,
                        die.abstractOriginRef,
                        die.specificationRef,
                        signatures.get(die.typeSignature),
                        signatures.get(die.definitionSignature)
                    ].some((ref) => ref !== undefined && !dies.has(ref) && wasSkipped(ref))
                ) {
                    needsLocals = true;
                    break;
                }
            }
        if (!needsLocals) break;
        retainLocals = true;
        partial = null;
        dies.clear();
        childrenMap.clear();
        parentOf.clear();
        variableOffsets.length = 0;
        subprogramOffsets.length = 0;
        skippedOffsets.length = 0;
        signatures.clear();
        units.length = 0;
        sectionBase = 0;
        totalUnits = 0;
        totalDies = 0;
        abbrevBudget.abbrevs = 0;
        abbrevBudget.attrs = 0;
        abbrevCache.clear();
    }

    if (partial) {
        // Everything from the stopping point on was dropped: the rest of that section, its later
        // sections and every later input. A stop while loading companions keeps that input's units.
        const order = [".debug_info", ".debug_types"];
        let droppedUnits = 0;
        let droppedBytes = 0;
        for (let index = partial.inputIndex; index < inputs.length; index++) {
            for (const name of order) {
                const section = inputs[index].sections.get(name);
                if (!section) continue;
                let from = 0;
                if (index === partial.inputIndex) {
                    if (partial.sectionName === null || order.indexOf(name) < order.indexOf(partial.sectionName))
                        continue;
                    if (name === partial.sectionName) from = partial.offset;
                }
                droppedUnits += countUnits(section.data, from, section.size);
                droppedBytes += section.size - from;
            }
        }
        const budget =
            /^DWARF (.+) budget exceeded$/.exec(partial.reason)?.[1] ||
            (/companion/i.test(partial.reason) ? "companion" : "safety");
        const loaded = units.length;
        const total = loaded + droppedUnits;
        partial = { budget, loadedUnits: loaded, droppedUnits, droppedBytes };
        // Bypass the diagnostic cap: the diagnostic budget itself may be what stopped the parse.
        diagnostics.unshift({
            code: "DWARF_PARTIAL",
            stage: "parse",
            message: `DWARF types are partial: ${loaded} of ${total} units loaded; parsing stopped at the ${budget} budget`,
            i18nKey: "elfDiag.partial",
            i18nParams: { loaded, total, budget },
            ...partial
        });
    }

    for (const input of inputs.filter((entry) => entry.parent)) {
        input.valid = units.some(
            (unit) => unit.input === input && !unit.isType && unit.dwoId && unit.dwoId === input.parent.dwoId
        );
        if (!input.valid)
            appendDiagnostic(diagnostics, {
                code: "DWARF_COMPANION_MISMATCH",
                stage: "sections",
                message: "Split DWARF compilation-unit identity does not match its ELF"
            });
    }
    // 统一解析 strx 名称
    for (const [key, d] of dies) if (d.unit.input.parent && !d.unit.input.valid) dies.delete(key);
    for (const d of dies.values()) {
        if (d.typeSignature) d.typeRef = signatures.get(d.typeSignature);
        if (d.typeSignature && d.typeRef === undefined)
            appendDiagnostic(diagnostics, {
                code: "DWARF_TYPE_UNRESOLVED",
                stage: "types",
                message: "DWARF type signature is unavailable"
            });
        if (d.definitionSignature) {
            const definitionRef = signatures.get(d.definitionSignature);
            if (dies.has(definitionRef)) {
                d.tag = DW_TAG_typedef;
                d.typeRef = definitionRef;
                delete d.isDecl;
            } else
                appendDiagnostic(diagnostics, {
                    code: "DWARF_TYPE_UNRESOLVED",
                    stage: "types",
                    message: "DWARF type signature is unavailable"
                });
        }
        if (d.addressIndex !== undefined) {
            const off = d.unit.addrBase + d.addressIndex * d.unit.addrSize;
            const addresses = d.unit.addresses?.data;
            if (
                addresses &&
                d.unit.addrSize === 4 &&
                Number.isSafeInteger(off) &&
                off >= 0 &&
                off + 4 <= addresses.length
            )
                d.address = addresses.readUInt32LE(off);
            else
                appendDiagnostic(diagnostics, {
                    code: "DWARF_ADDRESS_UNRESOLVED",
                    stage: "attributes",
                    message: "Split DWARF address index is unavailable"
                });
        }
        if (d.name === undefined && d.strx !== undefined)
            d.name = resolveStrx(d.strx, d.base, d.unit.offsetSize, d.unit.strings);
        if (d.linkageName === undefined && d.linkageStrx !== undefined)
            d.linkageName = resolveStrx(d.linkageStrx, d.base, d.unit.offsetSize, d.unit.strings);
    }

    // Unit root names identify the defining source file; split units inherit the skeleton's.
    for (const d of dies.values())
        if (UNIT_TAGS.has(d.tag) && typeof d.name === "string" && !/[\x00-\x1f]/.test(d.name)) {
            d.unit.sourceName ||= d.name;
            if (!d.unit.compDir && d.unit.compDirIndex !== undefined)
                d.unit.compDir = resolveStrx(d.unit.compDirIndex, d.unit.strBase, d.unit.offsetSize, d.unit.strings);
        }

    // Out-of-line nested definitions can carry only DW_AT_specification.
    for (const die of dies.values()) {
        if (![DW_TAG_structure_type, DW_TAG_class_type, DW_TAG_union_type, DW_TAG_enumeration_type].includes(die.tag))
            continue;
        let inherited = die;
        const seen = new Set();
        while (!die.name && inherited?.specificationRef !== undefined && seen.size < 16) {
            if (seen.has(inherited.specificationRef)) break;
            seen.add(inherited.specificationRef);
            inherited = dies.get(inherited.specificationRef);
            die.name ||= inherited?.name;
        }
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
    for (const [off, die] of dies) {
        if ((SCOPE_TAGS.has(die.tag) || die.tag === DW_TAG_enumeration_type) && die.name)
            die.qualifiedTypeName = buildQualifiedName(die.specificationRef ?? off, die.name);
    }
    for (const [off, die] of dies) {
        if (die.tag !== DW_TAG_enumerator || !die.name) continue;
        const parent = dies.get(parentOf.get(off));
        die.qualifiedName =
            parent?.enumClass && parent.qualifiedTypeName
                ? parent.qualifiedTypeName + "::" + die.name
                : buildQualifiedName(off, die.name);
    }

    normalizeTypeDeclarations({ dies, childrenMap, parentOf });

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
        if (!concrete?.hasAddr || concrete.invalidUnit) continue;
        const identity = resolveVariableIdentity(dieOff);
        if (!identity.name) continue;
        variables.push({
            ...concrete,
            name: identity.name,
            typeRef: identity.typeRef,
            linkageName: identity.linkageName,
            qualifiedName: buildQualifiedName(identity.scopeDieOff, identity.name),
            sourceFile: unitSourceFile(concrete.unit)
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

    return { dies, childrenMap, parentOf, resolveStrx, variables, subprograms, diagnostics, companions, partial };
}
module.exports = { parseDwarfInternal: _parseDwarfInternal, DEFAULT_BUDGETS };
