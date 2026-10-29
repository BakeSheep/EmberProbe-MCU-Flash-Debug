"use strict";

const fsp = require("fs/promises");
const { decodeRecords, scanRecords } = require("./samplingArchiveFormat");
const { columnBin } = require("../webview/liveWatch/chartInspection");

const MISSING = 1;
const EXACT = 2;
const DISORDER = 4;
const PAGE = 64;
// first/last/min/max (time,value), time bounds, row byte bounds, count, flags.
const FIELDS = 18;
const keyFor = (scope, generation, key, identity) => JSON.stringify([scope, generation, key, identity || ""]);
const point = (t, v, valueText = null) => ({ t, v, valueText });

function compare(a, b) {
    if (a.v === b.v && Number.isInteger(a.v) && !Number.isSafeInteger(a.v)) {
        const x = a.valueText ?? String(BigInt(a.v)),
            y = b.valueText ?? String(BigInt(b.v));
        if (/^-?\d+$/.test(x) && /^-?\d+$/.test(y)) return BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0;
    }
    return a.v - b.v;
}

function compareValue(value, text, previous, previousText) {
    if (value !== previous || Number.isSafeInteger(value) || !Number.isInteger(value)) return value - previous;
    const x = text ?? String(BigInt(value)),
        y = previousText ?? String(BigInt(previous));
    if (/^-?\d+$/.test(x) && /^-?\d+$/.test(y)) return BigInt(x) < BigInt(y) ? -1 : BigInt(x) > BigInt(y) ? 1 : 0;
    return 0;
}

const textBytes = (texts) => texts.reduce((n, t) => n + (t?.length || 0) * 2 + 8, 64);

// Monotone, gap-free series can flow straight from wire/bucket fields into columns.
// Keep only four candidates per column and one outside neighbour on either side.
class Columns {
    constructor(range, width, filter) {
        this.range = range;
        this.bin = columnBin(Math.max(1, range.max - range.min), width);
        this.filter = filter;
        this.output = [];
        this.weights = filter.keepWeights ? [] : null;
        this.visibleCount = 0;
        this.times = [0, 0, 0, 0];
        this.values = [0, 0, 0, 0];
        this.texts = [null, null, null, null];
        this.orders = [0, 0, 0, 0];
        this.column = null;
        this.count = 0;
        this.order = 0;
        this.started = false;
        this.done = false;
        this.before = null;
    }
    add(t, value, text, weight = 1) {
        if (t < this.filter.from || t > this.filter.cut || t >= this.filter.memStart || this.done) return;
        if (!this.started && t < this.range.min) {
            this.before = point(t, value, text);
            return;
        }
        if (!this.started) {
            this.started = true;
            if (this.before) this.accept(this.before.t, this.before.v, this.before.valueText, 0);
        }
        const count = t >= this.range.min && t <= this.range.max ? weight : 0;
        this.visibleCount += count;
        this.accept(t, value, text, count);
        if (t > this.range.max) this.done = true;
    }
    accept(t, value, text, weight) {
        const column = Math.floor(t / this.bin);
        if (column !== this.column) {
            this.flush();
            this.column = column;
            for (let i = 0; i < 4; i++) {
                this.times[i] = t;
                this.values[i] = value;
                this.texts[i] = text;
                this.orders[i] = this.order;
            }
        } else {
            const min =
                text !== null || this.texts[1] !== null
                    ? compareValue(value, text, this.values[1], this.texts[1])
                    : value - this.values[1];
            const max =
                text !== null || this.texts[2] !== null
                    ? compareValue(value, text, this.values[2], this.texts[2])
                    : value - this.values[2];
            if (min < 0) {
                this.times[1] = t;
                this.values[1] = value;
                this.texts[1] = text;
                this.orders[1] = this.order;
            }
            if (max > 0) {
                this.times[2] = t;
                this.values[2] = value;
                this.texts[2] = text;
                this.orders[2] = this.order;
            }
            this.times[3] = t;
            this.values[3] = value;
            this.texts[3] = text;
            this.orders[3] = this.order;
        }
        this.order++;
        this.count += weight;
    }
    emit(i, weight) {
        this.output.push(point(this.times[i], this.values[i], this.texts[i]));
        this.weights?.push(weight);
    }
    flush() {
        if (this.column === null) return;
        this.emit(0, this.count);
        const a = this.orders[1] <= this.orders[2] ? 1 : 2,
            b = 3 - a;
        let previous = this.orders[0];
        for (let j = 0; j < 3; j++) {
            const i = j === 0 ? a : j === 1 ? b : 3;
            if (this.orders[i] !== previous) {
                this.emit(i, 0);
                previous = this.orders[i];
            }
        }
        this.count = 0;
    }
    bucket(b, texts, covered, at = 0) {
        if (!Number.isFinite(b[at + 1])) return;
        const weight = covered ? b[at + 12] : 1;
        this.add(b[at + 0], b[at + 1], texts?.[0] ?? null, weight);
        const a = b[at + 16] <= b[at + 17] ? 4 : 6,
            c = 10 - a;
        let previous = b[at + 14];
        for (let j = 0; j < 3; j++) {
            const r = j === 0 ? a : j === 1 ? c : 2,
                order = b[at + 14 + r / 2];
            if (order !== previous) {
                this.add(b[at + r], b[at + r + 1], texts?.[r / 2] ?? null, covered ? 0 : 1);
                previous = order;
            }
        }
    }
    finish() {
        if (!this.started && this.before) this.accept(this.before.t, this.before.v, this.before.valueText, 0);
        this.flush();
        return { points: this.output, weights: this.weights, visibleCount: this.visibleCount };
    }
}

