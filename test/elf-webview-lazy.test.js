"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { loadProvider } = require("./helpers/load-provider");

const provider = Object.create(loadProvider().prototype);
provider._elfService = {
    cache: {
        elf: { sha256: "cached" },
        symbols: [{ name: "alias", size: 4, isComposite: true, typeName: "Alias" }],
        warnings: [],
        dwarfReady: true
    }
};
for (const listType of ["availableVariables", "variablesList"]) {
    const messages = [];
    provider._sendElfSnapshot((message) => messages.push(message), listType);
    assert.strictEqual(
        messages.at(-1).type,
        listType === "availableVariables" ? "availableTypesDone" : "variableTypesDone",
        "a reopened view must learn that cached DWARF types are ready"
    );
}

const sidebar = render(getModernWebviewContent({}, "en"));
try {
    const symbols = Array.from({ length: 600 }, (_, index) => ({
        name: `v${index}`,
        address: 0x20000000 + index * 16,
        size: 12,
        isComposite: true,
        typeName: "struct S"
    }));
    sidebar.send({ type: "availableVariablesReset", version: "first" });
    sidebar.send({ type: "availableVariablesChunk", version: "first", symbols });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.comp").length, 500);
    const search = sidebar.document.getElementById("varSearch");
    search.value = "v599";
    search.dispatchEvent(new sidebar.window.Event("input"));
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.comp").length, 1);
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.leaf").length, 0);
    sidebar.document.querySelector("#availableVars .av-arrow").click();
    assert.deepStrictEqual(sidebar.messages.at(-1), {
        type: "resolveCompositeLayout",
        name: "v599",
        version: "first"
    });
    const layout = {
        kind: "struct",
        typeName: "struct S",
        byteSize: 4800,
        members: Array.from({ length: 1200 }, (_, index) => ({
            name: `field${index}`,
            offset: index * 4,
            byteSize: 4,
            watchType: "u32",
            kind: "scalar"
        }))
    };
    sidebar.send({ type: "compositeLayoutResult", name: "v599", version: "stale", layout });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.leaf").length, 0);
    sidebar.send({ type: "compositeLayoutResult", name: "v599", version: "first", layout });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.leaf").length, 999);
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row").length, 1000);
    search.value = "";
    search.dispatchEvent(new sidebar.window.Event("input"));
    sidebar.document.querySelector("#availableVars .av-arrow").click();
    sidebar.send({ type: "compositeLayoutResult", name: "v0", version: "first", layout });
    sidebar.document.querySelectorAll("#availableVars .av-arrow")[1].click();
    sidebar.send({ type: "compositeLayoutResult", name: "v1", version: "first", layout });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row").length, 1000);
    assert.strictEqual(
        sidebar.document.querySelectorAll("#availableVars .av-children")[1].querySelectorAll(".leaf").length,
        0,
        "an exhausted member budget must not render extra members"
    );
    sidebar.send({ type: "availableVariablesReset", version: "typedef" });
    sidebar.send({
        type: "availableVariablesChunk",
        version: "typedef",
        symbols: [{ name: "alias", address: 0x20000000, size: 4 }]
    });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.comp").length, 0);
    assert.strictEqual(sidebar.document.querySelector("#availableVars .av-watch").disabled, true);
    sidebar.send({
        type: "availableVariableTypes",
        version: "typedef",
        symbols: [{ name: "alias", typeName: "Alias", isComposite: true, watchType: "" }]
    });
    sidebar.send({ type: "availableTypesDone", version: "typedef" });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.comp").length, 1);
    sidebar.document.querySelector("#availableVars .av-watch").click();
    assert.deepStrictEqual(sidebar.messages.at(-1), {
        type: "resolveCompositeLayout",
        name: "alias",
        version: "typedef"
    });
    sidebar.send({ type: "compositeLayoutResult", name: "alias", version: "typedef", layout });
    assert.ok(sidebar.messages.some((message) => message.type === "saveSidebarWatch"));
    sidebar.send({ type: "availableVariablesReset", version: "boolean" });
    sidebar.send({
        type: "availableVariablesChunk",
        version: "boolean",
        symbols: [{ name: "enabled", address: 0x20000000, size: 1 }]
    });
    sidebar.send({
        type: "availableVariableTypes",
        version: "boolean",
        symbols: [
            {
                name: "enabled",
                typeName: "_Bool",
                watchType: "u8",
                hasDwarfWriteType: true,
                isBoolean: true
            }
        ]
    });
    sidebar.send({ type: "availableTypesDone", version: "boolean" });
    sidebar.document.querySelector("#availableVars .av-write").click();
    assert.strictEqual(sidebar.document.querySelector(".write-slider").max, "1");
    assert.strictEqual(sidebar.document.querySelector(".write-row .value-type").textContent, "bool");
    sidebar.send({ type: "availableVariablesReset", version: "rust-name" });
    sidebar.send({
        type: "availableVariablesChunk",
        version: "rust-name",
        symbols: [{ name: "_RNvRust4GAIN", address: 0x20000010, size: 4 }]
    });
    sidebar.send({
        type: "availableVariableTypes",
        version: "rust-name",
        symbols: [{ name: "_RNvRust4GAIN", displayName: "rust::GAIN", typeName: "Atomic<u32>", watchType: "u32" }]
    });
    sidebar.send({ type: "availableTypesDone", version: "rust-name" });
    assert.match(sidebar.document.getElementById("availableVars").textContent, /rust::GAIN/);
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}
console.log("ELF progressive sidebar and lazy member rendering tests passed");

