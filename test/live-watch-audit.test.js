"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { loadProvider } = require("./helpers/load-provider");
const { LiveWatchService } = require("../src/services/liveWatchService");
const { SamplingArchive } = require("../src/services/samplingArchive");
const { normalizeWatchList } = require("../src/validation");
const elf = require("../src/elfSymbols");

(async () => {
    const graph = render(getLiveWatchContent({}, "en"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-audit-"));
    const archive = new SamplingArchive({ rootDir: path.join(root, "history") });
    try {
        const P = loadProvider();
        const p = Object.create(P.prototype);
        const scalar = (name) => ({ name, address: 0x20000000, size: 4, type: "u32", watchType: "u32" });
        const entry = { ready: true, watchKey: "graph", latestSamples: new Map(), post: (m) => graph.send(m) };
        p._scalarWatchList = () => [];
        p._samplingStatus = () => ({});
        p.readElfSymbols = () => ({ symbols: [scalar("old"), scalar("new")], warnings: [] });
        graph.document.getElementById("import").click();
        graph.send({ type: "variablesList", symbols: [scalar("old")] });
        graph.document.querySelector("#impList input").checked = true;
        p._syncGraphTarget(entry);
        assert.deepStrictEqual(
            Array.from(graph.window.allSymbols, (s) => s.name),
            ["old", "new"]
        );
        assert.ok(graph.document.getElementById("impList").textContent.includes("new"));
        assert.ok(graph.document.querySelector("#impList input").checked, "refresh retains selected names");
        p.readElfSymbols = () => {
            throw Error("ELF unavailable");
        };
        p._syncGraphTarget(entry);
        assert.equal(graph.document.querySelectorAll("#impList input").length, 0);
        assert.equal(graph.document.getElementById("impWarn").textContent, "ELF unavailable");

        // Exercise the member button, host normalization and actual scalar decoding, including bitfields.
        const symbol = {
            name: "sensor",
            address: 0x20000000,
            size: 4,
            isComposite: true,
            compositeLayout: {
                kind: "struct",
                byteSize: 4,
                members: [{ name: "x", offset: 0, watchType: "u32", byteSize: 4, bitSize: 3, bitOffset: 4 }]
            }
        };
        graph.window.addSymbol(symbol);
        graph.send({
            type: "liveCompositeSample",
            samples: [
                {
                    name: "sensor",
                    tree: {
                        kind: "struct",
                        members: [{ name: "x", value: 5 }]
                    }
                }
            ]
        });
        assert.equal(graph.window.chartData().length, 0);
        graph.document.querySelector(".member-swatch").click();
        const watch = normalizeWatchList(graph.messages.at(-1).items, [symbol]);
        const leaf = watch.find((item) => item.name === "sensor.x");
        assert.equal(leaf.bitSize, 3);
        graph.send({ type: "watchList", items: watch });
        const service = new LiveWatchService(elf);
        const decoded = service.decodeConsumerSamples(
            [{ name: leaf.name, bytes: [80, 0, 0, 0] }],
            1000,
            new Map([[leaf.name, leaf]]),
            null,
            new Map()
        );
        graph.send({ type: "liveSample", samples: decoded.scalarSamples });
        assert.equal(graph.window.chartData()[0].arr[0].v, 5);

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
        graph.assertHealthy();
    } finally {
        graph.close();
        await archive.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log("Live Watch import, composite plotting and scoped CSV regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
