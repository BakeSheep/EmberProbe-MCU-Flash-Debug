"use strict";

const { SUPPORTED_TYPES, typeByteLength, parseMemberPath, expandCompositeLeaves } = require("./elfSymbols");
const { variableDisplayName, requiresRuntimePath } = require("./webview/runtime");
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

// 将复合变量的成员/元素路径（如 sensor.x、buf[0]）解析为单个标量观察项，
// 使其能像普通标量一样被读取与绘图；仅支持解析为唯一标量叶子的路径。
function resolveLeafPath(name, byName, supported) {
    const parsed = parseMemberPath(name);
    if (!parsed || !parsed.segments.length) return null;
    const base = byName.get(parsed.base);
    if (!base || !base.isComposite || !base.compositeLayout) return null;
    const leaves = expandCompositeLeaves(base, base.compositeLayout, parsed);
    if (leaves.length !== 1) return null; // 仅单标量叶子可入观察列表
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
        ...(leaf.isPointer && leaf.memberRole ? { memberRole: leaf.memberRole } : {}),
        ...(Number.isInteger(leaf.bitSize) ? { bitSize: leaf.bitSize, bitOffset: leaf.bitOffset } : {})
    };
}

function normalizeWatchList(items, symbols) {
    if (!Array.isArray(items) || !Array.isArray(symbols)) return [];
    const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
    const supported = new Set(SUPPORTED_TYPES);
    const seen = new Set();
    const result = [];
    for (const item of items) {
        if (!item || typeof item.name !== "string" || seen.has(item.name)) continue;
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
            // 非直接符号：尝试按复合变量成员/元素路径解析为标量叶子
            const leaf = resolveLeafPath(item.name, byName, supported);
            if (leaf) {
                const displayName = variableDisplayName(leaf, byName);
                seen.add(item.name);
                result.push({ ...leaf, ...(displayName !== leaf.name ? { displayName } : {}) });
            }
            continue;
        }
        // 复合变量（结构体/数组）保留布局信息，跳过标量类型校验
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
