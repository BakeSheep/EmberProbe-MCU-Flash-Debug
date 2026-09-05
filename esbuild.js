"use strict";

const esbuild = require("esbuild");
const path = require("path");

const extensionBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "extension.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "extension.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
    minify: false,
    sourcemap: false,
    legalComments: "eof"
});

function webviewBuild(area) {
    return esbuild.build({
        absWorkingDir: __dirname,
        entryPoints: [
            path.join(__dirname, "src", "webview", area, "renderer.js"),
            ...(area === "liveWatch" ? [path.join(__dirname, "src", "webview", area, "viewport.js")] : []),
            path.join(__dirname, "src", "webview", area, "app.css")
        ],
        bundle: true,
        outdir: path.join(__dirname, "dist", "webview", area),
        platform: "browser",
        banner: { js: require("./src/webviewTemplate").loadRendererPrelude(area) },
        format: "iife",
        target: "es2020",
        minify: false,
        sourcemap: false,
        legalComments: "none"
    });
}

Promise.all([extensionBuild, webviewBuild("sidebar"), webviewBuild("liveWatch")]).catch((error) => {
    console.error(error);
    process.exit(1);
});
