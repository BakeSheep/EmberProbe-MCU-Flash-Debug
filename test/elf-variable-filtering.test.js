"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const elf = require("../src/elfSymbols");
const dwarf = require("../src/dwarf");
const { readElf32Header, readSectionEntries } = require("../src/elfFormat");
const { bindVariableSymbols } = require("../src/dwarf/types");
const { ElfService } = require("../src/services/elfService");
const { buildElf } = require("./perf/parse-bench");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { normalizeWatchList } = require("../src/validation");
const { variableBaseName } = require("../src/webview/runtime");

const metadata = [
    "_ZTIN8scenario6SensorE",
    "_ZTSN8scenario6SensorE",
    "_ZTVN8scenario6SensorE",
    "_ZTTN8scenario6SensorE",
    "_ZTCN8scenario6SensorE0_NS_4BaseE",
    "_ZGVZ8callbackvE5state"
];
const missingName = "_ZN3app7missingE";
// C reserves "_" plus an uppercase letter but not "_" plus a lowercase one, so these are legal C
// globals that a bare /^_Z/ test would drag into the C++ unresolved-type path.
const cLookalikes = ["_ZephyrState", "_Zcounter"];
for (const name of metadata) assert(elf.isCppRuntimeSymbol(name));
for (const name of [missingName, "_ZN3app7g_plantE", "_ZZ8callbackvE5state", "Idle_Stack.2", "counter"])
    assert(!elf.isCppRuntimeSymbol(name), `keep source variable ${name}`);
for (const name of [
    ...metadata,
    missingName,
    "_ZN3app7g_plantE",
    "_ZL3foov",
    "_ZZ8callbackvE5state",
    "_ZSt3cin",
    "_Z3amb"
])
    assert(elf.isItaniumMangled(name), `Itanium-mangled ${name}`);
for (const name of [...cLookalikes, "counter", "Idle_Stack.2", "v0_2.1"])
    assert(!elf.isItaniumMangled(name), `not Itanium-mangled ${name}`);

// Diagnostics ship to the webview wholesale, so a firmware linking many C++ objects without debug
// info must not be able to flood the channel; the overflow is reported, not silently dropped.
{
    const capped = new ElfService({ t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key) });
    const result = { symbols: [], diagnostics: [], warnings: [] };
    for (let index = 0; index < 120; index++)
        result.symbols.push({ name: `_ZN3app${index}7missingE`, displayName: `app${index}::missing` });
    result.symbols.push({ name: "_ZephyrState", displayName: "_ZephyrState" });
    capped._recordCppDiagnostics(result, new Map());
    assert.strictEqual(result.diagnostics.filter((d) => d.code === "CPP_TYPE_UNRESOLVED").length, 50);
    const truncated = result.diagnostics.filter((d) => d.code === "CPP_DIAGNOSTICS_TRUNCATED");
    assert.strictEqual(truncated.length, 1);
    assert.match(truncated[0].message, /"count":70/);
    assert.strictEqual(result.warnings.length, 51);
}

// Only an unambiguous static address may bind compiler-suffixed C symbols.
const variable = (address) => ({ name: "state", linkageName: "", address });
const declarations = [variable(0x20000000), variable(0x20000010), variable(0x20000020), { name: "local" }];
const bound = bindVariableSymbols({ variables: declarations }, [
    { name: "state.0", address: 0x20000000 },
    { name: "state.1", address: 0x20000010 },
    { name: "state.2", address: 0x20000020 },
    { name: "alias", address: 0x20000020 }
]).variables;
assert.deepStrictEqual(
    bound.map((v) => v.linkageName),
    ["state.0", "state.1", "", undefined]
);
assert.strictEqual(bound[2], declarations[2], "ambiguous addresses must not acquire a guessed type");
assert.strictEqual(bound[3], declarations[3], "stack locals have no static ELF identity");
assert.strictEqual(variableBaseName("Idle_Stack.2[3]"), "Idle_Stack.2");
assert.strictEqual(variableBaseName("Idle_TCB.3.value"), "Idle_TCB.3");
assert.deepStrictEqual(elf.parseMemberPath("Idle_Stack.2[3]"), {
    base: "Idle_Stack.2",
    segments: [{ kind: "index", index: 3 }]
});
assert.strictEqual(elf.parseMemberPath("state.1oops.value"), null);

