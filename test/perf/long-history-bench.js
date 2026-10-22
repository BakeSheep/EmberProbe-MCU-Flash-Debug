"use strict";

// Opt in: node test/perf/long-history-bench.js. No hardware or network.
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { performance } = require("perf_hooks");
const { ArchiveEncoder, FILE_HEADER } = require("../../src/services/samplingArchiveFormat");
const { ArchiveChartHistoryStore } = require("../../src/services/archiveChartHistoryStore");

async function createArchive(file, channels, hours) {
    const encoder = new ArchiveEncoder();
    const values = (i) =>
        Array.from({ length: channels }, (_, c) => ({
            key: `x${c} [f32]`,
            text: String(c + (i % 16) / 4)
        }));
    const output = await fs.open(file, "w");
    try {
        await output.write(FILE_HEADER);
        await output.write(encoder.encodeRow({ scope: "p", t: 1, values: values(0) }));
        const patterns = Array.from({ length: 16 }, (_, i) =>
            encoder.encodeRow({ scope: "p", t: 1, values: values(i) })
        );
        const rowBytes = patterns[0].length;
        const batchRows = 8192;
        const batch = Buffer.allocUnsafe(rowBytes * batchRows);
        for (let i = 0; i < batchRows; i++) patterns[i % 16].copy(batch, i * rowBytes);
        const rows = hours * 3600 * 200;
        for (let start = 1; start < rows; start += batchRows) {
            const count = Math.min(batchRows, rows - start);
            for (let i = 0; i < count; i++) batch.writeDoubleLE((start + i) * 5 + 1, i * rowBytes + 11);
            let written = 0;
            while (written < count * rowBytes) {
                const result = await output.write(batch, written, count * rowBytes - written);
                written += result.bytesWritten;
            }
        }
    } finally {
        await output.close();
    }
}

async function measure({ file, channels, hours }) {
    const store = new ArchiveChartHistoryStore();
    const items = Array.from({ length: channels }, (_, i) => ({ name: `x${i}`, type: "f32" }));
    store.configure("p", items, 0);
    const bytes = (await fs.stat(file)).size;
    const start = performance.now();
    await store.archiveProgress({ dataPath: file, bytes });
    const buildMs = performance.now() - start;
    const queries = [];
    for (const [label, range] of [
        ["full", { min: 1, max: hours * 3600000 }],
        ["old10s", { min: 600001, max: 610001 }],
        ["old10min", { min: 600001, max: 1200001 }]
    ]) {
        store.archive.stats.rawBytes = 0;
        store.archive.stats.bucketsTouched = 0;
        const before = performance.now();
        const result = await store.archiveViewport(
            "p",
            items.map((i) => i.name),
            range,
            1200
        );
        queries.push({
            label,
            ms: +(performance.now() - before).toFixed(2),
            rawMiB: +(store.archive.stats.rawBytes / 1048576).toFixed(3),
            buckets: store.archive.stats.bucketsTouched,
            points: result.series.reduce((n, s) => n + s.arr.length, 0)
        });
    }
    return {
        channels,
        hours,
        archiveMiB: +(bytes / 1048576).toFixed(2),
        buildMs: +buildMs.toFixed(1),
        buildMBps: +(bytes / 1000 / buildMs).toFixed(2),
        indexMiB: +(store.archive.bytes / 1048576).toFixed(3),
        cacheMiB: +(store.archive.cacheBytes / 1048576).toFixed(3),
        workerRssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1),
        workerHeapUsedMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2),
        workerArrayBuffersMiB: +(process.memoryUsage().arrayBuffers / 1048576).toFixed(2),
        queries
    };
}

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "long-history-bench-"));
    try {
        for (const channels of [1, 10])
            for (const hours of [2, 8]) {
                const file = path.join(dir, "samples.bin");
                await createArchive(file, channels, hours);
                console.log(
                    JSON.stringify(
                        await new Promise((resolve, reject) => {
                            const worker = new Worker(__filename, { workerData: { file, channels, hours } });
                            worker.once("message", resolve);
                            worker.once("error", reject);
                            worker.once("exit", (code) => {
                                if (code) reject(new Error(`Benchmark Worker exited (${code})`));
                            });
                        })
                    )
                );
            }
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

if (isMainThread)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
else
    measure(workerData)
        .then((result) => parentPort.postMessage(result))
        .catch((error) => {
            throw error;
        });
