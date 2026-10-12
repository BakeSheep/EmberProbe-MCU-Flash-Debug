"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const c = require("../src/dwarf/constants");
const { buildCompositeLayouts, createCompositeLayoutResolver, buildVariableTypes } = require("../src/dwarf/types");
const {
    MAX_COMPOSITE_DEPTH,
    MAX_COMPOSITE_NODES,
    MAX_TYPE_ALIASES,
    MAX_TYPE_INFO_DEPTH
} = require("../src/dwarf/layoutLimits");
const { validateComposite } = require("../src/compositeValidation");
const elf = require("../src/elfSymbols");
const { normalizeWatchList } = require("../src/validation");
const runtime = require("../src/webview/runtime");
const { buildActiveReadPlan } = require("../src/services/liveWatchService");

function fixture() {
    const dies = new Map();
    const childrenMap = new Map();
    const variables = [];
    let next = 1;
    const add = (die, children = []) => {
        const ref = next++;
        dies.set(ref, die);
        childrenMap.set(ref, children);
        return ref;
    };
    const integer = add({ tag: c.DW_TAG_base_type, name: "int", encoding: c.DW_ATE_signed, byteSize: 4 });
    const member = (name, typeRef, memberOffset = 0) => add({ tag: c.DW_TAG_member, name, typeRef, memberOffset });
    const struct = (name, children, byteSize = 8, tag = c.DW_TAG_structure_type) =>
        add({ tag, name, byteSize }, children);
    const chain = (count, target = integer) => {
        for (let index = count - 1; index >= 0; index--) target = struct("S" + index, [member("next", target)]);
        return target;
    };
    const variable = (name, typeRef) => variables.push({ name, typeRef });
    const array = (typeRef, count = 1) =>
        add({ tag: c.DW_TAG_array_type, typeRef }, [add({ tag: c.DW_TAG_subrange_type, subrangeCount: count })]);
    const aliases = (target, count) => {
        const tags = [c.DW_TAG_typedef, c.DW_TAG_const_type, c.DW_TAG_volatile_type, c.DW_TAG_restrict_type];
        for (let index = 0; index < count; index++) target = add({ tag: tags[index % tags.length], typeRef: target });
        return target;
    };
    return { dies, childrenMap, variables, add, integer, member, struct, chain, variable, array, aliases };
}
function nodes(layout) {
    if (!layout) return 0;
    const entries = layout.kind === "array" ? [layout.elementType] : layout.members || [];
    return 1 + entries.reduce((count, entry) => count + 1 + nodes(entry?.compositeLayout), 0);
}
function limits(layout) {
    const entries = layout.kind === "array" ? [layout.elementType] : layout.members || [];
    return entries.flatMap((entry) => [
        ...(entry.unobservable ? [entry] : []),
        ...(entry.compositeLayout ? limits(entry.compositeLayout) : [])
    ]);
}
function symbol(layout, name = "root") {
    return { name, address: 0x20000000, size: layout.byteSize, isComposite: true, compositeLayout: layout };
}

// A limit belongs to one branch; scalar and composite siblings remain observable.
{
    const f = fixture();
    const shallow = f.struct("Shallow", [f.member("value", f.integer)], 4);
    const root = f.struct("Root", [f.member("deep", f.chain(50)), f.member("shallow", shallow, 4)], 12);
    f.variable("root", root);
    const layout = buildCompositeLayouts(f).get("root");
    assert.strictEqual(layout.truncated, true);
    assert.deepStrictEqual(
        limits(layout).map((entry) => entry.unobservable),
        ["depth-limit"]
    );
    assert.strictEqual(layout.members[1].compositeLayout.members[0].watchType, "i32");
    assert.ok(nodes(layout) <= MAX_COMPOSITE_NODES);
    validateComposite(layout, 12);
    const leaves = elf.expandCompositeLeaves(symbol(layout), layout);
    assert.deepStrictEqual(
        leaves.map((leaf) => leaf.path),
        ["root.shallow.value"]
    );
    assert.deepStrictEqual(elf.expandCompositeLeaves(symbol(layout), layout, elf.parseMemberPath("root.deep")), []);
    assert.deepStrictEqual(normalizeWatchList([{ name: "root.deep", type: "u32" }], [symbol(layout)]), []);
    const decoded = elf.decodeComposite(Buffer.alloc(12), layout);
    assert.strictEqual(decoded.truncated, true);
    assert.strictEqual(decoded.members[1].members[0].value, 0);
}

