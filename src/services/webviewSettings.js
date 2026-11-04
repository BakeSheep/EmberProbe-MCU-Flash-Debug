"use strict";

function webviewSettings(vscode) {
    return {
        type: "webviewSettings",
        mouseWheelZoom: vscode.workspace.getConfiguration("editor").get("mouseWheelZoom", false) === true
    };
}

function broadcastWebviewSettings(host, vscode) {
    const settings = webviewSettings(vscode);
    host._webviewView?.webview.postMessage(settings);
    for (const entry of host._livePanels.values()) entry.post(settings);
}

module.exports = { webviewSettings, broadcastWebviewSettings };
