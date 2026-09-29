"use strict";

const path = require("path");
const yauzl = require("yauzl");

const REQUIRED = [
    "extension/dist/sampling-timer/node_modules/koffi/package.json",
    "extension/dist/sampling-timer/node_modules/koffi/index.cjs",
    "extension/dist/sampling-timer/node_modules/koffi/src/koffi/index.cjs",
    "extension/dist/sampling-timer/node_modules/koffi/src/koffi/src/static.cjs",
    "extension/dist/sampling-timer/node_modules/koffi/LICENSE.txt",
    "extension/dist/sampling-timer/node_modules/@koromix/koffi-win32-x64/package.json",
    "extension/dist/sampling-timer/node_modules/@koromix/koffi-win32-x64/index.js",
    "extension/dist/sampling-timer/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node"
];

async function verifySamplingTimerVsix(file) {
    const zip = await new Promise((resolve, reject) =>
        yauzl.open(file, { lazyEntries: true }, (error, opened) => (error ? reject(error) : resolve(opened)))
    );
    const found = new Set();
    try {
        await new Promise((resolve, reject) => {
            zip.on("error", reject);
            zip.on("end", resolve);
            zip.on("entry", (entry) => {
                if (REQUIRED.includes(entry.fileName)) found.add(entry.fileName);
                zip.readEntry();
            });
            zip.readEntry();
        });
    } finally {
        zip.close();
    }
    for (const name of REQUIRED)
        if (!found.has(name)) throw new Error(`VSIX is missing Windows timer dependency: ${name}`);
}

if (require.main === module)
    verifySamplingTimerVsix(path.resolve(process.argv[2] || "dist/emberprobe.vsix"))
        .then(() => console.log("Windows sampling timer dependency verified in VSIX"))
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });

module.exports = { verifySamplingTimerVsix, REQUIRED };
