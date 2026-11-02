"use strict";

const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { isOfficialRelease } = require("./src/buildInfo");

const extensionBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "extension.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "extension.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    // jsonc-parser's UMD entry passes require into a factory, hiding relative imports from esbuild.
    alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
    external: ["vscode", "koffi"],
    minify: false,
    sourcemap: false,
    legalComments: "eof"
});

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
const chartHistoryBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "chartHistoryWorker.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "chartHistoryWorker.js"),
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

// MCP stdio server: a separate process that inlines the Bridge locator, diagnostics table and MCP SDK.
const mcpBuild = esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(__dirname, "src", "mcp", "server.js")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "mcp-server.js"),
    platform: "node",
    format: "cjs",
    target: "node18",
    // Most of its size is the SDK's zod/ajv dependencies; a separate process needs no readable bundle.
    minify: true,
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

function writeBuildInfo() {
    const version = require("./package.json").version;
    fs.writeFileSync(
        path.join(__dirname, "dist", "buildInfo.json"),
        JSON.stringify({ version, officialRelease: isOfficialRelease(version, process.env.RELEASE_TAG) }) + "\n"
    );
}

Promise.all([extensionBuild, samplingBuild, chartHistoryBuild, elfBuild, svdBuild, debugBuild, mcpBuild])
    .then(() => {
        stageSamplingTimer();
        writeBuildInfo();
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
