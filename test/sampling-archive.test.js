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
        assert.strictEqual(csvField("a,b"), '"a,b"');
        assert.strictEqual(csvField('a"b'), '"a""b"');
        assert.strictEqual(csvField(null), "");
        assert.strictEqual(
            csvHeaderField('=HYPERLINK("https://example.invalid")'),
            '"\'=HYPERLINK(""https://example.invalid"")"'
        );
        assert.strictEqual(sampleValueText({ value: 1.25, valueText: null }), "1.25");
        assert.strictEqual(sampleValueText({ value: -0, valueText: null }), "-0");
        assert.strictEqual(sampleValueText({ value: 1, valueText: "exact" }), "exact");
        assert.strictEqual(sampleValueText({ value: null, valueText: null }), null);

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
        assert.match(rendererSource, /post\(\{\s*type:\s*["']samplingArchiveInfo["']\s*\}\)/);
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
            ["f64_ninf", "-inf", "-Infinity", "f64"]
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

    console.log("sampling archive tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