// Extend a hardware-independent ELF/DWARF fixture with ABI metadata and C statics.
function fixture() {
    const buffer = buildElf({ cus: 1, vars: 4, structs: 1, members: 2 }).buf;
    const header = readElf32Header(buffer);
    const sections = readSectionEntries(buffer, header);
    const symbolIndex = sections.findIndex((s) => s.type === 2);
    const symtab = sections[symbolIndex];
    const strtab = sections[symtab.link];
    const strings = [Buffer.from([0])];
    const entries = [Buffer.alloc(16)];
    let stringSize = 1;
    const add = (name, entry) => {
        entry.writeUInt32LE(stringSize);
        const bytes = Buffer.from(name + "\0");
        strings.push(bytes);
        stringSize += bytes.length;
        entries.push(entry);
    };
    for (let offset = 16; offset < symtab.size; offset += 16) {
        const entry = Buffer.from(buffer.subarray(symtab.offset + offset, symtab.offset + offset + 16));
        const start = strtab.offset + entry.readUInt32LE(0);
        let name = buffer.toString("utf8", start, buffer.indexOf(0, start));
        // The performance fixture uses placeholder symbol addresses; align these
        // entries with its DW_OP_addr records for an actual identity-binding test.
        entry.writeUInt32LE(name === "cu0_a" ? 0x20010000 : 0x20000000 + (Number(name.split("_")[1]) || 0) * 4, 4);
        entry.writeUInt32LE(name === "cu0_a" ? 16 : name === "v0_2" ? 8 : 4, 8);
        if (name === "v0_2") name += ".1";
        if (name === "cu0_a") name += ".0";
        add(name, entry);
    }
    [...metadata, missingName].forEach((name, index) => {
        const entry = Buffer.alloc(16);
        entry.writeUInt32LE(0x08010000 + index * 32, 4);
        entry.writeUInt32LE(16, 8);
        entry[12] = 0x11;
        entry.writeUInt16LE(1, 14);
        add(name, entry);
    });
    // Size 4, so the size-inferred scalar path applies and only the mangling test decides the kind.
    cLookalikes.forEach((name, index) => {
        const entry = Buffer.alloc(16);
        entry.writeUInt32LE(0x08011000 + index * 16, 4);
        entry.writeUInt32LE(4, 8);
        entry[12] = 0x11;
        entry.writeUInt16LE(1, 14);
        add(name, entry);
    });
    const output = Buffer.concat([buffer, Buffer.concat(strings), Buffer.concat(entries)]);
    const symbolHeader = header.shoff + symbolIndex * header.shentsize;
    const stringHeader = header.shoff + symtab.link * header.shentsize;
    output.writeUInt32LE(buffer.length, stringHeader + 16);
    output.writeUInt32LE(stringSize, stringHeader + 20);
    output.writeUInt32LE(buffer.length + stringSize, symbolHeader + 16);
    output.writeUInt32LE(entries.length * 16, symbolHeader + 20);
    return output;
}

