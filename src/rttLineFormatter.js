"use strict";

// Turns raw RTT channel bytes into terminal text: UTF-8 sequences split across socket chunks are joined, LF and CRLF
// become CRLF (a lone CR still returns the cursor for progress lines), and an optional host timestamp is written when
// the first byte of each line arrives, so a partial line is shown at once and keeps its time when it completes.
const { StringDecoder } = require("string_decoder");
const { SYSTEM_CLOCK } = require("./samplingClock");

// CSI/OSC/other ESC sequences; used for plain-text log files.
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

const stripAnsi = (text) => String(text ?? "").replace(ANSI_PATTERN, "");

const pad = (value, width = 2) => String(value).padStart(width, "0");

// Local wall-clock time HH:MM:SS.mmm
function formatTimestamp(ms) {
    const date = new Date(ms);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

class RttLineFormatter {
    constructor({ timestamps = false, clock = SYSTEM_CLOCK, formatTime = formatTimestamp } = {}) {
        this.timestamps = timestamps === true;
        this.clock = clock;
        this.formatTime = formatTime;
        this.decoder = new StringDecoder("utf8");
        this.atLineStart = true;
        this.pendingCr = false;
    }

    setTimestamps(enabled) {
        this.timestamps = enabled === true;
    }

    _prefix() {
        return this.timestamps ? `[${this.formatTime(this.clock.now())}] ` : "";
    }

    // Returns the text to write for this chunk (Buffer or string).
    push(chunk) {
        const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk ?? "");
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

    // Emits anything held back (an incomplete UTF-8 sequence or a trailing CR), e.g. when the channel closes.
    flush() {
        let out = this.push(this.decoder.end());
        if (this.pendingCr) {
            this.pendingCr = false;
            out += "\r";
            this.atLineStart = true;
        }
        return out;
    }
}

module.exports = { RttLineFormatter, formatTimestamp, stripAnsi };
