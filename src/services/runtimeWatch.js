"use strict";

function runtimeWatchEntry(name, symbol, segments = []) {
    const graph = symbol.runtimeLayout || symbol.compositeLayout?.runtimeLayout;
    if (!graph) return null;
    const unwrap = (id) => {
        for (let depth = 0; depth < 32; depth++) {
            const type = graph.types[id];
            if (!type) return null;
            if (type.kind !== "alias") return type;
            id = type.target;
        }
        return null;
    };
    const rootType = unwrap(graph.root);
    if (!rootType) return null;
    // Raw pointer/reference graphs are intentionally kept on the static DWARF path.
    // Reading them requires chasing target addresses and can make a live watch card
    // oscillate when the target is outside the verified ELF memory ranges. STL roots
    // (vector/map/etc.) still use their dedicated runtime index/member handling.
    const hasPointerTypes = (graph.types || []).some(
        (entry) => entry?.kind === "pointer" || entry?.kind === "reference"
    );
    if (hasPointerTypes && !rootType.stl) return null;
    if (segments.some((segment) => segment?.kind === "dereference")) return null;
    const field = (type, name, depth = 0) => {
        if (depth > 12) return null;
        const direct = type?.fields?.filter((entry) => entry.name === name) || [];
        if (direct.length) return direct.length === 1 ? unwrap(direct[0].type) : null;
        const candidates = (type?.fields || [])
            .filter((entry) => entry.isBase || entry.name === "?")
            .map((entry) => field(unwrap(entry.type), name, depth + 1))
            .filter(Boolean);
        return candidates.length === 1 ? candidates[0] : null;
    };
    const inherits = (type, base, seen = new Set()) => {
        if (!type || seen.has(type)) return false;
        if (type === base) return true;
        seen.add(type);
        return (type.fields || []).some((entry) => entry.isBase && inherits(unwrap(entry.type), base, seen));
    };
    const member = (type, name) => {
        const known = field(type, name);
        if (known) return known;
        if (!type?.fields?.some((entry) => entry.name.startsWith("_vptr"))) return null;
        const candidates = (graph.dynamicTypes || [])
            .map((entry) => unwrap(entry.type))
            .filter((entry) => inherits(entry, type))
            .map((entry) => field(entry, name))
            .filter(Boolean);
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
    let type = rootType;
    for (const segment of segments) {
        if (!type) return null;
        if (type.kind === "reference") type = unwrap(type.target);
        if (type?.kind === "pointer") {
            type = unwrap(type.target);
            if (segment.kind === "dereference" || (segment.kind === "member" && segment.name === "value")) continue;
        } else if (segment.kind === "dereference") return null;
        if (type?.stl) {
            if (segment.kind === "index" || (segment.kind === "member" && segment.name === "value")) {
                if (segment.kind === "index" && (!Number.isSafeInteger(segment.index) || segment.index < 0))
                    return null;
                const named = ["unique_ptr", "shared_ptr", "weak_ptr", "optional", "variant"].includes(type.stl);
                if ((segment.kind === "index" && named) || (segment.kind === "member" && !named)) return null;
                if (/map$/.test(type.stl)) {
                    const pairs = graph.types.filter(
                        (entry) =>
                            entry.stl === "pair" &&
                            entry.args?.length === 2 &&
                            entry.args.every((id, index) => unwrap(id)?.typeName === unwrap(type.args[index])?.typeName)
                    );
                    type =
                        pairs.length &&
                        pairs.every(
                            (entry) => entry.typeName === pairs[0].typeName && entry.byteSize === pairs[0].byteSize
                        )
                            ? pairs[0]
                            : null;
                } else if (type.stl === "tuple") type = unwrap(type.args?.[segment.index]);
                else if (type.stl === "variant") {
                    const alternatives = type.args.map(unwrap);
                    type = alternatives.every((entry) => entry?.watchType === alternatives[0]?.watchType)
                        ? alternatives[0]
                        : null;
                } else type = unwrap(type.args?.[0]);
            } else if (type.stl === "pair" && ["first", "second"].includes(segment.name))
                type = unwrap(type.args[segment.name === "first" ? 0 : 1]);
            else return null;
        } else if (segment.kind === "index" && type?.kind === "array") type = unwrap(type.target);
        else if (segment.kind === "member") type = member(type, segment.name);
        else return null;
    }
    if (type?.kind === "reference") type = unwrap(type.target);
    if (!type || type.kind === "unavailable" || (type.kind === "scalar" && !type.watchType)) return null;
    return {
        name,
        address: symbol.address,
        size: symbol.size,
        type: type.watchType || "",
        isComposite: type.kind !== "scalar",
        compositeLayout: symbol.compositeLayout || null,
        runtimeLayout: graph,
        runtimeSegments: segments,
        ...(symbol.displayName && symbol.name === name ? { displayName: symbol.displayName } : {})
    };
}

module.exports = { runtimeWatchEntry };
