"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const modernView = require("../src/modernView");
const liveWatchView = require("../src/liveWatchView");
const { externalizeWebviewHtml } = require("../src/webviewAssets");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-webview-assets-"));
try {
    const assetRootUri = { scheme: "file", fsPath: temp, path: "/global-storage/webview-assets" };
    const joinedUris = [];
    const vscode = {
        Uri: {
            joinPath: (root, name) => {
                assert.strictEqual(root, assetRootUri, "asset URIs must preserve the authorized root URI");
                const uri = { scheme: root.scheme, fsPath: path.join(root.fsPath, name), root };
                joinedUris.push(uri);
                return uri;
            }
        }
    };
    const webview = {
        cspSource: "vscode-webview://test",
        asWebviewUri: (uri) => {
            assert.strictEqual(uri.root, assetRootUri, "served assets must derive from localResourceRoots");
            return { toString: () => `vscode-resource:/${path.basename(uri.fsPath)}` };
        }
    };
    const cases = [
        ["sidebar", modernView.getModernWebviewContent({ elf: "", debugger: "", mcu: "", svd: "" }, "en")],
        ["live", liveWatchView.getLiveWatchContent({ maxSamples: 100, intervalMs: 20 }, "en")]
    ];
    for (const [scope, source] of cases) {
        const result = externalizeWebviewHtml({
            html: source,
            webview,
            vscode,
            assetRootUri,
            scope
        });
        assert.ok(result.styleCount >= 1);
        assert.ok(result.scriptCount >= 1);
        assert.ok(!result.html.includes("<style"), `${scope} must not contain inline styles`);
        assert.ok(!/<script(?![^>]*\bsrc=)/i.test(result.html), `${scope} must not contain inline scripts`);
        assert.ok(!result.html.includes("unsafe-inline"), `${scope} CSP must not allow unsafe-inline`);
        assert.ok(result.html.includes(`'nonce-${result.nonce}'`));
        assert.ok(result.html.includes(`nonce="${result.nonce}"`));
    }
    assert.ok(joinedUris.length >= 4, "all extracted assets must use Uri.joinPath");
    assert.ok(fs.readdirSync(temp).some((file) => file.endsWith(".css")));
    assert.ok(fs.readdirSync(temp).some((file) => file.endsWith(".js")));
    console.log("Webview asset and CSP tests passed");
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
