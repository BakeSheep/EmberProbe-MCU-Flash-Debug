"use strict";

const assert = require("assert");
const { getModernWebviewContent } = require("../src/modernView");
const { addPeripheralViewerSvd } = require("../src/services/peripheralViewerIntegration");
const { render } = require("./helpers/render-webview");

const original = { name: "debug" };
assert.strictEqual(addPeripheralViewerSvd(original, ""), original);
assert.deepStrictEqual(addPeripheralViewerSvd(original, "/device.svd"), {
    name: "debug",
    svdPath: "/device.svd"
});
assert.strictEqual(original.svdPath, undefined);

const view = render(getModernWebviewContent({}, "en"));
try {
    view.assertHealthy();
    assert(view.document.getElementById("svdSelect").closest("#otherConfig"));
    assert(view.document.getElementById("svdDownload").closest("#otherConfig"));
    assert(view.document.getElementById("peripheralSection"));
    assert.strictEqual(view.document.querySelector("#peripheralSection #svdSelect"), null);
    assert.strictEqual(view.document.querySelector('[data-command="mcu-vscode.enablePeripheralViewer"]'), null);
    assert(!view.messages.some((message) => message.type === "peripheralCatalogRequest"));
    view.send({ type: "svdStatus", state: "configured", path: "/device.svd" });
    assert(view.messages.some((message) => message.type === "peripheralCatalogRequest"));
    view.assertHealthy();
} finally {
    view.close();
}

console.log("SVD auto-activation and configuration placement passed");