// libstdc++ variant bases, recursive alternatives and cv/typedef wrappers inside Axis axes[1].
{
    const f = fixture();
    let union = f.struct("_Variadic_union<>", [], 4, c.DW_TAG_union_type);
    for (let alternative = 0; alternative < 12; alternative++) {
        const initialized = f.struct("_Uninitialized<T" + alternative + ">", [f.member("_M_storage", f.integer)], 4);
        union = f.struct(
            "_Variadic_union<T...>",
            [f.member("_M_first", f.aliases(initialized, 8)), f.member("_M_rest", f.aliases(union, 8))],
            4,
            c.DW_TAG_union_type
        );
    }
    let type = f.struct("_Variant_storage", [f.member("_M_u", union)], 4, c.DW_TAG_class_type);
    for (const name of [
        "_Copy_ctor_base",
        "_Move_ctor_base",
        "_Copy_assign_base",
        "_Move_assign_base",
        "_Variant_base",
        "variant"
    ]) {
        const base = f.add({ tag: c.DW_TAG_inheritance, typeRef: f.aliases(type, 8), memberOffset: 0 });
        type = f.struct(name, [base], 4, c.DW_TAG_class_type);
    }
    const axis = f.struct("Axis", [f.member("state", type), f.member("position", f.integer, 4)], 8);
    f.variable("axes", f.array(axis));
    const layout = buildCompositeLayouts(f).get("axes");
    assert.strictEqual(layout.truncated, undefined);
    assert.deepStrictEqual(limits(layout), []);
    validateComposite(layout, 8);
    const leaves = elf.expandCompositeLeaves(symbol(layout, "axes"), layout);
    assert.strictEqual(leaves.length, 13, "deep variant alternatives remain visible to consumers");
    assert.ok(leaves.some((leaf) => leaf.path.endsWith("._M_storage")));
}

// Original reproduction and a new limit-crossing reproduction, in either order and after eviction.
for (const count of [8, MAX_COMPOSITE_DEPTH + 1]) {
    const f = fixture();
    const refs = [f.integer];
    for (let index = count - 1; index >= 0; index--) refs.unshift(f.struct("S" + index, [f.member("next", refs[0])]));
    f.variable("warm", refs[0]);
    const target = refs[3];
    f.variable("inner", target);
    f.variable("deep", f.chain(5, target));
    for (let index = 0; index < 70; index++)
        f.variable("evict" + index, f.struct("Evict" + index, [f.member("value", f.integer)], 4));
    const cold = createCompositeLayoutResolver(f);
    const expected = JSON.stringify(cold("deep"));
    const fullInner = JSON.stringify(cold("inner"));
    assert.strictEqual(limits(cold("inner")).length, 0, "truncated entries are not cached as complete types");
    const warm = createCompositeLayoutResolver(f);
    warm("warm");
    assert.strictEqual(JSON.stringify(warm("deep")), expected);
    for (let index = 0; index < 70; index++) warm("evict" + index);
    assert.strictEqual(JSON.stringify(warm("deep")), expected, "LRU eviction cannot change expansion");
    assert.strictEqual(JSON.stringify(warm("inner")), fullInner);
}

// Fair shares make a fresh build stricter than "cached cost fits": a type completed
// as a root must not be reused complete inside a tighter sibling share.
{
    const f = fixture();
    const big = f.struct(
        "Big",
        Array.from({ length: 5000 }, (_, index) => f.member("a" + index, f.integer)),
        4
    );
    const pair = f.struct(
        "Pair",
        [f.member("big", big), f.member("small", f.struct("Small", [f.member("b", f.integer)], 4))],
        8
    );
    const outer = f.struct(
        "Outer",
        [f.member("pair", pair), f.member("other", f.struct("Other", [f.member("u", f.integer)], 4))],
        16
    );
    f.variable("pair", pair);
    f.variable("outer", outer);
    const expected = JSON.stringify(createCompositeLayoutResolver(f)("outer"));
    assert.ok(expected.includes('"expansion-budget"'), "the fixture must cross a fair-share boundary");
    const warm = createCompositeLayoutResolver(f);
    assert.strictEqual(limits(warm("pair")).length, 0);
    assert.strictEqual(JSON.stringify(warm("outer")), expected, "budget-limited expansion is order independent");
}

