"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

const classSymbol = {
    name: "_ZN2ns3objE",
    displayName: "ns::obj",
    address: 0x20000000,
    size: 4,
    isComposite: true,
    typeName: "class Foo",
    compositeLayout: {
        kind: "class",
        typeName: "class Foo",
        byteSize: 4,
        members: [{ name: "value", offset: 0, byteSize: 4, typeName: "int", watchType: "i32" }]
    }
};
const scalarSymbol = {
    name: "_ZN2ns5countE",
    displayName: "ns::count",
    address: 0x20000004,
    size: 4,
    watchType: "i32"
};

const sidebar = render(getModernWebviewContent({}, "en"));
try {
    sidebar.send({ type: "availableVariables", symbols: [classSymbol, scalarSymbol] });
    sidebar.document.querySelector(".available-row.comp .av-arrow").click();
    assert.strictEqual(sidebar.document.querySelectorAll(".available-row.leaf").length, 1);
    assert.ok(sidebar.document.getElementById("availableVars").textContent.includes("ns::obj"));
    assert.ok(sidebar.document.getElementById("availableVars").textContent.includes("ns::count"));

    const search = sidebar.document.getElementById("varSearch");
    search.value = "ns::obj";
    search.dispatchEvent(new sidebar.window.Event("input"));
    assert.strictEqual(sidebar.document.querySelectorAll(".available-row.comp").length, 1);
    assert.strictEqual(sidebar.document.querySelectorAll(".available-row.leaf").length, 1);
    search.value = classSymbol.name;
    search.dispatchEvent(new sidebar.window.Event("input"));
    assert.strictEqual(sidebar.document.querySelectorAll(".available-row.comp").length, 1);

    sidebar.send({ type: "sidebarWatchList", items: [classSymbol] });
    assert.strictEqual(sidebar.document.querySelectorAll(".sb-mrow").length, 1);
    assert.ok(sidebar.document.getElementById("liveValues").textContent.includes("ns::obj"));
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}

const graph = render(getLiveWatchContent({ panelId: 1 }, "en"));
try {
    graph.document.getElementById("import").click();
    graph.send({ type: "variablesList", symbols: [classSymbol, scalarSymbol] });
    const filter = graph.document.getElementById("impFilter");
    filter.value = "ns::obj";
    filter.dispatchEvent(new graph.window.Event("input"));
    graph.document.querySelector(".imp-row .imp-arrow").click();
    assert.strictEqual(graph.document.querySelectorAll(".imp-row.leaf").length, 1);
    assert.ok(graph.document.getElementById("impList").textContent.includes("ns::obj"));
    filter.value = "ns::count";
    filter.dispatchEvent(new graph.window.Event("input"));
    assert.strictEqual(graph.document.querySelectorAll(".imp-row").length, 1);
    filter.value = classSymbol.name;
    filter.dispatchEvent(new graph.window.Event("input"));
    assert.strictEqual(graph.document.querySelectorAll(".imp-row.leaf").length, 1);

    const addName = graph.document.getElementById("addName");
    addName.value = "ns::count";
    addName.dispatchEvent(new graph.window.Event("input"));
    assert.ok(graph.document.getElementById("acDrop").textContent.includes("ns::count"));

    const rawWatchItem = { ...classSymbol };
    delete rawWatchItem.displayName;
    graph.send({ type: "watchList", items: [rawWatchItem] });
    assert.strictEqual(graph.document.querySelectorAll(".member-row").length, 1);
    assert.ok(graph.document.querySelector(".comp-name").textContent.includes("ns::obj"));
    graph.assertHealthy();
} finally {
    graph.close();
}

console.log("C++ webview compatibility tests passed");
