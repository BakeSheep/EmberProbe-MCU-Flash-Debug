"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yazl = require("yazl");
const { expectedFiles, verifyVsix } = require("../scripts/verify-driver-helper");

function digest(bytes) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function makeVsix(file, files) {
    const zip = new yazl.ZipFile();
    for (const [name, bytes] of files) zip.addBuffer(bytes, `extension/resources/driver-helper/win32-x64/${name}`);
    await new Promise((resolve, reject) => {
        const stream = fs.createWriteStream(file);
        zip.outputStream.on("error", reject);
        stream.on("error", reject);
        stream.on("finish", resolve);
        zip.outputStream.pipe(stream);
        zip.end();
    });
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-helper-verify-"));
    try {
        const files = new Map([
            ["emberprobe-driver-helper.exe", Buffer.from("native exe")],
            ["libwdi.dll", Buffer.from("native dll")]
        ]);
        for (const [name, bytes] of files) fs.writeFileSync(path.join(root, name), bytes);
        fs.writeFileSync(
            path.join(root, "manifest.json"),
            JSON.stringify({ version: 1, files: [...files].map(([name, bytes]) => ({ name, sha256: digest(bytes) })) })
        );
        const expected = expectedFiles(root);
        const good = path.join(root, "good.vsix");
        await makeVsix(good, files);
        await verifyVsix(good, expected);
        const missing = path.join(root, "missing.vsix");
        await makeVsix(missing, new Map([["emberprobe-driver-helper.exe", files.get("emberprobe-driver-helper.exe")]]));
        await assert.rejects(verifyVsix(missing, expected), /missing the verified helper bytes/);
        fs.writeFileSync(path.join(root, "libwdi.dll"), "tampered");
        assert.throws(() => expectedFiles(root), /hash mismatch/);
        console.log("Native helper manifest and VSIX content tests passed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