// Array metadata must stay deterministic even when a long outer chain warms inner types.
for (const count of [70, MAX_TYPE_INFO_DEPTH + 20]) {
    const f = fixture();
    const refs = [f.integer];
    for (let index = 0; index < count; index++) refs.push(f.array(refs.at(-1)));
    f.variable("warmArray", refs.at(-1));
    f.variable("innerArray", refs[20]);
    for (let index = 0; index < 70; index++)
        f.variable("evictArray" + index, f.array(f.struct("ArrayValue" + index, [f.member("v", f.integer)], 4)));
    const cold = createCompositeLayoutResolver(f);
    const expected = cold("innerArray");
    assert.strictEqual(expected.byteSize, 4);
    const warm = createCompositeLayoutResolver(f);
    warm("warmArray");
    assert.deepStrictEqual(warm("innerArray"), expected);
    for (let index = 0; index < 70; index++) warm("evictArray" + index);
    assert.deepStrictEqual(warm("innerArray"), expected);
    validateComposite(expected, 4);
}

// Wrappers have their own generous iterative bound and never consume composite depth.
{
    const f = fixture();
    f.variable("alias", f.aliases(f.chain(MAX_COMPOSITE_DEPTH), 200));
    const layout = buildCompositeLayouts(f).get("alias");
    assert.deepStrictEqual(limits(layout), []);
    assert.strictEqual(layout.isConst, true);
    assert.strictEqual(buildVariableTypes(f).get("alias").kind, "struct");
    f.variable("oversizedAlias", f.aliases(f.integer, MAX_TYPE_ALIASES + 4000));
    assert.strictEqual(buildVariableTypes(f).get("oversizedAlias").watchType, "");
}

// Malformed by-value recursion is distinct from a depth limit, including aliases and bases.
{
    const f = fixture();
    const cycle = f.struct("Cycle", [], 4);
    f.childrenMap.set(cycle, [
        f.add({ tag: c.DW_TAG_inheritance, typeRef: f.aliases(cycle, 3), memberOffset: 0 }),
        f.member("value", f.integer)
    ]);
    const root = f.struct("Root", [f.member("bad", cycle), f.member("good", f.integer, 4)]);
    f.variable("root", root);
    const layout = buildCompositeLayouts(f).get("root");
    assert.strictEqual(layout.truncated, true);
    const bad = layout.members[0].compositeLayout.members[0];
    assert.strictEqual(bad.unobservable, "type-cycle");
    assert.strictEqual(bad.compositeLayout, undefined);
    assert.deepStrictEqual(
        elf.expandCompositeLeaves(symbol(layout), layout).map((leaf) => leaf.path),
        ["root.bad.value", "root.good"]
    );
}

// A wide branch cannot exhaust sibling work; cache hits account for the same per-root cost.
{
    const f = fixture();
    const huge = f.struct(
        "Huge",
        Array.from({ length: 10000 }, (_, index) => f.member("m" + index, f.integer)),
        4
    );
    const shallow = f.struct("Shallow", [f.member("value", f.integer)], 4);
    const root = f.struct("Root", [f.member("huge", huge), f.member("small", shallow, 4)], 8);
    f.variable("root", root);
    f.variable("warm", huge);
    const cold = createCompositeLayoutResolver(f);
    const layout = cold("root");
    assert.strictEqual(layout.members[0].unobservable, "expansion-budget");
    assert.strictEqual(layout.members[0].compositeLayout, undefined);
    assert.strictEqual(layout.members[1].compositeLayout.members[0].watchType, "i32");
    assert.strictEqual(layout.truncated, true);
    assert.ok(nodes(layout) <= MAX_COMPOSITE_NODES);
    const warm = createCompositeLayoutResolver(f);
    assert.strictEqual(warm("warm").truncated, undefined);
    assert.deepStrictEqual(warm("root"), layout);
    assert.deepStrictEqual(
        elf.expandCompositeLeaves(symbol(layout), layout).map((leaf) => leaf.path),
        ["root.small.value"]
    );
}

// Metadata size is bounded before serialization, including when a warm cache cannot fit.
{
    const f = fixture();
    const big = f.struct(
        "Big",
        Array.from({ length: 60 }, (_, index) => f.member("x".repeat(20000) + index, f.integer)),
        4
    );
    const small = f.struct("Small", [f.member("value", f.integer)], 4);
    f.variable("root", f.struct("Root", [f.member("big", big), f.member("small", small, 4)], 8));
    f.variable("warm", big);
    const cold = createCompositeLayoutResolver(f)("root");
    assert.strictEqual(cold.members[0].unobservable, "expansion-budget");
    assert.strictEqual(cold.members[1].compositeLayout.members[0].watchType, "i32");
    const warm = createCompositeLayoutResolver(f);
    assert.strictEqual(warm("warm").truncated, undefined);
    assert.deepStrictEqual(warm("root"), cold);
}

