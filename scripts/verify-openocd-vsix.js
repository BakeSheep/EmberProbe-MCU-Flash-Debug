"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const yauzl = require("yauzl");
const { ROOT, sha256, verifyBundle } = require("./openocd-bundle");

async function verifyOpenOcdVsix(file, root = ROOT) {
    const manifest = await verifyBundle(root);
    const required = [
        "resources/openocd-targets-manifest.json",
        ...manifest.archives.map((archive) => `resources/${archive.file}`),
        "native/openocd/0001-emberprobe-read-scatter.patch",
        "native/openocd/build-lock.json",
        "native/openocd/build.sh",
        "native/openocd/prepare-build.js",
        "native/openocd/README.md",
        "THIRD_PARTY_NOTICES.md"
    ];
    const expected = new Map(
        required.map((name) => [`extension/${name}`, sha256(fs.readFileSync(path.join(root, name)))])
    );
    const zip = await new Promise((resolve, reject) =>
        yauzl.open(file, { lazyEntries: true }, (error, opened) => (error ? reject(error) : resolve(opened)))
    );
    const found = new Set();
    try {
        await new Promise((resolve, reject) => {
            zip.on("error", reject);
            zip.on("end", resolve);
            zip.on("entry", (entry) => {
                if (entry.fileName === `extension/${manifest.source.file}`) {
                    reject(new Error("Corresponding sources must be a separate Release asset"));
                    return;
                }
                if (!expected.has(entry.fileName)) return zip.readEntry();
                if (found.has(entry.fileName)) return reject(new Error(`Duplicate VSIX entry: ${entry.fileName}`));
                zip.openReadStream(entry, (error, stream) => {
                    if (error) return reject(error);
                    const hash = require("crypto").createHash("sha256");
                    stream.on("error", reject);
                    stream.on("data", (chunk) => hash.update(chunk));
                    stream.on("end", () => {
                        try {
                            assert.strictEqual(
                                hash.digest("hex"),
                                expected.get(entry.fileName),
                                `VSIX bytes differ: ${entry.fileName}`
                            );
                            found.add(entry.fileName);
                            zip.readEntry();
                        } catch (failure) {
                            reject(failure);
                        }
                    });
                });
            });
            zip.readEntry();
        });
    } finally {
        zip.close();
    }
    for (const name of expected.keys()) assert.ok(found.has(name), `VSIX missing: ${name}`);
    console.log("VSIX OpenOCD runtimes, provenance, patches and notices match the reviewed bundle");
}

if (require.main === module)
    verifyOpenOcdVsix(path.resolve(process.argv[2] || "dist/emberprobe.vsix")).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });

module.exports = { verifyOpenOcdVsix };
