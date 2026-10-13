"use strict";
// C++ member roles and pointer metadata: artificial and standard-library internals are
// classified for default hiding, pointers carry their target kind, raw paths stay intact.
const assert = require("assert");
const zlib = require("zlib");
const c = require("../src/dwarf/constants");
const dwarf = require("../src/dwarf");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { buildCompositeLayouts } = require("../src/dwarf/types");
const { memberRole, stdSummary, isStdType } = require("../src/dwarf/memberRoles");
const elf = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
const { formatPointer, summaryRoute } = require("../src/webview/runtime");

// —— Role rules ——
assert.strictEqual(memberRole("class Widget", { name: "_vptr.Listener" }), "artificial");
assert.strictEqual(memberRole("class Widget", { name: "hidden", isArtificial: true }), "artificial");
assert.strictEqual(memberRole("class std::function<void(int)>", { name: "_M_invoker" }), "internal");
assert.strictEqual(memberRole("std::_Function_base", { name: "__state" }), "internal");
assert.strictEqual(memberRole("std::atomic<int>", { name: "@base0", isBase: true }), "internal");
assert.strictEqual(memberRole("std::pair<int, int>", { name: "first" }), undefined, "public std members stay visible");
assert.strictEqual(memberRole("class Driver", { name: "_M_state" }), undefined, "user types keep reserved names");
assert.strictEqual(memberRole("class stdlib::Thing", { name: "_M_x" }), undefined);
assert.ok(isStdType("struct __gnu_cxx::__aligned_membuf<int>"));
assert.strictEqual(stdSummary("class std::atomic<int>").kind, "value");
assert.deepStrictEqual(stdSummary("std::function<void()>").presence, ["_M_manager"]);
assert.strictEqual(stdSummary("class Widget"), undefined);
assert.strictEqual(stdSummary("std::vector<int>"), undefined);
stdSummary("std::array<int, 4>").targets.push("mutated");
assert.deepStrictEqual(stdSummary("std::array<int, 4>").targets, ["_M_elems"], "summaries are fresh copies");

// —— Pointer text ——
assert.strictEqual(formatPointer(0), "0x00000000");
assert.strictEqual(formatPointer(0x2000014c), "0x2000014C");
assert.strictEqual(formatPointer(0xffffffff), "0xFFFFFFFF");
for (const invalid of [-1, 0x100000000, NaN, 1.5, null]) assert.strictEqual(formatPointer(invalid), null);

// —— Synthetic DWARF: artificial members, typedef'd pointers and void/function targets ——
{
    const dies = new Map();
    const childrenMap = new Map();
    const intDie = { tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 };
    dies.set(1, intDie);
    dies.set(2, { tag: c.DW_TAG_pointer_type, typeRef: 1 });
    dies.set(3, { tag: c.DW_TAG_typedef, name: "IntHandle", typeRef: 2 });
    dies.set(4, { tag: c.DW_TAG_pointer_type });
    dies.set(5, { tag: c.DW_TAG_subroutine_type });
    dies.set(6, { tag: c.DW_TAG_pointer_type, typeRef: 5 });
    dies.set(7, { tag: c.DW_TAG_const_type });
    dies.set(8, { tag: c.DW_TAG_pointer_type, typeRef: 7 });
    dies.set(10, { tag: c.DW_TAG_structure_type, name: "Holder", byteSize: 20 });
    dies.set(11, { tag: c.DW_TAG_member, name: "handle", typeRef: 3, memberOffset: 0 });
    dies.set(12, { tag: c.DW_TAG_member, name: "opaque", typeRef: 4, memberOffset: 4 });
    dies.set(13, { tag: c.DW_TAG_member, name: "hook", typeRef: 6, memberOffset: 8 });
    dies.set(14, { tag: c.DW_TAG_member, name: "secret", typeRef: 1, memberOffset: 12, isArtificial: true });
    dies.set(15, { tag: c.DW_TAG_member, name: "constVoid", typeRef: 8, memberOffset: 16 });
    childrenMap.set(10, [11, 12, 13, 14, 15]);
    const layout = buildCompositeLayouts({ dies, childrenMap, variables: [{ name: "holder", typeRef: 10 }] }).get(
        "holder"
    );
    const byName = new Map(layout.members.map((member) => [member.name, member]));
    assert.strictEqual(byName.get("handle").typeName, "IntHandle", "typedef names are kept");
    assert.strictEqual(byName.get("handle").isPointer, true, "pointer flags survive typedefs");
    assert.strictEqual(byName.get("handle").pointerTarget, "data");
    assert.strictEqual(byName.get("opaque").pointerTarget, "void");
    assert.strictEqual(byName.get("constVoid").pointerTarget, "void");
    assert.strictEqual(byName.get("hook").pointerTarget, "function");
    assert.strictEqual(byName.get("secret").memberRole, "artificial");
    assert.strictEqual(byName.get("secret").isPointer, undefined);
    const bytes = Buffer.alloc(20);
    bytes.writeUInt32LE(0x20000010, 0);
    const tree = elf.decodeComposite(bytes, layout, { name: "holder", address: 0x20000000, size: 20 });
    const decoded = new Map(tree.members.map((member) => [member.name, member]));
    assert.strictEqual(decoded.get("handle").value, 0x20000010, "numeric values stay intact for charts");
    assert.strictEqual(decoded.get("handle").valueText, "0x20000010");
    assert.strictEqual(decoded.get("opaque").valueText, "0x00000000");
    assert.strictEqual(decoded.get("secret").valueText, null, "only pointers get address text");
    assert.strictEqual(decoded.get("secret").memberRole, "artificial");
}

