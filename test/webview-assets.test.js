"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");
const modernView = require("../src/modernView");
const liveWatchView = require("../src/liveWatchView");
const { externalizeWebviewHtml, pruneWebviewAssets } = require("../src/webviewAssets");

for (const file of [
    "../src/webview/sidebar/app.css",
    "../src/webview/sidebar/renderer.js",
    "../src/webview/liveWatch/app.css",
    "../src/webview/liveWatch/viewport.js",
    "../src/webview/liveWatch/renderer.js"
]) {
    assert.ok(fs.statSync(path.resolve(__dirname, file)).size > 100, `${file} must be a real webview asset`);
}

(async () => {
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
            const result = await externalizeWebviewHtml({
                html: source,
                webview,
                vscode,
                assetRootUri,
                scope
            });
            assert.ok(result.styleCount >= 1);
            assert.ok(result.scriptCount >= 1);
            const dom = new JSDOM(result.html);
            try {
                const doc = dom.window.document;
                assert.strictEqual(doc.querySelector("style"), null);
                const policy = new Map(
                    doc
                        .querySelector('meta[http-equiv="Content-Security-Policy"]')
                        .content.split(";")
                        .map((part) => part.trim().split(/\s+/))
                        .map(([key, ...values]) => [key, values])
                );
                assert.deepStrictEqual(policy.get("default-src"), ["'none'"]);
                assert.ok(![...policy.values()].flat().includes("'unsafe-inline'"));
                assert.ok(policy.get("script-src").includes(`'nonce-${result.nonce}'`));
                for (const script of doc.querySelectorAll("script")) {
                    assert.ok(script.src.startsWith("vscode-resource:/"));
                    assert.strictEqual(script.textContent, "");
                    assert.strictEqual(script.nonce, result.nonce);
                }
            } finally {
                dom.window.close();
            }
        }
        assert.ok(joinedUris.length >= 4, "all extracted assets must use Uri.joinPath");
        assert.ok(fs.readdirSync(temp).some((file) => file.endsWith(".css")));
        assert.ok(fs.readdirSync(temp).some((file) => file.endsWith(".js")));

        const originalReaddir = fs.promises.readdir;
        let scans = 0;
        fs.promises.readdir = async () => {
            scans++;
            throw new Error("cached render must not scan");
        };
        try {
            await externalizeWebviewHtml({ html: cases[0][1], webview, vscode, assetRootUri, scope: "sidebar" });
        } finally {
            fs.promises.readdir = originalReaddir;
        }
        assert.strictEqual(scans, 0, "identical renders must skip disk scanning");

        // 旧哈希资产在重新 externalize 后被清理；其他 scope 与无关文件不受影响
        const staleSidebar = path.join(temp, "sidebar-style-0-deadbeef.css");
        const staleOtherScope = path.join(temp, "live-style-0-deadbeef.css");
        const unrelated = path.join(temp, "notes.txt");
        fs.writeFileSync(staleSidebar, "old");
        fs.writeFileSync(staleOtherScope, "old");
        fs.writeFileSync(unrelated, "keep");
        await externalizeWebviewHtml({
            html: cases[0][1].replace("</style>", "/* updated asset */</style>"),
            webview,
            vscode,
            assetRootUri,
            scope: "sidebar"
        });
        assert.ok(!fs.existsSync(staleSidebar), "stale assets of the same scope must be pruned");
        assert.ok(fs.existsSync(staleOtherScope), "assets of other scopes must be preserved");
        assert.ok(fs.existsSync(unrelated), "unrelated files must be preserved");
        assert.ok(
            fs.readdirSync(temp).some((file) => file.startsWith("sidebar-")),
            "current sidebar assets must survive pruning"
        );
        for (const scope of ["live-watch-1", "live-watch-2", "live-watch-1"]) {
            await externalizeWebviewHtml({ html: cases[1][1], webview, vscode, assetRootUri, scope });
        }
        for (const scope of ["live-watch-1", "live-watch-2"])
            assert.ok(fs.readdirSync(temp).some((file) => file.startsWith(scope + "-")));
        // Disposal queues behind an in-flight render, then invalidates its asset cache.
        const options = { html: cases[1][1], webview, vscode, assetRootUri, scope: "disposable" };
        await Promise.all([externalizeWebviewHtml(options), pruneWebviewAssets(temp, "disposable", new Set())]);
        assert.ok(!fs.readdirSync(temp).some((name) => name.startsWith("disposable-")));
        await externalizeWebviewHtml(options);
        assert.ok(fs.readdirSync(temp).some((name) => name.startsWith("disposable-")));
        await assert.rejects(() => externalizeWebviewHtml({ ...options, html: "<head></head>" }), {
            code: "WEBVIEW_ASSET_EXTRACTION_FAILED"
        });
        console.log("Webview asset and CSP tests passed");
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// §4 CSP 构建加固：对畸形/恶意标记 fail-closed，并保证唯一权威 CSP meta。
(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-webview-csp-"));
    try {
        const assetRootUri = { scheme: "file", fsPath: temp, path: "/global-storage/webview-assets" };
        const vscode = {
            Uri: {
                joinPath: (root, name) => ({ scheme: root.scheme, fsPath: path.join(root.fsPath, name), root })
            }
        };
        const webview = {
            cspSource: "vscode-webview://test",
            asWebviewUri: (uri) => ({ toString: () => `vscode-resource:/${path.basename(uri.fsPath)}` })
        };
        const base = `<head><style>body{color:red}</style></head><body><script>var a=1;</script></body>`;

        // (1) 第二个注入的 CSP meta 不得存活；最终只保留唯一权威 meta。
        const twoMeta =
            `<head>` +
            `<meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self'">` +
            `<meta http-equiv="Content-Security-Policy" content="default-src *;script-src 'unsafe-inline'">` +
            `<style>body{color:red}</style></head><body><script>var a=1;</script></body>`;
        const result = await externalizeWebviewHtml({
            html: twoMeta,
            webview,
            vscode,
            assetRootUri,
            scope: "csp-two"
        });
        const metas = result.html.match(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/gi) || [];
        assert.strictEqual(metas.length, 1, "exactly one authoritative CSP meta must remain");
        assert.ok(!/default-src\s+\*/i.test(result.html), "injected permissive CSP must be removed");
        assert.ok(!/'unsafe-inline'/i.test(result.html), "no policy may retain 'unsafe-inline'");

        // (2) 脚本体内含 "</script>" 时不得把标记泄漏到 nonce 脚本标签之外。
        await assert.rejects(
            () =>
                externalizeWebviewHtml({
                    html: base.replace("var a=1;", 'var s="</script>";var b=2;'),
                    webview,
                    vscode,
                    assetRootUri,
                    scope: "csp-script"
                }),
            { code: "WEBVIEW_ASSET_EXTRACTION_FAILED" },
            "stray </script> must fail closed"
        );

        // (3) 非标准 <stylesheet> 块不得原样穿透。
        await assert.rejects(
            () =>
                externalizeWebviewHtml({
                    html: base.replace("<body>", "<body><stylesheet>RAW</stylesheet>"),
                    webview,
                    vscode,
                    assetRootUri,
                    scope: "csp-stylesheet"
                }),
            { code: "WEBVIEW_ASSET_EXTRACTION_FAILED" },
            "<stylesheet> must fail closed"
        );

        // (4) 内联事件处理器 / style 属性不得在外部化后存活。
        await assert.rejects(
            () =>
                externalizeWebviewHtml({
                    html: base.replace("<body>", '<body><div onclick="alert(1)" style="x:y">z</div>'),
                    webview,
                    vscode,
                    assetRootUri,
                    scope: "csp-inline"
                }),
            { code: "WEBVIEW_ASSET_EXTRACTION_FAILED" },
            "inline on*/style attributes must fail closed"
        );

        console.log("Webview CSP hardening tests passed");
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
