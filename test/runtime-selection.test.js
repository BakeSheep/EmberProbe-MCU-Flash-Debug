"use strict";

const assert = require("assert");
const zlib = require("zlib");
const fixtures = require("./fixtures/runtime-layouts.json");
const dwarf = require("../src/dwarf");
const elf = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
const { normalizeWatchList } = require("../src/validation");
const runtime = require("../src/webview/runtime");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { loadProvider } = require("./helpers/load-provider");

function openVariables(view, sidebar, symbols, version = "selection") {
    const prefix = sidebar ? "availableVariables" : "variablesList";
    view.send({ type: `${prefix}Reset`, version });
    view.send({ type: `${prefix}Chunk`, version, symbols });
    view.send({ type: sidebar ? "availableTypesDone" : "variableTypesDone", version });
    if (!sidebar) view.document.getElementById("import").click();
    view.send({ type: `${prefix}Done`, version });
}

(async () => {
    for (const [version, compressed] of Object.entries(fixtures)) {
        const buffer = zlib.inflateSync(Buffer.from(compressed, "base64"));
        const parsed = dwarf.parseDwarf(buffer, { runtime: true });
        const result = elf.parseElfSymbols(buffer);
        new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
            result,
            parsed.types,
            parsed.layouts,
            parsed.displayNames
        );
        result.elf = { path: "not-needed-for-runtime-rejection" };
        const symbols = result.symbols.filter((symbol) => runtime.runtimeSelection(symbol));
        assert.strictEqual(symbols.length, 22, `DWARF ${version}: all STL fixture objects are audited`);
        const provider = Object.create(loadProvider().prototype);
        provider.readElfSymbols = () => result;
        provider._prepareRequestedLayouts = async () => {};
        for (const symbol of symbols) {
            assert.ok(normalizeWatchList([{ name: symbol.name }], result.symbols)[0].runtimeLayout);
            const selection = runtime.runtimeSelection(symbol);
            for (const entry of selection.entries) {
                assert.ok(!/\._M_|\.@base|_vptr/.test(entry.path));
                assert.ok(normalizeWatchList([entry], result.symbols)[0]?.runtimeLayout);
            }
            // Rejected internal implementation paths cannot become fixed-address watches.
            for (const leaf of elf.expandCompositeLeaves(symbol, symbol.compositeLayout, null)) {
                if (runtime.runtimeWatchEntry(leaf.path, symbol, elf.parseMemberPath(leaf.path).segments)) continue;
                assert.deepStrictEqual(normalizeWatchList([{ name: leaf.path }], result.symbols), []);
                assert.throws(() => provider._agentVariablePlan({ variables: [leaf.path] }), {
                    code: "INVALID_VARIABLE_PATH"
                });
                await assert.rejects(provider._addAgentWatch({ variables: [leaf.path] }), {
                    code: "INVALID_VARIABLE_PATH"
                });
                assert.throws(
                    () =>
                        provider._agentWritePlan([{ name: leaf.path, value: 1 }], {
                            refreshSymbols: false
                        }),
                    { code: "WRITE_NOT_ALLOWED" }
                );
            }
        }
        const unique = symbols.find((symbol) => symbol.displayName === "unique");
        const vector = symbols.find((symbol) => symbol.displayName === "values");
        assert.deepStrictEqual(
            runtime.runtimeSelection(unique).entries.map((entry) => entry.label),
            [".value"]
        );
        assert.deepStrictEqual(runtime.runtimeSelection(vector).entries, []);
        for (const sidebar of [true, false]) {
            const view = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
            try {
                openVariables(view, sidebar, symbols);
                const selector = sidebar ? "#availableVars .av-arrow" : "#impList .imp-arrow";
                [...view.document.querySelectorAll(selector)].forEach((arrow) => arrow.click());
                const labels = [...view.document.querySelectorAll(sidebar ? ".av-leaf-name" : ".imp-leaf-name")];
                assert.ok(labels.some((node) => node.textContent === ".value"));
                assert.ok(labels.every((node) => !/_M_|@base|_vptr/.test(node.textContent)));
                assert.ok(view.document.querySelector(sidebar ? ".av-children .sb-note" : ".imp-children .comp-note"));
                if (sidebar)
                    assert.ok(
                        [...view.document.querySelectorAll(".available-row.leaf .av-write")].every((b) => b.disabled)
                    );

                // Exercise lazy layout delivery without a top-level runtimeLayout field.
                const unloaded = { ...unique };
                delete unloaded.compositeLayout;
                delete unloaded.runtimeLayout;
                openVariables(view, sidebar, [unloaded], "lazy");
                if (!view.document.querySelector(selector).classList.contains("open"))
                    view.document.querySelector(selector).click();
                if (sidebar) view.document.querySelector("#availableVars .av-watch").click();
                view.send({
                    type: "compositeLayoutResult",
                    version: "lazy",
                    name: unique.name,
                    layout: unique.compositeLayout
                });
                assert.ok(
                    view.document.querySelector(sidebar ? ".av-leaf-name" : ".imp-leaf-name").textContent === ".value"
                );
                if (!sidebar) {
                    view.document.querySelector("#impList input[data-idx]").checked = true;
                    view.document.getElementById("impAdd").click();
                }
                const saved = view.messages.findLast((m) => m.type === (sidebar ? "saveSidebarWatch" : "saveWatch"));
                assert.ok(saved.items[0].runtimeLayout, "lazy whole-variable addition retains the runtime recipe");
                view.send({
                    type: "liveCompositeSample",
                    samples: [
                        {
                            name: unique.name,
                            tree: {
                                kind: "class",
                                members: [{ name: "value", kind: "scalar", type: "i32", value: 41 }]
                            }
                        }
                    ]
                });
                assert.strictEqual(
                    view.document.querySelector(sidebar ? ".sb-mval" : ".member-value").textContent,
                    "41"
                );

                // Dynamic container members appear from samples and keep semantic paths.
                openVariables(view, sidebar, [vector], "dynamic");
                if (!view.document.querySelector(selector).classList.contains("open"))
                    view.document.querySelector(selector).click();
                assert.match(
                    view.document.querySelector(sidebar ? ".av-children .sb-note" : ".imp-children .comp-note")
                        .textContent,
                    /Add this container and start sampling/
                );
                const sample = (count, value = 7) =>
                    view.send({
                        type: "liveCompositeSample",
                        samples: [
                            {
                                name: vector.name,
                                tree: {
                                    kind: "array",
                                    elements: Array.from({ length: count }, (_, index) => ({
                                        kind: "scalar",
                                        index,
                                        type: "i32",
                                        value,
                                        address: 0x20001000 + index * 4
                                    }))
                                }
                            }
                        ]
                    });
                sample(2);
                assert.match(
                    view.document.querySelector(sidebar ? ".av-children .sb-note" : ".imp-children .comp-note")
                        .textContent,
                    /individual members/
                );
                const leafSelector = sidebar ? ".available-row.leaf" : "#impList input[data-leaf-path]";
                const first = view.document.querySelector(leafSelector);
                assert.ok(first);
                if (!sidebar) first.checked = true;
                sample(2, 8);
                assert.strictEqual(
                    view.document.querySelector(leafSelector),
                    first,
                    "value-only refresh reuses picker rows"
                );
                sample(3);
                if (!sidebar)
                    assert.ok(view.document.querySelector(leafSelector).checked, "growing retains selected members");
                if (sidebar) view.document.querySelector(".available-row.leaf .av-watch").click();
                else view.document.getElementById("impAdd").click();
                const selected = view.messages.findLast((m) => m.type === (sidebar ? "saveSidebarWatch" : "saveWatch"));
                const member = selected.items.find((item) => item.name === vector.name + "[0]");
                assert.ok(member.runtimeLayout);
                assert.deepStrictEqual(member.runtimeSegments, [{ kind: "index", index: 0 }]);
                assert.strictEqual(member.address, vector.address, "persist the root identity, never a heap address");
                view.assertHealthy();
            } finally {
                view.close();
            }
        }
        // Normal structures remain available through the static path.
        const plain = {
            name: "plain",
            address: 0x20000000,
            size: 4,
            isComposite: true,
            compositeLayout: {
                kind: "struct",
                members: [{ name: "count", offset: 0, byteSize: 4, watchType: "u32" }]
            }
        };
        assert.strictEqual(normalizeWatchList([{ name: "plain.count" }], [plain])[0].type, "u32");
        const nestedOnly = { ...unique, runtimeLayout: undefined };
        provider.readElfSymbols = () => ({ ...result, symbols: [nestedOnly] });
        assert.throws(
            () =>
                provider._agentWritePlan([{ name: unique.name + ".value", value: 1 }], {
                    refreshSymbols: false
                }),
            { code: "WRITE_NOT_ALLOWED" }
        );
    }
    assert.strictEqual(runtime.runtimeSelection({}), null);
    console.log("Semantic STL selection, lazy recipes, dynamic imports and host boundary tests passed / DWARF 4 and 5");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
