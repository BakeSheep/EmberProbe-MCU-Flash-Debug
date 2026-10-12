"use strict";

const WINDOW_MS = 30 * 60 * 1000;
const MAX_POINTS = 360001;
const BLOCK_POINTS = 4096;
const SUMMARY_BASE_POINTS = 64;
const SUMMARY_SIZES = [1024, SUMMARY_BASE_POINTS];
const SUMMARY_MISSING = 1;
const SUMMARY_EXACT = 2;
const SUMMARY_UNORDERED = 4;
// Four Uint16 indices (first, last, min, max) and one flag byte per bucket.
const INITIAL_BLOCK_POINTS = 64;
const blockBytes = (capacity) =>
    capacity * 17 + SUMMARY_SIZES.reduce((bytes, size) => bytes + Math.ceil(capacity / size) * 9, 0);
// Maximum block allocation; tail blocks are budgeted at their actual capacity.
const BLOCK_BYTES = blockBytes(BLOCK_POINTS);
const capacityFor = (points) =>
    Math.min(BLOCK_POINTS, Math.max(INITIAL_BLOCK_POINTS, 2 ** Math.ceil(Math.log2(points))));

const growBlock = (block, capacity) => {
    const arrays = { times: Float64Array, values: Float64Array, present: Uint8Array };
    for (const [key, ArrayType] of Object.entries(arrays)) {
        const next = new ArrayType(capacity);
        if (block[key]) next.set(block[key]);
        block[key] = next;
    }
    block.summaries = SUMMARY_SIZES.map((size, index) => {
        const previous = block.summaries?.[index];
        const indices = new Uint16Array(Math.ceil(capacity / size) * 4);
        const flags = new Uint8Array(Math.ceil(capacity / size));
        if (previous) {
            indices.set(previous.indices);
            flags.set(previous.flags);
        }
        return { size, indices, flags };
    });
    // Snapshots reference the block object, never detached buffers. Existing indices/data are preserved.
    block.capacity = capacity;
};
const coded = (code, message) => Object.assign(new Error(message), { code });

const appendSummary = (block, i, value, text) => {
    const flags =
        (value === null || !Number.isFinite(value) ? SUMMARY_MISSING : 0) |
        (text !== null || (Number.isInteger(value) && !Number.isSafeInteger(value)) ? SUMMARY_EXACT : 0) |
        (i > 0 && block.times[i] < block.times[i - 1] ? SUMMARY_UNORDERED : 0);
    for (const summary of block.summaries) {
        const bucket = Math.floor(i / summary.size),
            offset = bucket * 4,
            indices = summary.indices;
        if (i % summary.size === 0) {
            indices[offset] = indices[offset + 1] = indices[offset + 2] = indices[offset + 3] = i;
            summary.flags[bucket] = flags;
        } else {
            indices[offset + 1] = i;
            if (value < block.values[indices[offset + 2]]) indices[offset + 2] = i;
            if (value > block.values[indices[offset + 3]]) indices[offset + 3] = i;
            summary.flags[bucket] |= flags;
        }
    }
};

