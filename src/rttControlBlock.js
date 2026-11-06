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
// `rtt start` scans in one blocking command and a Tcl RPC timeout resets the connection, so a range is searched in
// slices small enough to finish inside that timeout on a slow adapter, releasing the session between them. Slices
// overlap by the ID so a control block across a boundary is still found.
const SCAN_SLICE_BYTES = 32 * 1024;
const SCAN_SLICE_OVERLAP = 16;
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

// Every writable span, best guess first: SEGGER places the control block in .bss, but a project may give it its own
// RAM section (`.rtt_cb` in AXI SRAM while .bss stays in DTCM). Without .bss the largest span leads.
function writableSectionRanges(sections) {
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
    const rank = (range) => (range.names.includes(".bss") ? Infinity : range.end - range.start);
    return ranges
        .sort((a, b) => rank(b) - rank(a))
        .map((range) => ({ address: range.start, size: range.end - range.start }));
}

// The first span is checked as a search range; later ones join while the whole scan stays within the automatic limit.
function sectionBlock(ranges) {
    const block = checkedRange(ranges[0].address, ranges[0].size, AUTO_SCAN_MAX_BYTES, "sections");
    let total = block.size;
    const more = ranges.slice(1).filter((range) => {
        if (total + range.size > AUTO_SCAN_MAX_BYTES) return false;
        total += range.size;
        return true;
    });
    return more.length ? { ...block, more } : block;
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
    const fromSections = writableSectionRanges(sections);
    if (fromSections.length) return sectionBlock(fromSections);
    const fromRegion = regionRange(regions);
    if (fromRegion) return checkedRange(fromRegion.address, fromRegion.size, AUTO_SCAN_MAX_BYTES, "region");
    throw rttError(
        "RTT_CONTROL_BLOCK_UNKNOWN",
        `No ${CONTROL_BLOCK_SYMBOL} symbol or RAM range to search; set emberprobe.rtt.controlBlockAddress`
    );
}

// The `rtt setup` ranges to try in order for a resolved block; an exact block is one range.
function scanSlices(block) {
    const { more = [], ...first } = block;
    return [first, ...more.map((range) => ({ ...first, ...range }))].flatMap(rangeSlices);
}

function rangeSlices(range) {
    if (range.exact || range.size <= SCAN_SLICE_BYTES + SCAN_SLICE_OVERLAP) return [range];
    const slices = [];
    for (let offset = 0; ; offset += SCAN_SLICE_BYTES) {
        const size = Math.min(SCAN_SLICE_BYTES + SCAN_SLICE_OVERLAP, range.size - offset);
        slices.push({ ...range, address: range.address + offset, size });
        if (offset + size >= range.size) return slices;
    }
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
    channels: () => "rtt channels",
    serverStart: (port, channel) =>
        `rtt server start ${integerIn(port, 1, 65535, "RTT_INVALID_PORT", "port")} ` +
        integerIn(channel, 0, MAX_CHANNEL, "RTT_INVALID_CHANNEL", "channel"),
    serverStop: (port) => `rtt server stop ${integerIn(port, 1, 65535, "RTT_INVALID_PORT", "port")}`
});

const CHANNEL_MODES = ["skip", "trim", "block"];
const CHANNEL_FORMATS = ["text", "raw", "hex"];
// WHATWG labels, all available from TextDecoder in the extension host (verified on VS Code 1.136 / Electron 42).
const CHANNEL_ENCODINGS = ["utf-8", "gbk", "gb18030", "big5", "shift_jis", "euc-kr", "latin1"];
const CHANNEL_FIELDS = ["index", "mode", "format", "encoding", "down"];
const CHANNEL_LINE = /^(\d+): (.*) (\d+) (\d+)$/;

// Parses `rtt channels` into { up: [...], down: [...] } with { index, name, size, flags, mode }:
//   Channels: up=3, down=1
//   Up-channels:
//   0: Terminal 1024 0
//   2: Log 1024 2
//   Down-channels:
//   0: Terminal 16 0
// OpenOCD omits unconfigured channels (size 0), so only this listing gives the channel number; `rtt channellist`
// has none. The firmware owns the name, which may be empty or contain spaces, hence the anchored numeric fields.
// A control block in a section the startup code leaves uninitialized holds random values in its unconfigured channels.
// SEGGER's flags use only the low bits, so those channels are recognized by their flags or size.
const MAX_CHANNEL_SIZE = 0x10000000;
const MAX_CHANNEL_FLAGS = 0xff;

