"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
(async () => {
    const panels = [],
        writes = [],
        values = new Map([
            ["mcu.watchList.2", [{ name: "shared" }]],
            ["mcu.watchList", [{ name: "first" }, { name: "shared" }]]
        ]);
    const vscode = {
        ViewColumn: { Active: 1 },
        Uri: { joinPath: (_folder, name) => ({ fsPath: name }), file: (name) => ({ fsPath: name }) },
        workspace: {
            getConfiguration: () => ({ get: (_key, fallback) => fallback }),
            fs: { writeFile: async (_uri, bytes) => writes.push(bytes.toString("utf8")) }
        },
        window: {
            createWebviewPanel() {
                const p = {
                    messages: [],
                    webview: {
                        postMessage: (m) => p.messages.push(structuredClone(m)),
                        onDidReceiveMessage: (handler) => {
                            p.receive = handler;
                        }
                    },
                    onDidDispose() {},
                    onDidChangeViewState() {}
                };
                panels.push(p);
                return p;
            },
            showSaveDialog: async () => ({ fsPath: "snapshot.csv" }),
            showInformationMessage() {},
            showErrorMessage() {}
        }
    };
    const P = loadProvider(vscode),
        p = Object.create(P.prototype);
    p._context = {
        workspaceState: {
            get: (key) => values.get(key),
            keys: () => [...values.keys()],
            update: async (key, value) => values.set(key, value)
        }
    };
    p._livePanels = new Map();
    p._livePanelFocusOrder = 0;
    p._lang = "en";
    p._t = (key) => key;
    p._invalidateConsumerTypes = () => {};
    p._renderWebview = () => {};
    p._syncGraphTarget = () => {};
    p.openLiveWatchPanel();
    p.openLiveWatchPanel();
    await panels[1].receive({ type: "ready", panelId: 2 });
    await panels[0].receive({ type: "ready", panelId: 1 });
    assert.equal(
        panels[1].messages[0].styles.shared.color,
        "#F14C4C",
        "migration priority is panel ID, not ready order"
    );
    await panels[1].receive({ type: "setSeriesStyle", name: "shared", style: { color: "#123456", line: "dotted" } });
    assert.equal(panels[0].messages.at(-1).styles.shared.color, "#123456");
    assert.equal(panels[1].messages.at(-1).styles.shared.line, "dotted");
    await panels[0].receive({ type: "setSeriesStyle", panelId: 2, name: "other" });
    assert.equal(panels[0].messages.at(-1).type, "liveError");
    await panels[0].receive({ type: "setSeriesStyle", name: "shared", style: { color: "invalid", line: "solid" } });
    assert.equal(panels[0].messages.at(-1).type, "liveError");
    await panels[0].receive({ type: "exportCsv", source: "snapshot", names: ["shared"], csv: "time,shared\r\nnow,42" });
    assert.equal(writes[0], "time,shared\r\nnow,42");
    assert.equal(panels[0].messages.at(-1).ok, true);
    await panels[0].receive({ type: "exportCsv", source: "retained", names: ["shared"], csv: 7 });
    assert.equal(panels[0].messages.at(-1).ok, false);
    console.log("Chart host migration, multi-panel styles and snapshot export tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
