"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { MAX_COMPOSITE_DEPTH } = require("../src/dwarf/layoutLimits");
const { render } = require("./helpers/render-webview");
const { FakeClock } = require("./helpers/fake-clock");
const { chartHistoryHost } = require("./helpers/chart-history-host");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const { normalizeWatchList } = require("../src/validation");
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
    provider._elfView.sendSnapshot((message) => messages.push(message), listType);
    assert.strictEqual(
        messages.at(-1).type,
        listType === "availableVariables" ? "availableTypesDone" : "variableTypesDone",
        "a reopened view must learn that cached DWARF types are ready"
    );
}

scenario("Keep a disclosure focused through unrelated replies and expand with one activation", () => {
    for (const sidebar of [true, false]) {
        const page = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
        const { document: doc, window } = page;
        const prefix = sidebar ? "availableVariables" : "variablesList";
        const list = doc.getElementById(sidebar ? "availableVars" : "impList");
        const layout = { kind: "struct", byteSize: 4, members: [{ name: "ready", byteSize: 4, watchType: "u32" }] };
        const metadata = (name) => ({ name, isComposite: true, address: 0x20000000, size: 4 });
        const load = (generation) => {
            page.send({ type: prefix + "Reset", version: "same-elf", generation });
            page.send({
                type: prefix + "Chunk",
                version: "same-elf",
                symbols: [metadata("target"), metadata("other")]
            });
            if (!sidebar && doc.getElementById("overlay").classList.contains("hidden"))
                doc.getElementById("import").click();
            page.send({ type: prefix + "Done", version: "same-elf" });
        };
        const reply = (name, generation) =>
            page.send({ type: "compositeLayoutResult", version: "same-elf", generation, name, layout });
        const arrow = () => list.querySelector('[data-picker-path="target"] button[aria-expanded]');
        try {
            load(2);
            const toggle = arrow();
            toggle.focus();
            toggle.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
            reply("other", 2);
            assert.strictEqual(arrow(), toggle);
            assert.strictEqual(doc.activeElement, toggle);
            toggle.click();
            assert.strictEqual(toggle.getAttribute("aria-expanded"), "true");
            assert.match(list.textContent, /Loading members/);
            assert.strictEqual(page.messages.filter((message) => message.type === "resolveCompositeLayout").length, 1);
            reply("target", 1);
            assert.strictEqual(list.querySelector('[data-picker-path="target.ready"]'), null);
            reply("target", 2);
            assert.ok(list.querySelector('[data-picker-path="target.ready"]'));
            assert.strictEqual(arrow(), toggle);
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
});

scenario("Find qualified static array paths outside the first page", () => {
    const array = {
        name: "_ZN3lab4gridE",
        displayName: "lab::grid",
        isComposite: true,
        address: 0x20000000,
        size: 256,
        compositeLayout: {
            kind: "array",
            totalElements: 64,
            byteSize: 256,
            elementType: { byteSize: 4, watchType: "u32" }
        }
    };
    for (const sidebar of [true, false]) {
        const page = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
        try {
            page.send({ type: sidebar ? "availableVariables" : "variablesList", symbols: [structuredClone(array)] });
            if (!sidebar) page.window.openImport();
            const filter = page.document.getElementById(sidebar ? "varSearch" : "impFilter");
            const search = (query) => {
                filter.value = query;
                filter.dispatchEvent(new page.window.Event("input"));
            };
            search("LAB::GRID[63]");
            assert.ok(page.document.querySelector('[data-picker-path="_ZN3lab4gridE[63]"]'));
            search("lab::grid[64]");
            assert.strictEqual(page.document.querySelector("[data-picker-member]"), null);
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
});

scenario("Resolve a reference before adding it in either picker", () => {
    const symbol = { name: "reference", address: 0x08010000, size: 4, typeName: "int &", isReference: true };
    const runtimeLayout = {
        root: 1,
        types: [
            { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" },
            { kind: "reference", typeName: "int &", byteSize: 4, target: 0 }
        ]
    };
    const layout = { kind: "class", members: [], runtimeLayout };
    const version = "reference";
    for (const side of [true, false]) {
        const view = render(side ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
        try {
            const listType = side ? "availableVariables" : "variablesList";
            view.send({ type: listType + "Reset", version });
            view.send({ type: listType + "Chunk", version, symbols: [{ ...symbol }] });
            view.send({ type: side ? "availableTypesDone" : "variableTypesDone", version });
            if (side) {
                view.document.querySelector("#availableVars .av-watch").click();
                assert.strictEqual(view.messages.at(-1).type, "resolveCompositeLayout");
                view.send({ type: "compositeLayoutResult", version, name: symbol.name, layout });
            } else {
                const input = view.document.getElementById("addName");
                input.value = symbol.name;
                input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
                assert.strictEqual(view.messages.at(-1).type, "resolveVariable");
                view.send({ type: "addResolved", version, symbol: { ...symbol, compositeLayout: layout } });
            }
            const saved = view.messages.findLast(
                (message) => message.type === (side ? "saveSidebarWatch" : "saveWatch")
            );
            assert.strictEqual(saved.items[0].name, symbol.name);
            assert.strictEqual(saved.items[0].type, "i32");
            assert.strictEqual(saved.items[0].isPointer, undefined);
            view.assertHealthy();
        } finally {
            view.close();
        }
    }
});

scenario("Restore an expanded nested reference before the first waveform sample", () => {
    const { normalizeWatchList } = require("../src/validation");
    const name = "holder";
    const referencePath = "holder.motor.axis";
    const symbol = {
        name,
        address: 0x20000100,
        size: 4,
        isComposite: true,
        runtimeLayout: {
            root: 4,
            types: [
                { kind: "scalar", typeName: "int", watchType: "i32", byteSize: 4 },
                { kind: "class", typeName: "Axis", byteSize: 4, fields: [{ name: "speed", type: 0, offset: 0 }] },
                { kind: "reference", typeName: "Axis &", byteSize: 4, target: 1 },
                { kind: "class", typeName: "Motors", byteSize: 4, fields: [{ name: "axis", type: 2, offset: 0 }] },
                { kind: "class", typeName: "Holder", byteSize: 4, fields: [{ name: "motor", type: 3, offset: 0 }] }
            ]
        }
    };
    const items = normalizeWatchList([{ name }], [symbol], { migrateLegacyRuntimePaths: true });
    assert.ok(items[0].runtimeLayout);
    const heading = (view) =>
        [...view.document.querySelectorAll(".comp-nest > .comp-head")].find(
            (head) => head.querySelector(".comp-name")?.title === referencePath
        );
    const initial = render(getLiveWatchContent({}, "en"), { expanded: { holder: true, "holder.motor": true } });
    let persisted;
    try {
        initial.send({ type: "watchList", items });
        assert.ok(heading(initial), "a reference with a known target type can be expanded before sampling");
        heading(initial).click();
        persisted = initial.getState();
    } finally {
        initial.close();
    }
    const restored = render(getLiveWatchContent({}, "en"), persisted);
    try {
        restored.send({ type: "watchList", items });
        assert.ok(heading(restored).querySelector(".comp-arrow").classList.contains("open"));
        const { expansions } = restored.messages.findLast((message) => message.type === "saveRuntimeExpansions");
        assert.ok(expansions.holder.includes(".motor.axis"));
        restored.send({
            type: "liveCompositeSample",
            samples: [
                {
                    name,
                    tree: {
                        kind: "class",
                        members: [
                            {
                                name: "motor",
                                kind: "class",
                                members: [
                                    {
                                        name: "axis",
                                        kind: "class",
                                        typeName: "Axis &",
                                        members: [{ name: "speed", kind: "scalar", type: "i32", value: 42 }]
                                    }
                                ]
                            }
                        ]
                    }
                }
            ]
        });
        assert.match(restored.document.querySelector('[data-path="holder.motor.axis.speed"]').textContent, /42/);
    } finally {
        restored.close();
    }
});

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
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.leaf").length, 64);
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row").length, 65);
    search.value = "";
    search.dispatchEvent(new sidebar.window.Event("input"));
    sidebar.document.querySelector("#availableVars .av-arrow").click();
    sidebar.send({ type: "compositeLayoutResult", name: "v0", version: "first", layout });
    sidebar.document.querySelectorAll("#availableVars .av-arrow")[1].click();
    sidebar.send({ type: "compositeLayoutResult", name: "v1", version: "first", layout });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row").length, 628);
    assert.strictEqual(
        sidebar.document.querySelectorAll("#availableVars .av-children")[1].querySelectorAll(".leaf").length,
        64,
        "both expanded structures get a page of members"
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
    // Adding a composite whose expanded row already asked for its layout waits for that same reply.
    sidebar.send({ type: "availableVariablesReset", version: "pending" });
    sidebar.send({
        type: "availableVariablesChunk",
        version: "pending",
        symbols: [{ name: "late", address: 0x20000100, size: 12, isComposite: true, typeName: "struct S" }]
    });
    sidebar.send({ type: "availableTypesDone", version: "pending" });
    const lateRequests = () =>
        sidebar.messages.filter((message) => message.type === "resolveCompositeLayout" && message.name === "late");
    sidebar.document.querySelector("#availableVars .av-arrow").click();
    assert.strictEqual(lateRequests().length, 1);
    sidebar.document.querySelector("#availableVars .av-watch").click();
    assert.strictEqual(lateRequests().length, 1, "the add reuses the pending layout request");
    sidebar.send({ type: "compositeLayoutResult", name: "late", version: "pending", layout });
    assert.ok(
        sidebar.messages
            .findLast((message) => message.type === "saveSidebarWatch")
            .items.some((item) => item.name === "late"),
        "the layout reply completes the add"
    );
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
    assert.match(graph.document.querySelector("#impList .imp-children.open").textContent, /Loading members/);
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
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row").length, 564);
    const firstBody = graph.document.querySelector("#impList .imp-children");
    firstBody.querySelector(".array-more .notice-action").click();
    assert.strictEqual(firstBody.querySelectorAll(".leaf").length, 128);
    const arrows = graph.document.querySelectorAll("#impList .imp-arrow");
    arrows[1].focus();
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
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row.leaf").length, 129);
    assert.strictEqual(graph.document.activeElement, arrows[1], "reply keeps the disclosure focused");
    assert.strictEqual(
        graph.document.querySelectorAll("#impList .imp-children")[1].querySelectorAll(".leaf").length,
        1
    );
    graph.document.querySelector("#impList .imp-arrow").click();
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row.leaf").length, 1);
    graph.send({ type: "variablesListReset", version: "graph-typedef" });
    graph.send({
        type: "variablesListChunk",
        version: "graph-typedef",
        symbols: [{ name: "alias", address: 0x20000000, size: 4 }]
    });
    graph.document.getElementById("addName").value = "alias";
    graph.document.getElementById("addName").dispatchEvent(new graph.window.KeyboardEvent("keydown", { key: "Enter" }));
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

scenario("Add a nested branch or one member without adding its parent in either picker", () => {
    const field = (name, offset) => ({ name, offset, kind: "scalar", byteSize: 4, watchType: "u32" });
    const element = { kind: "struct", typeName: "Axis", byteSize: 8, members: [field("low", 0), field("high", 4)] };
    const symbol = {
        name: "drive",
        displayName: "lab::drive",
        typeName: "Drive",
        address: 0x20000000,
        size: 20,
        isComposite: true,
        compositeLayout: {
            kind: "struct",
            byteSize: 20,
            members: [
                {
                    name: "axes",
                    offset: 4,
                    byteSize: 16,
                    compositeLayout: {
                        kind: "array",
                        typeName: "Axis[2]",
                        byteSize: 16,
                        totalElements: 2,
                        dimensions: [2],
                        elementType: { byteSize: 8, compositeLayout: element }
                    }
                },
                field("flags", 0)
            ]
        }
    };
    for (const sidebar of [true, false]) {
        const page = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
        try {
            const { document: doc } = page;
            const row = (path) => doc.querySelector(`[data-picker-path="${path}"]`);
            const arrow = (path) => row(path).querySelector("button[aria-expanded]");
            const control = (path) => row(path).querySelector(sidebar ? ".av-watch" : "input");
            const pickerType = sidebar ? ".available-type" : ".ty";
            const watchType = sidebar ? ".sb-comp-type" : ".comp-type";
            const group = (document, path) => document.querySelector(`[data-watch-group="${path}"]`);
            const head = (document, path) =>
                group(document, path).querySelector(sidebar ? ".sb-comp-head" : ".comp-head");
            const remove = sidebar ? ".watch-remove" : ".remove";
            const savedItems = () =>
                normalizeWatchList(
                    page.messages.findLast((m) => m.type === (sidebar ? "saveSidebarWatch" : "saveWatch")).items,
                    [symbol]
                );
            const saved = () => savedItems().map(({ name, address }) => [name, address]);
            const branch = "drive.axes[1]";
            if (!sidebar) doc.getElementById("import").click();
            const listType = sidebar ? "availableVariables" : "variablesList";
            page.send({ type: listType, symbols: [symbol] });
            arrow("drive").click();
            assert.strictEqual(row("drive.axes").querySelector(pickerType).textContent, "Axis[2]");
            assert.strictEqual(arrow("drive.axes").getAttribute("aria-expanded"), "false");
            assert.strictEqual(row(branch), null);
            arrow("drive.axes").click();
            assert.strictEqual(row(branch).querySelector(pickerType).textContent, "Axis");
            assert.strictEqual(row(branch + ".low"), null);
            arrow(branch).click();
            assert.strictEqual(row(branch + ".low").style.getPropertyValue("--picker-indent"), "36px");
            assert.strictEqual(row("drive.axes[0].low"), null);
            const leaf = row(branch + ".low");
            if (sidebar) {
                assert.deepStrictEqual(
                    Array.from(leaf.querySelector(".av-name-cell").children, (element) => element.className),
                    ["av-write", "av-watch", "av-leaf-name"]
                );
            } else {
                assert.strictEqual(arrow(branch).nextElementSibling, control(branch));
                assert(control(branch).nextElementSibling.classList.contains("imp-name"));
                assert(control(branch + ".low").nextElementSibling.classList.contains("imp-leaf-name"));
                assert.strictEqual(control(branch + ".low").parentElement, leaf.querySelector(".imp-name-wrap"));
            }
            control(branch + ".low").click();
            if (sidebar) {
                assert.deepStrictEqual(saved(), [[branch + ".low", symbol.address + 12]]);
                assert.strictEqual(control(branch).getAttribute("aria-pressed"), "mixed");
                arrow("drive.axes").click();
                arrow("drive.axes").click();
                assert.strictEqual(control(branch).getAttribute("aria-pressed"), "mixed");
            } else {
                assert.strictEqual(control(branch).indeterminate, true);
                arrow("drive.axes").click();
                assert.strictEqual(row(branch), null);
                const filter = doc.getElementById("impFilter");
                filter.value = "flags";
                filter.dispatchEvent(new page.window.Event("input"));
                doc.getElementById("impAdd").click();
                assert.deepStrictEqual(saved(), [[branch + ".low", symbol.address + 12]]);
                doc.getElementById("import").click();
                page.send({ type: listType, symbols: [symbol] });
                arrow("drive.axes").click();
            }
            control(branch).click();
            if (!sidebar) {
                assert.strictEqual(control("drive").checked, false);
                assert.strictEqual(control("drive.axes[0]").checked, false);
                arrow("drive").click();
                doc.getElementById("impAdd").click();
            }
            assert.deepStrictEqual(saved(), [
                [branch + ".low", symbol.address + 12],
                [branch + ".high", symbol.address + 16]
            ]);
            const heading = head(doc, branch);
            assert.strictEqual(group(doc, "drive"), null);
            assert.strictEqual(group(doc, "drive.axes"), null);
            assert.strictEqual(heading.querySelector(watchType).textContent, "Axis");
            assert.strictEqual(heading.querySelector(".variable-name-prefix").textContent, "lab::");
            assert.strictEqual(heading.querySelector(".variable-name-leaf").textContent, "[1]");
            assert.strictEqual(group(doc, "drive.axes[0]"), null);
            const memberRow = sidebar ? ".sb-mrow" : ".member-row";
            const memberValue = sidebar ? ".sb-mval" : ".member-value";
            const watched = group(doc, branch);
            assert(watched.matches(sidebar ? ".value-row.composite" : ".var-card.composite"));
            assert.strictEqual(watched.querySelectorAll(remove).length, 1);
            assert.strictEqual(watched.querySelectorAll(".value-row, .var-card").length, 0);
            assert.strictEqual(watched.querySelectorAll(memberRow).length, 2);
            for (const member of watched.querySelectorAll(memberRow)) {
                const classes = Array.from(member.children, (child) => child.className);
                assert.deepStrictEqual(
                    classes,
                    sidebar ? ["sb-mname", "sb-mtype", "sb-mval"] : ["curve-toggle", "member-type", "member-value"]
                );
            }
            page.send({
                type: sidebar ? "liveSample" : "chartValues",
                samples: [{ name: branch + ".low", value: 23 }]
            });
            if (sidebar) page.window.refreshDisplayedValues();
            else page.window.updateValues();
            assert.strictEqual(watched.querySelector(`[data-path="${branch}.low"] ${memberValue}`).textContent, "23");
            head(doc, branch).click();
            assert.strictEqual(watched.classList.contains("open"), false);
            const restored = render(
                sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"),
                page.getState()
            );
            try {
                const { compositeLayout, ...metadata } = symbol;
                restored.send({ type: listType + "Reset", version: "restored" });
                restored.send({ type: listType + "Chunk", version: "restored", symbols: [metadata] });
                restored.send({
                    type: "compositeLayoutResult",
                    name: symbol.name,
                    version: "restored",
                    layout: compositeLayout
                });
                restored.send({ type: sidebar ? "sidebarWatchList" : "watchList", items: savedItems() });
                const restoredHead = head(restored.document, branch);
                assert.strictEqual(group(restored.document, branch).classList.contains("open"), false);
                assert.strictEqual(restoredHead.querySelector(watchType).textContent, "Axis");
                restoredHead.click();
                assert.strictEqual(group(restored.document, branch).classList.contains("open"), true);
                const restoredDoc = restored.document;
                if (sidebar) {
                    for (const path of ["drive", "drive.axes", branch])
                        restoredDoc.querySelector(`[data-picker-path="${path}"] .av-arrow`).click();
                    restoredDoc.querySelector(`[data-picker-path="${branch}.low"] .av-watch`).click();
                } else {
                    restoredDoc
                        .querySelector(`[data-series-name="${branch}.low"]`)
                        .dispatchEvent(new restored.window.MouseEvent("contextmenu", { bubbles: true }));
                    restoredDoc.getElementById("seriesRemove").click();
                }
                const { items } = restored.messages.findLast(
                    (message) => message.type === (sidebar ? "saveSidebarWatch" : "saveWatch")
                );
                assert.deepStrictEqual(
                    items.map((item) => item.name),
                    [branch + ".high"]
                );
                restored.send({
                    type: sidebar ? "sidebarWatchList" : "watchList",
                    items: normalizeWatchList([...items, { name: "drive.flags" }], [symbol])
                });
                group(restoredDoc, branch).querySelector(remove).click();
                const savedAfterClose = restored.messages.findLast(
                    (message) => message.type === (sidebar ? "saveSidebarWatch" : "saveWatch")
                );
                assert.deepStrictEqual(
                    savedAfterClose.items.map((item) => item.name),
                    ["drive.flags"]
                );
                assert.strictEqual(group(restoredDoc, branch), null);
                restored.assertHealthy();
            } finally {
                restored.close();
            }
            if (!sidebar) {
                doc.getElementById("import").click();
                page.send({ type: listType, symbols: [symbol] });
                arrow("drive").click();
                control("drive.flags").click();
                arrow("drive").click();
                const saveCount = page.messages.filter((message) => message.type === "saveWatch").length;
                page.send({ type: "variablesListReset", version: "replacement", generation: 2 });
                doc.getElementById("impAdd").click();
                assert.strictEqual(page.messages.filter((message) => message.type === "saveWatch").length, saveCount);
            }
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
});

scenario("A summarized ELF root keeps its display name and canonical member path", () => {
    const symbol = {
        name: "counter",
        address: 0x20000000,
        size: 4,
        isComposite: true,
        compositeLayout: {
            kind: "class",
            byteSize: 4,
            stdSummary: { kind: "atomic", targets: ["_M_i"] },
            members: [{ name: "_M_i", offset: 0, byteSize: 4, watchType: "i32", memberRole: "internal" }]
        }
    };
    const page = render(getLiveWatchContent({}, "en"));
    try {
        const { document: doc } = page;
        doc.getElementById("import").click();
        page.send({ type: "variablesList", symbols: [symbol] });
        doc.querySelector(".imp-arrow").click();
        assert.strictEqual(doc.querySelector(".imp-leaf-name").textContent, symbol.name);
        doc.querySelector('input[data-leaf-path="counter._M_i"]').click();
        doc.getElementById("impAdd").click();
        assert.strictEqual(
            page.messages.findLast((message) => message.type === "saveWatch").items[0].name,
            "counter._M_i"
        );
        page.assertHealthy();
    } finally {
        page.close();
    }
});

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
            assert.equal(doc.querySelectorAll(".imp-children.open").length, 2, "matching members open their ancestors");
            assert.equal(doc.querySelector(".imp-leaf-name").textContent, "gain");
            assert.equal(doc.querySelector(".imp-leaf-name").title, "ns::device.settings.gain");
            search("ns::device.samples[2]");
            assert.equal(doc.querySelector(".imp-leaf-name").textContent, "[2]");
            search("missing");
            assert.equal(doc.querySelector(".imp-row"), null);
            doc.getElementById("impFilterClear").click();
            assert.equal(doc.querySelectorAll(".imp-children.open").length, 0, "search expansion is temporary");
            doc.querySelector(".imp-arrow").click();
            search("gain");
            doc.getElementById("impFilterClear").click();
            assert.equal(doc.querySelectorAll(".imp-children.open").length, 1, "manual expansion is retained");
            search("gain");
            doc.querySelector("input[data-leaf-path]").click();
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
            page.window.eval("state").importExpanded[symbol.name] = false;
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
            assert.equal(doc.querySelector(".imp-leaf-name").textContent, "[2]");
            assert.ok(doc.querySelector(".imp-children.open"), "runtime shape changes update an active member search");
            assert.equal(
                page.window.eval("state").importExpanded[symbol.name],
                false,
                "runtime search does not persist auto-expansion"
            );
            page.assertHealthy();
        } finally {
            page.close();
        }
    }
    const clock = new FakeClock();
    const lazy = render(getLiveWatchContent({}, "en"), {}, { clock });
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
            symbols: Array.from({ length: 8 }, (_, i) => ({
                ...symbol,
                name: "device" + i,
                compositeLayout: null,
                origin: i >= 6 ? "vendor" : "user"
            }))
        });
        lazy.send({ type: "variablesListDone", version: "search-1" });
        doc.getElementById("impUserOnly").click();
        search("gain");
        await clock.advance(220);
        assert.equal(requests().length, 0, "wait for DWARF types before searching layouts");
        lazy.send({ type: "variableTypesDone", version: "search-1" });
        await clock.advance(220);
        assert.equal(requests().length, 4, "limit concurrent metadata requests");
        assert.deepStrictEqual(
            requests().map((request) => request.name),
            ["device0", "device1", "device2", "device3"],
            "member search skips hidden generated variables"
        );
        lazy.send({ type: "compositeLayoutResult", version: "stale", name: "device0", layout });
        assert.equal(doc.querySelector(".imp-leaf-name"), null, "ignore stale ELF layouts");
        lazy.send({ type: "compositeLayoutResult", version: "search-1", name: "device0", layout });
        assert.equal(doc.querySelector(".imp-leaf-name").textContent, "gain");
        doc.querySelector("input[data-leaf-path]").click();
        await clock.advance(0);
        assert.equal(requests().length, 5, "continue searching when a slot becomes free");
        lazy.send({ type: "compositeLayoutResult", version: "search-1", name: "device1", error: "Unavailable type" });
        assert.equal(doc.querySelector("input[data-leaf-path]").checked, true, "layout replies retain checked matches");
        search("");
        await clock.advance(220);
        assert.equal(requests().length, 5, "clearing search cancels queued metadata work");
        search("gain");
        lazy.send({ type: "variablesListReset", version: "search-2" });
        await clock.advance(220);
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
        await clock.advance(220);
        assert.equal(requests().length, 5, "closing import cancels queued work");
        const manyLeaves = {
            kind: "struct",
            members: Array.from({ length: 1200 }, (_, i) => ({ name: "field" + i, watchType: "u32" }))
        };
        assert.equal(
            lazy.window.eval("valueTree").collectLeaves(manyLeaves, "large", 0).length,
            1000,
            "bound member-search traversal"
        );
        const cyclic = { kind: "struct", members: [] };
        cyclic.members.push({ name: "self", compositeLayout: cyclic }, { name: "value", watchType: "u32" });
        assert.ok(
            lazy.window.eval("valueTree").collectLeaves(cyclic, "cycle", 0).length <= MAX_COMPOSITE_DEPTH + 1,
            "bound recursion in malformed layouts"
        );
        lazy.assertHealthy();
    } finally {
        lazy.close();
    }

    await scenario("Refresh graph import choices and retain selections or show ELF failures", async () => {
        const graph = render(getLiveWatchContent({}, "en"));
        try {
            const P = loadProvider();
            const p = Object.create(P.prototype);
            const scalar = (name) => ({ name, address: 0x20000000, size: 4, type: "u32", watchType: "u32" });
            const entry = { ready: true, watchKey: "graph", latestSamples: new Map(), post: (m) => graph.send(m) };
            p._scalarWatchList = () => [];
            p._sampling.status = () => ({});
            p.readElfSymbols = () => ({ symbols: [scalar("old"), scalar("new")], warnings: [] });
            graph.document.getElementById("import").click();
            graph.send({ type: "variablesList", symbols: [scalar("old")] });
            graph.document.querySelector("#impList input").click();
            p._syncGraphTarget(entry);
            assert.deepStrictEqual(
                Array.from(graph.window.eval("state").allSymbols, (s) => s.name),
                ["old", "new"]
            );
            assert.ok(graph.document.getElementById("impList").textContent.includes("new"));
            assert.ok(graph.document.querySelector("#impList input").checked, "refresh retains selected names");
            p.readElfSymbols = () => {
                throw Error("ELF unavailable");
            };
            p._syncGraphTarget(entry);
            assert.equal(graph.document.querySelectorAll("#impList input").length, 0);
            assert.equal(graph.document.getElementById("importDiagnostics").hidden, false);
            assert.ok(graph.document.getElementById("importDiagnostics").textContent.includes("ELF unavailable"));
            assert.equal(graph.document.getElementById("elfDiagnostics"), null);
            graph.assertHealthy();
        } finally {
            graph.close();
        }
    });

    await scenario("Plot a composite bitfield through member selection and scalar decoding", async () => {
        const { LiveWatchService } = require("../src/services/liveWatchService");
        const { normalizeWatchList } = require("../src/validation");
        const elf = require("../src/elfSymbols");
        const graph = render(getLiveWatchContent({}, "en"));
        try {
            // Exercise the member button, host normalization and actual scalar decoding, including bitfields.
            const symbol = {
                name: "sensor",
                address: 0x20000000,
                size: 4,
                isComposite: true,
                compositeLayout: {
                    kind: "struct",
                    byteSize: 4,
                    members: [{ name: "x", offset: 0, watchType: "u32", byteSize: 4, bitSize: 3, bitOffset: 4 }]
                }
            };
            graph.window.addSymbol(symbol);
            graph.send({
                type: "liveCompositeSample",
                samples: [
                    {
                        name: "sensor",
                        tree: {
                            kind: "struct",
                            members: [{ name: "x", value: 5 }]
                        }
                    }
                ]
            });
            assert.equal(graph.window.chartData().length, 0);
            graph.document.querySelector(".member-swatch").click();
            const watch = normalizeWatchList(graph.messages.at(-1).items, [symbol]);
            const leaf = watch.find((item) => item.name === "sensor.x");
            assert.equal(leaf.bitSize, 3);
            graph.send({ type: "watchList", items: watch });
            const service = new LiveWatchService(elf);
            const decoded = service.decodeConsumerSamples(
                [{ name: leaf.name, bytes: [80, 0, 0, 0] }],
                1000,
                new Map([[leaf.name, leaf]]),
                null,
                new Map()
            );
            const host = chartHistoryHost(graph);
            host.samples(decoded.scalarSamples);
            host.draw(1000);
            assert.equal(graph.window.chartData()[0].arr[0].v, 5);
            graph.assertHealthy();
        } finally {
            graph.close();
        }
    });

    scenario("Removing a collapsed selected-member card clears its collapse and nested branch state", () => {
        const field = (name, offset) => ({ name, offset, kind: "scalar", byteSize: 4, watchType: "u32" });
        const element = { kind: "struct", typeName: "Axis", byteSize: 8, members: [field("low", 0), field("high", 4)] };
        const symbol = {
            name: "drive",
            displayName: "lab::drive",
            typeName: "Drive",
            address: 0x20000000,
            size: 20,
            isComposite: true,
            compositeLayout: {
                kind: "struct",
                byteSize: 20,
                members: [
                    {
                        name: "axes",
                        offset: 4,
                        byteSize: 16,
                        compositeLayout: {
                            kind: "array",
                            typeName: "Axis[2]",
                            byteSize: 16,
                            totalElements: 2,
                            dimensions: [2],
                            elementType: { byteSize: 8, compositeLayout: element }
                        }
                    },
                    field("flags", 0)
                ]
            }
        };
        for (const sidebar of [true, false]) {
            const page = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
            try {
                const { document: doc } = page;
                const listType = sidebar ? "availableVariables" : "variablesList";
                const watchType = sidebar ? "sidebarWatchList" : "watchList";
                const head = (path) =>
                    doc.querySelector(`[data-watch-group="${path}"] ${sidebar ? ".sb-comp-head" : ".comp-head"}`);
                const remove = (path) =>
                    doc.querySelector(`[data-watch-group="${path}"] ${sidebar ? ".watch-remove" : ".remove"}`);
                const expanded = () => page.window.eval("state").expanded;
                page.send({ type: listType, symbols: [symbol] });
                const branch = "drive.axes[1]";
                const branchItems = normalizeWatchList(
                    [{ name: branch + ".low" }, { name: branch + ".high" }],
                    [symbol]
                );
                page.send({ type: watchType, items: branchItems });
                assert.strictEqual(
                    doc.querySelector(`[data-watch-group="${branch}"]`).classList.contains("open"),
                    true
                );
                head(branch).click();
                assert.strictEqual(expanded()["\0" + branch], false);
                assert.strictEqual(
                    doc.querySelector(`[data-watch-group="${branch}"]`).classList.contains("open"),
                    false
                );
                remove(branch).click();
                assert.strictEqual(expanded()["\0" + branch], undefined, "closing card forgets collapsed group key");
                const savedExpanded = page.getState()[sidebar ? "sbExpanded" : "expanded"] || {};
                assert.strictEqual(savedExpanded["\0" + branch], undefined);
                page.send({ type: watchType, items: branchItems });
                assert.strictEqual(
                    doc.querySelector(`[data-watch-group="${branch}"]`).classList.contains("open"),
                    true,
                    "re-added branch card opens by default"
                );
                // Nested sub-branches inside a selected-member card clear when the card is closed.
                const twoAxes = normalizeWatchList(
                    [{ name: "drive.axes[0].low" }, { name: "drive.axes[1].low" }],
                    [symbol]
                );
                page.send({ type: watchType, items: twoAxes });
                const nestedHead = doc.querySelector(
                    `[data-watch-group="drive.axes"] ${sidebar ? ".sb-body .sb-comp-head" : ".comp-body .comp-head"}`
                );
                nestedHead.click();
                assert.strictEqual(expanded()["drive.axes[0]"], true);
                head("drive.axes").click();
                assert.strictEqual(expanded()["\0drive.axes"], false);
                remove("drive.axes").click();
                assert.strictEqual(expanded()["\0drive.axes"], undefined);
                assert.strictEqual(expanded()["drive.axes[0]"], undefined);
                // Removing a leaf watch does not clear branch expansion owned by a watched root composite.
                page.send({
                    type: watchType,
                    items: normalizeWatchList([{ name: "drive" }, { name: "drive.axes[1].low" }], [symbol])
                });
                expanded()["drive.axes[1]"] = true;
                if (sidebar) page.window.sbRemove("drive.axes[1].low", false);
                else page.window.removeVar("drive.axes[1].low");
                assert.strictEqual(expanded()["drive.axes[1]"], true);
                page.assertHealthy();
            } finally {
                page.close();
            }
        }
    });

    await scenario(
        "Late compositeLayoutResult and host layout preparation refresh watched nested members",
        async () => {
            const field = (name, offset) => ({ name, offset, kind: "scalar", byteSize: 4, watchType: "u32" });
            const layout = {
                kind: "struct",
                typeName: "Drive",
                byteSize: 20,
                members: [
                    {
                        name: "axes",
                        offset: 4,
                        byteSize: 16,
                        compositeLayout: {
                            kind: "array",
                            typeName: "Axis[2]",
                            byteSize: 16,
                            totalElements: 2,
                            dimensions: [2],
                            elementType: {
                                byteSize: 8,
                                compositeLayout: {
                                    kind: "struct",
                                    typeName: "Axis",
                                    byteSize: 8,
                                    members: [field("low", 0), field("high", 4)]
                                }
                            }
                        }
                    }
                ]
            };
            const metadata = { name: "drive", displayName: "drive", address: 0x20000000, size: 20, isComposite: true };
            const member = { name: "drive.axes[1].low", address: 0x2000000c, size: 4, type: "u32" };
            for (const sidebar of [true, false]) {
                const page = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
                try {
                    const { document: doc } = page;
                    const listType = sidebar ? "availableVariables" : "variablesList";
                    const watchType = sidebar ? "sidebarWatchList" : "watchList";
                    const watchTypeEl = () =>
                        doc.querySelector(
                            `[data-watch-group="drive.axes[1]"] ${sidebar ? ".sb-comp-type" : ".comp-type"}`
                        );
                    page.send({ type: listType + "Reset", version: "late-1" });
                    page.send({ type: listType + "Chunk", version: "late-1", symbols: [{ ...metadata }] });
                    page.send({ type: watchType, items: [member] });
                    assert.strictEqual(watchTypeEl().textContent, "object", "fallback type before layout arrives");
                    page.send({ type: "compositeLayoutResult", version: "late-1", name: "drive", layout });
                    assert.strictEqual(watchTypeEl().textContent, "Axis", "late layout redraws watched nested members");
                    page.assertHealthy();
                } finally {
                    page.close();
                }
            }
            // Host refreshBindings and broadcast prepareLayouts both forward compositeLayoutResult to ready views.
            const { CACHE_KEYS } = require("../src/cacheKeys");
            const P = loadProvider();
            const p = Object.create(P.prototype);
            const sidebarMessages = [];
            const panelMessages = [];
            const symbol = { ...metadata };
            const elfResult = { elf: { sha256: "v-host" }, symbols: [symbol], warnings: [], dwarfReady: true };
            p._context = {
                workspaceState: {
                    get: (key) =>
                        key === CACHE_KEYS.elfPath ? "app.elf" : key === CACHE_KEYS.sidebarWatchList ? [member] : []
                }
            };
            p._elfService = {
                generation: 3,
                cache: elfResult,
                symbolByName: new Map([[symbol.name, symbol]]),
                invalidate() {},
                ready: async () => elfResult,
                layout: async (name) => {
                    if (name !== "drive") return null;
                    symbol.compositeLayout = layout;
                    return layout;
                }
            };
            p._watchLists = { invalidate() {}, rebind: async () => new Map() };
            p._sampling.invalidateRuntimeRam = () => {};
            p._sampling.refreshSamplingPlan = async () => {};
            p._latestSidebarSamples = new Map();
            p._webviewView = { webview: { postMessage: (msg) => sidebarMessages.push(msg) } };
            p._livePanels = new Map([
                ["1", { ready: true, watchKey: "g1", latestSamples: new Map(), post: (msg) => panelMessages.push(msg) }]
            ]);
            p._syncSidebarTarget = () => {};
            p._syncGraphTarget = () => {};
            p._scalarWatchList = () => [];
            p._watchListWithDisplayNames = () => [];
            await p._elfView.refreshBindings();
            assert.ok(
                sidebarMessages.some(
                    (m) =>
                        m.type === "compositeLayoutResult" &&
                        m.name === "drive" &&
                        m.generation === 3 &&
                        m.layout === layout
                )
            );
            assert.ok(
                panelMessages.some(
                    (m) =>
                        m.type === "compositeLayoutResult" &&
                        m.name === "drive" &&
                        m.generation === 3 &&
                        m.layout === layout
                )
            );
            sidebarMessages.length = 0;
            panelMessages.length = 0;
            await p._elfView.prepareLayouts(["drive.axes[1].low"], { broadcast: true });
            assert.ok(
                sidebarMessages.some(
                    (m) =>
                        m.type === "compositeLayoutResult" &&
                        m.name === "drive" &&
                        m.generation === 3 &&
                        m.layout === layout
                )
            );
            assert.ok(
                panelMessages.some(
                    (m) =>
                        m.type === "compositeLayoutResult" &&
                        m.name === "drive" &&
                        m.generation === 3 &&
                        m.layout === layout
                )
            );
        }
    );

    scenario("Keep nested picker branch pagination inside its own branch across parent pagination", () => {
        const subMembers = Array.from({ length: 70 }, (_, i) => ({
            name: "f" + i,
            offset: i * 4,
            byteSize: 4,
            watchType: "u32"
        }));
        const rootMembers = [
            {
                name: "sub",
                offset: 0,
                byteSize: 280,
                compositeLayout: { kind: "struct", byteSize: 280, typeName: "Sub", members: subMembers }
            },
            ...Array.from({ length: 75 }, (_, i) => ({
                name: "m" + i,
                offset: 280 + i * 4,
                byteSize: 4,
                watchType: "u32"
            }))
        ];
        const symbol = {
            name: "root",
            isComposite: true,
            address: 0x20000000,
            size: 580,
            compositeLayout: { kind: "struct", byteSize: 580, typeName: "Root", members: rootMembers }
        };
        for (const sidebar of [true, false]) {
            const page = render(sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
            try {
                const list = page.document.getElementById(sidebar ? "availableVars" : "impList");
                page.send({
                    type: sidebar ? "availableVariables" : "variablesList",
                    symbols: [structuredClone(symbol)]
                });
                if (!sidebar) page.window.openImport();
                list.querySelector('[data-picker-path="root"] button[aria-expanded]').click();
                const rootBody = list.querySelector(sidebar ? ".av-children" : ".imp-children");
                const subRow = list.querySelector('[data-picker-path="root.sub"]');
                const subBody = subRow.nextElementSibling;
                subRow.querySelector("button[aria-expanded]").click();
                assert.strictEqual(rootBody.querySelectorAll(":scope > .variable-notices .array-more").length, 1);
                assert.strictEqual(subBody.querySelectorAll(":scope > .variable-notices .array-more").length, 1);
                rootBody.querySelector(":scope > .variable-notices .array-more .notice-action").click();
                assert.strictEqual(rootBody.querySelectorAll(":scope > div > .leaf").length, 75);
                const subMore = subBody.querySelector(":scope > .variable-notices .array-more .notice-action");
                assert.ok(subMore, "parent pagination preserves child pagination controls");
                subMore.click();
                assert.strictEqual(subBody.querySelectorAll(".leaf").length, 70);
                page.assertHealthy();
            } finally {
                page.close();
            }
        }
    });

    scenario("Refresh newly expanded and paged liveWatch import selections after watchList updates", () => {
        const symbol = {
            name: "foo",
            isComposite: true,
            address: 0x20000000,
            size: 280,
            compositeLayout: {
                kind: "struct",
                byteSize: 280,
                typeName: "Foo",
                members: Array.from({ length: 70 }, (_, i) => ({
                    name: "f" + i,
                    offset: i * 4,
                    byteSize: 4,
                    watchType: "u32"
                }))
            }
        };
        const page = render(getLiveWatchContent({}, "en"));
        try {
            const doc = page.document;
            page.send({ type: "variablesList", symbols: [symbol] });
            page.window.openImport();
            page.send({
                type: "watchList",
                items: [
                    { name: "foo.f0", address: 0x20000000, size: 4, type: "u32" },
                    { name: "foo.f65", address: 0x20000104, size: 4, type: "u32" }
                ]
            });
            doc.querySelector('#impList [data-picker-path="foo"] button[aria-expanded]').click();
            assert.strictEqual(doc.querySelector('#impList input[data-leaf-path="foo.f0"]').checked, true);
            doc.querySelector("#impList .array-more .notice-action").click();
            assert.strictEqual(doc.querySelector('#impList input[data-leaf-path="foo.f65"]').checked, true);
            page.assertHealthy();
        } finally {
            page.close();
        }
    });

    await scenario(
        "Reuse scalar reference layout, reset user-only search expansion, and resume search after scalar pointer layout",
        async () => {
            const ref = {
                name: "ref",
                address: 0x20000000,
                size: 4,
                typeName: "int &",
                isReference: true,
                isComposite: false,
                hasRuntimeLayout: true
            };
            const refLayout = {
                kind: "class",
                byteSize: 4,
                members: [],
                runtimeLayout: {
                    root: 1,
                    types: [
                        { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" },
                        { kind: "reference", typeName: "int &", byteSize: 4, target: 0 }
                    ]
                }
            };
            const sidebar = render(getModernWebviewContent({}, "en"));
            try {
                sidebar.send({ type: "availableVariablesReset", version: "ref-v1", generation: 1 });
                sidebar.send({ type: "availableVariablesChunk", version: "ref-v1", symbols: [ref] });
                sidebar.send({ type: "availableVariablesDone", version: "ref-v1" });
                sidebar.send({ type: "availableTypesDone", version: "ref-v1" });
                const btn = () => sidebar.document.querySelector("#availableVars .av-watch");
                btn().click();
                sidebar.send({
                    type: "compositeLayoutResult",
                    version: "ref-v1",
                    generation: 1,
                    name: "ref",
                    layout: refLayout
                });
                btn().click();
                btn().click();
                assert.strictEqual(
                    sidebar.messages.filter((m) => m.type === "resolveCompositeLayout").length,
                    1,
                    "re-watching a resolved scalar reference does not request its layout again"
                );
                assert.strictEqual(
                    sidebar.messages.findLast((m) => m.type === "saveSidebarWatch").items[0].name,
                    "ref"
                );
                sidebar.assertHealthy();
            } finally {
                sidebar.close();
            }

            const makeComposite = (name, origin) => ({
                name,
                origin,
                isComposite: true,
                address: 0x20000000,
                size: 4,
                compositeLayout: {
                    kind: "struct",
                    byteSize: 4,
                    members: [{ name: "target_field", offset: 0, byteSize: 4, watchType: "u32" }]
                }
            });
            for (const isSidebar of [true, false]) {
                const page = render(isSidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"));
                try {
                    const symbols = [
                        ...Array.from({ length: 8 }, (_, i) => makeComposite("lib" + i, "vendor")),
                        makeComposite("my_user_var", "user")
                    ];
                    page.send({ type: isSidebar ? "availableVariables" : "variablesList", symbols });
                    if (!isSidebar) page.window.openImport();
                    const filter = page.document.getElementById(isSidebar ? "varSearch" : "impFilter");
                    filter.value = "target_field";
                    filter.dispatchEvent(new page.window.Event("input"));
                    page.document.getElementById(isSidebar ? "varUserOnly" : "impUserOnly").click();
                    const arrow = page.document.querySelector('[data-picker-path="my_user_var"] button[aria-expanded]');
                    assert.strictEqual(arrow.getAttribute("aria-expanded"), "true");
                    page.send({
                        type: isSidebar ? "availableVariables" : "variablesList",
                        symbols: [makeComposite("fresh_user_var", "user")]
                    });
                    assert.ok(page.document.querySelector('[data-picker-path="fresh_user_var"]'));
                    page.assertHealthy();
                } finally {
                    page.close();
                }
            }

            const refPtr = {
                name: "refPtr",
                address: 0x20000000,
                size: 4,
                typeName: "int * &",
                isReference: true,
                isPointer: true,
                isComposite: false,
                hasRuntimeLayout: true
            };
            const refPtrLayout = {
                kind: "class",
                byteSize: 4,
                members: [],
                runtimeLayout: {
                    root: 2,
                    types: [
                        { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" },
                        { kind: "pointer", typeName: "int *", byteSize: 4, target: 0 },
                        { kind: "reference", typeName: "int * &", byteSize: 4, target: 1 }
                    ]
                }
            };
            for (const isSidebar of [true, false]) {
                const clock = new FakeClock();
                const page = render(
                    isSidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en"),
                    {},
                    { clock }
                );
                try {
                    const prefix = isSidebar ? "availableVariables" : "variablesList";
                    const symbols = [
                        { name: "c0", address: 0x20000010, size: 4, isComposite: true },
                        { name: "c1", address: 0x20000020, size: 4, isComposite: true },
                        { name: "c2", address: 0x20000030, size: 4, isComposite: true },
                        { ...refPtr },
                        { name: "c4", address: 0x20000040, size: 4, isComposite: true }
                    ];
                    page.send({ type: prefix + "Reset", version: "ptr-search", generation: 1 });
                    page.send({ type: prefix + "Chunk", version: "ptr-search", symbols });
                    if (!isSidebar) page.window.openImport();
                    page.send({ type: prefix + "Done", version: "ptr-search" });
                    page.send({ type: isSidebar ? "availableTypesDone" : "variableTypesDone", version: "ptr-search" });
                    const filter = page.document.getElementById(isSidebar ? "varSearch" : "impFilter");
                    filter.value = "needle";
                    filter.dispatchEvent(new page.window.Event("input"));
                    await clock.advance(220);
                    const requests = () => page.messages.filter((m) => m.type === "resolveCompositeLayout");
                    assert.deepStrictEqual(
                        requests().map((m) => [m.name, !!m.background, !!m.promote]),
                        [
                            ["c0", true, false],
                            ["c1", true, false],
                            ["c2", true, false],
                            ["refPtr", true, false]
                        ]
                    );
                    page.send({
                        type: isSidebar ? "sidebarWatchList" : "watchList",
                        items: [
                            {
                                name: "refPtr",
                                address: 0x20000000,
                                size: 4,
                                type: "u32",
                                isPointer: true,
                                isReference: true
                            }
                        ]
                    });
                    assert.deepStrictEqual(requests().at(-1), {
                        type: "resolveCompositeLayout",
                        name: "refPtr",
                        version: "ptr-search",
                        generation: 1,
                        promote: true,
                        ...(isSidebar ? {} : { panelId: 1 })
                    });
                    page.send({
                        type: "compositeLayoutResult",
                        version: "ptr-search",
                        generation: 1,
                        name: "refPtr",
                        layout: refPtrLayout
                    });
                    await clock.advance(0);
                    assert.strictEqual(requests().at(-1).name, "c4", "scalar pointer layout completion resumes search");
                    page.assertHealthy();
                } finally {
                    page.close();
                }
            }
        }
    );

    console.log("Live-watch recursive member search and bounded lazy layout tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
