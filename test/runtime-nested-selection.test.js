"use strict";

const assert = require("assert");
const zlib = require("zlib");
const fixtures = require("./fixtures/runtime-layouts.json");
const dwarf = require("../src/dwarf");
const elf = require("../src/elfSymbols");
const runtime = require("../src/webview/runtime");
const { normalizeWatchList } = require("../src/validation");
const { RuntimeObjectReader } = require("../src/services/runtimeObjectReader");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

function symbol(name, address, size, layout, graph) {
    return { name, address, size, isComposite: true, compositeLayout: layout, runtimeLayout: graph };
}
function scalarArray(count) {
    return { kind: "array", totalElements: count, elementType: { watchType: "i32", byteSize: 4 } };
}
function segments(name) {
    return elf.parseMemberPath(name).segments;
}

(async () => {
    for (const [version, compressed] of Object.entries(fixtures)) {
        const parsed = dwarf.parseDwarf(zlib.inflateSync(Buffer.from(compressed, "base64")), { runtime: true });
        const fixed = parsed.layouts.get("fixed");
        const fixedGraph = fixed.runtimeLayout;
        const int = fixedGraph.types[fixedGraph.root].args[0];
        const packetTypes = [...fixedGraph.types];
        const samplesType = packetTypes.push({ kind: "array", target: int, count: 4, byteSize: 16 }) - 1;
        const packetRoot =
            packetTypes.push({
                kind: "class",
                byteSize: 28,
                fields: [
                    { name: "samples", type: samplesType, offset: 0 },
                    { name: "marker", type: fixedGraph.root, offset: 16 }
                ]
            }) - 1;
        const packet = symbol(
            "packet",
            0x20000000,
            28,
            {
                kind: "struct",
                byteSize: 28,
                members: [
                    { name: "samples", offset: 0, byteSize: 16, compositeLayout: scalarArray(4) },
                    { name: "marker", offset: 16, byteSize: 12, compositeLayout: fixed }
                ]
            },
            { ...fixedGraph, root: packetRoot, types: packetTypes }
        );
        const provider = Object.create(loadProvider().prototype);
        provider.readElfSymbols = () => ({ symbols: [packet] });
        provider._prepareRequestedLayouts = async () => {};
        provider._scalarWatchList = () => [];
        provider._focusedLivePanel = () => null;
        let saved;
        provider._saveWatchList = async (_key, items) => {
            saved = items;
        };
        const bytes = Buffer.alloc(packet.size);
        [10, 20, 30, 40].forEach((value, index) => bytes.writeInt32LE(value, index * 4));
        [51, 52, 53].forEach((value, index) => bytes.writeInt32LE(value, 16 + index * 4));
        // Fixed STL array members can be watched before sampling their parent.
        for (const language of ["zh", "en"]) {
            for (const sidebar of [true, false]) {
                const view = render(
                    sidebar ? getModernWebviewContent({}, language) : getLiveWatchContent({}, language)
                );
                try {
                    if (sidebar) {
                        view.send({ type: "availableVariables", symbols: [packet] });
                        view.document.querySelector(".av-arrow").click();
                    } else {
                        view.send({ type: "variablesListReset", version });
                        view.send({ type: "variablesListChunk", version, symbols: [packet] });
                        view.send({ type: "variableTypesDone", version });
                        view.document.getElementById("import").click();
                        view.send({ type: "variablesListDone", version });
                        view.document.querySelector(".imp-arrow").click();
                    }
                    const hint = view.document.querySelector(sidebar ? ".sb-note" : ".comp-note").textContent;
                    assert.match(hint, language === "zh" ? /可单独添加/ : /individual members/);
                    assert.doesNotMatch(hint, language === "zh" ? /先添加|启动采样/ : /start sampling/);
                    const member = [...view.document.querySelectorAll(sidebar ? ".av-leaf-name" : ".imp-leaf-name")]
                        .find((node) => node.textContent === ".marker[1]")
                        .closest(sidebar ? ".available-row" : ".imp-row");
                    if (sidebar) member.querySelector(".av-watch").click();
                    else {
                        member.querySelector("input").checked = true;
                        view.document.getElementById("impAdd").click();
                    }
                    const saved = view.messages.findLast(
                        (m) => m.type === (sidebar ? "saveSidebarWatch" : "saveWatch")
                    );
                    assert.strictEqual(saved.items.length, 1, "adding an element never implicitly watches its parent");
                    const [item] = normalizeWatchList(saved.items, [packet]);
                    assert.strictEqual(item.name, "packet.marker[1]");
                    assert.strictEqual(item.isComposite, false);
                    const reads = [];
                    const tree = await new RuntimeObjectReader(
                        { ...item, runtimeRanges: [{ start: packet.address, end: packet.address + packet.size }] },
                        async (address, size) => {
                            reads.push({ address, size });
                            return bytes.subarray(address - packet.address, address - packet.address + size);
                        }
                    ).sample();
                    assert.strictEqual(tree.value, 52);
                    assert.deepStrictEqual(reads, [{ address: packet.address + 20, size: 4 }]);
                    view.assertHealthy();
                } finally {
                    view.close();
                }
            }
        }
        for (const [suffix, values] of [
            ["[1:3]", [20, 30]],
            ["[*]", [10, 20, 30, 40]]
        ]) {
            const name = "packet.samples" + suffix;
            assert.strictEqual(runtime.requiresRuntimePath(packet, segments(name)), false);
            const plan = provider._agentVariablePlan({ variables: [name] });
            assert.strictEqual(plan.compositePlan[0].runtimeLayout, undefined, "static slices keep their static plan");
            const decoded = provider._decodeAgentSample([], [{ name: packet.name, bytes }], plan.compositePlan);
            assert.deepStrictEqual(
                decoded.values[name].tree.elements.map((node) => node.value),
                values
            );
            const result = await provider._addAgentWatch({ variables: [name] });
            assert.strictEqual(result.sidebar.added.length, values.length);
            assert.strictEqual(normalizeWatchList(saved, [packet]).length, values.length);
        }
        assert.strictEqual(runtime.requiresRuntimePath(packet, segments("packet.marker[0:2]")), true);
        for (const name of ["packet.marker[0:2]", "packet.samples[0:9]", "packet.samples[9]"])
            assert.throws(() => provider._agentVariablePlan({ variables: [name] }), { code: "INVALID_VARIABLE_PATH" });

        // Wrap real ARM libstdc++ storage in normal classes, inheritance and C arrays.
        const vector = parsed.layouts.get("values");
        const graph = vector.runtimeLayout;
        const types = [...graph.types];
        const pointer = types.push({ kind: "pointer", target: graph.types[graph.root].args[0], byteSize: 4 }) - 1;
        const holderRoot =
            types.push({
                kind: "class",
                byteSize: 20,
                fields: [
                    { name: "counter", type: graph.types[graph.root].args[0], offset: 0 },
                    { name: "values", type: graph.root, offset: 4 },
                    { name: "raw", type: pointer, offset: 16 }
                ]
            }) - 1;
        const holderLayout = {
            kind: "struct",
            byteSize: 20,
            members: [
                { name: "counter", offset: 0, byteSize: 4, watchType: "i32" },
                { name: "values", offset: 4, byteSize: 12, compositeLayout: vector },
                { name: "raw", offset: 16, byteSize: 4, watchType: "u32" }
            ]
        };
        const derivedRoot =
            types.push({
                kind: "class",
                byteSize: 20,
                fields: [{ name: "@base0", type: holderRoot, offset: 0, isBase: true }]
            }) - 1;
        const arrayRoot = types.push({ kind: "array", target: holderRoot, count: 2, byteSize: 40 }) - 1;
        const base = 0x20000000;
        const holder = symbol("holder", base + 256, 20, holderLayout, { ...graph, root: holderRoot, types });
        const derived = symbol(
            "derived",
            base + 256,
            20,
            {
                kind: "class",
                byteSize: 20,
                members: [{ name: "@base0", offset: 0, byteSize: 20, compositeLayout: holderLayout }]
            },
            { ...graph, root: derivedRoot, types }
        );
        const array = symbol(
            "holders",
            base + 256,
            40,
            { kind: "array", totalElements: 2, elementType: { byteSize: 20, compositeLayout: holderLayout } },
            { ...graph, root: arrayRoot, types }
        );
        const memory = Buffer.alloc(8192);
        const word = (address, value) => memory.writeUInt32LE(value >>> 0, address - base);
        const read = async (address, size) => memory.subarray(address - base, address - base + size);
        const ranges = [{ start: base, end: base + memory.length }];
        const recipe = (item, name = item.name) => ({
            ...runtime.runtimeWatchEntry(name, item, segments(name)),
            runtimeRanges: ranges
        });
        const setup = async (address, heap) => {
            word(address, 17);
            word(address + 16, 0xdeadbeef);
            const reader = new RuntimeObjectReader(recipe(holder), read);
            const object = { address: address + 4, type: graph.root };
            for (const [path, value] of [
                ["_M_start", heap],
                ["_M_finish", heap + 12],
                ["_M_end_of_storage", heap + 16]
            ])
                word((await reader.path(object, path, true)).address, value);
            [31, 32, 33].forEach((value, index) => word(heap + index * 4, value));
        };
        await setup(holder.address, base + 4096);
        await setup(holder.address + 20, base + 4160);
        for (const [item, prefix] of [
            [holder, ".values"],
            [derived, ".values"],
            [array, "[0].values"]
        ]) {
            const entry = recipe(item);
            assert.strictEqual(entry.runtimeStaticPointers, true, "aggregate reads never chase unrelated pointers");
            const reads = [];
            const reader = new RuntimeObjectReader(entry, async (address, size) => {
                reads.push(address);
                return read(address, size);
            });
            const tree = await reader.sample();
            assert.ok(reads.every((address) => address >= base && address < base + memory.length));
            const selection = runtime.runtimeSelection(item, tree);
            assert.ok(
                selection.entries.some((child) => child.label === prefix),
                "nested container itself is selectable"
            );
            assert.ok(selection.entries.some((child) => child.label === prefix + "[1]"));
            assert.ok(selection.entries.every((child) => !/_M_|@base|_vptr/.test(child.label)));
            const selected = recipe(item, item.name + prefix + "[1]");
            assert.strictEqual((await new RuntimeObjectReader(selected, read).sample()).value, 32);
            // Validate real picker DOM, not just the shared helper's output.
            for (const sidebar of [true, false]) {
                const view = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
                try {
                    if (sidebar) {
                        view.send({ type: "availableVariables", symbols: [item] });
                        view.document.querySelector(".av-arrow").click();
                    } else {
                        view.send({ type: "variablesListReset", version });
                        view.send({ type: "variablesListChunk", version, symbols: [item] });
                        view.send({ type: "variableTypesDone", version });
                        view.document.getElementById("import").click();
                        view.send({ type: "variablesListDone", version });
                        view.document.querySelector(".imp-arrow").click();
                    }
                    const labels = () => [
                        ...view.document.querySelectorAll(sidebar ? ".av-leaf-name" : ".imp-leaf-name")
                    ];
                    assert.ok(labels().some((node) => node.textContent === prefix));
                    assert.ok(labels().every((node) => !/_M_|@base|_vptr/.test(node.textContent)));
                    view.send({ type: "liveCompositeSample", samples: [{ name: item.name, tree }] });
                    const member = labels().find((node) => node.textContent === prefix + "[1]");
                    assert.ok(member);
                    if (sidebar) {
                        assert.ok(
                            [...view.document.querySelectorAll(".available-row.leaf .av-write")].every(
                                (button) => button.disabled
                            )
                        );
                        member.closest(".available-row").querySelector(".av-watch").click();
                    } else {
                        member.closest(".imp-row").querySelector("input").checked = true;
                        view.document.getElementById("impAdd").click();
                    }
                    const saved = view.messages.findLast(
                        (m) => m.type === (sidebar ? "saveSidebarWatch" : "saveWatch")
                    );
                    assert.strictEqual(saved.items[0].name, item.name + prefix + "[1]");
                    assert.strictEqual(saved.items[0].address, item.address);
                    assert.ok(saved.items[0].runtimeLayout);
                    view.assertHealthy();
                } finally {
                    view.close();
                }
            }
            provider.readElfSymbols = () => ({ symbols: [item] });
            for (const leaf of elf
                .expandCompositeLeaves(item, item.compositeLayout, null)
                .filter((leaf) => /_M_/.test(leaf.path))) {
                assert.strictEqual(runtime.requiresRuntimePath(item, segments(leaf.path)), true);
                assert.deepStrictEqual(normalizeWatchList([{ name: leaf.path }], [item]), []);
                assert.throws(() => provider._agentVariablePlan({ variables: [leaf.path] }), {
                    code: "INVALID_VARIABLE_PATH"
                });
            }
        }
        const raw = recipe(holder, "holder.raw");
        assert.strictEqual((await new RuntimeObjectReader(raw, read).sample()).value, 0xdeadbeef);
        assert.strictEqual(runtime.runtimeWatchEntry("holder.raw.value", holder, segments("holder.raw.value")), null);
        // Relocation refreshes semantic elements without persisting their heap addresses.
        await setup(holder.address, base + 4288);
        word(base + 4292, 99);
        assert.strictEqual(
            (await new RuntimeObjectReader(recipe(holder, "holder.values[1]"), read).sample()).value,
            99
        );
    }
    console.log(
        "Ordinary array slices, nested STL wrappers/inheritance/arrays, pointer isolation and relocation passed"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
