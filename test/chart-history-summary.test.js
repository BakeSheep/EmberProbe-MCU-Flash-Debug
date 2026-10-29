"use strict";
const assert = require("assert");
const {
    ChartHistoryStore,
    BLOCK_BYTES,
    BLOCK_POINTS,
    INITIAL_BLOCK_POINTS,
    blockBytes,
    MAX_POINTS,
    WINDOW_MS
} = require("../src/services/chartHistoryStore");
const { columnBin } = require("../src/webview/liveWatch/chartInspection");

const coded = (code, message) => Object.assign(new Error(message), { code });

// The pre-summary viewport implementation is deliberately kept independent of the optimized traversal.
function referenceViewport(store, scope, names, range, width, snapshotId) {
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
    const state = store._source(scope, snapshotId);
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
                    segment.push(store.point(ref.block, ref.i));
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
            // The shared helper also pins the store's standalone copy of the bin rule.
            const next = Math.floor(tt / columnBin(Math.max(1, range.max - range.min), width));
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
    return { ...store.status(scope, snapshotId), series };
}

let seed = 0x8bd3f521;
function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
}
function integer(max) {
    return Math.floor(random() * max);
}
function configure(store, names) {
    store.configure(
        "panel",
        names.map((name) => ({ name, type: "u64", address: 0x20000000 }))
    );
}
function equivalent(store, names, range, width, snapshotId, label = "") {
    assert.deepStrictEqual(
        store.viewport("panel", names, range, width, snapshotId),
        referenceViewport(store, "panel", names, range, width, snapshotId),
        label + " range=" + JSON.stringify(range) + " width=" + width
    );
}
function appendBatches(store, samples, size = 1024) {
    for (let from = 0; from < samples.length; from += size) {
        const batch = samples.slice(from, from + size);
        store.append("panel", batch, Math.max(...batch.map((sample) => sample.t)));
    }
}
function errorCode(run) {
    assert.throws(run, (error) => error.code === "CHART_VIEW_TOO_LARGE");
}

for (const length of [1, 63, 64, 65, 127, 128, 129, 511, 512, 513, 1023, 1024, 1025, 2047, 2048, 2049]) {
    const store = new ChartHistoryStore();
    configure(store, ["growth"]);
    const samples = Array.from({ length }, (_, i) => ({ name: "growth", t: i, value: Math.sin(i / 7) }));
    appendBatches(store, samples, 31);
    const frozen = store.freeze("panel");
    const range = { min: 0, max: length + 64 };
    const original = store.viewport("panel", ["growth"], range, 1, frozen.snapshotId).series;
    store.append(
        "panel",
        Array.from({ length: 65 }, (_, i) => ({ name: "growth", t: length + i, value: i % 9 === 0 ? null : i })),
        length + 64
    );
    for (const width of [1, 3, 127]) {
        equivalent(store, ["growth"], range, width, undefined, "grown partial block");
        equivalent(store, ["growth"], range, width, frozen.snapshotId, "frozen mid-growth");
    }
    assert.deepStrictEqual(store.viewport("panel", ["growth"], range, 1, frozen.snapshotId).series, original);
}

