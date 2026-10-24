"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ArchiveEncoder, decodeRecords, FILE_HEADER } = require("../src/services/samplingArchiveFormat");
const elfSymbols = require("../src/elfSymbols");
const { LiveWatchService } = require("../src/services/liveWatchService");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { render } = require("./helpers/render-webview");
const {
    SamplingArchive,
    csvField,
    csvHeaderField,
    sampleValueText,
    cleanupStaleSamplingArchives
} = require("../src/services/samplingArchive");

async function testDraining(parentDir) {
    const archive = new SamplingArchive({ rootDir: path.join(parentDir, "coalescing") });
    const writes = [];
    let syncs = 0;
    try {
        await archive.ready;
        archive.handle = await fs.promises.open(archive.dataPath, "a+", 0o600);
        const write = archive.handle.write.bind(archive.handle);
        archive.handle.write = (...args) => {
            writes.push(args[0].length);
            return write(...args);
        };
        archive.handle.datasync = async () => {
            syncs++;
        };
        for (let i = 0; i < 20; i++) archive.append([{ name: "tick", value: i }], 1000 + i * 5);
        assert.strictEqual(writes.length, 0, "appends coalesce before the drain timer fires");
        assert.strictEqual(archive.drainPromise, null);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.strictEqual(writes.length, 1, "the normal timer drains without an explicit flush");
        await archive.flush();
        assert.deepStrictEqual(fs.readFileSync(archive.dataPath).subarray(0, 16), FILE_HEADER);
        assert.strictEqual(archive.status().bytes, fs.statSync(archive.dataPath).size);
        assert.strictEqual(writes.length, 1, "twenty ticks share one concatenated disk write");
        assert.strictEqual(syncs, 0, "neither a normal drain nor flush syncs the temporary archive");
        assert.deepStrictEqual(
            decodeRecords(fs.readFileSync(archive.dataPath)).rows.map((row) => row.v.tick),
            Array.from({ length: 20 }, (_, i) => String(i))
        );

        let release;
        let entered;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const writing = new Promise((resolve) => {
            entered = resolve;
        });
        let first = true;
        archive.handle.write = async (...args) => {
            if (first) {
                first = false;
                entered();
                await gate;
            }
            // Exercise short writes as well as appends arriving while a write is in flight.
            return write(args[0], args[1], Math.min(args[2], 17));
        };
        archive.append([{ name: "tick", value: 20 }], 1100);
        const flushing = archive.flush();
        await writing;
        const inFlightBytes = archive.queuedBytes;
        assert.ok(inFlightBytes > 0, "in-flight bytes remain in the queue budget");
        archive.append([{ name: "tick", value: 21 }], 1105);
        const expectedBytes = archive.writtenBytes + archive.queuedBytes;
        const concurrent = archive.flush();
        release();
        assert.deepStrictEqual(await Promise.all([flushing, concurrent]), [expectedBytes, expectedBytes]);
        assert.strictEqual(archive.queuedBytes, 0);
        assert.strictEqual(archive.queue.length, 0);
        assert.strictEqual(archive.drainTimer, null);
        assert.strictEqual(archive.writtenBytes, expectedBytes);
        assert.strictEqual(syncs, 0);
        assert.strictEqual(decodeRecords(fs.readFileSync(archive.dataPath)).rows.length, 22);
        archive.append([{ name: "tick", value: 22 }], 1110);
        await archive.dispose();
        assert.strictEqual(archive.queuedBytes, 0, "dispose flushes bytes still waiting for the batching timer");
        assert.strictEqual(fs.existsSync(archive.rootDir), false);
    } finally {
        await archive.dispose();
    }

    const pauses = [],
        errors = [];
    const bounded = new SamplingArchive({
        rootDir: path.join(parentDir, "backpressure"),
        maxBytes: 2 * 1024 * 1024,
        onBackpressure: (active) => pauses.push(active),
        onError: (error) => errors.push(error)
    });
    let release;
    try {
        await bounded.ready;
        bounded.handle = await fs.promises.open(bounded.dataPath, "a+", 0o600);
        const write = bounded.handle.write.bind(bounded.handle);
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let entered;
        const writing = new Promise((resolve) => {
            entered = resolve;
        });
        bounded.handle.write = async (...args) => {
            entered();
            await gate;
            return write(...args);
        };
        bounded.handle.datasync = async () => assert.fail("normal archive drains must not sync");
        assert.strictEqual(bounded.append([{ name: "big", valueText: "x".repeat(1024 * 1024) }], 1), true);
        assert.deepStrictEqual(pauses, [true]);
        assert.ok(bounded.drainPromise, "large queues drain immediately at the byte threshold");
        await writing;
        assert.ok(bounded.queuedBytes > 1024 * 1024);
        assert.strictEqual(
            bounded.append([{ name: "big", valueText: "x".repeat(1024 * 1024) }], 2),
            false,
            "the file limit includes the write in flight"
        );
        assert.strictEqual(errors[0].code, "SAMPLING_ARCHIVE_FULL");
        release();
        const size = await bounded.flush();
        assert.ok(size <= bounded.maxBytes);
        assert.deepStrictEqual(pauses, [true, false]);
    } finally {
        release?.();
        await bounded.dispose();
    }

    const failure = new SamplingArchive({ rootDir: path.join(parentDir, "drain-failure") });
    try {
        await failure.ready;
        failure.handle = await fs.promises.open(failure.dataPath, "a+", 0o600);
        failure.handle.write = async () => {
            throw new Error("disk unavailable");
        };
        failure.append([{ name: "tick", value: 1 }], 1);
        await failure.flush();
        assert.match(failure.status().error, /disk unavailable/);
        assert.strictEqual(failure.queuedBytes, 0);
        assert.strictEqual(failure.backpressured, false);
        assert.strictEqual(failure.append([{ name: "tick", value: 2 }], 2), false);
    } finally {
        await failure.dispose();
    }
}

