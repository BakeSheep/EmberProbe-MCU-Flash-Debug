"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const elf = require("../src/elfSymbols");
const { normalizeWatchList } = require("../src/validation");
const { LiveWatchService, buildActiveReadPlan, buildChartHistoryItems } = require("../src/services/liveWatchService");
const { MAX_LAYOUT_EXPANSIONS, MAX_LAYOUT_EXPANSION_BYTES } = require("../src/services/elfService");
const { WriteAuthorization, fingerprintWritePlan } = require("../src/writeAuthorization");
const { WatchListStore } = require("../src/services/watchListStore");
const { loadProvider } = require("./helpers/load-provider");
const { buildElf32 } = require("./helpers/elf-fixture");
const { fixture, handle, scalar, runtimeGraph } = require("./helpers/layout-expansion-fixture");
(async () => {
    const f = fixture();
    const branchPath = "axes[0].a.b";
    const gain = branchPath + ".gain";
    const leaves = (name) => elf.expandCompositeLeaves(f.symbol, f.layout, elf.parseMemberPath(name));
    assert.deepStrictEqual(leaves(gain), []);
    assert.deepStrictEqual(normalizeWatchList([{ name: gain, address: 1 }], [f.symbol]), []);
    const before = JSON.stringify(f.layout);
    let requests = 0,
        release;
    f.service.expandLayout = () => {
        requests++;
        return new Promise((resolve) => {
            release = resolve;
        });
    };
    const first = f.service.expandSymbolLayout("axes", branchPath, handle(), f.generation);
    const duplicate = f.service.expandSymbolLayout("axes", branchPath, handle(), f.generation);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(requests, 1, "host also de-duplicates in-flight requests");
    release(f.sublayout);
    assert.strictEqual(await first, await duplicate);
    assert.strictEqual(JSON.stringify(f.layout), before, "bounded root remains unchanged");
    const leaf = leaves(gain)[0];
    assert.strictEqual(leaf.address, f.symbol.address + 12 + 16 + 20 + 4);
    assert.strictEqual(leaf.type, "f32");
    assert.strictEqual(leaf.layoutExpanded, true);
    assert.deepStrictEqual(leaves("axes[1].a.b.gain"), [], "array elements have independent expansion maps");
    const watches = normalizeWatchList([{ name: gain, address: 1, type: "u8" }, { name: "axes" }], [f.symbol]);
    assert.strictEqual(watches[0].address, leaf.address, "ignore caller-supplied addresses/types");
    assert.strictEqual(watches[0].type, "f32");
    const plan = buildActiveReadPlan([watches], elf);
    assert.deepStrictEqual(
        plan.find((item) => item.name === gain),
        { name: gain, address: leaf.address, size: 4 }
    );
    assert.strictEqual(plan.find((item) => item.name === "axes").size, 256);
    const bytes = Buffer.alloc(256);
    bytes.writeFloatLE(3.5, leaf.address - f.symbol.address);
    const tree = elf.decodeComposite(bytes, f.layout, f.symbol);
    assert.strictEqual(elf.navigateCompositeTree(tree, elf.parseMemberPath(gain)).value, 3.5);
    const consumer = new LiveWatchService(elf);
    const compositeMap = new Map([["axes", { ...watches[1], layout: f.layout }]]);
    const decoded = consumer.decodeConsumerSamples([{ name: "axes", bytes }], 100, new Map(), compositeMap);
    assert.strictEqual(
        elf.navigateCompositeTree(decoded.compositeSamples[0].tree, elf.parseMemberPath(gain)).value,
        3.5
    );
    const history = buildChartHistoryItems(watches, elf);
    const historical = consumer.decodeHistorySamples([{ name: "axes", bytes }], 100, history);
    assert.strictEqual(historical.find((item) => item.name === gain).value, 3.5);

    f.service.expandLayout = async () => f.nested;
    const nestedPath = branchPath + ".c";
    assert.deepStrictEqual(leaves(nestedPath + ".@base0.gain"), []);
    await f.service.expandSymbolLayout("axes", nestedPath, handle("Mg"), f.generation);
    const nestedLeaf = leaves(nestedPath + ".@base0.gain")[0];
    assert.strictEqual(nestedLeaf.address, f.symbol.address + 12 + 16 + 20 + 8 + 4 + 4);
    bytes.writeFloatLE(7.25, nestedLeaf.address - f.symbol.address);
    assert.strictEqual(
        elf.navigateCompositeTree(elf.decodeComposite(bytes, f.layout, f.symbol), elf.parseMemberPath(nestedLeaf.path))
            .value,
        7.25
    );
    assert.deepStrictEqual(leaves(branchPath + ".cycle"), []);
    assert.strictEqual(
        elf.resolveLayoutPath(f.symbol, f.layout, elf.parseMemberPath(nestedLeaf.path)).usedExpansion,
        true
    );
    f.symbol.runtimeLayout = runtimeGraph();
    const runtimeWatches = normalizeWatchList([{ name: gain }, { name: "axes" }], [f.symbol]);
    assert.strictEqual(
        runtimeWatches[0].address,
        leaf.address,
        "a verified expanded static leaf can be watched under a semantic STL root"
    );
    assert.strictEqual(runtimeWatches[1].layoutExpansions, f.symbol.layoutExpansions);
    const runtimePlan = buildActiveReadPlan([runtimeWatches], elf);
    assert.deepStrictEqual(
        runtimePlan.find((item) => item.name === gain),
        {
            name: gain,
            address: leaf.address,
            size: 4
        }
    );
    const runtimeRoot = runtimePlan.find((item) => item.name === "axes");
    assert(runtimeRoot.runtimeLayout);
    assert(!runtimeRoot.layoutExpansions && !runtimeRoot.compositeLayout, "static metadata stays out of runtime reads");
    const rawProvider = Object.create(loadProvider().prototype);
    rawProvider.readElfSymbols = () => f.service.cache;
    rawProvider._prepareRequestedLayouts = async () => {};
    rawProvider._scalarWatchList = () => [];
    rawProvider._focusedLivePanel = () => null;
    let addedStatic;
    rawProvider._saveWatchList = async (_key, items) => {
        addedStatic = normalizeWatchList(items, [f.symbol]);
    };
    const added = await rawProvider._addAgentWatch({ variables: [gain] });
    assert.deepStrictEqual(added.sidebar.added, [gain]);
    assert.strictEqual(addedStatic[0].address, leaf.address);
    assert.strictEqual(addedStatic[0].staticRuntimeStorage, true);
    const rawPlan = rawProvider._agentVariablePlan({ variables: [gain] });
    assert.strictEqual(rawPlan.plan.length, 1);
    assert.strictEqual(rawPlan.plan[0].address, leaf.address);
    assert.strictEqual(rawPlan.plan[0].size, 4, "Bridge reads only the validated leaf bytes");
    const rawSample = rawProvider._decodeAgentSample(
        rawPlan.plan,
        [{ name: gain, bytes: bytes.subarray(52, 56) }],
        rawPlan.compositePlan
    );
    assert.strictEqual(rawSample.values[gain].value, 3.5);
    delete f.symbol.runtimeLayout;
    f.layout.elementType.isConst = true;
    assert.strictEqual(leaves(gain)[0].isConst, true, "array and ancestor qualifiers survive subroots");
    delete f.layout.elementType.isConst;

    // Anonymous expanded branches retain their canonical identity in decoded trees.
    const anonymous = fixture();
    anonymous.branch.name = "";
    await anonymous.service.expandSymbolLayout("axes", "axes[0].a.?", handle(), 7);
    const anonymousPath = "axes[0].a.?.gain";
    const anonymousLeaf = elf.expandedStaticLeaves(anonymous.symbol, elf.parseMemberPath(anonymousPath))[0];
    assert.strictEqual(anonymousLeaf.address, anonymous.symbol.address + 52);
    const anonymousTree = elf.decodeComposite(bytes, anonymous.layout, anonymous.symbol);
    const anonymousBranch = elf.navigateCompositeTree(anonymousTree, elf.parseMemberPath("axes[0].a.?"));
    assert.strictEqual(anonymousBranch.expansionRoot, true);
    assert.strictEqual(elf.navigateCompositeTree(anonymousTree, elf.parseMemberPath(anonymousPath)).value, 3.5);

    // A truncated array element expands only at the requested concrete index.
    const array = fixture();
    array.layout.elementType = {
        kind: "class",
        byteSize: 128,
        unobservable: "expansion-budget",
        expansionHandle: handle()
    };
    array.service.expandLayout = async () => ({
        kind: "class",
        byteSize: 128,
        expansionGeneration: 7,
        members: [scalar("value", 8)]
    });
    await array.service.expandSymbolLayout("axes", "axes[1]", handle(), 7);
    const arrayLeaves = elf.expandCompositeLeaves(array.symbol, array.layout);
    assert.strictEqual(arrayLeaves.length, 1);
    assert.strictEqual(arrayLeaves[0].address, array.symbol.address + 128 + 8);
    const arrayTree = elf.decodeComposite(bytes, array.layout, array.symbol);
    assert.strictEqual(arrayTree.elements[0].index, 1);
    assert(!arrayTree.unobservable, "an expanded array element remains visible in the decoded tree");

    // An unavailable million-element branch must not hide a shallow sibling.
    const sparse = fixture();
    const count = 1000000;
    const hugeArray = {
        kind: "array",
        byteSize: count * 4,
        totalElements: count,
        elementType: { kind: "class", byteSize: 4, unobservable: "depth-limit", expansionHandle: handle() }
    };
    sparse.symbol.size = count * 4 + 4;
    sparse.symbol.compositeLayout = {
        kind: "class",
        byteSize: sparse.symbol.size,
        expansionGeneration: 7,
        members: [
            { name: "large", offset: 0, byteSize: count * 4, compositeLayout: hugeArray },
            scalar("healthy", count * 4)
        ]
    };
    sparse.service.expandLayout = async () => ({
        kind: "class",
        byteSize: 4,
        expansionGeneration: 7,
        members: [scalar("value")]
    });
    await sparse.service.expandSymbolLayout("axes", "axes.large[999999]", handle(), 7);
    const sparseLeaves = elf.expandCompositeLeaves(sparse.symbol, sparse.symbol.compositeLayout);
    assert.deepStrictEqual(
        sparseLeaves.map((entry) => entry.path),
        ["axes.large[999999].value", "axes.healthy"]
    );
    assert.strictEqual(sparseLeaves[0].address, sparse.symbol.address + 999999 * 4);
    const sparseTree = elf.decodeComposite(
        Buffer.alloc(sparse.symbol.size),
        sparse.symbol.compositeLayout,
        sparse.symbol
    );
    assert.strictEqual(sparseTree.members[0].elements.length, 1);
    assert.strictEqual(sparseTree.members[1].value, 0);

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-layout-writes-"));
    try {
        const file = path.join(temp, "firmware.elf");
        const image = buildElf32({
            sections: [{ name: ".data", flags: 3, addr: f.symbol.address, data: Buffer.alloc(256) }]
        });
        fs.writeFileSync(file, image);
        f.service.cache.elf.path = file;
        f.service.cache.memory = elf.parseElfSections(image);
        const provider = Object.create(loadProvider().prototype);
        Object.assign(provider, { _elfService: f.service, readElfSymbols: () => f.service.cache });
        const write = (value) => provider._agentWritePlan([{ name: gain, value }], { refreshSymbols: false });
        const valid = write(2);
        valid.connection = { kind: "dap", sessionId: "test-session", stopEpoch: 1 };
        assert.strictEqual(valid.items[0].address, leaf.address);
        const authorization = new WriteAuthorization({ get: () => null, update: async () => {} });
        const response = authorization.authorize(valid, {});
        assert.strictEqual(response.authorized, false, "expanded writes still require confirmation");
        assert.strictEqual(
            authorization.authorize(valid, { confirmationId: response.response.confirmationId }).authorized,
            true
        );
        const denied = authorization.authorize(valid, {});
        const changed = write(3);
        changed.connection = valid.connection;
        assert.throws(() => authorization.authorize(changed, { confirmationId: denied.response.confirmationId }), {
            code: "WRITE_CONFIRMATION_INVALID"
        });
        assert.notStrictEqual(fingerprintWritePlan(valid), fingerprintWritePlan(write(3)));
        assert.throws(
            () => provider._agentWritePlan([{ name: "axes[1].a.b.gain", value: 2 }], { refreshSymbols: false }),
            { code: "INVALID_VARIABLE_PATH" }
        );
        f.sublayout.isConst = true;
        assert.throws(() => write(2), { code: "WRITE_NOT_ALLOWED" });
        delete f.sublayout.isConst;
        f.symbol.runtimeLayout = { root: 0, types: [] };
        assert.strictEqual(
            write(2).items[0].address,
            leaf.address,
            "a pointer/STL elsewhere in the type graph keeps fixed user members writable"
        );
        const userTypeName = f.sublayout.typeName;
        f.sublayout.typeName = "class std::array<float, 4>";
        assert.throws(() => write(2), { code: "WRITE_NOT_ALLOWED" }, "members inside std:: objects stay read-only");
        f.sublayout.typeName = userTypeName;
        delete f.symbol.runtimeLayout;

        // Persist only identity/invalid-watch markers, and re-resolve after reload.
        assert.deepStrictEqual(
            provider._watchIdentities([{ ...watches[0], min: -1, max: 2, value: 0 }]),
            [{ name: gain, type: "f32", layoutExpanded: true, min: -1, max: 2, value: 0 }],
            "identity persistence retains user write controls without derived addresses/layouts"
        );
        const saved = new Map();
        const state = { get: (key) => saved.get(key), update: async (key, value) => saved.set(key, value) };
        provider._context = { workspaceState: state };
        provider._watchLists = new WatchListStore({
            state,
            normalize: normalizeWatchList,
            serialize: (items) => provider._watchIdentities(items),
            symbols: () => [f.symbol],
            onChanged() {},
            onError() {}
        });
        Object.assign(provider, {
            _latestSidebarSamples: new Map(),
            _livePanels: new Map(),
            _refreshSamplingPlan: async () => {},
            _syncSidebarTarget() {},
            _syncGraphTarget() {},
            _pruneSampleMap() {}
        });
        await provider._saveWatchList("mcu.sidebarWatchList", watches);
        const persisted = saved.get("mcu.sidebarWatchList");
        assert.deepStrictEqual(persisted, [
            { name: gain, type: "f32", layoutExpanded: true },
            { name: "axes", type: "" }
        ]);
        assert(!JSON.stringify(persisted).includes("layout:"));
        assert(!persisted[0].address && !persisted[1].compositeLayout);
        await provider._watchLists.rebind(["mcu.sidebarWatchList"], [f.symbol]);
        assert(
            !JSON.stringify(saved.get("mcu.sidebarWatchList")).includes("layout:"),
            "rebind also persists identities only"
        );
        const notices = [];
        provider._postLive = (message) => notices.push(message);
        f.service.invalidate();
        assert.deepStrictEqual(
            normalizeWatchList(persisted, [f.symbol]).filter((item) => item.name === gain),
            []
        );
        await provider._rebindWatchLists([f.symbol]);
        assert.strictEqual(notices.at(-1).key, "lw.layoutWatchInvalid");
        assert.match(notices.at(-1).params.names, /axes\[0\]\.a\.b\.gain/);
        const fresh = {
            ...f.symbol,
            address: f.symbol.address + 0x1000,
            compositeLayout: JSON.parse(JSON.stringify(f.layout))
        };
        delete fresh.layoutExpansions;
        delete fresh.layoutExpansionGeneration;
        fresh.compositeLayout.expansionGeneration = f.service.generation;
        const freshParent = fresh.compositeLayout.elementType.compositeLayout.members[0].compositeLayout.members[0];
        freshParent.compositeLayout.members[0] = {
            name: "b",
            offset: 20,
            byteSize: 32,
            compositeLayout: { kind: "class", byteSize: 32, members: [scalar("gain", 4)] }
        };
        saved.set("mcu.sidebarWatchList", persisted);
        const rebound = await provider._rebindWatchLists([fresh]);
        const freshLeaf = rebound.rebound.get("mcu.sidebarWatchList").find((item) => item.name === gain);
        assert.strictEqual(
            freshLeaf.address,
            fresh.address + 52,
            "fresh metadata rebinds without replaying an address"
        );
        assert(!saved.get("mcu.sidebarWatchList")[0].address);
        assert.strictEqual(notices.length, 1, "a safely re-resolved path survives reload without an invalid notice");
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }

    // Both a count cap and a serialized metadata cap apply across recursive requests.
    const capped = fixture();
    capped.symbol.compositeLayout = {
        kind: "class",
        byteSize: 256,
        expansionGeneration: 7,
        members: Array.from({ length: MAX_LAYOUT_EXPANSIONS + 1 }, (_, i) => ({
            name: "f" + i,
            offset: i * 4,
            byteSize: 4,
            kind: "class",
            unobservable: "depth-limit",
            expansionHandle: handle()
        }))
    };
    capped.service.expandLayout = async () => ({
        kind: "class",
        byteSize: 4,
        expansionGeneration: 7,
        members: [scalar("value")]
    });
    for (let i = 0; i < MAX_LAYOUT_EXPANSIONS; i++)
        await capped.service.expandSymbolLayout("axes", "axes.f" + i, handle(), 7);
    await assert.rejects(capped.service.expandSymbolLayout("axes", "axes.f32", handle(), 7), {
        code: "LAYOUT_EXPANSION_LIMIT"
    });
    await capped.service.expandSymbolLayout("axes", "axes.f0", handle(), 7);
    capped.service.invalidate();
    assert.strictEqual(Object.keys(capped.symbol.layoutExpansions).length, 0);
    assert.strictEqual(capped.service.symbolExpansionBytes.size, 0);
    const metadata = fixture();
    metadata.symbol.compositeLayout = { ...capped.symbol.compositeLayout };
    const big = {
        kind: "class",
        byteSize: 4,
        expansionGeneration: 7,
        members: [scalar("value")],
        typeName: "x".repeat(3 * 1024 * 1024)
    };
    metadata.service.expandLayout = async () => big;
    await metadata.service.expandSymbolLayout("axes", "axes.f0", handle(), 7);
    await metadata.service.expandSymbolLayout("axes", "axes.f1", handle(), 7);
    await assert.rejects(metadata.service.expandSymbolLayout("axes", "axes.f2", handle(), 7), {
        code: "LAYOUT_EXPANSION_LIMIT"
    });
    assert(metadata.service.symbolExpansionBytes.get("axes") <= MAX_LAYOUT_EXPANSION_BYTES);
    console.log("Detached layout address, read/watch/decode, recursive budgets and typed write tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