const widths = [1, 1.25, 2, 3, 7, 17, 64, 127, 800, 1200, 8192];
const exactBase = 18446744073709551000n;
for (let scenario = 0; scenario < 10; scenario++) {
    const store = new ChartHistoryStore();
    const names = ["clean", "mixed", "exact"];
    configure(store, names);
    const length = BLOCK_POINTS + 701 + integer(BLOCK_POINTS);
    const times = [];
    const samples = [];
    let time = 1000;
    for (let i = 0; i < length; i++) {
        time += integer(5) * 2.5;
        times.push(time);
        for (const name of names) {
            let value = integer(17) - 8;
            let valueText;
            if (name === "mixed") {
                const choice = integer(1400);
                if (choice < 5) value = [null, NaN, Infinity, -Infinity, -0][choice];
                else if (choice < 9) {
                    const exact = (choice % 2 ? -exactBase : exactBase) + BigInt(integer(40));
                    value = Number(exact);
                    valueText = choice === 8 ? "not-an-integer" : String(exact);
                } else if (choice === 9) valueText = "00" + value;
                else if (choice === 10) value = Number.MAX_SAFE_INTEGER + 1;
                else if (choice === 11) value = 1e-30;
            } else if (name === "exact") {
                const exact = (i % 127 < 64 ? exactBase : -exactBase) + BigInt(integer(50));
                value = i % 509 === 0 ? null : Number(exact);
                valueText = String(exact);
            }
            samples.push({ name, t: time, value, valueText });
        }
    }
    appendBatches(store, samples, 111 + integer(1024));
    const requested = ["mixed", "clean", "mixed", "unknown", "exact"];
    const full = { min: times[0], max: time };
    for (const width of widths) equivalent(store, requested, full, width, undefined, "random full " + scenario);
    const snapshot = store.freeze("panel");
    const frozenSeries = store.viewport("panel", requested, full, 7).series;
    // Appends finish summary buckets shared with the frozen tail and add gaps/exact values beyond its end.
    const future = [];
    for (let i = 1; i <= 1300; i++)
        for (const name of names)
            future.push({
                name,
                t: time + i * 5,
                value: i % 67 === 0 ? null : Number(exactBase + BigInt(i)),
                valueText: String(exactBase + BigInt(i))
            });
    appendBatches(store, future, 379);
    assert.deepStrictEqual(store.viewport("panel", requested, full, 7, snapshot.snapshotId).series, frozenSeries);
    for (let query = 0; query < 30; query++) {
        const a = times[integer(length)] + (random() - 0.5) * 30;
        const b = times[integer(length)] + (random() - 0.5) * 30;
        const range = { min: Math.min(a, b), max: Math.max(a, b) };
        const width = widths[integer(widths.length)];
        equivalent(store, requested, range, width, undefined, "random live " + scenario);
        equivalent(store, requested, range, width, snapshot.snapshotId, "random frozen " + scenario);
    }
    for (const range of [
        { min: times[0] - 100, max: times[0] - 50 },
        { min: time + 20, max: time + 30 },
        { min: times[BLOCK_POINTS], max: times[BLOCK_POINTS] },
        { min: times[BLOCK_POINTS - 1] - 0.1, max: times[BLOCK_POINTS] + 0.1 }
    ])
        for (const width of [1, 1200])
            equivalent(store, requested, range, width, snapshot.snapshotId, "boundary neighbours");
    // Time retention expires part of the first block without altering the snapshot's shared summaries.
    store.append("panel", [], WINDOW_MS + times[113]);
    for (const width of [1, 3, 64, 1200]) {
        equivalent(store, requested, full, width, undefined, "trimmed live");
        equivalent(store, requested, full, width, snapshot.snapshotId, "untrimmed frozen");
    }
    const exported = store.freeze("panel", "export", snapshot.snapshotId);
    store.clear("panel");
    equivalent(store, requested, full, 1, exported.snapshotId, "snapshot after live clear");
    store.release(exported.snapshotId);
    assert.strictEqual(store.bytes, 0);
}

// Complete bucket extrema keep the earliest tie, even across bucket and block boundaries.
{
    const store = new ChartHistoryStore();
    configure(store, ["ties"]);
    const samples = Array.from({ length: BLOCK_POINTS * 2 + 31 }, (_, i) => ({
        name: "ties",
        t: i * 5,
        value: i % 64 === 7 || i % 64 === 8 ? -10 : i % 64 === 17 || i % 64 === 18 ? 20 : 3
    }));
    appendBatches(store, samples, 97);
    const block = store._scope("panel").series.get("ties").parts[0].block;
    const fine = block.summaries.find((summary) => summary.size === 64);
    assert.deepStrictEqual(Array.from(fine.indices.slice(0, 4)), [0, 63, 7, 17]);
    assert.strictEqual(fine.flags[0], 0);
    const stableIndices = block.summaries.map((summary) => Array.from(summary.indices.slice(0, 4)));
    for (const width of widths)
        equivalent(store, ["ties"], { min: 0, max: samples.at(-1).t + 5 }, width, undefined, "ties");
    const frozen = store.freeze("panel");
    store.append("panel", [{ name: "ties", t: samples.at(-1).t + 5, value: 1000 }], samples.at(-1).t + 5);
    assert.deepStrictEqual(
        block.summaries.map((summary) => Array.from(summary.indices.slice(0, 4))),
        stableIndices,
        "completed summaries remain immutable"
    );
    // Trim to a non-bucket-aligned start, leaving expired extrema in the shared first block.
    store.append("panel", [], WINDOW_MS + 9 * 5);
    assert.strictEqual(store._scope("panel").series.get("ties").parts[0].start, 9);
    equivalent(store, ["ties"], { min: 0, max: samples.at(-1).t + 10 }, 1, undefined, "expired bucket extrema");
    equivalent(store, ["ties"], { min: 0, max: samples.at(-1).t + 10 }, 1, frozen.snapshotId, "frozen extrema");
}

