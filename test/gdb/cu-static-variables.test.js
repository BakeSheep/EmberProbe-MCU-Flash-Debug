"use strict";

// Builds the fixture for test/agent-cu-static-variables.test.js: file-scope C statics with the same
// name in several compilation units (two of them named main.c in different directories), plus
// same-named function statics (calls.0). Run with --fixtures to refresh
// test/fixtures/cu-static-variables.json.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { parseDwarf } = require("../../src/dwarf");
const { parseElfSymbols } = require("../../src/elfSymbols");

const SOURCES = {
    "src/a/main.c": `#include <stdint.h>
struct LocalConfig { uint32_t mode; uint32_t gain; };
static struct LocalConfig g_localConfig = { 1, 2 };
static uint32_t s_counter = 11;
uint32_t g_shared = 3;
void other_touch(void);
uint32_t *third(void);
void entry(void) {
    static uint32_t calls = 21;
    calls++; s_counter++; g_localConfig.mode++; other_touch(); g_shared += *third();
}
`,
    "src/b/other.c": `#include <stdint.h>
struct LocalConfig { uint32_t mode; uint32_t gain; };
static struct LocalConfig g_localConfig = { 7, 8 };
static uint16_t s_counter = 22;
void other_touch(void) { static uint32_t calls = 31; calls++; s_counter++; g_localConfig.gain++; }
`,
    "src/b/main.c": `#include <stdint.h>
static uint32_t s_counter = 33;
uint32_t *third(void) { return &s_counter; }
`
};

const output = path.resolve(__dirname, "../../test-results");
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(output, "cu-static-variables-"));
try {
    const run = (args) =>
        execFileSync(process.env.IMAGE_CC || "arm-none-eabi-gcc", args, { cwd: root, windowsHide: true });
    const objects = [];
    for (const [file, source] of Object.entries(SOURCES)) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), source);
        const object = file.replace(/[/.]/g, "_") + ".o";
        run(["-mcpu=cortex-m4", "-mthumb", "-O0", "-g", `-fdebug-prefix-map=${root}=.`, "-c", file, "-o", object]);
        objects.push(object);
    }
    run(["-mcpu=cortex-m4", "-mthumb", "-nostdlib", "-Wl,-e,entry", ...objects, "-o", "statics.elf"]);
    const buffer = fs.readFileSync(path.join(root, "statics.elf"));
    const elfOnly = parseElfSymbols(buffer).symbols.map((symbol) => symbol.name);
    for (const name of ["main.c::g_localConfig", "other.c::g_localConfig", "other.c::s_counter", "main.c::calls.0"])
        assert(elfOnly.includes(name), `${name} in ${elfOnly.join(",")}`);
    const parsed = parseDwarf(buffer, { filePath: path.join(root, "statics.elf") });
    assert.deepStrictEqual(parsed.diagnostics, []);
    for (const name of ["a/main.c::s_counter", "b/main.c::s_counter", "other.c::s_counter"])
        assert(parsed.types.has(name), name);
    assert(parsed.layouts.has("main.c::g_localConfig") && parsed.layouts.has("other.c::g_localConfig"));
    if (process.argv.includes("--fixtures"))
        fs.writeFileSync(
            path.resolve(__dirname, "../fixtures/cu-static-variables.json"),
            JSON.stringify({ elf: zlib.deflateSync(buffer).toString("base64") }) + "\n"
        );
    console.log("PASS ARM same-named C statics fixture");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
