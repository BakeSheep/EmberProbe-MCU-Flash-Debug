"use strict";

// These ELF files are layout evidence only. No generated code executes and no board is connected.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { parseDwarfInternal } = require("../../src/dwarf/parser");
const { bindVariableSymbols, buildDisplayNames } = require("../../src/dwarf/types");
const { createRuntimeLayoutResolver } = require("../../src/dwarf/runtimeTypes");
const { parseElfSymbols, parseElfSections } = require("../../src/elfSymbols");
const { exerciseRuntimeLayouts } = require("../helpers/runtime-layouts");

(async () => {
    const output = path.resolve(__dirname, "../../test-results");
    fs.mkdirSync(output, { recursive: true });
    const root = fs.mkdtempSync(path.join(output, "runtime-layouts-"));
    const fixtures = {};
    try {
        for (const version of [4, 5]) {
            const file = path.join(root, "runtime.elf");
            execFileSync(
                process.env.IMAGE_CXX || "arm-none-eabi-g++",
                [
                    "-std=c++20",
                    "-g",
                    `-gdwarf-${version}`,
                    "-O0",
                    "-nostdlib",
                    "-fno-exceptions",
                    "-Wl,--unresolved-symbols=ignore-all",
                    "-Wl,-Ttext=0x08000000,-Tdata=0x20000000,-e,entry",
                    `-fdebug-prefix-map=${path.resolve(__dirname, "../..")}=.`,
                    path.resolve(__dirname, "../fixtures/runtime-objects.cpp"),
                    "-o",
                    file
                ],
                { windowsHide: true }
            );
            const buffer = fs.readFileSync(file);
            const symbols = parseElfSymbols(buffer).symbols;
            const parsed = bindVariableSymbols(parseDwarfInternal(buffer), symbols);
            const names = buildDisplayNames(parsed);
            for (const symbol of symbols) symbol.displayName = names.get(symbol.name);
            assert.deepStrictEqual(parsed.diagnostics, []);
            const resolve = createRuntimeLayoutResolver(parsed, symbols);
            await exerciseRuntimeLayouts(symbols, resolve, parseElfSections(buffer).sections);
            fixtures[version] = zlib.deflateSync(buffer).toString("base64");
            console.log("PASS native ARM runtime type layouts DWARF " + version);
        }
        if (process.argv.includes("--fixtures"))
            fs.writeFileSync(
                path.resolve(__dirname, "../fixtures/runtime-layouts.json"),
                JSON.stringify(fixtures) + "\n"
            );
    } finally {
        for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
        fs.rmdirSync(root);
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
