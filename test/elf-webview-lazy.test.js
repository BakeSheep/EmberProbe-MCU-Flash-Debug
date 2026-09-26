"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

const sidebar = render(getModernWebviewContent({}, "en"));
try {
    const symbols = Array.from({ length: 500 }, (_, index) => ({
        name: `v${index}`,
        address: 0x20000000 + index * 16,
        size: 12,
        isComposite: true,
        typeName: "struct S"
    }));
    sidebar.send({ type: "availableVariablesReset", version: "first" });
    sidebar.send({ type: "availableVariablesChunk", version: "first", symbols });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.comp").length, 100);
    const search = sidebar.document.getElementById("varSearch");
    search.value = "v499";
    search.dispatchEvent(new sidebar.window.Event("input"));
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.comp").length, 1);
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.leaf").length, 0);
    sidebar.document.querySelector("#availableVars .av-arrow").click();
    assert.deepStrictEqual(sidebar.messages.at(-1), {
        type: "resolveCompositeLayout",
        name: "v499",
        version: "first"
    });
    const layout = {
        kind: "struct",
        typeName: "struct S",
        byteSize: 1000,
        members: Array.from({ length: 250 }, (_, index) => ({
            name: `field${index}`,
            offset: index * 4,
            byteSize: 4,
            watchType: "u32",
            kind: "scalar"
        }))
    };
    sidebar.send({ type: "compositeLayoutResult", name: "v499", version: "stale", layout });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.leaf").length, 0);
    sidebar.send({ type: "compositeLayoutResult", name: "v499", version: "first", layout });
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row.leaf").length, 199);
    assert.strictEqual(sidebar.document.querySelectorAll("#availableVars .available-row").length, 200);
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}
console.log("ELF progressive sidebar and lazy member rendering tests passed");

const graph = render(getLiveWatchContent({}, "en"));
try {
    const symbols = Array.from({ length: 500 }, (_, index) => ({
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
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row").length, 100);
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
            members: Array.from({ length: 250 }, (_, index) => ({
                name: `field${index}`,
                offset: index * 4,
                byteSize: 4,
                watchType: "u32",
                kind: "scalar"
            }))
        }
    });
    assert.strictEqual(graph.document.querySelectorAll("#impList .imp-row").length, 200);
    graph.assertHealthy();
} finally {
    graph.close();
}
console.log("ELF progressive live-watch import and lazy member rendering tests passed");
