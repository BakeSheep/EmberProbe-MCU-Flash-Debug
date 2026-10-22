"use strict";

const fs = require("fs");
const { isUtf8 } = require("buffer");
const { TextDecoder } = require("util");

const FILE_HEADER = Buffer.alloc(16);
FILE_HEADER.write("EPSA");
FILE_HEADER.writeUInt16LE(1, 4);
const DICTIONARY_LIMIT = 65535;
const CHUNK_BYTES = 256 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function dictionaryFull() {
    return Object.assign(new Error("Sampling archive dictionary is full"), {
        code: "SAMPLING_ARCHIVE_DICTIONARY_FULL"
    });
}

function stringBytes(text) {
    return 4 + Buffer.byteLength(text);
}

function writeString(buffer, offset, text) {
    const length = Buffer.byteLength(text);
    buffer.writeUInt32LE(length, offset);
    buffer.write(text, offset + 4, length);
    return offset + 4 + length;
}

function valueKind(text) {
    if (text === null) return 0;
    const n = Number(text);
    if (String(n) !== text) return 4;
    if (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647) return 1;
    if (Math.fround(n) === n) return 2;
    return 3;
}

class ArchiveEncoder {
    constructor() {
        this.scopes = new Map();
        this.channels = new Map();
        this.channelDefinitions = [];
    }

    dictionary() {
        return {
            scopes: [...this.scopes.keys()],
            channels: this.channelDefinitions.map((channel) => ({ ...channel }))
        };
    }

    encodeRow({ t, scope = "", generation = 0, values }) {
        if (
            !Number.isFinite(t) ||
            typeof scope !== "string" ||
            !Number.isInteger(generation) ||
            generation < 0 ||
            generation > 0xffffffff ||
            !Array.isArray(values)
        )
            throw new TypeError("Invalid sampling archive row");
        if (values.length > DICTIONARY_LIMIT) throw dictionaryFull();
        const definitions = [];
        const scopeId = this.scopes.get(scope) ?? this.scopes.size;
        if (!this.scopes.has(scope)) {
            if (scopeId >= DICTIONARY_LIMIT) throw dictionaryFull();
            definitions.push({ type: 1, id: scopeId, strings: [scope] });
        }
        // Stage definitions until the entire row has validated, so rejected rows cannot leave holes.
        const pending = new Map();
        let nextChannelId = this.channelDefinitions.length;
        const entries = values.map(({ key, text, identity = "" }) => {
            if (typeof key !== "string" || (text !== null && typeof text !== "string") || typeof identity !== "string")
                throw new TypeError("Invalid sampling archive value");
            let id = this.channels.get(key)?.get(identity) ?? pending.get(key)?.get(identity);
            if (id === undefined) {
                id = nextChannelId++;
                if (id >= DICTIONARY_LIMIT) throw dictionaryFull();
                if (!pending.has(key)) pending.set(key, new Map());
                pending.get(key).set(identity, id);
                definitions.push({ type: 2, id, strings: [key, identity] });
            }
            const kind = valueKind(text);
            return {
                id,
                text,
                kind,
                bytes: 3 + (kind === 0 ? 0 : kind === 4 ? stringBytes(text) : kind === 3 ? 8 : 4)
            };
        });
        const rowLength = 16 + entries.reduce((size, entry) => size + entry.bytes, 0);
        const definitionLengths = definitions.map(
            (definition) => 2 + definition.strings.reduce((size, text) => size + stringBytes(text), 0)
        );
        const buffer = Buffer.allocUnsafe(
            5 + rowLength + definitionLengths.reduce((size, length) => size + 5 + length, 0)
        );
        let offset = 0;
        definitions.forEach((definition, i) => {
            buffer.writeUInt8(definition.type, offset);
            buffer.writeUInt32LE(definitionLengths[i], offset + 1);
            buffer.writeUInt16LE(definition.id, offset + 5);
            offset += 7;
            for (const text of definition.strings) offset = writeString(buffer, offset, text);
        });
        buffer.writeUInt8(3, offset);
        buffer.writeUInt32LE(rowLength, offset + 1);
        buffer.writeUInt16LE(scopeId, offset + 5);
        buffer.writeUInt32LE(generation, offset + 7);
        buffer.writeDoubleLE(t, offset + 11);
        buffer.writeUInt16LE(entries.length, offset + 19);
        offset += 21;
        for (const { id, text, kind } of entries) {
            buffer.writeUInt16LE(id, offset);
            buffer.writeUInt8(kind, offset + 2);
            offset += 3;
            if (kind === 4) offset = writeString(buffer, offset, text);
            else if (kind !== 0) {
                if (kind === 1) buffer.writeInt32LE(Number(text), offset);
                else if (kind === 2) buffer.writeFloatLE(Number(text), offset);
                else buffer.writeDoubleLE(Number(text), offset);
                offset += kind === 3 ? 8 : 4;
            }
        }
        this.scopes.set(scope, scopeId);
        for (const [key, identities] of pending) {
            if (!this.channels.has(key)) this.channels.set(key, new Map());
            for (const [identity, id] of identities) this.channels.get(key).set(identity, id);
        }
        for (const definition of definitions) {
            if (definition.type === 2)
                this.channelDefinitions.push({ key: definition.strings[0], identity: definition.strings[1] });
        }
        return buffer;
    }
}

