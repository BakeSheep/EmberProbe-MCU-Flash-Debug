"use strict";

// Same-named internal-linkage variables in several compilation units (issue #38 follow-up): every
// copy stays visible under a CU-qualified identity, bare names are rejected as ambiguous for reads,
// writes and watch.add instead of silently using the first symbol, and file::name selects one CU.
// Fixture source and regeneration: test/gdb/cu-static-variables.test.js --fixtures.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const elf = require("../src/elfSymbols");
const runtime = require("../src/webview/runtime");
const { normalizeWatchList } = require("../src/validation");
const i18n = require("../src/i18n");
const { bindVariableSymbols } = require("../src/dwarf/types");
const { loadProvider } = require("./helpers/load-provider");
const { createWorkerElfService } = require("./helpers/elf-service");
const { diagnosticForError } = require("../skills/_emberprobe/agent-client");
const {
    parseSymbolsBuffer,
    findSymbol,
    variableSpecs,
    directRequests
} = require("../skills/mcu-variables/scripts/read");
const fixture = require("./fixtures/cu-static-variables.json");

const buffer = zlib.inflateSync(Buffer.from(fixture.elf, "base64"));

// —— CU scope grammar shared by the host, the webviews and the Skill ——
{
    const { parseMemberPath } = elf;
    assert.deepStrictEqual(parseMemberPath("main.c::g_localConfig.mode"), {
        base: "main.c::g_localConfig",
        segments: [{ kind: "member", name: "mode" }],
        scope: { file: "main.c", name: "g_localConfig" }
    });
    // The base stays a prefix of the request, so callers can slice the member suffix off it.
    assert.deepStrictEqual(parseMemberPath("'dir a/x.c'::buf[2]"), {
        base: "'dir a/x.c'::buf",
        segments: [{ kind: "index", index: 2 }],
        scope: { file: "dir a/x.c", name: "buf" }
    });
    assert.strictEqual(parseMemberPath('"src\\b\\main.c"::calls.0').scope.file, "src\\b\\main.c");
    assert.strictEqual(parseMemberPath("src/b/main.c::calls.0").base, "src/b/main.c::calls.0");
    assert.strictEqual(parseMemberPath("0x20000010::s_counter").scope.file, "0x20000010");
    // C++ qualified names never parse as CU scopes; only a file-like left side does.
    assert.deepStrictEqual(parseMemberPath("ns::value.x"), {
        base: "ns::value",
        segments: [{ kind: "member", name: "x" }]
    });
    assert.strictEqual(parseMemberPath("main.cpp::ns::value").scope.name, "ns::value");
    for (const invalid of ["main.c::", "main.c::1x", "a.c::b.c::x", "'x.c'y::z", "'x.c::y", "C:/x.c::y"])
        assert.strictEqual(parseMemberPath(invalid), null, invalid);
    assert.strictEqual(runtime.variableBaseName("main.c::cfg.mode"), "main.c::cfg");
    assert.strictEqual(runtime.variableBaseName("'a b/x.c'::calls.0[1]"), "'a b/x.c'::calls.0");
    assert.deepStrictEqual(runtime.variableNameParts("main.c::cfg"), { prefix: "main.c::", leaf: "cfg" });
    assert.strictEqual(runtime.scopedVariableName("src/main.c", "x"), "src/main.c::x");
    assert.strictEqual(runtime.scopedVariableName("dir a/x.c", "x"), "'dir a/x.c'::x");
    assert.strictEqual(runtime.scopedVariableName("it's/x.c", "x"), '"it\'s/x.c"::x');
    assert.strictEqual(runtime.scopedVariableName("a'b\"/x.c", "x"), null);
}

