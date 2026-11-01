"use strict";
// The waveform history store and its Worker: block growth and eviction under the shared budget, frozen snapshots,
// archive restore, viewport summaries against a point-by-point reference, and the Worker protocol.
const assert = require("assert");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const fsSync = require("fs");
const { PassThrough } = require("stream");
const { MessageChannel } = require("worker_threads");
const {
    ChartHistoryStore,
    BLOCK_POINTS,
    BLOCK_BYTES,
    INITIAL_BLOCK_POINTS,
    blockBytes,
    MAX_POINTS,
    WINDOW_MS
} = require("../src/services/chartHistoryStore");
const { restoreHistory, run } = require("../src/chartHistoryWorker");
const { ChartHistoryService, estimateHistoryBytes, MAX_BACKLOG_BYTES } = require("../src/services/chartHistoryService");
const { SamplingArchive } = require("../src/services/samplingArchive");
const { columnBin } = require("../src/webview/liveWatch/chartInspection");
const { deserializeError } = require("../src/services/errorEnvelope");
const { decodeViewport } = require("../src/webview/liveWatch/chartTransport");
const { waitFor } = require("./helpers/wait");
const { scenario } = require("./helpers/scenario");

// Block growth, shared-budget eviction, atomic degradation, snapshots and archive restore
async function capacity() {
    const itemsFor = (count) =>
        Array.from({ length: count }, (_, i) => ({ name: "buf[" + i + "]", type: "u8", address: 0x20000000 + i }));
    const samplesFor = (items, t) => items.map(({ name }, i) => ({ name, t, value: (i + t) & 255 }));
    const points = (store, scope, name, snapshotId) => [
        ...store.points(store._source(scope, snapshotId).series.get(name))
    ];

    // A full block per series would not fit the budget: just over it (like 7800 series against the default 512 MB),
    // and far over it. Blocks start small and grow, so the first sample and the first growth both fit.
    for (const count of [1000, 2600]) {
        const items = itemsFor(count);
        const store = new ChartHistoryStore(64 * 1024 * 1024);
        assert.ok(count * BLOCK_BYTES > store.maxBytes, "eager full blocks would exhaust the budget");
        store.configure("large", items);
        store.append("large", samplesFor(items, 0), 0);
        assert.strictEqual(store.bytes, count * blockBytes(INITIAL_BLOCK_POINTS));
        assert.strictEqual(store.status("large").limited, false);
        for (let t = 1; t < INITIAL_BLOCK_POINTS; t++) store.append("large", samplesFor(items, t), t);
        assert.strictEqual(store.bytes, count * blockBytes(INITIAL_BLOCK_POINTS));
        const frozen = store.freeze("large");
        const original = points(store, "large", items[0].name, frozen.snapshotId);
        const block = store._scope("large").series.get(items[0].name).parts[0].block;
        store.append("large", samplesFor(items, INITIAL_BLOCK_POINTS), INITIAL_BLOCK_POINTS);
        assert.strictEqual(store.bytes, count * blockBytes(INITIAL_BLOCK_POINTS * 2));
        assert.strictEqual(store._source("large", frozen.snapshotId).series.get(items[0].name).parts[0].block, block);
        assert.deepStrictEqual(points(store, "large", items[0].name, frozen.snapshotId), original);
        store.clear("large");
        assert.strictEqual(store.bytes, 0);
    }

    // Large batches reserve every growth step and full block before any point is written.
    {
        const store = new ChartHistoryStore();
        const [item] = itemsFor(1);
        store.configure("p", [item]);
        for (let from = 0; from < BLOCK_POINTS * 2 + 77; from += 37) {
            const samples = Array.from({ length: Math.min(37, BLOCK_POINTS * 2 + 77 - from) }, (_, i) => ({
                name: item.name,
                t: from + i,
                value: i
            }));
            store.append("p", samples, samples.at(-1).t);
        }
        const parts = store._scope("p").series.get(item.name).parts;
        assert.deepStrictEqual(
            parts.map((part) => part.block.capacity),
            [BLOCK_POINTS, BLOCK_POINTS, 128]
        );
        assert.strictEqual(store.bytes, BLOCK_BYTES * 2 + blockBytes(128));
    }

    // Old live blocks are evicted, retaining actual bounds; frozen blocks and their bounds survive.
    {
        const store = new ChartHistoryStore(BLOCK_BYTES + blockBytes(INITIAL_BLOCK_POINTS));
        const [item] = itemsFor(1);
        store.configure("p", [item]);
        store.append(
            "p",
            Array.from({ length: BLOCK_POINTS }, (_, t) => ({ name: item.name, t, value: t })),
            BLOCK_POINTS - 1
        );
        store.append("p", [{ name: item.name, t: BLOCK_POINTS, value: 1 }], BLOCK_POINTS);
        const frozen = store.freeze("p", "export");
        const original = points(store, "p", item.name, frozen.snapshotId);
        const oldBlock = store._scope("p").series.get(item.name).parts[0].block;
        store.append(
            "p",
            Array.from({ length: INITIAL_BLOCK_POINTS }, (_, i) => ({
                name: item.name,
                t: BLOCK_POINTS + i + 1,
                value: i
            })),
            BLOCK_POINTS + INITIAL_BLOCK_POINTS
        );
        assert.deepStrictEqual(points(store, "p", item.name, frozen.snapshotId), original);
        assert.strictEqual(
            store._scope("p").series.get(item.name).count,
            BLOCK_POINTS + 1,
            "a batch that cannot fit shared history is skipped atomically"
        );
        assert.strictEqual(store.status("p").limited, true);
        assert.strictEqual(store.status("p", frozen.snapshotId).limited, false);
        assert.strictEqual(store.status("p").bounds.min, 0);
        store.release(frozen.snapshotId);
        store.append(
            "p",
            [{ name: item.name, t: BLOCK_POINTS + INITIAL_BLOCK_POINTS + 1, value: 3 }],
            BLOCK_POINTS + INITIAL_BLOCK_POINTS + 1
        );
        assert.ok(store.bytes <= store.maxBytes);
        assert.strictEqual(store.status("p").bounds.min, BLOCK_POINTS);
        assert.strictEqual(oldBlock.refs, 0, "eviction releases the live block reference");
        assert.strictEqual(
            store.viewport("p", [item.name], store.status("p").bounds, 1).series.length,
            2,
            "skipped samples remain a visible discontinuity"
        );
    }

    // No partial writes even when a new batch alone exceeds the budget; later batches can recover.
    {
        const store = new ChartHistoryStore(blockBytes(INITIAL_BLOCK_POINTS));
        const items = itemsFor(2);
        store.configure("p", items);
        assert.strictEqual(store.append("p", samplesFor(items, 1), 1).limited, true);
        assert.strictEqual(store.bytes, 0);
        assert.strictEqual(store.status("p").bounds, null);
        store.append("p", samplesFor(items.slice(0, 1), 2), 2);
        assert.strictEqual(store.status("p").bounds.min, 2);
        store.clear("p");
        assert.strictEqual(store.status("p").limited, false);
    }

    // The full three-minute, 100 Hz workload over 20,000 series can be run with --stress (360 million leaf points,
    // 512 MB). Normal runs drive 5,000 series with a 6 MB budget, the same bytes per series as 20,000 with 24 MB, which
    // reaches steady eviction pressure after 64 frames instead of 1024.
    {
        const stress = process.argv.includes("--stress");
        const store = new ChartHistoryStore((stress ? 512 : 6) * 1024 * 1024);
        const items = itemsFor(stress ? 20000 : 5000);
        const viewed = items.slice(0, 3).map((item) => item.name);
        const samples = samplesFor(items, 0);
        store.configure("steady", items);
        store.configure("frozen", items.slice(0, 1));
        store.append("frozen", [{ name: items[0].name, t: 0, value: 7 }], 0);
        const frozen = store.freeze("frozen", "export");
        const original = points(store, "frozen", items[0].name, frozen.snapshotId);
        const frames = stress ? 18000 : 160;
        let pressureFrames = 0;
        for (let frame = 0; frame < frames; frame++) {
            const tick = frame * 10; // Virtual 100 Hz, with every leaf in every frame.
            for (const sample of samples) sample.t = tick;
            const work = store.evictionWork;
            const evictions = store.evictedBlocks;
            store.append("steady", samples, tick);
            if (frame % 50 === 0) store.viewport("steady", viewed, { min: 0, max: tick }, 1);
            assert.ok(store.bytes <= store.maxBytes);
            const removed = store.evictedBlocks - evictions;
            if (removed) pressureFrames++;
            assert.ok(
                store.evictionWork - work < (items.length + removed + 1) * 64,
                "per-append heap work is bounded by new/removed candidates, with no global sort"
            );
            if (stress && frame % 2000 === 0) console.log("History stress: " + frame + "/" + frames + " frames");
        }
        const state = store._scope("steady");
        const viewedStart = state.series.get(viewed[0]).parts[0].block.times[0];
        const unviewed = items.slice(3).map((item) => state.series.get(item.name));
        assert.strictEqual(viewedStart, 0, "displayed curves retain the beginning of the run");
        assert.ok(
            unviewed.some((series) => series.parts[0].block.times[series.parts[0].start] > (stress ? 10000 : 0)),
            "unviewed curves lose old history first"
        );
        assert.ok(store.evictedBlocks > 0);
        assert.ok(pressureFrames < frames / 4, "headroom amortizes eviction across many appends");
        assert.strictEqual(
            store.evictionHeap.length,
            [...store.scopes.values()].reduce(
                (n, scope) =>
                    n +
                    [...scope.series.values()].reduce(
                        (sum, series) => sum + series.parts.filter((part) => part.block.refs === 1).length,
                        0
                    ),
                0
            )
        );
        assert.deepStrictEqual(points(store, "frozen", items[0].name, frozen.snapshotId), original);
        store.release(frozen.snapshotId);
        store.remove("steady");
        store.remove("frozen");
        assert.strictEqual(store.bytes, 0);
        assert.strictEqual(store.evictionHeap.length, 0);
    }

    // Snapshot-of-snapshot exports and viewport priority expiration preserve the eviction index.
    {
        const store = new ChartHistoryStore(blockBytes(INITIAL_BLOCK_POINTS) * 2);
        const items = itemsFor(3);
        store.configure("p", items);
        store.append("p", samplesFor(items.slice(0, 2), 0), 0);
        store.viewport("p", [items[0].name], { min: 0, max: 1 }, 1);
        const frozen = store.freeze("p");
        const exported = store.freeze("p", "export", frozen.snapshotId);
        store.resume("p");
        assert.strictEqual(store.evictionHeap.length, 0);
        store.release(exported.snapshotId);
        assert.strictEqual(store.evictionHeap.length, 2);
        store.append("p", samplesFor(items.slice(2), 6000), 6000);
        assert.strictEqual(store._scope("p").series.get(items[0].name).viewed, false);
        assert.strictEqual(store.evictionHeap.length, 1, "hysteresis frees headroom beyond the minimum batch");
    }

    // Evictions in one panel update the actual retained bounds of other panels too.
    const updates = [];
    const worker = new ChartHistoryService({
        maxBytes: blockBytes(INITIAL_BLOCK_POINTS),
        onUpdated: (message) => updates.push(message)
    });
    try {
        const [item] = itemsFor(1);
        await worker.request("configure", ["old", [item]]);
        await worker.request("append", ["old", [{ name: item.name, t: 1, value: 1 }], 1]);
        // Updates are debounced in the worker; a fixed sleep let a late pre-eviction update leak past the reset.
        await waitFor(
            () => updates.some((message) => message.scope === "old"),
            "the first append publishes its status update",
            5000
        );
        updates.length = 0;
        await worker.request("configure", ["new", [item]]);
        await worker.request("append", ["new", [{ name: item.name, t: 2, value: 2 }], 2]);
        await waitFor(
            () =>
                updates.some((message) => message.scope === "old") &&
                updates.some((message) => message.scope === "new"),
            "both panels publish a status update after the shared-budget eviction",
            5000
        );
        const old = updates.find((message) => message.scope === "old");
        assert.ok(old, "the evicted panel receives a status update without its own append");
        assert.strictEqual(old.limited, true);
        assert.strictEqual(old.bounds, null);
        assert.strictEqual(updates.find((message) => message.scope === "new").bounds.min, 2);
    } finally {
        await worker.dispose();
    }

    // Lowering the configured budget cannot release export references or stop recording.
    const store = new ChartHistoryStore();
    const [item] = itemsFor(1);
    store.configure("p", [item]);
    store.append("p", [{ name: item.name, t: 1, value: 1, valueText: "x".repeat(34 * 1024 * 1024) }], 1);
    const frozen = store.freeze("p", "export");
    store.remove("p");
    assert.strictEqual(
        store.setBudget(64 * 1024 * 1024).limited,
        true,
        "an export from a removed panel still occupies the budget"
    );
    store.configure("p", [item]);
    assert.ok(store.bytes > store.maxBytes, "shared memory remains budgeted until released");
    assert.strictEqual(store.append("p", [{ name: item.name, t: 2, value: 2 }], 2).limited, true);
    assert.strictEqual(points(store, "p", item.name, frozen.snapshotId)[0].t, 1);
    store.release(frozen.snapshotId);
    store.append("p", [{ name: item.name, t: 3, value: 3 }], 3);
    assert.ok(store.bytes <= store.maxBytes);
    assert.strictEqual(store.status("p").bounds.min, 3);

    // Archive restoration observes the same memory limit without losing archive data.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chart-capacity-"));
    const archive = new SamplingArchive({ rootDir: dir });
    try {
        for (let t = 0; t <= INITIAL_BLOCK_POINTS; t++)
            archive.append([{ name: item.name + " [u8]", value: t }], t + 1000, "restore");
        const restored = new ChartHistoryStore(blockBytes(INITIAL_BLOCK_POINTS));
        restored.configure("restore", [item]);
        const status = await restoreHistory(restored, await archive.historySource("restore"));
        assert.strictEqual(status.limited, true);
        assert.strictEqual(status.bounds.min, INITIAL_BLOCK_POINTS + 1000);
        assert.strictEqual(points(restored, "restore", item.name)[0].v, INITIAL_BLOCK_POINTS);
        assert.strictEqual((await archive.historySource("restore")).lastTimestampMs, INITIAL_BLOCK_POINTS + 1000);
    } finally {
        await archive.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    }
    console.log("Large leaf capacity, growth, atomic degradation, snapshots and archive restore passed");
}

