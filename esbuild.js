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

const samplingBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "samplingWorker.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "samplingWorker.js"),
    platform: "node",
    format: "cjs",
    target: "node20"
});
const debugBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "debug", "adapter.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "debugAdapter.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    legalComments: "eof"
});
Promise.all([extensionBuild, samplingBuild, debugBuild, webviewBuild("sidebar"), webviewBuild("liveWatch")]).catch(
    (error) => {
        console.error(error);
        process.exit(1);
    }
);
