"use strict";

// SEGGER RTT control-block location and the OpenOCD `rtt` command set. Pure: no probe, socket or file access.
// Location priority: configured address > ELF _SEGGER_RTT symbol > configured search range > writable ELF sections >
// linker RAM regions. Only the first two are exact; the rest let OpenOCD scan for the "SEGGER RTT" ID.
const { createSymbolResolver } = require("./elfSymbols");
const { quoteTclWord } = require("./openocdRunner");

const RTT_ID = "SEGGER RTT";
const CONTROL_BLOCK_SYMBOL = "_SEGGER_RTT";
// acID[16] + MaxNumUpBuffers + MaxNumDownBuffers + one up and one down SEGGER_RTT_BUFFER (24 bytes each)
const MIN_CONTROL_BLOCK_SIZE = 72;
const AUTO_SCAN_MAX_BYTES = 1024 * 1024;
const MANUAL_SCAN_MAX_BYTES = 16 * 1024 * 1024;
// Writable sections closer than this are scanned as one range (alignment padding, small heaps between .data and .bss)
const SECTION_MERGE_GAP = 64 * 1024;
const MAX_CHANNEL = 255;
const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const ADDRESS_SPACE = 0x100000000;

const hex = (value) => `0x${value.toString(16).toUpperCase()}`;
const rttError = (code, message, details) =>
    Object.assign(new Error(message), { code, ...(details ? { details } : {}) });

// Accepts a non-negative integer or a decimal/0x-hex string; "" and null mean "not configured".
function parseAddress(value, label) {
    if (value === undefined || value === null || value === "") return null;
    const text = typeof value === "number" ? String(value) : String(value).trim();
    const parsed = /^0x[0-9a-f]{1,8}$/i.test(text) ? parseInt(text, 16) : /^\d{1,10}$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed >= ADDRESS_SPACE)
        throw rttError("RTT_INVALID_ADDRESS", `Invalid RTT ${label}: ${value}`, { [label]: value });
    return parsed;
}

function checkedRange(address, size, maxBytes, source) {
    if (!Number.isSafeInteger(size) || size < 16 || address + size > ADDRESS_SPACE)
        throw rttError("RTT_INVALID_RANGE", `Invalid RTT search range ${hex(address)} + ${size}`, { source });
    if (size > maxBytes)
        throw rttError(
            "RTT_SCAN_RANGE_TOO_LARGE",
            `RTT search range ${hex(address)} + ${size} exceeds ${maxBytes} bytes; set emberprobe.rtt.controlBlockAddress ` +
                "or a smaller emberprobe.rtt.searchRange",
            { source, address: hex(address), size, maxBytes }
        );
    return { source, address, size, exact: false };
}

function symbolBlock(symbols) {
    if (!Array.isArray(symbols) || !symbols.length) return null;
    let symbol;
    try {
        symbol = createSymbolResolver(symbols, { foldCase: false })(CONTROL_BLOCK_SYMBOL);
    } catch (error) {
        if (error.code === "VARIABLE_NOT_FOUND") return null;
        if (error.code === "VARIABLE_AMBIGUOUS")
            throw rttError("RTT_CONTROL_BLOCK_AMBIGUOUS", `Several ${CONTROL_BLOCK_SYMBOL} symbols in the ELF`, {
                candidates: error.details?.candidates
            });
        throw error;
    }
    if (!symbol) return null;
    const address = Number(symbol.address) >>> 0;
    if (!address) return null;
    const size = Math.max(Number(symbol.size) || 0, MIN_CONTROL_BLOCK_SIZE);
    return { source: "symbol", address, size, exact: true };
}

function writableSectionRange(sections) {
    const writable = (Array.isArray(sections) ? sections : [])
        .filter((s) => (s.flags & (SHF_WRITE | SHF_ALLOC)) === (SHF_WRITE | SHF_ALLOC) && s.size > 0 && s.addr > 0)
        .sort((a, b) => a.addr - b.addr);
    const ranges = [];
    for (const section of writable) {
        const last = ranges[ranges.length - 1];
        const end = section.addr + section.size;
        if (last && section.addr <= last.end + SECTION_MERGE_GAP) {
            last.end = Math.max(last.end, end);
            last.names.push(section.name);
        } else ranges.push({ start: section.addr, end, names: [section.name] });
    }
    if (!ranges.length) return null;
    // SEGGER places the control block in .bss (or a named RAM section next to it); otherwise take the largest span.
    const chosen =
        ranges.find((range) => range.names.includes(".bss")) ||
        ranges.reduce((best, range) => (range.end - range.start > best.end - best.start ? range : best));
    return { address: chosen.start, size: chosen.end - chosen.start };
}

function regionRange(regions) {
    const ram = (Array.isArray(regions) ? regions : []).filter(
        (r) => r.type === "ram" && Number.isSafeInteger(r.origin) && Number.isSafeInteger(r.capacity) && r.capacity > 0
    );
    return ram.length ? { address: ram[0].origin, size: ram[0].capacity, name: ram[0].name } : null;
}

// Returns { source, address, size, exact } for `rtt setup`. settings: { controlBlockAddress, searchRange: { address,
// size } }; symbols: ELF symbols; sections: parseElfSections().sections; regions: linker regions typed by memoryAnalysis.
/**
 * @param {{ settings?: { controlBlockAddress?: string | number, searchRange?: { address?: string | number, size?: string | number } },
 *   symbols?: any[], sections?: any[], regions?: any[] }} [inputs]
 */
