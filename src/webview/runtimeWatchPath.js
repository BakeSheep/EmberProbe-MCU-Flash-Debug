"use strict";
(function (root, create) {
    if (typeof module === "object" && module.exports) module.exports = create;
    else root.EmberProbeRuntimeWatchPath = create;
})(globalThis, function (runtime) {
    const {
        MAX_TYPE_ALIASES,
        runtimeContainsContainer,
        runtimeContainsReference,
        runtimeFieldType,
        variableDisplayName
    } = runtime;
    return function runtimeWatchEntry(name, symbol, segments = [], allowDynamicLeaf = false, legacySteps) {
        const graph = symbol.runtimeLayout || symbol.compositeLayout?.runtimeLayout;
        if (!graph) return null;
        const unwrap = (id) => {
            for (let depth = 0; depth < MAX_TYPE_ALIASES; depth++) {
                const type = graph.types[id];
                if (!type) return null;
                if (type.kind !== "alias") return type;
                id = type.target;
            }
            return null;
        };
        const rootType = unwrap(graph.root);
        if (!rootType) return null;
        // Aggregates containing STL use semantic reads too. Their unrelated raw pointers
        // stay as address values; only paths through STL may chase target storage.
        const hasPointerTypes = (graph.types || []).some(
            (entry) => entry?.kind === "pointer" || entry?.kind === "reference"
        );
        const hasContainers = runtimeContainsContainer(graph, graph.root);
        const field = (type, name) => runtimeFieldType(graph, type, name);
        const inherits = (type, base, seen = new Set()) => {
            if (!type || seen.has(type)) return false;
            if (type === base) return true;
            seen.add(type);
            return (type.fields || []).some((entry) => entry.isBase && inherits(unwrap(entry.type), base, seen));
        };
        const dynamicMembers = (type, name) => {
            if (!type?.fields?.some((entry) => entry.name.startsWith("_vptr"))) return [];
            return (graph.dynamicTypes || [])
                .map((entry) => unwrap(entry.type))
                .filter((entry) => inherits(entry, type))
                .map((entry) => field(entry, name))
                .filter(Boolean);
        };
        let runtimeSeparateRead = false;
        const member = (type, name) => {
            // Implicit base and anonymous members do not occupy this literal path in a sampled tree.
            runtimeSeparateRead ||= !type?.fields?.some((entry) => entry.name === name && !entry.unobservable);
            const known = field(type, name);
            if (known) return known;
            const candidates = dynamicMembers(type, name);
            return candidates.length &&
                candidates.every(
                    (entry) =>
                        entry.kind === candidates[0].kind &&
                        entry.typeName === candidates[0].typeName &&
                        entry.watchType === candidates[0].watchType &&
                        entry.byteSize === candidates[0].byteSize
                )
                ? candidates[0]
                : null;
        };
        let visits = 0;
        const referent = (type) => {
            while (type?.kind === "reference") {
                if (++visits > 4096 || (type.pointerTarget && type.pointerTarget !== "data")) return null;
                type = unwrap(type.target);
            }
            return type;
        };
        function resolve(type, start, enteredContainer, followed, reference = false, runtimeLeaf = false) {
            const branch = (options, next) => {
                for (const candidate of new Set(options)) {
                    const found = resolve(candidate, next, enteredContainer, followed, reference, true);
                    if (found) return found;
                }
                return null;
            };
            for (let index = start; index < segments.length; index++) {
                if (++visits > 4096) return null;
                const segment = segments[index];
                if (!type) return null;
                if (type.kind === "reference") {
                    type = referent(type);
                    if (!type) return null;
                    reference = true;
                    // Older saved paths consumed one synthetic ".value" to step through a reference.
                    if (legacySteps && !enteredContainer && segment.kind === "member" && segment.name === "value") {
                        legacySteps.set(index, []);
                        continue;
                    }
                    if (
                        type.kind !== "pointer" &&
                        (segment.kind === "dereference" ||
                            (segment.name === "value" && !type.stl && !field(type, "value")))
                    )
                        continue;
                }
                if (type.kind === "pointer" && !enteredContainer) {
                    const explicit =
                        segment.kind === "dereference" || (segment.kind === "member" && segment.name === "value");
                    if (!explicit || (type.pointerTarget && type.pointerTarget !== "data")) return null;
                    followed = true;
                    type = unwrap(type.target);
                    continue;
                }
                if (type.kind === "pointer") {
                    type = unwrap(type.target);
                    if (segment.kind === "dereference" || (segment.kind === "member" && segment.name === "value"))
                        continue;
                } else if (segment.kind === "dereference") return null;
                if (type?.stl) {
                    enteredContainer = true;
                    if (segment.kind === "index" || (segment.kind === "member" && segment.name === "value")) {
                        if (segment.kind === "index" && (!Number.isSafeInteger(segment.index) || segment.index < 0))
                            return null;
                        const named = ["unique_ptr", "shared_ptr", "weak_ptr", "optional", "variant"].includes(
                            type.stl
                        );
                        if ((segment.kind === "index" && named) || (segment.kind === "member" && !named)) return null;
                        if (/map$/.test(type.stl)) {
                            const pairs = graph.types.filter(
                                (entry) =>
                                    entry.stl === "pair" &&
                                    entry.args?.length === 2 &&
                                    entry.args.every(
                                        (id, index) => unwrap(id)?.typeName === unwrap(type.args[index])?.typeName
                                    )
                            );
                            type =
                                pairs.length &&
                                pairs.every(
                                    (entry) =>
                                        entry.typeName === pairs[0].typeName && entry.byteSize === pairs[0].byteSize
                                )
                                    ? pairs[0]
                                    : null;
                        } else if (type.stl === "tuple") type = unwrap(type.args?.[segment.index]);
                        else if (type.stl === "variant") {
                            const alternatives = type.args.map(unwrap);
                            const deferred = allowDynamicLeaf && branch(alternatives, index + 1);
                            if (deferred) return deferred;
                            type = alternatives.every((entry) => entry?.watchType === alternatives[0]?.watchType)
                                ? alternatives[0]
                                : null;
                        } else type = unwrap(type.args?.[0]);
                    } else if (type.stl === "pair" && ["first", "second"].includes(segment.name))
                        type = unwrap(type.args[segment.name === "first" ? 0 : 1]);
                    else return null;
                } else if (segment.kind === "index" && type?.kind === "array") {
                    if (legacySteps && type.dimensions?.length > 1) {
                        const coordinates = [];
                        let flat = segment.index;
                        for (const dimension of type.dimensions.slice().reverse()) {
                            if (!dimension) return null;
                            coordinates.unshift({ kind: "index", index: flat % dimension });
                            flat = Math.floor(flat / dimension);
                        }
                        if (flat !== 0) return null;
                        for (const _coordinate of coordinates) type = unwrap(type?.target);
                        legacySteps.set(index, coordinates);
                        continue;
                    }
                    if (!Number.isSafeInteger(segment.index) || segment.index < 0 || segment.index >= type.count)
                        return null;
                    type = unwrap(type.target);
                } else if (segment.kind === "member") {
                    if (allowDynamicLeaf) {
                        const known = field(type, segment.name);
                        const candidates = dynamicMembers(type, segment.name);
                        const deferred =
                            candidates.some((candidate) => candidate !== known) &&
                            branch([known, ...candidates], index + 1);
                        if (deferred) return deferred;
                    }
                    type = member(type, segment.name);
                } else return null;
            }
            const declaredReference = type?.kind === "reference" ? type : null;
            type = referent(type);
            if (!type && !declaredReference) return null;
            if (runtimeLeaf && (type?.kind !== "scalar" || !type.watchType || type.unobservable)) return null;
            return { type, declaredReference, enteredContainer, followed, reference, runtimeLeaf };
        }
        const selection = resolve(rootType, 0, !!rootType.stl, false);
        if (!selection) return null;
        let { type, declaredReference, enteredContainer, followed, reference, runtimeLeaf } = selection;
        reference ||= !!declaredReference;
        const ownsReferences = !!type && runtimeContainsReference(graph, graph.types.indexOf(type));
        if (!followed && !reference && !ownsReferences && hasPointerTypes && !hasContainers) return null;
        if (!followed && !reference && segments.some((segment) => segment?.kind === "dereference")) return null;
        if (type?.stl) enteredContainer = true;
        const rawPointer = type?.kind === "pointer" && (!enteredContainer || reference);
        const unavailable =
            !type || type.unobservable || type.kind === "unavailable" || (type.kind === "scalar" && !type.watchType);
        if (unavailable && !declaredReference) return null;
        const typeName = (rawPointer ? type.typeName : declaredReference?.typeName) || type?.typeName;
        const named = variableDisplayName({ name }, [symbol]);
        const displayName = followed && /\.value$/.test(named) ? "*" + named.slice(0, -".value".length) : named;
        return {
            name,
            address: symbol.address,
            size: symbol.size,
            type: runtimeLeaf || unavailable ? "" : rawPointer ? "u32" : type.watchType || "",
            ...(runtimeLeaf ? { runtimeLeaf: true } : {}),
            ...(typeName && !runtimeLeaf && (segments.length || declaredReference) ? { typeName } : {}),
            ...(declaredReference ? { isReference: true } : {}),
            ...(rawPointer ? { isPointer: true, pointerTarget: type.pointerTarget || "data" } : {}),
            isComposite: !unavailable && !rawPointer && type.kind !== "scalar",
            compositeLayout: symbol.compositeLayout || null,
            ...(symbol.layoutExpansions
                ? {
                      layoutExpansions: symbol.layoutExpansions,
                      layoutExpansionGeneration: symbol.layoutExpansionGeneration
                  }
                : {}),
            runtimeLayout: graph,
            runtimeSegments: segments,
            ...(reference || ownsReferences ? { runtimeReferencePath: true } : {}),
            ...(runtimeSeparateRead ? { runtimeSeparateRead: true } : {}),
            ...(rawPointer || followed || ((reference || ownsReferences || hasContainers) && !enteredContainer)
                ? { runtimeStaticPointers: true }
                : {}),
            ...(followed ? { derefPath: true } : {}),
            ...(displayName !== name ? { displayName } : {})
        };
    };
});
