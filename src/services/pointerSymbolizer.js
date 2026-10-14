"use strict";

const fs = require("fs");
const { formatPointer } = require("../webview/runtime");

const MAX_POINTER_CACHE_ENTRIES = 4096;
const ADDRESS_LIMIT = 0x100000000;
const MAX_STRING_BYTES = 64;
const SHT_PROGBITS = 1;
const SHF_WRITE = 1;
const SHF_ALLOC = 2;

/**
 * @typedef {{ kind: string, text: string, name?: string, offset?: number,
 * index?: number, memberPath?: string, memberOffset?: number, region?: string,
 * dynamicTypeName?: string }} PointerInfo
 * @typedef {{ info: PointerInfo, symbol?: any, displayName?: string, layout?: any }} CachedPointer
 * @typedef {{ start: number, end: number, symbol?: any, region?: string, name?: string, section?: any }} Range
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

const MAX_MEMBER_PATH_DEPTH = 16;

// Member path of the object `offset` bytes into a DWARF layout: `[2].y`, `.pos`, `[1][3]`.
// Stops at the outermost object starting exactly there; `rest` is what no member covers.
// Unions, bitfields and unsized members are ambiguous and end the path.
function layoutPathAt(layout, offset, depth = 0) {
    if (!layout || depth > MAX_MEMBER_PATH_DEPTH || !Number.isSafeInteger(offset) || offset <= 0) return null;
    if (layout.kind === "array") {
        const element = layout.elementType || {};
        const size = Number(element.byteSize) || 0;
        const total = Number(layout.totalElements) || 0;
        const index = size > 0 ? Math.floor(offset / size) : -1;
        if (index < 0 || index >= total) return null;
        const dimensions =
            Array.isArray(layout.dimensions) &&
            layout.dimensions.length > 1 &&
            layout.dimensions.every((count) => Number.isSafeInteger(count) && count > 0) &&
            layout.dimensions.reduce((product, count) => product * count, 1) === total
                ? layout.dimensions
                : [total];
        let path = "";
        for (let rest = index, position = dimensions.length - 1; position >= 0; position--) {
            path = "[" + (rest % dimensions[position]) + "]" + path;
            rest = Math.floor(rest / dimensions[position]);
        }
        const rest = offset - index * size;
        const inner = element.compositeLayout && layoutPathAt(element.compositeLayout, rest, depth + 1);
        return inner ? { path: path + inner.path, rest: inner.rest } : { path, rest };
    }
    if (layout.kind !== "struct" && layout.kind !== "class") return null;
    for (const member of layout.members || []) {
        if (Number.isInteger(member.bitSize)) continue;
        const start = Number(member.offset);
        const size = Number(member.byteSize || member.compositeLayout?.byteSize) || 0;
        if (!Number.isSafeInteger(start) || size <= 0 || offset < start || offset >= start + size) continue;
        const name = !member.name || member.isBase || /^@based+$/.test(member.name) ? "" : "." + member.name;
        const inner = member.compositeLayout && layoutPathAt(member.compositeLayout, offset - start, depth + 1);
        if (inner) return { path: name + inner.path, rest: inner.rest };
        return name ? { path: name, rest: offset - start } : null;
    }
    return null;
}

// C string literal text, escaped like runtime string previews; `…` marks a missing terminator.
function cStringLiteral(bytes) {
    const end = bytes.indexOf(0);
    const text = bytes
        .subarray(0, end < 0 ? bytes.length : end)
        .toString("latin1")
        .replace(/[\x00-\x1f\x7f-\xff"\\]/g, (char) =>
            char === '"' || char === "\\" ? "\\" + char : "\\x" + char.charCodeAt(0).toString(16).padStart(2, "0")
        );
    return '"' + text + '"' + (end < 0 ? "\u2026" : "");
}

/**
 * Read-only annotations derived from ELF metadata, with no target memory access.
 * resolve() returns machine-friendly kind/region codes together with plain text.
 * This service has no t() dependency: clients may localize pointerInfo.region;
 * names, arrows, array indices and hexadecimal offsets are language independent.
 * Dynamic type names are display hints only, never runtime read/write authority.
 */
class PointerSymbolizer {
    constructor(result = null, { cacheLimit = MAX_POINTER_CACHE_ENTRIES, fileSystem = fs, requestLayout = null } = {}) {
        this.cacheLimit = Number.isSafeInteger(cacheLimit)
            ? Math.max(1, Math.min(cacheLimit, MAX_POINTER_CACHE_ENTRIES))
            : MAX_POINTER_CACHE_ENTRIES;
        this.fs = fileSystem;
        // Loads a composite symbol's layout on demand so offsets resolve to member paths.
        this.requestLayout = typeof requestLayout === "function" ? requestLayout : null;
        /** @type {Map<string, CachedPointer>} */
        this.cache = new Map();
        /** @type {Map<number, string | null>} */
        this.strings = new Map();
        this.peripheralTree = null;
        this.updateElf(result);
    }

