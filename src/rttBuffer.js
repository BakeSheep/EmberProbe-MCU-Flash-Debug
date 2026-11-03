"use strict";

// Bounded byte history of one RTT up channel for cursor-based readers (Agent Bridge). A cursor is the absolute byte
// offset since the buffer's generation started; old bytes are evicted by maxBytes and reported as droppedBytes.
// reset() (new session, re-attach, flash) starts a new generation so cursors from before it cannot alias new data.
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_READ_BYTES = 16 * 1024;
const MAX_READ_BYTES = 256 * 1024;

const clampBytes = (value, fallback, max) =>
    Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : Math.min(fallback, max);

// Length of the longest prefix of bytes[0, end) that does not split a UTF-8 sequence at its end.
function utf8Boundary(bytes, end) {
    let lead = end - 1,
        continuation = 0;
    while (lead >= 0 && continuation < 3 && (bytes[lead] & 0xc0) === 0x80) {
        lead--;
        continuation++;
    }
    if (lead < 0) return end;
    const byte = bytes[lead];
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return width > continuation + 1 ? lead : end;
}

class RttBuffer {
    constructor({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
            throw Object.assign(new Error(`Invalid RTT buffer size: ${maxBytes}`), { code: "RTT_INVALID_BUFFER" });
        this.maxBytes = maxBytes;
        this.generation = 0;
        this._reset();
    }

    _reset() {
        this.chunks = [];
        this.start = 0; // absolute offset of chunks[0][0]
        this.end = 0;
    }

    reset() {
        this.generation++;
        this._reset();
    }

    append(data) {
        // Copy: socket chunks may be pooled and reused by the caller.
        const bytes = Buffer.from(Buffer.isBuffer(data) ? data : String(data ?? ""));
        if (!bytes.length) return this.end;
        this.end += bytes.length;
        if (bytes.length >= this.maxBytes) {
            this.chunks = [bytes.subarray(bytes.length - this.maxBytes)];
            this.start = this.end - this.maxBytes;
            return this.end;
        }
        this.chunks.push(bytes);
        while (this.end - this.start > this.maxBytes) {
            const excess = this.end - this.start - this.maxBytes;
            const first = this.chunks[0];
            if (first.length <= excess) {
                this.chunks.shift();
                this.start += first.length;
            } else {
                this.chunks[0] = first.subarray(excess);
                this.start += excess;
            }
        }
        return this.end;
    }

    // { generation, cursor } from a previous read, or nothing to start at the oldest retained byte. Returns
    // { generation, cursor (where data starts), nextCursor, data: Buffer, droppedBytes, reset, more }.
    /** @param {{ generation?: number, cursor?: number, maxBytes?: number }} [request] */
    read({ generation, cursor, maxBytes } = {}) {
        const limit = clampBytes(maxBytes, DEFAULT_READ_BYTES, MAX_READ_BYTES);
        const valid =
            generation === this.generation && Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= this.end;
        const requested = valid ? cursor : this.start;
        const from = Math.max(requested, this.start);
        let to = Math.min(this.end, from + limit);
        const parts = [];
        let offset = this.start;
        for (const chunk of this.chunks) {
            const chunkEnd = offset + chunk.length;
            if (chunkEnd > from && offset < to) parts.push(chunk.subarray(Math.max(0, from - offset), to - offset));
            offset = chunkEnd;
            if (offset >= to) break;
        }
        let data = Buffer.concat(parts);
        if (to < this.end) {
            const cut = utf8Boundary(data, data.length);
            if (cut > 0) data = data.subarray(0, cut);
            to = from + data.length;
        }
        return {
            generation: this.generation,
            cursor: from,
            nextCursor: to,
            data,
            droppedBytes: from - requested,
            reset: !valid && (generation !== undefined || cursor !== undefined),
            more: to < this.end
        };
    }

    stats() {
        return { generation: this.generation, start: this.start, end: this.end, bytes: this.end - this.start };
    }
}

module.exports = { DEFAULT_MAX_BYTES, DEFAULT_READ_BYTES, MAX_READ_BYTES, RttBuffer, utf8Boundary };