function seedDictionary(dictionary) {
    const scopes = dictionary?.scopes ?? [];
    const channels = dictionary?.channels ?? [];
    if (
        !Array.isArray(scopes) ||
        !Array.isArray(channels) ||
        scopes.length > DICTIONARY_LIMIT ||
        channels.length > DICTIONARY_LIMIT ||
        ![...scopes].every((scope) => typeof scope === "string") ||
        ![...channels].every(
            (channel) => channel && typeof channel.key === "string" && typeof channel.identity === "string"
        )
    )
        return null;
    return { scopes: [...scopes], channels: channels.map((channel) => ({ ...channel })) };
}

// All payload reads are bounded by the record, including UTF-8 validation and dictionary references.
// Definitions commit only after the complete payload has validated.
function decodePayload(type, payload, dictionary) {
    let cursor = 0;
    const take = (length) => {
        if (cursor + length > payload.length) throw new Error("Incomplete archive payload");
        const at = cursor;
        cursor += length;
        return at;
    };
    const u16 = () => payload.readUInt16LE(take(2));
    const string = () => {
        const length = payload.readUInt32LE(take(4));
        const at = take(length);
        return utf8.decode(payload.subarray(at, at + length));
    };
    const complete = () => {
        if (cursor !== payload.length) throw new Error("Trailing archive payload");
    };
    if (type === 1 || type === 2) {
        const id = u16();
        const key = string();
        const identity = type === 2 ? string() : "";
        complete();
        const entries = type === 1 ? dictionary.scopes : dictionary.channels;
        if (id > entries.length || id >= DICTIONARY_LIMIT) throw new Error("Invalid archive dictionary id");
        if (id < entries.length) {
            const previous = entries[id];
            if (type === 1 ? previous !== key : previous.key !== key || previous.identity !== identity)
                throw new Error("Conflicting archive dictionary definition");
        } else entries.push(type === 1 ? key : { key, identity });
        return null;
    }
    const scopeId = u16();
    const generation = payload.readUInt32LE(take(4));
    const t = payload.readDoubleLE(take(8));
    const count = u16();
    if (scopeId >= dictionary.scopes.length || !Number.isFinite(t)) throw new Error("Invalid archive row");
    // defineProperty handles keys such as __proto__ without changing the object's prototype.
    const v = {};
    const identities = {};
    for (let i = 0; i < count; i++) {
        const channel = dictionary.channels[u16()];
        const kind = payload.readUInt8(take(1));
        if (!channel || kind > 4) throw new Error("Invalid archive channel or value kind");
        let text = null;
        if (kind === 1) text = String(payload.readInt32LE(take(4)));
        else if (kind === 2) text = String(payload.readFloatLE(take(4)));
        else if (kind === 3) text = String(payload.readDoubleLE(take(8)));
        else if (kind === 4) text = string();
        Object.defineProperty(v, channel.key, { value: text, enumerable: true, configurable: true });
        if (channel.identity)
            Object.defineProperty(identities, channel.key, {
                value: channel.identity,
                enumerable: true,
                configurable: true
            });
        else delete identities[channel.key];
    }
    complete();
    return {
        t,
        v,
        scope: dictionary.scopes[scopeId],
        generation,
        identities: Object.keys(identities).length ? identities : undefined
    };
}

/** Decode from a buffer boundary; end is the last valid byte boundary (including definitions).
 * The returned dictionary can seed another call without mutating the caller's snapshot.
 */
function decodeRecords(buffer, offset = 0, dictionary) {
    const state = seedDictionary(dictionary);
    const rows = [];
    let end = offset;
    if (!state || !Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length)
        return { rows, end, dictionary: state };
    if (offset === 0) {
        if (buffer.length < 16 || !buffer.subarray(0, 16).equals(FILE_HEADER)) return { rows, end, dictionary: state };
        end = 16;
    }
    while (end + 5 <= buffer.length) {
        const at = end;
        const type = buffer[at];
        const next = at + 5 + buffer.readUInt32LE(at + 1);
        if (next > buffer.length) break;
        try {
            const row = type >= 1 && type <= 3 ? decodePayload(type, buffer.subarray(at + 5, next), state) : null;
            if (row) rows.push({ ...row, offset: at, end: next });
        } catch {
            break;
        }
        end = next;
    }
    return { rows, end, dictionary: state };
}

