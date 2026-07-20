"use strict";

const esbuild = require("esbuild");
const path = require("path");

esbuild.build({
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
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
