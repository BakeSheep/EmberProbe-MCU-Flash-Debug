"use strict";
const { arrayDimensions } = require("./subranges");
const {
    MAX_COMPOSITE_DEPTH,
    MAX_COMPOSITE_NODES,
    MAX_COMPOSITE_BYTES,
    MAX_TYPE_ALIASES,
    MAX_TYPE_INFO_DEPTH
} = require("./layoutLimits");
const EXPANSION_TYPE_REF = Symbol("layoutExpansionType");
const typeInfoHeights = new WeakMap();
const { createTypeComparer, declarationMatchesDefinition, isTypeDeclaration } = require("./typeIdentity");
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
    DW_TAG_reference_type,
    DW_TAG_rvalue_reference_type,
    DW_TAG_ptr_to_member_type,
    DW_TAG_subroutine_type,
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
    DW_ATE_unsigned_char,
    DW_ATE_UTF
} = require("./constants");
const WRAPPERS = new Set([DW_TAG_typedef, DW_TAG_const_type, DW_TAG_volatile_type, DW_TAG_restrict_type]);
function typeFlags(info) {
    return {
        ...Object.fromEntries(
            ["isBoolean", "isConst", "isReference", "isMemberPointer", "isEnum", "enumEncodingInferred"]
                .filter((key) => info?.[key])
                .map((key) => [key, true])
        ),
        ...(info?.enumInfo ? { enumInfo: info.enumInfo } : {})
    };
}

