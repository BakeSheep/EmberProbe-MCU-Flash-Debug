"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { parseDwarf } = require("../src/dwarf");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const elf = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
const fixtures = require("./fixtures/dwarf-formats.json");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-dwarf-formats-"));
try {
    for (const [key, fixture] of Object.entries(fixtures)) {
        const buffer = zlib.inflateSync(Buffer.from(fixture.elf, "base64"));
        const filePath = path.join(root, key + ".elf");
        fs.writeFileSync(filePath, buffer);
        for (const [name, bytes] of Object.entries(fixture.companions))
            fs.writeFileSync(path.join(root, name), zlib.inflateSync(Buffer.from(bytes, "base64")));
        const parsed = parseDwarf(buffer, { filePath });
        assert.deepStrictEqual(parsed.diagnostics, [], key);
        assert.strictEqual(parsed.types.get("packet").kind, "struct", key);
        assert.deepStrictEqual(
            parsed.layouts.get("packet").members.map((field) => field.name),
            ["value", "ready"]
        );
        assert.strictEqual(parsed.layouts.get("_ZN3app6objectE").byteSize, 8);
        if (!key.includes("split")) continue;
        const names = Object.keys(fixture.companions);
        assert(names.length > 0, "split fixture includes its companion");
        for (const name of names) fs.unlinkSync(path.join(root, name));
        const missing = parseDwarf(buffer, { filePath });
        assert(missing.diagnostics.some((item) => item.code === "DWARF_COMPANION_MISSING"));
        const result = elf.parseElfSymbols(buffer);
        result.typeMetadataIncomplete = true;
        new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(result, missing.types, missing.layouts);
        const packet = result.symbols.find((symbol) => symbol.name === "packet");
        assert(packet.isComposite, "unknown objects must not become guessed integers");
        assert.strictEqual(packet.watchType, "");
        assert.strictEqual(packet.hasDwarfWriteType, false);
        const companion = zlib.inflateSync(Buffer.from(fixture.companions[names[0]], "base64"));
        const internal = parseDwarfInternal(companion);
        const identity = [...internal.dies.values()].find((die) => die.unit.dwoId)?.unit.dwoId;
        assert(identity);
        const original = Buffer.alloc(8),
            replacement = Buffer.alloc(8);
        original.writeBigUInt64LE(BigInt(identity));
        replacement.writeBigUInt64LE(BigInt(identity) ^ 1n);
        const position = companion.indexOf(original);
        assert(position >= 0);
        replacement.copy(companion, position);
        fs.writeFileSync(path.join(root, names[0]), companion);
        const mismatched = parseDwarf(buffer, { filePath });
        assert(mismatched.diagnostics.some((item) => item.code === "DWARF_COMPANION_MISMATCH"));
        assert(!mismatched.layouts.has("packet"));
        fs.writeFileSync(path.join(root, names[0]), Buffer.from("invalid ELF"));
        const malformed = parseDwarf(buffer, { filePath });
        assert(malformed.diagnostics.some((item) => item.code === "DWARF_INVALID_ELF"));
        fs.unlinkSync(path.join(root, names[0]));
    }
} finally {
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(root);
}

scenario("Reject truncated, unterminated and recursively indirect forms", () => {
    const { createFormReader } = require("../src/dwarf/forms");
    const reader = createFormReader({ buf: Buffer.from([10, 3, 0]), str: null, lineStr: null });
    assert.throws(() => reader({ p: 0 }, 0x09, {}), /Truncated/);
    assert.throws(
        () => createFormReader({ buf: Buffer.from("name"), str: null, lineStr: null })({ p: 0 }, 0x08, {}),
        /Unterminated/
    );
    const indirect = createFormReader({ buf: Buffer.alloc(100, 0x16), str: null, lineStr: null });
    assert.throws(() => indirect({ p: 0 }, 0x16, {}), /nesting/);
});

