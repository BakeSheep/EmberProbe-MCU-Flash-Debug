"use strict";

const assert = require("assert");
const zlib = require("zlib");
const dwarf = require("../src/dwarf");
const elf = require("../src/elfSymbols");
const { ElfService } = require("../src/services/elfService");
const runtime = require("../src/webview/runtime");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const fixture = require("./fixtures/pointer-classes/elf.json");

const names = [
    "parent",
    "nextSibling",
    "label",
    "onClick",
    "userData",
    "x",
    "y",
    "speed",
    "position",
    "callback",
    "state",
    "rxBuffer"
];
const statePath = "motor.state.@base0._M_i";
const callbackPath = "motor.callback._M_invoker";
const managerPath = "motor.callback.@base1._M_manager";
const clone = (value) => JSON.parse(JSON.stringify(value));

function load(version) {
    const buffer = zlib.inflateSync(Buffer.from(fixture["dwarf" + version], "base64"));
    const parsed = dwarf.parseDwarf(buffer, { runtime: true });
    const result = elf.parseElfSymbols(buffer);
    new ElfService({ elfSymbols: elf, t: (key) => key })._enrich(
        result,
        parsed.types,
        parsed.layouts,
        parsed.displayNames
    );
    return result.symbols;
}
function setup(sidebar, lang, initialState = {}) {
    const view = render(sidebar ? getModernWebviewContent({}, lang) : getLiveWatchContent({}, lang), initialState);
    return {
        ...view,
        sidebar,
        rowSelector: sidebar ? ".sb-mrow" : ".member-row",
        nameSelector: sidebar ? ".sb-mname" : ".member-name",
        valueSelector: sidebar ? ".sb-mval" : ".member-value",
        listSelector: sidebar ? ".available-row.leaf" : ".imp-row.leaf",
        watch(items) {
            view.send({ type: sidebar ? "sidebarWatchList" : "watchList", items });
        },
        sample(tree, name = "motor") {
            view.send({ type: "liveCompositeSample", samples: [{ name, tree }] });
            this.flush();
        },
        scalar(samples) {
            view.send({ type: "liveSample", samples });
            this.flush();
        },
        flush() {
            if (sidebar) view.window.refreshDisplayedValues();
            else view.window.updateValues();
        },
        variables(symbols) {
            if (!sidebar) view.document.getElementById("import").click();
            view.send({ type: sidebar ? "availableVariables" : "variablesList", symbols });
            view.document.querySelector(sidebar ? ".av-arrow" : ".imp-arrow").click();
        },
        raw(name = "motor") {
            view.document.querySelector('.raw-members-toggle[data-variable-name="' + name + '"]').click();
            this.flush();
        },
        row(path) {
            return [...view.document.querySelectorAll(this.rowSelector)].find((row) => row.dataset.path === path);
        },
        text(path) {
            return this.row(path)?.querySelector(this.valueSelector).textContent;
        },
        collect(symbol, options) {
            return clone(
                (sidebar ? view.window.sbCollectLeaves : view.window.collectLeaves)(
                    symbol.compositeLayout,
                    symbol.name,
                    symbol.address,
                    options
                )
            );
        }
    };
}

// Pure helpers preserve the original formatter's zero, reject invalid addresses and localize display zero.
for (const lang of ["zh", "en"]) {
    const table = require("../src/i18n/" + lang);
    const t = (key) => table[key];
    assert.strictEqual(runtime.formatPointer(0), "0x00000000");
    assert.strictEqual(runtime.pointerDisplay(0, t), table["lw.pointerNull"]);
    assert.strictEqual(runtime.pointerDisplay(0x2000000c, t, "→ &rxBuf[12]"), "0x2000000C → &rxBuf[12]");
    for (const value of [-1, 0x100000000, NaN, 1.5, "12", null, undefined])
        assert.strictEqual(runtime.pointerDisplay(value, t), "—");
    assert.strictEqual(runtime.pointerDisplay(0xffffffff, t), "0xFFFFFFFF");
    assert.strictEqual(runtime.memberVisible({ memberRole: "internal" }), false);
    assert.strictEqual(runtime.memberVisible({ memberRole: "artificial" }, true), true);
    assert.strictEqual(runtime.memberVisible({}), true);
    assert.strictEqual(runtime.pointerNodeValue({ members: [], valueText: "nullptr" }), 0);
}