// Every consumer ignores unobservable entries even if stale/hostile watchType/layout data is attached.
{
    const leaf = { kind: "scalar", typeName: "int", watchType: "i32", byteSize: 4 };
    const layout = {
        kind: "struct",
        byteSize: 8,
        truncated: true,
        members: [
            {
                ...leaf,
                name: "bad",
                offset: 0,
                unobservable: "depth-limit",
                compositeLayout: { kind: "struct", byteSize: 4, members: [{ ...leaf, name: "fake", offset: 0 }] }
            },
            { ...leaf, name: "good", offset: 4 }
        ]
    };
    const sym = symbol(layout);
    assert.deepStrictEqual(
        elf.expandCompositeLeaves(sym, layout).map((entry) => entry.path),
        ["root.good"]
    );
    assert.deepStrictEqual(elf.expandCompositeLeaves(sym, layout, elf.parseMemberPath("root.bad.fake")), []);
    assert.strictEqual(normalizeWatchList([{ name: "root.bad", type: "i32" }], [sym]).length, 0);
    const tree = elf.decodeComposite(Buffer.alloc(8), layout);
    assert.strictEqual(tree.members[0].unobservable, "depth-limit");
    assert.strictEqual(tree.members[0].value, undefined);
    assert.strictEqual(tree.members[0].offset, undefined, "unavailable decoded rows carry no writable address");
    const array = {
        kind: "array",
        byteSize: 4,
        dimensions: [1],
        totalElements: 1,
        elementType: { ...leaf, unobservable: "expansion-budget" }
    };
    assert.deepStrictEqual(elf.expandCompositeLeaves(symbol(array), array), []);
    assert.deepStrictEqual(elf.expandCompositeLeaves(symbol(array), array, elf.parseMemberPath("root[0]")), []);
    assert.deepStrictEqual(buildActiveReadPlan([[symbol(array)]], elf), []);
    assert.strictEqual(elf.decodeComposite(Buffer.alloc(4), array).elements.length, 0);
    for (const [file, fn, next] of [
        ["sidebar/renderer.js", "sbCollectLeaves", "sbApplyWriteDiff"],
        ["liveWatch/renderer.js", "collectLeaves", "onCompositeSamples"]
    ]) {
        const source = fs.readFileSync(path.join(__dirname, "../src/webview", file), "utf8");
        const start = source.indexOf("function " + fn + "(");
        const end = source.indexOf("\nfunction ", start + 1);
        assert.ok(end > start, next);
        const context = {
            EmberProbeRuntime: runtime,
            LEAF_W: { i32: 4 },
            MAX_ARR_SHOWN: 16,
            sbLayoutSymbol: () => null,
            layoutSymbol: () => null
        };
        vm.createContext(context);
        vm.runInContext(source.slice(start, end), context);
        assert.deepStrictEqual(
            JSON.parse(JSON.stringify(context[fn](layout, "root", 0x20000000))).map((entry) => entry.path),
            ["root.good"]
        );
        assert.strictEqual(context[fn](array, "root", 0x20000000).length, 0);
    }
    assert.strictEqual(runtime.MAX_COMPOSITE_DEPTH, MAX_COMPOSITE_DEPTH);
    assert.strictEqual(
        runtime.unobservableReason("type-cycle", (key) => key),
        "lw.layoutTypeCycle"
    );
}

