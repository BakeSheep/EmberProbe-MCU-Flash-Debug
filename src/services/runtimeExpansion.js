"use strict";

// "Sample expanded pointer parts only": a runtime object (pointer target, STL container) reads
// only the composites its waveform view has opened. Paths are relative to the watch name and use
// the view's spelling: `.member`, `[index]`, and `.value` for a followed pointer's target.
// Scalars inside an opened composite are always read; closed composites cost no reads.
const MAX_RUNTIME_EXPANSION_ITEMS = 256;
const MAX_RUNTIME_EXPANSION_PATHS = 512;
const MAX_RUNTIME_EXPANSION_PATH_LENGTH = 1024;
// Scalar leaves one waveform view records from runtime trees as silent history channels.
const MAX_RUNTIME_HISTORY_LEAVES = 1024;

function memberPath(path, name) {
    return name ? path + "." + name : path;
}

function elementPath(path, index) {
    return path + "[" + index + "]";
}

// Base classes, anonymous members and library internals have no disclosure of their own.
function flatMember(name, memberRole) {
    return !name || name === "?" || /^@base\d+$/.test(name) || !!memberRole;
}

// Library objects shown as one value (atomic, chrono, function, smart pointers) stay readable;
// std::array is an element list and opens like any array.
function summaryShown(summary, stl) {
    return !!summary && stl !== "array";
}

function invalid(message) {
    return Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}

// Validated `{ watchName: [relative paths] }` from a waveform view.
function normalizeRuntimeExpansions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid runtime expansions");
    const entries = Object.entries(value);
    if (entries.length > MAX_RUNTIME_EXPANSION_ITEMS) throw invalid("Too many runtime expansion entries");
    const result = {};
    for (const [name, paths] of entries) {
        if (!name || name.length > MAX_RUNTIME_EXPANSION_PATH_LENGTH || !Array.isArray(paths))
            throw invalid("Invalid runtime expansion entry");
        if (paths.length > MAX_RUNTIME_EXPANSION_PATHS) throw invalid("Too many runtime expansion paths");
        const unique = new Set();
        for (const path of paths) {
            if (
                typeof path !== "string" ||
                path.length > MAX_RUNTIME_EXPANSION_PATH_LENGTH ||
                (path && !/^[.[]/.test(path))
            )
                throw invalid("Invalid runtime expansion path");
            unique.add(path);
        }
        result[name] = [...unique].sort();
    }
    return result;
}

// Scalar leaves of a decoded runtime tree, as `{ path, node }` with paths relative to the tree.
// `opened(path)` follows the reader's rules; null records everything the tree contains.
function runtimeTreeLeaves(tree, opened = null, limit = MAX_RUNTIME_HISTORY_LEAVES) {
    const leaves = [];
    const isOpen = (path) => !opened || opened(path);
    const walk = (node, path, open, depth) => {
        if (!node || leaves.length >= limit || depth > 32 || node.kind === "unavailable" || node.unobservable) return;
        if (node.isPointer) {
            const value = node.pointerValue ?? node.value;
            if (value != null) leaves.push({ path, node: { ...node, kind: "scalar", type: "u32", value } });
            const target = node.members?.find((member) => member.name === "value");
            if (target && isOpen(path)) walk(target, path + ".value", true, depth + 1);
            return;
        }
        if (Object.prototype.hasOwnProperty.call(node, "value")) {
            if (node.value != null && node.type) leaves.push({ path, node });
            return;
        }
        if (node.collapsed || !open) return;
        for (const member of node.members || []) {
            const child = memberPath(path, member.name);
            const shown =
                flatMember(member.name, member.memberRole) ||
                (member.kind !== "array" && summaryShown(member.stdSummary)) ||
                isOpen(child);
            walk(member, child, shown, depth + 1);
        }
        for (const element of node.elements || []) {
            const child = elementPath(path, element.index);
            walk(
                element,
                child,
                (element.kind !== "array" && summaryShown(element.stdSummary)) || isOpen(child),
                depth + 1
            );
        }
    };
    walk(tree, "", isOpen(""), 0);
    return leaves;
}

module.exports = {
    MAX_RUNTIME_EXPANSION_ITEMS,
    MAX_RUNTIME_EXPANSION_PATHS,
    MAX_RUNTIME_HISTORY_LEAVES,
    memberPath,
    elementPath,
    flatMember,
    summaryShown,
    normalizeRuntimeExpansions,
    runtimeTreeLeaves
};
