"use strict";
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
function arrayDimensions(typeRef, dies, childrenMap) {
    const dimensions = [];
    for (const childOff of childrenMap.get(typeRef) || []) {
        const child = dies.get(childOff);
        if (!child || child.tag !== DW_TAG_subrange_type) continue;
        const count =
            child.subrangeCount ?? (child.subrangeUpperBound === undefined ? 0 : child.subrangeUpperBound + 1);
        if (Number.isSafeInteger(count) && count > 0) dimensions.push(count);
    }
    return dimensions;
}
function _resolveTypeInfo(refKey, dies, childrenMap, cache, depth = 0) {
    if (cache.has(refKey)) return cache.get(refKey);
    const placeholder = { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
    if (depth > 32) return placeholder;
    cache.set(refKey, placeholder);
    const d = dies.get(refKey);
    if (!d) return placeholder;
    const nm = d.name || "";
    let result;
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
        case DW_TAG_typedef: {
            const inner =
                d.typeRef !== undefined
                    ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1)
                    : placeholder;
            result = {
                kind: inner.kind,
                typeName: nm || inner.typeName,
                watchType: inner.watchType,
                byteSize: d.byteSize || inner.byteSize,
                ...typeFlags(inner)
            };
            break;
        }
        case DW_TAG_const_type: {
            const inner =
                d.typeRef !== undefined
                    ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1)
                    : placeholder;
            result = {
                ...inner,
                isConst: true
            };
            break;
        }
        case DW_TAG_volatile_type:
        case DW_TAG_restrict_type:
            result =
                d.typeRef !== undefined
                    ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1)
                    : placeholder;
            break;
        case DW_TAG_pointer_type: {
            const inner =
                d.typeRef !== undefined
                    ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1)
                    : { typeName: "void" };
            result = { kind: "scalar", typeName: (inner.typeName || "void") + " *", watchType: "u32", byteSize: 4 };
            break;
        }
        case DW_TAG_reference_type: {
            const inner =
                d.typeRef !== undefined
                    ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1)
                    : { typeName: "void" };
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
            const inner =
                d.typeRef !== undefined
                    ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1)
                    : { typeName: "void" };
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
            const inner =
                d.typeRef !== undefined
                    ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1)
                    : { typeName: "void" };
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
            const underlying =
                d.typeRef !== undefined ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1) : null;
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
        case DW_TAG_structure_type: {
            // Rust's Atomic<T> is a fixed-address scalar wrapper in current Cortex-M DWARF.
            // Match both the inner type and the reported storage width before allowing live writes.
            const atomic = /^Atomic<(u8|i8|u16|i16|u32|i32|u64|i64|bool)>$/.exec(nm);
            const atomicType = atomic?.[1] === "bool" ? "u8" : atomic?.[1];
            const atomicSize = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8 }[atomicType];
            result =
                atomicType && atomicSize === d.byteSize
                    ? {
                          kind: "scalar",
                          typeName: nm,
                          watchType: atomicType,
                          byteSize: atomicSize,
                          isBoolean: atomic?.[1] === "bool"
                      }
                    : {
                          kind: "struct",
                          typeName: nm ? "struct " + nm : "struct",
                          watchType: "",
                          byteSize: d.byteSize || 0
                      };
            break;
        }
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
            const inner =
                d.typeRef !== undefined
                    ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache, depth + 1)
                    : placeholder;
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
    cache.set(refKey, result);
    return result;
}
function buildVariableTypes(parsed) {
    const { dies, childrenMap, variables } = parsed;
    const typeCache = new Map();
    const result = new Map();
    for (const v of variables) {
        // 以 linkage name（C++ mangled，与 ELF 符号名一致）为稳定键；C 符号无 linkage name 时回落普通名。
        const key = v.linkageName || v.name || "";
        if (!key) continue;
        const t = v.typeRef !== undefined ? _resolveTypeInfo(v.typeRef, dies, childrenMap, typeCache) : null;
        const info = {
            kind: (t && t.kind) || "unknown",
            typeName: (t && t.typeName) || "",
            watchType: (t && t.watchType) || "",
            ...typeFlags(t)
        };
        const prev = result.get(key);
        if (prev) {
            // 同一键命中多个类型不一致的候选 → 无法唯一匹配，标记歧义，交由上层诊断，不绑定类型。
            if (
                !prev.ambiguous &&
                (prev.kind !== info.kind ||
                    prev.typeName !== info.typeName ||
                    prev.watchType !== info.watchType ||
                    JSON.stringify(typeFlags(prev)) !== JSON.stringify(typeFlags(info)))
            ) {
                result.set(key, { ambiguous: true, typeName: "", watchType: "" });
            }
            continue;
        }
        result.set(key, info);
    }
    return result;
}
function _collectMembers(typeDieOff, dies, childrenMap, typeCache, depth, budget) {
    if (depth > 8) return [];
    const childOffsets = childrenMap.get(typeDieOff);
    if (!childOffsets) return [];
    const members = [];
    // 基类合成成员（@baseN）置于自身成员之前，保持每条基类路径独立，天然消除跨基类同名歧义。
    let baseIndex = 0;
    for (const childOff of childOffsets) {
        const child = dies.get(childOff);
        if (!child || child.tag !== DW_TAG_inheritance) continue;
        consumeCompositeBudget(budget);
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
        const base = {
            name: "@base" + index,
            offset: child.memberOffset || 0,
            byteSize: baseType.byteSize || 0,
            typeName: baseType.typeName,
            watchType: "",
            kind: baseType.kind,
            isBase: true,
            baseIndex: index
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
            consumeCompositeBudget(budget);
            members.push({
                name: child.name || "",
                offset: 0,
                byteSize: 0,
                unobservable: "member-location"
            });
            continue;
        }
        consumeCompositeBudget(budget);
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
            ...typeFlags(memberType)
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
function _buildArrayLayout(typeDieOff, dies, childrenMap, typeCache, depth, budget, state) {
    const typeDie = dies.get(typeDieOff);
    const elementType =
        typeDie && typeDie.typeRef !== undefined
            ? _resolveTypeInfo(typeDie.typeRef, dies, childrenMap, typeCache)
            : { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
    const dimensions = arrayDimensions(typeDieOff, dies, childrenMap);
    const totalElements = dimensions.length ? dimensions.reduce((a, b) => a * b, 1) : 0;
    if (!Number.isSafeInteger(totalElements) || totalElements > 65536)
        throw Object.assign(new Error("DWARF array expansion budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
    const compositeLayout =
        typeDie && typeDie.typeRef !== undefined
            ? _buildCompositeLayout(typeDie.typeRef, dies, childrenMap, typeCache, depth + 1, budget, state)
            : null;
    /** @type {Record<string, any>} */
    const element = {
        typeName: elementType.typeName,
        watchType: elementType.watchType,
        byteSize: elementType.byteSize || 0,
        kind: elementType.kind,
        ...typeFlags(elementType)
    };
    if (compositeLayout) element.compositeLayout = compositeLayout;
    // GCC can encode all dimensions as subranges of one array DIE. Give each
    // dimension its own layout node so paths and row strides stay meaningful.
    consumeCompositeBudget(budget, Math.max(0, dimensions.length - 1));
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
            totalElements: count
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
        totalElements: 0
    };
    if (typeDie?.byteSize) layout.byteSize = typeDie.byteSize;
    return layout;
}
function _buildCompositeLayout(typeRef, dies, childrenMap, typeCache, depth, budget, state) {
    if (depth > 8 || state.active.has(typeRef))
        throw Object.assign(new Error("DWARF composite nesting budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
    const cached = state.cache.get(typeRef);
    if (cached) {
        consumeCompositeBudget(budget, cached.cost);
        state.cache.delete(typeRef);
        state.cache.set(typeRef, cached);
        return cached.layout;
    }
    consumeCompositeBudget(budget);
    const typeDie = dies.get(typeRef);
    if (!typeDie) return null;
    state.active.add(typeRef);
    const startCount = budget.nodes;
    let layout;
    try {
        if (
            typeDie.tag === DW_TAG_typedef ||
            typeDie.tag === DW_TAG_const_type ||
            typeDie.tag === DW_TAG_volatile_type ||
            typeDie.tag === DW_TAG_restrict_type
        ) {
            if (typeDie.typeRef === undefined) return null;
            const nested = _buildCompositeLayout(
                typeDie.typeRef,
                dies,
                childrenMap,
                typeCache,
                depth + 1,
                budget,
                state
            );
            if (nested && typeDie.tag === DW_TAG_typedef && typeDie.name) {
                layout = {
                    ...nested,
                    typeName: typeDie.name,
                    ...(nested.isConst ? { isConst: true } : {})
                };
            } else if (nested && typeDie.tag === DW_TAG_const_type) {
                layout = { ...nested, isConst: true };
            } else {
                layout = nested;
            }
        } else if (
            typeDie.tag === DW_TAG_structure_type ||
            typeDie.tag === DW_TAG_union_type ||
            typeDie.tag === DW_TAG_class_type
        ) {
            // Forward declarations have no trustworthy member offsets.
            if (typeDie.isDecl || !Number.isSafeInteger(typeDie.byteSize) || typeDie.byteSize <= 0) return null;
            const kind =
                typeDie.tag === DW_TAG_structure_type
                    ? "struct"
                    : typeDie.tag === DW_TAG_union_type
                      ? "union"
                      : "class";
            const nm = typeDie.name || "";
            const members = _collectMembers(typeRef, dies, childrenMap, typeCache, depth, budget);
            // 递归解析嵌套复合成员的布局
            for (const m of members) {
                if (m.memberTypeRef !== undefined) {
                    const nested = _buildCompositeLayout(
                        m.memberTypeRef,
                        dies,
                        childrenMap,
                        typeCache,
                        depth + 1,
                        budget,
                        state
                    );
                    if (nested) m.compositeLayout = nested;
                    delete m.memberTypeRef;
                }
            }
            layout = { kind, typeName: nm ? kind + " " + nm : kind, byteSize: typeDie.byteSize || 0, members };
        } else if (typeDie.tag === DW_TAG_array_type) {
            layout = _buildArrayLayout(typeRef, dies, childrenMap, typeCache, depth, budget, state);
        }
    } finally {
        state.active.delete(typeRef);
    }
    if (layout) {
        const cost = budget.nodes - startCount + 1;
        state.cache.set(typeRef, { layout, cost });
        state.cachedNodes += cost;
        while (state.cache.size > 64 || state.cachedNodes > 65536) {
            const oldest = state.cache.keys().next().value;
            state.cachedNodes -= state.cache.get(oldest).cost;
            state.cache.delete(oldest);
        }
    }
    return layout || null;
}
// Count layout visits and members for one requested root type.
// Reject incomplete layouts rather than presenting truncated data as writable members.
const MAX_COMPOSITE_NODES = 16384;
function consumeCompositeBudget(budget, amount = 1) {
    if ((budget.nodes += amount) > MAX_COMPOSITE_NODES)
        throw Object.assign(new Error("DWARF composite expansion budget exceeded"), {
            code: "DWARF_BUDGET_EXCEEDED"
        });
}
function createCompositeLayoutResolver(parsed) {
    const { dies, childrenMap, variables } = parsed;
    const typeCache = new Map();
    const byName = new Map();
    const candidates = new Map();
    const ambiguousNames = new Set();
    for (const variable of variables) {
        const key = variable.linkageName || variable.name;
        if (!key) continue;
        const previous = byName.get(key);
        if (!previous) {
            byName.set(key, variable);
            candidates.set(key, new Set([variable.typeRef]));
            continue;
        }
        candidates.get(key).add(variable.typeRef);
        if (previous.typeRef === variable.typeRef) continue;
        const prevInfo = _resolveTypeInfo(previous.typeRef, dies, childrenMap, typeCache);
        const curInfo = _resolveTypeInfo(variable.typeRef, dies, childrenMap, typeCache);
        if (
            prevInfo.kind !== curInfo.kind ||
            prevInfo.typeName !== curInfo.typeName ||
            prevInfo.byteSize !== curInfo.byteSize ||
            JSON.stringify(typeFlags(prevInfo)) !== JSON.stringify(typeFlags(curInfo))
        ) {
            ambiguousNames.add(key);
        } else {
            const prevDie = dies.get(previous.typeRef);
            const curDie = dies.get(variable.typeRef);
            if (prevDie?.isDecl && !curDie?.isDecl) {
                byName.set(key, variable);
            }
        }
    }
    const state = { cache: new Map(), cachedNodes: 0, active: new Set() };
    const failedTypes = new Map();
    return (name) => {
        if (ambiguousNames.has(name)) return null;
        const variable = byName.get(name);
        if (!variable || variable.typeRef === undefined) return null;
        if (failedTypes.has(variable.typeRef)) throw failedTypes.get(variable.typeRef);
        const info = _resolveTypeInfo(variable.typeRef, dies, childrenMap, typeCache);
        if (!info || !["struct", "class", "union", "array"].includes(info.kind)) return null;
        try {
            const budget = { nodes: 0 };
            const layout = _buildCompositeLayout(variable.typeRef, dies, childrenMap, typeCache, 0, budget, state);
            // Equal names and byte sizes do not prove equal member offsets or types.
            // Compare complete layouts lazily, keeping the existing expansion budget.
            let identity;
            for (const typeRef of candidates.get(name)) {
                if (typeRef === variable.typeRef) continue;
                const other = _buildCompositeLayout(typeRef, dies, childrenMap, typeCache, 0, budget, state);
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
    resolveTypeInfo: _resolveTypeInfo,
    bindVariableSymbols,
    encodingToWatchType,
    buildVariableTypes,
    buildCompositeLayouts,
    buildDisplayNames,
    createCompositeLayoutResolver
};
