"use strict";

const c = require("./constants");
const { encodingToWatchType, resolveTypeInfo, createVariableTypeIndex, unwrapAliases } = require("./types");
const { arrayDimensions } = require("./subranges");
const { MAX_COMPOSITE_NODES, MAX_COMPOSITE_BYTES, MAX_TYPE_ALIASES } = require("./layoutLimits");
const { memberRole, stdSummary } = require("./memberRoles");
const MAX_RUNTIME_DEPTH = 128;
const MAX_RUNTIME_TYPES = 4096;

const COMPOSITES = new Set([c.DW_TAG_structure_type, c.DW_TAG_class_type, c.DW_TAG_union_type]);
const WRAPPERS = new Set([c.DW_TAG_typedef, c.DW_TAG_const_type, c.DW_TAG_volatile_type, c.DW_TAG_restrict_type]);
const INDIRECT_SUFFIXES = {
    [c.DW_TAG_pointer_type]: " *",
    [c.DW_TAG_reference_type]: " &",
    [c.DW_TAG_rvalue_reference_type]: " &&"
};
const STL =
    /^(?:std::(?:__cxx11::)?)(basic_string|vector|array|pair|tuple|map|multimap|set|multiset|unordered_map|unordered_multimap|unordered_set|unordered_multiset|list|forward_list|deque|unique_ptr|shared_ptr|weak_ptr|optional|variant)</;

function markMissingStlArguments(types) {
    for (const type of types) {
        if (!type.stl || (type.stl === "tuple" && /^std::tuple<\s*>$/.test(type.typeName))) continue;
        const required = type.stl === "pair" || type.stl.endsWith("map") ? 2 : 1;
        if (type.args.length < required) type.unobservable = "template-arguments";
    }
}

// Recover an omitted tuple parameter pack from the concrete _Head_base<N>::_M_head_impl DIEs.
function recoverTupleArguments(types) {
    const collect = (id, result, seen = new Set(), depth = 0) => {
        if (seen.has(id) || depth > 32) return;
        seen.add(id);
        const node = types[id];
        if (node?.kind === "alias") return collect(node.target, result, seen, depth + 1);
        const index = node?.typeName.match(/(?:^|::)_Head_base<(\d+),/);
        for (const field of node?.fields || []) {
            if (index && field.name === "_M_head_impl") result[Number(index[1])] = field.type;
            else if (field.isBase) collect(field.type, result, seen, depth + 1);
        }
    };
    for (const [id, type] of types.entries()) {
        if (type.stl !== "tuple" || type.args.length) continue;
        const args = [];
        collect(id, args);
        if (args.length <= 256 && Array.from(args).every((arg) => arg !== undefined)) type.args = args;
    }
}

function indirectTargetName(types, id, showConst) {
    let isConst = false;
    for (let depth = 0; depth < MAX_TYPE_ALIASES && types[id]; depth++) {
        const type = types[id];
        isConst ||= showConst && !!type.isConst;
        if (type.typeName) return (isConst && !type.typeName.startsWith("const ") ? "const " : "") + type.typeName;
        if (type.kind !== "alias") break;
        id = type.target;
    }
    return "";
}

function withDeclarator(name, declarator) {
    const array = /^(.*?)(?: \(([*&]+)\))?((?:\[\d+\])+)$/.exec(name);
    const dimensions = declarator.startsWith("[");
    if (!array) return dimensions ? name + declarator : name + " " + declarator;
    const [, base, indirect, existing] = array;
    return dimensions && !indirect
        ? base + declarator + existing
        : `${base} (${indirect || ""}${declarator})${existing}`;
}

function indirectTypeName(types, node, tag) {
    const name =
        indirectTargetName(types, node.target, node.kind === "reference") ||
        (node.pointerTarget === "function" ? "function" : "void");
    return withDeclarator(name, INDIRECT_SUFFIXES[tag].trim());
}

function runtimePointerTarget(dies, ref) {
    if (ref === undefined) return "void";
    const pointee = unwrapAliases(ref, dies);
    if (pointee.unobservable) return "data";
    if (pointee.ref === undefined) return "void";
    const target = dies.get(pointee.ref);
    if (target?.tag === c.DW_TAG_subroutine_type) return "function";
    return COMPOSITES.has(target?.tag) && target.isDecl ? "incomplete" : "data";
}

