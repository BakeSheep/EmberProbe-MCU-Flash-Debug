"use strict";
const assert = require("assert");
const {
    ChartHistoryStore,
    BLOCK_POINTS,
    BLOCK_BYTES,
    INITIAL_BLOCK_POINTS,
    blockBytes
} = require("../src/services/chartHistoryStore");
const { restoreHistory } = require("../src/chartHistoryWorker");
const { ChartHistoryService } = require("../src/services/chartHistoryService");
const { SamplingArchive } = require("../src/services/samplingArchive");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");

const itemsFor = (count) =>
    Array.from({ length: count }, (_, i) => ({ name: "buf[" + i + "]", type: "u8", address: 0x20000000 + i }));
const samplesFor = (items, t) => items.map(({ name }, i) => ({ name, t, value: (i + t) & 255 }));
const points = (store, scope, name, snapshotId) => [...store.points(store._source(scope, snapshotId).series.get(name))];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, message, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        assert(Date.now() < deadline, message);
        await wait(5);
    }
}

for (const count of [7800, 20000]) {
    const items = itemsFor(count);
    const store = new ChartHistoryStore(512 * 1024 * 1024);
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

// The full three-minute, 100 Hz workload can be run with --stress (360 million leaf points, 512 MB).
// Normal runs drive the same 20k-series path with a 24 MB budget, which reaches steady eviction
// pressure after 64 frames instead of 1024.
{
    const stress = process.argv.includes("--stress");
    const store = new ChartHistoryStore((stress ? 512 : 24) * 1024 * 1024);
    const items = itemsFor(20000);
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
        const tick = frame * 10; // Virtual 100 Hz, with all 20,000 leaves in every frame.
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

(async () => {
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
            "the first append publishes its status update"
        );
        updates.length = 0;
        await worker.request("configure", ["new", [item]]);
        await worker.request("append", ["new", [{ name: item.name, t: 2, value: 2 }], 2]);
        await waitFor(
            () =>
                updates.some((message) => message.scope === "old") &&
                updates.some((message) => message.scope === "new"),
            "both panels publish a status update after the shared-budget eviction"
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
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
