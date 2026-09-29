"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const extensionBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "extension.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "extension.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode", "koffi"],
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
    target: "node20",
    external: ["koffi"]
});
const elfBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "elfWorker.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "elfWorker.js"),
    platform: "node",
    format: "cjs",
    target: "node20"
});
const svdBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "svdWorker.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "svdWorker.js"),
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

function stageSamplingTimer() {
    const required = [
        "koffi/package.json",
        "koffi/index.cjs",
        "koffi/LICENSE.txt",
        "koffi/src/koffi/index.cjs",
        "koffi/src/koffi/src/static.cjs"
    ];
    const windows = [
        "@koromix/koffi-win32-x64/package.json",
        "@koromix/koffi-win32-x64/index.js",
        "@koromix/koffi-win32-x64/win32_x64/koffi.node"
    ];
    const output = path.join(__dirname, "dist", "sampling-timer", "node_modules");
    for (const name of required) {
        const source = path.join(__dirname, "node_modules", name);
        const target = path.join(output, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
    }
    for (const name of windows) {
        const source = path.join(__dirname, "node_modules", name);
        const target = path.join(output, name);
        if (fs.existsSync(source)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(source, target);
        } else fs.rmSync(target, { force: true });
    }
}

Promise.all([
    extensionBuild,
    samplingBuild,
    elfBuild,
    svdBuild,
    debugBuild,
    webviewBuild("sidebar"),
    webviewBuild("liveWatch")
])
    .then(stageSamplingTimer)
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
