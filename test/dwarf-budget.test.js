"use strict";
const assert = require("assert");
const { parseAbbrev } = require("../src/dwarf/binary");
const { buildCompositeLayouts, buildVariableTypes, createCompositeLayoutResolver } = require("../src/dwarf/types");
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
console.log("DWARF budget tests passed");