class Level {
    constructor(size, owner) {
        this.size = size;
        this.owner = owner;
        this.pages = new Map();
        this.length = 0;
        this.start = 0;
        this.text = new Map();
        this.pageId = -1;
        this.page = null;
    }
    get(i) {
        if (i >= this.length) return undefined;
        const page = this.pages.get(Math.floor(i / PAGE));
        return page?.subarray((i % PAGE) * FIELDS, ((i % PAGE) + 1) * FIELDS);
    }
    put(i, b, texts) {
        const page = this.writable(i);
        page.set(b, (i % PAGE) * FIELDS);
        this.length = Math.max(this.length, i + 1);
        const previous = this.text.get(i);
        if (previous) this.owner.bytes -= textBytes(previous);
        if (b[13] & EXACT) {
            this.text.set(i, texts);
            this.owner.bytes += textBytes(texts);
        } else this.text.delete(i);
    }
    writable(i) {
        const pageId = Math.floor(i / PAGE);
        if (pageId === this.pageId && this.page.length >= ((i % PAGE) + 1) * FIELDS) return this.page;
        const required = ((i % PAGE) + 1) * FIELDS;
        const old = this.pages.get(pageId);
        if (!old || old.length < required) {
            const capacity = 2 ** Math.ceil(Math.log2((i % PAGE) + 1));
            const page = new Float64Array(capacity * FIELDS);
            if (old) page.set(old);
            this.pages.set(pageId, page);
            this.owner.bytes += page.byteLength - (old?.byteLength || 0);
        }
        this.pageId = pageId;
        this.page = this.pages.get(pageId);
        return this.page;
    }
    add(i, count, t, value, exact, flags, offset, end) {
        const b = this.writable(i),
            at = (i % PAGE) * FIELDS;
        if (i >= this.length) {
            b[at] = b[at + 2] = b[at + 4] = b[at + 6] = b[at + 8] = b[at + 9] = t;
            b[at + 1] = b[at + 3] = b[at + 5] = b[at + 7] = NaN;
            b[at + 10] = offset;
            this.length = i + 1;
        }
        let texts;
        if (exact !== null || b[at + 13] & EXACT) {
            texts = this.text.get(i);
            if (texts) this.owner.bytes -= textBytes(texts);
            else {
                texts = [null, null, null, null];
                this.text.set(i, texts);
            }
        }
        if (Number.isFinite(value)) {
            if (!Number.isFinite(b[at + 1])) {
                b[at] = t;
                b[at + 1] = value;
                b[at + 14] = count;
                if (texts) texts[0] = exact;
            }
            b[at + 2] = t;
            b[at + 3] = value;
            b[at + 15] = count;
            if (texts) texts[1] = exact;
            if (
                !Number.isFinite(b[at + 5]) ||
                (texts ? compareValue(value, exact, b[at + 5], texts[2]) < 0 : value < b[at + 5])
            ) {
                b[at + 4] = t;
                b[at + 5] = value;
                b[at + 16] = count;
                if (texts) texts[2] = exact;
            }
            if (
                !Number.isFinite(b[at + 7]) ||
                (texts ? compareValue(value, exact, b[at + 7], texts[3]) > 0 : value > b[at + 7])
            ) {
                b[at + 6] = t;
                b[at + 7] = value;
                b[at + 17] = count;
                if (texts) texts[3] = exact;
            }
        }
        b[at + 8] = Math.min(b[at + 8], t);
        b[at + 9] = Math.max(b[at + 9], t);
        b[at + 11] = end;
        b[at + 12]++;
        b[at + 13] |= flags;
        if (texts) this.owner.bytes += textBytes(texts);
    }
    merge(i, child, childIndex, count) {
        const source = child.get(childIndex),
            sourceTexts = child.text.get(childIndex);
        if (i >= this.length) {
            this.put(i, source, sourceTexts?.slice() ?? [null, null, null, null]);
            return;
        }
        const b = this.get(i);
        let texts = this.text.get(i);
        if (source[13] & EXACT || texts) {
            if (texts) this.owner.bytes -= textBytes(texts);
            else this.text.set(i, (texts = [null, null, null, null]));
        }
        for (let r = 0; r < 8; r += 2) {
            if (!Number.isFinite(source[r + 1])) continue;
            const order = source[14 + r / 2],
                previousOrder = b[14 + r / 2];
            let replace = !Number.isFinite(b[r + 1]);
            if (!replace) {
                if (r === 0) replace = order < previousOrder;
                else if (r === 2) replace = order >= previousOrder;
                else {
                    const comparison = texts
                        ? compareValue(source[r + 1], sourceTexts?.[r / 2], b[r + 1], texts[r / 2])
                        : source[r + 1] - b[r + 1];
                    replace = (r === 4 ? comparison < 0 : comparison > 0) || (!comparison && order < previousOrder);
                }
            }
            if (replace) {
                b[r] = source[r];
                b[r + 1] = source[r + 1];
                b[14 + r / 2] = order;
                if (texts) texts[r / 2] = sourceTexts?.[r / 2] ?? null;
            }
        }
        b[8] = Math.min(b[8], source[8]);
        b[9] = Math.max(b[9], source[9]);
        b[11] = source[11];
        b[12] = count - i * this.size;
        b[13] |= source[13];
        if (texts) this.owner.bytes += textBytes(texts);
    }
    dropPage() {
        const id = Math.floor(this.start / PAGE);
        const page = this.pages.get(id);
        if (!page) return false;
        this.pages.delete(id);
        if (this.pageId === id) {
            this.pageId = -1;
            this.page = null;
        }
        this.owner.bytes -= page.byteLength;
        for (let i = id * PAGE; i < (id + 1) * PAGE; i++) {
            const texts = this.text.get(i);
            if (texts) this.owner.bytes -= texts.reduce((n, t) => n + (t?.length || 0) * 2 + 8, 64);
            this.text.delete(i);
        }
        this.start = (id + 1) * PAGE;
        return true;
    }
    points(i) {
        const b = this.get(i),
            texts = this.text.get(i);
        if (!b || !Number.isFinite(b[1])) return [];
        const output = [point(b[0], b[1], texts?.[0] ?? null)],
            a = b[16] <= b[17] ? 4 : 6,
            c = 10 - a;
        let previous = b[14];
        for (let j = 0; j < 3; j++) {
            const r = j === 0 ? a : j === 1 ? c : 2,
                order = b[14 + r / 2];
            if (order !== previous) {
                output.push(point(b[r], b[r + 1], texts?.[r / 2] ?? null));
                previous = order;
            }
        }
        return output;
    }
    capture() {
        const view = Object.create(this);
        const last = this.length - 1;
        const bucket = this.get(last)?.slice();
        const texts = this.text.get(last)?.slice();
        view.length = this.length;
        view.tailIndex = last;
        view.tail = bucket;
        view.get = (i) => (i >= view.length ? undefined : i === last ? bucket : this.get(i));
        view.text = { get: (i) => (i === last ? texts : this.text.get(i)) };
        return view;
    }
}

