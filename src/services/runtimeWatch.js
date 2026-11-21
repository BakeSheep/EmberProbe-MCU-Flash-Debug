"use strict";

// The picker and host validate the same semantic member paths.
const { runtimeWatchEntry } = require("../webview/runtime");

// Rewrite persisted expansions and indices only. A real member called "value" keeps its name
// when the saved type identifies the member instead of the old expansion.
function migrateLegacyRuntimePath(item, symbol, path) {
    if (item.runtimePathVersion || !path.segments.some((part) => part.kind === "index" || part.name === "value"))
        return item.name;
    const legacySteps = new Map();
    const legacy = runtimeWatchEntry(item.name, symbol, path.segments, false, legacySteps);
    if (!legacy || !legacySteps.size) return item.name;
    const modern = runtimeWatchEntry(item.name, symbol, path.segments);
    if (modern && (item.type === modern.type || item.type !== legacy.type)) return item.name;
    const segments = path.segments.flatMap((part, index) => legacySteps.get(index) || [part]);
    const suffix = segments
        .map((part, index) => {
            if (part.kind === "index") return `[${part.index}]`;
            if (part.kind === "dereference") return "->";
            return (segments[index - 1]?.kind === "dereference" ? "" : ".") + part.name;
        })
        .join("");
    const name = path.base + suffix;
    return runtimeWatchEntry(name, symbol, segments) ? name : item.name;
}

module.exports = { runtimeWatchEntry, migrateLegacyRuntimePath };
