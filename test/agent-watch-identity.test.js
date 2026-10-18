"use strict";

// watch.add must persist raw ELF identities. normalizeWatchList only resolves raw names,
// so an Agent asking for a C++ static by its display name (`ep7` for `_ZL3ep7`) used to
// get `added: ["ep7"]` while nothing was saved.
const assert = require("assert");
const zlib = require("zlib");
const fixtures = require("./fixtures/runtime-layouts.json");
const dwarf = require("../src/dwarf");
const elf = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
const { normalizeWatchList } = require("../src/validation");
const { loadProvider } = require("./helpers/load-provider");

const endpointLayout = {
    kind: "struct",
    typeName: "Endpoint",
    byteSize: 4,
    members: [
        { name: "port", offset: 0, byteSize: 2, watchType: "u16", typeName: "unsigned short" },
        { name: "pin", offset: 2, byteSize: 1, watchType: "u8", typeName: "unsigned char" }
    ]
};
const staticSymbols = [
    {
        name: "_ZL3ep7",
        displayName: "ep7",
        address: 0x20000100,
        size: 4,
        isComposite: true,
        compositeLayout: endpointLayout
    },
    {
        name: "_ZL6s_anon",
        displayName: "s_anon",
        address: 0x20000104,
        size: 4,
        isComposite: true,
        compositeLayout: endpointLayout
    },
    { name: "_ZN3app6objectE", displayName: "app::object", address: 0x20000108, size: 4, watchType: "u32" },
    { name: "_ZL7counter", displayName: "counter", address: 0x2000010c, size: 4, watchType: "u32" },
    { name: "plain", address: 0x20000110, size: 2, watchType: "u16" }
];

// Persist the way the host does: normalize against the ELF, then keep identities only.
function provider(symbols) {
    const host = Object.create(loadProvider().prototype);
    const stored = new Map();
    host.readElfSymbols = () => ({ symbols });
    host._prepareRequestedLayouts = async () => {};
    host._focusedLivePanel = () => null;
    host._scalarWatchList = (key) => normalizeWatchList(stored.get(key) || [], symbols);
    host._saveWatchList = async (key, items) => {
        stored.set(
            key,
            normalizeWatchList(items, symbols).map(({ name, type }) => ({ name, type }))
        );
    };
    return { host, stored };
}

(async () => {
    {
        const { host, stored } = provider(staticSymbols);
        const result = await host._addAgentWatch({
            variables: ["ep7", "s_anon", "app::object", "counter", "plain", "ep7.port"],
            types: { counter: "i32" },
            destination: "both"
        });
        const raw = ["_ZL3ep7", "_ZL6s_anon", "_ZN3app6objectE", "_ZL7counter", "plain", "_ZL3ep7.port"];
        assert.deepStrictEqual(result.resolvedNames, {
            ep7: "_ZL3ep7",
            s_anon: "_ZL6s_anon",
            "app::object": "_ZN3app6objectE",
            counter: "_ZL7counter"
        });
        for (const target of ["sidebar", "chart"]) {
            assert.deepStrictEqual(result[target], { added: raw, alreadyPresent: [] }, target);
        }
        for (const list of stored.values()) {
            assert.deepStrictEqual(
                list.map((item) => item.name),
                raw,
                "every display-name request is saved under its raw ELF name"
            );
            // `params.types` stays keyed by the requested name.
            assert.strictEqual(list.find((item) => item.name === "_ZL7counter").type, "i32");
        }
        // A reload re-normalizes stored identities; display names come back from the ELF.
        const reloaded = normalizeWatchList([...stored.values()][0], staticSymbols);
        assert.deepStrictEqual(
            reloaded.map((item) => item.displayName || item.name),
            ["ep7", "s_anon", "app::object", "counter", "plain", "ep7.port"]
        );

        // Display-name and raw-name requests share one identity.
        const again = await host._addAgentWatch({ variables: ["_ZL3ep7", "app::object"], destination: "sidebar" });
        assert.deepStrictEqual(again, {
            resolvedNames: { "app::object": "_ZN3app6objectE" },
            sidebar: { added: [], alreadyPresent: ["_ZL3ep7", "_ZN3app6objectE"] }
        });
    }

    // Semantic runtime roots (STL) take the same raw identity, including member paths.
    for (const [version, compressed] of Object.entries(fixtures)) {
        const buffer = zlib.inflateSync(Buffer.from(compressed, "base64"));
        const parsed = dwarf.parseDwarf(buffer, { runtime: true });
        const result = elf.parseElfSymbols(buffer);
        new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
            result,
            parsed.types,
            parsed.layouts,
            parsed.displayNames
        );
        const text = result.symbols.find((symbol) => symbol.displayName === "text");
        assert.ok(text && text.name !== "text" && text.runtimeLayout, `DWARF ${version}: mangled std::string`);
        const { host, stored } = provider(result.symbols);
        const added = await host._addAgentWatch({ variables: ["text"], destination: "sidebar" });
        assert.deepStrictEqual(added.sidebar.added, [text.name], `DWARF ${version}`);
        assert.deepStrictEqual(added.resolvedNames, { text: text.name });
        const saved = normalizeWatchList([...stored.values()][0], result.symbols);
        assert.strictEqual(saved.length, 1, `DWARF ${version}: runtime root persisted`);
        assert.ok(saved[0].runtimeLayout);
        assert.strictEqual(saved[0].displayName, "text");
    }
    console.log("agent-watch-identity: ok");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