const graph = render(getLiveWatchContent({}, "en"));
try {
    const symbols = Array.from({ length: 600 }, (_, index) => ({
        name: `g${index}`,
        address: 0x20000000 + index * 16,
        size: 12,
        isComposite: true,
        typeName: "struct G"
    }));
    graph.send({ type: "variablesListReset", version: "graph-first" });
    graph.send({ type: "variablesListChunk", version: "graph-first", symbols });
    graph.document.getElementById("import").click();
    graph.send({ type: "variablesListDone", version: "graph-first" });
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row").length, 500);
    graph.document.querySelector("#impList .imp-arrow").click();
    assert.deepStrictEqual(graph.messages.at(-1), {
        type: "resolveCompositeLayout",
        name: "g0",
        version: "graph-first",
        panelId: 1
    });
    graph.send({ type: "compositeLayoutResult", name: "g0", version: "stale", layout: { members: [] } });
    graph.send({
        type: "compositeLayoutResult",
        name: "g0",
        version: "graph-first",
        layout: {
            kind: "struct",
            members: Array.from({ length: 1200 }, (_, index) => ({
                name: `field${index}`,
                offset: index * 4,
                byteSize: 4,
                watchType: "u32",
                kind: "scalar"
            }))
        }
    });
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row").length, 1000);
    const arrows = graph.document.querySelectorAll("#impList .imp-arrow");
    arrows[1].click();
    graph.send({
        type: "compositeLayoutResult",
        name: "g1",
        version: "graph-first",
        layout: {
            kind: "struct",
            members: [{ name: "value", offset: 0, byteSize: 4, watchType: "u32" }]
        }
    });
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row.leaf").length, 500);
    assert.strictEqual(
        graph.document.querySelectorAll("#impList .imp-children")[1].querySelectorAll(".leaf").length,
        0
    );
    graph.document.querySelector("#impList .imp-arrow").click();
    const secondArrow = graph.document.querySelectorAll("#impList .imp-arrow")[1];
    secondArrow.click();
    secondArrow.click();
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row.leaf").length, 1);
    graph.send({ type: "variablesListReset", version: "graph-typedef" });
    graph.send({
        type: "variablesListChunk",
        version: "graph-typedef",
        symbols: [{ name: "alias", address: 0x20000000, size: 4 }]
    });
    graph.document.getElementById("addName").value = "alias";
    graph.document.getElementById("addBtn").click();
    assert.deepStrictEqual(graph.messages.at(-1), {
        type: "resolveVariable",
        name: "alias",
        version: "graph-typedef",
        panelId: 1
    });
    graph.send({
        type: "variableTypes",
        version: "graph-typedef",
        symbols: [{ name: "alias", typeName: "Alias", isComposite: true, watchType: "" }]
    });
    graph.send({ type: "variableTypesDone", version: "graph-typedef" });
    graph.send({
        type: "addResolved",
        version: "graph-typedef",
        symbol: {
            name: "alias",
            address: 0x20000000,
            size: 4,
            isComposite: true,
            compositeLayout: {
                kind: "struct",
                byteSize: 4,
                members: [{ name: "field", offset: 0, byteSize: 4, watchType: "u32", kind: "scalar" }]
            }
        }
    });
    assert.ok(graph.messages.some((message) => message.type === "saveWatch"));
    graph.assertHealthy();
} finally {
    graph.close();
}
console.log("ELF progressive live-watch import and lazy member rendering tests passed");