class ChartHistoryStore {
    constructor(maxBytes = 512 * 1024 * 1024) {
        this.maxBytes = maxBytes;
        this.bytes = 0;
        this.scopes = new Map();
        this.snapshots = new Map();
        this.nextSnapshot = 0;
        this.evictionHeap = [];
        this.evictionWork = 0;
        this.evictionPasses = 0;
        this.evictedBlocks = 0;
        this.viewedSeries = new Set();
        this.latestTick = 0;
    }
    _scope(scope) {
        if (!this.scopes.has(scope))
            this.scopes.set(scope, { series: new Map(), revision: 0, tick: null, limited: false });
        return this.scopes.get(scope);
    }
    setBudget(bytes) {
        if (!Number.isInteger(bytes) || bytes < 64 * 1024 * 1024 || bytes > 4096 * 1024 * 1024)
            throw coded("CHART_HISTORY_BUDGET_INVALID", "History budget must be 64–4096 MiB");
        this.maxBytes = bytes;
        for (const state of this.scopes.values())
            if (state.tick !== null)
                for (const series of state.series.values()) this._trim(series, state.tick - WINDOW_MS);
        this._makeRoom(new Map());
        if (this.bytes > bytes) for (const scope of this.scopes.keys()) this.markLimited(scope);
        return {
            bytes: this.bytes,
            maxBytes: bytes,
            limited: this.bytes > bytes || [...this.scopes.values()].some((state) => state.limited)
        };
    }
    _less(a, b) {
        this.evictionWork++;
        return a.viewed !== b.viewed ? !a.viewed : a.time < b.time;
    }
    _swap(a, b) {
        const heap = this.evictionHeap;
        [heap[a], heap[b]] = [heap[b], heap[a]];
        heap[a].index = a;
        heap[b].index = b;
    }
    _adjust(candidate) {
        const heap = this.evictionHeap;
        let index = candidate.index;
        while (index > 0) {
            const parent = (index - 1) >>> 1;
            if (!this._less(heap[index], heap[parent])) break;
            this._swap(index, parent);
            index = parent;
        }
        while (index * 2 + 1 < heap.length) {
            let child = index * 2 + 1;
            if (child + 1 < heap.length && this._less(heap[child + 1], heap[child])) child++;
            if (!this._less(heap[child], heap[index])) break;
            this._swap(index, child);
            index = child;
        }
    }
    _untrack(part) {
        const candidate = part?.candidate;
        if (!candidate) return;
        const last = this.evictionHeap.pop();
        if (last !== candidate) {
            this.evictionHeap[candidate.index] = last;
            last.index = candidate.index;
            this._adjust(last);
        }
        part.candidate = null;
    }
    _track(live) {
        if (!live || live.part.candidate || live.part.block.refs !== 1) return;
        const { part, series } = live;
        const candidate = {
            ...live,
            index: this.evictionHeap.length,
            viewed: !!series.viewed,
            time: part.block.times[part.start]
        };
        part.candidate = candidate;
        this.evictionHeap.push(candidate);
        this._adjust(candidate);
    }
    _viewed(series, viewed) {
        if (!!series.viewed === viewed) return;
        series.viewed = viewed;
        if (viewed) this.viewedSeries.add(series);
        else this.viewedSeries.delete(series);
        for (const part of series.parts) {
            if (!part.candidate) continue;
            part.candidate.viewed = viewed;
            this._adjust(part.candidate);
        }
    }
    _release(series, live = false) {
        if (live) this._viewed(series, false);
        for (const part of series.parts) {
            if (live) {
                this._untrack(part);
                part.block.live = null;
            }
            if (--part.block.refs === 0) this.bytes -= part.block.bytes;
            else this._track(part.block.live);
        }
    }
    configure(scope, items) {
        const state = this._scope(scope);
        const wanted = new Map(items.filter((item) => !item.isComposite).map((item) => [item.name, item]));
        for (const [name, series] of state.series) {
            const item = wanted.get(name);
            if (!item || JSON.stringify([item.type, item.address, item.bitOffset, item.bitSize]) !== series.identity) {
                this._release(series, true);
                state.series.delete(name);
            }
        }
        for (const [name, item] of wanted)
            if (!state.series.has(name))
                state.series.set(name, {
                    item,
                    identity: JSON.stringify([item.type, item.address, item.bitOffset, item.bitSize]),
                    parts: [],
                    count: 0
                });
        state.revision++;
        return this.status(scope);
    }
    _trim(series, cutoff) {
        while (series.parts.length) {
            const part = series.parts[0];
            while (part.start < part.end && (part.block.times[part.start] < cutoff || series.count > MAX_POINTS)) {
                part.start++;
                series.count--;
            }
            if (part.start < part.end) {
                if (part.candidate && part.candidate.time !== part.block.times[part.start]) {
                    part.candidate.time = part.block.times[part.start];
                    this._adjust(part.candidate);
                }
                break;
            }
            this._untrack(part);
            part.block.live = null;
            series.parts.shift();
            if (--part.block.refs === 0) this.bytes -= part.block.bytes;
        }
    }
    _reservation(series, count, textBytes) {
        if (!count) return 0;
        const tail = series.discontinuous ? null : series.parts.at(-1);
        const available = tail ? BLOCK_POINTS - tail.end : 0;
        const inTail = Math.min(count, available);
        let bytes = textBytes;
        if (inTail) bytes += blockBytes(capacityFor(tail.end + inTail)) - blockBytes(tail.block.capacity);
        const remaining = count - inTail;
        bytes += Math.floor(remaining / BLOCK_POINTS) * BLOCK_BYTES;
        if (remaining % BLOCK_POINTS) bytes += blockBytes(capacityFor(remaining % BLOCK_POINTS));
        return bytes;
    }
    _makeRoom(reservations) {
        let required = 0;
        for (const [series, batch] of reservations) {
            batch.bytes = this._reservation(series, batch.count, batch.textBytes);
            required += batch.bytes;
        }
        if (this.bytes + required <= this.maxBytes) return true;
        this.evictionPasses++;
        // Expire only the small displayed set. The indexed heap never scans/sorts all live blocks.
        for (const series of this.viewedSeries)
            if (this.latestTick - series.lastViewportUse > 5000) this._viewed(series, false);
        // Reserve 5% headroom once pressure is hit, amortizing subsequent appends.
        const target =
            this.maxBytes - Math.min(Math.floor(this.maxBytes * 0.05), Math.max(0, this.maxBytes - required));
        while (this.evictionHeap.length) {
            // Optional headroom must not displace viewed history once the atomic batch already fits.
            if (this.bytes + required <= this.maxBytes && this.evictionHeap[0].viewed) return true;
            const { state, series, part } = this.evictionHeap[0];
            this._untrack(part);
            part.block.live = null;
            this.evictedBlocks++;
            series.evicted = true;
            const index = series.parts.indexOf(part);
            series.parts.splice(index, 1);
            series.count -= part.end - part.start;
            part.block.refs--;
            this.bytes -= part.block.bytes;
            state.limited = true;
            state.revision++;
            // A shared older block may survive eviction of a newer one. Do not bridge that gap later.
            const next = series.parts[index];
            if (next) next.gapBefore = true;
            else series.discontinuous = true;
            const batch = reservations.get(series);
            if (batch) {
                const bytes = this._reservation(series, batch.count, batch.textBytes);
                required += bytes - batch.bytes;
                batch.bytes = bytes;
            }
            if (this.bytes + required <= target) return true;
        }
        return this.bytes + required <= this.maxBytes;
    }
    markLimited(scope, tick) {
        const state = this._scope(scope);
        state.limited = true;
        if (Number.isFinite(tick)) {
            state.tick = Math.max(state.tick ?? tick, tick);
            for (const series of state.series.values()) this._trim(series, state.tick - WINDOW_MS);
        }
        for (const series of state.series.values()) series.discontinuous = true;
        state.revision++;
        return this.status(scope);
    }
    append(scope, samples, tick) {
        const state = this._scope(scope);
        state.tick = Math.max(state.tick ?? tick, tick);
        this.latestTick = Math.max(this.latestTick, state.tick);
        for (const series of state.series.values()) this._trim(series, state.tick - WINDOW_MS);
        // Reserve the complete batch before writing, including growth and exact text.
        const prepared = [];
        const reservations = new Map();
        for (const sample of samples) {
            const series = state.series.get(sample.name);
            if (!series) continue;
            const time = Number(sample.t ?? tick);
            if (!Number.isFinite(time) || time < state.tick - WINDOW_MS) continue;
            const tail = series.parts.at(-1);
            if (tail && time < tail.block.times[tail.end - 1]) continue;
            const value = sample.value == null ? null : Number(sample.value);
            const valueText = sample.valueText ?? (Object.is(value, -0) ? "-0" : null);
            const text =
                value !== null && valueText != null && String(valueText) !== String(value) ? String(valueText) : null;
            const textBytes = text === null ? 0 : text.length * 2 + 96;
            const batch = reservations.get(series) || { count: 0, textBytes: 0, bytes: 0 };
            batch.count++;
            batch.textBytes += textBytes;
            reservations.set(series, batch);
            prepared.push({ series, time, value, text, textBytes });
        }
        if (!this._makeRoom(reservations)) return this.markLimited(scope, tick);
        for (const point of prepared) {
            const { series, time, value, text, textBytes } = point;
            let part = series.parts.at(-1);
            if (!part || part.end >= BLOCK_POINTS || series.discontinuous) {
                const block = { text: new Map(), refs: 1, bytes: blockBytes(INITIAL_BLOCK_POINTS) };
                growBlock(block, INITIAL_BLOCK_POINTS);
                part = { start: 0, end: 0, block, gapBefore: !!series.discontinuous };
                series.discontinuous = false;
                series.parts.push(part);
                block.live = { state, series, part };
                this.bytes += block.bytes;
            } else if (part.end === part.block.capacity) {
                const capacity = capacityFor(part.end + 1);
                const extra = blockBytes(capacity) - blockBytes(part.block.capacity);
                growBlock(part.block, capacity);
                part.block.bytes += extra;
                this.bytes += extra;
            }
            const i = part.end++;
            part.block.times[i] = time;
            part.block.values[i] = value ?? 0;
            part.block.present[i] = value === null ? 0 : 1;
            if (text !== null) part.block.text.set(i, text);
            appendSummary(part.block, i, value, text);
            part.block.bytes += textBytes;
            this.bytes += textBytes;
            series.count++;
            this._track(part.block.live);
            this._trim(series, state.tick - WINDOW_MS);
        }
        state.revision++;
        return { limited: state.limited };
    }
    _source(scope, snapshotId) {
        if (!snapshotId) return this._scope(scope);
        const snapshot = this.snapshots.get(snapshotId);
        if (!snapshot || snapshot.scope !== scope)
            throw coded("CHART_SNAPSHOT_STALE", "Chart snapshot is no longer available");
        return snapshot;
    }
    status(scope, snapshotId) {
        const state = this._source(scope, snapshotId);
        let min = Infinity,
            max = -Infinity;
        const variables = [];
        for (const [name, s] of state.series) {
            if (!s.count) continue;
            variables.push(name);
            min = Math.min(min, s.parts[0].block.times[s.parts[0].start]);
            const tail = s.parts.at(-1);
            max = Math.max(max, tail.block.times[tail.end - 1]);
        }
        return {
            revision: state.revision,
            bounds: Number.isFinite(min) ? { min, max: Math.max(min + 1, max) } : null,
            variables,
            limited: !!state.limited,
            bytes: this.bytes,
            maxBytes: this.maxBytes
        };
    }
    freeze(scope, kind = "freeze", sourceId) {
        if (kind === "freeze") this.resume(scope);
        const state = this._source(scope, sourceId);
        const series = new Map();
        for (const [name, s] of state.series) {
            const parts = s.parts.map((part) => {
                part.block.refs++;
                this._untrack(part.block.live?.part);
                return { start: part.start, end: part.end, block: part.block, gapBefore: part.gapBefore };
            });
            series.set(name, { ...s, parts });
        }
        const snapshotId = ++this.nextSnapshot;
        this.snapshots.set(snapshotId, { scope, kind, series, revision: state.revision, limited: state.limited });
        return { snapshotId, ...this.status(scope, snapshotId) };
    }
    release(snapshotId) {
        const snapshot = this.snapshots.get(snapshotId);
        if (!snapshot) return;
        for (const s of snapshot.series.values()) this._release(s);
        this.snapshots.delete(snapshotId);
    }
    resume(scope) {
        for (const [id, snapshot] of this.snapshots)
            if (snapshot.scope === scope && snapshot.kind === "freeze") this.release(id);
    }
    clear(scope) {
        this.resume(scope);
        const state = this._scope(scope);
        for (const s of state.series.values()) {
            this._release(s, true);
            s.parts = [];
            s.evicted = false;
            s.count = 0;
            s.discontinuous = false;
        }
        state.limited = false;
        state.tick = null;
        state.revision++;
        return this.status(scope);
    }
    remove(scope) {
        this.clear(scope);
        this.scopes.delete(scope);
    }
    point(block, i) {
        return {
            t: block.times[i],
            v: block.present[i] ? block.values[i] : null,
            valueText: block.text.get(i) ?? null
        };
    }
    *points(series) {
        for (const part of series.parts) for (let i = part.start; i < part.end; i++) yield this.point(part.block, i);
    }
    viewport(scope, names, range, width, snapshotId) {
        if (
            !range ||
            !Number.isFinite(range.min) ||
            !Number.isFinite(range.max) ||
            range.min > range.max ||
            !Number.isFinite(width) ||
            width < 1 ||
            width > 8192
        )
            throw coded("CHART_VIEW_INVALID", "Invalid chart viewport");
        const state = this._source(scope, snapshotId);
        const series = [];
        const span = Math.max(1, range.max - range.min);
        let totalPoints = 0;
        for (const name of new Set(names)) {
            const s = state.series.get(name);
            if (s && !snapshotId) {
                s.lastViewportUse = this.latestTick;
                this._viewed(s, true);
            }
            if (!s || !s.count) continue;
            let segment = [],
                count = 0,
                column = null,
                first = null,
                lastBlock = null,
                lastIndex = 0,
                lastOrder = 0,
                min = null,
                max = null;
            const value = (ref) => ref.block.values[ref.i];
            const compare = (a, b) => {
                const x = value(a),
                    y = value(b);
                if (x === y && Number.isInteger(x) && !Number.isSafeInteger(x)) {
                    const tx = a.block.text.get(a.i) ?? String(BigInt(x)),
                        ty = b.block.text.get(b.i) ?? String(BigInt(y));
                    if (/^-?\d+$/.test(tx) && /^-?\d+$/.test(ty))
                        return BigInt(tx) < BigInt(ty) ? -1 : BigInt(tx) > BigInt(ty) ? 1 : 0;
                }
                return x - y;
            };
            const flushColumn = () => {
                if (!first) return;
                const refs = [first, min, max, { block: lastBlock, i: lastIndex, order: lastOrder }].sort(
                    (a, b) => a.order - b.order
                );
                let previous = -1;
                for (const ref of refs)
                    if (ref.order !== previous) {
                        segment.push(this.point(ref.block, ref.i));
                        previous = ref.order;
                        if (++totalPoints > 262144)
                            throw coded(
                                "CHART_VIEW_TOO_LARGE",
                                "Too many discontinuities to display; narrow the time range or show fewer curves."
                            );
                    }
                first = null;
            };
            const flush = () => {
                flushColumn();
                if (segment.length) series.push({ name, item: s.item, arr: segment, visibleCount: count });
                segment = [];
                count = 0;
                column = null;
            };
            // Locate boundaries per block; include exactly one neighbouring sample on each side.
            let before = null,
                after = null,
                order = 0;
            const consume = (block, i, n) => {
                const tt = block.times[i],
                    vv = block.values[i];
                if (!block.present[i] || !Number.isFinite(vv)) {
                    flush();
                    return;
                }
                if (tt >= range.min && tt <= range.max) count++;
                const next = Math.floor(((tt - range.min) * width) / span);
                if (next !== column) {
                    flushColumn();
                    column = next;
                    first = min = max = { block, i, order: n };
                } else {
                    // Exact numeric ties retain the original precision comparison.
                    const minValue = value(min),
                        maxValue = value(max);
                    if (vv <= minValue || vv >= maxValue) {
                        const ref = { block, i, order: n };
                        if (vv < minValue || (vv === minValue && compare(ref, min) < 0)) min = ref;
                        if (vv > maxValue || (vv === maxValue && compare(ref, max) > 0)) max = ref;
                    }
                }
                lastBlock = block;
                lastIndex = i;
                lastOrder = n;
            };
            let started = false;
            for (const part of s.parts) {
                if (part.gapBefore) {
                    flush();
                    before = null;
                }
                const block = part.block;
                const bound = (time, inclusive) => {
                    let lo = part.start,
                        hi = part.end;
                    while (lo < hi) {
                        const mid = (lo + hi) >>> 1;
                        if (block.times[mid] < time || (inclusive && block.times[mid] === time)) lo = mid + 1;
                        else hi = mid;
                    }
                    return lo;
                };
                const from = bound(range.min, false),
                    to = bound(range.max, true);
                if (from > part.start) before = { block, i: from - 1, order: order + from - part.start - 1 };
                if (from < to) {
                    if (!started && before) consume(before.block, before.i, before.order);
                    started = true;
                    for (let i = from; i < to;) {
                        let skipped = 0;
                        if ((i & (SUMMARY_BASE_POINTS - 1)) === 0) {
                            for (const summary of block.summaries) {
                                const size = summary.size;
                                // Complete buckets stay immutable after append, including when snapshots share them.
                                if (i % size !== 0 || i + size > to) continue;
                                const bucket = i / size;
                                if (summary.flags[bucket]) continue;
                                const offset = bucket * 4,
                                    indices = summary.indices,
                                    firstIndex = indices[offset],
                                    endIndex = indices[offset + 1],
                                    firstTime = block.times[firstIndex],
                                    endTime = block.times[endIndex];
                                if (
                                    firstTime < range.min ||
                                    endTime > range.max ||
                                    Math.floor(((firstTime - range.min) * width) / span) !==
                                        Math.floor(((endTime - range.min) * width) / span)
                                )
                                    continue;
                                consume(block, firstIndex, order + firstIndex - part.start);
                                const minIndex = indices[offset + 2],
                                    maxIndex = indices[offset + 3];
                                // Finite values without exact text use strict ties to retain the first index.
                                if (block.values[minIndex] < value(min))
                                    min = { block, i: minIndex, order: order + minIndex - part.start };
                                if (block.values[maxIndex] > value(max))
                                    max = { block, i: maxIndex, order: order + maxIndex - part.start };
                                lastBlock = block;
                                lastIndex = endIndex;
                                lastOrder = order + endIndex - part.start;
                                count += size - 1;
                                skipped = size;
                                break;
                            }
                        }
                        if (skipped) i += skipped;
                        else {
                            const end = Math.min(to, (i | (SUMMARY_BASE_POINTS - 1)) + 1);
                            for (; i < end; i++) consume(block, i, order + i - part.start);
                        }
                    }
                }
                if (to < part.end) {
                    after = { block, i: to, order: order + to - part.start };
                    break;
                }
                order += part.end - part.start;
            }
            if (!started && before) consume(before.block, before.i, before.order);
            if (after) consume(after.block, after.i, after.order);
            flush();
        }
        const evictedNames = snapshotId ? [] : names.filter((name) => state.series.get(name)?.evicted);
        return { ...this.status(scope, snapshotId), series, ...(evictedNames.length ? { evictedNames } : {}) };
    }
}
module.exports = {
    ChartHistoryStore,
    WINDOW_MS,
    MAX_POINTS,
    BLOCK_POINTS,
    BLOCK_BYTES,
    INITIAL_BLOCK_POINTS,
    blockBytes
};
