"use strict";

const {
    SUPPORTED_TYPES,
    typeByteLength,
    parseMemberPath,
    expandCompositeLeaves,
    createSymbolResolver
} = require("./elfSymbols");
const { variableDisplayName, requiresRuntimePath, variableScope } = require("./webview/runtime");
const { runtimeWatchEntry } = require("./services/runtimeWatch");

function validateLayoutExpansionRequest(handle, generation) {
    const { LAYOUT_HANDLE_PATTERN } = require("./dwarf/layoutExpansion");
    if (typeof handle !== "string" || handle.length > 280 || !LAYOUT_HANDLE_PATTERN.test(handle))
        throw Object.assign(new Error("Invalid layout expansion handle"), { code: "INVALID_LAYOUT_HANDLE" });
    if (!Number.isSafeInteger(generation) || generation < 0)
        throw Object.assign(new Error("Invalid ELF layout generation"), { code: "INVALID_LAYOUT_HANDLE" });
}

function validateLayoutExpansionTarget(name, path) {
    const symbol = typeof name === "string" && name.length <= 1024 && parseMemberPath(name);
    const parsed = typeof path === "string" && path.length <= 4096 && parseMemberPath(path);
    if (
        !symbol ||
        symbol.base !== name ||
        symbol.segments.length ||
        !parsed ||
        parsed.base !== name ||
        !parsed.segments.length ||
        parsed.segments.length > 256 ||
        parsed.segments.some((segment) => !["member", "index"].includes(segment.kind))
    )
        throw Object.assign(new Error("Invalid layout expansion symbol or member path"), {
            code: "INVALID_VARIABLE_PATH"
        });
    return parsed;
}

