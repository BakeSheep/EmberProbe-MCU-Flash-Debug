"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ElfService } = require("../src/services/elfService");
const elfSymbols = require("../src/elfSymbols");

(async () => {
    const Provider = loadProvider();
    const provider = Object.create(Provider.prototype);
    let planned = false;
    provider._elfService = {
        ready: async () => {
            throw Object.assign(new Error("DWARF type information is unavailable"), { code: "DWARF_PARSE_FAILED" });
        }
    };
    provider._agentWritePlan = () => {
        planned = true;
    };
    await assert.rejects(provider._writeAgentVariables({ values: [{ name: "value", value: 1 }] }), {
        code: "DWARF_PARSE_FAILED"
    });
    assert.strictEqual(planned, false, "writes must stop before planning when DWARF is unavailable");
    delete provider._agentWritePlan;
    provider.readElfSymbols = () => ({
        elf: { path: "missing" },
        symbols: [
            { name: "flag", address: 0x20000000, size: 1, watchType: "u8", hasDwarfWriteType: true, isBoolean: true },
            {
                name: "group",
                address: 0x20000001,
                size: 1,
                isComposite: true,
                compositeLayout: {
                    kind: "struct",
                    byteSize: 1,
                    members: [{ name: "enabled", offset: 0, byteSize: 1, watchType: "u8", isBoolean: true }]
                }
            }
        ]
    });
    for (const name of ["flag", "group.enabled"])
        assert.throws(() => provider._agentWritePlan([{ name, value: 2 }], { refreshSymbols: false }), {
            code: "INVALID_WRITE_VALUE"
        });
    assert.throws(() => provider._agentWritePlan([{ name: "flag", value: 1 }], { refreshSymbols: false }), {
        code: "WRITE_NOT_ALLOWED"
    });
    const CachedProvider = loadProvider(
        {},
        {
            fs: { readFileSync: () => assert.fail("write planning must reuse cached ELF sections") },
            "./elfSymbols": {
                ...elfSymbols,
                parseElfSections: () => assert.fail("write planning must not reparse sections")
            }
        }
    );
    const cached = Object.create(CachedProvider.prototype);
    let stat = { mtimeMs: 10, size: 64 * 1024 * 1024 };
    const service = new ElfService({
        context: { workspaceState: { get: () => "firmware.elf" } },
        cacheKey: "elf",
        fs: { statSync: () => stat },
        cleanPath: (value) => value,
        workerPath: "unused-worker.js"
    });
    const result = {
        elf: { path: "firmware.elf", ...stat, sha256: "cached-identity" },
        memory: {
            sections: [
                { name: ".data", flags: 3, addr: 0x20000000, size: 16 },
                { name: ".bss", flags: 3, addr: 0x20000020, size: 16 },
                { name: ".rodata", flags: 2, addr: 0x20000040, size: 16 },
                { name: ".unallocated", flags: 1, addr: 0x20000060, size: 16 },
                { name: ".empty", flags: 3, addr: 0x20000080, size: 0 }
            ]
        },
        symbols: [0, 0x20, 0x40, 0x60, 0x80].map((offset, i) => ({
            name: "value" + i,
            address: 0x20000000 + offset,
            size: 4,
            watchType: "u32",
            hasDwarfWriteType: true
        }))
    };
    service.cache = result;
    cached._elfService = service;
    cached.readElfSymbols = () => service.read();
    for (const name of ["value0", "value1"]) {
        const plan = cached._agentWritePlan([{ name, value: 42 }], { refreshSymbols: false });
        assert.strictEqual(plan.elfResult, result, "the plan retains the same identity-checked ELF result");
        assert.strictEqual(plan.items[0].value, 42);
        assert.strictEqual(plan.items[0].address, result.symbols.find((symbol) => symbol.name === name).address);
    }
    for (const name of ["value2", "value3", "value4"])
        assert.throws(() => cached._agentWritePlan([{ name, value: 42 }], { refreshSymbols: false }), {
            code: "WRITE_NOT_ALLOWED"
        });
    const memory = result.memory;
    delete result.memory;
    assert.throws(() => cached._agentWritePlan([{ name: "value0", value: 42 }], { refreshSymbols: false }), {
        code: "WRITE_NOT_ALLOWED"
    });
    result.memory = memory;
    stat = { ...stat, mtimeMs: 11 };
    service.load = async () => {};
    assert.throws(() => cached._agentWritePlan([{ name: "value0", value: 42 }], { refreshSymbols: false }), {
        code: "ELF_CHANGED"
    });

    const symbols = [
        { name: "raw", displayName: "app::value" },
        { name: "app::value", displayName: "other" },
        { name: "raw2", displayName: "ambiguous" },
        { name: "raw3", displayName: "ambiguous" }
    ];
    const firstIndex = cached._symbolNameIndex(symbols);
    assert.strictEqual(firstIndex.get("app::value"), symbols[1], "raw symbol identity takes precedence over aliases");
    assert.strictEqual(firstIndex.has("ambiguous"), false);
    assert.strictEqual(cached._symbolNameIndex(symbols), firstIndex, "unchanged symbol arrays reuse the index");
    symbols.push({ name: "new", displayName: "new::value" });
    const larger = cached._symbolNameIndex(symbols);
    assert.notStrictEqual(larger, firstIndex);
    assert.strictEqual(larger.get("new::value"), symbols[4]);
    const changed = { symbols, elf: { sha256: "new-identity" }, warnings: [] };
    cached._livePanels = new Map();
    symbols[0].displayName = "enriched::value";
    cached._onElfChange("types", changed, [symbols[0]]);
    const enriched = cached._symbolNameIndex(symbols);
    assert.notStrictEqual(enriched, larger, "in-place DWARF display-name enrichment invalidates the cache");
    assert.strictEqual(enriched.get("enriched::value"), symbols[0]);
    cached._hydrateSelectedLayouts = async () => {};
    cached._rebindWatchLists = async () => {};
    cached._syncSidebarTarget = () => {};
    cached._refreshSamplingPlan = async () => {};
    cached._onElfChange("dwarfReady", changed);
    await cached._elfRebindPromise;
    assert.notStrictEqual(cached._symbolNameIndex(symbols), enriched, "DWARF completion also invalidates the index");

    await scenario("Reject bitfield write plans", async () => {
        const symbol = { name: "sensor", address: 0x20000000, size: 4 };
        const layout = {
            kind: "struct",
            byteSize: 4,
            members: [{ name: "x", offset: 0, byteSize: 4, watchType: "u32" }]
        };
        const Provider = loadProvider();
        const provider = Object.create(Provider.prototype);
        provider._elfService = { invalidate() {} };
        provider.readElfSymbols = () => ({
            elf: { path: "missing" },
            symbols: [
                {
                    ...symbol,
                    isComposite: true,
                    compositeLayout: { ...layout, members: [{ ...layout.members[0], bitSize: 4, bitOffset: 0 }] }
                }
            ]
        });
        assert.throws(() => provider._agentWritePlan([{ name: "sensor.x", value: 1 }]), /Bitfield writes/);
    });

    await scenario("Reject denied or changed-image writes after human approval", async () => {
        const { ProbeCoordinator } = require("../src/probeCoordinator");
        const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
        const { DebugLifecycle } = require("../src/services/debugLifecycle");
        function providerFixture() {
            const sessions = [],
                statuses = [];
            class Session {
                constructor(_vscode, _options, events) {
                    this.events = events;
                    sessions.push(this);
                }
                setWatch() {}
                setSamplingEnabled(value) {
                    this.enabled = value;
                }
                async start() {
                    this.started = true;
                }
                async stop() {
                    return true;
                }
            }
            const P = loadProvider(
                { debug: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
                { "./liveWatch": { LiveWatchSession: Session } }
            );
            const p = Object.create(P.prototype);
            Object.assign(p, {
                _probeCoordinator: new ProbeCoordinator(),
                _samplingCoordinator: new SamplingCoordinator(),
                _debugLifecycle: new DebugLifecycle(),
                _probeConnectionService: { prepare: async () => ({}) },
                _debugBridge: { setIntent() {}, agentStatus: () => ({ state: "inactive" }) },
                _context: { workspaceState: { get: () => "configured" } },
                _liveConsumers: new Set(),
                _activeReadPlan: () => [{ name: "tick", address: 0x20000000, size: 4 }],
                _setLiveInterval() {},
                _commandContext: () => ({}),
                _t: (key) => key,
                _resolveTclPort: async () => 1234,
                _resolveOpenOcdPath: async () => "fake",
                _postConsumerStatuses: (status) => statuses.push(status),
                _postLive() {},
                _postAgentSampling() {},
                _handleRawSamples: () => {
                    throw Error("Late sample accepted");
                }
            });
            return { p, sessions, statuses };
        }
        const variable = providerFixture().p;
        let identity = "before",
            attemptedWrites = 0;
        variable._prepareRequestedLayouts = async () => {};
        variable._agentWritePlan = () => ({
            elfResult: { elf: { path: "firmware.elf", sha256: identity } },
            items: [{ name: "x", address: 0x20000000, size: 4, type: "u32", value: 1, bytes: [1, 0, 0, 0] }]
        });
        variable._prepareWriteConnection = async () => ({
            kind: "dap",
            sessionId: "debug",
            workspace: "workspace",
            stopEpoch: 1
        });
        variable._writeAuthorization = { authorize: () => ({ authorized: true }) };
        variable._executeWritePlan = async () => {
            attemptedWrites++;
        };
        variable._humanApproval = {
            approve: async () => {
                throw Object.assign(Error("denied"), { code: "HUMAN_APPROVAL_DENIED" });
            }
        };
        await assert.rejects(variable._writeAgentVariables({ values: [] }), { code: "HUMAN_APPROVAL_DENIED" });
        variable._humanApproval.approve = async () => {
            identity = "after";
            return { remember: false };
        };
        await assert.rejects(variable._writeAgentVariables({ values: [] }), { code: "WRITE_CONFIRMATION_INVALID" });
        assert.strictEqual(attemptedWrites, 0);
    });

    await scenario("Reject const scalar and const composite member write plans", async () => {
        const c = require("../src/dwarf/constants");
        const { buildCompositeLayouts } = require("../src/dwarf/types");
        const dies = new Map([
            [1, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 }],
            [2, { tag: c.DW_TAG_reference_type, typeRef: 1 }],
            [3, { tag: c.DW_TAG_rvalue_reference_type, typeRef: 1 }],
            [4, { tag: c.DW_TAG_ptr_to_member_type, typeRef: 1 }],
            [5, { tag: c.DW_TAG_base_type, name: "char16_t", encoding: c.DW_ATE_UTF, byteSize: 2 }],
            [6, { tag: c.DW_TAG_const_type, typeRef: 1 }],
            [10, { tag: c.DW_TAG_structure_type, name: "Data", byteSize: 6 }],
            [11, { tag: c.DW_TAG_member, name: "ch", typeRef: 5, memberOffset: 0 }],
            [12, { tag: c.DW_TAG_member, name: "ro", typeRef: 6, memberOffset: 2 }]
        ]);
        const parsed = {
            dies,
            childrenMap: new Map([[10, [11, 12]]]),
            variables: [
                { name: "lref", typeRef: 2 },
                { name: "rref", typeRef: 3 },
                { name: "pmem", typeRef: 4 },
                { name: "cval", typeRef: 6 },
                { name: "data", typeRef: 10 }
            ]
        };
        const dataLayout = buildCompositeLayouts(parsed).get("data");
        // 验证 _agentWritePlan 对 const 变量及 const 复合成员的写入拦截
        const Provider = loadProvider();
        const provider = Object.create(Provider.prototype);
        provider.readElfSymbols = () => ({
            elf: { path: "dummy" },
            symbols: [
                {
                    name: "constScalar",
                    address: 0x20000000,
                    size: 4,
                    watchType: "u32",
                    hasDwarfWriteType: true,
                    isConst: true
                },
                {
                    name: "data",
                    address: 0x20000010,
                    size: 6,
                    isComposite: true,
                    compositeLayout: dataLayout
                }
            ]
        });

        assert.throws(
            () => provider._agentWritePlan([{ name: "constScalar", value: 1 }], { refreshSymbols: false }),
            (err) => err.code === "WRITE_NOT_ALLOWED" && /const \/ read-only/.test(err.message),
            "const scalar must reject write plan"
        );

        assert.throws(
            () => provider._agentWritePlan([{ name: "data.ro", value: 1 }], { refreshSymbols: false }),
            (err) => err.code === "WRITE_NOT_ALLOWED" && /const \/ read-only/.test(err.message),
            "const composite member must reject write plan"
        );
    });

    await scenario("Enforce real ARM C++ static, reference, const and bitfield write identities", async () => {
        const fs = require("fs");
        const os = require("os");
        const path = require("path");
        const zlib = require("zlib");
        const dwarf = require("../src/dwarf");
        const elf = require("../src/elfSymbols");
        const fixtures = require("./fixtures/cpp-review/elf.json");
        const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "emberprobe-cpp-writes-"));
        try {
            // Use real GCC DWARF output without requiring a compiler or connected board in CI.
            for (const version of [4, 5]) {
                const buffer = zlib.inflateSync(Buffer.from(fixtures[`dwarf${version}`], "base64"));
                const parsed = dwarf.parseDwarf(buffer);
                const result = elf.parseElfSymbols(buffer);
                new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
                    result,
                    parsed.types,
                    parsed.layouts,
                    parsed.displayNames
                );
                const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
                const file = path.join(temporary, `dwarf${version}.elf`);
                fs.writeFileSync(file, buffer);
                result.elf = { path: file };
                result.memory = elf.parseElfSections(buffer);
                const Provider = loadProvider();
                const provider = Object.create(Provider.prototype);
                provider.readElfSymbols = () => result;
                const write = (name) => provider._agentWritePlan([{ name, value: 1 }], { refreshSymbols: false });
                assert.throws(() => write("plain.shared"), { code: "INVALID_VARIABLE_PATH" });
                assert.strictEqual(write("Plain::shared").items[0].address, byName.get("_ZN5Plain6sharedE").address);
                assert.strictEqual(
                    write("Holder<int>::object.x").items[0].address,
                    byName.get("_ZN6HolderIiE6objectE").address
                );
                assert.strictEqual(write("virtualObject.own").items.length, 1);
                for (const name of ["reference", "rvalueReference", "memberPointer", "methodPointer"]) {
                    assert.throws(() => write(name), { code: "WRITE_NOT_ALLOWED" });
                }
                assert.throws(() => write("refbox.ref"), { code: "WRITE_NOT_ALLOWED" });
                assert.strictEqual(write("refbox.own").items.length, 1);
                for (const name of ["readonlyRoot.nested.value", "readonlyRoot.values[0]", "readonlyRoot.values[1]"])
                    assert.throws(() => write(name), { code: "WRITE_NOT_ALLOWED" });
                assert.throws(() => write("packed.b"), { code: "UNSUPPORTED_VARIABLE" });
            }
        } finally {
            fs.rmSync(temporary, { recursive: true, force: true });
        }
    });

    console.log("ELF write readiness, cached sections, identity and symbol index tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
