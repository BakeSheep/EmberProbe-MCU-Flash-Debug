"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");

(async () => {
    const renders = [];
    const Provider = loadProvider(
        {},
        {
            "./webviewAssets": {
                externalizeWebviewHtml: () => new Promise((resolve) => renders.push(resolve))
            }
        }
    );
    const provider = Object.create(Provider.prototype);
    provider._webviewRenders = new WeakMap();
    const webview = { html: "initial" };
    provider._webviewView = { webview };
    provider.getModernWebviewContent = () => "content";
    const oldRender = provider.updateView();
    const newRender = provider.updateView();
    renders[1]({ html: "new" });
    await newRender;
    renders[0]({ html: "old" });
    await oldRender;
    assert.strictEqual(webview.html, "new", "a late render must not overwrite the newest content");
    const closingRender = provider.updateView();
    provider._webviewRenders.delete(webview);
    renders[2]({ html: "closed" });
    await closingRender;
    assert.strictEqual(webview.html, "new", "disposed views must not receive pending HTML");
    console.log("Webview render ordering tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
