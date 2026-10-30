"use strict";

const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { ArchiveEncoder, FILE_HEADER, decodeRecords } = require("../src/services/samplingArchiveFormat");
const { SamplingArchive } = require("../src/services/samplingArchive");
const { ArchiveHistoryIndex } = require("../src/services/archiveHistoryIndex");
const { ArchiveChartHistoryStore } = require("../src/services/archiveChartHistoryStore");
const { ChartHistoryStore, WINDOW_MS, MAX_POINTS } = require("../src/services/chartHistoryStore");
const { ChartHistoryService } = require("../src/services/chartHistoryService");
const { decodeViewport } = require("../src/webview/liveWatch/chartTransport");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

const item = { name: "x", type: "u64", address: 0x20000000 };
const identity = JSON.stringify([item.type, item.address, null, null]);
const flat = (reply) => reply.series.flatMap((s) => s.arr);

async function fastPaths(dir) {
    const encoder = new ArchiveEncoder(),
        records = [FILE_HEADER],
        items = [
            { name: "a", type: "f32" },
            { name: "b", type: "u64" },
            { name: "c", type: "f64" }
        ],
        reference = new ChartHistoryStore(),
        store = new ArchiveChartHistoryStore({ archive: { bucketSize: 4 } });
    reference.configure("numeric", items);
    store.configure("numeric", items, 0);
    for (let i = 0; i < 4103; i++) {
        const t = 1 + Math.floor(i / 2) * 5,
            texts = [String((i % 17) - 8), String(18446744073709550000n + BigInt(i % 19)), String(Math.sin(i))];
        records.push(
            encoder.encodeRow({
                scope: "numeric",
                t,
                values: texts.map((text, c) => ({
                    key: `${items[c].name} [${items[c].type}]`,
                    text
                }))
            })
        );
        reference.append(
            "numeric",
            texts.map((text, c) => ({ name: items[c].name, t, value: Number(text), valueText: text })),
            t
        );
    }
    const buffer = Buffer.concat(records),
        dataPath = path.join(dir, "numeric.bin"),
        decoded = decodeRecords(buffer).rows;
    await fs.writeFile(dataPath, buffer);
    // Publish many partial children, then cross two parent boundaries in a single scan.
    for (const bytes of [17, 511, 1901, 5999, buffer.length]) await store.archiveProgress({ dataPath, bytes });
    for (const item of items) {
        const key = `${item.name} [${item.type}]`,
            series = store.archive.find("numeric", 0, key, "")[0];
        for (const level of series.levels) {
            for (let i = 0; i < level.length; i++) {
                const rows = decoded.slice(i * level.size, (i + 1) * level.size);
                let min = 0,
                    max = 0;
                const cmp = (a, b) =>
                    item.type === "u64"
                        ? BigInt(a.v[key]) < BigInt(b.v[key])
                            ? -1
                            : BigInt(a.v[key]) > BigInt(b.v[key])
                              ? 1
                              : 0
                        : Number(a.v[key]) - Number(b.v[key]);
                for (let j = 1; j < rows.length; j++) {
                    if (cmp(rows[j], rows[min]) < 0) min = j;
                    if (cmp(rows[j], rows[max]) > 0) max = j;
                }
                const expected = [...new Set([0, min, max, rows.length - 1])]
                    .sort((a, b) => a - b)
                    .map((j) => {
                        const text = rows[j].v[key],
                            v = Number(text);
                        return { t: rows[j].t, v, valueText: String(v) === text ? null : text };
                    });
                assert.deepStrictEqual(level.points(i), expected, `cascade ${key}/${level.size}/${i}`);
                assert.strictEqual(level.get(i)[12], rows.length);
                assert.strictEqual(level.get(i)[10], rows[0].offset);
                assert.strictEqual(level.get(i)[11], rows.at(-1).end);
            }
        }
    }
    for (let i = 0; i < 18; i++) {
        const range = { min: 5.5 + i * 509, max: 47.25 + i * 509 };
        assert.deepStrictEqual(
            (
                await store.archiveViewport(
                    "numeric",
                    items.map((item) => item.name),
                    range,
                    512 + i
                )
            ).series,
            reference.viewport(
                "numeric",
                items.map((item) => item.name),
                range,
                512 + i
            ).series
        );
    }
    // Wide enough that one power-of-two column holds every sample.
    const range = { min: 0, max: 2 * decoded.at(-1).t + 10 },
        names = items.map((item) => item.name);
    const before = store.archive.stats.rawBytes;
    assert.deepStrictEqual(
        (await store.archiveViewport("numeric", names, range, 1)).series,
        reference.viewport("numeric", names, range, 1).series
    );
    assert.strictEqual(store.archive.stats.rawBytes, before, "numeric aggregation reads bucket fields only");
    const frozen = store.freeze("numeric");
    store.archive.rawMaxBytes = 0;
    const captured = await store.archiveViewport("numeric", names, range, 25, frozen.snapshotId);
    await fs.appendFile(
        dataPath,
        encoder.encodeRow({ scope: "numeric", t: decoded.at(-1).t, values: [{ key: "a [f32]", text: "999999" }] })
    );
    await store.archiveProgress({ dataPath, bytes: (await fs.stat(dataPath)).size });
    assert.deepStrictEqual(
        (await store.archiveViewport("numeric", names, range, 25, frozen.snapshotId)).series,
        captured.series,
        "numeric snapshot tails stay immutable with raw reads disabled"
    );
    store.release(frozen.snapshotId);
    store.archive.rawMaxBytes = 16 * 1024 * 1024;
    // Exercise weights when reduced archive columns join a continuous memory suffix.
    for (const row of decoded.slice(-101))
        store.append(
            "numeric",
            items.map((item) => {
                const text = row.v[`${item.name} [${item.type}]`];
                return { name: item.name, t: row.t, value: Number(text), valueText: text };
            }),
            row.t
        );
    const seamRange = { min: decoded.at(-120).t + 0.25, max: decoded.at(-90).t + 0.5 };
    assert.deepStrictEqual(
        (await store.archiveViewport("numeric", names, seamRange, 800)).series,
        reference.viewport("numeric", names, seamRange, 800).series
    );

    const duplicates = new ArchiveEncoder(),
        duplicatePath = path.join(dir, "duplicates.bin");
    const duplicateData = Buffer.concat([
        FILE_HEADER,
        duplicates.encodeRow({
            scope: "p",
            t: 1,
            values: [
                { key: "x [f32]", text: "1", identity: "old" },
                { key: "x [f32]", text: "2" },
                { key: "x [f32]", text: "3" }
            ]
        })
    ]);
    await fs.writeFile(duplicatePath, duplicateData);
    const duplicateStore = new ArchiveChartHistoryStore({ archive: { bucketSize: 4 } });
    duplicateStore.configure("p", [{ name: "x", type: "f32" }], 0);
    await duplicateStore.archiveProgress({ dataPath: duplicatePath, bytes: duplicateData.length });
    assert.strictEqual(duplicateStore.archive.series.size, 1, "only the final duplicate key enters the index");
    assert.strictEqual(duplicateStore.archive.find("p", 0, "x [f32]", "")[0].count, 1);
    assert.deepStrictEqual(flat(await duplicateStore.archiveViewport("p", ["x"], { min: 0, max: 2 }, 800)), [
        { t: 1, v: 3, valueText: null }
    ]);
    assert.deepStrictEqual(
        await duplicateStore.archive.raw(16, duplicateData.length, duplicateStore.archive.dictionary, {
            scope: "p",
            generation: 0,
            key: "x [f32]",
            identity: "old"
        }),
        [],
        "a fixed layout still applies the final duplicate key's identity"
    );
    // The wire format permits multiple dictionary IDs for the same key and identity.
    const key = Buffer.from("x [f32]"),
        definition = Buffer.alloc(15 + key.length);
    definition[0] = 2;
    definition.writeUInt32LE(definition.length - 5, 1);
    definition.writeUInt16LE(2, 5);
    definition.writeUInt32LE(key.length, 7);
    key.copy(definition, 11);
    const alias = duplicates.encodeRow({ scope: "p", t: 2, values: [{ key: "x [f32]", text: "4" }] });
    alias.writeUInt16LE(2, 21);
    const empty = [];
    for (let generation = 1; generation < 20; generation++)
        empty.push(duplicates.encodeRow({ scope: "empty", t: 3, generation, values: [] }));
    await fs.appendFile(duplicatePath, Buffer.concat([definition, alias, ...empty]));
    await duplicateStore.archiveProgress({ dataPath: duplicatePath, bytes: (await fs.stat(duplicatePath)).size });
    assert.strictEqual(duplicateStore.archive.series.size, 1);
    assert.strictEqual(duplicateStore.archive.find("p", 0, "x [f32]", "")[0].count, 2);
    assert.strictEqual(duplicateStore.archive.lookup.size, 1, "empty rows allocate no numeric series lookup");
    assert.deepStrictEqual(
        await duplicateStore.archive.raw(16, duplicateData.length, duplicateStore.archive.dictionary),
        decodeRecords(
            Buffer.concat([Buffer.alloc(1), duplicateData.subarray(16)]),
            1,
            duplicateStore.archive.dictionary
        ).rows,
        "unfiltered raw callers retain the decoded-row contract"
    );
    const legacyFilter = {
        scope: "p",
        generation: 0,
        key: "x [f32]",
        identity: "",
        from: -Infinity,
        cut: Infinity,
        offset: Infinity,
        memStart: Infinity
    };
    assert.deepStrictEqual(
        await duplicateStore.archive.query(
            duplicateStore.archive.find("p", 0, "x [f32]", "")[0],
            legacyFilter,
            { min: 0, max: 3 },
            800,
            { bytes: 0 }
        ),
        [
            { t: 1, v: 3, valueText: null },
            { t: 2, v: 4, valueText: null }
        ],
        "direct queries retain their point-array contract unless column reduction is requested"
    );
    assert.deepStrictEqual(flat(await duplicateStore.archiveViewport("p", ["x"], { min: 0, max: 3 }, 800)), [
        { t: 1, v: 3, valueText: null },
        { t: 2, v: 4, valueText: null }
    ]);
    duplicateStore.archive.generations.set("p", 1);
    duplicateStore.archive.maxBytes = 1;
    duplicateStore.archive._budget();
    assert.strictEqual(duplicateStore.archive.lookup.size, 0, "compaction releases numeric aliases too");

    // P2b's coarse mixed-identity result: a clean fallback must retain all representatives
    // until it has been merged with the explicit identity's conservative gap markers.
    const mixedEncoder = new ArchiveEncoder(),
        mixedRecords = [FILE_HEADER],
        mixedPath = path.join(dir, "mixed.bin"),
        mixedItem = { name: "x", type: "f32", address: 4 };
    for (let i = 0; i < 100; i++)
        mixedRecords.push(
            mixedEncoder.encodeRow({
                scope: "p",
                t: i * 5 + 1,
                values: [
                    {
                        key: "x [f32]",
                        identity: i % 3 === 0 ? JSON.stringify(["f32", 4, null, null]) : "",
                        text: i % 33 === 0 ? null : String((i * 7) % 29)
                    }
                ]
            })
        );
    const mixedData = Buffer.concat(mixedRecords),
        mixedStore = new ArchiveChartHistoryStore({ archive: { bucketSize: 4, rawMaxBytes: 0 } });
    await fs.writeFile(mixedPath, mixedData);
    mixedStore.configure("p", [mixedItem], 0);
    await mixedStore.archiveProgress({ dataPath: mixedPath, bytes: mixedData.length });
    const mixed = await mixedStore.archiveViewport("p", ["x"], { min: 0, max: 600 }, 2);
    assert.deepStrictEqual(
        mixed.series.map((s) => [s.visibleCount, s.arr.map((p) => [p.t, p.v])]),
        [
            [
                5,
                [
                    [6, 7],
                    [16, 21]
                ]
            ],
            [
                5,
                [
                    [21, 28],
                    [46, 5]
                ]
            ],
            [
                12,
                [
                    [51, 12],
                    [61, 26],
                    [106, 2],
                    [116, 16]
                ]
            ],
            [1, [[121, 23]]],
            [
                5,
                [
                    [126, 1],
                    [141, 22],
                    [146, 0],
                    [151, 7]
                ]
            ],
            [
                4,
                [
                    [156, 14],
                    [161, 21]
                ]
            ],
            [
                24,
                [
                    [171, 6],
                    [186, 27],
                    [251, 2],
                    [266, 23],
                    [291, 0],
                    [296, 7]
                ]
            ],
            [1, [[301, 14]]],
            [
                5,
                [
                    [306, 21],
                    [311, 28],
                    [316, 6]
                ]
            ],
            [
                5,
                [
                    [321, 13],
                    [326, 20],
                    [336, 5],
                    [346, 19]
                ]
            ],
            [
                24,
                [
                    [351, 26],
                    [436, 0],
                    [456, 28],
                    [476, 27]
                ]
            ],
            [1, [[481, 5]]],
            [
                2,
                [
                    [486, 12],
                    [491, 19]
                ]
            ]
        ]
    );
    const uniformEncoder = new ArchiveEncoder(),
        uniformRecords = [FILE_HEADER],
        uniformPath = path.join(dir, "uniform.bin"),
        uniformItems = [
            { name: "x", type: "f32" },
            { name: "y", type: "f32" }
        ],
        uniformStore = new ArchiveChartHistoryStore({ archive: { bucketSize: 4 } }),
        uniformReference = new ChartHistoryStore();
    uniformStore.configure("p", uniformItems, 0);
    uniformReference.configure("p", uniformItems);
    for (let i = 0; i < 32; i++) {
        const texts = i % 2 ? ["1.5", "3"] : ["2", "2.5"];
        uniformRecords.push(
            uniformEncoder.encodeRow({
                scope: "p",
                t: i * 5 + 1,
                values: texts.map((text, c) => ({ key: `${uniformItems[c].name} [f32]`, text }))
            })
        );
        uniformReference.append(
            "p",
            texts.map((text, c) => ({ name: uniformItems[c].name, value: Number(text) })),
            i * 5 + 1
        );
    }
    const uniformData = Buffer.concat(uniformRecords),
        uniformRange = { min: 10, max: 70 };
    await fs.writeFile(uniformPath, uniformData);
    await uniformStore.archiveProgress({ dataPath: uniformPath, bytes: uniformData.length });
    assert.deepStrictEqual(
        (await uniformStore.archiveViewport("p", ["x", "y"], uniformRange, 800)).series,
        uniformReference.viewport("p", ["x", "y"], uniformRange, 800).series
    );
    assert.ok(
        [...uniformStore.archive.cache.values()].every((entry) => entry.layout),
        "validated fixed offsets avoid scanning other channels' entries"
    );
    for (const entry of uniformStore.archive.cache.values())
        assert.ok(
            entry.bytes >= entry.buffer.buffer.byteLength + entry.offsets.byteLength,
            "cache accounting includes complete retained backing allocations"
        );
}

