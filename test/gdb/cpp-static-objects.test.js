"use strict";

// Builds the fixture for test/agent-static-variables.test.js (issue #38): mangled file-scope statics
// and namespace objects requested by display name, plus .bss statics that GCC emits as NOTYPE LOCAL
// symbols at -O0 without -fdata-sections. Run with --fixtures to refresh test/fixtures/cpp-static-objects.json.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { parseDwarf } = require("../../src/dwarf");
const { parseElfSymbols } = require("../../src/elfSymbols");

const CXX_SOURCE = `#include <stdint.h>
struct Endpoint { uint32_t id; uint16_t port; uint8_t up; };
static Endpoint ep7{7, 80, 1};
namespace app { Endpoint object{9, 81, 0}; }
static struct { uint32_t x; uint32_t y; } s_anon;
uint32_t counter = 5;
extern "C" void c_touch(void);
extern "C" void entry() { ep7.id++; app::object.id++; s_anon.x++; counter++; c_touch(); }
`;
const C_SOURCE = `#include <stdint.h>
static uint32_t c_plain;
void c_touch(void) { c_plain++; }
`;

const output = path.resolve(__dirname, "../../test-results");
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "cpp-static-objects-"));
try {
    fs.writeFileSync(path.join(root, "objects.cpp"), CXX_SOURCE);
    fs.writeFileSync(path.join(root, "plain.c"), C_SOURCE);
    const common = ["-O0", "-g", "-gdwarf-5", `-fdebug-prefix-map=${root}=.`];
    const run = (tool, args) => execFileSync(tool, args, { cwd: root, windowsHide: true });
    run(process.env.IMAGE_CXX || "arm-none-eabi-g++", [
        ...common,
        "-fno-exceptions",
        "-c",
        "objects.cpp",
        "-o",
        "objects.o"
    ]);
    run(process.env.IMAGE_CC || "arm-none-eabi-gcc", [...common, "-c", "plain.c", "-o", "plain.o"]);
    run(process.env.IMAGE_CXX || "arm-none-eabi-g++", [
        "-nostdlib",
        "-Wl,-e,entry",
        "objects.o",
        "plain.o",
        "-o",
        "objects.elf"
    ]);
    const buffer = fs.readFileSync(path.join(root, "objects.elf"));
    const names = parseElfSymbols(buffer).symbols.map((symbol) => symbol.name);
    for (const name of ["_ZL3ep7", "_ZN3app6objectE", "_ZL6s_anon", "counter", "c_plain"])
        assert(names.includes(name), `${name} in ${names.join(",")}`);
    const parsed = parseDwarf(buffer, { filePath: path.join(root, "objects.elf") });
    assert.deepStrictEqual(parsed.diagnostics, []);
    for (const name of ["_ZL3ep7", "_ZN3app6objectE", "_ZL6s_anon"]) assert(parsed.layouts.has(name), name);
    if (process.argv.includes("--fixtures"))
        fs.writeFileSync(
            path.resolve(__dirname, "../fixtures/cpp-static-objects.json"),
            JSON.stringify({ elf: zlib.deflateSync(buffer).toString("base64") }) + "\n"
        );
    console.log("PASS ARM C++ static objects fixture");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
