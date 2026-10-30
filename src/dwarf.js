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
// Module-level parse cache: one Buffer object is parsed fully once, and the variable type and composite layout views
// share the result. The outer layer still caches final results by ELF SHA-256; the two caches serve different purposes.
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
            // Compilation-unit identities of same-named statics must come from DWARF source files before binding, as on
            // the Worker path.
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
        return new Map(); // any exception degrades to an empty table
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
        // Normalize to one Buffer first so a Uint8Array input is not wrapped separately by both view entry points.
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
            // Only structured codes the parser throws on purpose (such as DWARF_BUDGET_EXCEEDED) are kept; any other
            // exception (such as ERR_INVALID_ARG_TYPE from Buffer.from(null)) becomes DWARF_PARSE_FAILED.
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
