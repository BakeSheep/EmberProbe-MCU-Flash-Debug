"use strict";

const { ChartHistoryStore } = require("./chartHistoryStore");
const { ArchiveHistoryIndex, compare } = require("./archiveHistoryIndex");
const { columnBin } = require("../webview/liveWatch/chartInspection");

const cancelled = () =>
    Object.assign(new Error("History changed while reading archive"), {
        code: "CHART_HISTORY_RESTORE_CANCELLED"
    });

// Re-reduce both fast paths on the same column grid, including only one outside neighbour.
function reduce(points, name, item, range, width) {
    // An archive can contain late rounds. Keep each chronological run separate, so an
    // early out-of-range timestamp cannot hide later in-range samples or bridge disorder.
    const runs = [];
    let runStart = 0,
        previous = -Infinity;
    for (let i = 0; i < points.length; i++) {
        const time = points[i]?.t;
        if (time === undefined) continue;
        if (time < previous) {
            runs.push(points.slice(runStart, i));
            runStart = i;
        }
        previous = time;
    }
    if (runs.length) {
        runs.push(points.slice(runStart));
        return runs.flatMap((run) => reduce(run, name, item, range, width));
    }
    const result = [];
    let segment = [],
        column = null,
        visibleCount = 0,
        first,
        min,
        max,
        last,
        minOrder = 0,
        maxOrder = 0,
        order = 0;
    const emit = (p) => segment.push({ t: p.t, v: p.v, valueText: p.valueText });
    const flushColumn = () => {
        if (!first) return;
        emit(first);
        const a = minOrder <= maxOrder ? min : max,
            b = minOrder <= maxOrder ? max : min,
            ai = Math.min(minOrder, maxOrder),
            bi = Math.max(minOrder, maxOrder);
        if (ai) emit(a);
        if (bi && bi !== ai) emit(b);
        if (order && order !== bi) emit(last);
        first = null;
    };
    const flush = () => {
        flushColumn();
        if (segment.length) result.push({ name, item, arr: segment, visibleCount });
        segment = [];
        visibleCount = 0;
        column = null;
    };
    const bin = columnBin(Math.max(1, range.max - range.min), width);
    let firstIndex = points.findIndex((p) => p && p.t >= range.min);
    if (firstIndex < 0) firstIndex = points.length;
    let lastIndex = points.findIndex((p, i) => i >= firstIndex && p && p.t > range.max);
    if (lastIndex < 0) lastIndex = points.length - 1;
    const start = Math.max(0, firstIndex - 1);
    for (let i = start; i <= lastIndex; i++) {
        const p = points[i];
        if (!p || p.v === null || !Number.isFinite(p.v)) {
            flush();
            continue;
        }
        const next = Math.floor(p.t / bin);
        if (next !== column) {
            flushColumn();
            column = next;
        }
        if (!first) {
            first = min = max = last = p;
            minOrder = maxOrder = order = 0;
        } else {
            order++;
            if ((p.valueText !== null || min.valueText !== null ? compare(p, min) : p.v - min.v) < 0) {
                min = p;
                minOrder = order;
            }
            if ((p.valueText !== null || max.valueText !== null ? compare(p, max) : p.v - max.v) > 0) {
                max = p;
                maxOrder = order;
            }
            last = p;
        }
        if (p.t >= range.min && p.t <= range.max) visibleCount += p.weight ?? 1;
    }
    flush();
    return result;
}

