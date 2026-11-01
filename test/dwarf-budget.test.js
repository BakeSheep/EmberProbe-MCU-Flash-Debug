"use strict";
// DWARF parse budgets: compilation unit, abbreviation, DIE and compressed-section limits across the whole parse, and
// the partial result they leave: complete units are kept and the unit that ran out is rolled back as a whole.
const assert = require("assert");
const fs = require("fs");
const crypto = require("crypto");
const { parseAbbrev } = require("../src/dwarf/binary");
const { buildCompositeLayouts, buildVariableTypes, createCompositeLayoutResolver } = require("../src/dwarf/types");
const c = require("../src/dwarf/constants");
const { _debugSectionData } = require("../src/dwarf");
const { parseDwarfInternal, DEFAULT_BUDGETS } = require("../src/dwarf/parser");
const { ElfService } = require("../src/services/elfService");
const elfSymbols = require("../src/elfSymbols");
const { formatDiagnostic } = require("../src/webview/elfDiagnostics");
const { scenario } = require("./helpers/scenario");
const { buildDwarfElf: buildElf } = require("./helpers/elf-fixture");
const { uleb, cstr: string, u32 } = require("./helpers/dwarf-tree");

// Parse, layout and zstd budgets
async function limits() {
    function abbreviation(count, terminated = true) {
        return Buffer.from([1, 17, 0, ...Array(count).fill([1, 1]).flat(), ...(terminated ? [0, 0, 0] : [])]);
    }
    assert.strictEqual(parseAbbrev(abbreviation(1000), 0).get(1).attrs.length, 1000);
    assert.throws(() => parseAbbrev(abbreviation(1001), 0), { code: "DWARF_BUDGET_EXCEEDED" });
    assert.throws(() => parseAbbrev(abbreviation(1001, false), 0), { code: "DWARF_BUDGET_EXCEEDED" });
    assert.throws(() => parseAbbrev(abbreviation(1, false), 0), /Truncated/);

    function fixture(depth, width, variableCount = 1) {
        const dies = new Map();
        const childrenMap = new Map();
        for (let d = 0; d < depth; d++) {
            dies.set(d, { tag: c.DW_TAG_structure_type, name: `S${d}`, byteSize: 4 });
            const children = [];
            for (let i = 0; i < width; i++) {
                const id = depth + 1 + d * width + i;
                children.push(id);
                dies.set(id, { tag: c.DW_TAG_member, name: `m${i}`, typeRef: d + 1, memberOffset: 0 });
            }
            childrenMap.set(d, children);
        }
        dies.set(depth, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 });
        return {
            dies,
            childrenMap,
            variables: Array.from({ length: variableCount }, (_, i) => ({ name: `root${i}`, typeRef: 0 }))
        };
    }
    const healthy = buildCompositeLayouts(fixture(2, 2));
    assert.strictEqual(healthy.get("root0").members[0].compositeLayout.members.length, 2);
    const bounded = buildCompositeLayouts(fixture(7, 6)).get("root0");
    assert.strictEqual(bounded.truncated, true);
    function countNodes(layout) {
        return (
            1 +
            (layout.members || []).reduce(
                (sum, member) => sum + 1 + (member.compositeLayout ? countNodes(member.compositeLayout) : 0),
                0
            )
        );
    }
    assert.ok(countNodes(bounded) <= 16384, "partial layout work remains bounded");
    assert.ok(
        bounded.members.some((member) => member.compositeLayout),
        "an oversized branch must not discard all top-level members"
    );
    assert.strictEqual(buildCompositeLayouts(fixture(1, 2048)).size, 1);
    assert.strictEqual(buildCompositeLayouts(fixture(1, 1, 1025)).size, 1025);
    assert.throws(() => buildCompositeLayouts(fixture(1, 16384)), { code: "DWARF_BUDGET_EXCEEDED" });
    const mixed = fixture(1, 16384);
    mixed.dies.set(100000, { tag: c.DW_TAG_structure_type, name: "Small", byteSize: 4 });
    mixed.dies.set(100001, { tag: c.DW_TAG_member, name: "value", typeRef: 1, memberOffset: 0 });
    mixed.childrenMap.set(100000, [100001]);
    mixed.variables.push({ name: "small", typeRef: 100000 });
    const failures = [];
    const partial = buildCompositeLayouts(mixed, (name, error) => failures.push([name, error.code]));
    assert.strictEqual(partial.get("small").members.length, 1, "one oversized type must not hide healthy layouts");
    assert.deepStrictEqual(failures, [["root0", "DWARF_BUDGET_EXCEEDED"]]);
    const resolve = createCompositeLayoutResolver(fixture(1, 8, 5000));
    assert.strictEqual(resolve("root4999").members.length, 8, "repeated variables reuse the same layout");
    assert.strictEqual(buildCompositeLayouts(fixture(1, 1)).size, 1, "budgets must reset between invocations");
    const deepAliases = new Map();
    for (let index = 0; index < 4000; index++) deepAliases.set(index, { tag: c.DW_TAG_typedef, typeRef: index + 1 });
    deepAliases.set(4000, { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 });
    assert.strictEqual(
        buildVariableTypes({
            dies: deepAliases,
            childrenMap: new Map(),
            variables: [{ name: "deep", typeRef: 0 }]
        }).get("deep").watchType,
        "",
        "deep alias chains degrade safely without exhausting the JavaScript stack"
    );

    scenario("Bound excessive compilation units", () => {
        const { buildElf32 } = require("./helpers/elf-fixture");
        const { parseDwarfInternal } = require("../src/dwarf/parser");
        const unit = Buffer.alloc(6);
        unit.writeUInt32LE(2);
        const elf = buildElf32({
            sections: [
                { name: ".debug_info", data: Buffer.concat(Array(20000).fill(unit)) },
                { name: ".debug_abbrev", data: Buffer.from([0]) }
            ]
        });
        // Invalid units exhaust the diagnostic cap first; the parse stops there instead of failing as a whole.
        const flooded = parseDwarfInternal(elf);
        assert.deepStrictEqual(flooded.partial, {
            budget: "diagnostic",
            loadedUnits: 0,
            droppedUnits: 20000 - 1024,
            droppedBytes: (20000 - 1024) * unit.length
        });
        assert.strictEqual(flooded.diagnostics.length, 1025, "the cap plus one partial notice");
        const counted = parseDwarfInternal(elf, { budgets: { units: 5 } });
        assert.deepStrictEqual(counted.partial, {
            budget: "compilation unit",
            loadedUnits: 0,
            droppedUnits: 20000 - 5,
            droppedBytes: (20000 - 5) * unit.length
        });
    });

    // Length checks for zstd-compressed sections. fzstd.decompress(dat, buf) returns the caller's buffer preallocated from
    // ch_size, whose length always equals ch_size, so a later length check proves nothing; an ELF under 1 KB lying about
    // ch_size could make each required section take ch_size bytes of zero-filled memory (5 sections x 128 MiB = 640 MiB).
    scenario("Bound zstd-compressed debug sections", () => {
        // The zstd CLI's single-frame output for ASCII "DWARF-zstd-test" (15 bytes); the test needs no system zstd.
        const zstdPayload = Buffer.from("28b52ffd045879000044574152462d7a7374642d746573741a9e4eec", "hex");

        function zstdSection(chSize, frame) {
            const section = Buffer.alloc(12 + frame.length);
            section.writeUInt32LE(2, 0); // ELFCOMPRESS_ZSTD
            section.writeUInt32LE(chSize, 4);
            section.writeUInt32LE(1, 8);
            frame.copy(section, 12);
            return { section, entry: { offset: 0, size: section.length, flags: 0x800 } };
        }

        // Baseline: decompresses normally when ch_size matches the real decoded length.
        const baseline = zstdSection(15, zstdPayload);
        assert.strictEqual(
            _debugSectionData(baseline.section, baseline.entry, ".debug_info").toString(),
            "DWARF-zstd-test"
        );

        // A ch_size far larger than the real decoded length is rejected instead of returning a zero-filled buffer.
        const lying = zstdSection(4096, zstdPayload);
        assert.throws(
            () => _debugSectionData(lying.section, lying.entry, ".debug_info"),
            /size mismatch|budget/i,
            "a zstd section lying about ch_size must be rejected"
        );

        // Defence in depth: a frame header declaring a window or content size over budget aborts before fzstd preallocates.
        // Single-segment frame (single_segment=1) + 4-byte FCS (fcf=2) declaring contentSize=0xFFFFFFFF (4 GiB).
        const hugeFcs = Buffer.from("28b52ffda0ffffffff", "hex");
        const huge = zstdSection(1000, hugeFcs);
        assert.throws(
            () => _debugSectionData(huge.section, huge.entry, ".debug_info"),
            /budget/i,
            "a zstd frame declaring a huge content size must be rejected before decoding"
        );

        function decode(frame, size = 15) {
            const { section, entry } = zstdSection(size, frame);
            return _debugSectionData(section, entry, ".debug_info");
        }

        const skip = Buffer.from("502a4d1804000000deadbeef", "hex");
        assert.strictEqual(decode(Buffer.concat([skip, zstdPayload])).toString(), "DWARF-zstd-test");
        assert.strictEqual(
            decode(Buffer.concat([zstdPayload, skip, zstdPayload, skip]), 30).toString(),
            "DWARF-zstd-testDWARF-zstd-test"
        );
        // Raw and RLE blocks have different encoded lengths; magic inside raw data is not a frame.
        assert.deepStrictEqual(
            decode(Buffer.from("28b52ffd200421000028b52ffd", "hex"), 4),
            Buffer.from("28b52ffd", "hex")
        );
        assert.strictEqual(decode(Buffer.from("28b52ffd200423000041", "hex"), 4).toString(), "AAAA");
        assert.strictEqual(decode(Buffer.from("28b52ffd2004100000414213000043", "hex"), 4).toString(), "ABCC");

        for (const invalid of [
            Buffer.from("28b5", "hex"),
            Buffer.from("28b52ffd28ff", "hex"),
            Buffer.from("28b52ffd2300", "hex"),
            Buffer.from("28b52ffd20010100", "hex"),
            Buffer.from("28b52ffd2001090000", "hex"),
            Buffer.from("28b52ffd2001070000", "hex"),
            zstdPayload.subarray(0, -1),
            skip.subarray(0, 6),
            skip.subarray(0, -1)
        ]) {
            assert.throws(() => decode(invalid), /invalid|truncated/i);
        }

        // Instrument the actual decoder's allocations, so regressions fail without allocating huge windows.
        const vm = require("vm");
        const { createRequire } = require("module");
        const decoder = { exports: {} };
        const allocations = [];
        const guardedUint8Array = new Proxy(Uint8Array, {
            construct(target, args) {
                if (typeof args[0] === "number") {
                    allocations.push(args[0]);
                    assert.ok(args[0] <= 32 * 1024 * 1024 + 12, "decoder allocated an unchecked window");
                }
                return Reflect.construct(target, args);
            }
        });
        vm.runInNewContext(fs.readFileSync(require.resolve("fzstd"), "utf8"), {
            exports: decoder.exports,
            Uint8Array: guardedUint8Array
        });
        const binaryFile = require.resolve("../src/dwarf/binary");
        const binaryRequire = createRequire(binaryFile);
        const binary = { exports: {} };
        vm.runInNewContext(fs.readFileSync(binaryFile, "utf8"), {
            module: binary,
            Buffer,
            require: (name) => (name === "fzstd" ? decoder.exports : binaryRequire(name))
        });
        for (const prefix of [Buffer.alloc(0), zstdPayload, skip, Buffer.concat([zstdPayload, skip])]) {
            for (const frame of [
                Buffer.from("28b52ffda000000004010000", "hex"), // 64 MiB single-segment window
                Buffer.from("28b52ffd0080010000", "hex"), // 64 MiB window, unknown content size
                Buffer.from("28b52ffd00ff010000", "hex") // exponent must not wrap through a 32-bit shift
            ]) {
                const { section, entry } = zstdSection(15, Buffer.concat([prefix, frame]));
                assert.throws(() => binary.exports.debugSectionData(section, entry, ".debug_info"), {
                    code: "DWARF_BUDGET_EXCEEDED"
                });
            }
        }
        assert.ok(
            allocations.some((size) => size > 1024),
            "valid prefix must exercise the instrumented decoder"
        );
    });

    console.log("DWARF parse, layout and zstd budget tests passed");
}