async function testLegacyCsv(parentDir) {
    const archive = new SamplingArchive({ rootDir: path.join(parentDir, "csv-parity") });
    const lines = [];
    const generations = new Map();
    // Retain the old NDJSON line builder as an independent compatibility fixture.
    const append = (samples, timestamp, scope = "") => {
        const v = Object.create(null);
        for (const sample of samples) {
            if (!sample || typeof sample.name !== "string") continue;
            v[sample.name] = sampleValueText(sample);
        }
        const identities = Object.fromEntries(
            samples.filter((sample) => sample?.historyIdentity).map((sample) => [sample.name, sample.historyIdentity])
        );
        lines.push(
            `${JSON.stringify({
                t: timestamp,
                v,
                scope,
                generation: generations.get(scope) || undefined,
                identities: Object.keys(identities).length ? identities : undefined
            })}\n`
        );
        assert.strictEqual(archive.append(samples, timestamp, scope), true);
    };
    try {
        const names = ["=formula", "b", "text", "nullable", "__proto__"];
        append(
            [
                { name: names[0], value: -0 },
                { name: "b", valueText: "18446744073709551615" },
                { name: "text", valueText: 'line,"quoted"\r\n中🙂' },
                { name: "nullable", value: null },
                { name: "__proto__", valueText: "safe" }
            ],
            1000
        );
        append(
            [
                { name: "b", value: 1, historyIdentity: "old" },
                { name: "b", valueText: "-1.5", historyIdentity: "new" },
                { name: "text", valueText: "=SUM(1,2)" }
            ],
            2000
        );
        append([{ name: "nullable", value: null }], 3000);
        append(
            [
                { name: "b", valueText: "0.10000000149011612" },
                { name: "text", valueText: "-enum" }
            ],
            4000
        );
        append(
            [
                { name: "b", valueText: "NaN" },
                { name: "text", valueText: "" }
            ],
            5000,
            "other"
        );
        const check = async (request = {}) => {
            const expectedRows = lines
                .map(JSON.parse)
                .filter(
                    (row) =>
                        row.scope === "" &&
                        (row.generation || 0) === (generations.get("") || 0) &&
                        row.t >= (request.fromMs ?? -Infinity) &&
                        row.t <= (request.toMs ?? Infinity)
                );
            const expected =
                "\uFEFFtime," +
                names.map((name) => csvHeaderField(request.displayNames?.get(name) || name)).join(",") +
                "\r\n" +
                expectedRows
                    .map(
                        (row) =>
                            // Own-property lookup: an absent "__proto__" column is empty, not "[object Object]".
                            `${new Date(row.t).toISOString()},${names.map((name) => csvField(Object.hasOwn(row.v, name) ? row.v[name] : null)).join(",")}\r\n`
                    )
                    .join("");
            const outputPath = path.join(parentDir, "parity.csv");
            const exported = await archive.exportCsv({ ...request, names, outputPath });
            assert.deepStrictEqual(
                fs.readFileSync(outputPath),
                Buffer.from(expected),
                "legacy CSV bytes are unchanged"
            );
            const read = await archive.readCsv({ ...request, names });
            assert.strictEqual(read.csv, expected);
            assert.strictEqual(read.rows, expectedRows.length);
            assert.strictEqual(
                exported.valueRows,
                expectedRows.filter((row) => names.some((name) => Object.hasOwn(row.v, name) && row.v[name] != null))
                    .length
            );
        };
        await check();
        await check({ fromMs: 2000, toMs: 3000, displayNames: new Map([["b", "@display,label"]]) });
        archive.clear();
        generations.set("", 1);
        append(
            names.map((name) => ({ name, valueText: name === "b" ? "Infinity" : "" })),
            6000
        );
        await check();
    } finally {
        await archive.dispose();
    }
}