for (const version of [4, 5]) {
    const symbols = load(version);
    const motor = symbols.find((symbol) => symbol.name === "motor");
    const counter = { ...symbols.find((symbol) => symbol.name === "counterPtr"), type: "u32" };
    const leaves = elf.expandCompositeLeaves(motor, motor.compositeLayout);
    const leaf = (path) => leaves.find((entry) => entry.path === path);
    const bytes = Buffer.alloc(motor.size);
    bytes.writeUInt32LE(0x2000000c, leaf("motor.rxBuffer").address - motor.address);
    bytes.writeInt32LE(7, leaf(statePath).address - motor.address);
    const initialTree = elf.decodeComposite(bytes, motor.compositeLayout, motor);
    const rawWatch = { name: managerPath, address: leaf(managerPath).address, size: 4, type: "u32" };
    const staticMotor = { ...motor };
    delete staticMotor.runtimeLayout;

    for (const sidebar of [false, true]) {
        for (const lang of ["en", "zh"]) {
            const table = require("../src/i18n/" + lang);
            // Exercise static layouts as well as the runtime tree delivered by the reader.
            for (const item of [staticMotor, motor]) {
                const view = setup(sidebar, lang);
                let saved;
                try {
                    view.watch([item, rawWatch, counter]);
                    view.sample(initialTree);
                    view.scalar([
                        { name: managerPath, value: 17 },
                        { name: counter.name, value: 0 }
                    ]);
                    const rows = [...view.document.querySelectorAll(view.rowSelector)];
                    assert.strictEqual(rows.length, 12, "DWARF " + version + ": meaningful motor members only");
                    assert.deepStrictEqual(
                        rows.map((row) => row.querySelector(view.nameSelector).textContent),
                        names
                    );
                    assert.strictEqual(view.text(statePath), "7");
                    assert.strictEqual(view.text(callbackPath), table["lw.functionEmpty"]);
                    assert.strictEqual(view.row(statePath).querySelector(view.nameSelector).title, "motor.state");
                    assert.strictEqual(view.row(callbackPath).querySelector(view.nameSelector).title, "motor.callback");
                    assert.strictEqual(view.text("motor.@base0.parent"), table["lw.pointerNull"]);
                    assert.strictEqual(view.text("motor.rxBuffer"), "0x2000000C");
                    assert.match(view.row("motor.@base0.parent").textContent, /Widget \*/);
                    assert.ok(
                        view.document
                            .querySelector(".hidden-members")
                            .textContent.includes(
                                String(
                                    runtime.hiddenMemberCount(item.runtimeLayout ? initialTree : item.compositeLayout)
                                )
                            )
                    );
                    const scalarValues = [...view.document.querySelectorAll(sidebar ? ".value-number" : ".var-value")];
                    assert.ok(
                        scalarValues.some((cell) => cell.textContent === "0x00000011"),
                        "saved hidden raw member still renders"
                    );
                    assert.ok(scalarValues.some((cell) => cell.textContent === table["lw.pointerNull"]));
                    const scalarType = [
                        ...view.document.querySelectorAll(sidebar ? ".value-type" : ".var-main .member-type")
                    ];
                    assert.ok(scalarType.some((cell) => cell.textContent === counter.typeName));

                    const nextTree = clone(initialTree);
                    const visit = (node, path) => {
                        if (path === managerPath) node.value = 1;
                        if (path === callbackPath) {
                            node.value = 0x08000101;
                            node.pointerText = "→ clickHandler";
                        }
                        if (path === "motor.rxBuffer") node.pointerText = "→ &rxBuf[12]";
                        for (const member of node.members || []) visit(member, runtime.layoutMemberPath(path, member));
                        for (const element of node.elements || []) visit(element, path + "[" + element.index + "]");
                    };
                    visit(nextTree, "motor");
                    view.sample(nextTree);
                    view.scalar([{ name: counter.name, value: 0x2000000c, pointerText: "→ &rxBuf[12]" }]);
                    assert.strictEqual(
                        view.text(callbackPath),
                        "0x08000101 → clickHandler",
                        "function presence updates without rebuilding"
                    );
                    assert.strictEqual(view.text("motor.rxBuffer"), "0x2000000C → &rxBuf[12]");
                    assert.strictEqual(
                        view.row("motor.rxBuffer").querySelector(view.valueSelector).title,
                        "0x2000000C → &rxBuf[12]"
                    );
                    assert.ok(
                        [...view.document.querySelectorAll(sidebar ? ".value-number" : ".var-value")].some(
                            (cell) => cell.title === "0x2000000C → &rxBuf[12]"
                        )
                    );

                    const displayLeaves = view.collect(motor, { includePointers: true });
                    assert.strictEqual(displayLeaves.length, 12);
                    assert.strictEqual(displayLeaves.find((entry) => entry.path === statePath).label, ".state");
                    assert.strictEqual(displayLeaves.find((entry) => entry.path === callbackPath).label, ".callback");
                    const chartLeaves = view.collect(motor);
                    assert.deepStrictEqual(
                        chartLeaves.map((entry) => entry.path),
                        ["motor.@base0.x", "motor.@base0.y", "motor.speed", "motor.position", statePath]
                    );

                    view.variables(symbols.filter((symbol) => ["motor", "counterPtr"].includes(symbol.name)));
                    assert.strictEqual(view.document.querySelectorAll(view.listSelector).length, 12);
                    assert.ok(
                        [...view.document.querySelectorAll(sidebar ? ".av-leaf-name" : ".imp-leaf-name")].some(
                            (cell) => cell.textContent === ".state"
                        )
                    );
                    const search = view.document.getElementById(sidebar ? "varSearch" : "impFilter");
                    search.value = "_M_manager";
                    search.dispatchEvent(new view.window.Event("input"));
                    assert.strictEqual(
                        view.document.querySelectorAll(view.listSelector).length,
                        0,
                        "hidden internals are absent from search"
                    );
                    search.value = "";
                    search.dispatchEvent(new view.window.Event("input"));

                    view.raw();
                    assert.strictEqual(view.document.querySelectorAll(view.rowSelector).length, 26);
                    assert.strictEqual(view.document.querySelectorAll(view.listSelector).length, 26);
                    assert.ok(view.row(managerPath), "raw expansion restores the manager row");
                    saved = view.getState();
                    assert.strictEqual(saved[sidebar ? "sbRawMembers" : "rawMembers"].motor, true);
                    search.value = "_M_manager";
                    search.dispatchEvent(new view.window.Event("input"));
                    assert.strictEqual(
                        view.document.querySelectorAll(view.listSelector).length,
                        1,
                        "raw mode searches internals"
                    );
                    view.assertHealthy();
                } finally {
                    view.close();
                }
                const restored = setup(sidebar, lang, saved);
                try {
                    restored.watch([item]);
                    restored.sample(initialTree);
                    assert.strictEqual(restored.document.querySelectorAll(restored.rowSelector).length, 26);
                    assert.strictEqual(
                        restored.document.querySelector('.raw-members-toggle[data-variable-name="motor"]').textContent,
                        table["lw.hideRawMembers"]
                    );
                    restored.raw();
                    assert.strictEqual(restored.document.querySelectorAll(restored.rowSelector).length, 12);
                    if (!sidebar) {
                        restored.row("motor.rxBuffer").querySelector(".curve-toggle").click();
                        assert.ok(
                            restored.messages
                                .findLast((message) => message.type === "saveWatch")
                                .items.some((entry) => entry.name === "motor.rxBuffer" && entry.isPointer),
                            "manual pointer chart addition remains available"
                        );
                    }
                    restored.assertHealthy();
                } finally {
                    restored.close();
                }
            }
        }
    }
}

