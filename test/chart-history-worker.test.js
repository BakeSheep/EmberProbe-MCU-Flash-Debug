"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { ChartHistoryStore, BLOCK_BYTES, WINDOW_MS, MAX_POINTS } = require("../src/services/chartHistoryStore");
const { ChartHistoryService } = require("../src/services/chartHistoryService");
const { SamplingArchive } = require("../src/services/samplingArchive");
const { exportHistory } = require("../src/chartHistoryWorker");
const items = ["visible", "silent"].map((name) => ({ name, type: "u64", address: 0x20000000 }));
(async () => {
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
    const bounded = new ChartHistoryStore(BLOCK_BYTES);
    bounded.configure("p", items);
    assert.throws(
        () =>
            bounded.append(
                "p",
                items.map((item) => ({ name: item.name, value: 1 })),
                1
            ),
        /budget/
    );
    assert.strictEqual(bounded.bytes, 0, "failed batch is atomic");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chart-history-"));
    const worker = new ChartHistoryService();
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
        await worker.request("clear", ["panel"]);
        const restoreSource = await archive.historySource("panel");
        const restoring = worker.request("restore", [restoreSource]);
        const cancelled = assert.rejects(restoring, (error) => error.code === "CHART_HISTORY_RESTORE_CANCELLED");
        await worker.request("clear", ["panel"]);
        await cancelled;
        assert.strictEqual(
            (await worker.request("status", ["panel"])).bounds,
            null,
            "clear cancels asynchronous archive reconstruction"
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
    console.log("Packed history, silent retention, precision, budgets, worker recovery and CSV tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
