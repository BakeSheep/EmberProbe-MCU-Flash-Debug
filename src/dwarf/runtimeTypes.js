"use strict";

const c = require("./constants");
const { encodingToWatchType } = require("./types");

const COMPOSITES = new Set([c.DW_TAG_structure_type, c.DW_TAG_class_type, c.DW_TAG_union_type]);
const WRAPPERS = new Set([c.DW_TAG_typedef, c.DW_TAG_const_type, c.DW_TAG_volatile_type, c.DW_TAG_restrict_type]);
const STL =
    /^(?:std::(?:__cxx11::)?)(basic_string|vector|array|pair|tuple|map|multimap|set|multiset|unordered_map|unordered_multimap|unordered_set|unordered_multiset|list|forward_list|deque|unique_ptr|shared_ptr|weak_ptr|optional|variant)</;

function createRuntimeLayoutResolver(parsed, symbols = []) {
    const byName = new Map();
    for (const variable of parsed.variables) {
        const name = variable.linkageName || variable.name;
        const previous = byName.get(name);
        if (!byName.has(name)) byName.set(name, variable);
        else if (previous && (previous.address !== variable.address || previous.typeRef !== variable.typeRef))
            byName.set(name, null);
    }
    const vtables = new Map(
        symbols.filter((symbol) => symbol.name.startsWith("_ZTV")).map((symbol) => [symbol.name, symbol])
    );
    return (name) => {
        const variable = byName.get(name);
        if (!variable || variable.typeRef === undefined) return null;
        const types = [];
        const ids = new Map();
        let dynamic = false;
        const visit = (ref, depth = 0) => {
            if (ids.has(ref)) return ids.get(ref);
            if (depth > 128)
                throw Object.assign(new Error("Runtime type graph nesting exceeds 128"), {
                    code: "DWARF_BUDGET_EXCEEDED"
                });
            if (types.length >= 4096)
                throw Object.assign(new Error("Runtime type graph exceeds 4096 types"), {
                    code: "DWARF_BUDGET_EXCEEDED"
                });
            const id = types.length;
            ids.set(ref, id);
            const die = parsed.dies.get(ref);
            const node = {
                kind: "unavailable",
                typeName: die?.qualifiedTypeName || die?.name || "",
                byteSize: die?.byteSize || 0
            };
            types.push(node);
            if (!die) return id;
            if (WRAPPERS.has(die.tag)) {
                node.kind = "alias";
                node.target = visit(die.typeRef, depth + 1);
                node.isConst = die.tag === c.DW_TAG_const_type;
            } else if (
                [c.DW_TAG_pointer_type, c.DW_TAG_reference_type, c.DW_TAG_rvalue_reference_type].includes(die.tag)
            ) {
                node.kind = die.tag === c.DW_TAG_pointer_type ? "pointer" : "reference";
                node.byteSize = 4;
                node.target = visit(die.typeRef, depth + 1);
                dynamic = true;
            } else if ([c.DW_TAG_base_type, c.DW_TAG_enumeration_type, c.DW_TAG_ptr_to_member_type].includes(die.tag)) {
                node.kind = "scalar";
                node.watchType = encodingToWatchType(die.encoding, node.byteSize);
                if (die.tag === c.DW_TAG_enumeration_type && die.typeRef !== undefined) {
                    const inner = types[visit(die.typeRef, depth + 1)];
                    node.byteSize ||= inner.byteSize;
                    node.watchType ||= inner.watchType;
                }
            } else if (die.tag === c.DW_TAG_array_type) {
                node.kind = "array";
                node.target = visit(die.typeRef, depth + 1);
                node.count = 1;
                for (const off of parsed.childrenMap.get(ref) || []) {
                    const subrange = parsed.dies.get(off);
                    if (subrange?.tag !== c.DW_TAG_subrange_type) continue;
                    node.count *= subrange.subrangeCount ?? (subrange.subrangeUpperBound ?? -1) + 1;
                }
            } else if (COMPOSITES.has(die.tag) && !die.isDecl) {
                node.kind = die.tag === c.DW_TAG_union_type ? "union" : "class";
                node.fields = [];
                node.args = [];
                let base = 0;
                const args = (off) => {
                    const child = parsed.dies.get(off);
                    if (child?.tag === 0x2f && child.typeRef !== undefined)
                        node.args.push(visit(child.typeRef, depth + 1));
                    else if (child?.tag === 0x4107)
                        for (const nested of parsed.childrenMap.get(off) || []) args(nested);
                };
                for (const off of parsed.childrenMap.get(ref) || []) {
                    const child = parsed.dies.get(off);
                    args(off);
                    if (![c.DW_TAG_member, c.DW_TAG_inheritance].includes(child?.tag) || child.isDecl) continue;
                    const isBase = child.tag === c.DW_TAG_inheritance;
                    node.fields.push({
                        name: isBase ? "@base" + base++ : child.name || "?",
                        type: visit(child.typeRef, depth + 1),
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
                                  : (child.byteSize || types[ids.get(child.typeRef)]?.byteSize || 0) * 8 -
                                    child.bitOffset -
                                    child.bitSize,
                        dataBitOffset: child.dataBitOffset
                    });
                }
                const stl = node.typeName.match(STL);
                if (stl) {
                    node.stl = stl[1];
                    dynamic = true;
                }
            }
            return id;
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
        const dynamicTypes = [];
        for (const [ref, die] of parsed.dies) {
            if (!COMPOSITES.has(die.tag) || !die.qualifiedTypeName || die.isDecl) continue;
            const parts = die.qualifiedTypeName.split("::");
            if (!parts.every((part) => /^[A-Za-z_]\w*$/.test(part))) continue;
            const encoded = parts.map((part) => part.length + part).join("");
            const vtable = vtables.get("_ZTV" + (parts.length > 1 ? "N" + encoded + "E" : encoded));
            if (vtable) dynamicTypes.push({ address: vtable.address, size: vtable.size, type: visit(ref) });
        }
        // GCC can omit the children of a tuple's template parameter pack. Recover
        // them only from its concrete _Head_base<N>::_M_head_impl DIEs.
        const tupleArgs = (id, result, seen = new Set(), depth = 0) => {
            if (seen.has(id) || depth > 32) return;
            seen.add(id);
            const node = types[id];
            if (node?.kind === "alias") return tupleArgs(node.target, result, seen, depth + 1);
            const index = node?.typeName.match(/(?:^|::)_Head_base<(\d+),/);
            for (const field of node?.fields || []) {
                if (index && field.name === "_M_head_impl") result[Number(index[1])] = field.type;
                else if (field.isBase) tupleArgs(field.type, result, seen, depth + 1);
            }
        };
        for (let id = 0; id < types.length; id++) {
            if (types[id].stl !== "tuple" || types[id].args.length) continue;
            const args = [];
            tupleArgs(id, args);
            if (args.length <= 256 && Array.from(args).every((arg) => arg !== undefined)) types[id].args = args;
        }
        return { root, types, dynamicTypes };
    };
}

module.exports = { createRuntimeLayoutResolver };