class ArchiveHistoryIndex {
    constructor(options = {}) {
        this.bucketSize = options.bucketSize ?? 256;
        this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
        this.rawMaxBytes = options.rawMaxBytes ?? 16 * 1024 * 1024;
        this.cacheMaxBytes = options.cacheMaxBytes ?? 8 * 1024 * 1024;
        this.bytes = 0;
        this.cacheBytes = 0;
        this.cache = new Map();
        this.rawReads = new Map();
        this.series = new Map();
        this.lookup = new Map();
        this.generations = new Map();
        this.pins = new Map();
        this.dictionary = { scopes: [], channels: [] };
        this.dictionaryBytes = 0;
        this.indexedOffset = 0;
        this.dataPath = null;
        this.pending = Promise.resolve();
        this.stats = { bytesRead: 0, bucketsTouched: 0, rawBytes: 0, level: 0 };
    }
    progress({ dataPath, bytes }) {
        if (typeof dataPath !== "string" || !Number.isSafeInteger(bytes) || bytes < 0)
            return Promise.reject(new TypeError("Invalid archive progress"));
        if (this.dataPath && this.dataPath !== dataPath)
            return Promise.reject(new Error("Archive path changed within a history Worker"));
        this.dataPath = dataPath;
        const task = this.pending.then(() => this._tail(bytes));
        this.pending = task.catch(() => {});
        return task;
    }
    async _tail(bytes) {
        if (bytes <= this.indexedOffset) return;
        const input = await fsp.open(this.dataPath, "r");
        try {
            let size = 1024 * 1024;
            while (this.indexedOffset < bytes) {
                // Offset one avoids interpreting a non-header chunk as the file header.
                const base = this.indexedOffset,
                    prefix = base ? 1 : 0;
                const buffer = Buffer.allocUnsafe(Math.min(size, bytes - base) + prefix);
                const { bytesRead } = await input.read(buffer, prefix, buffer.length - prefix, base);
                this.stats.bytesRead += bytesRead;
                let scopeId, generation, t, rowOffset, rowEnd, channels;
                const visitor = {
                    lastValueOnly: true,
                    definition: (type, id, dictionary) => {
                        this.dictionary = dictionary;
                    },
                    row: (offset, end, scope, gen, time, count) => {
                        if (!count) return false;
                        if (scopeId !== scope || generation !== gen || !channels) {
                            scopeId = scope;
                            generation = gen;
                            let scopes = this.lookup.get(scope);
                            if (!scopes) this.lookup.set(scope, (scopes = new Map()));
                            channels = scopes.get(gen);
                            if (!channels) scopes.set(gen, (channels = new Map()));
                        }
                        t = time;
                        rowOffset = offset + base - prefix;
                        rowEnd = end + base - prefix;
                    },
                    value: (id, kind, number, text) => {
                        let s = channels.get(id);
                        if (!s) {
                            const channel = this.dictionary.channels[id],
                                scope = this.dictionary.scopes[scopeId],
                                key = keyFor(scope, generation, channel.key, channel.identity);
                            s = this.series.get(key);
                            if (!s)
                                s = {
                                    count: 0,
                                    levels: [new Level(this.bucketSize, this)],
                                    disorder: false,
                                    scope,
                                    scopeId,
                                    generation,
                                    channelId: id,
                                    key: channel.key,
                                    identity: channel.identity,
                                    metadataBytes: 256 + key.length * 2
                                };
                            if (!this.series.has(key)) {
                                this.series.set(key, s);
                                // The series metadata allowance includes its numeric lookup entries.
                                this.bytes += s.metadataBytes;
                            } else {
                                s.metadataBytes += 48;
                                this.bytes += 48;
                            }
                            channels.set(id, s);
                        }
                        const value = kind === 4 ? Number(text) : number;
                        const valid = kind !== 0 && Number.isFinite(value);
                        const exact = valid && kind === 4 && String(value) !== text ? text : null;
                        const flags =
                            (valid ? 0 : MISSING) | (exact !== null ? EXACT : 0) | (s.lastTime > t ? DISORDER : 0);
                        s.disorder ||= !!(flags & DISORDER);
                        s.missing ||= !!(flags & MISSING);
                        s.lastTime = t;
                        let l = 0;
                        while (Math.floor(s.count / s.levels[l].size) < s.levels[l].start) l++;
                        const level = s.levels[l];
                        level.add(
                            Math.floor(s.count / level.size),
                            s.count,
                            t,
                            valid ? value : NaN,
                            exact,
                            flags,
                            rowOffset,
                            rowEnd
                        );
                        s.count++;
                        if (s.count % level.size === 0) this._cascade(s, l, false);
                    }
                };
                const decoded = scanRecords(buffer.subarray(0, bytesRead + prefix), prefix, this.dictionary, visitor);
                this.dictionary = decoded.dictionary;
                const dictionaryBytes =
                    this.dictionary.scopes.reduce((n, scope) => n + 32 + scope.length * 2, 0) +
                    this.dictionary.channels.reduce((n, c) => n + 96 + (c.key.length + c.identity.length) * 2, 0);
                this.bytes += dictionaryBytes - this.dictionaryBytes;
                this.dictionaryBytes = dictionaryBytes;
                // Publish partial parents at each durable chunk boundary. Completed children
                // cascade immediately; no parent is rewritten for every individual sample.
                for (const s of this.series.values()) {
                    let l = 0;
                    while (l < s.levels.length - 1 && !s.levels[l].get(Math.floor((s.count - 1) / s.levels[l].size)))
                        l++;
                    this._cascade(s, l, true);
                }
                this.indexedOffset += decoded.end - prefix;
                this._budget();
                if (this.indexedOffset === base) {
                    if (bytesRead < size || size >= this.rawMaxBytes) break;
                    size *= 2;
                } else size = 1024 * 1024;
            }
        } finally {
            await input.close();
        }
    }
    _cascade(s, l, partial) {
        for (; l < s.levels.length; l++) {
            const child = s.levels[l],
                childIndex = Math.floor((s.count - 1) / child.size);
            if (!partial && s.count % child.size) break;
            if (l === s.levels.length - 1) {
                if (s.count !== child.size || child.size >= Number.MAX_SAFE_INTEGER / 16) break;
                s.levels.push(new Level(child.size * 16, this));
            }
            const parent = s.levels[l + 1],
                i = Math.floor((s.count - 1) / parent.size);
            if (i >= parent.start) parent.merge(i, child, childIndex, s.count);
        }
    }
    _budget() {
        // Cleared generations are invisible. Reclaim them before sacrificing current-session detail.
        for (const [id, s] of this.series) {
            if (this.bytes <= this.maxBytes) break;
            if (
                !this.generations.has(s.scope) ||
                this.generations.get(s.scope) === s.generation ||
                this.pins.has(JSON.stringify([s.scope, s.generation]))
            )
                continue;
            let bytes = s.metadataBytes;
            for (const level of s.levels) {
                for (const page of level.pages.values()) bytes += page.byteLength;
                for (const texts of level.text.values())
                    bytes += texts.reduce((n, t) => n + (t?.length || 0) * 2 + 8, 64);
            }
            this.bytes -= bytes;
            this.series.delete(id);
            const scopes = this.lookup.get(s.scopeId),
                channels = scopes.get(s.generation);
            for (const [channelId, series] of channels) if (series === s) channels.delete(channelId);
            if (!channels.size) scopes.delete(s.generation);
            if (!scopes.size) this.lookup.delete(s.scopeId);
        }
        // Release oldest pages, preserving their parents. Partial tails can also be coarsened
        // when many channels would otherwise make the minimum fine-level allocation too large.
        // If L1 itself grows beyond the budget, repeat at L1, then L2, etc.
        let changed = true;
        while (this.bytes > this.maxBytes && changed) {
            changed = false;
            let oldest;
            for (const s of this.series.values())
                for (let l = 0; l < s.levels.length - 1; l++) {
                    const level = s.levels[l];
                    if (level.start >= level.length || !level.pages.size) continue;
                    const time = level.get(level.start)?.[8];
                    if (!oldest || time < oldest.time) oldest = { level, time };
                    break;
                }
            if (oldest) changed = oldest.level.dropPage();
        }
    }
    find(scope, generation, key, identity, source = this.series) {
        return [
            source.get(keyFor(scope, generation, key, identity)),
            ...(identity ? [source.get(keyFor(scope, generation, key, ""))] : [])
        ].filter(Boolean);
    }
    capture(source = this.series, scope, generation) {
        const series = new Map();
        let bytes = 0;
        for (const [key, s] of source) {
            if (scope !== undefined && (s.scope !== scope || s.generation !== generation)) continue;
            const levels = s.levels.map((level) => level.capture());
            for (const level of levels) {
                bytes += FIELDS * 8 + 128;
                bytes += level.text.get(level.length - 1)?.reduce((n, t) => n + (t?.length || 0) * 2 + 8, 64) || 0;
            }
            series.set(key, { ...s, levels });
        }
        this.bytes += bytes;
        const pin = JSON.stringify([scope, generation]);
        this.pins.set(pin, (this.pins.get(pin) || 0) + 1);
        this._budget();
        return { series, bytes, pin };
    }
    releaseCapture({ bytes, pin }) {
        this.bytes -= bytes;
        if (this.pins.get(pin) === 1) this.pins.delete(pin);
        else this.pins.set(pin, this.pins.get(pin) - 1);
        this._budget();
    }
    bounds(s, from = -Infinity, cut = Infinity, offset = Infinity) {
        let min = Infinity,
            max = -Infinity;
        const visit = (l, i) => {
            const level = s.levels[l],
                b = level.get(i);
            if (!b || b[9] < from || b[8] > cut || b[10] >= offset) return;
            if ((b[8] < from || b[9] > cut || b[11] > offset) && l && s.levels[l - 1].get(i * 16)) {
                for (let j = i * 16; j < Math.min((i + 1) * 16, s.levels[l - 1].length); j++) visit(l - 1, j);
            } else {
                min = Math.min(min, Math.max(from, b[8]));
                max = Math.max(max, Math.min(cut, b[9]));
            }
        };
        const l = s.levels.length - 1;
        for (let i = 0; i < s.levels[l].length; i++) visit(l, i);
        return { min, max };
    }
    async exactBounds(s, filter) {
        let min = Infinity,
            max = -Infinity,
            bytes = 0;
        const ranges = [];
        const visit = (l, i) => {
            const b = s.levels[l].get(i);
            if (!b || b[9] < filter.from || b[10] >= filter.offset || b[8] > filter.cut) return;
            if (b[8] >= filter.from && b[9] <= filter.cut && b[11] <= filter.offset) {
                min = Math.min(min, b[8]);
                max = Math.max(max, b[9]);
                return;
            }
            if (l && s.levels[l - 1].get(i * 16)) {
                for (let j = i * 16; j < Math.min((i + 1) * 16, s.levels[l - 1].length); j++) visit(l - 1, j);
            } else if (bytes + b[11] - b[10] <= this.rawMaxBytes) {
                bytes += b[11] - b[10];
                ranges.push([b[10], Math.min(b[11], filter.offset)]);
            } else
                for (const p of s.levels[l].points(i))
                    if (p.t >= filter.from && p.t <= filter.cut) {
                        min = Math.min(min, p.t);
                        max = Math.max(max, p.t);
                    }
        };
        const l = s.levels.length - 1;
        for (let i = 0; i < s.levels[l].length; i++) visit(l, i);
        for (const [start, end] of ranges) {
            const points = await this.raw(start, end, this.dictionary, { ...filter, identity: s.identity });
            if (filter.check() === false) return { min: Infinity, max: -Infinity };
            for (const p of points)
                if (p.t >= filter.from && p.t <= filter.cut) {
                    min = Math.min(min, p.t);
                    max = Math.max(max, p.t);
                }
        }
        return { min, max };
    }
    async raw(start, end, dictionary, filter, columns) {
        const key = `${start}:${end}`;
        let cached = this.cache.get(key);
        if (cached) {
            this.cache.delete(key);
            this.cache.set(key, cached);
        } else {
            let task = this.rawReads.get(key);
            if (!task) {
                task = this._readRaw(start, end, key, dictionary).finally(() => this.rawReads.delete(key));
                this.rawReads.set(key, task);
            }
            cached = await task;
        }
        if (!filter) return decodeRecords(cached.buffer, 1, dictionary).rows;
        const points = [],
            buffer = cached.buffer,
            channelId = dictionary.channels.findIndex((c) => c.key === filter.key && c.identity === filter.identity),
            aliases = dictionary.channels.some((c, i) => i !== channelId && c.key === filter.key);
        let relative = -1;
        if (cached.layout) {
            for (let i = 0; i < cached.layout.ids.length; i++) {
                const channel = dictionary.channels[cached.layout.ids[i]];
                if (channel.key === filter.key)
                    relative = channel.identity === filter.identity ? cached.layout.positions[i] : -1;
            }
            if (relative < 0) return points;
        }
        for (let row = 0; row < cached.count; row++) {
            const at = cached.offsets[row];
            if (
                dictionary.scopes[buffer.readUInt16LE(at + 5)] !== filter.scope ||
                buffer.readUInt32LE(at + 7) !== filter.generation
            )
                continue;
            const count = cached.layout ? 0 : buffer.readUInt16LE(at + 19);
            let cursor = at + 21,
                selected = cached.layout ? at + relative : -1;
            for (let i = 0; i < count; i++) {
                const id = buffer[cursor] | (buffer[cursor + 1] << 8),
                    kind = buffer[cursor + 2];
                if (id === channelId) selected = cursor;
                else if (aliases && dictionary.channels[id].key === filter.key)
                    selected = dictionary.channels[id].identity === filter.identity ? cursor : -1;
                cursor += 3;
                cursor += kind === 0 ? 0 : kind === 4 ? 4 + buffer.readUInt32LE(cursor) : kind === 3 ? 8 : 4;
            }
            if (selected < 0) continue;
            const kind = buffer[selected + 2],
                t = buffer.readDoubleLE(at + 11);
            cursor = selected + 3;
            let value = null,
                text = null;
            if (kind === 1) value = buffer.readInt32LE(cursor);
            else if (kind === 2) value = buffer.readFloatLE(cursor);
            else if (kind === 3) value = buffer.readDoubleLE(cursor);
            else if (kind === 4) {
                text = buffer.toString("utf8", cursor + 4, cursor + 4 + buffer.readUInt32LE(cursor));
                value = Number(text);
            }
            if (value === 0) value = 0;
            const exact = kind === 4 && String(value) !== text ? text : null;
            if (columns) columns.add(t, value, exact);
            else points.push(point(t, value !== null && Number.isFinite(value) ? value : null, exact));
        }
        return points;
    }
    async _readRaw(start, end, key, dictionary) {
        const input = await fsp.open(this.dataPath, "r");
        let cached;
        try {
            // A cached tiny range must not pin an unaccounted shared Buffer-pool slab.
            const buffer = Buffer.allocUnsafeSlow(end - start + 1);
            let read = 0;
            while (read < end - start) {
                const { bytesRead } = await input.read(buffer, read + 1, end - start - read, start + read);
                if (!bytesRead) break;
                read += bytesRead;
                this.stats.rawBytes += bytesRead;
            }
            const offsets = new Uint32Array(Math.floor(read / 21));
            const sink = { offsets, count: 0, layout: null };
            scanRecords(buffer.subarray(0, read + 1), 1, dictionary, sink);
            cached = {
                buffer: buffer.subarray(0, read + 1),
                offsets,
                count: sink.count,
                layout: sink.layout,
                bytes:
                    buffer.byteLength + offsets.byteLength + 256 + (sink.layout ? 256 + sink.layout.ids.length * 32 : 0)
            };
        } finally {
            await input.close();
        }
        // Retain bounded wire bytes instead of objects/strings for every interleaved channel.
        if (cached.bytes <= this.cacheMaxBytes) {
            while (this.cacheBytes + cached.bytes > this.cacheMaxBytes) {
                const first = this.cache.keys().next().value;
                this.cacheBytes -= this.cache.get(first).bytes;
                this.cache.delete(first);
            }
            this.cache.set(key, cached);
            this.cacheBytes += cached.bytes;
        }
        return cached;
    }
    async query(s, filter, range, width, budget) {
        const columns =
            filter.reduceColumns && !filter.preservePoints && !s.disorder && !s.missing
                ? new Columns(range, width, filter)
                : null;
        const plans = [],
            pixel = columnBin(Math.max(1, range.max - range.min), width);
        const visit = (l, i) => {
            const level = s.levels[l],
                at = level.tailIndex === i ? 0 : (i % PAGE) * FIELDS,
                b =
                    i >= level.length
                        ? null
                        : level.tailIndex === i
                          ? level.tail
                          : level.pages.get(Math.floor(i / PAGE));
            if (
                !b ||
                b[at + 9] < filter.from ||
                b[at + 8] > filter.cut ||
                b[at + 10] >= filter.offset ||
                b[at + 8] >= filter.memStart
            )
                return;
            this.stats.bucketsTouched++;
            const complete =
                b[at + 8] >= filter.from &&
                b[at + 9] <= filter.cut &&
                b[at + 11] <= filter.offset &&
                b[at + 9] < filter.memStart;
            if (complete && !(b[at + 13] & (MISSING | DISORDER)) && (b[at + 9] < range.min || b[at + 8] > range.max)) {
                if (columns) {
                    const r = b[at + 9] < range.min ? 2 : 0;
                    if (!plans.length) {
                        if (Number.isFinite(b[at + r + 1]))
                            columns.add(b[at + r], b[at + r + 1], level.text.get(i)?.[r / 2] ?? null, 0);
                    } else
                        plans.push({ bucket: b.slice(at, at + FIELDS), texts: level.text.get(i)?.slice(), outside: r });
                } else
                    plans.push({
                        points: level
                            .points(i)
                            .slice(b[at + 9] < range.min ? -1 : 0, b[at + 9] < range.min ? undefined : 1)
                    });
                return;
            }
            const fits = b[at + 9] - b[at + 8] <= pixel;
            const covered = b[at + 8] >= range.min && b[at + 9] <= range.max;
            const child = l && s.levels[l - 1];
            if ((!complete || !fits || !covered) && child && child.get(i * 16)) {
                const lo = i * 16,
                    hi = Math.min((i + 1) * 16, child.length);
                let first = lo,
                    last = hi;
                if (!s.disorder) {
                    while (first < hi && child.get(first)?.[9] < range.min) first++;
                    while (last > lo && child.get(last - 1)?.[8] > range.max) last--;
                    first = Math.max(lo, first - 1);
                    last = Math.min(hi, last + 1);
                }
                for (let j = first; j < last; j++) visit(l - 1, j);
            } else if (
                !l &&
                (b[at + 9] - b[at + 8] > pixel ||
                    !complete ||
                    !covered ||
                    (b[at + 13] & (MISSING | DISORDER) && pixel < level.size)) &&
                budget.bytes + b[at + 11] - b[at + 10] <= this.rawMaxBytes
            ) {
                budget.bytes += b[at + 11] - b[at + 10];
                const previous = plans.at(-1);
                if (previous?.end >= b[at + 10]) previous.end = Math.max(previous.end, b[at + 11]);
                else plans.push({ start: b[at + 10], end: b[at + 11] });
            } else {
                this.stats.level = Math.max(this.stats.level, l);
                if (columns) {
                    if (!plans.length) columns.bucket(b, level.text.get(i), covered, at);
                    else plans.push({ bucket: b.slice(at, at + FIELDS), texts: level.text.get(i)?.slice(), covered });
                    return;
                }
                const points = level.points(i);
                if (!(b[at + 13] & MISSING) && covered)
                    for (let j = 0; j < points.length; j++) points[j].weight = j ? 0 : b[at + 12];
                plans.push({
                    points:
                        b[at + 13] & (MISSING | DISORDER)
                            ? [
                                  point(b[at + 8], null),
                                  ...points.flatMap((p) => [p, point(p.t, null)]),
                                  point(b[at + 9], null)
                              ]
                            : points
                });
            }
        };
        const top = s.levels.length - 1;
        for (let i = 0; i < s.levels[top].length; i++) visit(top, i);
        const points = [];
        const dictionary = this.dictionary;
        for (const plan of plans) {
            if (plan.bucket) {
                if (plan.outside !== undefined) {
                    const r = plan.outside;
                    if (Number.isFinite(plan.bucket[r + 1]))
                        columns.add(plan.bucket[r], plan.bucket[r + 1], plan.texts?.[r / 2] ?? null, 0);
                } else columns.bucket(plan.bucket, plan.texts, plan.covered);
            } else if (plan.points) points.push(...plan.points);
            else {
                filter.check?.();
                const raw = await this.raw(plan.start, Math.min(plan.end, filter.offset), dictionary, filter, columns);
                filter.check?.();
                for (const p of raw) points.push(p);
            }
        }
        if (columns) return columns.finish();
        return points.filter((p) => !p || (p.t >= filter.from && p.t <= filter.cut && p.t < filter.memStart));
    }
}

module.exports = { ArchiveHistoryIndex, compare, MISSING, EXACT, DISORDER };