async function main() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-lod-"));
    const archive = new SamplingArchive({
        rootDir: path.join(dir, "archive"),
        onWritten: (bytes) => writes.push(bytes)
    });
    const writes = [];
    try {
        await fastPaths(dir);
        const encoder = new ArchiveEncoder();
        const records = [FILE_HEADER];
        const reference = new ChartHistoryStore();
        reference.configure("p", [item]);
        const samples = [];
        for (let i = 0; i < 900; i++) {
            const text = i === 31 || i === 80 ? null : String(18446744073709550000n + BigInt(i % 17));
            const t = i * 10 + 100;
            const sample = { name: "x", t, value: text === null ? null : Number(text), valueText: text };
            samples.push(sample);
            reference.append("p", [sample], t);
            records.push(
                encoder.encodeRow({ scope: "p", t, generation: 0, values: [{ key: "x [u64]", text, identity }] })
            );
            if (i % 3 === 0)
                records.push(
                    encoder.encodeRow({
                        scope: "other",
                        t,
                        generation: 9,
                        values: [{ key: "x [u64]", text: "7", identity: "changed" }]
                    })
                );
        }
        records.push(
            encoder.encodeRow({ scope: "p", generation: 1, t: 50, values: [{ key: "x [u64]", text: "7", identity }] })
        );
        records.push(
            encoder.encodeRow({
                scope: "p",
                generation: 0,
                t: 9999,
                values: [{ key: "x [u64]", text: "8", identity: "changed" }]
            })
        );
        const buffer = Buffer.concat(records);
        const dataPath = path.join(dir, "samples.bin");
        await fs.writeFile(dataPath, buffer);
        const store = new ArchiveChartHistoryStore({ archive: { bucketSize: 4 } });
        store.configure("p", [item], 0);
        // Re-read incomplete records at arbitrary durable byte cuts, including a split file header.
        for (let bytes = 1; bytes < buffer.length; bytes += 397) await store.archiveProgress({ dataPath, bytes });
        await store.archiveProgress({ dataPath, bytes: buffer.length });
        assert.strictEqual(store.archive.indexedOffset, buffer.length);
        // Compare the complete raw path on many column grids, including exact u64 ties and gaps.
        let seed = 1234;
        for (let i = 0; i < 24; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const min = 100 + (seed % 8000),
                range = { min, max: min + 1 + (seed % 600) };
            const width = 512 + (seed % 1000);
            assert.deepStrictEqual(
                (await store.archiveViewport("p", ["x"], range, width)).series,
                reference.viewport("p", ["x"], range, width).series
            );
        }
        const restarted = new ArchiveHistoryIndex({ bucketSize: 4 });
        await restarted.progress({ dataPath, bytes: buffer.length });
        assert.strictEqual(restarted.series.size, 4);
        assert.strictEqual(restarted.find("p", 0, "x [u64]", identity)[0].count, 900);
        assert.deepStrictEqual(store.status("p").bounds, { min: 100, max: 9090 });
        for (const range of [
            { min: 110, max: 150 },
            { min: 385, max: 995 },
            { min: 421, max: 455 },
            { min: 405, max: 415 },
            { min: 95, max: 9500 }
        ]) {
            const actual = await store.archiveViewport("p", ["x"], range, 2048);
            const expected = reference.viewport("p", ["x"], range, 2048);
            assert.deepStrictEqual(actual.series, expected.series, `raw equivalence ${JSON.stringify(range)}`);
        }
        assert.ok(store.archive.cacheBytes > 0);
        assert.ok(store.archive.cacheBytes <= store.archive.cacheMaxBytes);
        const cachedBytes = store.archive.stats.rawBytes;
        await store.archiveViewport("p", ["x"], { min: 95, max: 9500 }, 2048);
        assert.strictEqual(store.archive.stats.rawBytes, cachedBytes, "decoded ranges use bounded LRU");
        store.archive.cache.clear();
        store.archive.cacheBytes = 0;
        const concurrent = await Promise.all([
            store.archiveViewport("p", ["x"], { min: 385, max: 995 }, 800),
            store.archiveViewport("p", ["x"], { min: 385, max: 995 }, 800)
        ]);
        assert.deepStrictEqual(concurrent[0], concurrent[1]);
        assert.strictEqual(
            store.archive.cacheBytes,
            [...store.archive.cache.values()].reduce((n, entry) => n + entry.bytes, 0)
        );

        // A recent contiguous run seamlessly replaces the corresponding archive suffix.
        for (const sample of samples.slice(600)) store.append("p", [sample], sample.t);
        const rawBeforeRecent = store.archive.stats.rawBytes;
        await store.archiveViewport("p", ["x"], { min: 7000, max: 8000 }, 800);
        assert.strictEqual(store.archive.stats.rawBytes, rawBeforeRecent, "recent continuous range stays in memory");
        assert.deepStrictEqual(
            (await store.archiveViewport("p", ["x"], { min: 5900, max: 6300 }, 800)).series,
            reference.viewport("p", ["x"], { min: 5900, max: 6300 }, 800).series
        );
        store.markLimited("p", 9090);
        assert.strictEqual(store.status("p").limited, false, "archive covers memory gaps");
        assert.strictEqual(
            store.append("p", [], 9090).limited,
            false,
            "append replies do not warn on archive-covered gaps"
        );
        assert.deepStrictEqual(
            (await store.archiveViewport("p", ["x"], { min: 5900, max: 6300 }, 800)).series,
            reference.viewport("p", ["x"], { min: 5900, max: 6300 }, 800).series
        );
        store.configure("p", [{ ...item, address: 4 }], 0);
        assert.strictEqual(store.status("p").bounds, null, "identity change hides older identity");
        store.configure("p", [{ ...item, historyFromMs: 6000 }], 0);
        assert.strictEqual(store.status("p").bounds.min, 6000);
        assert.ok(
            flat(await store.archiveViewport("p", ["x"], { min: 5000, max: 6500 }, 800)).every((p) => p.t >= 6000)
        );
        store.configure("p", [{ ...item, historyFromMs: 6005 }], 0);
        await store.resolveBounds("p");
        assert.strictEqual(store.status("p").bounds.min, 6010, "bounds start at an actual filtered sample");
        store.configure("p", [item], 1);
        assert.strictEqual(store.status("p").bounds.min, 50, "only the configured generation is visible");
        store.clear("p", 2);
        assert.strictEqual(store.status("p").bounds, null);
        store.configure("p", [item], 0);

        const snapshot = store.freeze("p");
        const later = encoder.encodeRow({
            scope: "p",
            generation: 0,
            t: 10000,
            values: [{ key: "x [u64]", text: "123", identity }]
        });
        await fs.appendFile(dataPath, later);
        await store.archiveProgress({ dataPath, bytes: buffer.length + later.length });
        assert.strictEqual(store.status("p").bounds.max, 10000);
        assert.strictEqual(store.status("p", snapshot.snapshotId).bounds.max, 9090);
        assert.ok(
            flat(await store.archiveViewport("p", ["x"], { min: 8000, max: 11000 }, 800, snapshot.snapshotId)).every(
                (p) => p.t <= 9090
            )
        );
        // Lifecycle mutation while a disk read is pending must reject, never mix generations.
        store.archive.cache.clear();
        store.archive.cacheBytes = 0;
        const raw = store.archive.raw.bind(store.archive);
        let resume, entered;
        const reading = new Promise((resolve) => {
            entered = resolve;
        });
        store.archive.raw = async (...args) => {
            entered();
            await new Promise((resolve) => {
                resume = resolve;
            });
            return raw(...args);
        };
        const pending = store.archiveViewport("p", ["x"], { min: 111, max: 155 }, 800);
        await reading;
        store.clear("p", 1);
        resume();
        await assert.rejects(pending, { code: "CHART_HISTORY_RESTORE_CANCELLED" });
        store.archive.raw = raw;
        // Check all other invalidation paths, including snapshot release during I/O.
        for (const mutation of ["configure", "remove", "release"]) {
            store.configure("p", [item], 0);
            const frozen = mutation === "release" ? store.freeze("p").snapshotId : undefined;
            store.archive.cache.clear();
            store.archive.cacheBytes = 0;
            let unblock, began;
            const started = new Promise((resolve) => {
                began = resolve;
            });
            store.archive.raw = async (...args) => {
                began();
                await new Promise((resolve) => {
                    unblock = resolve;
                });
                return raw(...args);
            };
            const task = store.archiveViewport("p", ["x"], { min: 111, max: 155 }, 800, frozen);
            await started;
            if (mutation === "configure") store.configure("p", [{ ...item, address: 4 }], 0);
            else if (mutation === "remove") store.remove("p");
            else store.release(frozen);
            unblock();
            await assert.rejects(task, {
                code: mutation === "release" ? "CHART_SNAPSHOT_STALE" : "CHART_HISTORY_RESTORE_CANCELLED"
            });
            store.archive.raw = raw;
        }
        store.configure("p", [item], 0);
        store.remove("p");
        assert.strictEqual(store.archive.generations.get("p"), 0, "remove does not invent an archive clear");
        store.configure("p", [item], 0);
        const capBytes = store.archive.stats.rawBytes;
        store.archive.rawMaxBytes = 0;
        assert.ok(flat(await store.archiveViewport("p", ["x"], { min: 385, max: 995 }, 800)).length > 0);
        assert.strictEqual(store.archive.stats.rawBytes, capBytes, "raw cap falls back with L0 still available");
        store.archive.rawMaxBytes = 16 * 1024 * 1024;
        const unorderedPath = path.join(dir, "unordered.bin"),
            unorderedEncoder = new ArchiveEncoder();
        const unordered = [FILE_HEADER];
        for (const [t, text] of [
            [100, "1"],
            [400, "2"],
            [200, "3"],
            [201, null],
            [202, "4"],
            [600, "5"]
        ])
            unordered.push(unorderedEncoder.encodeRow({ scope: "p", t, values: [{ key: "x [f32]", text }] }));
        const unorderedData = Buffer.concat(unordered);
        await fs.writeFile(unorderedPath, unorderedData);
        const disordered = new ArchiveChartHistoryStore({ archive: { bucketSize: 4 } });
        disordered.configure("p", [{ name: "x", type: "f32" }], 0);
        await disordered.archiveProgress({ dataPath: unorderedPath, bytes: unorderedData.length });
        const disorderReply = await disordered.archiveViewport("p", ["x"], { min: 199, max: 203 }, 800);
        assert.deepStrictEqual(
            flat(disorderReply)
                .filter((p) => p.t >= 199 && p.t <= 203)
                .map((p) => p.v),
            [3, 4],
            "a late round after an out-of-range round remains visible"
        );
        assert.ok(disorderReply.series.length >= 2, "missing/disordered rounds never join falsely");
        await assert.rejects(store.archiveViewport("p", ["x"], { min: NaN, max: 1 }, 10), {
            code: "CHART_VIEW_INVALID"
        });
        await assert.rejects(store.archiveViewport("p", ["x"], { min: 0, max: 1 }, 10, snapshot.snapshotId), {
            code: "CHART_SNAPSHOT_STALE"
        });

        // Real archive: old points survive time retention and MAX_POINTS at high rates.
        const live = new ArchiveChartHistoryStore({ archive: { bucketSize: 16 } });
        live.configure("p", [{ name: "x", type: "f32" }], 0);
        archive.append([{ name: "x [f32]", value: 1 }], 100, "p");
        archive.append([{ name: "x [f32]", value: 2 }], WINDOW_MS + 200, "p");
        const source = await archive.historySource("p");
        assert.ok(writes.includes(source.cutoff));
        await live.archiveProgress({ dataPath: source.dataPath, bytes: source.cutoff });
        live.append("p", [{ name: "x", value: 2 }], WINDOW_MS + 200);
        assert.strictEqual(flat(await live.archiveViewport("p", ["x"], { min: 99, max: 101 }, 800))[0].v, 1);
        assert.strictEqual(live.status("p").bounds.min, 100);
        const highPath = path.join(dir, "high.bin"),
            highEncoder = new ArchiveEncoder();
        const high = [FILE_HEADER];
        for (let i = 0; i < MAX_POINTS + 2; i++) {
            high.push(
                highEncoder.encodeRow({ scope: "p", t: i / 2 + 1, values: [{ key: "x [f32]", text: String(i) }] })
            );
            live.append("p", [{ name: "x", value: i }], WINDOW_MS + 201 + i / 2);
        }
        assert.strictEqual(live._scope("p").series.get("x").count, MAX_POINTS);
        assert.strictEqual(
            flat(await live.archiveViewport("p", ["x"], { min: 99, max: 101 }, 800))[0].v,
            1,
            "old data remains viewable after the high-rate memory cap"
        );
        await fs.writeFile(highPath, Buffer.concat(high));
        const indexed = new ArchiveChartHistoryStore({ archive: { bucketSize: 16, maxBytes: 64000 } });
        indexed.configure("p", [{ name: "x", type: "f32" }], 0);
        await indexed.archiveProgress({ dataPath: highPath, bytes: (await fs.stat(highPath)).size });
        // The exact same 2 kHz session is archived and memory-capped; only the oldest two rounds are absent in memory.
        const highRate = new ArchiveChartHistoryStore();
        highRate.configure("p", [{ name: "x", type: "f32" }], 0);
        for (let i = 0; i < MAX_POINTS + 2; i += 4096) {
            const batch = Array.from({ length: Math.min(4096, MAX_POINTS + 2 - i) }, (_, j) => ({
                name: "x",
                t: (i + j) / 2 + 1,
                value: i + j
            }));
            highRate.append("p", batch, batch.at(-1).t);
        }
        await highRate.archiveProgress({ dataPath: highPath, bytes: (await fs.stat(highPath)).size });
        assert.strictEqual(highRate._scope("p").series.get("x").count, MAX_POINTS);
        assert.deepStrictEqual(
            flat(await highRate.archiveViewport("p", ["x"], { min: 1, max: 3 }, 800)).map((p) => p.v),
            [0, 1, 2, 3, 4, 5],
            "old high-rate points join their retained memory neighbours"
        );
        assert.ok(indexed.archive.find("p", 0, "x [f32]", "")[0].levels[0].start > 0);
        assert.ok(indexed.status("p").indexBytes <= indexed.archive.maxBytes);
        indexed.archive.stats.bucketsTouched = 0;
        indexed.archive.stats.rawBytes = 0;
        const overview = await indexed.archiveViewport("p", ["x"], { min: 1, max: (MAX_POINTS + 1) / 2 + 1 }, 100);
        assert.ok(flat(overview).length > 0);
        assert.strictEqual(indexed.archive.stats.rawBytes, 0, "overview uses summaries");
        assert.ok(indexed.archive.stats.bucketsTouched < 100 * 64);
        assert.ok(indexed.archive.stats.level >= 1, "higher-level summaries supply the wide view");
        indexed.archive.rawMaxBytes = 0;
        assert.ok(flat(await indexed.archiveViewport("p", ["x"], { min: 200, max: 201 }, 800)).length > 0);
        assert.strictEqual(indexed.status("p").limited, false);
        const tight = new ArchiveChartHistoryStore({ archive: { bucketSize: 4, maxBytes: 3000 } });
        tight.configure("p", [item], 0);
        await tight.archiveProgress({ dataPath, bytes: buffer.length + later.length });
        assert.ok(tight.archive.bytes <= tight.archive.maxBytes, "partial tails can degrade under tight budgets");
        assert.strictEqual(tight.status("p").bounds.min, 100);
        assert.ok(flat(await tight.archiveViewport("p", ["x"], { min: 400, max: 800 }, 800)).length > 0);
        const coarseSnapshot = indexed.freeze("p");
        // Captured partial summaries must survive later appends even with raw reads disabled.
        const changed = highEncoder.encodeRow({
            scope: "p",
            t: (MAX_POINTS + 1) / 2 + 1,
            values: [{ key: "x [f32]", text: "999999" }]
        });
        await fs.appendFile(highPath, changed);
        await indexed.archiveProgress({ dataPath: highPath, bytes: (await fs.stat(highPath)).size });
        const frozenReply = await indexed.archiveViewport(
            "p",
            ["x"],
            { min: MAX_POINTS / 2 - 100, max: MAX_POINTS / 2 + 10 },
            800,
            coarseSnapshot.snapshotId
        );
        assert.ok(
            flat(frozenReply).every((p) => p.v !== 999999),
            "byte cut also excludes later equal-time samples"
        );
        indexed.release(coarseSnapshot.snapshotId);
        const indexBytes = indexed.archive.bytes;
        await indexed.archiveProgress({ dataPath: highPath, bytes: (await fs.stat(highPath)).size, limited: true });
        assert.strictEqual(indexed.status("p").limited, true, "archive failure/full is a viewing limit");
        assert.strictEqual(indexed.archive.bytes, indexBytes);
        const generationsPath = path.join(dir, "generations.bin"),
            generationsEncoder = new ArchiveEncoder();
        const generations = [FILE_HEADER];
        for (let generation = 0; generation < 200; generation++)
            generations.push(
                generationsEncoder.encodeRow({
                    scope: "p",
                    generation,
                    t: generation + 1,
                    values: [{ key: "x [f32]", text: String(generation) }]
                })
            );
        const generationsData = Buffer.concat(generations);
        await fs.writeFile(generationsPath, generationsData);
        const manyClears = new ArchiveChartHistoryStore();
        manyClears.configure("p", [{ name: "x", type: "f32" }], 0);
        await manyClears.archiveProgress({ dataPath: generationsPath, bytes: generationsData.length });
        const pinned = manyClears.freeze("p", "export");
        manyClears.configure("p", [{ name: "x", type: "f32" }], 199);
        manyClears.archive.maxBytes = 4096;
        manyClears.archive._budget();
        assert.ok(manyClears.archive.bytes <= 4096, "obsolete generations cannot accumulate beyond the budget");
        assert.strictEqual(manyClears.status("p").bounds.min, 200);
        assert.strictEqual(
            flat(await manyClears.archiveViewport("p", ["x"], { min: 0, max: 2 }, 800, pinned.snapshotId))[0].v,
            0,
            "snapshot pins survive obsolete-generation compaction"
        );
        manyClears.release(pinned.snapshotId);
        assert.strictEqual(manyClears.archive.pins.size, 0);

        const service = new ChartHistoryService();
        try {
            service.archiveProgress({ dataPath: source.dataPath, bytes: source.cutoff });
            await service.request("configure", ["p", [{ name: "x", type: "f32" }], 0]);
            const reply = await service.request("viewport", ["p", ["x"], { min: 99, max: 101 }, 800]);
            const result = { ...reply, series: decodeViewport(reply.series) };
            assert.strictEqual(flat(result)[0].v, 1);
            assert.strictEqual(result.bounds.min, 100);
            await service.restart();
            await service.request("configure", ["p", [{ name: "x", type: "f32" }], 0]);
            const afterRestart = await service.request("viewport", ["p", ["x"], { min: 99, max: 101 }, 800]);
            assert.strictEqual(decodeViewport(afterRestart.series)[0].arr[0].v, 1);
            service.archiveProgress({ dataPath: source.dataPath, bytes: source.cutoff });
        } finally {
            await service.dispose();
        }

        const page = render(getLiveWatchContent({}, "en"));
        try {
            const w = page.window;
            Object.defineProperties(page.document.getElementById("chart"), {
                clientWidth: { value: 800 },
                clientHeight: { value: 400 }
            });
            page.send({ type: "watchList", items: [{ name: "x", type: "f32" }] });
            page.send({ type: "chartHistoryStatus", ...live.status("p"), historyRevision: w.historyRevision });
            w.syncTimeBounds();
            assert.strictEqual(w.chartState.bounds.min, 100);
            w.applyWindowPreset("0");
            w.chartState.follow = true;
            w.syncTimeBounds();
            assert.ok(w.chartState.x.max - w.chartState.x.min > WINDOW_MS);
            w.refreshChartTimeline();
            const total = Math.round(live.status("p").bounds.max - 100);
            assert.strictEqual(Number(page.document.getElementById("chartFromRange").max), total);
            assert.strictEqual(Number(page.document.getElementById("chartToRange").value), total);
            assert.strictEqual(page.document.getElementById("chartRangeFill").style.width, "100%");
            assert.strictEqual(
                page.document.getElementById("chartAxisEnd").textContent,
                w.formatElapsed(live.status("p").bounds.max - 100)
            );
            w.dirty = true;
            w.chartState.fastDirty = true;
            w.draw(10000);
            const request = w.remoteHistory.inFlight;
            assert.ok(request.range.min <= 100);
            assert.deepStrictEqual(
                JSON.parse(JSON.stringify(w.remoteHistory.target.overviewRange)),
                live.status("p").bounds
            );
            w.remoteHistory.inFlight = null;
            w.remoteHistory.pending = null;
            w.remoteHistory.lastRequest = -Infinity;
            w.dispatchChartViewport();
            assert.strictEqual(w.remoteHistory.inFlight.purpose, "overview");
            assert.deepStrictEqual(JSON.parse(JSON.stringify(w.remoteHistory.inFlight.range)), live.status("p").bounds);
            page.assertHealthy();
        } finally {
            page.close();
        }
        await assert.rejects(restarted.progress({ dataPath: "different", bytes: 1 }), /path changed/);
        await assert.rejects(restarted.progress({ dataPath, bytes: -1 }), /Invalid archive/);
        const notifications = [],
            throttled = new ChartHistoryService();
        throttled.worker = {
            postMessage: (message) => notifications.push(message),
            terminate: async () => 0
        };
        for (let bytes = 0; bytes < 100; bytes++) throttled.archiveProgress({ dataPath, bytes });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.strictEqual(notifications.length, 1);
        assert.strictEqual(notifications[0].args[0].bytes, 99);
        throttled.archiveProgress({ dataPath, bytes: 100 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.strictEqual(notifications.length, 1, "drains coalesce within a 250 ms interval");
        await throttled.dispose();
        console.log(
            "Archive tailing, exact raw viewports, seams, generations, snapshots, cancellation, LOD and Worker passed"
        );
    } finally {
        await archive.dispose();
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const deadline = setTimeout(() => {
    console.error("Archive history test timed out");
    process.exitCode = 1;
}, 30000);
main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => clearTimeout(deadline));
