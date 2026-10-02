"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { parseDwarf } = require("../../src/dwarf");
const { parseElfSymbols } = require("../../src/elfSymbols");

const output = path.resolve(__dirname, "../../test-results");
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "dwarf-formats-"));
const fixtures = {};
try {
    fs.writeFileSync(
        path.join(root, "formats.cpp"),
        "struct Packet { int value; bool ready; }; Packet packet = {7, true}; " +
            'namespace app { Packet object = {9, false}; } extern "C" void entry() {}\n'
    );
    for (const version of [4, 5]) {
        for (const [name, flags] of [
            ["normal", []],
            ["types", ["-fdebug-types-section"]],
            ["wide", ["-gdwarf64"]],
            ["split", ["-gsplit-dwarf"]],
            ["split-wide", ["-gsplit-dwarf", "-gdwarf64"]],
            ["split-types", ["-gsplit-dwarf", "-fdebug-types-section"]]
        ]) {
            const key = `${version}-${name}`;
            const filename = key + ".elf";
            execFileSync(
                process.env.IMAGE_CXX || "arm-none-eabi-g++",
                [
                    "-g",
                    `-gdwarf-${version}`,
                    ...flags,
                    `-fdebug-prefix-map=${root}=.`,
                    "-nostdlib",
                    "-Wl,-e,entry",
                    "formats.cpp",
                    "-o",
                    filename
                ],
                { cwd: root, windowsHide: true }
            );
            const buffer = fs.readFileSync(path.join(root, filename));
            const result = parseDwarf(buffer, { filePath: path.join(root, filename) });
            assert.deepStrictEqual(result.diagnostics, [], `${key}: ${JSON.stringify(result.diagnostics)}`);
            const symbols = parseElfSymbols(buffer).symbols;
            for (const symbol of symbols.filter((item) => ["packet", "_ZN3app6objectE"].includes(item.name))) {
                assert.strictEqual(result.types.get(symbol.name)?.kind, "struct", key);
                assert.deepStrictEqual(
                    result.layouts.get(symbol.name)?.members.map((member) => member.name),
                    ["value", "ready"],
                    key
                );
            }
            fixtures[key] = { elf: zlib.deflateSync(buffer).toString("base64"), companions: {} };
            for (const file of fs
                .readdirSync(root)
                .filter((file) => file.startsWith(key + ".elf-") && file.endsWith(".dwo")))
                fixtures[key].companions[file] = zlib
                    .deflateSync(fs.readFileSync(path.join(root, file)))
                    .toString("base64");
            console.log("PASS ARM DWARF " + key);
        }
    }
    if (process.argv.includes("--fixtures"))
        fs.writeFileSync(path.resolve(__dirname, "../fixtures/dwarf-formats.json"), JSON.stringify(fixtures) + "\n");
} finally {
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(root);
}
