"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const elfSymbols = require("../src/elfSymbols");
const { LiveWatchService } = require("../src/services/liveWatchService");
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
        assert.strictEqual(writes.length, 1, "twenty ticks share one concatenated disk write");
        assert.strictEqual(syncs, 0, "neither a normal drain nor flush syncs the temporary archive");
        assert.deepStrictEqual(
            fs
                .readFileSync(archive.dataPath, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line).v.tick),
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
        assert.strictEqual(fs.readFileSync(archive.dataPath, "utf8").trim().split("\n").length, 22);
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

async function main() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-sampling-archive-"));
    const archiveRoot = path.join(temporaryRoot, "history");
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

        // A torn final line (for example after process interruption) is ignored, preserving prior complete rows.
        await archive.flush();
        fs.appendFileSync(archive.dataPath, '{"t":10000,"v":');
        archive.writtenBytes += Buffer.byteLength('{"t":10000,"v":');
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

        const rendererSource = fs.readFileSync(
            path.join(__dirname, "..", "src", "webview", "liveWatch", "renderer.js"),
            "utf8"
        );
        assert.match(rendererSource, /post\(\{\s*type:\s*["']samplingArchiveInfo["'],\s*historyRevision:/);
        assert.match(rendererSource, /firstTimestampMs/);
        assert.match(rendererSource, /lastTimestampMs/);
        assert.match(rendererSource, /chartState\.bounds\.min\s*-\s*origin/);
        assert.match(rendererSource, /chartState\.bounds\.max\s*-\s*origin/);
    } finally {
        await archive.dispose();
        assert.strictEqual(fs.existsSync(archiveRoot), false, "temporary history must be deleted on exit");
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
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