// Each subrange is a type node, so both selection and sampling use the same per-dimension stride.
function runtimeArrayTypes(node, dimensions, element, types, reserve) {
    const name = indirectTargetName(types, element, true);
    const layers = [];
    let count = 1;
    let byteSize = types[element].byteSize;
    let suffix = "";
    const truncated = types[element].unobservable || types[element].truncated;
    for (const dimension of dimensions.slice().reverse()) {
        count *= dimension;
        byteSize *= dimension;
        if (!Number.isSafeInteger(count) || !Number.isSafeInteger(byteSize))
            throw Object.assign(new Error("Runtime array dimension exceeds its integer budget"), {
                code: "DWARF_BUDGET_EXCEEDED"
            });
        suffix = `[${dimension}]` + suffix;
        layers.push({
            kind: "array",
            byteSize,
            count: dimension,
            typeName: name ? withDeclarator(name, suffix) : "",
            ...(truncated ? { truncated: true } : {})
        });
    }
    const outer = layers.pop();
    if (dimensions.length > 1) outer.dimensions = dimensions;
    const bytes = layers.reduce(
        (sum, layer) => sum + Buffer.byteLength(JSON.stringify(layer)) + 256,
        Buffer.byteLength(JSON.stringify(outer))
    );
    if (!reserve(layers.length, bytes)) return false;
    let target = element;
    for (const layer of layers) {
        types.push({ ...layer, target });
        target = types.length - 1;
    }
    Object.assign(node, outer, {
        byteSize: node.byteSize || outer.byteSize,
        typeName: node.typeName || outer.typeName,
        target
    });
    return true;
}

function runtimeScalarType(node, die, ref, parsed, scalarCache, chargeBytes, pointerTarget) {
    node.kind = "scalar";
    if (die.tag === c.DW_TAG_ptr_to_member_type) {
        node.byteSize ||= pointerTarget(die.typeRef) === "function" ? 8 : 4;
        node.isMemberPointer = true;
    }
    node.isBoolean = die.encoding === c.DW_ATE_boolean;
    node.watchType = encodingToWatchType(
        die.tag === c.DW_TAG_ptr_to_member_type ? c.DW_ATE_unsigned : die.encoding,
        node.byteSize
    );
    if (die.tag === c.DW_TAG_enumeration_type) {
        const info = resolveTypeInfo(ref, parsed.dies, parsed.childrenMap, scalarCache);
        node.byteSize = info.byteSize;
        node.watchType = info.watchType;
        node.enumEncodingInferred = !!info.enumEncodingInferred;
        if (info.enumInfo) {
            if (!chargeBytes(Buffer.byteLength(JSON.stringify(info.enumInfo)))) return;
            node.enumInfo = info.enumInfo;
        }
    }
}

