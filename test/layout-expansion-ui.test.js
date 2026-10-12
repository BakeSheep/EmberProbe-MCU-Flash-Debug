"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { fixture, runtimeGraph } = require("./helpers/layout-expansion-fixture");
const { decodeComposite } = require("../src/elfSymbols");
for (const language of ["en", "zh"]) {
    for (const sidebar of [true, false]) {
        for (const hasRuntime of [false, true]) {
            const f = fixture();
            if (hasRuntime) f.symbol.runtimeLayout = runtimeGraph();
            const page = render(sidebar ? getModernWebviewContent({}, language) : getLiveWatchContent({}, language));
            const { document: doc } = page;
            const prefix = sidebar ? "availableVariables" : "variablesList";
            const container = sidebar ? "#availableVars" : "#impList";
            const requests = () => page.messages.filter((message) => message.type === "expandLayout");
            try {
                page.send({ type: prefix + "Reset", version: "v1", generation: 7 });
                page.send({ type: prefix + "Chunk", version: "v1", symbols: [f.symbol] });
                if (!sidebar) doc.getElementById("import").click();
                page.send({ type: prefix + "Done", version: "v1" });
                page.send({ type: sidebar ? "availableTypesDone" : "variableTypesDone", version: "v1" });
                doc.querySelector(container + (sidebar ? " .av-arrow" : " .imp-arrow")).click();
                assert.strictEqual(doc.querySelectorAll(container + " .layout-expand").length, 2);
                const button = () => doc.querySelector(container + ' .layout-expand[data-path="axes[0].a.b"]');
                button().click();
                const request = requests()[0];
                assert.strictEqual(request.generation, 7);
                assert.strictEqual(request.name, "axes");
                assert.strictEqual(request.path, "axes[0].a.b");
                assert.strictEqual(request.handle, f.branch.expansionHandle);
                assert.strictEqual(button().disabled, true);
                assert.match(button().textContent, language === "en" ? /Loading/ : /正在加载/);
                button().click();
                assert.strictEqual(requests().length, 1, "de-duplicate in-flight clicks");
                page.send({ ...request, type: "layoutExpansionResult", code: "DWARF_BUDGET_EXCEEDED" });
                assert.strictEqual(button().disabled, false);
                assert.match(
                    doc.querySelector(container + " .layout-expansion-error").textContent,
                    language === "en" ? /limit reached/ : /上限/
                );
                button().click();
                page.send({ ...request, type: "layoutExpansionResult", code: "STALE_LAYOUT_HANDLE" });
                assert.match(
                    doc.querySelector(container + " .layout-expansion-error").textContent,
                    language === "en" ? /ELF changed/ : /ELF 已更新/
                );
                button().click();
                page.send({ ...request, type: "layoutExpansionResult", code: "INVALID_LAYOUT_HANDLE" });
                assert.match(
                    doc.querySelector(container + " .layout-expansion-error").textContent,
                    language === "en" ? /Try expanding/ : /重试/
                );
                button().click();
                page.send({ ...request, type: "layoutExpansionResult", version: "old", layout: f.sublayout });
                assert(
                    !Array.from(
                        doc.querySelectorAll(container + (sidebar ? " .available-row.leaf" : " .imp-row.leaf"))
                    ).some((row) => row.textContent.includes(".gain"))
                );
                page.send({ ...request, type: "layoutExpansionResult", layout: f.sublayout });
                assert.strictEqual(button(), null);
                assert.strictEqual(
                    doc.querySelectorAll(container + " .layout-expand").length,
                    2,
                    "nested branch and other array element remain expandable"
                );
                assert.strictEqual(
                    doc.querySelector(container + ' .layout-expand[data-path="axes[0].a.b.cycle"]'),
                    null
                );
                const gain = "axes[0].a.b.gain";
                if (sidebar) {
                    const row = Array.from(doc.querySelectorAll(container + " .available-row.leaf")).find((row) =>
                        row.textContent.includes(".gain")
                    );
                    if (hasRuntime) assert.strictEqual(row.querySelector(".av-write").disabled, true);
                    assert.match(row.textContent, /gain/);
                    row.querySelector(".av-watch").click();
                    assert.strictEqual(
                        page.messages.findLast((message) => message.type === "saveSidebarWatch").items[0].address,
                        f.symbol.address + 52
                    );
                } else {
                    const checkbox = doc.querySelector('input[data-leaf-path="' + gain + '"]');
                    assert.strictEqual(Number(checkbox.dataset.leafAddr), f.symbol.address + 52);
                    checkbox.checked = true;
                    doc.getElementById("impAdd").click();
                    assert.strictEqual(
                        page.messages.findLast((message) => message.type === "saveWatch").items[0].name,
                        gain
                    );
                    doc.getElementById("import").click();
                    page.send({ type: prefix + "Done", version: "v1" });
                }
                const nestedButton = doc.querySelector(container + ' .layout-expand[data-path="axes[0].a.b.c"]');
                nestedButton.click();
                const nestedRequest = requests().at(-1);
                page.send({ ...nestedRequest, type: "layoutExpansionResult", layout: f.nested });
                assert.match(doc.querySelector(container).textContent, /@base0.gain/);
                // Selected composite trees use the same map and concrete index controls.
                const expandedSymbol = {
                    ...f.symbol,
                    layoutExpansions: { [request.path]: f.sublayout, [nestedRequest.path]: f.nested },
                    layoutExpansionGeneration: 7
                };
                const selected = { ...expandedSymbol, type: "" };
                page.send({ type: sidebar ? "sidebarWatchList" : "watchList", items: [selected] });
                const treeContainer = sidebar ? "#liveValues" : "#vars";
                assert(doc.querySelector(treeContainer + ' .layout-expand[data-path="axes[1].a.b"]'));
                assert(!doc.querySelector(treeContainer + ' .layout-expand[data-path="axes[0].a.b"]'));
                // Same hash, new Worker generation: a late reply cannot restore old expansions.
                page.send({ type: prefix + "Reset", version: "v1", generation: 8 });
                const next = { ...f.symbol, compositeLayout: { ...f.layout, expansionGeneration: 8 } };
                page.send({ type: prefix + "Chunk", version: "v1", symbols: [next] });
                page.send({ ...request, type: "layoutExpansionResult", layout: f.sublayout });
                assert(doc.querySelector(container + ' .layout-expand[data-path="axes[0].a.b"]'));
                if (hasRuntime) {
                    page.send({
                        type: sidebar ? "sidebarWatchList" : "watchList",
                        items: [
                            selected,
                            {
                                name: gain,
                                address: f.symbol.address + 52,
                                size: 4,
                                type: "f32",
                                layoutExpanded: true,
                                staticRuntimeStorage: true
                            }
                        ]
                    });
                    assert(
                        doc.querySelector(treeContainer).textContent.includes("gain"),
                        "static expanded leaves remain visible alongside a runtime root"
                    );
                }
                page.assertHealthy();
            } finally {
                page.close();
            }
        }
    }
}
for (const sidebar of [true, false]) {
    const f = fixture();
    f.branch.name = "";
    f.symbol.layoutExpansions = { "axes[0].a.?": f.sublayout };
    f.symbol.layoutExpansionGeneration = 7;
    const page = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
    try {
        const prefix = sidebar ? "availableVariables" : "variablesList";
        page.send({ type: prefix + "Reset", version: "v1", generation: 7 });
        page.send({ type: prefix + "Chunk", version: "v1", symbols: [f.symbol] });
        page.send({ type: sidebar ? "sidebarWatchList" : "watchList", items: [f.symbol] });
        const bytes = Buffer.alloc(256);
        bytes.writeFloatLE(3.5, 52);
        const tree = decodeComposite(bytes, f.layout, f.symbol);
        page.send({ type: "liveCompositeSample", samples: [{ name: "axes", tree }] });
        const update = sidebar ? page.window.sbUpdateComposite : page.window.updateCompositeValues;
        update("axes");
        const leaf = [...page.document.querySelectorAll(sidebar ? ".sb-mrow" : ".member-row")].find((row) =>
            row.textContent.includes("gain")
        );
        assert.match(leaf.querySelector(sidebar ? ".sb-mval" : ".member-value").textContent, /3\.5/);
        page.assertHealthy();
    } finally {
        page.close();
    }
}
console.log("Sidebar/live-watch localized lazy expansion, loading/error/stale, nested and watch UI tests passed");