class ArchiveChartHistoryStore extends ChartHistoryStore {
    constructor(options = {}) {
        super(options.maxBytes);
        this.archive = new ArchiveHistoryIndex({ maxBytes: this.maxBytes / 4, ...options.archive });
        this.epochs = new Map();
    }
    configure(scope, items, generation) {
        this.epochs.set(scope, (this.epochs.get(scope) || 0) + 1);
        const state = this._scope(scope);
        if (generation !== undefined && state.generation !== undefined && generation !== state.generation) {
            super.clear(scope);
            for (const s of state.series.values()) delete s.archiveBounds;
        }
        state.generation = generation ?? state.generation ?? 0;
        this.archive.generations.set(scope, state.generation);
        const result = super.configure(scope, items);
        // Existing identities can acquire an updated historyFromMs after a host reset.
        for (const item of items) if (state.series.has(item.name)) state.series.get(item.name).item = item;
        return { ...result, ...this.status(scope) };
    }
    clear(scope, generation) {
        this.epochs.set(scope, (this.epochs.get(scope) || 0) + 1);
        const state = this._scope(scope);
        state.generation = generation ?? (state.generation || 0) + 1;
        this.archive.generations.set(scope, state.generation);
        for (const s of state.series.values()) delete s.archiveBounds;
        return super.clear(scope);
    }
    remove(scope) {
        this.epochs.set(scope, (this.epochs.get(scope) || 0) + 1);
        // Closing a consumer releases its memory but does not clear the host's archive generation.
        super.clear(scope);
        this.scopes.delete(scope);
    }
    setBudget(bytes) {
        const result = super.setBudget(bytes);
        this.archive.maxBytes = bytes / 4;
        this.archive._budget();
        return { ...result, limited: this.archive.dataPath ? !!this.archiveLimited : result.limited };
    }
    append(scope, samples, tick) {
        const result = super.append(scope, samples, tick);
        return { limited: this.archive.dataPath ? !!this.archiveLimited : result.limited };
    }
    async archiveProgress(progress) {
        this.archiveLimited = progress.limited === true;
        await this.archive.progress(progress);
        for (const [scope, state] of this.scopes) {
            state.revision++;
            await this.resolveBounds(scope);
        }
    }
    async resolveBounds(scope) {
        const state = this._scope(scope),
            epoch = this.epochs.get(scope);
        const check = () => this.scopes.get(scope) === state && this.epochs.get(scope) === epoch;
        for (const s of state.series.values()) {
            const from = s.item.historyFromMs ?? -Infinity;
            // Unfiltered bounds are already exact in the root summary.
            if (from === -Infinity) continue;
            let min = Infinity,
                max = -Infinity;
            for (const a of this._archived(scope, state, s)) {
                const b = await this.archive.exactBounds(a, {
                    scope,
                    generation: state.generation || 0,
                    key: `${s.item.name} [${s.item.type}]`,
                    from,
                    cut: Infinity,
                    offset: Infinity,
                    check
                });
                if (!check()) return;
                min = Math.min(min, b.min);
                max = Math.max(max, b.max);
            }
            s.archiveBounds = { from, min, max };
        }
    }
    _archived(scope, state, s) {
        return this.archive.find(
            scope,
            state.generation || 0,
            `${s.item.name} [${s.item.type}]`,
            s.identity,
            state.archiveSeries
        );
    }
    _memorySource(state) {
        const series = new Map();
        for (const [name, s] of state.series) {
            const from = s.item.historyFromMs ?? -Infinity;
            if (!s.parts.length || s.parts[0].block.times[s.parts[0].start] >= from) {
                series.set(name, s);
                continue;
            }
            const parts = [];
            let count = 0;
            for (const part of s.parts) {
                let start = part.start,
                    end = part.end;
                while (start < end) {
                    const mid = (start + end) >>> 1;
                    if (part.block.times[mid] < from) start = mid + 1;
                    else end = mid;
                }
                if (start < part.end) {
                    parts.push({ ...part, start });
                    count += part.end - start;
                }
            }
            series.set(name, { ...s, parts, count });
        }
        return { ...state, series };
    }
    _memoryViewport(scope, state, name, range, width, snapshotId, seam) {
        const original = state.series.get(name);
        if (!snapshotId) {
            original.lastViewportUse = this.latestTick;
            this._viewed(original, true);
        }
        const view = Object.create(this);
        const s = { ...original, parts: original.parts.slice(seam?.start || 0) };
        s.count = seam?.time === Infinity ? 0 : s.parts.reduce((n, p) => n + p.end - p.start, 0);
        const source = this._memorySource({ ...state, series: new Map([[name, s]]) });
        view._source = () => source;
        view.status = () => ChartHistoryStore.prototype.status.call(view, scope);
        return ChartHistoryStore.prototype.viewport.call(view, scope, [name], range, width, snapshotId);
    }
    status(scope, snapshotId) {
        const state = this._source(scope, snapshotId);
        const view = Object.create(this);
        view._source = () => this._memorySource(state);
        const result = ChartHistoryStore.prototype.status.call(view, scope, snapshotId);
        if (!this.archive) return result;
        let min = result.bounds?.min ?? Infinity,
            max = result.bounds?.max ?? -Infinity;
        const variables = new Set(result.variables);
        for (const [name, s] of state.series)
            for (const archived of this._archived(scope, state, s)) {
                const bounds =
                    s.archiveBounds?.from === (s.item.historyFromMs ?? -Infinity)
                        ? s.archiveBounds
                        : this.archive.bounds(
                              archived,
                              s.item.historyFromMs ?? -Infinity,
                              state.cutMax ?? Infinity,
                              state.archiveOffset ?? Infinity
                          );
                if (Number.isFinite(bounds.min)) {
                    min = Math.min(min, bounds.min);
                    max = Math.max(max, bounds.max);
                    variables.add(name);
                }
            }
        return {
            ...result,
            bounds: Number.isFinite(min) ? { min, max: Math.max(min + 1, max) } : null,
            variables: [...variables],
            limited: this.archive.dataPath ? !!(state.archiveLimited ?? this.archiveLimited) : result.limited,
            indexBytes: this.archive.bytes,
            indexMaxBytes: this.archive.maxBytes,
            rawCacheBytes: this.archive.cacheBytes,
            indexedOffset: this.archive.indexedOffset
        };
    }
    freeze(scope, kind = "freeze", sourceId) {
        const source = this._source(scope, sourceId);
        const cutMax = source.cutMax ?? this.status(scope, sourceId).bounds?.max ?? -Infinity;
        const archiveOffset = source.archiveOffset ?? this.archive.indexedOffset;
        const capture = super.freeze(scope, kind, sourceId);
        const index = this.archive.capture(source.archiveSeries, scope, source.generation || 0);
        Object.assign(this.snapshots.get(capture.snapshotId), {
            generation: source.generation || 0,
            cutMax,
            archiveOffset,
            archiveLimited: source.archiveLimited ?? this.archiveLimited,
            archiveSeries: index.series,
            archiveCapture: index
        });
        return { snapshotId: capture.snapshotId, ...this.status(scope, capture.snapshotId) };
    }
    async freezeArchive(scope, kind = "freeze", sourceId) {
        const epoch = this.epochs.get(scope),
            state = this._source(scope, sourceId);
        await this.archive.pending;
        if (epoch !== this.epochs.get(scope) || state !== this._source(scope, sourceId)) throw cancelled();
        return this.freeze(scope, kind, sourceId);
    }
    release(snapshotId) {
        const snapshot = this.snapshots.get(snapshotId);
        if (snapshot?.archiveCapture) this.archive.releaseCapture(snapshot.archiveCapture);
        super.release(snapshotId);
    }
    touchViewport(scope, names) {
        for (const name of names) {
            const s = this._scope(scope).series.get(name);
            if (!s) continue;
            s.lastViewportUse = this.latestTick;
            this._viewed(s, true);
        }
    }
    _boundary(s) {
        let start = 0;
        for (let i = 0; i < s.parts.length; i++) if (s.parts[i].gapBefore) start = i;
        const part = s.discontinuous ? null : s.parts[start];
        return { start, time: part ? part.block.times[part.start] : Infinity };
    }
    async archiveViewport(scope, names, range, width, snapshotId) {
        // Validate before any I/O, even when the requested series has no retained memory.
        if (
            !range ||
            !Number.isFinite(range.min) ||
            !Number.isFinite(range.max) ||
            range.min > range.max ||
            !Number.isFinite(width) ||
            width < 1 ||
            width > 8192
        )
            throw Object.assign(new Error("Invalid chart viewport"), { code: "CHART_VIEW_INVALID" });
        const state = this._source(scope, snapshotId),
            epoch = this.epochs.get(scope);
        const check = () => {
            if (snapshotId) {
                if (this._source(scope, snapshotId) !== state) throw cancelled();
                if (this.epochs.get(scope) !== epoch) throw cancelled();
            } else if (this.scopes.get(scope) !== state || this.epochs.get(scope) !== epoch) throw cancelled();
        };
        // Capture the queued tail so a viewport cannot race a progress message already received.
        const needsArchive = names.some((name) => {
            const s = state.series.get(name);
            return s && range.min <= this._boundary(s).time;
        });
        if (needsArchive) await this.archive.pending;
        check();
        const output = [],
            budget = { bytes: 0 };
        let total = 0;
        for (const name of new Set(names)) {
            const s = state.series.get(name);
            if (!s) continue;
            const archived = this._archived(scope, state, s);
            if (!archived.length) {
                const memory = this._memoryViewport(scope, state, name, range, width, snapshotId);
                for (const segment of memory.series) output.push(segment);
                continue;
            }
            const boundary = () => this._boundary(s);
            if (range.min > boundary().time) {
                for (const segment of this._memoryViewport(scope, state, name, range, width, snapshotId).series)
                    output.push(segment);
                continue;
            }
            // Memory may trim/evict while disk is awaited. Retry the archive prefix if the seam advances.
            let seam, points, reduced;
            do {
                seam = boundary();
                points = [];
                reduced = null;
                for (const a of archived) {
                    const prefix = await this.archive.query(
                        a,
                        {
                            scope,
                            generation: state.generation || 0,
                            key: `${s.item.name} [${s.item.type}]`,
                            identity: a.identity,
                            from: s.item.historyFromMs ?? -Infinity,
                            cut: state.cutMax ?? Infinity,
                            offset: state.archiveOffset ?? Infinity,
                            memStart: seam.time,
                            check,
                            reduceColumns: true,
                            preservePoints: archived.length > 1,
                            keepWeights: archived.length > 1 || seam.time !== Infinity
                        },
                        range,
                        width,
                        budget
                    );
                    if (Array.isArray(prefix)) {
                        for (const p of prefix) points.push(p);
                    } else if (archived.length === 1 && seam.time === Infinity) reduced = prefix;
                    else {
                        for (let i = 0; i < prefix.points.length; i++)
                            points.push({ ...prefix.points[i], weight: prefix.weights[i] });
                    }
                }
                check();
            } while (boundary().time > seam.time);
            if (reduced) {
                if (reduced.points.length)
                    output.push({ name, item: s.item, arr: reduced.points, visibleCount: reduced.visibleCount });
                continue;
            }
            // Compute memory only after disk reads. No mutation can interleave this synchronous section.
            const memory = this._memoryViewport(scope, state, name, range, width, snapshotId, seam);
            if (archived.length > 1) points.sort((a, b) => (a?.t ?? -Infinity) - (b?.t ?? -Infinity));
            for (let i = 0; i < memory.series.length; i++) {
                if (i) points.push(null);
                const segment = memory.series[i];
                let counted = false;
                for (const p of segment.arr)
                    if (p.t >= seam.time) {
                        const inside = p.t >= range.min && p.t <= range.max;
                        points.push({ ...p, weight: !counted && inside ? segment.visibleCount : 0 });
                        counted ||= inside;
                    }
            }
            const segments = reduce(points, name, s.item, range, width);
            for (const segment of segments) output.push(segment);
        }
        for (const segment of output) total += segment.arr.length;
        if (total > 262144)
            throw Object.assign(
                new Error("Too many discontinuities to display; narrow the time range or show fewer curves."),
                { code: "CHART_VIEW_TOO_LARGE" }
            );
        check();
        const evictedNames = snapshotId ? [] : names.filter((name) => state.series.get(name)?.evicted);
        return { ...this.status(scope, snapshotId), series: output, ...(evictedNames.length ? { evictedNames } : {}) };
    }
}

module.exports = { ArchiveChartHistoryStore, reduce };