    // SVD registers name peripheral pointers (`&GPIOA->ODR`); null clears them.
    updatePeripherals(model) {
        const ranges = [];
        for (const peripheral of model?.peripherals || [])
            for (const register of peripheral.registers || []) {
                const size = Math.max(1, Math.ceil((Number(register.size) || 32) / 8));
                const [owner, ...rest] = String(register.path || "").split(".");
                if (!owner || !rest.length || !validRange(register.address, size)) continue;
                ranges.push({
                    start: register.address,
                    end: register.address + size,
                    name: owner + "->" + rest.join(".")
                });
            }
        this.peripheralTree = rangeTree(ranges);
        this.cache.clear();
    }

    // String literals behind `char *` pointers, read from the ELF file's allocated
    // read-only PROGBITS sections only: their bytes equal the target's and never
    // change, so no target memory is read. A file that changed since parsing is ignored.
    stringAt(value) {
        if (formatPointer(value) === null || Number(value) === 0) return null;
        const address = Number(value);
        if (this.strings.has(address)) {
            const cached = this.strings.get(address);
            this.strings.delete(address);
            this.strings.set(address, cached);
            return cached;
        }
        let text = null;
        const section = containingRange(this.readOnlyTree, address)?.section;
        const elf = this.elfFile;
        if (section && elf?.path) {
            try {
                const stat = this.fs.statSync(elf.path);
                if (stat.size === elf.size && stat.mtimeMs === elf.mtimeMs) {
                    const length = Math.min(MAX_STRING_BYTES, section.addr + section.size - address);
                    const bytes = Buffer.alloc(length);
                    const descriptor = this.fs.openSync(elf.path, "r");
                    try {
                        const read = this.fs.readSync(
                            descriptor,
                            bytes,
                            0,
                            length,
                            section.offset + address - section.addr
                        );
                        if (read === length) text = cStringLiteral(bytes);
                    } finally {
                        this.fs.closeSync(descriptor);
                    }
                }
            } catch {
                text = null;
            }
        }
        this.strings.set(address, text);
        if (this.strings.size > this.cacheLimit) this.strings.delete(this.strings.keys().next().value);
        return text;
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
        this.strings.clear();
        this.layoutRequests = new Set();
        this.elfFile = result?.elf?.path ? result.elf : null;
        this.readOnlyTree = rangeTree(
            (this.sections || [])
                .filter(
                    (section) =>
                        section.type === SHT_PROGBITS &&
                        section.flags & SHF_ALLOC &&
                        !(section.flags & SHF_WRITE) &&
                        Number.isSafeInteger(section.offset) &&
                        validRange(section.addr, section.size)
                )
                .map((section) => ({ start: section.addr, end: section.addr + section.size, section }))
        );
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

    // A loaded layout replaces symbol.compositeLayout, which invalidates cached annotations.
    _requestLayout(symbol) {
        if (!this.requestLayout || this.layoutRequests.has(symbol.name)) return;
        this.layoutRequests.add(symbol.name);
        Promise.resolve()
            .then(() => this.requestLayout(symbol.name))
            .catch(() => {});
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
                const layout = symbol.compositeLayout;
                const elementSize =
                    layout?.kind === "array" && !(layout.dimensions?.length > 1) ? layout.elementType?.byteSize : 0;
                if (Number.isSafeInteger(elementSize) && elementSize > 0 && offset % elementSize === 0) {
                    const index = offset / elementSize;
                    return {
                        info: { kind: "data", name, offset, index, text: "→ &" + name + "[" + index + "]" },
                        symbol
                    };
                }
                if (offset && !layout && symbol.isComposite) this._requestLayout(symbol);
                const member = layoutPathAt(layout, offset);
                if (member)
                    return {
                        info: {
                            kind: "data",
                            name,
                            offset,
                            memberPath: member.path,
                            memberOffset: member.rest,
                            text: "→ &" + name + member.path + offsetText(member.rest)
                        },
                        symbol
                    };
                return { info: { kind: "data", name, offset, text: "→ &" + name + offsetText(offset) }, symbol };
            }
        }
        const register = containingRange(this.peripheralTree, address);
        if (register)
            return {
                info: {
                    kind: "peripheral",
                    region: "peripheral",
                    name: register.name,
                    offset: address - register.start,
                    text: "→ &" + register.name + offsetText(address - register.start)
                }
            };
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

module.exports = { PointerSymbolizer, MAX_POINTER_CACHE_ENTRIES, layoutPathAt };
