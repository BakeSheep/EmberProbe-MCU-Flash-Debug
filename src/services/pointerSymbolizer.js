"use strict";

const { formatPointer } = require("../webview/runtime");

const MAX_POINTER_CACHE_ENTRIES = 4096;
const ADDRESS_LIMIT = 0x100000000;

/**
 * @typedef {{ kind: string, text: string, name?: string, offset?: number,
 * index?: number, region?: string, dynamicTypeName?: string }} PointerInfo
 * @typedef {{ info: PointerInfo, symbol?: any, displayName?: string, layout?: any }} CachedPointer
 * @typedef {{ start: number, end: number, symbol?: any, region?: string, name?: string }} Range
 * @typedef {{ range: Range, maxEnd: number, left: RangeTree | null, right: RangeTree | null }} RangeTree
 */

function validRange(start, size) {
    return (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(size) &&
        start >= 0 &&
        size > 0 &&
        start + size <= ADDRESS_LIMIT
    );
}

// The subtree end bound also handles overlapping symbols/sections in O(log n).
/** @param {Range[]} ranges @returns {RangeTree | null} */
function rangeTree(ranges) {
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const build = (start, end) => {
        if (start >= end) return null;
        const middle = (start + end) >>> 1;
        const left = build(start, middle);
        const right = build(middle + 1, end);
        const range = ranges[middle];
        return { range, left, right, maxEnd: Math.max(range.end, left?.maxEnd || 0, right?.maxEnd || 0) };
    };
    return build(0, ranges.length);
}

/** @param {RangeTree | null} tree @param {number} address @returns {Range | null} */
function containingRange(tree, address) {
    if (!tree || tree.maxEnd <= address) return null;
    if (tree.range.start > address) return containingRange(tree.left, address);
    return (
        containingRange(tree.right, address) ||
        (tree.range.end > address ? tree.range : containingRange(tree.left, address))
    );
}

// Simple Itanium source names cover the fallback when no runtime graph is loaded.
// More complex names use the ELF displayName or the runtime dynamic-type catalog.
function vtableName(symbol) {
    if (symbol.displayName && symbol.displayName !== symbol.name) return symbol.displayName.replace(/^vtable for /, "");
    const encoded = symbol.name.slice(4);
    const nested = encoded.startsWith("N");
    let position = nested ? 1 : 0;
    const parts = [];
    while (position < encoded.length) {
        const digits = /^\d+/.exec(encoded.slice(position));
        if (!digits) break;
        const length = Number(digits[0]);
        position += digits[0].length;
        if (!length || length > encoded.length - position) return null;
        parts.push(encoded.slice(position, position + length));
        position += length;
    }
    return parts.length && encoded.slice(position) === (nested ? "E" : "") ? parts.join("::") : null;
}

/**
 * Read-only annotations derived from ELF metadata, with no target memory access.
 * resolve() returns machine-friendly kind/region codes together with plain text.
 * This service has no t() dependency: clients may localize pointerInfo.region;
 * names, arrows, array indices and hexadecimal offsets are language independent.
 * Dynamic type names are display hints only, never runtime read/write authority.
 */
class PointerSymbolizer {
    constructor(result = null, { cacheLimit = MAX_POINTER_CACHE_ENTRIES } = {}) {
        this.cacheLimit = Number.isSafeInteger(cacheLimit)
            ? Math.max(1, Math.min(cacheLimit, MAX_POINTER_CACHE_ENTRIES))
            : MAX_POINTER_CACHE_ENTRIES;
        /** @type {Map<string, CachedPointer>} */
        this.cache = new Map();
        this.updateElf(result);
    }

    // Arrays grow while the ELF worker streams symbols; force refreshes enriched
    // metadata for the same hash. Unchanged snapshots keep the annotation LRU.
    updateElf(result, force = false) {
        const identity = result?.elf?.sha256 || result;
        if (
            !force &&
            this.identity === identity &&
            this.symbols === result?.symbols &&
            this.symbolCount === (result?.symbols?.length || 0) &&
            this.functions === result?.functions &&
            this.functionCount === (result?.functions?.length || 0) &&
            this.sections === result?.memory?.sections
        )
            return;
        this.identity = identity;
        this.symbols = result?.symbols;
        this.symbolCount = this.symbols?.length || 0;
        this.functions = result?.functions;
        this.functionCount = this.functions?.length || 0;
        this.sections = result?.memory?.sections;
        this.cache.clear();
        this.runtimeLayouts = new WeakSet();
        /** @type {Map<number, Range>} */
        this.vtables = new Map();
        /** @type {RangeTree | null} */
        this.vtableTree = null;
        const data = [];
        for (const symbol of this.symbols || []) {
            if (!validRange(symbol.address, symbol.size)) continue;
            const range = { start: symbol.address, end: symbol.address + symbol.size, symbol };
            data.push(range);
            if (symbol.name?.startsWith("_ZTV")) {
                const name = vtableName(symbol);
                if (name) this.vtables.set(range.start, { ...range, name });
            }
        }
        this.dataTree = rangeTree(data);
        this.sectionTree = rangeTree(
            (this.sections || [])
                .filter((section) => section.flags & 2 && validRange(section.addr, section.size))
                .map((section) => ({
                    start: section.addr,
                    end: section.addr + section.size,
                    region: section.flags & 4 || !(section.flags & 1) ? "flash" : "ram"
                }))
        );
        for (const symbol of this.symbols || [])
            this.addRuntimeLayout(symbol.runtimeLayout || symbol.compositeLayout?.runtimeLayout);
        this.vtableTree = rangeTree([...this.vtables.values()]);
    }