// Viewport summaries match a point-by-point reference
async function summaries() {
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
            block.summaries.reduce(
                (bytes, summary) => bytes + summary.indices.byteLength + summary.flags.byteLength,
                0
            );
        assert.strictEqual(block.bytes, allocated);
        assert.strictEqual(store.bytes, allocated);
        const frozen = store.freeze("panel", "export");
        assert.strictEqual(store.bytes, allocated, "shared summaries are budgeted once");
        assert.strictEqual(
            store.append("panel", [{ name: "budget", t: 1, value: 2, valueText: "02" }], 1).limited,
            true
        );
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
}

// Worker protocol: packed history, silent retention, precision, budgets, recovery and CSV
async function worker() {
    async function testSeekRestore() {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-seek-"));
        const archive = new SamplingArchive({ rootDir: path.join(dir, "history") });
        const createReadStream = fsSync.createReadStream;
        let bytesRead = 0;
        try {
            // Over four days of interleaved scopes, with only the last 30 minutes needed for restore.
            for (let i = 1; i <= 40000; i++) {
                archive.append([{ name: "x [f32]", value: i }], i * 10000, "panel");
                if (i % 100 === 0) archive.append([{ name: "x [f32]", value: -i }], i * 10000, "other");
            }
            const source = await archive.historySource("panel");
            assert.ok(source.startOffset > source.cutoff * 0.8, "the time index skips old blocks");
            assert.ok(archive.timeIndex.length > 10);
            assert.ok(archive.timeIndex.length < source.cutoff / 65536 + 1);
            fsSync.createReadStream = (...args) => {
                const input = createReadStream(...args);
                input.on("data", (chunk) => (bytesRead += chunk.length));
                return input;
            };
            const sought = new ChartHistoryStore();
            const scanned = new ChartHistoryStore();
            for (const store of [sought, scanned]) store.configure("panel", [{ name: "x", type: "f32" }]);
            await restoreHistory(sought, source);
            const soughtBytes = bytesRead;
            assert.ok(soughtBytes < source.cutoff / 5, `seek reads ${soughtBytes} of ${source.cutoff} bytes`);
            bytesRead = 0;
            await restoreHistory(scanned, { ...source, startOffset: 0 });
            assert.strictEqual(bytesRead, source.cutoff);
            const points = (store) => [...store.points(store._scope("panel").series.get("x"))];
            assert.deepStrictEqual(points(sought), points(scanned));
            assert.strictEqual(points(sought).length, 181, "inclusive 30-minute window is unchanged");
            const nextTime = source.lastTimestampMs + 10000;
            archive.append([{ name: "x [f32]", value: 123 }], nextTime, "panel");
            archive.append([{ name: "new [f32]", value: 456 }], nextTime, "panel");
            const catchup = await archive.historySource("panel");
            bytesRead = 0;
            await restoreHistory(sought, { ...catchup, fromOffset: source.cutoff });
            assert.strictEqual(bytesRead, catchup.cutoff - source.cutoff);
            assert.strictEqual(points(sought).at(-1).v, 123);
            assert.strictEqual(points(sought).filter((point) => point.t === nextTime).length, 1);
            console.log(
                `Seek restore: ${soughtBytes}/${source.cutoff} bytes, identical 181-point window; catch-up boundary passed`
            );
        } finally {
            fsSync.createReadStream = createReadStream;
            await archive.dispose();
            await fs.rm(dir, { recursive: true, force: true });
        }
    }

    async function testServiceLimits() {
        const dormant = new ChartHistoryService({ workerPath: "missing-worker.js" });
        assert.strictEqual(dormant.worker, null, "construction does not create a worker");
        assert.strictEqual(dormant.failed, null);
        await dormant.dispose();
        await assert.rejects(dormant.request("status", ["p"]), /disposed/);
        const recovering = new ChartHistoryService();
        const failure = new Error("failed before first request");
        recovering.fail(failure);
        await recovering.termination;
        assert.strictEqual(recovering.worker, null);
        await assert.rejects(recovering.request("status", ["p"]), failure);
        await recovering.restart();
        assert.strictEqual(recovering.worker, null, "an unused service remains lazy after recovery");
        await recovering.request("status", ["p"]);
        assert.ok(recovering.worker.threadId > 0);
        await recovering.dispose();

        const samples = Array.from({ length: 100 }, (_, i) => ({
            name: "value",
            value: i / 3,
            valueText: String(i / 3),
            t: i
        }));
        const args = ["scope", samples, 99];
        const estimate = estimateHistoryBytes(args);
        assert.ok(estimate >= samples.length * 24 + 2 * "scope".length);
        assert.ok(
            estimate >= Buffer.byteLength(JSON.stringify(args)),
            "ordinary batches include container/property overhead"
        );
        assert.ok(estimate < MAX_BACKLOG_BYTES);
        assert.strictEqual(estimateHistoryBytes("中🙂"), 16 + "中🙂".length * 2);
        assert.strictEqual(estimateHistoryBytes(1e100), 8, "numbers are accounted as cloned doubles");
        assert.strictEqual(estimateHistoryBytes(Buffer.alloc(123)), 32 + 123);
        const cycle = {};
        cycle.self = cycle;
        assert.strictEqual(estimateHistoryBytes(cycle), MAX_BACKLOG_BYTES + 1, "cycles saturate within a depth bound");
        assert.strictEqual(estimateHistoryBytes(Array(300000).fill(0)), MAX_BACKLOG_BYTES + 1);
        assert.strictEqual(estimateHistoryBytes("x".repeat(MAX_BACKLOG_BYTES)), MAX_BACKLOG_BYTES + 1);
        const noJson = { value: 1 };
        Object.defineProperty(noJson, "toJSON", { value: () => assert.fail("estimates must not serialize") });
        assert.ok(estimateHistoryBytes(noJson) >= 8);

        const stalled = new ChartHistoryService();
        let terminations = 0;
        stalled.worker = {
            postMessage() {},
            terminate: async () => {
                terminations++;
            }
        };
        const large = ["scope", [{ name: "value", valueText: "x".repeat(4 * 1024 * 1024) }], 1];
        const first = stalled.request("append", large);
        assert.ok(stalled.queuedBytes > 8 * 1024 * 1024);
        const dropped = stalled.request("append", large);
        const repeated = stalled.request("append", large);
        assert.strictEqual(stalled.failed, null);
        assert.strictEqual(stalled.pending.size, 2, "backpressure adds one coalesced gap marker");
        assert.strictEqual(stalled.limitedScopes.size, 1);
        assert.strictEqual(terminations, 0, "backpressure preserves the worker and accepted appends");
        const accepted = stalled.pending.get(1);
        stalled.pending.delete(1);
        stalled.queuedBytes -= accepted.bytes;
        accepted.resolve({ limited: false });
        const marker = stalled.pending.get(2);
        stalled.pending.delete(2);
        marker.resolve({ limited: true });
        await first;
        assert.deepStrictEqual(await dropped, { limited: true });
        assert.deepStrictEqual(await repeated, { limited: true });
        assert.strictEqual(stalled.queuedBytes, 0);
        const generation = new ChartHistoryService();
        generation.worker = { postMessage() {}, terminate: async () => {} };
        generation.queuedBytes = MAX_BACKLOG_BYTES;
        const oldDrop = generation.request("append", ["scope", samples, 100]);
        const clearing = generation.request("clear", ["scope"]);
        const newDrop = generation.request("append", ["scope", samples, 200]);
        assert.strictEqual(generation.pending.size, 3, "clear fences the old marker and starts a new one");
        generation.pending.get(1).resolve({ limited: true });
        await oldDrop;
        assert.strictEqual(generation.limitedScopes.size, 1, "the old acknowledgement cannot erase the new gap marker");
        generation.pending.get(2).resolve({ limited: false });
        generation.pending.get(3).resolve({ limited: true });
        await Promise.all([clearing, newDrop]);
        generation.pending.clear();
        await generation.dispose();
        await stalled.dispose();
    }

    // Runs the worker's message loop in-process with a gated archive reader, so `clear` is guaranteed
    // to be handled while the restore is in flight instead of racing the file read.
    async function testRestoreCancellation(source, configuredItems) {
        const archived = (await fs.readFile(source.dataPath)).subarray(0, source.cutoff);
        const { port1, port2 } = new MessageChannel();
        const pending = new Map();
        let nextId = 0;
        port1.on("message", ({ id, result, error }) => {
            const request = pending.get(id);
            if (!request) return;
            pending.delete(id);
            if (error) request.reject(deserializeError(error));
            else request.resolve(result);
        });
        const request = (method, args) =>
            new Promise((resolve, reject) => {
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                port1.postMessage({ id, method, args });
            });
        let onOpen = null;
        const opened = () => new Promise((resolve) => (onOpen = resolve));
        const createReadStream = fsSync.createReadStream;
        fsSync.createReadStream = (file) => {
            assert.strictEqual(file, source.dataPath);
            const gate = new PassThrough();
            onOpen(gate);
            return gate;
        };
        const cancelled = (error) => error.code === "CHART_HISTORY_RESTORE_CANCELLED";
        run(port2);
        try {
            await request("configure", ["panel", configuredItems]);
            let reading = opened();
            const control = request("restore", [source]);
            (await reading).end(archived);
            assert.strictEqual(
                (await control).bounds.min,
                source.lastTimestampMs,
                "the gated reader restores archive data"
            );

            await request("clear", ["panel"]);
            reading = opened();
            const beforeLines = request("restore", [source]);
            let gate = await reading;
            await request("clear", ["panel"]);
            gate.end(archived);
            await assert.rejects(beforeLines, cancelled);
            assert.strictEqual(
                (await request("status", ["panel"])).bounds,
                null,
                "clear cancels asynchronous archive reconstruction"
            );

            reading = opened();
            const afterLines = request("restore", [source]);
            gate = await reading;
            gate.write(archived);
            assert.strictEqual(
                (await request("status", ["panel"])).bounds?.min,
                source.lastTimestampMs,
                "every archived row is applied before end-of-file"
            );
            await request("clear", ["panel"]);
            gate.end();
            await assert.rejects(afterLines, cancelled, "a clear before end-of-file still cancels the restore");
            assert.strictEqual((await request("status", ["panel"])).bounds, null);
        } finally {
            fsSync.createReadStream = createReadStream;
            port1.close();
        }
    }

    const items = ["visible", "silent"].map((name) => ({ name, type: "u64", address: 0x20000000 }));
    await testSeekRestore();
    await testServiceLimits();
    const store = new ChartHistoryStore();
    store.configure("panel", items);
    for (let i = 0; i <= 360100; i++)
        store.append(
            "panel",
            items.map((item) => ({ name: item.name, value: Math.sin(i / 40), t: i * 5 })),
            i * 5
        );
    const state = store._scope("panel");
    assert.strictEqual(state.series.get("silent").count, MAX_POINTS);
    const status = store.status("panel");
    assert.strictEqual(status.bounds.min, 500);
    assert.ok(store.bytes < 13 * 1024 * 1024);
    const view = store.viewport("panel", ["silent"], status.bounds, 800);
    // At most four points per power-of-two time bin; bins are within √2 of one column.
    assert.ok(view.series.reduce((count, s) => count + s.arr.length, 0) <= 4 * Math.ceil(801 * Math.SQRT2));
    assert.strictEqual(
        view.series.reduce((count, s) => count + s.visibleCount, 0),
        MAX_POINTS
    );
    assert.deepStrictEqual(store.viewport("panel", [], status.bounds, 800).bounds, status.bounds);
    const frozen = store.freeze("panel");
    store.append(
        "panel",
        [{ name: "silent", value: 123, t: status.bounds.max + WINDOW_MS }],
        status.bounds.max + WINDOW_MS
    );
    assert.deepStrictEqual(store.status("panel", frozen.snapshotId).bounds, status.bounds);
    assert.ok(store.bytes > 10 * 1024 * 1024, "expired blocks referenced by freeze remain budgeted");
    store.resume("panel");
    assert.ok(store.bytes < BLOCK_BYTES * 4);
    store.clear("panel");
    assert.strictEqual(store.bytes, 0);
    assert.throws(() => store.status("panel", frozen.snapshotId), /snapshot/);
    assert.throws(() => store.viewport("panel", [], { min: NaN, max: 4 }, 100), /viewport/);
    const exact = ["18446744073709551610", "18446744073709551615", "18446744073709551611"];
    for (let i = 0; i < exact.length; i++)
        store.append("panel", [{ name: "silent", value: Number(exact[i]), valueText: exact[i], t: i + 1 }], i + 1);
    store.append(
        "panel",
        [
            { name: "silent", value: null, t: 4 },
            { name: "silent", value: 7, t: 5 }
        ],
        5
    );
    const precision = store.viewport("panel", ["silent"], { min: 1, max: 5 }, 1);
    assert.strictEqual(precision.series.length, 2);
    assert.ok(precision.series[0].arr.some((point) => point.valueText === exact[1]));
    const bounded = new ChartHistoryStore(blockBytes(INITIAL_BLOCK_POINTS));
    bounded.configure("p", items);
    const limited = bounded.append(
        "p",
        items.map((item) => ({ name: item.name, value: 1 })),
        1
    );
    assert.strictEqual(limited.limited, true);
    assert.strictEqual(bounded.bytes, 0, "skipped batch is atomic");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chart-history-"));
    const worker = new ChartHistoryService();
    assert.strictEqual(worker.worker, null);
    const archive = new SamplingArchive({ rootDir: path.join(dir, "archive") });
    try {
        archive.append([{ name: "silent [u64]", value: 1 }], 1000, "panel");
        archive.clear("panel");
        archive.append([{ name: "silent [u64]", value: Number(exact[1]), valueText: exact[1] }], 2000, "panel");
        archive.append([{ name: "silent [u64]", value: 99 }], 2000, "other");
        assert.strictEqual(worker.worker, null, "unrelated archive/export work does not start history IPC");
        await worker.request("configure", ["multi", items]);
        assert.ok(worker.worker.threadId > 0, "the first request starts the worker");
        await worker.request("append", [
            "multi",
            [
                { name: "silent", value: 1, t: 10 },
                { name: "visible", value: 2, t: 10 },
                { name: "silent", value: 3, t: 15 },
                { name: "silent", value: 4, t: 20 }
            ],
            20
        ]);
        const multi = await worker.request("viewport", ["multi", ["silent"], { min: 0, max: 25 }, 100]);
        assert.deepStrictEqual(
            decodeViewport(multi.series)[0].arr.map((point) => [point.t, point.v]),
            [
                [10, 1],
                [15, 3],
                [20, 4]
            ]
        );
        const oldAppend = worker.request("append", ["multi", [{ name: "silent", value: 5, t: 25 }], 25]);
        const clearing = worker.request("clear", ["multi"]);
        const newAppend = worker.request("append", ["multi", [{ name: "silent", value: 6, t: 30 }], 30]);
        await Promise.all([oldAppend, clearing, newAppend]);
        const afterClear = await worker.request("viewport", ["multi", ["silent"], { min: 0, max: 40 }, 100]);
        assert.deepStrictEqual(
            decodeViewport(afterClear.series)[0].arr.map((point) => [point.t, point.v]),
            [[30, 6]]
        );
        await worker.request("configure", ["panel", items]);
        const restored = await worker.request("restore", [await archive.historySource("panel")]);
        assert.strictEqual(restored.bounds.min, 2000);
        const v = await worker.request("viewport", ["panel", ["silent"], { min: 0, max: 3000 }, 100]);
        assert.ok(v.series[0].t instanceof Float64Array, "worker replies retain typed arrays across IPC");
        assert.strictEqual(decodeViewport(v.series)[0].arr.length, 1);
        assert.strictEqual(decodeViewport(v.series)[0].arr[0].valueText, exact[1]);
        assert.strictEqual((await worker.request("setBudget", [64 * 1024 * 1024])).maxBytes, 64 * 1024 * 1024);
        await assert.rejects(worker.request("setBudget", [63 * 1024 * 1024]), /64/);
        const freeze = await worker.request("freeze", ["panel"]);
        await worker.request("configure", ["panel", []]);
        assert.deepStrictEqual((await worker.request("status", ["panel", freeze.snapshotId])).variables, ["silent"]);
        await worker.request("clear", ["panel"]);
        await assert.rejects(worker.request("status", ["panel", freeze.snapshotId]), /snapshot/);
        const identity = JSON.stringify(["u64", 0x20000000, undefined, undefined]);
        archive.append([{ name: "silent [u64]", value: 88, historyIdentity: "different-address" }], 2700, "panel");
        archive.append([{ name: "silent [u64]", value: 42, historyIdentity: identity }], 3000, "panel");
        await worker.request("configure", ["panel", items.map((item) => ({ ...item, historyFromMs: 2600 }))]);
        await worker.request("restore", [await archive.historySource("panel")]);
        const restoredIdentity = await worker.request("viewport", ["panel", ["silent"], { min: 0, max: 4000 }, 100]);
        assert.deepStrictEqual(
            decodeViewport(restoredIdentity.series)[0].arr.map((point) => point.v),
            [42],
            "recovery excludes old observations and changed addresses"
        );
        await testRestoreCancellation(
            await archive.historySource("panel"),
            items.map((item) => ({ ...item, historyFromMs: 2600 }))
        );
        await assert.rejects(worker.request("invalid"), /Unknown/);
        await worker.worker.terminate();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(worker.failed);
        await worker.restart();
        assert.strictEqual((await worker.request("status", ["panel"])).bounds, null);
    } finally {
        await worker.dispose();
        await archive.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    }

    await scenario("Await failed history worker termination before restarting", async () => {
        const { ChartHistoryService } = require("../src/services/chartHistoryService");
        const history = new ChartHistoryService();
        try {
            await history.request("status", ["panel"]);
            history.fail(Error("Forced failure"));
            await history.termination;
            assert.strictEqual(history.worker.threadId, -1);
            await history.restart();
            assert.ok(history.worker.threadId > 0);
        } finally {
            await history.dispose();
        }
    });

    console.log("Packed history, silent retention, precision, budgets, worker recovery and CSV tests passed");
}

(async () => {
    await scenario("Block growth, shared-budget eviction, atomic degradation, snapshots and archive restore", capacity);
    await scenario("Viewport summaries match a point-by-point reference", summaries);
    await scenario("Worker protocol: packed history, silent retention, precision, budgets, recovery and CSV", worker);
    console.log("Chart history store, summary and Worker tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
