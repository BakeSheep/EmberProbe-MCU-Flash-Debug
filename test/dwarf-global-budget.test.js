"use strict";
// DWARF abbreviation and DIE budgets cover the whole parse, not each call or CU; otherwise a file with many CUs or
// abbreviation table offsets could make the extension host accumulate hundreds of MB of heap. A minimal programmatic
// ELF32 checks that the global budget stops parsing in time: the CU exceeding it is rolled back as a whole, fully
// parsed CUs are kept, and one DWARF_PARTIAL diagnostic is reported.
const assert = require("assert");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { buildDwarfElf: buildElf } = require("./helpers/elf-fixture");
const { uleb } = require("./helpers/dwarf-tree");

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