// —— ELF only: every copy is kept, qualified by STT_FILE, falling back to the address ——
const elfOnly = elf.parseElfSymbols(buffer).symbols;
{
    const byElfName = (name) => elfOnly.filter((symbol) => symbol.elfName === name);
    assert.deepStrictEqual(
        byElfName("g_localConfig").map((symbol) => [symbol.name, symbol.objectFile, symbol.sameNameCount]),
        [
            ["main.c::g_localConfig", "main.c", 2],
            ["other.c::g_localConfig", "other.c", 2]
        ]
    );
    const counters = byElfName("s_counter").map((symbol) => symbol.name);
    assert.strictEqual(counters.length, 3);
    assert(counters.includes("other.c::s_counter"));
    // Both main.c objects share a basename, so only their addresses tell them apart without DWARF.
    assert.strictEqual(counters.filter((name) => /^0x[0-9a-f]+::s_counter$/.test(name)).length, 2);
    assert(!elfOnly.some((symbol) => symbol.name === "s_counter" || symbol.addressAmbiguous));
    assert.strictEqual(elfOnly.find((symbol) => symbol.name === "g_shared").elfName, undefined);
    // Requalification is idempotent and exact-address DWARF sources refine the scope.
    const copy = elfOnly.map((symbol) => ({ ...symbol }));
    const [a, b] = copy.filter((symbol) => symbol.elfName === "s_counter" && symbol.name.startsWith("0x"));
    const refined = elf.qualifySameNameSymbols(copy, [
        { name: "s_counter", address: a.address, sourceFile: "/w/src/a/main.c" },
        { name: "s_counter", address: b.address, sourceFile: "C:\\w\\src\\b\\main.c" }
    ]);
    assert.deepStrictEqual(
        refined.filter((symbol) => symbol.elfName === "s_counter").map((symbol) => symbol.name),
        ["a/main.c::s_counter", "b/main.c::s_counter", "other.c::s_counter"]
    );
    // A same-named, same-address symbol of another size has no unique identity and is never usable.
    const clash = elf.qualifySameNameSymbols([
        { name: "x", address: 0x20000000, size: 4 },
        { name: "x", address: 0x20000000, size: 2 }
    ]);
    assert.strictEqual(clash.length, 1);
    assert.throws(() => elf.createSymbolResolver(clash)("0x20000000::x"), { code: "VARIABLE_AMBIGUOUS" });
    // The warning is localized by the host; the Worker has no UI language.
    const translate = (lang) => (key, params) => i18n.t(lang, key, params);
    assert.match(elf.sameNameSymbolWarning(elfOnly, translate("zh")), /^3 个变量名在多个编译单元中各有定义/);
    assert.match(
        elf.sameNameSymbolWarning(elfOnly, translate("en")),
        /^3 variable names are defined in several compilation units.*g_localConfig \(main\.c::g_localConfig, other\.c::g_localConfig\)/
    );
    assert.strictEqual(elf.sameNameSymbolWarning([{ name: "x" }], translate("en")), "");
    // DWARF refinement reports each renamed identity so already-published symbols can follow it.
    const refinedCopy = elfOnly.map((symbol) => ({ ...symbol }));
    const before = refinedCopy.find((symbol) => symbol.elfName === "s_counter" && symbol.name.startsWith("0x"));
    const previousName = before.name;
    const { identities } = elf.refineSameNameSymbols(refinedCopy, [
        { name: "s_counter", address: before.address, sourceFile: "/w/src/a/main.c" }
    ]);
    assert.deepStrictEqual(identities.find(([previous]) => previous === previousName)[1], {
        name: "a/main.c::s_counter",
        elfName: "s_counter",
        scope: "a/main.c",
        sameNameCount: 3,
        sourceFile: "/w/src/a/main.c",
        addressAmbiguous: false
    });
    assert.deepStrictEqual(elf.refineSameNameSymbols([{ name: "x" }], []).identities, []);
}

// —— DWARF binding never merges CUs: each identity keeps its own type and layout ——
{
    const variables = [
        { name: "cfg", address: 0x10, sourceFile: "/p/a.c", typeRef: 1 },
        { name: "cfg", address: 0x20, sourceFile: "/p/b.c", typeRef: 2 },
        { name: "other", address: 0x30, sourceFile: "/p/b.c", typeRef: 3 }
    ];
    const symbols = elf.qualifySameNameSymbols(
        [
            { name: "cfg", address: 0x10, size: 4 },
            { name: "cfg", address: 0x20, size: 4 },
            { name: "other", address: 0x30, size: 4 }
        ],
        variables
    );
    const bound = bindVariableSymbols({ variables }, symbols).variables;
    assert.deepStrictEqual(
        bound.map((variable) => [variable.linkageName, variable.qualifiedName]),
        [
            ["a.c::cfg", "a.c::cfg"],
            ["b.c::cfg", "b.c::cfg"],
            [undefined, undefined]
        ]
    );
    // An unrelated DWARF name at the same address is not rebound.
    const alias = bindVariableSymbols({ variables: [{ name: "alias", address: 0x10 }] }, symbols).variables;
    assert.strictEqual(alias[0].linkageName, undefined);
}

