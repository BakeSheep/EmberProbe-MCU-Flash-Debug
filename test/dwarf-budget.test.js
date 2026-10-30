"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { parseAbbrev } = require("../src/dwarf/binary");
const { buildCompositeLayouts, buildVariableTypes, createCompositeLayoutResolver } = require("../src/dwarf/types");
const c = require("../src/dwarf/constants");
const { _debugSectionData } = require("../src/dwarf");
const fs = require("fs");

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
    buildVariableTypes({ dies: deepAliases, childrenMap: new Map(), variables: [{ name: "deep", typeRef: 0 }] }).get(
        "deep"
    ).watchType,
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
    assert.deepStrictEqual(decode(Buffer.from("28b52ffd200421000028b52ffd", "hex"), 4), Buffer.from("28b52ffd", "hex"));
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