function enumMembers(ref, die, dies, childrenMap) {
    const entries = [];
    let bytes = 0;
    for (const off of childrenMap.get(ref) || []) {
        const child = dies.get(off);
        if (child?.tag !== DW_TAG_enumerator) continue;
        const raw = child.constantValue;
        const value = Number.isSafeInteger(raw) ? String(raw) : raw?.integer64;
        if (!child.name || typeof value !== "string" || !/^-?\d{1,20}$/.test(value)) return null;
        const name = child.qualifiedName || child.name;
        bytes += Buffer.byteLength(name) + value.length;
        if (entries.length >= 1024 || bytes > 65536)
            throw Object.assign(new Error("DWARF enum member budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
        entries.push({ name, value });
    }
    return entries.length ? { typeName: die.qualifiedTypeName || die.name || "", entries } : null;
}
function bindVariableSymbols(parsed, symbols) {
    const byAddress = new Map();
    for (const symbol of symbols) {
        const previous = byAddress.get(symbol.address);
        byAddress.set(symbol.address, previous === undefined ? symbol : null);
    }
    return {
        ...parsed,
        variables: parsed.variables.map((variable) => {
            if (variable.linkageName || variable.address === undefined) return variable;
            const symbol = byAddress.get(variable.address);
            // Internal-linkage C++ globals and C function statics (e.g. Idle_Stack.2)
            // can have different ELF names and no DW_AT_linkage_name. Bind only an
            // exact, unique static address; never strip suffixes or guess by name.
            const numberedStatic =
                symbol?.name.startsWith(variable.name + ".") &&
                /^\d+$/.test(symbol.name.slice(variable.name.length + 1));
            return symbol && (/^_Z/.test(symbol.name) || numberedStatic)
                ? { ...variable, linkageName: symbol.name }
                : variable;
        })
    };
}
function encodingToWatchType(encoding, size) {
    if (encoding === DW_ATE_float) return size === 4 ? "f32" : size === 8 ? "f64" : "";
    if (encoding === DW_ATE_signed || encoding === DW_ATE_signed_char) {
        if (size === 1) return "i8";
        if (size === 2) return "i16";
        if (size === 4) return "i32";
        if (size === 8) return "i64";
        return "";
    }
    if (
        encoding === DW_ATE_unsigned ||
        encoding === DW_ATE_unsigned_char ||
        encoding === DW_ATE_boolean ||
        encoding === DW_ATE_UTF
    ) {
        if (size === 1) return "u8";
        if (size === 2) return "u16";
        if (size === 4) return "u32";
        if (size === 8) return "u64";
        return "";
    }
    return "";
}
function unwrapAliases(ref, dies, active = new Set()) {
    const aliases = [];
    const seen = new Set();
    while (WRAPPERS.has(dies.get(ref)?.tag)) {
        if (seen.has(ref) || active.has(ref)) return { ref, aliases, unobservable: "type-cycle" };
        if (aliases.length >= MAX_TYPE_ALIASES) return { ref, aliases, unobservable: "expansion-budget" };
        seen.add(ref);
        aliases.push([ref, dies.get(ref)]);
        ref = dies.get(ref).typeRef;
    }
    return { ref, aliases };
}

function _resolveTypeInfo(refKey, dies, childrenMap, cache, depth = 0, active = new Set()) {
    if (WRAPPERS.has(dies.get(refKey)?.tag)) {
        const { ref, aliases, unobservable } = unwrapAliases(refKey, dies, active);
        if (unobservable) return { kind: "unknown", typeName: "", watchType: "", byteSize: 0, unobservable };
        let info = _resolveTypeInfo(ref, dies, childrenMap, cache, depth, active);
        const height = typeInfoHeights.get(info) || 0;
        for (let index = aliases.length - 1; index >= 0; index--) {
            const [aliasRef, alias] = aliases[index];
            info = {
                ...info,
                ...(alias.tag === DW_TAG_typedef
                    ? {
                          typeName: alias.qualifiedTypeName || alias.name || info.typeName,
                          byteSize: alias.byteSize || info.byteSize
                      }
                    : {}),
                ...(alias.tag === DW_TAG_const_type ? { isConst: true } : {})
            };
            typeInfoHeights.set(info, height);
            if (!info.unobservable) cache.set(aliasRef, info);
        }
        return info;
    }
    const placeholder = { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
    if (active.has(refKey)) return { ...placeholder, unobservable: "type-cycle" };
    if (depth > MAX_TYPE_INFO_DEPTH) return { ...placeholder, unobservable: "expansion-budget" };
    const cached = cache.get(refKey);
    if (cached && depth + (typeInfoHeights.get(cached) || 0) <= MAX_TYPE_INFO_DEPTH) return cached;
    const d = dies.get(refKey);
    if (!d) return placeholder;
    const nm = d.qualifiedTypeName || d.name || "";
    let height = 0;
    let unobservable;
    const resolveInner = (ref) => {
        const info = _resolveTypeInfo(ref, dies, childrenMap, cache, depth + 1, active);
        height = Math.max(height, 1 + (typeInfoHeights.get(info) || 0));
        unobservable ||= info.unobservable;
        return info;
    };
    let result;
    active.add(refKey);
    try {
        switch (d.tag) {
            case DW_TAG_base_type:
                result = {
                    kind: "scalar",
                    typeName: nm || "base",
                    watchType: encodingToWatchType(d.encoding, d.byteSize || 0),
                    byteSize: d.byteSize || 0,
                    isBoolean: d.encoding === DW_ATE_boolean
                };
                break;
            case DW_TAG_pointer_type: {
                const inner = d.typeRef !== undefined ? resolveInner(d.typeRef) : { typeName: "void" };
                result = { kind: "scalar", typeName: (inner.typeName || "void") + " *", watchType: "u32", byteSize: 4 };
                break;
            }
            case DW_TAG_reference_type: {
                const inner = d.typeRef !== undefined ? resolveInner(d.typeRef) : { typeName: "void" };
                result = {
                    kind: "scalar",
                    typeName: (inner.typeName || "void") + " &",
                    watchType: "u32",
                    byteSize: d.byteSize || 4,
                    isReference: true
                };
                break;
            }
            case DW_TAG_rvalue_reference_type: {
                const inner = d.typeRef !== undefined ? resolveInner(d.typeRef) : { typeName: "void" };
                result = {
                    kind: "scalar",
                    typeName: (inner.typeName || "void") + " &&",
                    watchType: "u32",
                    byteSize: d.byteSize || 4,
                    isReference: true
                };
                break;
            }
            case DW_TAG_ptr_to_member_type: {
                const inner = d.typeRef !== undefined ? resolveInner(d.typeRef) : { typeName: "void" };
                // ARM GCC omits DW_AT_byte_size here. A member function pointer is
                // two words (function/virtual slot plus this adjustment), not a data pointer.
                const byteSize = d.byteSize || (inner.kind === "function" ? 8 : 4);
                result = {
                    kind: "scalar",
                    typeName: (inner.typeName || "function") + " member pointer",
                    watchType: encodingToWatchType(DW_ATE_unsigned, byteSize),
                    byteSize,
                    isMemberPointer: true
                };
                break;
            }
            case DW_TAG_subroutine_type:
                result = { kind: "function", typeName: "function", watchType: "", byteSize: 0 };
                break;
            case DW_TAG_enumeration_type: {
                const underlying = d.typeRef !== undefined ? resolveInner(d.typeRef) : null;
                const byteSize = d.byteSize || underlying?.byteSize || 4;
                const underlyingEncoding = underlying?.watchType?.startsWith("u")
                    ? DW_ATE_unsigned
                    : underlying?.watchType?.startsWith("i")
                      ? DW_ATE_signed
                      : undefined;
                const enumInfo = enumMembers(refKey, d, dies, childrenMap);
                const declaredEncoding = d.encoding ?? underlyingEncoding;
                // Legacy DWARF can omit the underlying encoding. Negative members prove
                // signed storage; nonnegative members can be read as raw unsigned values.
                // Such inferred types remain read-only because the original type is uncertain.
                const encoding =
                    declaredEncoding ??
                    (enumInfo
                        ? enumInfo.entries.some((entry) => BigInt(entry.value) < 0n)
                            ? DW_ATE_signed
                            : DW_ATE_unsigned
                        : undefined);
                const watchType = encodingToWatchType(encoding, byteSize);
                if (enumInfo && watchType) {
                    const bits = BigInt(byteSize * 8);
                    for (const entry of enumInfo.entries) {
                        let value = BigInt(entry.value);
                        if (watchType.startsWith("i") && value >= 1n << (bits - 1n) && value < 1n << bits)
                            value -= 1n << bits;
                        entry.value = value.toString();
                    }
                }
                result = {
                    kind: "scalar",
                    typeName: nm ? "enum " + (d.qualifiedTypeName || nm) : "enum",
                    watchType,
                    byteSize,
                    isEnum: true,
                    ...(declaredEncoding === undefined && watchType ? { enumEncodingInferred: true } : {}),
                    ...(enumInfo ? { enumInfo } : {})
                };
                break;
            }
            case DW_TAG_structure_type:
                result = {
                    kind: "struct",
                    typeName: nm ? "struct " + nm : "struct",
                    watchType: "",
                    byteSize: d.byteSize || 0
                };
                break;
            case DW_TAG_class_type:
                result = {
                    kind: "class",
                    typeName: nm ? "class " + nm : "class",
                    watchType: "",
                    byteSize: d.byteSize || 0
                };
                break;
            case DW_TAG_union_type:
                result = {
                    kind: "union",
                    typeName: nm ? "union " + nm : "union",
                    watchType: "",
                    byteSize: d.byteSize || 0
                };
                break;
            case DW_TAG_array_type: {
                const inner = d.typeRef !== undefined ? resolveInner(d.typeRef) : placeholder;
                // GCC/Clang 不为数组类型发 DW_AT_byte_size，多维数组的元素大小必须按
                // 本层 subrange 维度 × 内层大小推导，否则行 stride 恒为 0、所有行都
                // 解码到第 0 行的地址。单个数组 DIE 挂多个 subrange 的产生器同样按
                // 维度乘积推导。
                const dimensions = arrayDimensions(refKey, dies, childrenMap);
                const dimsProduct = dimensions.reduce((product, count) => product * count, 1);
                result = {
                    kind: "array",
                    typeName: (inner.typeName || "") + "[]".repeat(Math.max(1, dimensions.length)),
                    watchType: "",
                    byteSize: d.byteSize || (dimensions.length ? dimsProduct * (inner.byteSize || 0) : 0),
                    ...(inner.isConst ? { isConst: true } : {})
                };
                break;
            }
            default:
                result = { kind: "unknown", typeName: nm, watchType: "", byteSize: d.byteSize || 0 };
        }
    } finally {
        active.delete(refKey);
    }
    if (unobservable) result = { ...result, watchType: "", unobservable };
    typeInfoHeights.set(result, height);
    // Depth-limited metadata must not poison later, shallower queries. Even complete
    // entries can be reused only when their dependency height fits this position.
    if (!unobservable) cache.set(refKey, result);
    return result;
}
function createVariableTypeIndex(parsed) {
    const { dies, childrenMap, variables } = parsed;
    const typeCache = new Map(),
        byName = new Map(),
        candidates = new Map(),
        ambiguousNames = new Set();
    const equivalent = createTypeComparer(parsed);
    const comparisons = new Map();
    for (const variable of variables) {
        const key = variable.linkageName || variable.name;
        if (!key) continue;
        const previous = byName.get(key);
        if (!previous) {
            byName.set(key, variable);
            candidates.set(key, new Set([variable.typeRef]));
            continue;
        }
        // Same-named statics in different CUs have different addresses; only differing types are ambiguous.
        if (previous.typeRef === variable.typeRef || ambiguousNames.has(key)) continue;
        const prevInfo = _resolveTypeInfo(previous.typeRef, dies, childrenMap, typeCache);
        const curInfo = _resolveTypeInfo(variable.typeRef, dies, childrenMap, typeCache);
        const sameFlags = JSON.stringify(typeFlags(prevInfo)) === JSON.stringify(typeFlags(curInfo));
        if (
            sameFlags &&
            declarationMatchesDefinition(previous.typeRef, variable.typeRef, dies) &&
            prevInfo.typeName.replace(/^(?:class|struct) /, "") === curInfo.typeName.replace(/^(?:class|struct) /, "")
        ) {
            if (isTypeDeclaration(previous.typeRef, dies)) {
                byName.set(key, variable);
                candidates.set(key, new Set([variable.typeRef]));
            }
            continue;
        }
        candidates.get(key).add(variable.typeRef);
        const comparisonKey = previous.typeRef + ":" + variable.typeRef;
        const storageMatches = () => {
            if (!comparisons.has(comparisonKey)) {
                if (comparisons.size >= 64) comparisons.delete(comparisons.keys().next().value);
                comparisons.set(comparisonKey, equivalent(previous.typeRef, variable.typeRef));
            }
            return comparisons.get(comparisonKey);
        };
        if (
            prevInfo.kind !== curInfo.kind ||
            prevInfo.typeName !== curInfo.typeName ||
            prevInfo.byteSize !== curInfo.byteSize ||
            prevInfo.watchType !== curInfo.watchType ||
            !sameFlags ||
            !storageMatches()
        )
            ambiguousNames.add(key);
    }
    return { byName, candidates, ambiguousNames, typeCache };
}
function buildVariableTypes(parsed) {
    const { byName, ambiguousNames, typeCache } = createVariableTypeIndex(parsed);
    const result = new Map();
    for (const [key, variable] of byName) {
        const source = variable.sourceFile ? { sourceFile: variable.sourceFile } : {};
        if (ambiguousNames.has(key)) {
            result.set(key, { ambiguous: true, typeName: "", watchType: "", ...source });
            continue;
        }
        const t = _resolveTypeInfo(variable.typeRef, parsed.dies, parsed.childrenMap, typeCache);
        result.set(key, { kind: t.kind, typeName: t.typeName, watchType: t.watchType, ...typeFlags(t), ...source });
    }
    return result;
}
function _collectMembers(typeDieOff, dies, childrenMap, typeCache) {
    const childOffsets = childrenMap.get(typeDieOff);
    if (!childOffsets) return [];
    const members = [];
    // 基类合成成员（@baseN）置于自身成员之前，保持每条基类路径独立，天然消除跨基类同名歧义。
    let baseIndex = 0;
    for (const childOff of childOffsets) {
        const child = dies.get(childOff);
        if (!child || child.tag !== DW_TAG_inheritance) continue;
        const index = baseIndex++;
        const baseType =
            child.typeRef !== undefined
                ? _resolveTypeInfo(child.typeRef, dies, childrenMap, typeCache)
                : { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
        if (child.virtuality || child.memberOffset === undefined) {
            // 虚基类偏移依赖运行期 vtable，静态阶段不产地址、不出叶子（阶段 3 再接管求址）。
            // unobservable 是稳定的机器代码而非展示文案，消费方只判真值；如需面向用户请走 i18n。
            members.push({
                name: "@base" + index,
                offset: 0,
                byteSize: 0,
                typeName: baseType.typeName,
                kind: baseType.kind,
                isBase: true,
                baseIndex: index,
                ...(child.virtuality ? { virtual: true } : {}),
                unobservable: child.virtuality ? "virtual-base" : "base-location"
            });
            continue;
        }
        /** @type {Record<string, any>} */
        const base = {
            name: "@base" + index,
            offset: child.memberOffset || 0,
            byteSize: baseType.byteSize || 0,
            typeName: baseType.typeName,
            watchType: "",
            kind: baseType.kind,
            isBase: true,
            baseIndex: index,
            ...(baseType.unobservable ? { unobservable: baseType.unobservable } : {})
        };
        if (baseType.kind === "struct" || baseType.kind === "class" || baseType.kind === "union") {
            base.memberTypeRef = child.typeRef;
        }
        members.push(base);
    }
    for (const childOff of childOffsets) {
        const child = dies.get(childOff);
        if (!child || child.tag !== DW_TAG_member) continue;
        if (child.isDecl) continue;
        // Union members implicitly start at zero. Other members need a known location;
        // never turn an unsupported expression into a writable offset-zero field.
        if (
            child.memberLocationUnsupported ||
            (dies.get(typeDieOff)?.tag !== DW_TAG_union_type &&
                child.memberOffset === undefined &&
                !Number.isInteger(child.dataBitOffset))
        ) {
            members.push({
                name: child.name || "",
                offset: 0,
                byteSize: 0,
                unobservable: "member-location"
            });
            continue;
        }
        const name = child.name || "";
        const memberType =
            child.typeRef !== undefined
                ? _resolveTypeInfo(child.typeRef, dies, childrenMap, typeCache)
                : { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
        let byteSize = child.byteSize || memberType.byteSize || 0;
        let offset = child.memberOffset || 0;
        let bitOffset;
        if (Number.isInteger(child.dataBitOffset)) {
            offset = Math.floor(child.dataBitOffset / 8);
            bitOffset = child.dataBitOffset % 8;
        } else if (Number.isInteger(child.bitOffset) && Number.isInteger(child.bitSize) && byteSize > 0) {
            // DWARF4 DW_AT_bit_offset 是从存储单元高位端计数；ELF32 已限定小端。
            bitOffset = byteSize * 8 - child.bitOffset - child.bitSize;
            if (bitOffset >= 8) {
                offset += Math.floor(bitOffset / 8);
                bitOffset %= 8;
            }
        }
        if (Number.isInteger(child.bitSize) && child.bitSize > 0 && Number.isInteger(bitOffset) && bitOffset >= 0) {
            byteSize = Math.ceil((bitOffset + child.bitSize) / 8);
        }
        /** @type {Record<string, any>} */
        const member = {
            name,
            offset,
            byteSize,
            typeName: memberType.typeName,
            watchType: memberType.watchType,
            kind: memberType.kind,
            ...typeFlags(memberType),
            ...(memberType.unobservable ? { unobservable: memberType.unobservable } : {})
        };
        if (Number.isInteger(child.bitSize) && child.bitSize > 0 && Number.isInteger(bitOffset) && bitOffset >= 0) {
            member.bitSize = child.bitSize;
            member.bitOffset = bitOffset;
        }
        // 若成员本身是复合类型，附加嵌套布局信息（按需，延迟到 UI 展开）
        if (
            memberType.kind === "struct" ||
            memberType.kind === "class" ||
            memberType.kind === "union" ||
            memberType.kind === "array"
        ) {
            member.memberTypeRef = child.typeRef;
        }
        members.push(member);
    }
    return members;
}
function limited(typeRef, unobservable) {
    const result = { unobservable };
    // Internal reference is deliberately excluded from JSON identity and Worker transfer.
    Object.defineProperty(result, EXPANSION_TYPE_REF, { value: typeRef });
    return result;
}

function attachNested(member, nested) {
    if (!nested) return;
    if (nested.unobservable) {
        member.unobservable = nested.unobservable;
        member.watchType = "";
        Object.defineProperty(member, EXPANSION_TYPE_REF, { value: nested[EXPANSION_TYPE_REF] });
    } else member.compositeLayout = nested;
}

function isPartial(member) {
    return (
        ["depth-limit", "expansion-budget", "type-cycle"].includes(member.unobservable) ||
        !!member.compositeLayout?.truncated
    );
}

function _buildArrayLayout(typeDieOff, dies, childrenMap, typeCache, depth, budget, state) {
    const typeDie = dies.get(typeDieOff);
    const elementType =
        typeDie.typeRef !== undefined
            ? _resolveTypeInfo(typeDie.typeRef, dies, childrenMap, typeCache)
            : { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
    const dimensions = arrayDimensions(typeDieOff, dies, childrenMap);
    const totalElements = dimensions.length ? dimensions.reduce((a, b) => a * b, 1) : 0;
    if (
        !Number.isSafeInteger(totalElements) ||
        totalElements > 65536 ||
        !consumeCompositeBudget(budget, Math.max(1, dimensions.length))
    )
        return limited(typeDieOff, "expansion-budget");
    if (depth + Math.max(0, dimensions.length - 1) > MAX_COMPOSITE_DEPTH) return limited(typeDieOff, "depth-limit");
    /** @type {Record<string, any>} */
    const element = {
        typeName: elementType.typeName,
        watchType: elementType.watchType,
        byteSize: elementType.byteSize || 0,
        kind: elementType.kind,
        ...typeFlags(elementType),
        ...(elementType.unobservable ? { unobservable: elementType.unobservable } : {})
    };
    /** @type {Record<string, any>} */
    let current = element;
    for (let index = dimensions.length - 1; index >= 0; index--) {
        const count = dimensions[index];
        const layout = {
            kind: "array",
            typeName: (current.typeName || "") + "[]",
            watchType: "",
            byteSize: count * current.byteSize,
            elementType: current,
            dimensions: [count],
            totalElements: count,
            ...(isPartial(current) ? { truncated: true } : {})
        };
        current = {
            kind: "array",
            typeName: layout.typeName,
            watchType: "",
            byteSize: layout.byteSize,
            compositeLayout: layout
        };
    }
    const layout = current.compositeLayout || {
        kind: "array",
        typeName: (elementType.typeName || "") + "[]",
        watchType: "",
        byteSize: 0,
        elementType: element,
        dimensions: [],
        totalElements: 0,
        ...(isPartial(element) ? { truncated: true } : {})
    };
    if (typeDie.byteSize) layout.byteSize = typeDie.byteSize;
    let metadata = 0;
    let cursor = layout;
    for (let index = 0; index < Math.max(1, dimensions.length); index++) {
        const { elementType: entry, ...shell } = cursor;
        const { compositeLayout: nested, ...elementMetadata } = entry;
        metadata += Buffer.byteLength(JSON.stringify({ ...shell, elementType: elementMetadata })) + 384;
        cursor = nested;
        if (metadata > budget.maxBytes - budget.bytes) return limited(typeDieOff, "expansion-budget");
    }
    if (!consumeCompositeBudget(budget, 0, metadata)) return limited(typeDieOff, "expansion-budget");
    // The dimension shells are reserved before their sole element branch expands.
    if (["struct", "class", "union", "array"].includes(elementType.kind)) {
        attachNested(
            element,
            _buildCompositeLayout(
                typeDie.typeRef,
                dies,
                childrenMap,
                typeCache,
                depth + Math.max(1, dimensions.length),
                budget,
                state
            )
        );
    }
    if (isPartial(element)) {
        cursor = layout;
        for (let index = 0; index < Math.max(1, dimensions.length); index++) {
            cursor.truncated = true;
            cursor = cursor.elementType.compositeLayout;
        }
    }
    return layout;
}

function _buildCompositeLayout(typeRef, dies, childrenMap, typeCache, depth, budget, state) {
    const originalRef = typeRef;
    const { ref, aliases, unobservable } = unwrapAliases(typeRef, dies, state.active);
    if (unobservable || state.active.has(ref)) return limited(originalRef, unobservable || "type-cycle");
    if (depth > MAX_COMPOSITE_DEPTH) return limited(originalRef, "depth-limit");
    if (!consumeCompositeBudget(budget, aliases.length)) return limited(originalRef, "expansion-budget");
    typeRef = ref;
    const typeDie = dies.get(typeRef);
    if (!typeDie) return null;
    const cached = state.cache.get(typeRef);
    let layout;
    // Fair-share budgets make a fresh build stricter than "total cost fits". Reuse a
    // complete layout only where a fresh build is guaranteed to be complete too:
    // at least the depth, node and byte headroom it was originally built with.
    if (
        cached &&
        depth <= cached.depth &&
        budget.maxNodes - budget.nodes >= cached.nodeRoom &&
        budget.maxBytes - budget.bytes >= cached.byteRoom
    ) {
        consumeCompositeBudget(budget, cached.cost, cached.bytes);
        state.cache.delete(typeRef);
        state.cache.set(typeRef, cached);
        layout = cached.layout;
    } else {
        const startCount = budget.nodes;
        const startBytes = budget.bytes;
        if (!consumeCompositeBudget(budget)) return limited(originalRef, "expansion-budget");
        state.active.add(typeRef);
        try {
            if ([DW_TAG_structure_type, DW_TAG_union_type, DW_TAG_class_type].includes(typeDie.tag)) {
                if (typeDie.isDecl || !Number.isSafeInteger(typeDie.byteSize) || typeDie.byteSize <= 0) return null;
                // Reserve every sibling entry before expanding any one branch. A nested
                // type whose own member rows do not fit is limited atomically.
                let rows = 0;
                for (const off of childrenMap.get(typeRef) || []) {
                    const child = dies.get(off);
                    if (child?.tag === DW_TAG_inheritance || (child?.tag === DW_TAG_member && !child.isDecl)) rows++;
                }
                if (!consumeCompositeBudget(budget, rows)) return limited(originalRef, "expansion-budget");
                const members = _collectMembers(typeRef, dies, childrenMap, typeCache);
                const kind =
                    typeDie.tag === DW_TAG_structure_type
                        ? "struct"
                        : typeDie.tag === DW_TAG_union_type
                          ? "union"
                          : "class";
                const nm = typeDie.qualifiedTypeName || typeDie.name || "";
                const typeName = nm ? kind + " " + nm : kind;
                let bytes =
                    Buffer.byteLength(JSON.stringify({ kind, typeName, byteSize: typeDie.byteSize, members: [] })) + 32;
                for (const member of members) {
                    // Reserve room for a marker and its signed expansion handle as well
                    // as the compositeLayout property. Check incrementally, before a
                    // large response can be materialized by JSON.stringify.
                    bytes +=
                        Buffer.byteLength(JSON.stringify(member)) + 1 + (member.memberTypeRef !== undefined ? 384 : 0);
                    if (budget.bytes + bytes > budget.maxBytes) return limited(originalRef, "expansion-budget");
                }
                if (!consumeCompositeBudget(budget, 0, bytes)) return limited(originalRef, "expansion-budget");
                let branches = members.filter((member) => member.memberTypeRef !== undefined).length;
                for (const member of members) {
                    if (member.memberTypeRef === undefined) continue;
                    // Fair shares prevent a huge early branch from starving shallow later
                    // composites. Unused work remains available to subsequent siblings.
                    const branchBudget = {
                        nodes: budget.nodes,
                        maxNodes: budget.nodes + Math.floor((budget.maxNodes - budget.nodes) / branches),
                        bytes: budget.bytes,
                        maxBytes: budget.bytes + Math.floor((budget.maxBytes - budget.bytes) / branches--)
                    };
                    attachNested(
                        member,
                        _buildCompositeLayout(
                            member.memberTypeRef,
                            dies,
                            childrenMap,
                            typeCache,
                            depth + 1,
                            branchBudget,
                            state
                        )
                    );
                    budget.nodes = branchBudget.nodes;
                    budget.bytes = branchBudget.bytes;
                    delete member.memberTypeRef;
                }
                layout = {
                    kind,
                    typeName,
                    byteSize: typeDie.byteSize,
                    members,
                    ...(members.some(isPartial) ? { truncated: true } : {})
                };
            } else if (typeDie.tag === DW_TAG_array_type) {
                layout = _buildArrayLayout(typeRef, dies, childrenMap, typeCache, depth, budget, state);
            }
        } finally {
            state.active.delete(typeRef);
        }
        // Never present truncated data as writable members. Partial subtrees are
        // position-dependent and must never be reused from the type-only LRU.
        if (layout && !layout.unobservable && !layout.truncated) {
            const cost = budget.nodes - startCount;
            if (state.cache.has(typeRef)) state.cachedNodes -= state.cache.get(typeRef).cost;
            state.cache.set(typeRef, {
                layout,
                cost,
                bytes: budget.bytes - startBytes,
                depth,
                nodeRoom: budget.maxNodes - startCount,
                byteRoom: budget.maxBytes - startBytes
            });
            state.cachedNodes += cost;
            while (state.cache.size > 64 || state.cachedNodes > 65536) {
                const oldest = state.cache.keys().next().value;
                state.cachedNodes -= state.cache.get(oldest).cost;
                state.cache.delete(oldest);
            }
        }
    }
    if (layout?.unobservable) return limited(originalRef, layout.unobservable);
    if (layout && aliases.length) {
        const named = aliases.find(([, alias]) => alias.tag === DW_TAG_typedef && alias.name)?.[1];
        const isConst = aliases.some(([, alias]) => alias.tag === DW_TAG_const_type);
        const name = named ? named.qualifiedTypeName || named.name : layout.typeName;
        const extra =
            Math.max(0, Buffer.byteLength(JSON.stringify(name)) - Buffer.byteLength(JSON.stringify(layout.typeName))) +
            (isConst && !layout.isConst ? 32 : 0);
        if (!consumeCompositeBudget(budget, 0, extra)) return limited(originalRef, "expansion-budget");
        layout = { ...layout, typeName: name, ...(isConst ? { isConst: true } : {}) };
    }
    return layout || null;
}

function consumeCompositeBudget(budget, amount = 1, bytes = 0) {
    if (budget.nodes + amount > budget.maxNodes || budget.bytes + bytes > budget.maxBytes) return false;
    budget.nodes += amount;
    budget.bytes += bytes;
    return true;
}

function buildRootLayout(typeRef, dies, childrenMap, typeCache, state) {
    const layout = _buildCompositeLayout(
        typeRef,
        dies,
        childrenMap,
        typeCache,
        0,
        { nodes: 0, maxNodes: MAX_COMPOSITE_NODES, bytes: 0, maxBytes: MAX_COMPOSITE_BYTES },
        state
    );
    if (layout?.unobservable)
        throw Object.assign(new Error("DWARF root layout cannot fit its expansion budget"), {
            code: "DWARF_BUDGET_EXCEEDED"
        });
    return layout;
}
function createCompositeLayoutResolver(parsed) {
    const { dies, childrenMap } = parsed;
    const { byName, candidates, ambiguousNames, typeCache } = createVariableTypeIndex(parsed);
    const state = { cache: new Map(), cachedNodes: 0, active: new Set() };
    const failedTypes = new Map();
    const resolve = (name) => {
        if (ambiguousNames.has(name)) return null;
        const variable = byName.get(name);
        if (!variable || variable.typeRef === undefined) return null;
        if (failedTypes.has(variable.typeRef)) throw failedTypes.get(variable.typeRef);
        const info = _resolveTypeInfo(variable.typeRef, dies, childrenMap, typeCache);
        if (!info || !["struct", "class", "union", "array"].includes(info.kind)) return null;
        try {
            const layout = buildRootLayout(variable.typeRef, dies, childrenMap, typeCache, state);
            // Equal names and byte sizes do not prove equal member offsets or types.
            // Compare complete layouts lazily, keeping the existing expansion budget.
            let identity;
            for (const typeRef of candidates.get(name)) {
                if (typeRef === variable.typeRef) continue;
                const other = buildRootLayout(typeRef, dies, childrenMap, typeCache, state);
                identity ??= JSON.stringify(layout);
                if (identity !== JSON.stringify(other)) {
                    ambiguousNames.add(name);
                    return null;
                }
            }
            return layout;
        } catch (error) {
            failedTypes.set(variable.typeRef, error);
            throw error;
        }
    };
    resolve.expandType = (typeRef) => {
        if (!dies.has(typeRef))
            throw Object.assign(new Error("Unknown layout expansion type"), { code: "INVALID_LAYOUT_HANDLE" });
        return buildRootLayout(typeRef, dies, childrenMap, typeCache, state);
    };
    return resolve;
}
function buildCompositeLayouts(parsed, onError) {
    const resolve = createCompositeLayoutResolver(parsed);
    const result = new Map();
    const seen = new Set();
    for (const variable of parsed.variables) {
        const key = variable.linkageName || variable.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        try {
            const layout = resolve(key);
            if (layout) result.set(key, layout);
        } catch (error) {
            if (onError) onError(key, error);
            else throw error;
        }
    }
    return result;
}
// 以 linkage name（缺失时回落普通名）为键，映射到 DWARF 作用域链构造的 C++ 限定名，供 ELF 绑定与函数显示名使用。
function buildDisplayNames(parsed) {
    const result = new Map();
    const add = (rec) => {
        const key = rec.linkageName || rec.name || "";
        if (!key || result.has(key)) return;
        result.set(key, rec.qualifiedName || rec.name || key);
    };
    for (const v of parsed.variables || []) add(v);
    for (const s of parsed.subprograms || []) add(s);
    return result;
}
module.exports = {
    EXPANSION_TYPE_REF,
    unwrapAliases,
    resolveTypeInfo: _resolveTypeInfo,
    createVariableTypeIndex,
    bindVariableSymbols,
    encodingToWatchType,
    buildVariableTypes,
    buildCompositeLayouts,
    buildDisplayNames,
    createCompositeLayoutResolver
};
