"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory(require("../runtime"));
    else root.EmberProbeWatchWrites = factory(root.EmberProbeRuntime);
})(globalThis, function (runtime) {
    function watchWriteBinding(target) {
        const { address, type, size, isBoolean, typeName } = target || {};
        if (
            !runtime.SUPPORTED_TYPES.includes(type) ||
            size !== runtime.typeByteLength(type) ||
            !Number.isSafeInteger(address) ||
            address <= 0 ||
            address + size > 0x100000000
        )
            return null;
        return {
            address,
            type,
            size,
            isBoolean: isBoolean === true,
            ...(typeof typeName === "string" && typeName && typeName !== type ? { typeName } : {})
        };
    }
    const WRITE_RESTRICTIONS = {
        pointer: "sb.writePointerStorage",
        readOnly: "sb.writeReadOnly",
        unsupported: "sb.writeUnsupported",
        scalar: "sb.writeScalarOnly",
        type: "sb.writeTypeUnknown"
    };
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
        state.writeWatch = {
            samples: new Map(),
            blocked: new Set(),
            expansions: {},
            context: null,
            order: 0
        };
        const get = () => state.writeWatch;
        const below = (name, parent) =>
            name === parent || (name.startsWith(parent) && /^(?:[.[]|->)/.test(name.slice(parent.length)));
        function setContext(context) {
            const watch = get();
            if (watch.context === context) return false;
            watch.context = context;
            watch.blocked.clear();
            for (const [name, record] of watch.samples)
                if (record.sample.writeContext !== context) watch.samples.delete(name);
            return true;
        }
        function setExpansions(expansions) {
            const watch = get();
            const changed = (name) => JSON.stringify(expansions[name]) !== JSON.stringify(watch.expansions[name]);
            for (const [name, { sample }] of watch.samples)
                if (changed(sample.sampleOwner || name)) watch.samples.delete(name);
            watch.expansions = expansions;
        }
        function forget(name) {
            for (const sampledName of get().samples.keys())
                if (below(sampledName, name)) get().samples.delete(sampledName);
        }
        function owner(name) {
            return (
                state.watch.find((item) => item.name === name) ||
                [...state.watch]
                    .sort((left, right) => right.name.length - left.name.length)
                    .find((item) => below(name, item.name))
            );
        }
        function latest(name) {
            const record = get().samples.get(name);
            return record && record.sample.writeContext === get().context ? record : null;
        }
        function newer(left, right) {
            if (!right) return !!left;
            if (!left) return false;
            const t = left.sample.t;
            const previous = right.sample.t;
            return Number.isFinite(t) && Number.isFinite(previous) && t !== previous
                ? t > previous
                : left.order > right.order;
        }
        function entry(name) {
            const watch = owner(name);
            if (!watch) return { key: "sb.writeWatchRequired" };
            if (!canRead()) return { key: "sb.writeNeedSampling" };
            if (get().blocked.has(name)) return { key: "sb.writeSampleRequired" };
            const symbol = state.symbols.get(runtime.variableBaseName(name)) || watch;
            const parent = latest(watch.name);
            const exact = name === watch.name ? null : latest(name);
            // A leaf may be sampled independently while its owner is folded. Only use it if
            // the decoder supplied a real leaf address and type, or reported that it is stale.
            const separate =
                exact &&
                (exact.sample.diagnostic ||
                    exact.sample.stale ||
                    exact.sample.value == null ||
                    (Number.isSafeInteger(exact.sample.address) && exact.sample.type));
            const record = separate && newer(exact, parent) ? exact : parent;
            if (!record) return { key: "sb.writeSampleRequired" };
            let node = record.sample;
            let valid = !node.diagnostic && !node.stale;
            if (parent?.sample.tree) {
                if (!parent.nodes) {
                    parent.nodes = new Map();
                    sampleNodes(parent.sample.tree, watch.name, parent.nodes);
                }
                if (record === parent) {
                    const leaf = parent.nodes.get(name);
                    node = leaf?.node;
                    valid &&= !!leaf?.valid;
                }
            } else if (record === parent && name !== watch.name) valid = false;
            if (valid && node && !Object.prototype.hasOwnProperty.call(node, "value"))
                return { key: "sb.writeScalarOnly" };
            if (!valid || node?.value === null || node?.value === undefined) return { key: "sb.writeSampleRequired" };
            if (node.isPointer) return { key: "sb.writePointerStorage" };
            let access;
            if (typeof node.writeRestriction === "string") {
                if (node.writeRestriction)
                    return { key: WRITE_RESTRICTIONS[node.writeRestriction] || "sb.writeUnsupported" };
                access = { type: node.type, isBoolean: !!node.isBoolean, typeName: node.typeName };
            } else {
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
                access = { type, isBoolean: !!leaf.isBoolean, typeName: leaf.typeName };
                node = { ...node, address: leaf.address ?? node.address };
            }
            if (node.type && node.type !== access.type) return { key: "sb.writeTypeUnknown" };
            const binding = watchWriteBinding({
                ...access,
                address: node.address,
                size: runtime.typeByteLength(access.type)
            });
            if (!binding) return { key: "sb.writeSampleRequired" };
            return {
                entry: {
                    name,
                    ...binding,
                    value: node.value,
                    valueText: node.valueText,
                    writeBinding: binding,
                    writeContext: record.sample.writeContext,
                    fromWatch: true
                }
            };
        }
        /** @param {any[]} samples @param {(name: string) => void} [received] */
        function sampled(samples, received = () => {}) {
            const watch = get();
            for (const sample of samples || []) {
                if (!Number.isSafeInteger(sample.writeContext) || sample.writeContext < (watch.context || 1)) continue;
                if (watch.expansions[sample.sampleOwner || sample.name]?.length === 0) continue;
                const previous = watch.samples.get(sample.name);
                const record = { sample, order: ++watch.order, nodes: null };
                if (
                    previous &&
                    (previous.sample.writeContext > sample.writeContext ||
                        (sample.writeContext === previous.sample.writeContext &&
                            ((Number.isFinite(sample.t) && sample.t === previous.sample.t) ||
                                !newer(record, previous))))
                )
                    continue;
                watch.samples.set(sample.name, record);
                if (sample.writeContext !== watch.context) continue;
                for (const name of watch.blocked) if (below(name, sample.name)) watch.blocked.delete(name);
                received(sample.name);
            }
        }
        function invalidate() {
            get().samples.clear();
            get().blocked.clear();
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
        return { entry, menu, sampled, invalidate, setContext, setExpansions, forget, block, displayName };
    }
    return { create, watchWriteBinding };
});
