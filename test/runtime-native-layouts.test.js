"use strict";

const assert = require("assert");
const zlib = require("zlib");
const fixtures = require("./fixtures/runtime-layouts.json");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { bindVariableSymbols, buildDisplayNames } = require("../src/dwarf/types");
const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
const { parseElfSymbols, parseElfSections } = require("../src/elfSymbols");
const { exerciseRuntimeLayouts } = require("./helpers/runtime-layouts");

(async () => {
    for (const compressed of Object.values(fixtures)) {
        const buffer = zlib.inflateSync(Buffer.from(compressed, "base64"));
        const symbols = parseElfSymbols(buffer).symbols;
        const parsed = bindVariableSymbols(parseDwarfInternal(buffer), symbols);
        const names = buildDisplayNames(parsed);
        for (const symbol of symbols) symbol.displayName = names.get(symbol.name);
        assert.deepStrictEqual(parsed.diagnostics, []);
        await exerciseRuntimeLayouts(
            symbols,
            createRuntimeLayoutResolver(parsed, symbols),
            parseElfSections(buffer).sections
        );
    }
    console.log("Real ARM libstdc++ layouts: 24 runtime object kinds / DWARF 4 and 5 passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
