"use strict";
const crypto = require("crypto");
const fs = require("fs/promises");
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

// Serialize writes and disposal cleanup per scope. Repeated renders of identical
// assets reuse the cache without rescanning storage; bound cache growth across panels.
const assetQueues = new Map();
const assetCache = new Map();
function withAssetScope(root, scope, operation) {
    const key = JSON.stringify([root, scope]);
    const previous = assetQueues.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => operation(key));
    assetQueues.set(key, pending);
    return pending.finally(() => {
        if (assetQueues.get(key) === pending) assetQueues.delete(key);
    });
}

async function pruneAssets(assetRootDir, scope, keep) {
    try {
        for (const name of await fs.readdir(assetRootDir)) {
            if (!name.startsWith(`${scope}-`) || keep.has(name)) continue;
            await fs.rm(path.join(assetRootDir, name), { force: true });
        }
    } catch {
        /* Cleanup must not prevent rendering. */
    }
}

function pruneWebviewAssets(assetRootDir, scope, keep) {
    return withAssetScope(assetRootDir, scope, async (key) => {
        assetCache.delete(key);
        await pruneAssets(assetRootDir, scope, keep);
    });
}

async function externalizeWebviewHtml(options) {
    const { webview, vscode, assetRootUri, scope } = options;
    let html = String(options.html || "");
    const nonce = createNonce();
    let styleCount = 0;
    let scriptCount = 0;
    const assets = [];
    const assetUri = (kind, index, content) => {
        const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
        const extension = kind === "style" ? "css" : "js";
        const name = `${scope}-${kind}-${index}-${hash}.${extension}`;
        const fileUri = vscode.Uri.joinPath(assetRootUri, name);
        assets.push({ name, fileUri, content });
        return escapeAttribute(webview.asWebviewUri(fileUri).toString());
    };
    html = html.replace(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi, (_match, content) => {
        return `<link rel="stylesheet" href="${assetUri("style", styleCount++, content)}">`;
    });
    html = html.replace(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi, (_match, content) => {
        return `<script nonce="${nonce}" src="${assetUri("script", scriptCount++, content)}"></script>`;
    });

    if (!styleCount || !scriptCount) {
        throw Object.assign(new Error(`Webview ${scope} did not contain extractable style and script blocks`), {
            code: "WEBVIEW_ASSET_EXTRACTION_FAILED",
            scope
        });
    }

    // Fail closed on markup the regex extractor cannot fully account for. A script body
    // holding a literal </script> truncates the lazy match and leaks the tail past the
    // nonce tag; a non-standard <stylesheet> block is never extracted; inline on*/style
    // attributes execute despite the CSP. Reject all three instead of shipping broken HTML.
    const scriptOpens = (html.match(/<script/gi) || []).length;
    const scriptCloses = (html.match(/<\/script>/gi) || []).length;
    if (
        /<style/i.test(html) ||
        scriptOpens !== scriptCount ||
        scriptCloses !== scriptCount ||
        /\son\w+\s*=/i.test(html) ||
        /\sstyle\s*=/i.test(html)
    ) {
        throw Object.assign(new Error(`Webview ${scope} contained markup that failed CSP hardening`), {
            code: "WEBVIEW_ASSET_EXTRACTION_FAILED",
            scope
        });
    }

    await withAssetScope(assetRootUri.fsPath, scope, async (key) => {
        const signature = JSON.stringify(assets.map((asset) => asset.name));
        if (assetCache.get(key) === signature) return;
        assetCache.delete(key);
        await fs.mkdir(assetRootUri.fsPath, { recursive: true });
        for (const asset of assets) {
            try {
                await fs.writeFile(asset.fileUri.fsPath, asset.content, { flag: "wx" });
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
        }
        await pruneAssets(assetRootUri.fsPath, scope, new Set(assets.map((asset) => asset.name)));
        assetCache.set(key, signature);
        while (assetCache.size > 64) assetCache.delete(assetCache.keys().next().value);
    });

    const csp =
        [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `script-src ${webview.cspSource} 'nonce-${nonce}'`,
            `style-src ${webview.cspSource}`
        ].join(";") + ";";
    const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`;
    // Replace the first CSP meta with the authoritative policy and drop every other one, so
    // an injected duplicate such as `default-src *; script-src 'unsafe-inline'` cannot survive.
    let cspInjected = false;
    html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, () => {
        if (cspInjected) return "";
        cspInjected = true;
        return meta;
    });
    if (!cspInjected) html = html.replace(/<head>/i, `<head>${meta}`);
    return { html, nonce, styleCount, scriptCount };
}

module.exports = { createNonce, externalizeWebviewHtml, pruneWebviewAssets };