function createRuntimeLayoutResolver(parsed, symbols = []) {
    const scalarCache = new Map();
    const { byName, ambiguousNames } = createVariableTypeIndex(parsed);
    const vtables = new Map(
        symbols.filter((symbol) => symbol.name.startsWith("_ZTV")).map((symbol) => [symbol.name, symbol])
    );
    let vtableTypes;
    const dynamicBudgetError = () =>
        Object.assign(new Error("Runtime dynamic type graph exceeds its 4096 type budget"), {
            code: "DWARF_BUDGET_EXCEEDED"
        });
    const indexedVtables = () => {
        if (vtableTypes !== undefined) return vtableTypes;
        vtableTypes = [];
        for (const [ref, die] of parsed.dies) {
            if (!COMPOSITES.has(die.tag) || !die.qualifiedTypeName || die.isDecl) continue;
            const parts = die.qualifiedTypeName.split("::");
            if (!parts.every((part) => /^[A-Za-z_]\w*$/.test(part))) continue;
            const encoded = parts.map((part) => part.length + part).join("");
            const vtable = vtables.get("_ZTV" + (parts.length > 1 ? "N" + encoded + "E" : encoded));
            if (!vtable) continue;
            if (vtableTypes.length >= 4096) return (vtableTypes = null);
            vtableTypes.push({ ref, address: vtable.address, size: vtable.size });
        }
        return vtableTypes;
    };
    return (name, onError) => {
        if (ambiguousNames.has(name)) return null;
        const variable = byName.get(name);
        if (!variable || variable.typeRef === undefined) return null;
        const types = [];
        const ids = new Map();
        let dynamic = false;
        let truncated = false;
        let atomicDynamic = false;
        let work = 0;
        let metadataBytes = 0;
        const active = new Set();
        const limitedIds = new Map();
        const reported = new Set();
        const limit = (code) => {
            if (atomicDynamic) throw dynamicBudgetError();
            truncated = true;
            if (!reported.has(code)) {
                reported.add(code);
                onError?.(
                    name,
                    Object.assign(new Error("Runtime layout branch is unavailable: " + code), {
                        code: code === "type-cycle" ? "DWARF_TYPE_CYCLE" : "DWARF_BUDGET_EXCEEDED"
                    })
                );
            }
            if (!limitedIds.has(code)) {
                limitedIds.set(code, types.length);
                types.push({ kind: "unavailable", typeName: "", byteSize: 0, unobservable: code });
            }
            return limitedIds.get(code);
        };
        const partial = (id) => !!types[id]?.unobservable || !!types[id]?.truncated;
        const pointerTarget = (ref) => runtimePointerTarget(parsed.dies, ref);
        const fullBudget = {
            maxTypes: MAX_RUNTIME_TYPES - 3,
            maxWork: MAX_COMPOSITE_NODES,
            maxBytes: MAX_COMPOSITE_BYTES
        };
        const visit = (ref, depth = 0, byValue = true, budget = fullBudget) => {
            const die = parsed.dies.get(ref);
            if (
                byValue &&
                active.has(ref) &&
                (COMPOSITES.has(die?.tag) || WRAPPERS.has(die?.tag) || die?.tag === c.DW_TAG_array_type)
            )
                return limit("type-cycle");
            if (ids.has(ref)) return ids.get(ref);
            if (depth > MAX_RUNTIME_DEPTH) return limit("depth-limit");
            if (types.length >= budget.maxTypes || work >= budget.maxWork || metadataBytes >= budget.maxBytes)
                return limit("expansion-budget");
            work++;
            const id = types.length;
            ids.set(ref, id);
            const node = {
                kind: "unavailable",
                typeName: die?.qualifiedTypeName || die?.name || "",
                byteSize: die?.byteSize || 0
            };
            types.push(node);
            if (!die) return id;
            active.add(ref);
            const chargeBytes = (amount) => {
                if (metadataBytes + amount > budget.maxBytes) {
                    node.kind = "unavailable";
                    node.unobservable = "expansion-budget";
                    limit(node.unobservable);
                    return false;
                }
                metadataBytes += amount;
                return true;
            };
            try {
                if (!chargeBytes(Buffer.byteLength(JSON.stringify(node)) + 256)) return id;
                if (WRAPPERS.has(die.tag)) {
                    // Collapse wrapper chains iteratively. This uses one graph alias node,
                    // so a wrapper on every composite edge cannot multiply stack depth.
                    const aliases = unwrapAliases(ref, parsed.dies);
                    if (aliases.unobservable) {
                        Object.assign(node, { unobservable: aliases.unobservable });
                        limit(aliases.unobservable);
                    } else {
                        node.kind = "alias";
                        node.target = visit(aliases.ref, depth, byValue, budget);
                        node.isConst = aliases.aliases.some(([, alias]) => alias.tag === c.DW_TAG_const_type);
                        node.byteSize ||= types[node.target].byteSize;
                        if (partial(node.target)) node.truncated = true;
                    }
                } else if (Object.hasOwn(INDIRECT_SUFFIXES, die.tag)) {
                    node.kind = die.tag === c.DW_TAG_pointer_type ? "pointer" : "reference";
                    node.byteSize = node.kind === "reference" ? die.byteSize || die.unit?.addrSize || 4 : 4;
                    node.target = visit(die.typeRef, depth + 1, false, budget);
                    node.pointerTarget = pointerTarget(die.typeRef);
                    node.typeName ||= indirectTypeName(types, node, die.tag);
                    dynamic = true;
                    if (partial(node.target)) node.truncated = true;
                } else if (
                    [c.DW_TAG_base_type, c.DW_TAG_enumeration_type, c.DW_TAG_ptr_to_member_type].includes(die.tag)
                ) {
                    runtimeScalarType(node, die, ref, parsed, scalarCache, chargeBytes, pointerTarget);
                } else if (die.tag === c.DW_TAG_array_type) {
                    const dimensions = arrayDimensions(ref, parsed.dies, parsed.childrenMap);
                    if (!dimensions.length) dimensions.push(0);
                    if (depth + dimensions.length > MAX_RUNTIME_DEPTH) {
                        node.unobservable = "depth-limit";
                        limit(node.unobservable);
                        return id;
                    }
                    const element = visit(die.typeRef, depth + dimensions.length, true, budget);
                    const reserve = (count, bytes) => {
                        if (types.length + count > budget.maxTypes || work + count > budget.maxWork) return false;
                        if (!chargeBytes(bytes)) return false;
                        work += count;
                        return true;
                    };
                    if (!runtimeArrayTypes(node, dimensions, element, types, reserve)) {
                        node.unobservable = "expansion-budget";
                        limit(node.unobservable);
                    }
                } else if (COMPOSITES.has(die.tag) && !die.isDecl) {
                    const offsets = parsed.childrenMap.get(ref) || [];
                    if (work + offsets.length > budget.maxWork) {
                        node.unobservable = "expansion-budget";
                        limit(node.unobservable);
                        return id;
                    }
                    work += offsets.length;
                    const fields = offsets.filter((off) => {
                        const child = parsed.dies.get(off);
                        return [c.DW_TAG_member, c.DW_TAG_inheritance].includes(child?.tag) && !child.isDecl;
                    });
                    // Reserve the entire field list before any child uses work.
                    for (const off of fields) {
                        const child = parsed.dies.get(off);
                        const metadata = {
                            name: child.name || "?",
                            offset: child.memberOffset,
                            expression: child.memberExpression,
                            bitSize: child.bitSize,
                            bitOffset: child.bitOffset,
                            dataBitOffset: child.dataBitOffset
                        };
                        if (!chargeBytes(Buffer.byteLength(JSON.stringify(metadata)) + 128)) return id;
                    }
                    node.kind = die.tag === c.DW_TAG_union_type ? "union" : "class";
                    node.fields = [];
                    node.args = [];
                    const summary = stdSummary(node.typeName);
                    if (summary) node.stdSummary = summary;
                    const argumentRefs = [];
                    const pending = [...offsets];
                    const seen = new Set();
                    let argumentVisits = 0;
                    while (pending.length) {
                        const off = pending.pop();
                        if (seen.has(off)) continue;
                        seen.add(off);
                        const child = parsed.dies.get(off);
                        if (child?.tag === 0x2f && child.typeRef !== undefined) argumentRefs.push(child.typeRef);
                        else if (child?.tag === 0x4107) {
                            const nested = parsed.childrenMap.get(off) || [];
                            if (work + nested.length > budget.maxWork) {
                                node.kind = "unavailable";
                                node.unobservable = "expansion-budget";
                                limit(node.unobservable);
                                return id;
                            }
                            work += nested.length;
                            for (const entry of nested) pending.push(entry);
                        }
                        if (++argumentVisits > MAX_COMPOSITE_NODES || argumentRefs.length > MAX_TYPE_ALIASES) {
                            node.kind = "unavailable";
                            node.unobservable = "expansion-budget";
                            limit(node.unobservable);
                            return id;
                        }
                    }
                    // Restore template argument order after the iterative stack traversal.
                    argumentRefs.reverse();
                    if (!chargeBytes(argumentRefs.length * 16)) return id;
                    let branches = fields.length + argumentRefs.length;
                    const childBudget = () => {
                        const reserveTypes = Math.min(
                            Math.max(0, branches - 1) * 4,
                            Math.max(0, Math.floor((budget.maxTypes - types.length) / 2))
                        );
                        const reserveWork = Math.min(
                            Math.max(0, branches - 1) * 4,
                            Math.max(0, Math.floor((budget.maxWork - work) / 2))
                        );
                        const reserveBytes = Math.min(
                            Math.max(0, branches - 1) * 512,
                            Math.max(0, Math.floor((budget.maxBytes - metadataBytes) / 2))
                        );
                        branches--;
                        return {
                            maxTypes: budget.maxTypes - reserveTypes,
                            maxWork: budget.maxWork - reserveWork,
                            maxBytes: budget.maxBytes - reserveBytes
                        };
                    };
                    let base = 0;
                    for (const off of fields) {
                        const child = parsed.dies.get(off);
                        const target = visit(child.typeRef, depth + 1, true, childBudget());
                        const isBase = child.tag === c.DW_TAG_inheritance;
                        const role = memberRole(node.typeName, {
                            name: child.name,
                            isBase,
                            isArtificial: child.isArtificial
                        });
                        node.fields.push({
                            name: isBase ? "@base" + base++ : child.name || "?",
                            ...(role ? { memberRole: role } : {}),
                            type: target,
                            offset: child.memberOffset,
                            expression: child.memberOffset === undefined ? child.memberExpression : undefined,
                            isBase,
                            virtual: !!child.virtuality,
                            bitSize: child.bitSize,
                            bitOffset:
                                child.dataBitOffset !== undefined
                                    ? child.dataBitOffset % 8
                                    : child.bitOffset === undefined
                                      ? undefined
                                      : (child.byteSize || types[target]?.byteSize || 0) * 8 -
                                        child.bitOffset -
                                        child.bitSize,
                            dataBitOffset: child.dataBitOffset,
                            ...(types[target].unobservable ? { unobservable: types[target].unobservable } : {})
                        });
                        if (partial(target)) node.truncated = true;
                    }
                    for (const arg of argumentRefs) {
                        const target = visit(arg, depth + 1, false, childBudget());
                        node.args.push(target);
                        if (partial(target)) node.truncated = true;
                    }
                    const stl = node.typeName.match(STL);
                    if (stl && (die.name === node.typeName || die.name?.startsWith(stl[1] + "<"))) {
                        node.stl = stl[1];
                        dynamic = true;
                    }
                }
                return id;
            } finally {
                active.delete(ref);
                // A graph built with a smaller branch allowance must not constrain a
                // later occurrence with room to expand further.
                if (partial(id)) ids.delete(ref);
            }
        };
        const root = visit(variable.typeRef);
        if (!dynamic) return null;
        const storageNodes = new Set([
            "list",
            "forward_list",
            "map",
            "multimap",
            "set",
            "multiset",
            "unordered_map",
            "unordered_multimap",
            "unordered_set",
            "unordered_multiset"
        ]);
        if (types.some((type) => storageNodes.has(type.stl))) {
            for (const [ref, die] of parsed.dies) {
                if (
                    COMPOSITES.has(die.tag) &&
                    !die.isDecl &&
                    /(?:^|::)_(?:List_node|Fwd_list_node|Rb_tree_node|Hash_node)</.test(die.qualifiedTypeName || "")
                )
                    visit(ref);
            }
        }
        let dynamicTypes = [];
        // Scalar pointers and ordinary STL containers need no vtable catalog.
        // Index candidates once, then include complete graphs atomically: a partial
        // catalog could turn an ambiguous vtable into a writable dynamic identity.
        if (types.some((type) => type.fields?.some((field) => field.name.startsWith("_vptr")))) {
            const start = types.length;
            const startWork = work;
            const startBytes = metadataBytes;
            atomicDynamic = true;
            try {
                const candidates = indexedVtables();
                if (!candidates) throw dynamicBudgetError();
                for (const entry of candidates)
                    dynamicTypes.push({ address: entry.address, size: entry.size, type: visit(entry.ref) });
            } catch (error) {
                if (error.code !== "DWARF_BUDGET_EXCEEDED") throw error;
                types.length = start;
                work = startWork;
                metadataBytes = startBytes;
                for (const [ref, id] of ids) if (id >= start) ids.delete(ref);
                dynamicTypes = [];
                onError?.(name, error);
            } finally {
                atomicDynamic = false;
            }
        }
        recoverTupleArguments(types);
        markMissingStlArguments(types);
        return { root, types, dynamicTypes, ...(truncated ? { truncated: true } : {}) };
    };
}

function resolveRuntimeLayout(name, resolver, onError) {
    try {
        return resolver(name, onError);
    } catch (error) {
        onError?.(name, error);
        return null;
    }
}

module.exports = { createRuntimeLayoutResolver, resolveRuntimeLayout };
