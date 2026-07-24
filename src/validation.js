"use strict";

const { SUPPORTED_TYPES, typeByteLength, parseMemberPath, expandCompositeLeaves } = require("./elfSymbols");

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
    const leaves = expandCompositeLeaves({ name: base.name, address: base.address, size: base.size }, base.compositeLayout, parsed);
    if (leaves.length !== 1) return null; // 仅单标量叶子可入观察列表
    const leaf = leaves[0];
    if (!supported.has(leaf.type)) return null;
    return { name, address: leaf.address >>> 0, size: typeByteLength(leaf.type), type: leaf.type };
}

function normalizeWatchList(items, symbols) {
    if (!Array.isArray(items) || !Array.isArray(symbols)) return [];
    const byName = new Map(symbols.map(symbol => [symbol.name, symbol]));
    const supported = new Set(SUPPORTED_TYPES);
    const seen = new Set();
    const result = [];
    for (const item of items) {
        if (!item || typeof item.name !== "string" || seen.has(item.name)) continue;
        const symbol = byName.get(item.name);
        if (!symbol) {
            // 非直接符号：尝试按复合变量成员/元素路径解析为标量叶子
            const leaf = resolveLeafPath(item.name, byName, supported);
            if (leaf) { seen.add(item.name); result.push(leaf); }
            continue;
        }
        // 复合变量（结构体/数组）保留布局信息，跳过标量类型校验
        if (symbol.isComposite) {
            seen.add(item.name);
            result.push({
                name: symbol.name,
                address: Number(symbol.address) >>> 0,
                size: Number(symbol.size) >>> 0,
                type: '',
                isComposite: true,
                compositeLayout: symbol.compositeLayout || null
            });
            continue;
        }
        const type = supported.has(item.type) ? item.type : symbol.watchType;
        if (!supported.has(type) || typeByteLength(type) > Number(symbol.size)) continue;
        seen.add(item.name);
        result.push({
            name: symbol.name,
            address: Number(symbol.address) >>> 0,
            size: Number(symbol.size) >>> 0,
            type
        });
    }
    return result;
}

module.exports = { cleanWindowsPath, clampInteger, normalizeWatchList };
