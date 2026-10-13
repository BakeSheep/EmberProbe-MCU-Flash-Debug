"use strict";

const { scenario } = require("./helpers/scenario");

(async () => {
    const assert = require("assert");
    const { buildCsv, csvDataRowCount } = require("../src/liveWatchView");

    // RFC 4180:BOM 头、保留字符转义、CRLF 行尾;宽表按采样时间戳对齐,晚加入的序列起始前留空单元格
    const t0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
    const csv = buildCsv(
        ["counter", 'weird,"name"'],
        [
            [
                { t: t0, v: 1 },
                { t: t0 + 100, v: 2 }
            ],
            [{ t: t0 + 100, v: -0.5 }]
        ]
    );
    const lines = csv.split("\r\n");
    assert.strictEqual(
        lines[0],
        '\uFEFFtime,counter,"weird,""name"""',
        "header should keep the BOM and quote reserved characters"
    );
    assert.strictEqual(
        lines[1],
        "2026-01-02T03:04:05.678Z,1,",
        "series joined later should leave cells empty before its first sample"
    );
    assert.strictEqual(lines[2], "2026-01-02T03:04:05.778Z,2,-0.5", "rows should align samples by timestamp");
    assert.ok(csv.endsWith("\r\n"), "file should end with CRLF");
    assert.strictEqual(buildCsv(["a"], [[]]), "\uFEFFtime,a\r\n", "empty buffers should produce only the header");

    const ranged = buildCsv(
        ["wide", "state"],
        [
            [
                { t: t0, v: Number(18446744073709551615n), valueText: "18446744073709551615" },
                { t: t0 + 1000, v: NaN, valueText: "NaN" }
            ],
            [
                { t: t0 + 500, v: 7 },
                { t: t0 + 1000, v: Infinity, valueText: "Infinity" }
            ]
        ],
        { from: t0 + 500, to: t0 + 1000 }
    );
    const rangedLines = ranged.split("\r\n");
    assert.strictEqual(rangedLines[1], "2026-01-02T03:04:06.178Z,,7", "from endpoint should be included");
    assert.strictEqual(
        rangedLines[2],
        "2026-01-02T03:04:06.678Z,NaN,Infinity",
        "to endpoint and exact text should be included"
    );
    assert.strictEqual(
        buildCsv(["wide"], [[{ t: t0, v: 1, valueText: "18446744073709551615" }]]).split("\r\n")[1],
        "2026-01-02T03:04:05.678Z,18446744073709551615",
        "valueText should take precedence over approximate values"
    );
    assert.strictEqual(
        buildCsv(["a"], [[{ t: t0, v: 1 }]], { from: t0 + 1, to: t0 + 2 }),
        "\uFEFFtime,a\r\n",
        "empty ranges should contain only the header"
    );
    assert.strictEqual(
        buildCsv(['=HYPERLINK("https://example.invalid")'], [[]]).split("\r\n")[0],
        '\uFEFFtime,"\'=HYPERLINK(""https://example.invalid"")"',
        "ELF-controlled series names must not become spreadsheet formulas"
    );
    // Data cells are dominated by negative readings, so a leading "-" only counts as a formula when the
    // rest is not a plain number. Mirrors csvField in src/services/samplingArchive.js.
    assert.strictEqual(
        buildCsv(["v"], [[{ t: t0, v: -Infinity }]]).split("\r\n")[1],
        "2026-01-02T03:04:05.678Z,'-Infinity",
        "a non-numeric negative cell must not become a spreadsheet formula"
    );
    assert.strictEqual(
        buildCsv(["v"], [[{ t: t0, v: -128 }]]).split("\r\n")[1],
        "2026-01-02T03:04:05.678Z,-128",
        "negative readings must stay numeric"
    );
    assert.strictEqual(
        buildCsv(["v"], [[{ t: t0, v: 1, valueText: "=1+1" }]]).split("\r\n")[1],
        "2026-01-02T03:04:05.678Z,'=1+1",
        "a target-controlled value must not become a spreadsheet formula"
    );

    assert.strictEqual(
        buildCsv(["failed"], [[{ t: t0, v: null, valueText: "-" }]]).split("\r\n")[1],
        "2026-01-02T03:04:05.678Z,",
        "failed readings must leave CSV cells empty"
    );
    assert.strictEqual(csvDataRowCount(buildCsv(["line\r\nbreak"], [[{ t: t0, v: 1 }]])), 1);
    assert.strictEqual(csvDataRowCount(buildCsv(["empty"], [[]])), 0);

    await scenario("Export typed graph history with panel, variable and time-range isolation", async () => {
        const fs = require("fs");
        const os = require("os");
        const path = require("path");
        const { loadProvider } = require("./helpers/load-provider");
        const { LiveWatchService } = require("../src/services/liveWatchService");
        const { SamplingArchive } = require("../src/services/samplingArchive");
        const elf = require("../src/elfSymbols");
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-csv-history-"));
        const archive = new SamplingArchive({ rootDir: path.join(root, "history") });
        try {
            const P = loadProvider();
            const p = Object.create(P.prototype);
            const entry = { ready: true, watchKey: "graph", latestSamples: new Map(), post() {} };
            const service = new LiveWatchService(elf);
            const posted = [];
            p._livePanels = new Map([
                [1, { ...entry, post: (m) => posted.push(m) }],
                [2, { ...entry, watchKey: "graph2", post: () => {} }]
            ]);
            let chartType = "f32";
            p._getCachedConsumerTypes = () => ({
                sidebar: new Map([["value", "u32"]]),
                graphs: new Map([
                    ["graph", new Map([["value", chartType]])],
                    ["graph2", new Map([["value", "i32"]])]
                ])
            });
            p._compositeMap = () => new Map();
            p._latestSidebarSamples = new Map();
            p._liveWatchService = service;
            p._samplingArchive = archive;
            p._handleRawSamples([{ name: "value", bytes: [0, 0, 128, 63] }], 1000);
            assert.equal(posted[0].samples[0].value, 1);
            chartType = "u32";
            p._handleRawSamples([{ name: "value", bytes: [0, 0, 128, 63] }], 2000);
            assert.deepStrictEqual(archive.status("graph").variables, ["value [f32]", "value [u32]"]);
            assert.deepStrictEqual(archive.status("missing").variables, []);
            const outputPath = path.join(root, "graph.csv");
            const result = await archive.exportCsv({ outputPath, scope: "graph" });
            assert.equal(result.rows, 2);
            assert.equal(
                fs.readFileSync(outputPath, "utf8"),
                "﻿time,value [f32],value [u32]\r\n1970-01-01T00:00:01.000Z,1,\r\n1970-01-01T00:00:02.000Z,,1065353216\r\n"
            );
            await assert.rejects(archive.exportCsv({ outputPath, scope: "missing" }), { code: "CSV_EXPORT_EMPTY" });
            await archive.exportCsv({ outputPath, scope: "graph2", fromMs: 1000, toMs: 1000 });
            assert.match(fs.readFileSync(outputPath, "utf8"), /time,value \[i32\]\r\n.*?,1065353216\r\n$/);
            p._livePanels.set(1, { ...entry, panelId: 1, focusOrder: 1 });
            for (let i = 0; i < 2201; i++) archive.append([{ name: "value [u32]", value: i }], 3000 + i * 5, "graph");
            const agentCsv = await p._exportAgentCsv({ panelId: 1, variables: ["value"], from: 1000, to: 20000 });
            assert.equal(
                agentCsv.rowCount,
                2203,
                "Agent export must include history beyond the chart's 2000-point limit"
            );
            assert.deepStrictEqual(agentCsv.names, ["value [f32]", "value [u32]"]);
            assert.equal(agentCsv.from, 1000);
            assert.equal(agentCsv.to, 14000);
            assert.equal(agentCsv.historyTruncated, false, "an archive below its size cap must not claim truncation");
            assert.match(agentCsv.csv, /1970-01-01T00:00:01.000Z,1,/);
            assert.match(agentCsv.csv, /1970-01-01T00:00:14.000Z,,2200/);
            await assert.rejects(p._exportAgentCsv({ panelId: 1, variables: ["missing"] }), {
                code: "CSV_SERIES_NOT_FOUND"
            });
            await assert.rejects(p._exportAgentCsv({ panelId: 1, variables: ["value"], from: 25000, to: 26000 }), {
                code: "CSV_EXPORT_EMPTY"
            });
        } finally {
            await archive.dispose();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    console.log("CSV export tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