// Validate an entire row before notifying the visitor: an invalid tail must never partially
// update an index. Numeric rows allocate no row/value objects or strings. select skips decoding
// unrequested values; lastValueOnly preserves decodeRecords' last-key-wins semantics, including
// duplicate keys with different identities. An offsets sink collects validated row positions
// without callbacks or payload decoding. Scratch space is bounded by the dictionary.
function scanRecords(buffer, offset = 0, dictionary, visitor = {}) {
    let layout = visitor.offsets ? { ids: [], positions: [], bytes: 0 } : null;
    if (visitor.offsets) {
        visitor.count = 0;
        visitor.layout = null;
    }
    const state = seedDictionary(dictionary);
    let end = offset;
    if (!state || !Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length)
        return { end, dictionary: state };
    if (offset === 0) {
        if (buffer.length < 16 || !buffer.subarray(0, 16).equals(FILE_HEADER)) return { end, dictionary: state };
        end = 16;
    }
    const keys = new Map(),
        keyIds = [],
        last = [];
    const addKeys = () => {
        for (let id = keyIds.length; id < state.channels.length; id++) {
            const key = state.channels[id].key;
            if (!keys.has(key)) keys.set(key, keys.size);
            keyIds.push(keys.get(key));
        }
    };
    if (visitor.lastValueOnly) addKeys();
    records: while (end + 5 <= buffer.length) {
        const at = end,
            type = buffer[at],
            next = at + 5 + buffer.readUInt32LE(at + 1);
        if (next > buffer.length) break;
        if (type === 1 || type === 2) {
            try {
                decodePayload(type, buffer.subarray(at + 5, next), state);
            } catch {
                break;
            }
            if (visitor.lastValueOnly) addKeys();
            visitor.definition?.(type, buffer.readUInt16LE(at + 5), state);
        } else if (type === 3) {
            if (at + 21 > next) break;
            const scopeId = buffer.readUInt16LE(at + 5),
                generation = buffer.readUInt32LE(at + 7),
                t = buffer.readDoubleLE(at + 11),
                count = buffer.readUInt16LE(at + 19);
            if (scopeId >= state.scopes.length || !Number.isFinite(t)) break;
            const firstLayout = visitor.count === 0;
            if (layout && !firstLayout && (count !== layout.ids.length || next - at !== layout.bytes)) layout = null;
            let cursor = at + 21;
            for (let i = 0; i < count; i++) {
                if (cursor + 3 > next) break records;
                const id = buffer.readUInt16LE(cursor),
                    kind = buffer[cursor + 2];
                if (id >= state.channels.length || kind > 4) break records;
                if (layout) {
                    if (firstLayout) {
                        layout.ids.push(id);
                        layout.positions.push(cursor - at);
                    } else if (id !== layout.ids[i] || cursor - at !== layout.positions[i]) layout = null;
                }
                if (visitor.lastValueOnly) last[keyIds[id]] = cursor;
                cursor += 3;
                if (kind === 4) {
                    if (cursor + 4 > next) break records;
                    const length = buffer.readUInt32LE(cursor);
                    cursor += 4;
                    if (cursor + length > next || !isUtf8(buffer.subarray(cursor, cursor + length))) break records;
                    cursor += length;
                } else cursor += kind === 0 ? 0 : kind === 3 ? 8 : 4;
                if (cursor > next) break records;
            }
            if (cursor !== next) break;
            if (visitor.offsets) {
                visitor.offsets[visitor.count++] = at;
                if (layout && firstLayout) layout.bytes = next - at;
                end = next;
                continue;
            }
            const selected = visitor.row?.(at, next, scopeId, generation, t, count) !== false;
            if (selected) {
                cursor = at + 21;
                for (let i = 0; i < count; i++) {
                    const entry = cursor,
                        id = buffer.readUInt16LE(cursor),
                        kind = buffer[cursor + 2];
                    cursor += 3;
                    const length = kind === 4 ? buffer.readUInt32LE(cursor) : kind === 0 ? 0 : kind === 3 ? 8 : 4;
                    const wanted =
                        (!visitor.lastValueOnly || last[keyIds[id]] === entry) && visitor.select?.(id) !== false;
                    if (wanted) {
                        let number = NaN,
                            text = null;
                        if (kind === 1) number = buffer.readInt32LE(cursor);
                        else if (kind === 2) number = buffer.readFloatLE(cursor);
                        else if (kind === 3) number = buffer.readDoubleLE(cursor);
                        else if (kind === 4) text = utf8.decode(buffer.subarray(cursor + 4, cursor + 4 + length));
                        visitor.value?.(id, kind, number === 0 ? 0 : number, text);
                    }
                    cursor += length + (kind === 4 ? 4 : 0);
                }
                visitor.rowEnd?.();
            }
        }
        end = next;
    }
    if (visitor.offsets && visitor.count) visitor.layout = layout;
    return { end, dictionary: state };
}

