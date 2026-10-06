"use strict";
const assert = require("assert");
const elf = require("../src/elfSymbols");
const { LiveWatchService, buildChartHistoryItems, buildActiveReadPlan } = require("../src/services/liveWatchService");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

(async () => {
    const parent = {
        name: "app::g_pid",
        address: 0x20000000,
        size: 12,
        isComposite: true,
        compositeLayout: {
            kind: "struct",
            byteSize: 12,
            members: [
                { name: "integral", offset: 0, watchType: "f32", byteSize: 4 },
                { name: "previous", offset: 4, watchType: "f32", byteSize: 4 },
                { name: "initialized_", offset: 8, watchType: "u32", byteSize: 4 }
            ]
        }
    };
    const leaves = buildChartHistoryItems([parent], elf);
    assert.strictEqual(buildActiveReadPlan([[parent]], elf).length, 1, "history leaves add no hardware reads");
    let watches = [parent, { name: leaves[0].name, address: leaves[0].address, size: 4, type: "f32" }];
    const store = new ChartHistoryStore();
    const p = Object.create(loadProvider({}).prototype);
    const entry = { watchKey: "p", latestSamples: new Map(), ready: true, post() {} };
    const archive = [],
        messages = [];
    p._livePanels = new Map([[1, entry]]);
    p._scalarWatchList = (key) => (key === "p" ? watches : []);
    p._context = { workspaceState: { get: () => [] } };
    p._debugSamplingScope = (key) => key;
    p._liveWatchService = new LiveWatchService(elf);
    p._latestSidebarSamples = new Map();
    p._chartHistory = { request: async (method, args) => store[method](...args), fail: assert.fail };
    p._samplingArchive = { append: (samples) => archive.push(samples) };
    p._postWebviewBatch = (_entry, samples) => messages.push(samples);
    p._postSidebarBatch = () => {};
    p._configureChartHistory(entry, 1000);
    for (let i = 0; i < 100; i++) {
        const bytes = Buffer.alloc(12);
        bytes.writeFloatLE(i, 0);
        bytes.writeFloatLE(-i, 4);
        bytes.writeUInt32LE(1, 8);
        p._handleRawSamples(
            [
                { name: parent.name, bytes, t: 1000 + i * 5 },
                { name: leaves[0].name, bytes: bytes.subarray(0, 4), t: 1000 + i * 5 }
            ],
            1000 + i * 5,
            { graphNames: watches.map((item) => item.name), sidebarNames: [] }
        );
    }
    assert.ok(
        archive.every((samples) => samples.length === 3),
        "explicit and parent members archive once per batch"
    );
    assert.ok(
        messages.every((samples) => samples.length === 1),
        "silent leaf points stay out of Webview messages"
    );
    const frozen = store.freeze("p");
    const page = render(getLiveWatchContent({ backendHistory: true }, "en"));
    try {
        const w = page.window;
        Object.defineProperties(page.document.getElementById("chart"), {
            clientWidth: { value: 800 },
            clientHeight: { value: 400 }
        });
        page.send({ type: "watchList", items: watches });
        page.send({ type: "chartHistoryStatus", ...store.status("p"), historyRevision: 0 });
        w.syncTimeBounds();
        w.chartState.follow = false;
        w.chartState.x = { min: 1000, max: 1495 };
        const viewport = JSON.stringify(w.chartState.x);
        for (const leaf of leaves.slice(1)) w.toggleLeafInChart(leaf.name, leaf.address, leaf.type);
        watches = Array.from(w.watch, (item) => ({ ...item }));
        p._configureChartHistory(entry, 2000);
        assert.ok(
            entry.historyItems.every((item) => item.historyFromMs === 1000),
            "enabling preserves recording identity"
        );
        w.draw(5000);
        const request = page.messages.filter((message) => message.type === "chartViewport").at(-1);
        const reply = store.viewport("p", request.names, request.range, request.width);
        page.send({ type: "chartViewportResult", ...reply, requestId: request.requestId, historyRevision: 0 });
        assert.strictEqual(reply.series.length, 3);
        for (const series of reply.series) {
            assert.strictEqual(series.visibleCount, 100);
            assert.strictEqual(series.arr[0].t, 1000, "later enabled members plot from the first parent acquisition");
        }
        assert.strictEqual(JSON.stringify(w.chartState.x), viewport, "member activation preserves the viewport");
        const snapshot = store.viewport(
            "p",
            leaves.map((leaf) => leaf.name),
            request.range,
            800,
            frozen.snapshotId
        );
        assert.ok(
            snapshot.series.every((series) => series.visibleCount === 100),
            "freeze includes unselected members"
        );
        assert.strictEqual(store.scopes.get("p").series.get(leaves[1].name).count, 100);
        entry.historyClearedAt = 2000;
        store.clear("p");
        p._handleRawSamples([{ name: parent.name, bytes: Buffer.alloc(12), t: 1495 }], 2100);
        assert.ok([...store.scopes.get("p").series.values()].every((series) => series.count === 0));
        p._handleRawSamples([{ name: parent.name, bytes: Buffer.alloc(12), t: 2100 }], 2100);
        assert.ok([...store.scopes.get("p").series.values()].every((series) => series.count === 1));
        watches = [];
        p._configureChartHistory(entry, 2200);
        assert.strictEqual(store.scopes.get("p").series.size, 0, "parent removal releases implicit histories");
        page.assertHealthy();
    } finally {
        page.close();
    }
    const flags = {
        name: "flags",
        address: 0x20000020,
        size: 8,
        isComposite: true,
        compositeLayout: {
            kind: "struct",
            byteSize: 8,
            members: [
                { name: "enabled", offset: 0, watchType: "u8", byteSize: 1, bitOffset: 2, bitSize: 1 },
                { name: "exact", offset: 0, watchType: "u64", byteSize: 8 }
            ]
        }
    };
    const items = buildChartHistoryItems([flags], elf);
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(9007199254740997n);
    const decoded = p._liveWatchService.decodeHistorySamples([{ name: "flags", bytes, t: 30 }], 50, items);
    assert.strictEqual(decoded[0].value, 1);
    assert.strictEqual(decoded[1].valueText, "9007199254740997");
    assert.ok(decoded.every((sample) => sample.t === 30));
    const failed = p._liveWatchService.decodeHistorySamples([{ name: "flags", bytes: null, t: 40 }], 50, items);
    assert.ok(
        failed.every((sample) => sample.value === null),
        "failed composite reads leave gaps in every leaf"
    );
    const overridden = buildChartHistoryItems([flags, { ...items[0], parentName: undefined, type: "i8" }], elf);
    assert.strictEqual(overridden[0].parentName, undefined, "changed observation types cannot reuse parent history");
    assert.deepStrictEqual(buildChartHistoryItems([{ ...flags, runtimeLayout: {} }], elf), []);
    console.log("Composite silent history, late plotting, freeze, clear and exact member tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