    // ElfService filters ABI symbols from its picker. Its verified dynamic-type
    // catalog retains the vtable address/size and the corresponding class name.
    addRuntimeLayout(graph) {
        if (!graph || this.runtimeLayouts.has(graph)) return;
        this.runtimeLayouts.add(graph);
        let changed = false;
        for (const entry of graph.dynamicTypes || []) {
            const name = graph.types?.[entry.type]?.typeName?.replace(/^(?:class|struct)\s+/, "");
            if (!name || !validRange(entry.address, entry.size)) continue;
            const previous = this.vtables.get(entry.address);
            if (previous?.name === name && previous.end === entry.address + entry.size) continue;
            this.vtables.set(entry.address, { start: entry.address, end: entry.address + entry.size, name });
            changed = true;
        }
        if (changed) {
            this.vtableTree = rangeTree([...this.vtables.values()]);
            this.cache.clear();
        }
    }

    /** @returns {PointerInfo | null} */
    resolve(value, pointerTarget = "data") {
        if (formatPointer(value) === null || Number(value) === 0) return null;
        const address = Number(value);
        const key = pointerTarget + ":" + address;
        const cached = this.cache.get(key);
        if (
            cached &&
            (!cached.symbol ||
                (cached.displayName === (cached.symbol.displayName || cached.symbol.name) &&
                    cached.layout === cached.symbol.compositeLayout))
        ) {
            this.cache.delete(key);
            this.cache.set(key, cached);
            return cached.info;
        }
        const entry = this._resolve(address, pointerTarget);
        if (entry.symbol) {
            entry.displayName = entry.symbol.displayName || entry.symbol.name;
            entry.layout = entry.symbol.compositeLayout;
        }
        this.cache.set(key, entry);
        if (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
        return entry.info;
    }

    /** @returns {CachedPointer} */
    _resolve(value, pointerTarget) {
        if (pointerTarget === "vtable") {
            const vtable = containingRange(this.vtableTree, value - 8);
            if (vtable)
                return {
                    info: { kind: "vtable", name: vtable.name, dynamicTypeName: vtable.name, text: "→ " + vtable.name }
                };
        }
        const address = pointerTarget === "function" ? (value & ~1) >>> 0 : value;
        if (pointerTarget === "function") {
            let start = 0;
            let end = this.functionCount;
            while (start < end) {
                const middle = (start + end) >>> 1;
                if (this.functions[middle].address <= address) start = middle + 1;
                else end = middle;
            }
            const fn = this.functions?.[start - 1];
            if (fn) {
                const offset = address - fn.address;
                if (fn.size > 0 ? offset < fn.size : offset <= 0x10000) {
                    const name = fn.displayName || fn.name;
                    return {
                        info: { kind: "function", name, offset, text: "→ " + name + offsetText(offset) },
                        symbol: fn
                    };
                }
            }
        } else {
            const symbol = containingRange(this.dataTree, address)?.symbol;
            if (symbol) {
                const offset = address - symbol.address;
                const name = symbol.displayName || symbol.name;
                const elementSize =
                    symbol.compositeLayout?.kind === "array" ? symbol.compositeLayout.elementType?.byteSize : 0;
                if (Number.isSafeInteger(elementSize) && elementSize > 0 && offset % elementSize === 0) {
                    const index = offset / elementSize;
                    return {
                        info: { kind: "data", name, offset, index, text: "→ &" + name + "[" + index + "]" },
                        symbol
                    };
                }
                return { info: { kind: "data", name, offset, text: "→ &" + name + offsetText(offset) }, symbol };
            }
        }
        const region =
            containingRange(this.sectionTree, address)?.region ||
            (address >= 0x40000000 && address <= 0x5fffffff ? "peripheral" : address >= 0xe0000000 ? "system" : null);
        if (!region) return { info: { kind: "invalid", text: "→ invalid" } };
        const labels = { flash: "Flash", ram: "RAM", peripheral: "Peripheral", system: "System" };
        return { info: { kind: "region", region, text: "→ " + labels[region] } };
    }
}

function offsetText(offset) {
    return offset ? "+0x" + offset.toString(16).toUpperCase() : "";
}

module.exports = { PointerSymbolizer, MAX_POINTER_CACHE_ENTRIES };