scenario("Verify absolute location expressions and companion path containment", () => {
    const c = require("../src/dwarf/constants");
    const { readCompanion } = require("../src/dwarf/files");
    const { attr, base, composite, fixed, fixture, member, node, variable } = require("./helpers/dwarf-tree");
    function addressTests() {
        const f = fixture(
            [
                [
                    base("int"),
                    variable("plain", "int"),
                    variable("addrExtra", "int", 0, [3, ...fixed(0x20000000), 0x23, 1]),
                    variable("index", "int", 0, [0xa1, 0]),
                    variable("indexExtra", "int", 0, [0xa1, 0, 0x23, 1]),
                    variable("gnu", "int", 0, [0xfb, 0]),
                    variable("gnuExtra", "int", 0, [0xfb, 0, 0x23, 1])
                ]
            ],
            { sections: [{ name: ".debug_addr", data: Buffer.from(fixed(0x20001000)) }] }
        );
        const parsed = parseDwarfInternal(f.buffer);
        assert.deepStrictEqual(
            parsed.variables.map((entry) => entry.name),
            ["plain", "index", "gnu"]
        );
        for (const name of ["addrExtra", "indexExtra", "gnuExtra"]) {
            const die = parsed.dies.get(f.offsets.get("var-" + name));
            assert.strictEqual(die.hasAddr, false);
            assert.strictEqual(die.address, undefined);
            assert.strictEqual(die.addressIndex, undefined);
        }
        assert.strictEqual(parsed.variables[1].address, 0x20001000);
    }
    function companionTests(temp) {
        const compiled = path.join(temp, "compiled"),
            build = path.join(compiled, "build");
        fs.mkdirSync(build, { recursive: true });
        const dwoId = 123456789012345n;
        const companion = fixture([
            node(
                "dwo-cu",
                0x11,
                [attr(0x2131, 7, dwoId)],
                [
                    base("int"),
                    composite("Packet", "Packet", 4, [member("value", "value", "int", 0)], c.DW_TAG_structure_type),
                    variable("packet", "Packet")
                ]
            )
        ]).buffer;
        const name = "build/unit.dwo";
        const skeleton = fixture([
            node("skeleton", 0x11, [attr(0x2130, 8, name), attr(0x1b, 8, compiled), attr(0x2131, 7, dwoId)])
        ]).buffer;
        const file = path.join(build, "app.elf");
        fs.writeFileSync(file, skeleton);
        fs.writeFileSync(path.join(build, "unit.dwo"), companion);
        const result = parseDwarf(skeleton, { filePath: file });
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.layouts.get("packet").members[0].name, "value");
        assert.strictEqual(result.companions[0].path, fs.realpathSync(path.join(build, "unit.dwo")));
        // A companion over the shared file budget stops the parse but keeps the skeleton unit.
        const limited = parseDwarf(skeleton, { filePath: file, budgets: { companionBytes: 1 } });
        assert.strictEqual(limited.diagnostics[0].code, "DWARF_PARTIAL");
        assert.deepStrictEqual(limited.diagnostics[0].i18nParams, { loaded: 1, total: 1, budget: "companion" });
        assert.strictEqual(limited.layouts.has("packet"), false, "the companion over budget is never read");
        assert.deepStrictEqual(limited.companions, []);
        assert(
            readCompanion({ dwoName: name, compDir: path.join(temp, "absent") }, file, 65536).buffer.equals(companion),
            "basename fallback"
        );
        const outside = path.join(temp, "outside");
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "victim.dwo"), companion);
        assert.throws(() => readCompanion({ dwoName: "../victim.dwo" }, file, 65536), /escapes/);
        assert.throws(() => readCompanion({ dwoName: path.join(outside, "victim.dwo") }, file, 65536), /escapes/);
        const missing = assert.throws(
            () => readCompanion({ dwoName: "victim.dwo", compDir: outside }, file, 65536),
            /missing/
        );
        assert.strictEqual(missing, undefined);
        const link = path.join(build, "link");
        fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
        assert.throws(() => readCompanion({ dwoName: "link/victim.dwo", compDir: compiled }, file, 65536), /escapes/);
        assert.throws(() => readCompanion({ dwoName: name, compDir: compiled }, file, 1), {
            code: "DWARF_BUDGET_EXCEEDED"
        });
    }
    scenario("Reject trailing address expression operations", addressTests);
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-dwarf-companions-")));
    try {
        scenario("Resolve and contain split DWARF companion files", () => companionTests(temp));
    } finally {
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

console.log("DWARF4/5 formats, verified companions and type-loss guards passed");