// A followed pointer has no own value: retain the address row and nest its pointee.
for (const sidebar of [false, true]) {
    const view = setup(sidebar, "en");
    const symbol = { name: "object", isComposite: true, runtimeLayout: { root: 0, types: [] } };
    try {
        view.watch([symbol]);
        const tree = {
            kind: "class",
            members: [
                {
                    name: "next",
                    kind: "class",
                    isPointer: true,
                    typeName: "Node *",
                    address: 0x20000000,
                    pointerValue: 0x20000100,
                    valueText: "0x20000100",
                    pointerText: "→ &node",
                    members: [
                        {
                            name: "value",
                            kind: "class",
                            members: [{ name: "count", kind: "scalar", type: "i32", value: 8 }]
                        }
                    ]
                },
                { name: "nil", kind: "scalar", type: "u32", isPointer: true, typeName: "void *", value: 0 },
                { name: "legacy", kind: "class", typeName: "Node *", members: [], valueText: "nullptr" },
                {
                    name: "bad",
                    kind: "scalar",
                    type: "u32",
                    isPointer: true,
                    typeName: "Node *",
                    value: 0xdeadbeef,
                    unavailable: "Unreadable pointer"
                },
                { name: "secret", kind: "scalar", type: "i32", memberRole: "artificial", value: 99 }
            ]
        };
        view.sample(tree, "object");
        assert.strictEqual(view.text("object.next"), "0x20000100 → &node");
        assert.strictEqual(view.text("object.next.value.count"), "8");
        assert.ok(view.row("object.next.value.count").closest(".pointer-pointee"));
        assert.strictEqual(view.text("object.nil"), "NULL");
        assert.strictEqual(view.text("object.legacy"), "NULL");
        assert.strictEqual(view.text("object.bad"), "0xDEADBEEF");
        assert.ok(
            view.document.getElementById(sidebar ? "liveValues" : "vars").textContent.includes("Unreadable pointer")
        );
        assert.strictEqual(view.row("object.secret"), undefined);
        const changed = clone(tree);
        changed.members[0].pointerValue = 0x20000200;
        changed.members[0].pointerText = "→ &other";
        view.sample(changed, "object");
        assert.strictEqual(view.text("object.next"), "0x20000200 → &other");
        view.raw("object");
        assert.strictEqual(view.text("object.secret"), "99");
        view.assertHealthy();
    } finally {
        view.close();
    }
}