function parseChannelList(text) {
    const result = { up: [], down: [] };
    let direction = null;
    for (const line of String(text ?? "").split(/\r?\n/)) {
        if (line === "Up-channels:") direction = "up";
        else if (line === "Down-channels:") direction = "down";
        else {
            const match = direction && CHANNEL_LINE.exec(line);
            if (!match) continue;
            const size = Number(match[3]);
            const flags = Number(match[4]);
            if (size > MAX_CHANNEL_SIZE || flags > MAX_CHANNEL_FLAGS) continue;
            result[direction].push({
                index: Number(match[1]),
                name: match[2],
                size,
                flags,
                mode: CHANNEL_MODES[flags & 3] || "unknown"
            });
        }
    }
    if (direction === null) throw rttError("RTT_PARSE_ERROR", "Unexpected OpenOCD rtt channels result");
    return result;
}

// Normalize once per manual start; retries and session following must not acquire new write intent from settings.
function normalizeRttSettings(settings = {}) {
    const selected = settings.channels;
    const encoding = settings.encoding ?? "utf-8";
    if (!CHANNEL_ENCODINGS.includes(encoding))
        throw rttError("RTT_INVALID_CHANNELS", `Invalid RTT encoding: ${encoding}`);
    let channels;
    if (selected !== undefined) {
        if (!Array.isArray(selected) || !selected.length || selected.length > 16)
            throw rttError("RTT_INVALID_CHANNELS", "RTT channels must list 1..16 unique channel entries");
        const seen = new Set();
        channels = selected.map((entry) => {
            const object = entry !== null && typeof entry === "object" && !Array.isArray(entry);
            if (object && Object.keys(entry).some((key) => !CHANNEL_FIELDS.includes(key)))
                throw rttError("RTT_INVALID_CHANNELS", "Unknown RTT channel configuration field");
            const index = object ? entry.index : entry;
            integerIn(index, 0, MAX_CHANNEL, "RTT_INVALID_CHANNELS", "channel");
            const mode = object ? entry.mode : undefined;
            if (mode !== undefined && !CHANNEL_MODES.includes(mode))
                throw rttError("RTT_INVALID_CHANNELS", `Invalid RTT channel mode: ${mode}`);
            if (seen.has(index)) throw rttError("RTT_INVALID_CHANNELS", `Duplicate RTT channel: ${index}`);
            seen.add(index);
            const { format = "text", encoding: channelEncoding = encoding, down = index } = object ? entry : {};
            if (!CHANNEL_FORMATS.includes(format))
                throw rttError("RTT_INVALID_CHANNELS", `Invalid RTT channel format: ${format}`);
            if (!CHANNEL_ENCODINGS.includes(channelEncoding))
                throw rttError("RTT_INVALID_CHANNELS", `Invalid RTT encoding: ${channelEncoding}`);
            integerIn(down, 0, MAX_CHANNEL, "RTT_INVALID_CHANNELS", "channel");
            return Object.freeze({
                index,
                ...(mode === undefined ? {} : { mode }),
                format,
                encoding: channelEncoding,
                down
            });
        });
        Object.freeze(channels);
    }
    const configuredPollingIntervalMs = settings.pollingIntervalMs ?? 10;
    integerIn(configuredPollingIntervalMs, 0, 60000, "RTT_INVALID_INTERVAL", "pollingIntervalMs");
    return Object.freeze({
        encoding,
        controlBlockAddress: settings.controlBlockAddress,
        searchRange: settings.searchRange ? Object.freeze({ ...settings.searchRange }) : undefined,
        channels,
        configuredPollingIntervalMs,
        pollingIntervalMs: configuredPollingIntervalMs || 100
    });
}

module.exports = {
    AUTO_SCAN_MAX_BYTES,
    CHANNEL_ENCODINGS,
    CHANNEL_FORMATS,
    CONTROL_BLOCK_SYMBOL,
    MANUAL_SCAN_MAX_BYTES,
    MIN_CONTROL_BLOCK_SIZE,
    RTT_ID,
    SCAN_SLICE_BYTES,
    commands,
    normalizeRttSettings,
    parseChannelList,
    resolveControlBlock,
    scanSlices
};
