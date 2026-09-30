"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { deflateRawSync } = require("zlib");
const yauzl = require("yauzl");

async function verifyStlVsix(file) {
    const source = fs.readFileSync(path.resolve(__dirname, "../src/debug/stl.js"));
    // This module is included in both entry bundles. Its uncompressed size is a
    // conservative upper bound, independent of ZIP compression settings.
    assert(source.length * 2 < 500000, "Built-in STL display exceeds the 0.5 MB growth budget");
    const zip = await new Promise((resolve, reject) =>
        yauzl.open(file, { lazyEntries: true }, (error, value) => (error ? reject(error) : resolve(value)))
    );
    const bundles = new Set();
    try {
        await new Promise((resolve, reject) => {
            zip.on("error", reject);
            zip.on("end", resolve);
            zip.on("entry", (entry) => {
                const name = entry.fileName;
                if (
                    /^extension\/(?:test|test-results|coverage|toolchains|measurements)\//.test(name) ||
                    /\.(?:elf|axf|o|vsix)$/i.test(name) ||
                    /(?:^|\/)(?:arm-none-eabi-gdb[^/]*|python(?:\d+(?:\.\d+)?)?\.exe|xpack-arm[^/]*|measure-[^/]*)$/i.test(
                        name
                    )
                ) {
                    reject(new Error(`Test artifact or debugger runtime included in VSIX: ${name}`));
                    return;
                }
                if (/^extension\/dist\/(?:extension|debugAdapter)\.js$/.test(name)) bundles.add(name);
                zip.readEntry();
            });
            zip.readEntry();
        });
    } finally {
        zip.close();
    }
    assert.strictEqual(bundles.size, 2, "Both runtime bundles must be packaged");
    console.log(
        `VSIX contains runtime bundles without test toolchains/ELFs; STL module compressed upper estimate ${deflateRawSync(source).length * 2} bytes`
    );
}

if (require.main === module)
    verifyStlVsix(path.resolve(process.argv[2] || "dist/emberprobe.vsix")).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

module.exports = { verifyStlVsix };