// Reads large chunks, copying only records that straddle a chunk boundary. Unknown records can
// be skipped without allocating their payload. Iterator completion reports the valid end offset.
async function* readArchive(filePath, { start = 0, end = Infinity, dictionary = undefined } = {}) {
    const state = seedDictionary(dictionary);
    let validEnd = start;
    if (!state || !Number.isSafeInteger(start) || start < 0 || !(end >= start)) return { end: validEnd };
    const cutoff = Math.min(end, (await fs.promises.stat(filePath)).size);
    if (start >= cutoff) return { end: validEnd };
    const input = fs.createReadStream(filePath, { start, end: cutoff - 1, highWaterMark: CHUNK_BYTES });
    const iterator = input[Symbol.asyncIterator]();
    let chunk = Buffer.alloc(0);
    let cursor = 0;
    let position = start;
    const take = async (length, skip = false) => {
        if (position + length > cutoff) return null;
        const parts = [];
        let remaining = length;
        while (remaining) {
            if (cursor === chunk.length) {
                const next = await iterator.next();
                if (next.done) return null;
                chunk = next.value;
                cursor = 0;
            }
            const count = Math.min(remaining, chunk.length - cursor);
            if (!skip) parts.push(chunk.subarray(cursor, cursor + count));
            cursor += count;
            position += count;
            remaining -= count;
        }
        return skip ? Buffer.alloc(0) : parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
    };
    try {
        if (start === 0) {
            const header = await take(16);
            if (!header?.equals(FILE_HEADER)) return { end: validEnd };
            validEnd = 16;
        }
        while (position < cutoff) {
            const at = position;
            const header = await take(5);
            if (!header) break;
            const type = header[0];
            const known = type >= 1 && type <= 3;
            const payload = await take(header.readUInt32LE(1), !known);
            if (!payload) break;
            let row;
            try {
                row = known ? decodePayload(type, payload, state) : null;
            } catch {
                break;
            }
            validEnd = position;
            if (row) yield { ...row, offset: at, end: position };
        }
        if (position === cutoff) await iterator.next();
        return { end: validEnd, dictionary: state };
    } finally {
        input.destroy();
    }
}

const PREFIX = Buffer.alloc(1);

/** Scan complete records of [start, end) with `scanRecords` in large chunks (a record never straddles a call).
 * Record offsets given to the visitor are relative to each chunk. `onChunk(validEnd, cutoff)` runs after every
 * chunk and may throw to stop. Returns the last complete record boundary and the dictionary at that point.
 * @param {string} filePath
 * @param {{ start?: number, end?: number, dictionary?: any, chunkBytes?: number,
 *     onChunk?: (validEnd: number, cutoff: number) => any }} [options]
 * @param {object} [visitor] callbacks for `scanRecords`
 */
async function scanArchive(
    filePath,
    { start = 0, end = Infinity, dictionary, chunkBytes = 4 * 1024 * 1024, onChunk } = {},
    visitor = {}
) {
    const cutoff = Math.min(end, (await fs.promises.stat(filePath)).size);
    let validEnd = start,
        state = dictionary;
    if (!Number.isSafeInteger(start) || start < 0 || start >= cutoff) return { end: validEnd, dictionary: state };
    const input = await fs.promises.open(filePath, "r");
    try {
        const chunk = Buffer.allocUnsafe(Math.max(64 * 1024, Math.min(chunkBytes, cutoff - start)));
        let position = start,
            carry = Buffer.alloc(0);
        while (position < cutoff) {
            const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, cutoff - position), position);
            if (!bytesRead) break;
            position += bytesRead;
            // Offset 0 means "file start with header"; later chunks get one prefix byte and start at offset 1.
            const prefix = validEnd === 0 ? 0 : 1,
                data = chunk.subarray(0, bytesRead),
                buffer =
                    prefix || carry.length
                        ? Buffer.concat([prefix ? PREFIX : carry.subarray(0, 0), carry, data])
                        : data;
            const result = scanRecords(buffer, prefix, state, visitor);
            if (!result.dictionary || (prefix === 0 && result.end === 0 && buffer.length >= 16)) break;
            state = result.dictionary;
            validEnd += result.end - prefix;
            // The read buffer is reused, so keep a copy of the incomplete tail.
            carry = Buffer.from(buffer.subarray(result.end));
            if (onChunk) await onChunk(validEnd, cutoff);
        }
    } finally {
        await input.close();
    }
    return { end: validEnd, dictionary: state };
}

module.exports = { ArchiveEncoder, FILE_HEADER, decodeRecords, scanRecords, scanArchive, readArchive };
