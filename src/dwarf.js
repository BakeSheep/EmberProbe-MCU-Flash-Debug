"use strict";
const { parseDwarfInternal: _parseDwarfInternal } = require("./dwarf/parser");
const { readULEB, readSLEB, debugSectionData } = require("./dwarf/binary");
const { encodingToWatchType, buildVariableTypes, buildCompositeLayouts } = require("./dwarf/types");
// 模块级解析缓存：同一 Buffer 对象只完整解析一次，变量类型视图与复合布局视图共享结果。
// 外层（extension.js）仍按 ELF SHA-256 缓存最终结果；两层缓存职责不同。
const _parseCache = new WeakMap();

function _parseDwarfCached(buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    let parsed = _parseCache.get(buf);
    if (parsed === undefined) {
        parsed = _parseDwarfInternal(buf);
        _parseCache.set(buf, parsed);
    }
    return parsed;
}

function parseDwarfVariableTypes(buffer) {
    try {
        const parsed = _parseDwarfCached(buffer);
        return parsed ? buildVariableTypes(parsed) : new Map();
    } catch (e) {
        return new Map(); // 任意异常一律降级为空表
    }
}
function parseCompositeLayout(buffer) {
    try {
        const parsed = _parseDwarfCached(buffer);
        return parsed ? buildCompositeLayouts(parsed) : new Map();
    } catch (e) {
        return new Map();
    }
}
function parseDwarf(buffer) {
    try {
        // 先统一为一个 Buffer 对象，避免 Uint8Array 输入在两个视图入口各包装一次。
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const parsed = _parseDwarfCached(buf);
        if (!parsed)
            return {
                types: new Map(),
                layouts: new Map(),
                diagnostics: [{ code: "DWARF_PARSE_FAILED", stage: "parse", message: "DWARF parsing failed" }]
            };
        return {
            types: buildVariableTypes(parsed),
            layouts: buildCompositeLayouts(parsed),
            diagnostics: parsed.diagnostics
        };
    } catch (e) {
        return {
            types: new Map(),
            layouts: new Map(),
            diagnostics: [{ code: "DWARF_PARSE_FAILED", stage: "parse", message: e.message || String(e) }]
        };
    }
}
module.exports = {
    parseDwarf,
    parseDwarfVariableTypes,
    parseCompositeLayout,
    encodingToWatchType,
    readULEB,
    readSLEB,
    _debugSectionData: debugSectionData
};
