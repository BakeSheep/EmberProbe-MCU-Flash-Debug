"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("../runtime"));
    else root.EmberProbeWatchWrites = factory(root.EmberProbeRuntime);
})(globalThis, function (runtime) {
    function qualifiedType(graph, id) {
        let isConst = false;
        for (let depth = 0; depth < runtime.MAX_TYPE_ALIASES; depth++) {
            const type = graph.types[id];
            if (!type) return null;
            isConst ||= !!type.isConst;
            if (type.kind !== "alias") return { ...type, isConst };
            id = type.target;
        }
        return null;
    }
    function fieldType(graph, type, name, depth = 0) {
        if (!type || depth > runtime.MAX_COMPOSITE_DEPTH) return null;
        if (type.kind === "union") return { denied: true };
        const matches = [];
        const direct = (type.fields || []).filter((field) => field.name === name);
        for (const field of direct.length ? direct : type.fields || []) {
            const child = qualifiedType(graph, field.type);
            let result;
            if (field.name === name) result = child;
            else if (field.isBase || field.name === "?") result = fieldType(graph, child, name, depth + 1);
            if (result)
                matches.push({
                    ...result,
                    isConst: type.isConst || result.isConst,
                    denied: result.denied || !!field.memberRole || Number.isInteger(field.bitSize)
                });
        }
        return matches.length === 1 ? matches[0] : null;
    }
    // Menu eligibility uses type metadata and an existing sample. The host resolves and validates every write again.
    function dynamicAccess(graph, segments, sampled, ancestry = new Set()) {
        let type = qualifiedType(graph, graph.root),
            readOnly = false,
            denied = false;
        for (const segment of segments) {
            if (!type) return { key: "sb.writeTypeUnknown" };
            denied ||= type.denied;
            if (segment.kind === "index" && (!Number.isSafeInteger(segment.index) || segment.index < 0))
                return { key: "sb.writeUnsupported" };
            if (type.kind === "reference") {
                type = qualifiedType(graph, type.target);
                if (segment.name === "value" && ["scalar", "array"].includes(type?.kind)) continue;
            }
            if (!type) return { key: "sb.writeTypeUnknown" };
            if (type.kind === "pointer") {
                if (segment.kind !== "dereference" && segment.name !== "value")
                    return { key: "sb.writePointerStorage" };
                type = qualifiedType(graph, type.target);
                readOnly = !!type?.isConst;
                continue;
            }
            readOnly ||= type.isConst;
            denied ||= type.denied;
            if (type.kind === "union") return { key: "sb.writeUnsupported" };
            if (type.stl) {
                if (type.stl === "basic_string") return { key: "sb.writeReadOnly" };
                readOnly ||= /^(?:unordered_)?(?:multi)?set$/.test(type.stl);
                if (type.stl === "pair") {
                    if (!["first", "second"].includes(segment.name)) return { key: "sb.writeUnsupported" };
                    readOnly ||= type.mapEntry && segment.name === "first";
                    type = qualifiedType(graph, type.args[segment.name === "first" ? 0 : 1]);
                } else if (/map$/.test(type.stl)) {
                    if (segment.kind !== "index") return { key: "sb.writeUnsupported" };
                    type = { kind: "class", stl: "pair", args: type.args, mapEntry: true };
                } else if (type.stl === "tuple") type = qualifiedType(graph, type.args?.[segment.index]);
                else if (type.stl === "variant") {
                    const candidates = type.args
                        .map((id) => qualifiedType(graph, id))
                        .filter(
                            (entry) => entry && (entry.typeName === sampled?.typeName || ancestry.has(entry.typeName))
                        );
                    type = candidates.length === 1 ? candidates[0] : null;
                } else type = qualifiedType(graph, type.args?.[0]);
            } else if (type.kind === "array" && segment.kind === "index")
                type = segment.index < type.count ? qualifiedType(graph, type.target) : null;
            else if (segment.kind === "member") {
                const direct = fieldType(graph, type, segment.name);
                if (direct) type = direct;
                else {
                    const candidates = (graph.dynamicTypes || []).map((entry) => qualifiedType(graph, entry.type));
                    const matches = candidates.filter(
                        (entry) => entry && ancestry.has(entry.typeName) && fieldType(graph, entry, segment.name)
                    );
                    type = matches.length === 1 ? fieldType(graph, matches[0], segment.name) : null;
                }
            } else return { key: "sb.writeUnsupported" };
        }
        if (!type) return { key: "sb.writeTypeUnknown" };
        if (["pointer", "reference"].includes(type.kind)) return { key: "sb.writePointerStorage" };
        if (readOnly || type.isConst) return { key: "sb.writeReadOnly" };
        if (denied || type.denied || type.isMemberPointer) return { key: "sb.writeUnsupported" };
        if (type.kind !== "scalar") return { key: "sb.writeScalarOnly" };
        if (!runtime.SUPPORTED_TYPES.includes(type.watchType) || type.enumEncodingInferred)
            return { key: "sb.writeTypeUnknown" };
        return { type: type.watchType, isBoolean: !!type.isBoolean };
    }
    function sampleNodes(tree, path, found, depth = 0, valid = true) {
        if (!tree || depth > runtime.MAX_LAYOUT_PATH_DEPTH || found.size >= 2000) return;
        valid &&= !tree.unavailable && !tree.unobservable && !tree.stale && !tree.unavailableCode;
        found.set(path, { node: tree, valid });
        for (const member of tree.members || [])
            sampleNodes(member, runtime.layoutMemberPath(path, member), found, depth + 1, valid);
        for (const element of tree.elements || [])
            sampleNodes(element, path + "[" + element.index + "]", found, depth + 1, valid);
    }
    function create({ state, canRead, has, toggle }) {
        state.writeWatch = { fresh: new Set(), blocked: new Set(), identity: "" };
        const get = () => state.writeWatch;
        function ensureIdentity() {
            const identity = JSON.stringify([
                state.version,
                state.generation,
                state.dataBreakpoints?.sessionId,
                state.dataBreakpoints?.epoch
            ]);
            if (identity !== get().identity) {
                get().identity = identity;
                get().fresh.clear();
            }
        }
        function owner(name) {
            return (
                state.watch.find((item) => item.name === name) ||
                [...state.watch]
                    .sort((left, right) => right.name.length - left.name.length)
                    .find((item) => name.startsWith(item.name) && /^[.[]/.test(name.slice(item.name.length)))
            );
        }
        function entry(name) {
            ensureIdentity();
            const watch = owner(name);
            if (!watch) return { key: "sb.writeWatchRequired" };
            if (!canRead()) return { key: "sb.writeNeedSampling" };
            if (!get().fresh.has(watch.name) || get().blocked.has(name)) return { key: "sb.writeSampleRequired" };
            const symbol = state.symbols.get(runtime.variableBaseName(name)) || watch;
            const graph = runtime.runtimeGraph(symbol) || runtime.runtimeGraph(watch);
            let node,
                valid = true;
            const ancestry = new Set();
            const sample = state.latest[watch.name];
            if (sample && typeof sample === "object") {
                const nodes = new Map();
                sampleNodes(sample, watch.name, nodes);
                for (const [path, entry] of nodes)
                    if (path === name || (name.startsWith(path) && /^[.[]/.test(name.slice(path.length))))
                        ancestry.add(entry.node.typeName);
                ({ node, valid } = nodes.get(name) || { valid: false });
            } else if (name === watch.name)
                node = { value: sample, valueText: state.latestText[name], address: watch.address };
            if (valid && node && !Object.prototype.hasOwnProperty.call(node, "value"))
                return { key: "sb.writeScalarOnly" };
            if (!valid || node?.value === null || node?.value === undefined) return { key: "sb.writeSampleRequired" };
            let access;
            if (graph) access = dynamicAccess(graph, runtime.memberPathSegments(name)?.segments || [], node, ancestry);
            else {
                const leaf =
                    name === symbol.name
                        ? symbol
                        : runtime
                              .displayLayoutLeaves(symbol, symbol.compositeLayout, symbol.name, symbol.address, {
                                  showRaw: true,
                                  includePointers: true,
                                  maxArray: 1000
                              })
                              .find((item) => item.path === name);
                if (!leaf) return { key: "sb.writeScalarOnly" };
                if (leaf.isConst) return { key: "sb.writeReadOnly" };
                if (leaf.isPointer || leaf.isReference) return { key: "sb.writePointerStorage" };
                if (leaf.isMemberPointer || leaf.memberRole || Number.isInteger(leaf.bitSize))
                    return { key: "sb.writeUnsupported" };
                const type = leaf.watchType || leaf.type;
                if (
                    !runtime.SUPPORTED_TYPES.includes(type) ||
                    leaf.enumEncodingInferred ||
                    (name === symbol.name && symbol.hasDwarfWriteType !== true)
                )
                    return { key: "sb.writeTypeUnknown" };
                access = { type, isBoolean: !!leaf.isBoolean };
                node = { ...node, address: leaf.address ?? node.address };
            }
            if (access.key) return access;
            if (node.type && node.type !== access.type) return { key: "sb.writeTypeUnknown" };
            if (node.isPointer) return { key: "sb.writePointerStorage" };
            return {
                entry: {
                    name,
                    ...access,
                    address: node.address,
                    size: runtime.typeByteLength(access.type),
                    value: node.value,
                    valueText: node.valueText,
                    fromWatch: true
                }
            };
        }
        function sampled(samples) {
            ensureIdentity();
            for (const sample of samples || []) {
                if (sample.diagnostic || (!sample.tree && sample.value == null)) get().fresh.delete(sample.name);
                else get().fresh.add(sample.name);
                for (const name of get().blocked)
                    if (
                        name === sample.name ||
                        (name.startsWith(sample.name) && /^[.[]/.test(name.slice(sample.name.length)))
                    )
                        get().blocked.delete(name);
            }
        }
        function invalidate() {
            get().fresh.clear();
        }
        function block(name) {
            get().blocked.add(name);
        }
        function menu(name) {
            const selected = has(name);
            const candidate = entry(name);
            return {
                selected,
                key: selected ? "" : candidate.key || "",
                run: () => {
                    const current = entry(name);
                    if (has(name)) toggle({ name });
                    else if (current.entry) toggle(current.entry);
                }
            };
        }
        function displayName(item) {
            return runtime.variableDisplayName(item, {
                get: (name) => {
                    const symbol = state.symbols.get(name);
                    if (symbol?.displayName && symbol.displayName !== symbol.name) return symbol;
                    return (
                        state.watch.find((row) => row.name === name) ||
                        state.writeList.find((row) => row.name === name) ||
                        symbol
                    );
                }
            });
        }
        return { entry, menu, sampled, invalidate, block, displayName };
    }
    return { create, dynamicAccess };
});