function resolveControlBlock({ settings = {}, symbols, sections, regions } = {}) {
    const configured = parseAddress(settings.controlBlockAddress, "controlBlockAddress");
    if (configured !== null) {
        if (configured + MIN_CONTROL_BLOCK_SIZE > ADDRESS_SPACE)
            throw rttError("RTT_INVALID_ADDRESS", `Invalid RTT controlBlockAddress: ${settings.controlBlockAddress}`);
        return { source: "address", address: configured, size: MIN_CONTROL_BLOCK_SIZE, exact: true };
    }
    const fromSymbol = symbolBlock(symbols);
    if (fromSymbol) return fromSymbol;
    const range = settings.searchRange;
    const rangeAddress = parseAddress(range?.address, "searchRange.address");
    if (rangeAddress !== null) {
        const size = parseAddress(range.size, "searchRange.size");
        return checkedRange(rangeAddress, size ?? 0, MANUAL_SCAN_MAX_BYTES, "range");
    }
    const fromSections = writableSectionRange(sections);
    if (fromSections) return checkedRange(fromSections.address, fromSections.size, AUTO_SCAN_MAX_BYTES, "sections");
    const fromRegion = regionRange(regions);
    if (fromRegion) return checkedRange(fromRegion.address, fromRegion.size, AUTO_SCAN_MAX_BYTES, "region");
    throw rttError(
        "RTT_CONTROL_BLOCK_UNKNOWN",
        `No ${CONTROL_BLOCK_SYMBOL} symbol or RAM range to search; set emberprobe.rtt.controlBlockAddress`
    );
}

function integerIn(value, min, max, code, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw rttError(code, `Invalid RTT ${label}: ${value}`, { [label]: value });
    return value;
}

const commands = Object.freeze({
    setup: (block) => {
        const address = integerIn(block?.address, 0, ADDRESS_SPACE - 1, "RTT_INVALID_ADDRESS", "address");
        const size = integerIn(block?.size, 16, ADDRESS_SPACE - address, "RTT_INVALID_RANGE", "size");
        return `rtt setup ${hex(address)} ${size} ${quoteTclWord(RTT_ID)}`;
    },
    start: () => "rtt start",
    stop: () => "rtt stop",
    pollingInterval: (ms) =>
        `rtt polling_interval ${integerIn(ms, 1, 60000, "RTT_INVALID_INTERVAL", "pollingIntervalMs")}`,
    channelList: () => "rtt channellist",
    serverStart: (port, channel) =>
        `rtt server start ${integerIn(port, 1, 65535, "RTT_INVALID_PORT", "port")} ` +
        integerIn(channel, 0, MAX_CHANNEL, "RTT_INVALID_CHANNEL", "channel"),
    serverStop: (port) => `rtt server stop ${integerIn(port, 1, 65535, "RTT_INVALID_PORT", "port")}`
});

// Minimal Tcl list splitter for OpenOCD results: words, {braced} groups (nested) and "quoted" words with escapes.
function splitTclList(text) {
    const source = String(text ?? "");
    const words = [];
    let i = 0;
    while (i < source.length) {
        while (i < source.length && /\s/.test(source[i])) i++;
        if (i >= source.length) break;
        if (source[i] === "{") {
            let depth = 1,
                j = i + 1;
            for (; j < source.length && depth; j++) {
                if (source[j] === "\\") j++;
                else if (source[j] === "{") depth++;
                else if (source[j] === "}") depth--;
            }
            if (depth) throw rttError("RTT_PARSE_ERROR", "Unbalanced braces in OpenOCD RTT result");
            words.push(source.slice(i + 1, j - 1));
            i = j;
        } else if (source[i] === '"') {
            let word = "",
                j = i + 1;
            for (; j < source.length && source[j] !== '"'; j++) word += source[j] === "\\" ? source[++j] : source[j];
            if (j >= source.length) throw rttError("RTT_PARSE_ERROR", "Unterminated quote in OpenOCD RTT result");
            words.push(word);
            i = j + 1;
        } else {
            let j = i;
            while (j < source.length && !/\s/.test(source[j])) j++;
            words.push(source.slice(i, j));
            i = j;
        }
    }
    return words;
}

const CHANNEL_MODES = ["skip", "trim", "block"];

// Parses `rtt channellist`: "up {{name Terminal size 1024 flags 2} ...} down {{...}}" into { up: [...], down: [...] }
// with { index, name, size, flags, mode }. Unknown keys are ignored so newer OpenOCD fields do not break parsing.
function parseChannelList(text) {
    const top = splitTclList(text);
    const result = { up: [], down: [] };
    for (let i = 0; i + 1 < top.length; i += 2) {
        const direction = top[i];
        if (direction !== "up" && direction !== "down") continue;
        result[direction] = splitTclList(top[i + 1]).map((entry, index) => {
            const fields = splitTclList(entry);
            const record = {};
            for (let k = 0; k + 1 < fields.length; k += 2) record[fields[k]] = fields[k + 1];
            const size = Number(record.size) || 0;
            const flags = Number(record.flags) || 0;
            return { index, name: record.name || "", size, flags, mode: CHANNEL_MODES[flags & 3] || "unknown" };
        });
    }
    return result;
}

// OpenOCD announces each RTT TCP server with "Listening on port N for rtt connections".
function parseRttListening(line) {
    const match = /Listening on port (\d+) for rtt connections/i.exec(String(line ?? ""));
    return match ? Number(match[1]) : null;
}

module.exports = {
    AUTO_SCAN_MAX_BYTES,
    CONTROL_BLOCK_SYMBOL,
    MANUAL_SCAN_MAX_BYTES,
    MIN_CONTROL_BLOCK_SIZE,
    RTT_ID,
    commands,
    parseChannelList,
    parseRttListening,
    resolveControlBlock,
    splitTclList
};
