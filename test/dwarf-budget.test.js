"use strict";
const assert = require("assert");
const { parseAbbrev } = require("../src/dwarf/binary");
const { buildCompositeLayouts } = require("../src/dwarf/types");
const c = require("../src/dwarf/constants");

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
            dies.set(id, { tag: c.DW_TAG_member, name: `m${i}`, typeRef: d + 1 });
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
assert.throws(() => buildCompositeLayouts(fixture(7, 6)), { code: "DWARF_BUDGET_EXCEEDED" });
assert.throws(() => buildCompositeLayouts(fixture(1, 2048)), { code: "DWARF_BUDGET_EXCEEDED" });
assert.throws(() => buildCompositeLayouts(fixture(1, 1, 1025)), { code: "DWARF_BUDGET_EXCEEDED" });
assert.strictEqual(buildCompositeLayouts(fixture(1, 1)).size, 1, "budgets must reset between invocations");
console.log("DWARF budget tests passed");
