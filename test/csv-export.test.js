"use strict";

const { scenario } = require("./helpers/scenario");

(async () => {
    const assert = require("assert");
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
            p._samplingStatus = () => ({});
            p._handleRawSamples([{ name: "value", bytes: [0, 0, 128, 63] }], 1000);
            // Chart panels receive values in 50 ms batches.
            await new Promise((resolve) => setTimeout(resolve, 60));
            assert.equal(posted[0].type, "chartValues");
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