// std::array summary subtrees retain raw cells and display member titles; const ancestry still gates writes.
const arrayLayout = {
    kind: "class",
    members: [
        {
            name: "samples",
            isConst: true,
            compositeLayout: {
                kind: "class",
                stdSummary: { kind: "value", targets: ["_M_elems"] },
                members: [
                    {
                        name: "_M_elems",
                        memberRole: "internal",
                        compositeLayout: {
                            kind: "array",
                            totalElements: 2,
                            elementType: { watchType: "i32", typeName: "int", byteSize: 4 }
                        }
                    }
                ]
            }
        }
    ]
};
const arraySymbol = { name: "packet", address: 0x20000000, size: 8, isComposite: true, compositeLayout: arrayLayout };
assert.ok(
    runtime.displayLayoutLeaves(arraySymbol, arrayLayout, "packet", arraySymbol.address).every((entry) => entry.isConst)
);
assert.strictEqual(
    runtime.displayLayoutLeaves(arraySymbol, arrayLayout, "packet", arraySymbol.address)[1].displayPath,
    "packet.samples[1]"
);
for (const sidebar of [false, true]) {
    for (const sampled of [false, true]) {
        const view = setup(sidebar, "en");
        try {
            view.watch([{ ...arraySymbol, ...(sampled ? { runtimeLayout: { root: 0, types: [] } } : {}) }]);
            view.sample(
                {
                    kind: "class",
                    members: [
                        {
                            name: "samples",
                            kind: "class",
                            stdSummary: { kind: "value", targets: ["_M_elems"] },
                            members: [
                                {
                                    name: "_M_elems",
                                    memberRole: "internal",
                                    kind: "array",
                                    elements: [
                                        { index: 0, kind: "scalar", type: "i32", value: 11 },
                                        { index: 1, kind: "scalar", type: "i32", value: 22 }
                                    ]
                                }
                            ]
                        }
                    ]
                },
                "packet"
            );
            assert.strictEqual(view.text("packet.samples._M_elems[1]"), "22");
            assert.strictEqual(
                view.row("packet.samples._M_elems[1]").querySelector(view.nameSelector).title,
                "packet.samples[1]"
            );
            assert.ok(
                [
                    ...view.document.querySelectorAll(
                        sidebar ? ".sb-comp-name, .summary-head" : ".comp-name, .summary-head"
                    )
                ].some((cell) => cell.textContent === "samples")
            );
            if (sidebar && !sampled) {
                view.variables([arraySymbol]);
                assert.ok(
                    [...view.document.querySelectorAll(".available-row.leaf .av-write")].every(
                        (button) => button.disabled
                    )
                );
            }
            view.assertHealthy();
        } finally {
            view.close();
        }
    }
}