(async () => {
    const layout = {
        kind: "struct",
        members: [
            {
                name: "settings",
                offset: 4,
                compositeLayout: {
                    kind: "struct",
                    members: [{ name: "gain", offset: 8, watchType: "f32" }]
                }
            },
            {
                name: "samples",
                offset: 16,
                compositeLayout: {
                    kind: "array",
                    totalElements: 3,
                    elementType: { byteSize: 4, watchType: "u32" }
                }
            }
        ]
    };
    const symbol = {
        name: "raw_device",
        displayName: "ns::device",
        address: 0x20000000,
        size: 28,
        isComposite: true,
        compositeLayout: layout
    };
    for (const language of ["zh", "en"]) {
        const page = render(getLiveWatchContent({}, language));
        try {
            const doc = page.document;
            const search = (value) => {
                doc.getElementById("impFilter").value = value;
                doc.getElementById("impFilter").dispatchEvent(new page.window.Event("input"));
            };
            doc.getElementById("import").click();
            page.send({ type: "variablesList", symbols: [symbol, { name: "other", watchType: "u32" }] });
            search(" GAIN ");
            assert.equal(doc.querySelectorAll(".imp-children.open").length, 1, "matching members open their parent");
            assert.equal(doc.querySelector(".imp-leaf-name").textContent, ".settings.gain");
            assert.equal(doc.querySelector(".imp-leaf-name").title, "ns::device.settings.gain");
            search("ns::device.samples[2]");
            assert.equal(doc.querySelector(".imp-leaf-name").textContent, ".samples[2]");
            search("missing");
            assert.equal(doc.querySelector(".imp-row"), null);
            doc.getElementById("impFilterClear").click();
            assert.equal(doc.querySelectorAll(".imp-children.open").length, 0, "search expansion is temporary");
            doc.querySelector(".imp-arrow").click();
            search("gain");
            doc.getElementById("impFilterClear").click();
            assert.equal(doc.querySelectorAll(".imp-children.open").length, 1, "manual expansion is retained");
            search("gain");
            doc.querySelector("input[data-leaf-path]").checked = true;
            doc.getElementById("impAdd").click();
            const imported = page.messages.findLast((m) => m.type === "saveWatch").items[0];
            assert.equal(
                imported.name,
                "raw_device.settings.gain",
                "keep the canonical identity when importing a match"
            );
            assert.equal(imported.address, 0x2000000c);
            assert.equal(imported.type, "f32");
            doc.getElementById("import").click();
            page.window.impExpanded[symbol.name] = false;
            page.send({
                type: "variablesList",
                symbols: [
                    {
                        ...symbol,
                        compositeLayout: null,
                        runtimeLayout: {
                            root: 2,
                            types: [
                                { kind: "scalar", watchType: "f32", byteSize: 4 },
                                { kind: "class", stl: "vector", args: [0], byteSize: 12 },
                                { kind: "class", fields: [{ name: "telemetry", type: 1, offset: 0 }] }
                            ]
                        }
                    }
                ]
            });
            search("telemetry[2]");
            assert.equal(doc.querySelector(".imp-leaf-name"), null);
            page.send({
                type: "liveCompositeSample",
                samples: [
                    {
                        name: symbol.name,
                        tree: {
                            kind: "class",
                            members: [
                                {
                                    name: "telemetry",
                                    kind: "array",
                                    elements: [{ index: 2, kind: "scalar", type: "f32", value: 7 }]
                                }
                            ]
                        }
                    }
                ]
            });
            assert.equal(doc.querySelector(".imp-leaf-name").textContent, ".telemetry[2]");
            assert.ok(doc.querySelector(".imp-children.open"), "runtime shape changes update an active member search");
            assert.equal(page.window.impExpanded[symbol.name], false, "runtime search does not persist auto-expansion");
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
    const lazy = render(getLiveWatchContent({}, "en"));
    try {
        const doc = lazy.document;
        const search = (value) => {
            doc.getElementById("impFilter").value = value;
            doc.getElementById("impFilter").dispatchEvent(new lazy.window.Event("input"));
        };
        const requests = () => lazy.messages.filter((m) => m.type === "resolveCompositeLayout");
        doc.getElementById("import").click();
        lazy.send({ type: "variablesListReset", version: "search-1" });
        lazy.send({
            type: "variablesListChunk",
            version: "search-1",
            symbols: Array.from({ length: 6 }, (_, i) => ({
                ...symbol,
                name: "device" + i,
                compositeLayout: null
            }))
        });
        lazy.send({ type: "variablesListDone", version: "search-1" });
        search("gain");
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(requests().length, 0, "wait for DWARF types before searching layouts");
        lazy.send({ type: "variableTypesDone", version: "search-1" });
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(requests().length, 4, "limit concurrent metadata requests");
        lazy.send({ type: "compositeLayoutResult", version: "stale", name: "device0", layout });
        assert.equal(doc.querySelector(".imp-leaf-name"), null, "ignore stale ELF layouts");
        lazy.send({ type: "compositeLayoutResult", version: "search-1", name: "device0", layout });
        assert.equal(doc.querySelector(".imp-leaf-name").textContent, ".settings.gain");
        doc.querySelector("input[data-leaf-path]").checked = true;
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(requests().length, 5, "continue searching when a slot becomes free");
        lazy.send({ type: "compositeLayoutResult", version: "search-1", name: "device1", error: "Unavailable type" });
        assert.equal(doc.querySelector("input[data-leaf-path]").checked, true, "layout replies retain checked matches");
        search("");
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(requests().length, 5, "clearing search cancels queued metadata work");
        search("gain");
        lazy.send({ type: "variablesListReset", version: "search-2" });
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(requests().length, 5, "ELF replacement cancels queued work");
        lazy.send({
            type: "variablesList",
            symbols: Array.from({ length: 6 }, (_, i) => ({
                ...symbol,
                name: "replacement" + i,
                compositeLayout: null
            }))
        });
        search("gain");
        doc.getElementById("impCancel").click();
        await new Promise((resolve) => setTimeout(resolve, 220));
        assert.equal(requests().length, 5, "closing import cancels queued work");
        const manyLeaves = {
            kind: "struct",
            members: Array.from({ length: 1200 }, (_, i) => ({ name: "field" + i, watchType: "u32" }))
        };
        assert.equal(lazy.window.collectLeaves(manyLeaves, "large", 0).length, 1000, "bound member-search traversal");
        const cyclic = { kind: "struct", members: [] };
        cyclic.members.push({ name: "self", compositeLayout: cyclic }, { name: "value", watchType: "u32" });
        assert.ok(lazy.window.collectLeaves(cyclic, "cycle", 0).length <= 13, "bound recursion in malformed layouts");
        lazy.assertHealthy();
    } finally {
        lazy.close();
    }
    console.log("Live-watch recursive member search and bounded lazy layout tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