// Abbreviation and DIE budgets span the whole parse
async function globalBudget() {
    // DWARF abbreviation and DIE budgets cover the whole parse, not each call or CU; otherwise a file with many CUs or
    // abbreviation table offsets could make the extension host accumulate hundreds of MB of heap. A minimal programmatic
    // ELF32 checks that the global budget stops parsing in time: the CU exceeding it is rolled back as a whole, fully
    // parsed CUs are kept, and one DWARF_PARTIAL diagnostic is reported.

    // A table of count zero-attribute abbreviations with codes from 1; returns { bytes, size }.
    function abbrevTable(count, tag) {
        const bytes = [];
        for (let code = 1; code <= count; code++) {
            bytes.push(...uleb(code), ...uleb(tag), 0, 0, 0); // hasChildren=0, at=0, form=0
        }
        bytes.push(0); // end of table (code 0)
        return Buffer.from(bytes);
    }

    // Global abbreviation budget: three CUs each reference a different abbrevOff with 8000 abbreviations per table. Each
    // table is under the per-call limit, but the global budget (<= 20000) runs out inside the third table, so the first two
    // CUs are kept and the third is dropped.
    {
        const PER_TABLE = 8000;
        const tables = [abbrevTable(PER_TABLE, 0x24), abbrevTable(PER_TABLE, 0x24), abbrevTable(PER_TABLE, 0x24)];
        const offsets = [];
        let acc = 0;
        for (const t of tables) {
            offsets.push(acc);
            acc += t.length;
        }
        const abbrevData = Buffer.concat(tables);

        // Each CU: unit_length(u32) + version(u16=4) + abbrev_off(u32) + addr_size(u8=4) + code1 DIE
        const infoParts = [];
        for (const off of offsets) {
            const dieBytes = Buffer.from([1]); // code 1
            const unitLen = 2 + 4 + 1 + dieBytes.length;
            const cu = Buffer.alloc(4 + unitLen);
            cu.writeUInt32LE(unitLen, 0);
            cu.writeUInt16LE(4, 4); // version
            cu.writeUInt32LE(off, 6); // debug_abbrev_offset
            cu.writeUInt8(4, 10); // address_size
            dieBytes.copy(cu, 11);
            infoParts.push(cu);
        }
        const infoData = Buffer.concat(infoParts);
        const elf = buildElf(infoData, abbrevData);
        const parsed = parseDwarfInternal(elf);
        assert.deepStrictEqual(
            parsed.partial,
            { budget: "global abbreviation", loadedUnits: 2, droppedUnits: 1, droppedBytes: infoParts[2].length },
            "the global abbreviation budget spans CUs"
        );
        assert.strictEqual(parsed.diagnostics[0].code, "DWARF_PARTIAL");
        assert.strictEqual(parsed.dies.size, 2, "only the root DIEs of the first two CUs remain");
    }

    // Global DIE budget: two CUs with about 1.05 million zero-attribute DIEs each. Each CU is under a per-CU limit, but the
    // global budget (<= 2 million) runs out inside the second CU, and every DIE it stored is rolled back.
    {
        const DIES_PER_CU = 1050000;
        // Abbreviation table: code1 = compile_unit (0x11, no children, 0 attributes), code2 = base_type (0x24, no children,
        // 0 attributes)
        const abbrevData = Buffer.from([1, 0x11, 0, 0, 0, 2, 0x24, 0, 0, 0, 0]);

        const infoParts = [];
        for (let cu = 0; cu < 2; cu++) {
            // header: version(2) + abbrev_off(4) + addr_size(1); DIEs: code1 + code2 x N
            const dieCount = 1 + DIES_PER_CU;
            const unitLen = 2 + 4 + 1 + dieCount;
            const cuBuf = Buffer.alloc(4 + unitLen);
            cuBuf.writeUInt32LE(unitLen, 0);
            cuBuf.writeUInt16LE(4, 4);
            cuBuf.writeUInt32LE(0, 6); // abbrev offset 0
            cuBuf.writeUInt8(4, 10);
            cuBuf.writeUInt8(1, 11); // compile_unit DIE
            cuBuf.fill(2, 12, 12 + DIES_PER_CU); // all remaining DIEs are code2
            infoParts.push(cuBuf);
        }
        const infoData = Buffer.concat(infoParts);
        const elf = buildElf(infoData, abbrevData);
        const parsed = parseDwarfInternal(elf);
        assert.deepStrictEqual(
            parsed.partial,
            { budget: "DIE", loadedUnits: 1, droppedUnits: 1, droppedBytes: infoParts[1].length },
            "the global DIE budget spans CUs"
        );
        assert.strictEqual(parsed.dies.size, 1 + DIES_PER_CU, "no DIEs of the second CU remain");
        assert.ok([...parsed.dies.keys()].every((offset) => offset < infoParts[0].length));
    }

    console.log("DWARF global budget tests passed");
}