// —— Skill: --list exposes every candidate with its source file; direct mode rejects bare names ——
{
    const listed = parseSymbolsBuffer(buffer);
    assert.deepStrictEqual(
        listed.filter((symbol) => symbol.elfName === "g_localConfig").map((symbol) => symbol.name),
        ["main.c::g_localConfig", "other.c::g_localConfig"]
    );
    assert.deepStrictEqual(
        listed.map((symbol) => symbol.name).filter((name) => name.includes("::")),
        elfOnly.map((symbol) => symbol.name).filter((name) => name.includes("::")),
        "the Skill and the extension agree on ELF-only identities"
    );
    assert.throws(
        () => findSymbol(listed, "g_localConfig"),
        (error) =>
            error.code === "VARIABLE_AMBIGUOUS" &&
            error.details.candidates.map((candidate) => candidate.sourceFile).join() === "main.c,other.c"
    );
    assert.throws(() => findSymbol(listed, "main.c::s_counter"), { code: "VARIABLE_AMBIGUOUS" });
    assert.strictEqual(findSymbol(listed, "'other.c'::g_localConfig").name, "other.c::g_localConfig");
    assert.strictEqual(findSymbol(listed, "src/b/other.c::s_counter").name, "other.c::s_counter");
    const viaAddress = listed.find((symbol) => /^0x/.test(symbol.name));
    assert.strictEqual(findSymbol(listed, viaAddress.name), viaAddress);
    assert.strictEqual(findSymbol(listed, "missing.c::s_counter"), null);
    assert.strictEqual(findSymbol(listed, "g_shared").name, "g_shared");
    assert.deepStrictEqual(variableSpecs("main.c::s_counter:u32,'a b/x.c'::cfg.mode,0x2000::v:i16,ns::w:u8"), [
        { name: "main.c::s_counter", type: "u32" },
        { name: "'a b/x.c'::cfg.mode" },
        { name: "0x2000::v", type: "i16" },
        { name: "ns::w", type: "u8" }
    ]);
    // Direct --elf/--port mode: the `::` of a CU scope is never a type separator.
    assert.deepStrictEqual(
        directRequests(listed, "'other.c'::s_counter:u16,src/b/other.c::calls.0").map((item) => [item.name, item.type]),
        [
            ["other.c::s_counter", "u16"],
            ["other.c::calls.0", "u32"]
        ]
    );
    assert.throws(() => directRequests(listed, "g_localConfig"), { code: "VARIABLE_AMBIGUOUS" });
    const { error: diagnostic } = diagnosticForError(
        Object.assign(new Error("ambiguous"), { code: "VARIABLE_AMBIGUOUS", details: { candidates: [] } }),
        { operation: "variables.write" }
    );
    assert.strictEqual(diagnostic.category, "variable_resolution");
    assert(diagnostic.suggestedActions.length && diagnostic.details.candidates);
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-cu-statics-"));
    const file = path.join(root, "statics.elf");
    fs.writeFileSync(file, buffer);
    const phases = [];
    const published = [];
    const service = createWorkerElfService(file, {
        t: (key, params) => i18n.t("en", key, params),
        onChange: (phase, _result, entries) => {
            phases.push(phase);
            if (phase === "symbols") published.push(...entries.map((entry) => entry.name));
        }
    });
    try {
        const result = await service.ready();
        await service.dwarfPromise;
        // Symbols are published before the DWARF parse, under STT_FILE identities, and renamed afterwards.
        assert(phases.indexOf("symbolsDone") < phases.indexOf("identities"), phases.join());
        assert.strictEqual(published.filter((name) => /^0x[0-9a-f]+::s_counter$/.test(name)).length, 2);
        assert(service.symbolByName.has("a/main.c::s_counter"));
        assert(![...service.symbolByName.keys()].some((name) => /^0x[0-9a-f]+::s_counter$/.test(name)));
        const symbol = (name) => result.symbols.find((item) => item.name === name);
        // DWARF source paths extend the scope until it is unique: two main.c files and one other.c.
        assert.deepStrictEqual(
            result.symbols.filter((item) => item.elfName === "s_counter").map((item) => item.name),
            ["a/main.c::s_counter", "b/main.c::s_counter", "other.c::s_counter"]
        );
        assert.strictEqual(symbol("a/main.c::s_counter").watchType, "u32");
        assert.strictEqual(symbol("other.c::s_counter").watchType, "u16", "types are never merged across CUs");
        assert.strictEqual(symbol("b/main.c::s_counter").sourceFile, "src/b/main.c");
        assert.strictEqual(symbol("main.c::calls.0").displayName, "main.c::calls");
        assert.strictEqual(symbol("main.c::g_localConfig").isComposite, true);
        const sameName = result.warnings.filter((warning) => warning.startsWith("3 variable names are defined"));
        assert.strictEqual(sameName.length, 1, "the refined warning replaces the first one");
        assert(sameName[0].includes("s_counter (a/main.c::s_counter, b/main.c::s_counter, other.c::s_counter)"));

        const sections = elf.parseElfSections(buffer).sections;
        const reads = [];
        const memoryAt = (address, size) => {
            const data = sections.find(
                (section) => section.type === 1 && address >= section.addr && address < section.addr + section.size
            );
            return data
                ? buffer.subarray(data.offset + address - data.addr, data.offset + address - data.addr + size)
                : Buffer.alloc(size);
        };
        const stored = new Map();
        const provider = Object.create(loadProvider().prototype);
        provider._elfService = service;
        provider._focusedLivePanel = () => null;
        provider._scalarWatchList = (key) => normalizeWatchList(stored.get(key) || [], result.symbols);
        provider._saveWatchList = async (key, items) => {
            stored.set(
                key,
                normalizeWatchList(items, result.symbols).map(({ name, type }) => ({ name, type }))
            );
        };
        provider._withAgentProbe = (handler) =>
            handler({
                source: "test-probe",
                temporary: false,
                session: {
                    readOnce: async (items) => {
                        reads.push(items.map((item) => item.name));
                        return items.map((item) => ({
                            name: item.name,
                            bytes: memoryAt(item.address, item.size),
                            t: 1
                        }));
                    }
                }
            });
        const read = (variables) => provider._readAgentVariables({ variables });
        const isAmbiguous = (names) => (error) =>
            error.code === "VARIABLE_AMBIGUOUS" &&
            error.details.candidates.map((candidate) => candidate.name).join() === names.join();

        // Bare names never fall back to the first symbol: reads, member paths, writes and watch.add.
        await assert.rejects(read(["g_localConfig"]), isAmbiguous(["main.c::g_localConfig", "other.c::g_localConfig"]));
        await assert.rejects(read(["g_localConfig.mode"]), { code: "VARIABLE_AMBIGUOUS" });
        await assert.rejects(read(["calls"]), isAmbiguous(["main.c::calls.0", "other.c::calls.0"]));
        await assert.rejects(read(["main.c::s_counter"]), isAmbiguous(["a/main.c::s_counter", "b/main.c::s_counter"]));
        const ambiguousRead = await read(["s_counter", "g_shared"]);
        assert.strictEqual(ambiguousRead.values.g_shared.value, 3);
        const candidates = ambiguousRead.variableErrors[0].error.details.candidates;
        assert.deepStrictEqual(
            candidates.map((candidate) => [candidate.name, candidate.sourceFile]),
            [
                ["a/main.c::s_counter", "src/a/main.c"],
                ["b/main.c::s_counter", "src/b/main.c"],
                ["other.c::s_counter", "src/b/other.c"]
            ]
        );
        assert(candidates.every((candidate) => /^0x[0-9A-F]+$/.test(candidate.address)));
        assert.throws(() => provider._agentWritePlan([{ name: "s_counter", value: 1 }], { refreshSymbols: false }), {
            code: "VARIABLE_AMBIGUOUS"
        });
        assert.throws(
            () => provider._agentWritePlan([{ name: "g_localConfig.mode", value: 1 }], { refreshSymbols: false }),
            { code: "VARIABLE_AMBIGUOUS" }
        );
        await assert.rejects(provider._addAgentWatch({ variables: ["g_localConfig"] }), { code: "VARIABLE_AMBIGUOUS" });
        assert.strictEqual(stored.size, 0, "nothing is saved for an ambiguous watch request");

        // Qualified names select exactly one CU, quoted or not, by file name or path suffix.
        const qualified = await read([
            "main.c::g_localConfig.mode",
            "'other.c'::g_localConfig",
            "b/main.c::s_counter",
            "src/b/other.c::s_counter",
            "main.c::calls",
            "other.c::calls.0"
        ]);
        assert.strictEqual(qualified.partial, undefined);
        assert.strictEqual(qualified.values["main.c::g_localConfig.mode"].value, 1);
        assert.deepStrictEqual(
            qualified.values["'other.c'::g_localConfig"].tree.members.map((member) => [member.name, member.value]),
            [
                ["mode", 7],
                ["gain", 8]
            ]
        );
        const counter = qualified.values["b/main.c::s_counter"];
        assert.deepStrictEqual([counter.value, counter.requestedName], [33, "b/main.c::s_counter"]);
        assert.deepStrictEqual(
            [qualified.values["other.c::s_counter"].value, qualified.values["other.c::s_counter"].type],
            [22, "u16"]
        );
        assert.strictEqual(qualified.values["other.c::s_counter"].requestedName, "src/b/other.c::s_counter");
        assert.strictEqual(qualified.values["main.c::calls.0"].value, 21);
        assert.strictEqual(qualified.values["other.c::calls.0"].value, 31);
        assert.deepStrictEqual(
            reads.at(-1).sort(),
            [
                "b/main.c::s_counter",
                "main.c::calls.0",
                "main.c::g_localConfig",
                "other.c::calls.0",
                "other.c::g_localConfig",
                "other.c::s_counter"
            ],
            "reads use CU-qualified identities"
        );
        const address = symbol("a/main.c::s_counter").address.toString(16);
        assert.strictEqual((await read([`0x${address}::s_counter`])).values["a/main.c::s_counter"].value, 11);
        await assert.rejects(
            read(["missing.c::s_counter"]),
            (error) => error.code === "VARIABLE_NOT_FOUND" && error.details.candidates.length === 3
        );

        // Writes and watch.add take the selected CU's identity and address.
        const plan = provider._agentWritePlan([{ name: "'other.c'::g_localConfig.gain", value: 9 }], {
            refreshSymbols: false
        });
        assert.deepStrictEqual(
            plan.items.map((item) => [item.name, item.address, item.type]),
            [["other.c::g_localConfig.gain", symbol("other.c::g_localConfig").address + 4, "u32"]]
        );
        const scalarPlan = provider._agentWritePlan([{ name: "b/main.c::s_counter", value: 5 }], {
            refreshSymbols: false
        });
        assert.deepStrictEqual(
            scalarPlan.items.map((item) => [item.name, item.address]),
            [["b/main.c::s_counter", symbol("b/main.c::s_counter").address]]
        );
        assert.throws(
            () => provider._agentWritePlan([{ name: "b/main.c::s_counter.x", value: 5 }], { refreshSymbols: false }),
            { code: "INVALID_VARIABLE_PATH" }
        );
        const added = await provider._addAgentWatch({
            variables: ["'other.c'::g_localConfig.mode", "src/a/main.c::s_counter"],
            destination: "sidebar"
        });
        assert.deepStrictEqual(added.sidebar.added, ["other.c::g_localConfig.mode", "a/main.c::s_counter"]);
        assert.deepStrictEqual(added.resolvedNames, {
            "'other.c'::g_localConfig": "other.c::g_localConfig",
            "src/a/main.c::s_counter": "a/main.c::s_counter"
        });
        const saved = normalizeWatchList([...stored.values()][0], result.symbols);
        assert.deepStrictEqual(
            saved.map((item) => [item.name, item.address]),
            [
                ["other.c::g_localConfig.mode", symbol("other.c::g_localConfig").address],
                ["a/main.c::s_counter", symbol("a/main.c::s_counter").address]
            ]
        );
        // Persisted names follow a changed CU identity of the same ELF name; ambiguity is reported, never guessed.
        const renamed = [];
        const ambiguous = [];
        const followed = normalizeWatchList(
            [
                { name: `0x${address}::s_counter` },
                { name: "src/b/other.c::s_counter" },
                { name: "s_counter" },
                { name: "main.c::s_counter" },
                { name: "G_SHARED" }
            ],
            result.symbols,
            {
                onRename: (from, to) => renamed.push([from, to]),
                onAmbiguous: (name, names) => ambiguous.push([name, names])
            }
        );
        assert.deepStrictEqual(
            followed.map((item) => item.name),
            ["a/main.c::s_counter", "other.c::s_counter"]
        );
        assert.deepStrictEqual(renamed, [
            [`0x${address}::s_counter`, "a/main.c::s_counter"],
            ["src/b/other.c::s_counter", "other.c::s_counter"]
        ]);
        assert.deepStrictEqual(
            ambiguous.map(([name, names]) => [name, names.length]),
            [
                ["s_counter", 3],
                ["main.c::s_counter", 2]
            ]
        );
        console.log("agent CU static variables ok");
    } finally {
        service.invalidate();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
