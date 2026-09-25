"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const directory = path.resolve(__dirname, "../resources/driver-helper/win32-x64");
function hash(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expectedFiles(base = directory) {
    const manifest = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("Invalid native helper manifest");
    const expected = new Map(manifest.files.map((item) => [item.name, item.sha256]));
    if (expected.size !== 2 || !expected.has("emberprobe-driver-helper.exe") || !expected.has("libwdi.dll"))
        throw new Error("Native helper manifest is incomplete");
    for (const [name, digest] of expected) {
        if (!/^[a-f0-9]{64}$/.test(digest) || hash(fs.readFileSync(path.join(base, name))) !== digest)
            throw new Error(`Native helper hash mismatch: ${name}`);
    }
    return expected;
}

async function verifyVsix(file, expected) {
    const yauzl = require("yauzl");
    const zip = await new Promise((resolve, reject) =>
        yauzl.open(file, { lazyEntries: true }, (error, opened) => (error ? reject(error) : resolve(opened)))
    );
    const found = new Map();
    await new Promise((resolve, reject) => {
        zip.on("error", reject);
        zip.on("end", resolve);
        zip.on("entry", (entry) => {
            const name = entry.fileName.replace(/^extension\/resources\/driver-helper\/win32-x64\//, "");
            if (!expected.has(name) || name === entry.fileName) return zip.readEntry();
            zip.openReadStream(entry, (error, stream) => {
                if (error) return reject(error);
                const parts = [];
                stream.on("data", (part) => parts.push(part));
                stream.on("error", reject);
                stream.on("end", () => {
                    found.set(name, hash(Buffer.concat(parts)));
                    zip.readEntry();
                });
            });
        });
        zip.readEntry();
    });
    zip.close();
    for (const [name, digest] of expected)
        if (found.get(name) !== digest) throw new Error(`VSIX is missing the verified helper bytes: ${name}`);
}

async function main() {
    const expected = expectedFiles();
    if (process.argv[2]) await verifyVsix(path.resolve(process.argv[2]), expected);
    console.log("Windows driver helper hashes verified");
}

if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
module.exports = { expectedFiles, verifyVsix };
