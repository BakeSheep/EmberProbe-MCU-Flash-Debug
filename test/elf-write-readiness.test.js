"use strict";

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
    console.log("ELF write readiness, cached sections, identity and symbol index tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