// Both localized views expose unavailable rows without leaf controls, including imports.
{
    const { render } = require("./helpers/render-webview");
    const { getModernWebviewContent } = require("../src/modernView");
    const { getLiveWatchContent } = require("../src/liveWatchView");
    const layout = {
        kind: "struct",
        typeName: "struct Partial",
        byteSize: 8,
        truncated: true,
        members: [
            ...["depth-limit", "expansion-budget", "type-cycle"].map((code, index) => ({
                name: "limited" + index,
                offset: 0,
                byteSize: 4,
                kind: "struct",
                unobservable: code,
                watchType: "i32"
            })),
            { name: "good", offset: 4, byteSize: 4, watchType: "i32", typeName: "int" }
        ]
    };
    for (const lang of ["en", "zh"]) {
        const table = require("../src/i18n/" + lang);
        const sidebar = render(getModernWebviewContent({}, lang));
        const graph = render(getLiveWatchContent({ panelId: 1 }, lang));
        try {
            sidebar.send({ type: "availableVariables", symbols: [symbol(layout)] });
            sidebar.document.querySelector(".available-row.comp .av-arrow").click();
            assert.strictEqual(sidebar.document.querySelectorAll(".available-row.leaf").length, 1);
            sidebar.send({ type: "sidebarWatchList", items: [symbol(layout)] });
            assert.strictEqual(sidebar.document.querySelectorAll(".sb-mrow").length, 1);
            graph.document.getElementById("import").click();
            graph.send({ type: "variablesList", symbols: [symbol(layout)] });
            graph.document.querySelector(".imp-row .imp-arrow").click();
            assert.strictEqual(graph.document.querySelectorAll(".imp-row.leaf").length, 1);
            graph.send({ type: "watchList", items: [symbol(layout)] });
            assert.strictEqual(graph.document.querySelectorAll(".member-row").length, 1);
            for (const key of [
                "lw.layoutDepthLimit",
                "lw.layoutExpansionBudget",
                "lw.layoutTypeCycle",
                "lw.layoutPartial"
            ]) {
                assert.ok(sidebar.document.getElementById("availableVars").textContent.includes(table[key]));
                assert.ok(sidebar.document.getElementById("liveValues").textContent.includes(table[key]));
                assert.ok(graph.document.getElementById("impList").textContent.includes(table[key]));
                assert.ok(graph.document.querySelector(".comp-body").textContent.includes(table[key]));
            }
            sidebar.assertHealthy();
            graph.assertHealthy();
        } finally {
            sidebar.close();
            graph.close();
        }
    }
}

(async () => {
    const { createRuntimeLayoutResolver } = require("../src/dwarf/runtimeTypes");
    const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
    const readTree = (graph) =>
        new RuntimeObjectReader(
            {
                address: 0x20000000,
                size: 12,
                runtimeLayout: graph,
                runtimeStaticPointers: true,
                runtimeRanges: [{ start: 0x20000000, end: 0x2000000c }]
            },
            async (_address, size) => Buffer.alloc(size)
        );
    // Runtime metadata and sampled trees preserve shallow siblings across their distinct limits.
    for (const mode of ["depth", "nodes", "cycle"]) {
        const f = fixture();
        let deep;
        if (mode === "depth") deep = f.chain(160);
        else if (mode === "nodes") {
            deep = f.struct(
                "Huge",
                Array.from({ length: 4500 }, (_, index) =>
                    f.member("p" + index, f.add({ tag: c.DW_TAG_pointer_type, typeRef: f.integer }))
                ),
                4
            );
        } else {
            deep = f.struct("Cycle", [], 4);
            f.childrenMap.set(deep, [f.member("self", f.aliases(deep, 20))]);
        }
        const pointer = f.add({ tag: c.DW_TAG_pointer_type, typeRef: f.integer });
        const root = f.struct(
            "Root",
            [f.member("deep", deep), f.member("good", f.integer, 4), f.member("ptr", pointer, 8)],
            12
        );
        f.variable("root", f.aliases(root, 200));
        const diagnostics = [];
        const graph = createRuntimeLayoutResolver(f)("root", (_name, error) => diagnostics.push(error.code));
        assert.strictEqual(graph.truncated, true);
        assert.ok(graph.types.length <= 4096);
        assert.ok(Buffer.byteLength(JSON.stringify(graph)) < 2 * 1024 * 1024);
        const reader = readTree(graph);
        const good = reader.type(reader.type(graph.root).fields.find((field) => field.name === "good").type);
        assert.strictEqual(good.watchType, "i32");
        assert.ok(
            graph.types.some(
                (type) =>
                    type.unobservable ===
                    (mode === "depth" ? "depth-limit" : mode === "cycle" ? "type-cycle" : "expansion-budget")
            )
        );
        assert.ok(diagnostics.includes(mode === "cycle" ? "DWARF_TYPE_CYCLE" : "DWARF_BUDGET_EXCEEDED"));
        const tree = await reader.sample();
        assert.strictEqual(tree.truncated, true);
        assert.strictEqual(tree.members.find((member) => member.name === "good").value, 0);
        assert.ok(reader.nodes <= 256, "runtime sampling visits remain bounded");
        const unavailable = graph.types.findIndex((type) => type.unobservable);
        await assert.rejects(
            reader.member({ address: 0x20000000, type: graph.root }, { type: unavailable, name: "bad", offset: 0 }),
            { code: "LIVE_LAYOUT_UNSUPPORTED" }
        );
    }
    console.log("Deep C++ layout, cache order, runtime partial graphs and localized consumer safety tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
