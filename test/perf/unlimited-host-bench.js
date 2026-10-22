"use strict";

// Opt-in audit, not a test-suite entry point. Estimates how many sampling batches per second the
// extension host can consume in unlimited mode before worker flow control ("limitedBy: host") engages.
// node test/perf/unlimited-host-bench.js [--seconds 2]
// Measures the per-batch main-thread work of _handleRawSamples for one waveform panel: consumer and
// history decoding, archive row encoding, and the structured clone used by worker messages. The chart
// history store runs in its own Worker and is reported separately.
const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const elfSymbols = require("../../src/elfSymbols");
const { LiveWatchService } = require("../../src/services/liveWatchService");
const { SamplingArchive } = require("../../src/services/samplingArchive");
const { ArchiveEncoder, FILE_HEADER } = require("../../src/services/samplingArchiveFormat");
const { ChartHistoryStore } = require("../../src/services/chartHistoryStore");

const secondsArg = process.argv.indexOf("--seconds");
const SECONDS = secondsArg > 0 ? Math.max(0.5, Number(process.argv[secondsArg + 1]) || 2) : 2;

function makeBatch(channels, t) {
    const samples = [];
    for (let c = 0; c < channels; c++) {
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setFloat32(0, Math.sin((t + c) / 50), true);
        samples.push({ name: "ch" + c, bytes, t });
    }
    return samples;
}

function measure(label, durationMs, fn) {
    for (let i = 0; i < 2000; i++) fn(i);
    let iterations = 0;
    const start = process.hrtime.bigint();
    const deadline = start + BigInt(Math.round(durationMs * 1e6));
    while (process.hrtime.bigint() < deadline) fn(2000 + iterations++);
    const elapsedUs = Number(process.hrtime.bigint() - start) / 1000;
    return { label, usPerBatch: elapsedUs / iterations, batchesPerSecond: (iterations * 1e6) / elapsedUs };
}

function legacyEncodeRow({ t, scope, values }) {
    return Buffer.from(
        `${JSON.stringify({ t, v: Object.fromEntries(values.map(({ key, text }) => [key, text])), scope })}\n`
    );
}

function measureArchive(channels) {
    const encoder = new ArchiveEncoder();
    const batches = Array.from({ length: 1024 }, (_, i) => ({
        t: 1700000000000 + i * 5,
        scope: "bench",
        values: Array.from({ length: channels }, (_, c) => ({
            key: `ch${c} [f32]`,
            text: String(Math.fround(Math.sin((i + c) / 50)))
        }))
    }));
    let oldBytes = 0,
        newBytes = FILE_HEADER.length;
    const count = 10000;
    for (let i = 0; i < count; i++) {
        const row = batches[i % batches.length];
        oldBytes += legacyEncodeRow(row).length;
        newBytes += encoder.encodeRow(row).length;
    }
    const oldCost = measure("NDJSON encoder", SECONDS * 1000, (i) => legacyEncodeRow(batches[i % batches.length]));
    const newCost = measure("binary encoder", SECONDS * 1000, (i) => encoder.encodeRow(batches[i % batches.length]));
    return { oldBytes: oldBytes / count, newBytes: newBytes / count, oldCost, newCost };
}

async function run() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-unlimited-bench-"));
    const rows = [];
    try {
        for (const channels of [1, 3, 10]) {
            const service = new LiveWatchService(elfSymbols);
            const types = new Map(Array.from({ length: channels }, (_, c) => ["ch" + c, "f32"]));
            const items = Array.from({ length: channels }, (_, c) => ({
                name: "ch" + c,
                type: "f32",
                address: 0x20000000 + c * 4,
                size: 4
            }));
            const latest = new Map();
            const archive = new SamplingArchive({ rootDir: path.join(rootDir, String(channels)) });
            await archive.ready;
            const host = measure("host", SECONDS * 1000, (i) => {
                const t = 1e6 + i;
                const raw = makeBatch(channels, t);
                // Worker → host message clone.
                v8.deserialize(v8.serialize({ samples: raw, t }));
                const decoded = service.decodeConsumerSamples(raw, t, types, new Map(), latest);
                const recorded = service.decodeHistorySamples(raw, t, items, decoded.scalarSamples);
                archive.append(
                    recorded.map((sample) => ({ ...sample, name: `${sample.name} [f32]` })),
                    t,
                    "bench"
                );
                // Avoid measuring disk throughput: the archive drains asynchronously in production too.
                archive.queue.length = 0;
                archive.queuedBytes = 0;
            });
            await archive.dispose();
            const store = new ChartHistoryStore();
            store.configure(
                "bench",
                items.map((item) => ({ name: item.name, type: item.type }))
            );
            const history = measure("history", SECONDS * 1000, (i) => {
                const t = 1e6 + i;
                store.append(
                    "bench",
                    items.map((item, c) => ({ name: item.name, value: Math.sin((t + c) / 50), t })),
                    t
                );
            });
            if (store.status("bench").variables.length !== channels) throw new Error("history store rejected samples");
            rows.push({ channels, host, history, archive: measureArchive(channels) });
        }
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
    console.log(`Node ${process.version} ${os.cpus()[0]?.model || os.arch()} (${SECONDS}s per measurement)`);
    console.log("| channels | host µs/batch | host max batches/s | history worker µs/batch | history max batches/s |");
    console.log("| -------: | ------------: | -----------------: | ----------------------: | --------------------: |");
    for (const { channels, host, history } of rows)
        console.log(
            `| ${channels} | ${host.usPerBatch.toFixed(1)} | ${Math.round(host.batchesPerSecond)} | ` +
                `${history.usPerBatch.toFixed(1)} | ${Math.round(history.batchesPerSecond)} |`
        );
    console.log(
        "Archive: f32 text, 13-digit timestamps, bench scope, no identities; header/definitions amortized over 10000 rows."
    );
    console.log("Encoder costs use prebuilt rows and exclude sampling decode, disk I/O and Worker transport.");
    console.log("| channels | NDJSON bytes/row | binary bytes/row | reduction | NDJSON µs/row | binary µs/row |");
    console.log("| -------: | ---------------: | ---------------: | --------: | ------------: | ------------: |");
    for (const { channels, archive: a } of rows)
        console.log(
            `| ${channels} | ${a.oldBytes.toFixed(2)} | ${a.newBytes.toFixed(2)} | ` +
                `${(a.oldBytes / a.newBytes).toFixed(2)}× | ${a.oldCost.usPerBatch.toFixed(2)} | ${a.newCost.usPerBatch.toFixed(2)} |`
        );
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
