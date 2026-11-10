"use strict";

// The "RTT 终端" view in VS Code's bottom panel: an output area per up channel and an input box below it, like the
// Debug Console. The view is contributed with a `when` clause on CONTEXT_KEY, so its tab appears with the first RTT
// start and stays for the rest of the window's life. This class owns only the view's lifecycle and message wiring;
// the text and the sends belong to RttTerminalService, which rebuilds the page from its scrollback when it loads.

const { getRttPanelContent } = require("../rttPanelView");
const { createRttPanelHandler } = require("../controllers/rttPanelRoutes");

const VIEW_ID = "emberprobe.rttTerminal";
const CONTAINER_COMMAND = "workbench.view.extension.emberprobe-rtt";
const CONTEXT_KEY = "emberprobe.rttTerminalVisible";

class RttPanelHost {
    // host is the MainViewProvider: its `_rttTerminals`, `language` and `_renderWebview`.
    constructor(host, { vscode }) {
        this.host = host;
        this._vscode = vscode;
        this._view = null;
        this._ready = false;
        this._listener = null;
        this._shown = null; // The promise of the context key update, once the tab was asked to appear.
    }

    resolveWebviewView(view) {
        this._listener?.dispose();
        this._view = view;
        this._ready = false;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.host._context.extensionUri, this.host._webviewAssetRootUri]
        };
        const handle = createRttPanelHandler(this.host, this, this._vscode);
        this._listener = view.webview.onDidReceiveMessage((message) =>
            handle(message).catch((error) => console.error("RTT panel message failed:", error))
        );
        view.onDidDispose(() => {
            if (this._view !== view) return;
            this._listener?.dispose();
            this._listener = null;
            this._view = null;
            this._ready = false;
        });
        this._render();
    }

    // The page loaded: from now on it takes output as it comes.
    pageReady() {
        this._ready = true;
    }

    // The tab appears and stays; the context key is never cleared within the window.
    ensureVisible() {
        this._shown ??= Promise.resolve(this._vscode.commands.executeCommand("setContext", CONTEXT_KEY, true)).catch(
            () => {}
        );
        return this._shown;
    }

    // Shows the view. A resolved view keeps focus where it was when asked; one VS Code has not created yet is opened
    // through its container, which focuses it.
    async reveal(preserveFocus = true) {
        await this.ensureVisible();
        if (this._view?.show) this._view.show(preserveFocus);
        else await this._vscode.commands.executeCommand(CONTAINER_COMMAND);
    }

    // Messages before the page is ready are dropped: the snapshot it asks for carries them.
    post(message) {
        if (!this._view || !this._ready) return;
        Promise.resolve(this._view.webview.postMessage(message)).catch(() => {});
    }

    // The sidebar switched language: the page is rebuilt in it and asks for its snapshot again.
    languageChanged() {
        if (!this._view) return;
        this._ready = false;
        this._render();
    }

    // The view/title clear button: the page clears the channel it shows and reports which.
    clear() {
        this.post({ type: "rttClearRequest" });
    }

    _render() {
        const html = getRttPanelContent(this.host.language);
        return this.host._renderWebview(this._view.webview, html, "rttPanel");
    }
}

module.exports = { CONTAINER_COMMAND, CONTEXT_KEY, RttPanelHost, VIEW_ID };