(async () => {
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "emberprobe-elf-identities-"));
    const file = path.join(temporary, "firmware.elf");
    const buffer = fixture();
    fs.writeFileSync(file, buffer);
    assert(
        metadata.every((name) => elf.parseElfSymbols(buffer).symbols.some((s) => s.name === name)),
        "raw ELF analysis retains ABI objects"
    );
    const results = [];
    let numberedSymbol;
    try {
        for (const worker of [false, true]) {
            const chunks = [];
            const service = new ElfService({
                context: { workspaceState: { get: () => file } },
                cacheKey: "elf",
                fs,
                crypto,
                elfSymbols: elf,
                dwarf,
                cleanPath: (value) => value,
                t: (key) => key,
                ...(worker ? { workerPath: path.resolve(__dirname, "../src/elfWorker.js") } : {}),
                onChange: (phase, _result, entries) => {
                    if (phase === "symbols") chunks.push(...entries);
                }
            });
            try {
                const result = worker ? await service.ready() : service.read();
                assert(!result.symbols.some((s) => metadata.includes(s.name)));
                assert(!chunks.some((s) => metadata.includes(s.name)), "metadata never reaches progressive UI chunks");
                const state = result.symbols.find((s) => s.name === "v0_2.1");
                assert.strictEqual(state.displayName, "v0_2");
                assert.strictEqual(state.typeName, "struct S0_0");
                const layout = worker ? await service.layout(state.name) : state.compositeLayout;
                numberedSymbol = { ...state, compositeLayout: layout };
                assert.deepStrictEqual(
                    layout.members.map((m) => m.name),
                    ["m0", "m1"]
                );
                const stack = result.symbols.find((s) => s.name === "cu0_a.0");
                const stackLayout = worker ? await service.layout(stack.name) : stack.compositeLayout;
                assert.strictEqual(stackLayout.totalElements, 4);
                const leaves = normalizeWatchList(
                    [{ name: state.name + ".m1" }, { name: stack.name + "[2]" }],
                    result.symbols
                );
                assert.deepStrictEqual(
                    leaves.map((leaf) => [leaf.name, leaf.displayName, leaf.address]),
                    [
                        ["v0_2.1.m1", "v0_2.m1", state.address + 4],
                        ["cu0_a.0[2]", "cu0_a[2]", stack.address + 8]
                    ],
                    "compiler-suffixed members remain watchable after normalization and reload"
                );
                const unresolved = result.symbols.find((s) => s.name === missingName);
                assert(unresolved.cppTypeUnavailable);
                assert.strictEqual(unresolved.watchType, "", "missing debug types must not become writable scalars");
                assert.strictEqual(result.diagnostics.filter((d) => d.code === "CPP_TYPE_UNRESOLVED").length, 1);
                for (const name of cLookalikes) {
                    const cGlobal = result.symbols.find((s) => s.name === name);
                    assert(!cGlobal.isComposite, `${name} is a C global, not an unresolved C++ object`);
                    assert(!cGlobal.cppTypeUnavailable, `${name} must not report a C++ type problem`);
                    assert.strictEqual(cGlobal.watchType, "u32", `${name} keeps its size-inferred scalar type`);
                }
                results.push(result.symbols.map((s) => [s.name, s.displayName, s.typeName]));
            } finally {
                service.invalidate();
            }
        }
        assert.deepStrictEqual(results[0], results[1], "sync and progressive ELF views agree");
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const unavailable = {
        name: missingName,
        address: 0x20000000,
        size: 16,
        isComposite: true,
        cppTypeUnavailable: true,
        unsupportedReason: "C++ type unavailable"
    };
    const numberedWatch = normalizeWatchList(
        [{ name: numberedSymbol.name }, { name: numberedSymbol.name + ".m1" }],
        [numberedSymbol]
    );
    const sidebar = render(getModernWebviewContent({}, "en"));
    try {
        sidebar.send({ type: "availableVariables", symbols: [unavailable] });
        assert.strictEqual(sidebar.document.querySelector(".available-type").textContent, "Unknown type");
        sidebar.document.querySelector(".av-arrow").click();
        assert.strictEqual(sidebar.document.querySelector(".sb-note").textContent, unavailable.unsupportedReason);
        sidebar.send({ type: "availableVariables", symbols: [numberedSymbol] });
        sidebar.send({ type: "sidebarWatchList", items: numberedWatch });
        assert.strictEqual(
            sidebar.document.querySelectorAll(".value-row").length,
            1,
            "members stay in their parent card"
        );
        sidebar.document.querySelector(".value-row .watch-remove").click();
        assert.strictEqual(sidebar.messages.findLast((m) => m.type === "saveSidebarWatch").items.length, 0);
        sidebar.assertHealthy();
    } finally {
        sidebar.close();
    }
    const graph = render(getLiveWatchContent({ panelId: 1 }, "en"));
    try {
        graph.send({ type: "variablesList", symbols: [unavailable] });
        graph.window.openImport();
        assert.strictEqual(graph.document.querySelector(".imp-row .ty").textContent, "Unknown type");
        graph.document.querySelector(".imp-arrow").click();
        assert.strictEqual(graph.document.querySelector(".imp-children").textContent, unavailable.unsupportedReason);
        graph.send({ type: "variablesList", symbols: [numberedSymbol] });
        graph.send({ type: "watchList", items: numberedWatch });
        assert.strictEqual(graph.document.querySelectorAll(".var-card").length, 1, "members stay in their parent card");
        graph.document.querySelector(".var-card .remove").click();
        assert.strictEqual(graph.messages.findLast((m) => m.type === "saveWatch").items.length, 0);
        graph.assertHealthy();
    } finally {
        graph.close();
    }
    console.log("ELF metadata filtering, C static identities and unavailable-type presentation passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