function cleanWindowsPath(value) {
    if (!value) return "";
    return String(value)
        .replace(/^\/(?=[A-Za-z]:[\\/])/, "")
        .replace(/\\/g, "/");
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

// Resolves a member/element path of a composite (sensor.x, buf[0], ...) to a single scalar watch item, so it can be
// read and plotted like a plain scalar; only paths ending in a unique scalar leaf are supported.
function resolveLeafPath(name, byName, supported) {
    const parsed = parseMemberPath(name);
    if (!parsed || !parsed.segments.length) return null;
    const base = byName.get(parsed.base);
    if (!base || !base.isComposite || !base.compositeLayout) return null;
    const leaves = expandCompositeLeaves(base, base.compositeLayout, parsed);
    if (leaves.length !== 1) return null; // only a single scalar leaf may join the watch list
    const leaf = leaves[0];
    if (!supported.has(leaf.type)) return null;
    return {
        name,
        address: leaf.address >>> 0,
        size: Number(leaf.size) || typeByteLength(leaf.type),
        type: leaf.type,
        ...(leaf.layoutExpanded
            ? { layoutExpanded: true, ...(base.runtimeLayout ? { staticRuntimeStorage: true } : {}) }
            : {}),
        ...(leaf.enumInfo ? { enumInfo: leaf.enumInfo } : {}),
        ...(leaf.isBoolean ? { isBoolean: true } : {}),
        ...(leaf.isPointer ? { isPointer: true, pointerTarget: leaf.pointerTarget } : {}),
        ...(leaf.isPointer && leaf.typeName ? { typeName: leaf.typeName } : {}),
        ...(leaf.isPointer && leaf.memberRole ? { memberRole: leaf.memberRole } : {}),
        ...(Number.isInteger(leaf.bitSize) ? { bitSize: leaf.bitSize, bitOffset: leaf.bitOffset } : {})
    };
}

// Same-named internal-linkage variables carry CU-qualified identities that can change between builds:
// a bare `cnt` becomes `main.c::cnt` once another CU defines `cnt`, and `main.c::cnt` becomes
// `app/main.c::cnt` once another main.c appears. A persisted name follows its unique current identity
// only within the same ELF name; ambiguity is reported through onAmbiguous, never guessed.
function currentWatchName(name, byName, resolve, options) {
    const parsed = parseMemberPath(name);
    const base = parsed ? parsed.base : name;
    if (byName.has(name) || byName.has(base)) return name;
    let symbol;
    try {
        symbol = resolve()(base);
    } catch (error) {
        if (error?.code === "VARIABLE_AMBIGUOUS")
            options.onAmbiguous?.(
                name,
                (error.details?.candidates || []).map((candidate) => candidate.name)
            );
        return name;
    }
    const elfName = variableScope(base)?.name || base;
    if (!symbol?.elfName || symbol.elfName !== elfName) return name;
    const renamed = symbol.name + name.slice(base.length);
    options.onRename?.(name, renamed);
    return renamed;
}

function normalizeWatchList(items, symbols, options = {}) {
    if (!Array.isArray(items) || !Array.isArray(symbols)) return [];
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    let resolver;
    const resolve = () => (resolver ||= createSymbolResolver(symbols));
    const supported = new Set(SUPPORTED_TYPES);
    const seen = new Set();
    const result = [];
    for (const original of items) {
        if (!original || typeof original.name !== "string") continue;
        const name = currentWatchName(original.name, byName, resolve, options);
        const item = name === original.name ? original : { ...original, name };
        if (seen.has(item.name)) continue;
        const symbol = byName.get(item.name);
        const path = parseMemberPath(item.name);
        const runtimeSymbol = symbol || (path && byName.get(path.base));
        const expanded = runtimeSymbol?.layoutExpansions && resolveLeafPath(item.name, byName, supported);
        if (expanded?.layoutExpanded) {
            seen.add(item.name);
            const displayName = variableDisplayName(expanded, byName);
            result.push({ ...expanded, ...(displayName !== expanded.name ? { displayName } : {}) });
            continue;
        }
        const runtime = runtimeSymbol && runtimeWatchEntry(item.name, runtimeSymbol, path?.segments || []);
        if (runtime) {
            seen.add(item.name);
            result.push({
                ...runtime,
                ...(symbol?.isPointer ? { isPointer: true, pointerTarget: symbol.pointerTarget } : {})
            });
            continue;
        }
        if (runtimeSymbol && requiresRuntimePath(runtimeSymbol, path?.segments || [])) continue;
        if (!symbol) {
            // Not a direct symbol: try to resolve a composite member/element path to a scalar leaf
            const leaf = resolveLeafPath(item.name, byName, supported);
            if (leaf) {
                const displayName = variableDisplayName(leaf, byName);
                seen.add(item.name);
                result.push({ ...leaf, ...(displayName !== leaf.name ? { displayName } : {}) });
            }
            continue;
        }
        // Composites (structs/arrays) keep their layout and skip the scalar type check
        if (symbol.isComposite) {
            seen.add(item.name);
            result.push({
                name: symbol.name,
                ...(symbol.displayName && symbol.displayName !== symbol.name
                    ? { displayName: symbol.displayName }
                    : {}),
                address: Number(symbol.address) >>> 0,
                size: Number(symbol.size) >>> 0,
                type: "",
                isComposite: true,
                compositeLayout: symbol.compositeLayout || null,
                ...(symbol.layoutExpansions
                    ? {
                          layoutExpansions: symbol.layoutExpansions,
                          layoutExpansionGeneration: symbol.layoutExpansionGeneration
                      }
                    : {})
            });
            continue;
        }
        const type = symbol.isEnum ? symbol.watchType : supported.has(item.type) ? item.type : symbol.watchType;
        if (!supported.has(type) || typeByteLength(type) > Number(symbol.size)) continue;
        seen.add(item.name);
        result.push({
            name: symbol.name,
            ...(symbol.displayName && symbol.displayName !== symbol.name ? { displayName: symbol.displayName } : {}),
            address: Number(symbol.address) >>> 0,
            size: Number(symbol.size) >>> 0,
            type,
            ...(symbol.enumInfo ? { enumInfo: symbol.enumInfo } : {}),
            ...(symbol.isBoolean ? { isBoolean: true } : {}),
            ...(symbol.isPointer ? { isPointer: true, pointerTarget: symbol.pointerTarget } : {}),
            // Pointer type names let the host recognize C strings for display.
            ...(symbol.isPointer && symbol.typeName ? { typeName: symbol.typeName } : {}),
            ...(Number.isInteger(item.bitSize) ? { bitSize: item.bitSize, bitOffset: item.bitOffset } : {})
        });
    }
    return result;
}

module.exports = {
    cleanWindowsPath,
    clampInteger,
    normalizeWatchList,
    validateLayoutExpansionRequest,
    validateLayoutExpansionTarget
};