// Missing/nonfinite, exact-text and unsafe values force raw processing of their buckets.
{
    const store = new ChartHistoryStore();
    configure(store, ["flags"]);
    const samples = Array.from({ length: 1024 }, (_, i) => ({ name: "flags", t: i, value: i % 13 }));
    samples[65].value = null;
    samples[130].value = NaN;
    samples[193].value = Infinity;
    samples[257].valueText = "00" + samples[257].value;
    samples[321].value = Number.MAX_SAFE_INTEGER + 1;
    samples[385].value = -0;
    // Existing append accepts unordered times within a batch; summaries must not change its traversal.
    samples[450].t = samples[448].t;
    store.append("panel", samples, 1023);
    const block = store._scope("panel").series.get("flags").parts[0].block;
    const fine = block.summaries.find((summary) => summary.size === 64);
    assert.strictEqual(fine.flags[0], 0);
    assert.ok(fine.flags[1] & 1);
    assert.ok(fine.flags[2] & 1);
    assert.ok(fine.flags[3] & 1);
    assert.ok(fine.flags[4] & 2);
    assert.ok(fine.flags[5] & 2);
    assert.ok(fine.flags[6] & 2);
    assert.ok(fine.flags[7] & 4);
    for (const range of [
        { min: 0, max: 1024 },
        { min: -Number.MAX_VALUE, max: Number.MAX_VALUE },
        { min: 447, max: 451 },
        { min: 449, max: 449 },
        { min: 63.5, max: 194.5 }
    ])
        for (const width of widths) equivalent(store, ["flags"], range, width, undefined, "flags");
}

// Safe 1024-point summaries avoid raw scans; this asserts work rather than a machine-dependent timing.
{
    const store = new ChartHistoryStore();
    configure(store, ["safe"]);
    // Power-of-two sample spacing aligns the power-of-two columns with summary bucket boundaries.
    const samples = Array.from({ length: BLOCK_POINTS * 2 }, (_, i) => ({
        name: "safe",
        t: i * 4,
        value: Math.sin(i / 37)
    }));
    appendBatches(store, samples);
    const range = { min: 0, max: samples.at(-1).t + 5 };
    const expected = referenceViewport(store, "panel", ["safe"], range, 1);
    let reads = 0;
    for (const part of store._scope("panel").series.get("safe").parts)
        part.block.values = new Proxy(part.block.values, {
            get(target, key) {
                if (/^\d+$/.test(String(key))) reads++;
                return Reflect.get(target, key, target);
            }
        });
    assert.deepStrictEqual(store.viewport("panel", ["safe"], range, 1), expected);
    assert.ok(reads < 256, "safe complete buckets should consume extrema without scanning thousands of values");
    const fineExpected = referenceViewport(store, "panel", ["safe"], range, 32);
    reads = 0;
    assert.deepStrictEqual(store.viewport("panel", ["safe"], range, 32), fineExpected);
    assert.ok(reads < 2048, "64-point summaries are used when a column cannot cover a 1024-point bucket");
}

// Capacity-sized summary buffers are reserved atomically and retained only while their block is referenced.
{
    const rawBytes = BLOCK_POINTS * 17;
    assert.strictEqual(BLOCK_BYTES - rawBytes, (BLOCK_POINTS / 64 + BLOCK_POINTS / 1024) * 9);
    const tooSmall = new ChartHistoryStore(blockBytes(INITIAL_BLOCK_POINTS) - 1);
    configure(tooSmall, ["budget"]);
    assert.strictEqual(tooSmall.append("panel", [{ name: "budget", t: 0, value: 1 }], 0).limited, true);
    assert.strictEqual(tooSmall.bytes, 0);
    assert.strictEqual(tooSmall._scope("panel").series.get("budget").count, 0);
    const store = new ChartHistoryStore(blockBytes(INITIAL_BLOCK_POINTS));
    configure(store, ["budget"]);
    store.append("panel", [{ name: "budget", t: 0, value: 1 }], 0);
    const block = store._scope("panel").series.get("budget").parts[0].block;
    const allocated =
        block.times.byteLength +
        block.values.byteLength +
        block.present.byteLength +
        block.summaries.reduce((bytes, summary) => bytes + summary.indices.byteLength + summary.flags.byteLength, 0);
    assert.strictEqual(block.bytes, allocated);
    assert.strictEqual(store.bytes, allocated);
    const frozen = store.freeze("panel", "export");
    assert.strictEqual(store.bytes, allocated, "shared summaries are budgeted once");
    assert.strictEqual(store.append("panel", [{ name: "budget", t: 1, value: 2, valueText: "02" }], 1).limited, true);
    assert.strictEqual(store._scope("panel").series.get("budget").count, 1, "failed batch changes no summaries");
    equivalent(store, ["budget"], { min: 0, max: 2 }, 1, frozen.snapshotId, "failed append snapshot");
    store.clear("panel");
    assert.strictEqual(store.bytes, allocated, "export snapshot keeps shared summaries budgeted");
    store.release(frozen.snapshotId);
    assert.strictEqual(store.bytes, 0);
}

