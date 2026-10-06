"use strict";

const WINDOW_MS = 30 * 60 * 1000;
const MAX_POINTS = 360001;
const BLOCK_POINTS = 4096;
const BLOCK_BYTES = BLOCK_POINTS * 17;
const coded = (code, message) => Object.assign(new Error(message), { code });

class ChartHistoryStore {
    constructor(maxBytes = 512 * 1024 * 1024) {
        this.maxBytes = maxBytes;
        this.bytes = 0;
        this.scopes = new Map();
        this.snapshots = new Map();
        this.nextSnapshot = 0;
    }
    _scope(scope) {
        if (!this.scopes.has(scope)) this.scopes.set(scope, { series: new Map(), revision: 0, tick: null });
        return this.scopes.get(scope);
    }
    setBudget(bytes) {
        if (!Number.isInteger(bytes) || bytes < 64 * 1024 * 1024 || bytes > 4096 * 1024 * 1024)
            throw coded("CHART_HISTORY_BUDGET_INVALID", "History budget must be 64–4096 MiB");
        this.maxBytes = bytes;
        for (const state of this.scopes.values())
            if (state.tick !== null)
                for (const series of state.series.values()) this._trim(series, state.tick - WINDOW_MS);
        if (this.bytes > bytes)
            throw coded(
                "CHART_HISTORY_FULL",
                "Existing chart history exceeds the memory budget; release frozen history or reduce watched variables."
            );
        return { bytes: this.bytes, maxBytes: bytes };
    }
    _release(series) {
        for (const part of series.parts) {
            if (--part.block.refs === 0) this.bytes -= part.block.bytes;
        }
    }
    configure(scope, items) {
        const state = this._scope(scope);
        const wanted = new Map(items.filter((item) => !item.isComposite).map((item) => [item.name, item]));
        for (const [name, series] of state.series) {
            const item = wanted.get(name);
            if (!item || JSON.stringify([item.type, item.address, item.bitOffset, item.bitSize]) !== series.identity) {
                this._release(series);
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
            if (part.start < part.end) break;
            series.parts.shift();
            if (--part.block.refs === 0) this.bytes -= part.block.bytes;
        }
    }
    append(scope, samples, tick) {
        const state = this._scope(scope);
        state.tick = Math.max(state.tick ?? tick, tick);
        for (const series of state.series.values()) this._trim(series, state.tick - WINDOW_MS);
        // Reserve the complete batch before writing it; budget errors must not leave partial history.
        let required = 0;
        const prepared = [];
        const lengths = new Map();
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
            const used = lengths.get(series) ?? tail?.end ?? BLOCK_POINTS;
            if (used >= BLOCK_POINTS) required += BLOCK_BYTES;
            lengths.set(series, used >= BLOCK_POINTS ? 1 : used + 1);
            const textBytes = text === null ? 0 : text.length * 2 + 96;
            required += textBytes;
            prepared.push({ series, time, value, text, textBytes });
        }
        if (this.bytes + required > this.maxBytes)
            throw coded(
                "CHART_HISTORY_FULL",
                "Chart history memory budget reached; release frozen history or reduce watched variables before resuming."
            );
        for (const point of prepared) {
            const { series, time, value, text, textBytes } = point;
            let part = series.parts.at(-1);
            if (!part || part.end >= BLOCK_POINTS) {
                part = {
                    start: 0,
                    end: 0,
                    block: {
                        times: new Float64Array(BLOCK_POINTS),
                        values: new Float64Array(BLOCK_POINTS),
                        present: new Uint8Array(BLOCK_POINTS),
                        text: new Map(),
                        refs: 1,
                        bytes: BLOCK_BYTES
                    }
                };
                series.parts.push(part);
                this.bytes += BLOCK_BYTES;
            }
            const i = part.end++;
            part.block.times[i] = time;
            part.block.values[i] = value ?? 0;
            part.block.present[i] = value === null ? 0 : 1;
            if (text !== null) part.block.text.set(i, text);
            part.block.bytes += textBytes;
            this.bytes += textBytes;
            series.count++;
            this._trim(series, state.tick - WINDOW_MS);
        }
        state.revision++;
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
                return { ...part };
            });
            series.set(name, { ...s, parts });
        }
        const snapshotId = ++this.nextSnapshot;
        this.snapshots.set(snapshotId, { scope, kind, series, revision: state.revision });
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
            this._release(s);
            s.parts = [];
            s.count = 0;
        }
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
        let totalPoints = 0;
        for (const name of new Set(names)) {
            const s = state.series.get(name);
            if (!s || !s.count) continue;
            let segment = [],
                count = 0,
                column = null,
                first = null,
                last = null,
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
                const refs = [first, min, max, last].sort((a, b) => a.order - b.order);
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
                const next = Math.floor(((tt - range.min) * width) / Math.max(1, range.max - range.min));
                if (next !== column) {
                    flushColumn();
                    column = next;
                    first = min = max = { block, i, order: n };
                } else {
                    // Allocate references only for extrema, never a geometry object for every sample.
                    if (vv <= value(min)) {
                        const ref = { block, i, order: n };
                        if (compare(ref, min) < 0) min = ref;
                    }
                    if (vv >= value(max)) {
                        const ref = { block, i, order: n };
                        if (compare(ref, max) > 0) max = ref;
                    }
                }
                last = { block, i, order: n };
            };
            let started = false;
            for (const part of s.parts) {
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
                    for (let i = from; i < to; i++) consume(block, i, order + i - part.start);
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
        return { ...this.status(scope, snapshotId), series };
    }
}
module.exports = { ChartHistoryStore, WINDOW_MS, MAX_POINTS, BLOCK_POINTS, BLOCK_BYTES };