// —— Real GCC output (DWARF 4 and 5) ——
const fixture = require("./fixtures/pointer-classes/elf.json");
const VISIBLE_MOTOR_LEAVES = [
    "motor.@base0.parent",
    "motor.@base0.nextSibling",
    "motor.@base0.label",
    "motor.@base0.onClick",
    "motor.@base0.userData",
    "motor.@base0.x",
    "motor.@base0.y",
    "motor.speed",
    "motor.position",
    "motor.callback._M_invoker",
    "motor.state.@base0._M_i",
    "motor.rxBuffer"
];
for (const version of [4, 5]) {
    const buffer = zlib.inflateSync(Buffer.from(fixture[`dwarf${version}`], "base64"));
    const parsed = dwarf.parseDwarf(buffer, { runtime: true });
    assert.deepStrictEqual(parsed.diagnostics, [], `DWARF ${version} parses cleanly`);

    const internal = parseDwarfInternal(buffer);
    const vptr = [...internal.dies.values()].find((die) => die.name === "_vptr.Listener");
    assert.strictEqual(vptr?.isArtificial, true, `DWARF ${version} reads DW_AT_artificial`);

    const result = elf.parseElfSymbols(buffer);
    new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
        result,
        parsed.types,
        parsed.layouts,
        parsed.displayNames
    );
    const symbols = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
    assert.strictEqual(symbols.get("counterPtr").isPointer, true);
    assert.strictEqual(symbols.get("counterPtr").pointerTarget, "data");
    assert.strictEqual(symbols.get("idleHook").pointerTarget, "function");
    assert.strictEqual(symbols.get("motor").isPointer, undefined);

    const motor = symbols.get("motor");
    const leaves = elf.expandCompositeLeaves(motor, motor.compositeLayout, null);
    assert.strictEqual(leaves.length, 26, `DWARF ${version}: every raw leaf remains addressable`);
    assert.deepStrictEqual(
        leaves.filter((leaf) => !leaf.memberRole).map((leaf) => leaf.path),
        VISIBLE_MOTOR_LEAVES,
        `DWARF ${version}: default view keeps only meaningful members`
    );
    const leaf = (path) => leaves.find((entry) => entry.path === path);
    assert.strictEqual(leaf("motor.@base0.@base0._vptr.Listener").memberRole, "artificial");
    assert.strictEqual(leaf("motor.callback.@base1._M_manager").memberRole, "internal");
    assert.strictEqual(leaf("motor.callback._M_invoker").displayPath, "motor.callback");
    assert.strictEqual(leaf("motor.state.@base0._M_i").displayPath, "motor.state");
    assert.strictEqual(leaf("motor.state.@base0._M_i").type, "i32");
    assert.strictEqual(leaf("motor.position").displayPath, undefined);
    assert.strictEqual(leaf("motor.@base0.onClick").pointerTarget, "function");
    assert.strictEqual(leaf("motor.@base0.userData").pointerTarget, "void");
    assert.strictEqual(leaf("motor.rxBuffer").isPointer, true);
    assert.strictEqual(leaf("motor.speed").isPointer, undefined);

    const callback = motor.compositeLayout.members.find((member) => member.name === "callback");
    assert.deepStrictEqual(
        summaryRoute(callback).map((member) => member.name),
        ["_M_invoker"]
    );
    const state = motor.compositeLayout.members.find((member) => member.name === "state");
    assert.deepStrictEqual(
        summaryRoute(state).map((member) => member.name),
        ["@base0", "_M_i"]
    );

    const bytes = Buffer.alloc(motor.size);
    const base = Number(motor.address) >>> 0;
    bytes.writeUInt32LE(0x2000000c, leaf("motor.rxBuffer").address - base);
    bytes.writeInt32LE(7, leaf("motor.state.@base0._M_i").address - base);
    const tree = elf.decodeComposite(bytes, motor.compositeLayout, motor);
    const member = (name) => tree.members.find((entry) => entry.name === name);
    assert.strictEqual(member("rxBuffer").valueText, "0x2000000C");
    assert.strictEqual(member("rxBuffer").pointerTarget, "data");
    assert.strictEqual(member("state").stdSummary.kind, "value");
    assert.strictEqual(member("state").members[0].memberRole, "internal");
    assert.strictEqual(member("state").members[0].members[0].value, 7);

    const graph = parsed.layouts.get("fleet").runtimeLayout;
    const pointers = graph.types.filter((type) => type.kind === "pointer");
    const named = (name) => pointers.find((type) => type.typeName === name);
    assert.strictEqual(named("Node *")?.pointerTarget, "data", "runtime pointers are named after their target");
    assert.strictEqual(named("Opaque *")?.pointerTarget, "incomplete");
    assert.strictEqual(named("void *")?.pointerTarget, "void");
    assert.strictEqual(named("function *")?.pointerTarget, "function");
    assert.ok(!pointers.some((type) => type.typeName.trim() === "*" || !type.typeName));
    const memberPointer = graph.types.find((type) => type.isMemberPointer);
    assert.strictEqual(memberPointer.byteSize, 8, "member function pointers default to two words");
    assert.strictEqual(memberPointer.watchType, "u64");
    const fn = graph.types.find((type) => type.typeName === "std::function<void(int)>");
    assert.strictEqual(fn.stdSummary.kind, "function");
    assert.ok(fn.fields.every((field) => field.memberRole === "internal"));
    const root = graph.types[graph.root];
    assert.ok(
        root.fields.every((field) => !field.memberRole),
        "user members are never hidden"
    );
}

console.log("Member roles and pointer metadata tests passed");
