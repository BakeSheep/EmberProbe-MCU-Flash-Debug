"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const DEFAULT_ROOT = path.resolve(__dirname, "../resources/probe-rs");

function verify(root = DEFAULT_ROOT, release = false) {
    const platforms = fs.readdirSync(root);
    if (!platforms.length) throw new Error("No native sampler packages");
    if (
        release &&
        (!platforms.includes("win32-x64") ||
            !platforms.includes("linux-x64") ||
            !platforms.some((name) => /^darwin-(?:arm64|x64)$/.test(name)))
    )
        throw new Error("Incomplete release native platform matrix");
    for (const platform of platforms) {
        if (!/^(?:win32|linux|darwin)-(?:x64|arm64)$/.test(platform))
            throw new Error("Invalid native platform directory");
        const directory = path.join(root, platform);
        const filename = "emberprobe-probe-rs" + (platform.startsWith("win32-") ? ".exe" : "");
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
        const digest = crypto
            .createHash("sha256")
            .update(fs.readFileSync(path.join(directory, filename)))
            .digest("hex");
        if (manifest.protocol !== 1 || manifest.file !== filename || manifest.sha256 !== digest)
            throw new Error(`Invalid native sampler identity: ${platform}`);
        if (!fs.statSync(path.join(directory, "THIRD_PARTY_NOTICES.txt")).size)
            throw new Error("Native dependency notices missing");
    }
    return platforms;
}
async function verifyVsix(file, root = DEFAULT_ROOT, release = false) {
    const expected = new Map();
    for (const platform of verify(root, release)) {
        const binary = "emberprobe-probe-rs" + (platform.startsWith("win32-") ? ".exe" : "");
        for (const name of [binary, "manifest.json", "THIRD_PARTY_NOTICES.txt"]) {
            const digest = crypto
                .createHash("sha256")
                .update(fs.readFileSync(path.join(root, platform, name)))
                .digest("hex");
            expected.set(`extension/resources/probe-rs/${platform}/${name}`, {
                digest,
                executable: name === binary && !platform.startsWith("win32-")
            });
        }
    }
    const zip = await new Promise((resolve, reject) =>
        require("yauzl").open(file, { lazyEntries: true }, (error, opened) => (error ? reject(error) : resolve(opened)))
    );
    try {
        await new Promise((resolve, reject) => {
            zip.on("error", reject);
            zip.on("end", resolve);
            zip.on("entry", (entry) => {
                const item = expected.get(entry.fileName);
                if (!item) return zip.readEntry();
                if (item.executable && !((entry.externalFileAttributes >>> 16) & 0o111))
                    return reject(new Error(`VSIX native executable mode missing: ${entry.fileName}`));
                zip.openReadStream(entry, (error, stream) => {
                    if (error) return reject(error);
                    const hash = crypto.createHash("sha256");
                    stream.on("error", reject);
                    stream.on("data", (bytes) => hash.update(bytes));
                    stream.on("end", () => {
                        if (hash.digest("hex") !== item.digest)
                            return reject(new Error(`VSIX native hash mismatch: ${entry.fileName}`));
                        expected.delete(entry.fileName);
                        zip.readEntry();
                    });
                });
            });
            zip.readEntry();
        });
        if (expected.size) throw new Error(`VSIX native files missing: ${[...expected.keys()].join(", ")}`);
    } finally {
        zip.close();
    }
}
if (require.main === module) {
    (async () => {
        const vsix = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
        if (vsix) await verifyVsix(vsix, DEFAULT_ROOT, process.argv.includes("--release"));
        console.log("Verified native samplers: " + verify(undefined, process.argv.includes("--release")).join(", "));
    })().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
module.exports = { verify, verifyVsix };
