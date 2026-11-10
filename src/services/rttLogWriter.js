"use strict";

// Append-only log for one RTT channel: formatted text, or the channel's bytes as received with raw. When the current file fills its maxBytes budget it is renamed to
// "<file>.1" (replacing the previous backup) and a fresh file begins, so a long session is bounded by two files.
// Writes are synchronous: the poll tick appends small formatted chunks, and a rotation must not race a buffered
// stream. A failed write is reported once through onError and latches: the channel keeps its terminal without
// retrying the broken path on every tick.
const fs = require("fs");
const { utf8Boundary } = require("../rttBuffer");

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

class RttLogWriter {
    // options: { maxBytes, raw, onError }. onError(error, file) fires at most once per opened file.
    constructor({ maxBytes = DEFAULT_MAX_BYTES, raw = false, onError = (_error, _file) => {} } = {}) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 4)
            throw Object.assign(new Error(`Invalid RTT log size: ${maxBytes}`), { code: "RTT_INVALID_LOG_SIZE" });
        this.maxBytes = maxBytes;
        this.raw = raw === true;
        this._onError = onError;
        this._file = null;
        this._bytes = 0;
        this._failed = false;
    }

    get file() {
        return this._file;
    }

    // Starts logging to file; existing content counts towards the size limit.
    open(file) {
        this.close();
        this._file = file ? String(file) : null;
        this._failed = false;
        if (!this._file) return;
        try {
            this._bytes = this._sizeOf(this._file);
        } catch (error) {
            this._fail(error);
        }
    }

    append(text) {
        this._write(Buffer.from(String(text ?? ""), "utf8"), true);
    }

    appendBytes(data) {
        this._write(data, false);
    }

    _write(data, keepCharacters) {
        if (this._failed || !this._file || !data.length) return;
        try {
            for (let offset = 0; offset < data.length;) {
                if (this._bytes >= this.maxBytes) this._rotate();
                const remaining = data.subarray(offset);
                const room = Math.min(remaining.length, this.maxBytes - this._bytes);
                const length = keepCharacters ? utf8Boundary(remaining, room) : room;
                if (!length) {
                    this._rotate();
                    continue;
                }
                const end = offset + length;
                fs.appendFileSync(this._file, data.subarray(offset, end));
                this._bytes += end - offset;
                offset = end;
            }
        } catch (error) {
            this._fail(error);
        }
    }

    close() {
        this._file = null;
        this._bytes = 0;
    }

    _rotate() {
        const backup = `${this._file}.1`;
        try {
            fs.unlinkSync(backup);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        fs.renameSync(this._file, backup);
        this._bytes = 0;
    }

    _sizeOf(file) {
        try {
            return fs.statSync(file).size;
        } catch (error) {
            if (error.code === "ENOENT") return 0;
            throw error;
        }
    }

    _fail(error) {
        this._failed = true;
        const file = this._file;
        this.close();
        try {
            this._onError(error, file);
        } catch {
            /* A log consumer must not break the channel. */
        }
    }
}

module.exports = { DEFAULT_MAX_BYTES, RttLogWriter };
