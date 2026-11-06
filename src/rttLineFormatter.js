"use strict";

// Turns raw RTT channel bytes into terminal text. The text format joins multi-byte sequences split across chunks in the
// channel's encoding, turns LF and CRLF into CRLF (a lone CR still returns the cursor for progress lines), and writes
// an optional host timestamp when the first byte of each line arrives, so a partial line is shown at once and keeps its
// time when it completes. On channel 0 it also follows SEGGER virtual terminals: SEGGER_RTT_SetTerminal() sends 0xFF
// plus an id from "0123456789ABCDEF", a byte pair no supported multi-byte encoding produces. Only latin1 can spell it
// as text, which the virtualTerminals setting turns off. The raw format decodes and passes everything through for
// firmware that drives the terminal itself; the hex format dumps each chunk with its absolute stream offset.
const { SYSTEM_CLOCK } = require("./samplingClock");

const pad = (value, width = 2) => String(value).padStart(width, "0");

// Local wall-clock time HH:MM:SS.mmm
function formatTimestamp(ms) {
    const date = new Date(ms);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// Removes CSI, string (OSC, DCS, ...) and other ESC sequences from text for plain-text logs. A sequence may span
// pushes: channel data arrives in arbitrary chunks.
class AnsiStripper {
    constructor() {
        this.state = "";
    }

    reset() {
        this.state = "";
    }

    push(text) {
        const input = String(text ?? "");
        if (!this.state && !input.includes("\x1b")) return input;
        let plain = "";
        for (const char of input) {
            if (!this.state) {
                if (char === "\x1b") this.state = "escape";
                else plain += char;
            } else if (this.state === "escape") {
                this.state =
                    char === "[" ? "csi" : "]PX^_".includes(char) ? "string" : /[ -/]/.test(char) ? "escape" : "";
            } else if (this.state === "csi") {
                if (/[@-~]/.test(char)) this.state = "";
            } else if (this.state === "string") {
                if (char === "\x07") this.state = "";
                else if (char === "\x1b") this.state = "string-escape";
            } else {
                this.state = char === "\\" || char === "\x07" ? "" : char === "\x1b" ? "string-escape" : "string";
            }
        }
        return plain;
    }
}

const VIRTUAL_TERMINAL_IDS = Buffer.from("0123456789ABCDEF");
const VIRTUAL_TERMINAL_MARKER = 0xff;
const HEX_ROW_BYTES = 16;

// ignoreBOM keeps U+FEFF in the output: this is a stream, not a file, and a BOM here is firmware data.
const newDecoder = (encoding) => new TextDecoder(encoding, { ignoreBOM: true });

class RttLineFormatter {
    constructor({
        timestamps = false,
        clock = SYSTEM_CLOCK,
        formatTime = formatTimestamp,
        encoding = "utf-8",
        virtualTerminals = false
    } = {}) {
        this.timestamps = timestamps === true;
        this.clock = clock;
        this.formatTime = formatTime;
        this.decoder = newDecoder(encoding);
        this.virtualTerminals = virtualTerminals === true;
        this.terminal = 0;
        this.heldMarker = false; // 0xFF ended the last chunk, its id comes next.
        this.atLineStart = true;
        this.pendingCr = false;
    }

    setTimestamps(enabled) {
        this.timestamps = enabled === true;
    }

    _prefix() {
        const time = this.timestamps ? `[${this.formatTime(this.clock.now())}] ` : "";
        return this.terminal ? `${time}[T${this.terminal.toString(16).toUpperCase()}] ` : time;
    }

    // Returns the text to write for this chunk (Buffer or string).
    push(chunk) {
        if (!Buffer.isBuffer(chunk)) return this._format(String(chunk ?? ""));
        if (!this.virtualTerminals) return this._format(this.decoder.decode(chunk, { stream: true }));
        return this._pushTerminals(chunk);
    }

    _pushTerminals(chunk) {
        const data = this.heldMarker ? Buffer.concat([Buffer.of(VIRTUAL_TERMINAL_MARKER), chunk]) : chunk;
        this.heldMarker = false;
        let out = "";
        let start = 0;
        for (let index = data.indexOf(VIRTUAL_TERMINAL_MARKER); index >= 0;) {
            if (index + 1 === data.length) {
                this.heldMarker = true;
                return out + this._format(this.decoder.decode(data.subarray(start, index), { stream: true }));
            }
            const id = VIRTUAL_TERMINAL_IDS.indexOf(data[index + 1]);
            if (id >= 0) {
                out += this._format(this.decoder.decode(data.subarray(start, index), { stream: true }));
                out += this._switchTerminal(id);
                start = index + 2;
            }
            index = data.indexOf(VIRTUAL_TERMINAL_MARKER, id >= 0 ? index + 2 : index + 1);
        }
        return out + this._format(this.decoder.decode(data.subarray(start), { stream: true }));
    }

    // Output of two terminals never shares a line, so each line carries one prefix.
    _switchTerminal(id) {
        if (id === this.terminal) return "";
        const out = this.pendingCr || !this.atLineStart ? "\r\n" : "";
        this.pendingCr = false;
        this.atLineStart = true;
        this.terminal = id;
        return out;
    }

    _format(text) {
        let out = "";
        for (const char of text) {
            if (this.pendingCr) {
                this.pendingCr = false;
                if (char === "\n") {
                    out += "\r\n";
                    this.atLineStart = true;
                    continue;
                }
                // A lone CR rewrites the line from column 0, so it gets a fresh timestamp.
                out += "\r";
                this.atLineStart = true;
            }
            if (char === "\r") {
                this.pendingCr = true;
                continue;
            }
            if (char === "\n") {
                if (this.atLineStart) out += this._prefix();
                out += "\r\n";
                this.atLineStart = true;
                continue;
            }
            if (this.atLineStart) {
                out += this._prefix();
                this.atLineStart = false;
            }
            out += char;
        }
        return out;
    }

    // Emits anything held back (an incomplete sequence or a trailing CR), e.g. when the channel closes.
    flush() {
        const held = this.heldMarker ? Buffer.of(VIRTUAL_TERMINAL_MARKER) : Buffer.alloc(0);
        this.heldMarker = false;
        let out = this._format(this.decoder.decode(held));
        if (this.pendingCr) {
            this.pendingCr = false;
            out += "\r";
            this.atLineStart = true;
        }
        return out;
    }
}

// Firmware that positions the cursor or runs a shell owns the terminal, so bytes reach it unchanged.
class RttRawFormatter {
    constructor({ encoding = "utf-8" } = {}) {
        this.decoder = newDecoder(encoding);
    }

    setTimestamps() {}

    push(chunk) {
        return Buffer.isBuffer(chunk) ? this.decoder.decode(chunk, { stream: true }) : String(chunk ?? "");
    }

    flush() {
        return this.decoder.decode();
    }
}

// A chunk keeps its own rows: a short row shows a short packet at once instead of waiting for sixteen bytes.
class RttHexFormatter {
    constructor({ timestamps = false, clock = SYSTEM_CLOCK, formatTime = formatTimestamp } = {}) {
        this.timestamps = timestamps === true;
        this.clock = clock;
        this.formatTime = formatTime;
        this.offset = 0;
    }

    setTimestamps(enabled) {
        this.timestamps = enabled === true;
    }

    // cursor: the stream offset of the chunk's first byte, so a dump stays addressable across a gap.
    push(chunk, cursor = this.offset) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), "latin1");
        const prefix = this.timestamps ? `[${this.formatTime(this.clock.now())}] ` : "";
        let out = "";
        for (let start = 0; start < bytes.length; start += HEX_ROW_BYTES) {
            const row = [...bytes.subarray(start, start + HEX_ROW_BYTES)];
            const hex = row.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
            const text = row.map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ".")).join("");
            const offset = (cursor + start).toString(16).padStart(8, "0");
            out += `${prefix}${offset}  ${hex.padEnd(HEX_ROW_BYTES * 3 - 1)}  |${text}|\r\n`;
        }
        this.offset = cursor + bytes.length;
        return out;
    }

    flush() {
        return "";
    }
}

/** @param {{ format?: string, encoding?: string, timestamps?: boolean, virtualTerminals?: boolean, clock?: any }} [settings] */
function createRttFormatter({ format = "text", ...options } = {}) {
    if (format === "raw") return new RttRawFormatter(options);
    if (format === "hex") return new RttHexFormatter(options);
    return new RttLineFormatter(options);
}

module.exports = {
    AnsiStripper,
    RttHexFormatter,
    RttLineFormatter,
    RttRawFormatter,
    createRttFormatter,
    formatTimestamp
};
