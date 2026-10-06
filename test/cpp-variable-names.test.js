"use strict";

const assert = require("assert");
const { normalizeWatchList } = require("../src/validation");
const { variableDisplayName, renderVariableName, shortVariableName } = require("../src/webview/runtime");
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
assert.strictEqual(variableDisplayName(normalized, [{ ...plant, displayName: plant.name }]), readablePath);
assert.strictEqual(
    variableDisplayName({ name: plant.name, displayName: plant.displayName }, [{ ...plant, displayName: plant.name }]),
    plant.displayName,
    "raw ELF placeholders do not overwrite known readable names"
);
for (const [name, expected] of [
    ["pwr.data_.bus_voltage_v", ".bus_voltage_v"],
    ["_ZL3pwr.data_.bus_voltage_v", ".bus_voltage_v"],
    ["app::Holder<std::pair<int, int>>::object.value_[2]", ".value_[2]"],
    ["app::Holder<foo::Bar>::buffer[2]", ".buffer[2]"],
    ["array[2]", "array[2]"],
    ["g_sensor_temp", "g_sensor_temp"]
])
    assert.strictEqual(shortVariableName(name), expected);

const runtimePlant = {
    ...plant,
    runtimeLayout: {
        root: 0,
        types: [
            { kind: "class", fields: [{ name: "value_", type: 1 }] },
            { kind: "scalar", watchType: "f32", byteSize: 4 }
        ]
    }
};
const [runtimeMember] = normalizeWatchList([{ name: rawPath }], [runtimePlant]);
assert.strictEqual(runtimeMember.displayName, readablePath, "C++ runtime member selections carry readable names");
assert.strictEqual(runtimeMember.name, rawPath);

const Provider = require("./helpers/load-provider").loadProvider();
const provider = Object.create(Provider.prototype);
provider._scalarWatchList = () => [{ name: rawPath, displayName: "stale" }, runtimeMember];
provider.readElfSymbols = () => ({ symbols: [plant] });
const namedWatch = provider._watchListWithDisplayNames("graph");
assert(namedWatch.every((entry) => entry.displayName === readablePath));
assert(namedWatch.every((entry) => entry.name === rawPath));
assert.strictEqual(provider._displayNamesForSeries("graph", [rawPath]).get(rawPath), readablePath);
provider._scalarWatchList = () => [];
assert.strictEqual(
    provider._displayNamesForSeries("graph", [rawPath]).get(rawPath),
    readablePath,
    "removed watch entries still resolve through ELF metadata"
);
provider._scalarWatchList = () => [runtimeMember];
provider.readElfSymbols = () => {
    throw new Error("ELF loading");
};
assert.strictEqual(provider._displayNamesForSeries("graph", [rawPath]).get(rawPath), readablePath);
assert.strictEqual(provider._displayNamesForSeries("graph", ["unknown", 42]).get("42"), "42");
assert.strictEqual(provider._displayNamesForSeries("graph", ["unknown"]).get("unknown"), "unknown");
assert.strictEqual(provider._displayNamesForSeries("graph", null).size, 0);
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
    assert(!element.title.includes(rawPath));
    assert.strictEqual(element.dataset.rawName, rawPath);
    assert.strictEqual(element.getAttribute("aria-label"), readablePath);
}

const sidebar = render(getModernWebviewContent({}, "en"));
try {
    sidebar.send({ type: "availableVariables", symbols: [plant] });
    sidebar.document.querySelector(".av-arrow").click();
    assert.strictEqual(sidebar.document.querySelector(".av-leaf-name").title, readablePath);
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
    graph.window.openImport();
    assert.strictEqual(graph.document.querySelector(".imp-name").title, "app::g_plant");
    graph.document.querySelector(".imp-arrow").click();
    assert.strictEqual(graph.document.querySelector(".imp-leaf-name").title, readablePath);
    graph.document.getElementById("addName").value = "app::g_plant";
    graph.window.renderAutocomplete();
    assert.strictEqual(graph.document.querySelector(".ac-name").title, "app::g_plant");
    graph.window.showArraySelectDialog({ ...plant, compositeLayout: { kind: "array", totalElements: 2 } }, () => {});
    assert(graph.document.querySelector(".array-panel h4").textContent.includes("app::g_plant[2]"));
    assert(!graph.document.querySelector(".array-panel h4").textContent.includes(plant.name));
    graph.document.querySelector(".var-card .remove").click();
    assert.strictEqual(graph.document.querySelectorAll(".var-card").length, 0);
    graph.assertHealthy();
} finally {
    graph.close();
}

