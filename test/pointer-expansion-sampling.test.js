"use strict";
// "Sample expanded pointer parts only": runtime objects read only the composites their waveform
// view opened, record those scalars as silent history, and read/record everything when off.
const assert = require("assert");
const elf = require("../src/elfSymbols");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const {
    normalizeRuntimeExpansions,
    runtimeTreeLeaves,
    MAX_RUNTIME_EXPANSION_PATHS
} = require("../src/services/runtimeExpansion");
const {
    LiveWatchService,
    buildActiveReadPlan,
    buildChartHistoryItems,
    collectRuntimeHistoryLeaves
} = require("../src/services/liveWatchService");
const { ChartHistoryStore } = require("../src/services/chartHistoryStore");
const { normalizeWatchList } = require("../src/validation");
const { pointerDerefEntry } = require("../src/webview/runtime");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { getLiveWatchContent } = require("../src/liveWatchView");

const base = 0x20000000;
const types = [
    { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" },
    {
        kind: "class",
        typeName: "Inner",
        byteSize: 8,
        fields: [
            { name: "x", offset: 0, type: 0 },
            { name: "y", offset: 4, type: 0 }
        ]
    },
    { kind: "pointer", typeName: "Inner *", target: 1, byteSize: 4, pointerTarget: "data" },
    { kind: "array", typeName: "int [3]", target: 0, count: 3, byteSize: 12 },
    {
        kind: "class",
        typeName: "Node",
        byteSize: 28,
        fields: [
            { name: "a", offset: 0, type: 0 },
            { name: "inner", offset: 4, type: 1 },
            { name: "next", offset: 12, type: 2 },
            { name: "arr", offset: 16, type: 3 }
        ]
    },
    { kind: "pointer", typeName: "Node *", target: 4, byteSize: 4, pointerTarget: "data" },
    { kind: "class", typeName: "Holder", byteSize: 4, fields: [{ name: "node", offset: 0, type: 5 }] }
];
const graph = { root: 6, types };
const symbol = { name: "g", address: base, size: 4, isComposite: true, runtimeLayout: graph };
const ranges = [{ start: base, end: base + 4096 }];

const memory = Buffer.alloc(4096);
const word = (address, value) => memory.writeInt32LE(value | 0, address - base);
word(base, base + 32);
word(base + 32, 7);
word(base + 36, 1);
word(base + 40, 2);
word(base + 44, base + 96);
word(base + 48, 10);
word(base + 52, 20);
word(base + 56, 30);
word(base + 96, 100);
word(base + 100, 200);

function reader(item) {
    const reads = [];
    return {
        reads,
        sample: () =>
            new RuntimeObjectReader({ ...item, runtimeRanges: ranges }, async (address, size) => {
                reads.push([address, size]);
                return memory.subarray(address - base, address - base + size);
            }).sample()
    };
}
const member = (tree, name) => tree.members.find((entry) => entry.name === name);

(async () => {
    // Input validation for the per-view expansion store.
    assert.deepStrictEqual(normalizeRuntimeExpansions({ "g.node.value": [".inner", "", ".inner"] }), {
        "g.node.value": ["", ".inner"]
    });
    for (const bad of [null, [], { g: "x" }, { g: ["inner"] }, { g: [1] }, { "": [] }])
        assert.throws(() => normalizeRuntimeExpansions(bad), { code: "INVALID_ARGUMENT" });
    assert.throws(
        () =>
            normalizeRuntimeExpansions({
                g: Array.from({ length: MAX_RUNTIME_EXPANSION_PATHS + 1 }, (_, i) => `[${i}]`)
            }),
        { code: "INVALID_ARGUMENT" }
    );

    const pointee = pointerDerefEntry("g.node", symbol);
    assert.strictEqual(pointee.name, "g.node.value");
    assert.strictEqual(pointee.runtimeStaticPointers, true);

    // Whole object when no expansions are given (setting off, sidebar).
    const whole = reader(pointee);
    const full = await whole.sample();
    assert.strictEqual(member(member(full, "inner"), "y").value, 2);
    assert.deepStrictEqual(
        member(full, "arr").elements.map((element) => element.value),
        [10, 20, 30]
    );
    assert.strictEqual(member(full, "next").value, base + 96, "nested raw pointers stay addresses");

    // Expanded-only: scalars of the opened root are read, closed composites are not.
    const rootOnly = reader({ ...pointee, runtimeExpanded: [""] });
    const opened = await rootOnly.sample();
    assert.strictEqual(member(opened, "a").value, 7);
    assert.deepStrictEqual(member(opened, "inner"), {
        name: "inner",
        kind: "class",
        typeName: "Inner",
        members: [],
        collapsed: true
    });
    assert.strictEqual(member(opened, "arr").collapsed, true);
    assert.strictEqual(member(opened, "arr").totalElements, 3);
    assert.ok(rootOnly.reads.length <= whole.reads.length);
    const inner = await reader({ ...pointee, runtimeExpanded: ["", ".inner", ".arr"] }).sample();
    assert.strictEqual(member(member(inner, "inner"), "x").value, 1);
    assert.strictEqual(member(inner, "arr").elements[2].value, 30);

    // A closed root costs no read of the target object.
    const closed = reader({ ...pointee, runtimeExpanded: [] });
    const stub = await closed.sample();
    assert.strictEqual(stub.collapsed, true);
    assert.ok(!closed.reads.some(([address]) => address >= base + 32), "a closed pointee is not read past its pointer");

    // Followed pointers (STL paths) keep their address until opened.
    const chased = { ...pointee, runtimeStaticPointers: undefined };
    const unopened = reader({ ...chased, runtimeExpanded: [""] });
    const pointer = member(await unopened.sample(), "next");
    assert.strictEqual(pointer.collapsed, true);
    assert.strictEqual(pointer.value, base + 96);
    assert.ok(!unopened.reads.some(([address]) => address >= base + 96), "the closed target is not read");
    const followed = member(await reader({ ...chased, runtimeExpanded: ["", ".next"] }).sample(), "next");
    assert.strictEqual(member(member(followed, "value"), "y").value, 200);
    assert.strictEqual(member(member(await reader(chased).sample(), "next"), "value").members[0].value, 100);

    // Recorded leaves follow the same rules on decoded trees.
    assert.deepStrictEqual(
        runtimeTreeLeaves(full).map((leaf) => leaf.path),
        [".a", ".inner.x", ".inner.y", ".next", ".arr[0]", ".arr[1]", ".arr[2]"]
    );
    const openedPaths = new Set(["", ".inner"]);
    assert.deepStrictEqual(
        runtimeTreeLeaves(full, (path) => openedPaths.has(path)).map((leaf) => leaf.path),
        [".a", ".inner.x", ".inner.y", ".next"],
        "a view records only its opened parts even when another consumer reads more"
    );
    const chasedFull = await reader(chased).sample();
    assert.deepStrictEqual(
        runtimeTreeLeaves(chasedFull, (path) => ["", ".next"].includes(path))
            .map((leaf) => leaf.path)
            .filter((path) => path.startsWith(".next")),
        [".next", ".next.value.x", ".next.value.y"]
    );
    assert.strictEqual(runtimeTreeLeaves(full, null, 2).length, 2, "leaf recording is bounded");

    // Read plan: one view's expansions, routes of charted members, and pointee roots.
    const watches = normalizeWatchList([{ name: "g.node.value" }, { name: "g.node.value.inner.x" }], [symbol]);
    assert.deepStrictEqual(
        watches.map((item) => [item.name, item.isComposite]),
        [
            ["g.node.value", true],
            ["g.node.value.inner.x", false]
        ]
    );
    const plan = buildActiveReadPlan([watches], elf, [{ "g.node.value": [".arr"] }]);
    assert.deepStrictEqual(
        plan.map((item) => item.name),
        ["g.node.value"],
        "a charted member is taken from its parent's tree"
    );
    assert.deepStrictEqual(plan[0].runtimeExpanded, ["", ".arr", ".inner", ".inner.x"]);
    assert.strictEqual(buildActiveReadPlan([watches], elf)[0].runtimeExpanded, undefined, "off reads everything");
    assert.strictEqual(
        buildActiveReadPlan([watches, [watches[0]]], elf, [{}])[0].runtimeExpanded,
        undefined,
        "a consumer reading the whole object wins"
    );
    assert.deepStrictEqual(
        buildActiveReadPlan([[watches[0]], [watches[0]]], elf, [
            { "g.node.value": [".inner"] },
            { "g.node.value": [".arr"] }
        ])[0].runtimeExpanded,
        ["", ".arr", ".inner"],
        "views sharing an object read the union"
    );
    assert.strictEqual(
        buildActiveReadPlan([[{ ...watches[0], runtimeExpanded: ["stale"] }]], elf)[0].runtimeExpanded,
        undefined,
        "stale masks on watch items never reach the reader"
    );

    // History leaves keep the identity of the explicit member watch they can become.
    const known = new Map();
    const service = new LiveWatchService(elf);
    const decoded = service.decodeConsumerSamples(
        [{ name: "g.node.value", runtimeTree: full, t: 5 }],
        5,
        new Map(),
        new Map([["g.node.value", { ...watches[0], layout: null }]])
    );
    const leaves = collectRuntimeHistoryLeaves(decoded.compositeSamples, [watches[0]], { "g.node.value": [] }, known);
    assert.ok(leaves.added);
    assert.deepStrictEqual(
        leaves.samples.map((sample) => [sample.name, sample.value, sample.t]),
        [
            ["g.node.value.a", 7, 5],
            ["g.node.value.next", base + 96, 5]
        ]
    );
    assert.strictEqual(
        collectRuntimeHistoryLeaves(decoded.compositeSamples, [watches[0]], { "g.node.value": [] }, known).added,
        false,
        "known leaves do not reconfigure history"
    );
    const merged = buildChartHistoryItems(watches, elf, [
        { name: "g.node.value.inner.x", type: "i32", address: base, runtimeOwner: "g.node.value" }
    ]);
    assert.strictEqual(merged.find((item) => item.name === "g.node.value.inner.x").runtimeOwner, "g.node.value");
    assert.deepStrictEqual(
        buildChartHistoryItems([watches[1]], elf, [
            { name: "g.node.value.a", type: "i32", runtimeOwner: "g.node.value" }
        ]),
        [watches[1]],
        "leaves of a removed runtime object are dropped"
    );

    // Host: expanded-only records opened parts; off records everything parsed; both reach the archive.
    const Provider = loadProvider({});
    const p = Object.create(Provider.prototype);
    const store = new ChartHistoryStore();
    const state = new Map([["liveWatch.runtimeExpansions", { w: { "g.node.value": [""] } }]]);
    let panelWatches = [watches[0]];
    const entry = { watchKey: "w", latestSamples: new Map(), ready: true, post() {} };
    const archive = [];
    p._livePanels = new Map([[1, entry]]);
    p._scalarWatchList = (key) => (key === "w" ? panelWatches : []);
    p._context = {
        workspaceState: { get: (key) => state.get(key), update: async (key, value) => state.set(key, value) }
    };
    p._debugSamplingScope = (key) => key;
    p._liveWatchService = service;
    p._latestSidebarSamples = new Map();
    p._chartHistory = { request: async (method, args) => store[method](...args), fail: assert.fail };
    p._samplingArchive = { append: (samples) => archive.push(samples.map((sample) => sample.name).sort()) };
    p._postWebviewBatch = () => {};
    p._postSidebarBatch = () => {};
    p._pointerExpandedOnly = true;
    const consumers = { graphNames: ["g.node.value"], sidebarNames: [] };
    p._handleRawSamples([{ name: "g.node.value", runtimeTree: full, t: 1000 }], 1000, consumers);
    assert.deepStrictEqual(archive.at(-1), ["g.node.value.a [i32]", "g.node.value.next [u32]"]);
    state.set("liveWatch.runtimeExpansions", { w: { "g.node.value": ["", ".inner"] } });
    p._handleRawSamples([{ name: "g.node.value", runtimeTree: full, t: 1010 }], 1010, consumers);
    assert.deepStrictEqual(archive.at(-1), [
        "g.node.value.a [i32]",
        "g.node.value.inner.x [i32]",
        "g.node.value.inner.y [i32]",
        "g.node.value.next [u32]"
    ]);
    p._pointerExpandedOnly = false;
    p._handleRawSamples([{ name: "g.node.value", runtimeTree: full, t: 1020 }], 1020, consumers);
    assert.strictEqual(archive.at(-1).length, 7, "off records every parsed scalar");
    await p._flushPendingChartHistorySamples();
    assert.strictEqual(store.scopes.get("w").series.get("g.node.value.a").count, 3);
    assert.strictEqual(entry.historyItems.find((item) => item.name === "g.node.value.arr[2]").historyFromMs, 1020);
    // Charting a recorded member keeps its history.
    panelWatches = watches;
    p._configureChartHistory(entry, 2000);
    assert.strictEqual(entry.historyItems.find((item) => item.name === "g.node.value.inner.x").historyFromMs, 1010);
    assert.strictEqual(store.scopes.get("w").series.get("g.node.value.inner.x").count, 2);
    panelWatches = [];
    p._configureChartHistory(entry, 3000);
    assert.strictEqual(entry.runtimeHistoryLeaves.size, 0, "removing the object releases its recorded leaves");

    // Workspace persistence of the switch and of each view's expansions.
    const posted = [];
    entry.post = (message) => posted.push(message);
    let refreshes = 0;
    p._refreshSamplingPlan = async () => refreshes++;
    await p._setPointerExpandedOnly(true);
    assert.strictEqual(state.get("liveWatch.pointerExpandedOnly"), true);
    assert.deepStrictEqual(posted.at(-1), { type: "pointerSampling", expandedOnly: true });
    assert.strictEqual(refreshes, 1);
    await p._setPointerExpandedOnly(true);
    assert.strictEqual(refreshes, 1, "an unchanged mode keeps the plan");
    await assert.rejects(p._setPointerExpandedOnly("yes"), { code: "INVALID_PARAMS" });
    await p._saveRuntimeExpansions("w", { "g.node.value": [".arr", ""] });
    assert.deepStrictEqual(state.get("liveWatch.runtimeExpansions").w, { "g.node.value": ["", ".arr"] });
    assert.strictEqual(refreshes, 2);
    await p._saveRuntimeExpansions("w", { "g.node.value": ["", ".arr"] });
    assert.strictEqual(refreshes, 2, "unchanged expansions keep the plan");
    await assert.rejects(p._saveRuntimeExpansions("w", { "g.node.value": ["arr"] }), { code: "INVALID_ARGUMENT" });
    await p._setPointerExpandedOnly(false);
    assert.deepStrictEqual(p._panelRuntimeExpansions("w"), null);
    await p._saveRuntimeExpansions("w", { "g.node.value": [""] });
    assert.strictEqual(refreshes, 3, "expansions only change reads while the switch is on");
    const restored = Object.create(Provider.prototype);
    restored._context = p._context;
    assert.deepStrictEqual(restored._runtimeExpansions("w"), { "g.node.value": [""] });
    assert.deepStrictEqual(restored._runtimeExpansions("other"), {});

    // Webview: the switch, closed rows, and expansions sent to the host.
    const view = render(getLiveWatchContent({}, "en"));
    try {
        const sent = (type) => view.messages.filter((message) => message.type === type);
        assert.strictEqual(sent("saveRuntimeExpansions").length, 0, "nothing is sent before the host's list");
        view.send({ type: "pointerSampling", expandedOnly: false });
        const toggle = view.document.getElementById("pointerExpandedOnly");
        assert.strictEqual(toggle.checked, false);
        toggle.checked = true;
        toggle.dispatchEvent(new view.window.Event("change"));
        assert.deepStrictEqual(sent("setPointerExpandedOnly").at(-1).enabled, true);
        view.send({ type: "watchList", items: [watches[0]] });
        assert.deepStrictEqual(sent("saveRuntimeExpansions").at(-1).expansions, { "g.node.value": [""] });
        view.send({ type: "liveCompositeSample", samples: [{ name: "g.node.value", tree: opened }] });
        const notes = [...view.document.querySelectorAll(".comp-note")].map((note) => note.textContent);
        assert.ok(notes.includes("Sampling starts when expanded"), notes.join("|"));
        const head = [...view.document.querySelectorAll(".comp-nest > .comp-head")].find(
            (node) => node.querySelector(".comp-name")?.textContent === "inner"
        );
        head.click();
        assert.deepStrictEqual(sent("saveRuntimeExpansions").at(-1).expansions, {
            "g.node.value": ["", ".inner"]
        });
        const count = sent("saveRuntimeExpansions").length;
        view.send({ type: "liveCompositeSample", samples: [{ name: "g.node.value", tree: inner }] });
        assert.strictEqual(sent("saveRuntimeExpansions").length, count, "unchanged expansions are not resent");
        view.send({ type: "liveCompositeSample", samples: [{ name: "g.node.value", tree: chasedFull }] });
        view.send({
            type: "liveCompositeSample",
            samples: [{ name: "g.node.value", tree: await reader({ ...chased, runtimeExpanded: [""] }).sample() }]
        });
        const pointerToggle = view.document.querySelector('.pointer-toggle[data-path="g.node.value.next"]');
        assert.ok(pointerToggle, "a closed followed pointer keeps its disclosure");
        pointerToggle.click();
        assert.ok(sent("saveRuntimeExpansions").at(-1).expansions["g.node.value"].includes(".next"));
        view.assertHealthy();
    } finally {
        view.close();
    }
    console.log("Expanded-only pointer sampling, recording, persistence and view tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
