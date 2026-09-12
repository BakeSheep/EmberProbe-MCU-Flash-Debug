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
function encodingToWatchType(encoding, size) {
    if (encoding === DW_ATE_float) return size === 4 ? "f32" : size === 8 ? "f64" : "";
    if (encoding === DW_ATE_signed || encoding === DW_ATE_signed_char) {
        if (size === 1) return "i8";
        if (size === 2) return "i16";
        if (size === 4) return "i32";
        if (size === 8) return "i64";
        return "";
    }
    if (encoding === DW_ATE_unsigned || encoding === DW_ATE_unsigned_char || encoding === DW_ATE_boolean) {
        if (size === 1) return "u8";
        if (size === 2) return "u16";
        if (size === 4) return "u32";
        if (size === 8) return "u64";
        return "";
    }
    return "";
}
function _resolveTypeInfo(refKey, dies, childrenMap, cache) {
    if (cache.has(refKey)) return cache.get(refKey);
    const placeholder = { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
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
                byteSize: d.byteSize || 0
            };
            break;
        case DW_TAG_typedef: {
            const inner = d.typeRef !== undefined ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache) : placeholder;
            result = {
                kind: inner.kind,
                typeName: nm || inner.typeName,
                watchType: inner.watchType,
                byteSize: d.byteSize || inner.byteSize
            };
            break;
        }
        case DW_TAG_const_type:
        case DW_TAG_volatile_type:
        case DW_TAG_restrict_type:
            result = d.typeRef !== undefined ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache) : placeholder;
            break;
        case DW_TAG_pointer_type: {
            const inner =
                d.typeRef !== undefined ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache) : { typeName: "void" };
            result = { kind: "scalar", typeName: (inner.typeName || "void") + " *", watchType: "u32", byteSize: 4 };
            break;
        }
        case DW_TAG_enumeration_type:
            result = {
                kind: "scalar",
                typeName: nm ? "enum " + nm : "enum",
                watchType: encodingToWatchType(DW_ATE_signed, d.byteSize || 4),
                byteSize: d.byteSize || 4
            };
            break;
        case DW_TAG_structure_type:
            result = {
                kind: "struct",
                typeName: nm ? "struct " + nm : "struct",
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
            const inner = d.typeRef !== undefined ? _resolveTypeInfo(d.typeRef, dies, childrenMap, cache) : placeholder;
            // GCC/Clang 不为数组类型发 DW_AT_byte_size，多维数组的元素大小必须按
            // 本层 subrange 维度 × 内层大小推导，否则行 stride 恒为 0、所有行都
            // 解码到第 0 行的地址。单个数组 DIE 挂多个 subrange 的产生器同样按
            // 维度乘积推导。
            let dimsProduct = 1;
            let hasDim = false;
            const childOffsets = childrenMap.get(refKey);
            if (childOffsets) {
                for (const childOff of childOffsets) {
                    const child = dies.get(childOff);
                    if (!child || child.tag !== DW_TAG_subrange_type) continue;
                    let dim = 0;
                    if (child.subrangeCount !== undefined) dim = child.subrangeCount;
                    else if (child.subrangeUpperBound !== undefined) dim = child.subrangeUpperBound + 1;
                    if (dim > 0) {
                        dimsProduct *= dim;
                        hasDim = true;
                    }
                }
            }
            result = {
                kind: "array",
                typeName: (inner.typeName || "") + "[]",
                watchType: "",
                byteSize: d.byteSize || (hasDim ? dimsProduct * (inner.byteSize || 0) : 0)
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
        const name = v.name || "";
        if (!name || result.has(name)) continue;
        const t = v.typeRef !== undefined ? _resolveTypeInfo(v.typeRef, dies, childrenMap, typeCache) : null;
        result.set(name, { typeName: (t && t.typeName) || "", watchType: (t && t.watchType) || "" });
    }
    return result;
}
function _collectMembers(typeDieOff, dies, childrenMap, typeCache, depth, budget) {
    if (depth > 8) return [];
    const childOffsets = childrenMap.get(typeDieOff);
    if (!childOffsets) return [];
    const members = [];
    for (const childOff of childOffsets) {
        const child = dies.get(childOff);
        if (!child || child.tag !== DW_TAG_member) continue;
        consumeCompositeBudget(budget);
        const name = child.name || "";
        const memberType =
            child.typeRef !== undefined
                ? _resolveTypeInfo(child.typeRef, dies, childrenMap, typeCache)
                : { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
        const byteSize = child.byteSize || memberType.byteSize || 0;
        let offset = child.memberOffset || 0;
        let bitOffset;
        if (Number.isInteger(child.dataBitOffset)) {
            offset = Math.floor(child.dataBitOffset / 8);
            bitOffset = child.dataBitOffset % 8;
        } else if (Number.isInteger(child.bitOffset) && Number.isInteger(child.bitSize) && byteSize > 0) {
            // DWARF4 DW_AT_bit_offset 是从存储单元高位端计数；ELF32 已限定小端。
            bitOffset = byteSize * 8 - child.bitOffset - child.bitSize;
        }
        const member = {
            name,
            offset,
            byteSize,
            typeName: memberType.typeName,
            watchType: memberType.watchType,
            kind: memberType.kind
        };
        if (Number.isInteger(child.bitSize) && child.bitSize > 0 && Number.isInteger(bitOffset) && bitOffset >= 0) {
            member.bitSize = child.bitSize;
            member.bitOffset = bitOffset;
        }
        // 若成员本身是复合类型，附加嵌套布局信息（按需，延迟到 UI 展开）
        if (memberType.kind === "struct" || memberType.kind === "union" || memberType.kind === "array") {
            member.memberTypeRef = child.typeRef;
        }
        members.push(member);
    }
    return members;
}
function _buildArrayLayout(typeDieOff, dies, childrenMap, typeCache, depth, budget) {
    const typeDie = dies.get(typeDieOff);
    const elementType =
        typeDie && typeDie.typeRef !== undefined
            ? _resolveTypeInfo(typeDie.typeRef, dies, childrenMap, typeCache)
            : { kind: "unknown", typeName: "", watchType: "", byteSize: 0 };
    const dimensions = [];
    const childOffsets = childrenMap.get(typeDieOff);
    if (childOffsets) {
        for (const childOff of childOffsets) {
            const child = dies.get(childOff);
            if (!child || child.tag !== DW_TAG_subrange_type) continue;
            let dim = 0;
            if (child.subrangeCount !== undefined) {
                dim = child.subrangeCount;
            } else if (child.subrangeUpperBound !== undefined) {
                dim = child.subrangeUpperBound + 1;
            }
            if (dim > 0) dimensions.push(dim);
        }
    }
    const totalElements = dimensions.length ? dimensions.reduce((a, b) => a * b, 1) : 0;
    if (!Number.isSafeInteger(totalElements) || totalElements > 65536)
        throw Object.assign(new Error("DWARF array expansion budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
    const elemSize = elementType.byteSize || 0;
    const compositeLayout =
        typeDie && typeDie.typeRef !== undefined
            ? _buildCompositeLayout(typeDie.typeRef, dies, childrenMap, typeCache, depth + 1, budget)
            : null;
    const element = {
        typeName: elementType.typeName,
        watchType: elementType.watchType,
        byteSize: elemSize,
        kind: elementType.kind
    };
    if (compositeLayout) element.compositeLayout = compositeLayout;
    return {
        kind: "array",
        typeName: (elementType.typeName || "") + "[]",
        watchType: "",
        byteSize: typeDie ? typeDie.byteSize || totalElements * elemSize : totalElements * elemSize,
        elementType: element,
        dimensions,
        totalElements
    };
}
function _buildCompositeLayout(typeRef, dies, childrenMap, typeCache, depth, budget) {
    if (depth > 8) return null;
    consumeCompositeBudget(budget);
    const typeDie = dies.get(typeRef);
    if (!typeDie) return null;
    if (
        typeDie.tag === DW_TAG_typedef ||
        typeDie.tag === DW_TAG_const_type ||
        typeDie.tag === DW_TAG_volatile_type ||
        typeDie.tag === DW_TAG_restrict_type
    ) {
        if (typeDie.typeRef === undefined) return null;
        const nested = _buildCompositeLayout(typeDie.typeRef, dies, childrenMap, typeCache, depth + 1, budget);
        if (nested && typeDie.tag === DW_TAG_typedef && typeDie.name) {
            return { ...nested, typeName: typeDie.name };
        }
        return nested;
    }
    if (typeDie.tag === DW_TAG_structure_type || typeDie.tag === DW_TAG_union_type) {
        const kind = typeDie.tag === DW_TAG_structure_type ? "struct" : "union";
        const nm = typeDie.name || "";
        const members = _collectMembers(typeRef, dies, childrenMap, typeCache, depth, budget);
        // 递归解析嵌套复合成员的布局
        for (const m of members) {
            if (m.memberTypeRef !== undefined) {
                const nested = _buildCompositeLayout(m.memberTypeRef, dies, childrenMap, typeCache, depth + 1, budget);
                if (nested) m.compositeLayout = nested;
                delete m.memberTypeRef;
            }
        }
        return { kind, typeName: nm ? kind + " " + nm : kind, byteSize: typeDie.byteSize || 0, members };
    }
    if (typeDie.tag === DW_TAG_array_type) {
        return _buildArrayLayout(typeRef, dies, childrenMap, typeCache, depth, budget);
    }
    return null;
}
// Count both layout visits and members across all variables, including repeated types.
// Reject incomplete layouts rather than presenting truncated data as writable members.
const MAX_COMPOSITE_NODES = 2048;
function consumeCompositeBudget(budget) {
    if (++budget.nodes > MAX_COMPOSITE_NODES)
        throw Object.assign(new Error("DWARF composite expansion budget exceeded"), {
            code: "DWARF_BUDGET_EXCEEDED"
        });
}
function buildCompositeLayouts(parsed) {
    const budget = { nodes: 0 };
    const { dies, childrenMap, variables } = parsed;
    const typeCache = new Map();
    const result = new Map();
    for (const v of variables) {
        const name = v.name || "";
        if (!name || result.has(name)) continue;
        if (v.typeRef === undefined) continue;
        const typeInfo = _resolveTypeInfo(v.typeRef, dies, childrenMap, typeCache);
        if (typeInfo.kind !== "struct" && typeInfo.kind !== "union" && typeInfo.kind !== "array") continue;
        const layout = _buildCompositeLayout(v.typeRef, dies, childrenMap, typeCache, 0, budget);
        if (layout) {
            // 数组类型名补充：使用变量名关联的元素类型
            if (layout.kind === "array" && layout.elementType) {
                layout.typeName = (layout.elementType.typeName || "") + "[]";
            }
            result.set(name, layout);
        }
    }
    return result;
}
module.exports = { encodingToWatchType, buildVariableTypes, buildCompositeLayouts };
