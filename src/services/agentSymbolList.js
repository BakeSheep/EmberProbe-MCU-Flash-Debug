"use strict";
// Agent 变量清单：在扩展已加载的 ELF 符号表（variables.read 解析名称所用的同一份）中搜索并分页。
// 只读，不访问硬件；names 可直接用于 variables.read / watch.add。

const MAX_QUERY = 256;
const MAX_COUNT = 200;

function invalid(message) {
    return Object.assign(new Error(message), { code: "INVALID_PARAMS" });
}

function integer(value, fallback, min, max, name) {
    const result = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(result) || result < min || result > max)
        throw invalid(`${name} must be an integer from ${min} to ${max}`);
    return result;
}

function describe(symbol) {
    return {
        name: symbol.name,
        ...(symbol.displayName && symbol.displayName !== symbol.name ? { displayName: symbol.displayName } : {}),
        sourceFile: symbol.sourceFile || symbol.objectFile || "",
        address: "0x" + (Number(symbol.address) >>> 0).toString(16).toUpperCase(),
        size: Number(symbol.size) || 0,
        // DWARF scalar type when known; composites are read through member paths.
        type: symbol.watchType || "",
        composite: !!symbol.isComposite
    };
}

/**
 * @param {{ elf?: any, symbols?: any[] }} elfResult
 * @param {{ query?: string, start?: number, count?: number }} [params]
 */
function listSymbols(elfResult, params = {}) {
    const query = params?.query ?? "";
    if (typeof query !== "string" || query.length > MAX_QUERY)
        throw invalid(`query must be a string of at most ${MAX_QUERY} characters`);
    const start = integer(params?.start, 0, 0, 10000000, "start");
    const count = integer(params?.count, 50, 1, MAX_COUNT, "count");
    const needle = query.trim().toLowerCase();
    const symbols = Array.isArray(elfResult?.symbols) ? elfResult.symbols : [];
    const matches = needle
        ? symbols.filter((symbol) =>
              [symbol.name, symbol.displayName, symbol.sourceFile || symbol.objectFile].some((value) =>
                  String(value || "")
                      .toLowerCase()
                      .includes(needle)
              )
          )
        : symbols;
    const page = matches.slice(start, start + count).map(describe);
    return {
        elf: elfResult?.elf || null,
        query,
        total: matches.length,
        start,
        count: page.length,
        ...(start + page.length < matches.length ? { nextStart: start + page.length } : {}),
        symbols: page
    };
}

module.exports = { listSymbols, MAX_COUNT };