async function testSourceBoundary(parentDir) {
    const archive = new SamplingArchive({ rootDir: path.join(parentDir, "source-boundary") });
    const stat = fs.promises.stat;
    let release;
    try {
        archive.append([{ name: "x", value: 1 }], 1000);
        const firstEnd = await archive.flush();
        const write = archive.handle.write.bind(archive.handle);
        let entered;
        const writing = new Promise((resolve) => (entered = resolve));
        const gate = new Promise((resolve) => (release = resolve));
        let first = true;
        archive.handle.write = async (...args) => {
            if (!first) return write(...args);
            first = false;
            const result = await write(args[0], args[1], 3);
            entered();
            await gate;
            return result;
        };
        fs.promises.stat = async (...args) => {
            archive.append([{ name: "new", value: 2 }], 2000);
            archive._ensureDrain();
            await writing;
            return stat(...args);
        };
        const source = await archive.historySource("");
        assert.strictEqual(source.cutoff, firstEnd, "an in-flight partial write cannot become a seek boundary");
        assert.strictEqual((await stat(archive.dataPath)).size, firstEnd + 3);
        assert.strictEqual(decodeRecords(fs.readFileSync(archive.dataPath)).end, firstEnd);
    } finally {
        fs.promises.stat = stat;
        release?.();
        await archive.dispose();
    }
}

async function testHeaderBudget(parentDir) {
    const archive = new SamplingArchive({ rootDir: path.join(parentDir, "header-budget"), maxBytes: 1024 * 1024 });
    try {
        await archive.ready;
        assert.strictEqual(fs.existsSync(archive.dataPath), false, "the header is deferred until the first drain");
        assert.strictEqual(path.basename(archive.dataPath), "samples.bin");
        assert.strictEqual((await archive.historySource("unknown")).startOffset, 0);
        const overhead =
            FILE_HEADER.length + new ArchiveEncoder().encodeRow({ t: 1000, values: [{ key: "x", text: "" }] }).length;
        assert.strictEqual(
            archive.append([{ name: "x", valueText: "x".repeat(archive.maxBytes - overhead) }], 1000),
            true
        );
        assert.strictEqual(archive.status().bytes, archive.maxBytes, "the header participates in the exact byte limit");
        assert.strictEqual(await archive.flush(), archive.maxBytes);
        assert.strictEqual(decodeRecords(fs.readFileSync(archive.dataPath)).rows.length, 1);
        assert.strictEqual(archive.append([{ name: "x", value: 1 }], 2000), false);
        assert.strictEqual(archive.status().limitReached, true);
        // Lowering the limit keeps written data and the full state; raising it lets the session record again.
        archive.setMaxBytes(512 * 1024);
        assert.strictEqual(archive.maxBytes, 1024 * 1024, "the limit never drops below 1 MiB");
        assert.strictEqual(archive.status().limitReached, true);
        archive.setMaxBytes(2 * 1024 * 1024);
        assert.strictEqual(archive.status().limitReached, false);
        assert.strictEqual(archive.append([{ name: "x", value: 1 }], 2000), true);
        assert.strictEqual(decodeRecords(fs.readFileSync(archive.dataPath)).rows.length, 1);
        await archive.flush();
        assert.strictEqual(decodeRecords(fs.readFileSync(archive.dataPath)).rows.length, 2);
    } finally {
        await archive.dispose();
    }
}

