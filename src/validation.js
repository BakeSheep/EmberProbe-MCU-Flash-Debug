"use strict";

const { SUPPORTED_TYPES, typeByteLength } = require("./elfSymbols");

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

function normalizeWatchList(items, symbols) {
    if (!Array.isArray(items) || !Array.isArray(symbols)) return [];
    const byName = new Map(symbols.map(symbol => [symbol.name, symbol]));
    const supported = new Set(SUPPORTED_TYPES);
    const seen = new Set();
    const result = [];
    for (const item of items) {
        if (!item || typeof item.name !== "string" || seen.has(item.name)) continue;
        const symbol = byName.get(item.name);
        if (!symbol || symbol.isComposite) continue;
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