// Runtime imports summarize ordinary library fields alongside semantic containers and stay read-only.
const mixed = {
    name: "mixed",
    address: 0x20000000,
    size: 32,
    isComposite: true,
    runtimeLayout: {
        root: 6,
        types: [
            { kind: "scalar", typeName: "int", byteSize: 4, watchType: "i32" },
            { kind: "pointer", typeName: "function *", byteSize: 4, target: 0, pointerTarget: "function" },
            {
                kind: "class",
                typeName: "std::atomic<int>",
                stdSummary: { kind: "value", targets: ["_M_i"] },
                fields: [{ name: "@base0", isBase: true, memberRole: "internal", type: 3 }]
            },
            {
                kind: "class",
                typeName: "std::__atomic_base<int>",
                fields: [{ name: "_M_i", memberRole: "internal", type: 0 }]
            },
            {
                kind: "class",
                typeName: "std::function<void()>",
                stdSummary: { kind: "function", targets: ["_M_invoker"], presence: ["_M_manager"] },
                fields: [
                    { name: "_M_invoker", memberRole: "internal", type: 1 },
                    { name: "_M_manager", memberRole: "internal", type: 1 }
                ]
            },
            { kind: "class", typeName: "std::vector<int>", stl: "vector", args: [0], fields: [] },
            {
                kind: "class",
                typeName: "Mixed",
                fields: [
                    { name: "values", type: 5 },
                    { name: "state", type: 2 },
                    { name: "callback", type: 4 },
                    { name: "hidden", memberRole: "artificial", type: 0 },
                    { name: "owner", type: 1 }
                ]
            }
        ]
    }
};
const mixedTree = {
    kind: "class",
    members: [
        { name: "values", kind: "array", elements: [{ index: 0, kind: "scalar", type: "i32", value: 3 }] },
        {
            name: "state",
            kind: "class",
            stdSummary: { kind: "value", targets: ["_M_i"] },
            members: [
                {
                    name: "@base0",
                    memberRole: "internal",
                    members: [{ name: "_M_i", kind: "scalar", type: "i32", memberRole: "internal", value: 4 }]
                }
            ]
        },
        {
            name: "callback",
            kind: "class",
            stdSummary: { kind: "function", targets: ["_M_invoker"], presence: ["_M_manager"] },
            members: [
                {
                    name: "_M_invoker",
                    kind: "scalar",
                    type: "u32",
                    typeName: "function *",
                    isPointer: true,
                    memberRole: "internal",
                    value: 0x08000101
                },
                { name: "_M_manager", kind: "scalar", type: "u32", memberRole: "internal", value: 1 }
            ]
        },
        { name: "hidden", kind: "scalar", type: "i32", memberRole: "artificial", value: 5 },
        { name: "owner", kind: "scalar", type: "u32", isPointer: true, typeName: "function *", value: 0 }
    ]
};
for (const tree of [undefined, mixedTree]) {
    const selection = runtime.displayRuntimeSelection(mixed, tree);
    assert.ok(!selection.entries.some((entry) => entry.path.includes("hidden") || entry.path.includes("_M_manager")));
    assert.strictEqual(selection.entries.find((entry) => entry.path === "mixed.state.@base0._M_i").label, ".state");
    assert.strictEqual(
        selection.entries.find((entry) => entry.path === "mixed.callback._M_invoker").label,
        ".callback"
    );
    assert.ok(selection.entries.find((entry) => entry.path === "mixed.owner").isPointer);
    assert.ok(selection.entries.every((entry) => entry.runtimeLayout));
}
for (const sidebar of [false, true]) {
    const view = setup(sidebar, "en");
    try {
        view.watch([mixed]);
        view.sample(mixedTree, mixed.name);
        view.variables([mixed]);
        const labels = [...view.document.querySelectorAll(sidebar ? ".av-leaf-name" : ".imp-leaf-name")];
        assert.ok(labels.some((cell) => cell.textContent === ".state"));
        assert.ok(labels.some((cell) => cell.textContent === ".callback"));
        assert.ok(!labels.some((cell) => /_M_|hidden/.test(cell.textContent)));
        if (sidebar)
            assert.ok([...view.document.querySelectorAll(".available-row.leaf .av-write")].every((b) => b.disabled));
        view.raw(mixed.name);
        assert.ok(
            [...view.document.querySelectorAll(sidebar ? ".av-leaf-name" : ".imp-leaf-name")].some((cell) =>
                cell.textContent.includes("_M_manager")
            )
        );
        view.assertHealthy();
    } finally {
        view.close();
    }
}

// Hidden unobservable members cannot leak back into import diagnostics.
const partial = {
    kind: "class",
    members: [
        { name: "_hidden", memberRole: "internal", unobservable: "depth-limit" },
        { name: "visible", unobservable: "depth-limit" }
    ]
};
assert.deepStrictEqual(
    runtime.displayUnavailableRows(partial, "partial").map((row) => row.path),
    ["partial.visible"]
);
assert.strictEqual(runtime.displayUnavailableRows(partial, "partial", 64, null, true).length, 2);

console.log(
    "Pointer display, summaries, raw state, chart exclusion and saved paths passed / both webviews, DWARF 4 and 5"
);