// Count retention can expire a partial bucket even when timestamps are equal.
{
    const store = new ChartHistoryStore();
    configure(store, ["retained"]);
    for (let from = 0; from < MAX_POINTS + 123; from += 1024)
        store.append(
            "panel",
            Array.from({ length: Math.min(1024, MAX_POINTS + 123 - from) }, (_, i) => ({
                name: "retained",
                t: 1000,
                value: (from + i) % 7
            })),
            1000
        );
    const series = store._scope("panel").series.get("retained");
    assert.strictEqual(series.count, MAX_POINTS);
    assert.strictEqual(series.parts[0].start, 123);
    equivalent(store, ["retained"], { min: 1000, max: 1001 }, 1, undefined, "count retention");
    assert.strictEqual(
        store.viewport("panel", ["retained"], { min: 1000, max: 1001 }, 1).series[0].visibleCount,
        MAX_POINTS
    );
}

// The aggregate output cap counts emitted points, including across discontinuous series.
{
    const store = new ChartHistoryStore();
    configure(store, ["left", "right"]);
    const length = 262144;
    for (let from = 0; from < length; from += 1024) {
        const samples = [];
        for (let i = from; i < Math.min(length, from + 1024); i++)
            for (const name of ["left", "right"]) samples.push({ name, t: i, value: i % 2 ? null : i });
        store.append("panel", samples, samples.at(-1).t);
    }
    const range = { min: 0, max: length + 1 };
    const below = store.viewport("panel", ["left", "right"], range, 1);
    assert.strictEqual(
        below.series.reduce((count, series) => count + series.arr.length, 0),
        262144
    );
    assert.deepStrictEqual(below, referenceViewport(store, "panel", ["left", "right"], range, 1));
    store.append(
        "panel",
        [
            { name: "left", t: length, value: 1 },
            { name: "right", t: length, value: 1 }
        ],
        length
    );
    errorCode(() => store.viewport("panel", ["left", "right"], range, 1));
    errorCode(() => referenceViewport(store, "panel", ["left", "right"], range, 1));
}

// A following viewport scrolls by fractional columns; its interior must keep the same reduced samples.
{
    const store = new ChartHistoryStore(),
        epoch = 1.8e12;
    configure(store, ["scroll"]);
    appendBatches(
        store,
        Array.from({ length: 20000 }, (_, i) => ({
            name: "scroll",
            t: epoch + 1000 + i * 5,
            value: i % 23 ? i % 7 : -50
        }))
    );
    const interior = (shift) => {
        const min = epoch + 30000 + shift;
        return store
            .viewport("panel", ["scroll"], { min, max: min + 30000 }, 900)
            .series[0].arr.map((point) => point.t - epoch)
            .filter((t) => t >= 32000 && t <= 58000);
    };
    for (const shift of [7, 13.3, 21.9]) assert.deepStrictEqual(interior(shift), interior(0), "shift " + shift);
    // A growing ("All") range keeps its reduced samples while the power-of-two bin size is unchanged.
    const grown = (grow) =>
        store
            .viewport("panel", ["scroll"], { min: epoch + 30000, max: epoch + 60000 + grow }, 900)
            .series[0].arr.map((point) => point.t - epoch)
            .filter((t) => t >= 32000 && t <= 58000);
    for (const grow of [80, 560, 2400]) assert.deepStrictEqual(grown(grow), grown(0), "growth " + grow);
}

console.log(
    "History summary randomized equivalence, trimming, snapshots, exact extrema, budgets and output cap passed"
);