async function main() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-sampling-archive-"));
    const archiveRoot = path.join(temporaryRoot, "history");
    await testLegacyCsv(temporaryRoot);
    await testSourceBoundary(temporaryRoot);
    await testHeaderBudget(temporaryRoot);
    const pauses = [];
    const errors = [];
    const archive = new SamplingArchive({
        rootDir: archiveRoot,
        maxBytes: 8 * 1024 * 1024,
        onBackpressure: (paused) => pauses.push(paused),
        onError: (error) => errors.push(error)
    });

    try {
        await testDraining(temporaryRoot);
        assert.strictEqual(csvField("a,b"), '"a,b"');
        assert.strictEqual(csvField('a"b'), '"a""b"');
        assert.strictEqual(csvField(null), "");
        // Data cells are dominated by negative readings, so a leading "-" only counts as a formula
        // when the rest is not a plain number. Headers keep the blanket rule.
        assert.strictEqual(csvField("-128"), "-128");
        assert.strictEqual(csvField("-3.5"), "-3.5");
        assert.strictEqual(csvField("-1e-7"), "-1e-7");
        assert.strictEqual(csvField("-0"), "-0");
        assert.strictEqual(csvField("-Infinity"), "'-Infinity");
        assert.strictEqual(csvField("-cmd|' /C calc'!A0"), "'-cmd|' /C calc'!A0");
        assert.strictEqual(csvField("=1+1"), "'=1+1");
        assert.strictEqual(csvField("+1"), "'+1");
        assert.strictEqual(csvField("@SUM(A1)"), "'@SUM(A1)");
        assert.strictEqual(csvHeaderField("-offset"), "'-offset");
        assert.strictEqual(
            csvHeaderField('=HYPERLINK("https://example.invalid")'),
            '"\'=HYPERLINK(""https://example.invalid"")"'
        );
        assert.strictEqual(sampleValueText({ value: 1.25, valueText: null }), "1.25");
        assert.strictEqual(sampleValueText({ value: -0, valueText: null }), "-0");
        assert.strictEqual(sampleValueText({ value: 1, valueText: "exact" }), "exact");
        assert.strictEqual(sampleValueText({ value: null, valueText: null }), null);
        assert.strictEqual(sampleValueText({ value: null, valueText: "-" }), null);

        const stale = path.join(temporaryRoot, "sampling-history-999999-deadbeef");
        const active = path.join(temporaryRoot, `sampling-history-${process.pid}-abcdef`);
        fs.mkdirSync(stale);
        fs.mkdirSync(active);
        assert.strictEqual(
            cleanupStaleSamplingArchives(temporaryRoot, process.pid, () => false),
            1
        );
        assert.ok(!fs.existsSync(stale), "archives left by dead extension hosts should be removed");
        assert.ok(fs.existsSync(active), "the current extension host archive must be preserved");

        // Sampling starts recording automatically; timestamp gaps model stop/disconnect/reconnect without sessions.
        assert.strictEqual(
            archive.append(
                [
                    { name: "Tick", valueText: "1" },
                    { name: "sensor,x", valueText: "2.5" }
                ],
                1000
            ),
            true
        );
        archive.append(
            [
                { name: "Tick", valueText: "2" },
                { name: "sensor,x", valueText: null }
            ],
            5000
        );

        const firstCsv = path.join(temporaryRoot, "first.csv");
        const first = await archive.exportCsv({
            outputPath: firstCsv,
            names: ["sensor,x", "Tick"],
            fromMs: 1000,
            toMs: 3000
        });
        assert.deepStrictEqual({ rows: first.rows, seriesCount: first.seriesCount }, { rows: 1, seriesCount: 2 });
        assert.strictEqual(
            fs.readFileSync(firstCsv, "utf8"),
            '\uFEFFtime,"sensor,x",Tick\r\n1970-01-01T00:00:01.000Z,2.5,1\r\n'
        );

        const labelledCsv = path.join(temporaryRoot, "labelled.csv");
        await archive.exportCsv({
            outputPath: labelledCsv,
            names: ["sensor,x", "Tick"],
            displayNames: new Map([
                ["sensor,x", "pwr.data_.bus_voltage_v"],
                ["Tick", 'app::Holder<int, 2>::count"']
            ]),
            fromMs: 1000,
            toMs: 3000
        });
        assert.strictEqual(
            fs.readFileSync(labelledCsv, "utf8"),
            '\uFEFFtime,pwr.data_.bus_voltage_v,"app::Holder<int, 2>::count"""\r\n1970-01-01T00:00:01.000Z,2.5,1\r\n',
            "readable headers preserve raw-key value lookup, column order and CSV escaping"
        );
        await archive.exportCsv({
            outputPath: labelledCsv,
            names: ["Tick", "sensor,x"],
            displayNames: new Map([["Tick", "=unsafe"]]),
            fromMs: 1000,
            toMs: 3000
        });
        assert.strictEqual(
            fs.readFileSync(labelledCsv, "utf8"),
            '\uFEFFtime,\'=unsafe,"sensor,x"\r\n1970-01-01T00:00:01.000Z,1,2.5\r\n',
            "display headers retain formula protection and missing-label fallback"
        );

        // Export does not finish the archive: subsequent samples remain appendable and later exports include them.
        archive.append(
            [
                { name: "Tick", valueText: "3" },
                { name: "sensor,x", valueText: "7" }
            ],
            4 * 60 * 60 * 1000 + 1000
        );
        const fullCsv = path.join(temporaryRoot, "full.csv");
        const full = await archive.exportCsv({ outputPath: fullCsv, names: ["Tick"] });
        assert.strictEqual(full.rows, 3);
        assert.match(fs.readFileSync(fullCsv, "utf8"), /04:00:01\.000Z,3/);

        // Clearing one panel invalidates both written and queued rows, even with equal timestamps.
        archive.append([{ name: "old", value: 99 }], 1000, "panel-a");
        await archive.flush();
        archive.append([{ name: "old", value: 98 }], 1000, "panel-a");
        archive.append([{ name: "other", value: 97 }], 1000, "panel-b");
        archive.clear("panel-a");
        assert.equal(archive.status("panel-a").rows, 0);
        assert.deepStrictEqual(archive.status("panel-a").variables, []);
        await assert.rejects(
            archive.exportCsv({ scope: "panel-a", outputPath: fullCsv }),
            (error) => error.code === "CSV_EXPORT_EMPTY"
        );
        archive.append([{ name: "old", value: 7 }], 1000, "panel-a");
        const clearedCsv = path.join(temporaryRoot, "cleared.csv");
        const afterClear = await archive.exportCsv({ scope: "panel-a", outputPath: clearedCsv });
        assert.equal(afterClear.rows, 1);
        assert.equal(fs.readFileSync(clearedCsv, "utf8"), "\uFEFFtime,old\r\n1970-01-01T00:00:01.000Z,7\r\n");
        const other = await archive.readCsv({ scope: "panel-b" });
        assert.equal(other.rows, 1);
        assert.ok(other.csv.includes(",97\r\n"));
        archive.clear("panel-a");
        archive.append([{ name: "new", value: 8 }], 2000, "panel-a");
        assert.deepStrictEqual(archive.status("panel-a").variables, ["new"]);
        assert.equal((await archive.readCsv({ scope: "panel-a" })).rows, 1);

        // A torn final binary record is ignored, preserving prior complete rows.
        await archive.flush();
        const tail = new ArchiveEncoder().encodeRow({ t: 10000, values: [{ key: "Tick", text: "4" }] });
        fs.appendFileSync(archive.dataPath, tail.subarray(0, -1));
        archive.writtenBytes += tail.length - 1;
        const recoveredCsv = path.join(temporaryRoot, "recovered.csv");
        const recovered = await archive.exportCsv({ outputPath: recoveredCsv, names: ["Tick"] });
        assert.strictEqual(recovered.rows, 3);

        assert.strictEqual(errors.length, 0);
        assert.deepStrictEqual(
            {
                rows: archive.status().rows,
                firstTimestampMs: archive.status().firstTimestampMs,
                lastTimestampMs: archive.status().lastTimestampMs
            },
            { rows: 3, firstTimestampMs: 1000, lastTimestampMs: 4 * 60 * 60 * 1000 + 1000 }
        );
    } finally {
        await archive.dispose();
        assert.strictEqual(fs.existsSync(archiveRoot), false, "temporary history must be deleted on exit");
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }

    // The live-watch webview asks for the archive bounds of its own history revision and labels the
    // timeline relative to the archive's first sample, not the oldest point still retained in the chart.
    {
        const view = render(getLiveWatchContent({ maxSamples: 100, autoMaxSamples: false }, "en"));
        try {
            const doc = view.document;
            const axis = () => {
                view.window.syncTimeBounds();
                view.window.refreshChartTimeline();
                return [
                    doc.getElementById("chartAxisStart").textContent,
                    doc.getElementById("chartAxisEnd").textContent
                ];
            };
            Object.defineProperty(doc.getElementById("chartTimeline"), "clientWidth", { value: 500 });
            assert.deepStrictEqual(
                view.messages.filter((message) => message.type === "samplingArchiveInfo").map((m) => m.historyRevision),
                [0],
                "the webview requests archive info once on load"
            );
            view.send({ type: "chartHistoryReady", historyRevision: 4 });
            assert.strictEqual(view.messages.at(-1).type, "samplingArchiveInfo");
            assert.strictEqual(view.messages.at(-1).historyRevision, 4);
            view.send({ type: "watchList", items: [{ name: "tick", address: 0x20000000, type: "u32", size: 4 }] });
            const origin = 1000000;
            for (const time of [60000, 70000])
                view.send({ type: "liveSample", samples: [{ name: "tick", value: time, t: origin + time }] });
            assert.deepStrictEqual(axis(), ["00:00", "00:10"], "without archive info the chart start is the origin");
            view.send({ type: "samplingArchiveInfo", historyRevision: 3, rows: 2, firstTimestampMs: origin });
            assert.deepStrictEqual(axis(), ["00:00", "00:10"], "archive info for an old revision is ignored");
            view.send({
                type: "samplingArchiveInfo",
                historyRevision: 4,
                rows: 2,
                firstTimestampMs: origin,
                lastTimestampMs: origin + 70000
            });
            assert.deepStrictEqual(axis(), ["01:00", "01:10"], "elapsed labels are measured from the archive start");
            view.assertHealthy();
        } finally {
            view.close();
        }
    }

    // Exports write "<target>.part", report rising progress, and cancel without leaving any file behind.
    const progressRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-sampling-export-progress-"));
    const progressArchive = new SamplingArchive({ rootDir: path.join(progressRoot, "history") });
    try {
        for (let i = 0; i < 20000; i++) progressArchive.append([{ name: "Tick", valueText: String(i) }], 1000 + i);
        const target = path.join(progressRoot, "out.csv");
        // An interrupted export leaves a .part that starts with the CSV header.
        fs.writeFileSync(target + ".part", "﻿time,Tick\r\n1970-01-01T00:00:01.000Z,");
        const fractions = [];
        let sawPart = false;
        const result = await progressArchive.exportCsv({
            outputPath: target,
            onProgress: (fraction) => fractions.push(fraction),
            isCancelled: () => {
                sawPart ||= fs.existsSync(target + ".part") && fs.statSync(target + ".part").size > 5;
                return false;
            }
        });
        assert.strictEqual(result.rows, 20000);
        assert.ok(sawPart, "the in-progress file is the visible .part name");
        assert.ok(fractions.length >= 1 && fractions.at(-1) === 1, "progress reaches 100%");
        assert.ok(fractions.every((value, i) => !i || value > fractions[i - 1]));
        assert.strictEqual(fs.existsSync(target + ".part"), false, "a leftover .part is replaced, then renamed");
        assert.ok(fs.readFileSync(target, "utf8").endsWith(",19999\r\n"));
        // A file of the same name that is not an export leftover is kept; the export writes beside it.
        const unrelated = path.join(progressRoot, "data.csv");
        fs.writeFileSync(unrelated + ".part", "user data");
        fs.mkdirSync(path.join(progressRoot, "dir.csv.part"));
        for (const name of ["data.csv", "dir.csv"]) {
            const exported = await progressArchive.exportCsv({ outputPath: path.join(progressRoot, name) });
            assert.strictEqual(exported.rows, 20000);
        }
        assert.strictEqual(fs.readFileSync(unrelated + ".part", "utf8"), "user data");
        assert.ok(fs.statSync(path.join(progressRoot, "dir.csv.part")).isDirectory());
        assert.ok(fs.readFileSync(unrelated, "utf8").endsWith(",19999\r\n"));
        assert.deepStrictEqual(
            fs.readdirSync(progressRoot).filter((name) => /^(data|dir)\.csv\.[0-9a-f]{8}\.part$/.test(name)),
            [],
            "the uniquely named temporary file is renamed to the target"
        );
        const cancelledTarget = path.join(progressRoot, "cancelled.csv");
        await assert.rejects(progressArchive.exportCsv({ outputPath: cancelledTarget, isCancelled: () => true }), {
            code: "CSV_EXPORT_CANCELLED"
        });
        assert.strictEqual(fs.existsSync(cancelledTarget), false);
        assert.strictEqual(fs.existsSync(cancelledTarget + ".part"), false);
    } finally {
        await progressArchive.dispose();
        fs.rmSync(progressRoot, { recursive: true, force: true });
    }

    // A failed export must not leave either a target CSV or an internal temporary file.
    const failureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-sampling-export-failure-"));
    const failureArchive = new SamplingArchive({ rootDir: path.join(failureRoot, "history") });
    try {
        failureArchive.append([{ name: "Tick", valueText: "1" }], 1);
        const missingParent = path.join(failureRoot, "missing", "out.csv");
        await assert.rejects(() => failureArchive.exportCsv({ outputPath: missingParent }), /ENOENT/);
        assert.strictEqual(fs.existsSync(missingParent), false);
    } finally {
        await failureArchive.dispose();
        fs.rmSync(failureRoot, { recursive: true, force: true });
    }

    // Every scalar type must survive raw-byte decode, temporary archiving, and CSV export.
    const typeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-sampling-types-"));
    const typeArchive = new SamplingArchive({ rootDir: path.join(typeRoot, "history") });
    try {
        const fixtures = [
            ["u8", 255, "255"],
            ["i8", -128, "-128"],
            ["u16", 65535, "65535"],
            ["i16", -32768, "-32768"],
            ["u32", 4294967295, "4294967295"],
            ["i32", -2147483648, "-2147483648"],
            ["f32", 1.25, "1.25"],
            ["u64", "18446744073709551615", "18446744073709551615"],
            ["i64", "-9223372036854775808", "-9223372036854775808"],
            ["f64", 1.5, "1.5"],
            ["f64_nan", "nan", "NaN", "f64"],
            ["f64_inf", "inf", "Infinity", "f64"],
            // The cell is formula-guarded because "-Infinity" is not a plain number; "-128" and
            // "-32768" above stay untouched.
            ["f64_ninf", "-inf", "'-Infinity", "f64"]
        ];
        const typeMap = new Map();
        const rawSamples = fixtures.map(([name, value, , explicitType]) => {
            const type = explicitType || name;
            typeMap.set(name, type);
            return { name, bytes: elfSymbols.encodeValue(value, type) };
        });
        const decoded = new LiveWatchService(elfSymbols).decodeConsumerSamples(
            rawSamples,
            1234,
            typeMap,
            null,
            new Map()
        ).scalarSamples;
        decoded.push({ name: "missing", value: null, valueText: null });
        typeArchive.append(decoded, 1234);

        const typeCsv = path.join(typeRoot, "types.csv");
        await typeArchive.exportCsv({ outputPath: typeCsv });
        const lines = fs
            .readFileSync(typeCsv, "utf8")
            .replace(/^\uFEFF/, "")
            .trim()
            .split(/\r?\n/);
        assert.deepStrictEqual(lines[0].split(","), ["time", ...fixtures.map(([name]) => name), "missing"]);
        assert.deepStrictEqual(lines[1].split(",").slice(1), [...fixtures.map(([, , expected]) => expected), ""]);
        assert.deepStrictEqual(
            elfSymbols.SUPPORTED_TYPES.slice().sort(),
            fixtures
                .slice(0, 10)
                .map(([name]) => name)
                .sort()
        );
    } finally {
        await typeArchive.dispose();
        fs.rmSync(typeRoot, { recursive: true, force: true });
    }

    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-agent-csv-"));
    const agentArchive = new SamplingArchive({ rootDir: path.join(agentRoot, "history") });
    try {
        agentArchive.append([{ name: "value [u32]", value: 42 }], 1000, "graph");
        await assert.rejects(
            agentArchive.exportCsv({
                outputPath: path.join(agentRoot, "too-large.csv"),
                scope: "graph",
                maxOutputBytes: 1
            }),
            { code: "CSV_EXPORT_TOO_LARGE" }
        );
        assert.ok(!fs.existsSync(path.join(agentRoot, "too-large.csv")));
        // An Agent read must not fail just because the user happens to be exporting: it writes to a
        // unique temporary file, and only the user-facing path needs the serialising lock.
        const userExport = agentArchive.exportCsv({
            outputPath: path.join(agentRoot, "user.csv"),
            scope: "graph"
        });
        const concurrentRead = agentArchive.readCsv({ scope: "graph" });
        const concurrent = await concurrentRead;
        assert.match(concurrent.csv, /1970-01-01T00:00:01.000Z,42/);
        assert.strictEqual(concurrent.limitReached, false);
        await userExport;
        const pendingRead = agentArchive.readCsv({ scope: "graph" });
        const pendingDispose = agentArchive.dispose();
        assert.match((await pendingRead).csv, /1970-01-01T00:00:01.000Z,42/);
        await pendingDispose;
        assert.ok(!fs.existsSync(agentArchive.rootDir));
    } finally {
        await agentArchive.dispose();
        fs.rmSync(agentRoot, { recursive: true, force: true });
    }

    // Once the archive hits its size cap it stops recording while the chart keeps drawing, so the
    // Agent-facing CSV has to say so instead of silently covering a shorter window than requested.
    const fullRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-archive-full-"));
    const fullArchive = new SamplingArchive({ rootDir: path.join(fullRoot, "history"), maxBytes: 1024 * 1024 });
    try {
        fullArchive.append([{ name: "tick", value: 1 }], 1000, "graph");
        assert.strictEqual(
            fullArchive.append([{ name: "tick", valueText: "x".repeat(2 * 1024 * 1024) }], 2000, "graph"),
            false,
            "an oversized sample must be refused rather than silently dropped"
        );
        assert.strictEqual(fullArchive.status("graph").limitReached, true);
        const truncated = await fullArchive.readCsv({ scope: "graph" });
        assert.strictEqual(truncated.limitReached, true);
        assert.match(truncated.csv, /1970-01-01T00:00:01.000Z,1/);
    } finally {
        await fullArchive.dispose();
        fs.rmSync(fullRoot, { recursive: true, force: true });
    }

    console.log("sampling archive tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
