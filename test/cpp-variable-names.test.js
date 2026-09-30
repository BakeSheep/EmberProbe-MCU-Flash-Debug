"use strict";

const assert = require("assert");
const { normalizeWatchList } = require("../src/validation");
const { variableDisplayName, renderVariableName } = require("../src/webview/runtime");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

const plant = {
    name: "_ZN3app7g_plantE",
    displayName: "app::g_plant",
    address: 0x20000000,
    size: 4,
    isComposite: true,
    compositeLayout: {
        kind: "class",
        typeName: "Plant",
        byteSize: 4,
        members: [{ name: "value_", offset: 0, byteSize: 4, watchType: "f32", typeName: "float" }]
    }
};
const rawPath = plant.name + ".value_";
const readablePath = "app::g_plant.value_";
const [normalized] = normalizeWatchList([{ name: rawPath, displayName: "stale" }], [plant]);
assert.strictEqual(normalized.name, rawPath, "persist the ELF identity for sampling and writes");
assert.strictEqual(normalized.displayName, readablePath, "resolve member display names from the current ELF");
assert.strictEqual(normalized.address, plant.address);
assert.strictEqual(normalizeWatchList([normalized], [plant])[0].displayName, readablePath);
assert.strictEqual(normalizeWatchList([plant], [plant])[0].displayName, plant.displayName);
assert.strictEqual(variableDisplayName({ name: rawPath }, new Map([[plant.name, plant]])), readablePath);
assert.strictEqual(variableDisplayName({ name: plant.name + "[2].value_" }, [plant]), "app::g_plant[2].value_");
assert.strictEqual(variableDisplayName({ name: "unknown.value_" }, []), "unknown.value_");
assert.strictEqual(variableDisplayName({ name: "missing", displayName: "cached" }, []), "cached");
assert.strictEqual(
    variableDisplayName({ name: "Holder<std::array<int, 2>>::object.value_" }, [
        { name: "Holder<std::array<int, 2>>::object", displayName: "app::object" }
    ]),
    "app::object.value_"
);

function assertName(element) {
    assert.strictEqual(element.textContent, readablePath);
    assert.strictEqual(element.querySelector(".variable-name-prefix").textContent, "app::g_plant.");
    assert.strictEqual(element.querySelector(".variable-name-leaf").textContent, "value_");
    assert(element.title.includes(readablePath));
    assert(element.title.includes(rawPath));
    assert.strictEqual(element.getAttribute("aria-label"), readablePath);
}

const sidebar = render(getModernWebviewContent({}, "en"));
try {
    sidebar.send({ type: "availableVariables", symbols: [plant] });
    sidebar.document.querySelector(".av-arrow").click();
    sidebar.document.querySelector(".available-row.leaf .av-watch").click();
    assertName(sidebar.document.querySelector(".value-name"));
    const saved = sidebar.messages.findLast((message) => message.type === "saveSidebarWatch");
    assert.strictEqual(saved.items[0].name, rawPath);
    // Old saved entries carry no displayName; the loaded symbol table repairs their presentation.
    const legacyItem = { ...normalized };
    delete legacyItem.displayName;
    sidebar.send({ type: "sidebarWatchList", items: [legacyItem] });
    assertName(sidebar.document.querySelector(".value-name"));
    sidebar.send({ type: "sidebarWriteList", items: [{ ...legacyItem, min: 0, max: 10, value: 1 }] });
    assertName(sidebar.document.querySelector(".write-name-wrap .value-name"));
    sidebar.send({ type: "liveSample", samples: [{ name: rawPath, value: 3 }] });
    assert.strictEqual(sidebar.document.querySelector(".value-number").dataset.valueName, rawPath);
    assert.strictEqual(sidebar.document.querySelector(".value-number").textContent, "3");

    const name = sidebar.document.createElement("span");
    renderVariableName(name, "app::Holder<std::pair<int, int>>::object.value_[2]");
    assert.strictEqual(name.querySelector(".variable-name-leaf").textContent, "value_[2]");
    renderVariableName(name, "counter");
    assert.strictEqual(name.textContent, "counter");
    assert.strictEqual(name.classList.contains("qualified-name"), false);
    renderVariableName(name, "app::<img src=x>.value_");
    assert.strictEqual(name.querySelector("img"), null, "names are rendered as text");
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}

const graph = render(getLiveWatchContent({ panelId: 1 }, "en"));
try {
    graph.send({ type: "watchList", items: [{ ...normalized, displayName: rawPath }] });
    graph.send({ type: "variablesList", symbols: [plant] });
    assertName(graph.document.querySelector(".var-name"));
    graph.send({ type: "variablesListReset", version: "new" });
    graph.send({ type: "variablesListChunk", version: "new", symbols: [{ ...plant, displayName: plant.name }] });
    graph.send({ type: "variableTypes", version: "new", symbols: [plant] });
    graph.send({ type: "variableTypesDone", version: "new" });
    assertName(graph.document.querySelector(".var-name"));
    graph.document.querySelector(".var-card .remove").click();
    assert.strictEqual(graph.document.querySelectorAll(".var-card").length, 0);
    graph.assertHealthy();
} finally {
    graph.close();
}

console.log("C++ member display names, saved identities and qualified-name presentation passed");
