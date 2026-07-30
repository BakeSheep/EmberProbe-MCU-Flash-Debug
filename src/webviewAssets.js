"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createNonce() {
    return crypto.randomBytes(18).toString("base64url");
}

function escapeAttribute(value) {
    return String(value).replace(
        /[&"<]/g,
        (character) =>
            ({
                "&": "&amp;",
                '"': "&quot;",
                "<": "&lt;"
            })[character]
    );
}

function writeAsset(assetRoot, scope, kind, index, content) {
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    const extension = kind === "style" ? "css" : "js";
    const file = path.join(assetRoot, `${scope}-${kind}-${index}-${hash}.${extension}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content);
    return file;
}

function externalizeWebviewHtml(options) {
    const { webview, vscode, assetRoot, scope } = options;
    let html = String(options.html || "");
    fs.mkdirSync(assetRoot, { recursive: true });
    const nonce = createNonce();
    let styleCount = 0;
    let scriptCount = 0;

    html = html.replace(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi, (_match, content) => {
        const file = writeAsset(assetRoot, scope, "style", styleCount++, content);
        const uri = webview.asWebviewUri(vscode.Uri.file(file)).toString();
        return `<link rel="stylesheet" href="${escapeAttribute(uri)}">`;
    });
    html = html.replace(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi, (_match, content) => {
        const file = writeAsset(assetRoot, scope, "script", scriptCount++, content);
        const uri = webview.asWebviewUri(vscode.Uri.file(file)).toString();
        return `<script nonce="${nonce}" src="${escapeAttribute(uri)}"></script>`;
    });

    if (!styleCount || !scriptCount) {
        throw Object.assign(new Error(`Webview ${scope} did not contain extractable style and script blocks`), {
            code: "WEBVIEW_ASSET_EXTRACTION_FAILED",
            scope
        });
    }

    const csp =
        [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `script-src ${webview.cspSource} 'nonce-${nonce}'`,
            `style-src ${webview.cspSource}`
        ].join(";") + ";";
    const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`;
    if (/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i.test(html)) {
        html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, meta);
    } else {
        html = html.replace(/<head>/i, `<head>${meta}`);
    }
    return { html, nonce, styleCount, scriptCount };
}

module.exports = { createNonce, externalizeWebviewHtml };
