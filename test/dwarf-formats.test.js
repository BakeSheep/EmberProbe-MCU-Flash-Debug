"use strict";

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
console.log("DWARF4/5 formats, verified companions and type-loss guards passed");