// Partial-parse degradation keeps complete units
async function partialParse() {
    const { buildDwarfElf } = require("./helpers/elf-fixture");
    // §2 Stage A: a global DWARF budget keeps every complete compilation unit instead of discarding all
    // types. The unit being parsed when a budget runs out is rolled back as a whole.

    const address = (value) => [5, 0x03, ...u32(value)];
    const ref = (label) => ({ label });
    const refAddr = (unit, label) => ({ unit, label });

    const declarations = [
        [1, 0x11, 1, [0x03, 0x08]],
        [2, 0x24, 0, [0x03, 0x08], [0x3e, 0x0b], [0x0b, 0x0b]],
        [3, 0x13, 1, [0x03, 0x08], [0x0b, 0x0b]],
        [4, 0x0d, 0, [0x03, 0x08], [0x49, 0x13], [0x38, 0x0b]],
        [5, 0x34, 0, [0x03, 0x08], [0x49, 0x13], [0x02, 0x18]],
        [6, 0x34, 0, [0x03, 0x08], [0x49, 0x10], [0x02, 0x18]],
        [7, 0x2e, 1, [0x03, 0x08]],
        [8, 0x34, 0, [0x03, 0x08], [0x49, 0x13]],
        [9, 0x34, 0, [0x31, 0x13], [0x02, 0x18]]
    ];
    const abbrev = Buffer.from([
        ...declarations.flatMap(([code, tag, children, ...attrs]) => [
            ...uleb(code),
            ...uleb(tag),
            children,
            ...attrs.flat(),
            0,
            0
        ]),
        0
    ]);

    // Units are DWARF 4 with a 32-bit offset size. ref4 targets are unit-relative, ref_addr targets are
    // .debug_info offsets, so both are resolved after every unit has its final position.
    function buildInfo(specs) {
        const units = specs.map((spec) => {
            const bytes = [...u32(0), 4, 0, ...u32(0), 4];
            const offsets = new Map();
            const fixups = [];
            spec({
                die(label, code, ...attributes) {
                    offsets.set(label, bytes.length);
                    bytes.push(...uleb(code));
                    for (const attr of attributes) {
                        if (attr.label) {
                            fixups.push({ position: bytes.length, ...attr });
                            bytes.push(...u32(0));
                        } else bytes.push(...attr);
                    }
                },
                end() {
                    bytes.push(0);
                }
            });
            return { bytes, offsets, fixups };
        });
        const starts = [];
        let start = 0;
        for (const unit of units) {
            starts.push(start);
            start += unit.bytes.length;
        }
        const info = Buffer.concat(
            units.map((unit) => {
                const buffer = Buffer.from(unit.bytes);
                buffer.writeUInt32LE(buffer.length - 4, 0);
                for (const fixup of unit.fixups) {
                    const target = fixup.unit === undefined ? unit : units[fixup.unit];
                    const offset = target.offsets.get(fixup.label);
                    assert.notStrictEqual(offset, undefined, fixup.label);
                    buffer.writeUInt32LE(
                        fixup.unit === undefined ? offset : starts[fixup.unit] + offset,
                        fixup.position
                    );
                }
                return buffer;
            })
        );
        return { elf: buildDwarfElf(info, abbrev), starts, size: info.length };
    }

    // Eight budgeted DIEs: unit, int, struct, two members, struct terminator, variable, unit terminator.
    function standardUnit(index) {
        return (unit) => {
            unit.die("cu", 1, string(`file${index}.c`));
            unit.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
            unit.die("struct", 3, string(`S${index}`), [8]);
            unit.die("a", 4, string("a"), ref("int"), [0]);
            unit.die("b", 4, string("b"), ref("int"), [4]);
            unit.end();
            unit.die("var", 5, string(`v${index}`), ref("struct"), address(0x20000000 + index * 16));
            unit.end();
        };
    }

    function partialOf(parsed) {
        return parsed.diagnostics.filter((entry) => entry.code === "DWARF_PARTIAL");
    }

    // A DIE budget that runs out inside the third unit keeps the first two and rolls back the third.
    {
        const fixture = buildInfo([0, 1, 2, 3].map(standardUnit));
        const full = parseDwarfInternal(fixture.elf);
        assert.deepStrictEqual(full.diagnostics, []);
        assert.strictEqual(full.partial, null);
        assert.deepStrictEqual(
            full.variables.map((variable) => variable.name),
            ["v0", "v1", "v2", "v3"]
        );

        const parsed = parseDwarfInternal(fixture.elf, { budgets: { dies: 20 } });
        assert.deepStrictEqual(
            parsed.variables.map((variable) => variable.name),
            ["v0", "v1"]
        );
        const [diagnostic] = partialOf(parsed);
        assert.strictEqual(parsed.diagnostics[0], diagnostic, "the partial notice leads the diagnostics");
        assert.strictEqual(partialOf(parsed).length, 1);
        assert.deepStrictEqual(parsed.partial, {
            budget: "DIE",
            loadedUnits: 2,
            droppedUnits: 2,
            droppedBytes: fixture.size - fixture.starts[2]
        });
        assert.strictEqual(diagnostic.i18nKey, "elfDiag.partial");
        assert.deepStrictEqual(diagnostic.i18nParams, { loaded: 2, total: 4, budget: "DIE" });
        assert.strictEqual(
            diagnostic.message,
            "DWARF types are partial: 2 of 4 units loaded; parsing stopped at the DIE budget"
        );

        // Rollback equivalence: what remains is exactly the full parse restricted to the kept units.
        const kept = (offset) => offset < fixture.starts[2];
        for (const field of ["dies", "childrenMap", "parentOf"]) {
            assert.deepStrictEqual(
                [...parsed[field].keys()],
                [...full[field].keys()].filter(kept),
                field + " keeps only complete units"
            );
            for (const [key, value] of parsed[field])
                if (field !== "dies") assert.deepStrictEqual(value, full[field].get(key), field);
        }
        assert.ok(
            [...parsed.childrenMap.values()].flat().every(kept),
            "no child of a rolled-back unit survives in a kept list"
        );
        const fullTypes = buildVariableTypes(full);
        const partialTypes = buildVariableTypes(parsed);
        const fullLayouts = buildCompositeLayouts(full);
        const partialLayouts = buildCompositeLayouts(parsed);
        for (const name of ["v0", "v1"]) {
            assert.deepStrictEqual(partialTypes.get(name), fullTypes.get(name), name);
            assert.deepStrictEqual(partialLayouts.get(name), fullLayouts.get(name), name);
        }
        for (const name of ["v2", "v3"]) {
            assert.strictEqual(partialTypes.has(name), false, name + " is absent, not guessed");
            assert.strictEqual(partialLayouts.has(name), false, name);
        }

        // Stopping on the unit terminator rolls back a unit whose variable and type were already stored.
        const late = parseDwarfInternal(fixture.elf, { budgets: { dies: 23 } });
        assert.deepStrictEqual(
            late.variables.map((variable) => variable.name),
            ["v0", "v1"]
        );
        assert.deepStrictEqual([...late.dies.keys()], [...full.dies.keys()].filter(kept));
        assert.strictEqual(buildVariableTypes(late).has("v2"), false);
    }

    // A cross-unit reference into a dropped unit resolves as missing, never as another type.
    {
        const fixture = buildInfo([
            standardUnit(0),
            (unit) => {
                unit.die("cu", 1, string("cross.c"));
                unit.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
                unit.die("cross", 6, string("cross"), refAddr(2, "struct"), address(0x20001000));
                unit.end();
            },
            standardUnit(2)
        ]);
        const full = parseDwarfInternal(fixture.elf);
        assert.deepStrictEqual(
            buildCompositeLayouts(full)
                .get("cross")
                .members.map((member) => member.name),
            ["a", "b"]
        );
        const parsed = parseDwarfInternal(fixture.elf, { budgets: { dies: 14 } });
        assert.deepStrictEqual(parsed.partial, {
            budget: "DIE",
            loadedUnits: 2,
            droppedUnits: 1,
            droppedBytes: fixture.size - fixture.starts[2]
        });
        assert.ok(
            parsed.variables.some((variable) => variable.name === "cross"),
            "the referencing variable is kept"
        );
        const type = buildVariableTypes(parsed).get("cross");
        assert.ok(!type || type.kind === "unknown", "a dangling type reference is never resolved to a struct");
        assert.strictEqual(buildCompositeLayouts(parsed).has("cross"), false);
    }

    // Unit and abbreviation budgets degrade the same way.
    {
        const fixture = buildInfo([0, 1, 2, 3].map(standardUnit));
        const units = parseDwarfInternal(fixture.elf, { budgets: { units: 3 } });
        assert.deepStrictEqual(
            units.variables.map((variable) => variable.name),
            ["v0", "v1", "v2"]
        );
        assert.deepStrictEqual(units.partial, {
            budget: "compilation unit",
            loadedUnits: 3,
            droppedUnits: 1,
            droppedBytes: fixture.size - fixture.starts[3]
        });

        for (const budgets of [{ abbrevs: 3 }, { attrs: 3 }]) {
            const parsed = parseDwarfInternal(fixture.elf, { budgets });
            assert.strictEqual(parsed.dies.size, 0, "the first unit cannot load its abbreviations");
            assert.deepStrictEqual(parsed.variables, []);
            assert.strictEqual(parsed.partial.loadedUnits, 0);
            assert.strictEqual(parsed.partial.droppedUnits, 4);
            assert.match(parsed.partial.budget, /abbreviation|attribute/);
        }

        // Overrides can only lower a budget; malformed or larger values keep the production limits.
        for (const dies of [0, -1, 1.5, "5", DEFAULT_BUDGETS.dies * 2]) {
            const parsed = parseDwarfInternal(fixture.elf, { budgets: { dies } });
            assert.strictEqual(parsed.partial, null, String(dies));
            assert.strictEqual(parsed.variables.length, 4);
        }
        assert.ok(Object.isFrozen(DEFAULT_BUDGETS));
    }

    // The local-retention retry pass stops at the same unit and reports one partial notice.
    {
        const fixture = buildInfo([
            (unit) => {
                unit.die("cu", 1, string("locals.c"));
                unit.die("int", 2, string("int"), [c.DW_ATE_signed], [4]);
                unit.die("function", 7, string("work"));
                unit.die("counter", 8, string("counter"), ref("int"));
                unit.end();
                unit.die("concrete", 9, ref("counter"), address(0x20002000));
                unit.end();
            },
            standardUnit(1),
            standardUnit(2)
        ]);
        const full = parseDwarfInternal(fixture.elf);
        assert.deepStrictEqual(
            full.variables.map((variable) => variable.name),
            ["counter", "v1", "v2"],
            "the retry pass resolves the skipped abstract origin"
        );
        const parsed = parseDwarfInternal(fixture.elf, { budgets: { dies: 19 } });
        assert.deepStrictEqual(
            parsed.variables.map((variable) => variable.name),
            ["counter", "v1"]
        );
        assert.strictEqual(partialOf(parsed).length, 1);
        assert.strictEqual(parsed.partial.loadedUnits, 2);
        assert.strictEqual(parsed.partial.droppedUnits, 1);
    }

    // The partial notice is localized from the parser message as well as from its i18n key.
    {
        const en = require("../src/i18n/en");
        const zh = require("../src/i18n/zh");
        for (const table of [en, zh]) {
            const t = (key, params = {}) =>
                String(table[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
            const text = formatDiagnostic(
                "DWARF_PARTIAL: DWARF types are partial: 2 of 4 units loaded; parsing stopped at the DIE budget",
                t
            );
            assert.ok(text.startsWith("DWARF_PARTIAL: "), text);
            assert.ok(text.includes("2") && text.includes("4") && text.includes("DIE"), text);
            assert.notStrictEqual(text, "DWARF_PARTIAL: " + table["elfDiag.code.DWARF_PARTIAL"]);
            assert.ok(table["elfDiag.code.DWARF_PARTIAL"]);
        }
    }

    // A partial parse is not complete debug information: symbols without a kept DWARF record keep the
    // user origin instead of being classified as toolchain runtime objects, and stay type-unknown.
    {
        const fixture = buildInfo([standardUnit(0)]);
        const symbols = (names) => names.map((name, index) => ({ name, address: 0x20000000 + index * 16, size: 4 }));
        const service = (diagnostics) =>
            new ElfService({
                context: { workspaceState: { get: () => "/fake/app.elf" } },
                cacheKey: "elf",
                fs: {
                    statSync: () => ({ size: fixture.elf.length, mtimeMs: 1 }),
                    readFileSync: () => fixture.elf
                },
                crypto,
                cleanPath: (value) => value,
                t: (key) => key,
                elfSymbols: {
                    ...elfSymbols,
                    parseElfSymbols: () => ({ symbols: symbols(["v0", "sensorValue"]), functions: [], warnings: [] }),
                    parseElfSections: () => ({ sections: [], programHeaders: [] })
                },
                dwarf: {
                    parseDwarf: () => ({
                        types: new Map([["v0", { kind: "scalar", typeName: "int", watchType: "i32" }]]),
                        layouts: new Map(),
                        displayNames: new Map(),
                        diagnostics
                    })
                }
            });
        const partialDiagnostic = { code: "DWARF_PARTIAL", stage: "parse", message: "partial" };
        const partial = service([partialDiagnostic]).read();
        const complete = service([]).read();
        const origin = (result, name) => result.symbols.find((symbol) => symbol.name === name).origin;
        assert.strictEqual(origin(complete, "sensorValue"), "runtime", "complete DWARF without a record means runtime");
        assert.strictEqual(origin(partial, "sensorValue"), "user", "a dropped unit's variable stays a user variable");
        assert.strictEqual(partial.typeMetadataIncomplete, true);
        const dropped = partial.symbols.find((symbol) => symbol.name === "sensorValue");
        assert.strictEqual(dropped.hasDwarfWriteType, false, "writes still need a DWARF type");
        assert.ok(partial.warnings.some((warning) => warning.startsWith("DWARF_PARTIAL: ")));
    }

    console.log("DWARF partial-parse degradation tests passed");
}

(async () => {
    await scenario("Parse, layout and zstd budgets", limits);
    await scenario("Abbreviation and DIE budgets span the whole parse", globalBudget);
    await scenario("Partial-parse degradation keeps complete units", partialParse);
    console.log("DWARF budget, global budget and partial-parse tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
