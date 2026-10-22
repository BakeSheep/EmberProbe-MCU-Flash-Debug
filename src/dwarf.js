"use strict";
const { parseDwarfInternal: _parseDwarfInternal } = require("./dwarf/parser");
const { readULEB, readSLEB, debugSectionData } = require("./dwarf/binary");
const {
    encodingToWatchType,
    buildVariableTypes,
    buildCompositeLayouts,
    buildDisplayNames,
    bindVariableSymbols
} = require("./dwarf/types");
const { parseElfSymbols, qualifySameNameSymbols } = require("./elfSymbols");
const { createRuntimeLayoutResolver, resolveRuntimeLayout } = require("./dwarf/runtimeTypes");
const { MAX_DIAGNOSTICS } = require("./dwarf/diagnostics");
// 模块级解析缓存：同一 Buffer 对象只完整解析一次，变量类型视图与复合布局视图共享结果。
// 外层（extension.js）仍按 ELF SHA-256 缓存最终结果；两层缓存职责不同。
const _parseCache = new WeakMap();

function _parseDwarfCached(buffer, options = {}) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    // Test budgets change the result, so such parses never enter or read the shared cache.
    const cacheable = !options.filePath && !options.budgets;
    let parsed = cacheable ? _parseCache.get(buf) : undefined;
    if (parsed === undefined) {
        parsed = _parseDwarfInternal(buf, options);
        let symbols = [];
        try {
            // 同名 static 的编译单元身份必须在绑定前按 DWARF 源文件确定，与 Worker 路径保持一致。
            symbols = qualifySameNameSymbols(parseElfSymbols(buf).symbols, parsed.variables);
        } catch {
            // Synthetic or stripped DWARF can still be inspected without a symbol table.
        }
        parsed = { ...bindVariableSymbols(parsed, symbols), symbols };
        if (cacheable) _parseCache.set(buf, parsed);
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
        return parsed ? buildCompositeLayouts(parsed, () => {}) : new Map();
    } catch (e) {
        return new Map();
    }
}
function parseDwarf(buffer, options = {}) {
    try {
        // 先统一为一个 Buffer 对象，避免 Uint8Array 输入在两个视图入口各包装一次。
        const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        const parsed = _parseDwarfCached(buf, options);
        if (!parsed)
            return {
                types: new Map(),
                layouts: new Map(),
                displayNames: new Map(),
                diagnostics: [{ code: "DWARF_PARSE_FAILED", stage: "parse", message: "DWARF parsing failed" }]
            };
        const types = buildVariableTypes(parsed);
        try {
            const diagnostics = [...parsed.diagnostics];
            const layouts = buildCompositeLayouts(parsed, (name, error) => {
                diagnostics.push({
                    code: error.code || "DWARF_PARSE_FAILED",
                    stage: "layouts",
                    symbol: name,
                    message: error.message
                });
            });
            const resolveRuntime = options.runtime ? createRuntimeLayoutResolver(parsed, parsed.symbols) : null;
            const seenRuntime = new Set();
            const runtimeError = (name, error) => {
                if (diagnostics.length < MAX_DIAGNOSTICS)
                    diagnostics.push({
                        code: error.code || "DWARF_PARSE_FAILED",
                        stage: "runtime-layouts",
                        symbol: name,
                        message: error.message
                    });
            };
            for (const variable of options.runtime ? parsed.variables : []) {
                const name = variable.linkageName || variable.name;
                if (seenRuntime.has(name)) continue;
                seenRuntime.add(name);
                const runtimeLayout = resolveRuntimeLayout(name, resolveRuntime, runtimeError);
                if (runtimeLayout)
                    layouts.set(name, {
                        ...(layouts.get(name) || { kind: "class", byteSize: 4, members: [] }),
                        runtimeLayout,
                        ...(runtimeLayout.truncated ? { truncated: true } : {})
                    });
            }
            return {
                types,
                layouts,
                displayNames: buildDisplayNames(parsed),
                symbols: parsed.symbols,
                diagnostics,
                companions: parsed.companions
            };
        } catch (error) {
            return {
                types,
                layouts: new Map(),
                displayNames: new Map(),
                diagnostics: [
                    ...parsed.diagnostics,
                    {
                        code: error.code || "DWARF_PARSE_FAILED",
                        stage: "layouts",
                        message: error.message
                    }
                ]
            };
        }
    } catch (e) {
        return {
            types: new Map(),
            layouts: new Map(),
            displayNames: new Map(),
            // 仅保留 DWARF_BUDGET_EXCEEDED 这类解析器主动抛出的结构化错误码；
            // 其余异常（如 Buffer.from(null) 的 ERR_INVALID_ARG_TYPE）一律归为 DWARF_PARSE_FAILED。
            diagnostics: [
                {
                    code: e.code === "DWARF_BUDGET_EXCEEDED" ? e.code : "DWARF_PARSE_FAILED",
                    stage: "parse",
                    message: e.message || String(e)
                }
            ]
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