const power = {
    name: "_ZL3pwr",
    displayName: "pwr",
    isComposite: true,
    address: 0x20000000,
    size: 4,
    compositeLayout: {
        kind: "class",
        members: [
            {
                name: "data_",
                offset: 0,
                compositeLayout: {
                    kind: "struct",
                    members: [{ name: "bus_voltage_v", offset: 0, byteSize: 4, watchType: "f32" }]
                }
            }
        ]
    }
};
const voltageName = power.name + ".data_.bus_voltage_v";
const nested = render(getLiveWatchContent({ panelId: 1 }, "en"));
try {
    nested.send({
        type: "watchList",
        items: [
            power,
            {
                name: voltageName,
                type: "f32",
                address: power.address,
                size: 4
            }
        ]
    });
    const leaf = nested.document.querySelector(".member-name");
    assert.strictEqual(leaf.textContent, "bus_voltage_v");
    assert.strictEqual(leaf.title, "pwr.data_.bus_voltage_v", "nested card title resolves the readable parent name");
    nested.send({ type: "variablesList", symbols: [{ ...power, displayName: power.name }] });
    assert.strictEqual(nested.document.querySelector(".member-name").title, "pwr.data_.bus_voltage_v");
    nested.window.chartState.hits = [{ name: voltageName, point: { t: 1000, v: 11.49 } }];
    nested.window.chartState.pointer = { x: 100, y: 100 };
    nested.window.controls.refresh();
    assert.strictEqual(nested.document.getElementById("curveTooltip").textContent, ".bus_voltage_v: 11.49");
    assert.strictEqual(nested.document.querySelector(".curve-hit").dataset.rawName, voltageName);
    nested.send({ type: "liveSample", samples: [{ name: voltageName, value: 11.4875, t: 1000 }] });
    assert.strictEqual(nested.window.latest[voltageName], 11.4875, "display changes preserve the sampling identity");
    nested.window.exportSource = "retained";
    nested.window.showLocalExport();
    assert.strictEqual(nested.document.querySelector("#exportSeries span").textContent, "pwr.data_.bus_voltage_v");
    nested.window.applyExport();
    let csv = nested.messages.findLast((message) => message.type === "exportCsv");
    assert.deepStrictEqual(Array.from(csv.names), [voltageName]);
    assert.strictEqual(csv.csv, "\uFEFFtime,pwr.data_.bus_voltage_v\r\n1970-01-01T00:00:01.000Z,11.4875\r\n");
    nested.window.freezeChart();
    nested.window.showExport();
    nested.window.applyExport();
    csv = nested.messages.findLast((message) => message.type === "exportCsv");
    assert.strictEqual(csv.source, "snapshot");
    assert(csv.csv.startsWith("\uFEFFtime,pwr.data_.bus_voltage_v\r\n"));
    nested.window.exportSource = "archive";
    nested.window.showArchiveExport({
        variables: [voltageName, "removed"],
        displayNames: { [voltageName]: "pwr.data_.bus_voltage_v", removed: "app::removed" },
        firstTimestampMs: 1000,
        lastTimestampMs: 2000
    });
    assert.deepStrictEqual(
        Array.from(nested.document.querySelectorAll("#exportSeries span"), (el) => el.textContent),
        ["pwr.data_.bus_voltage_v", "app::removed"]
    );
    nested.window.applyExport();
    csv = nested.messages.findLast((message) => message.type === "exportCsv");
    assert.deepStrictEqual(Array.from(csv.names), [voltageName, "removed"]);
    assert.strictEqual(csv.csv, undefined, "archive export selects raw identities for the host to read");
    nested.assertHealthy();
} finally {
    nested.close();
}

console.log("C++ member display names, saved identities and qualified-name presentation passed");

// Optional visual fixture, generated from the production webview without changing mock data.
if (process.argv.includes("--browser-preview")) {
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(__dirname, "..");
    const css = fs.readFileSync(path.join(root, "mockup/mock/theme.css"), "utf8");
    const colors = require("../mockup/vendor/light-modern-colors.json");
    const lightCss = Object.entries(colors)
        .map(([key, value]) => `--vscode-${key.replace(/\./g, "-")}:${value};`)
        .join("");
    const state = { expanded: { [power.name]: true, [power.name + ".data_"]: true } };
    const setup = `window.acquireVsCodeApi = () => ({postMessage() {}, getState() {
        return ${JSON.stringify(state)}; }, setState() {}});`;
    const fixture = `
        const power = ${JSON.stringify(power)};
        const member = ${JSON.stringify(voltageName)};
        const send = data => window.dispatchEvent(new MessageEvent("message", {data}));
        send({type:"watchList",items:[power,{name:member,type:"f32",address:power.address,size:4}]});
        send({type:"variablesList",symbols:[power]});
        send({type:"liveSample",samples:Array.from({length:901},(_,i)=>({name:member,value:11.4875,
            t:Date.now()-30000+i*33}))});
        send({type:"liveCompositeSample",samples:[{name:power.name,tree:{members:[{name:"data_",members:[
            {name:"bus_voltage_v",type:"f32",value:11.4875}
        ]}]}}]});
        send({type:"liveStatus",running:false});
    `;
    const html = getLiveWatchContent({ panelId: 1 }, "zh")
        .replace(
            "<head>",
            `<head><style>${css}\n:root{${lightCss}color-scheme:light;}</style><script>${setup}</script>`
        )
        .replace("</body>", `<script>${fixture}</script></body>`);
    const destination = path.join(root, "mockup/dist/curve-name-preview.html");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, html);
    console.log(destination);
}
