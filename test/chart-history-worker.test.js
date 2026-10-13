"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const { MessageChannel } = require("worker_threads");
const {
    ChartHistoryStore,
    BLOCK_BYTES,
    INITIAL_BLOCK_POINTS,
    blockBytes,
    WINDOW_MS,
    MAX_POINTS
} = require("../src/services/chartHistoryStore");
const { ChartHistoryService, estimateHistoryBytes, MAX_BACKLOG_BYTES } = require("../src/services/chartHistoryService");
const { SamplingArchive } = require("../src/services/samplingArchive");
const { exportHistory, run } = require("../src/chartHistoryWorker");
const { deserializeError } = require("../src/services/errorEnvelope");
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
            "every archived line is applied before end-of-file"
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
(async () => {
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
    assert.ok(view.series.reduce((count, s) => count + s.arr.length, 0) <= 3204);
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
        const outputPath = path.join(dir, "retained.csv");
        await exportHistory(store, { scope: "panel", names: ["silent"], outputPath });
        const csv = await fs.readFile(outputPath, "utf8");
        assert.ok(csv.includes(exact[1]));
        assert.strictEqual(csv.split("\r\n").filter(Boolean).length, 6);
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
            multi.series[0].arr.map((point) => [point.t, point.v]),
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
            afterClear.series[0].arr.map((point) => [point.t, point.v]),
            [[30, 6]]
        );
        await worker.request("configure", ["panel", items]);
        const restored = await worker.request("restore", [await archive.historySource("panel")]);
        assert.strictEqual(restored.bounds.min, 2000);
        const v = await worker.request("viewport", ["panel", ["silent"], { min: 0, max: 3000 }, 100]);
        assert.strictEqual(v.series[0].arr.length, 1);
        assert.strictEqual(v.series[0].arr[0].valueText, exact[1]);
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
            restoredIdentity.series[0].arr.map((point) => point.v),
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
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
