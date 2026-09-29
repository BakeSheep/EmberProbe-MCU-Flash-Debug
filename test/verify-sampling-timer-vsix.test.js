"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yazl = require("yazl");
const { verifySamplingTimerVsix, REQUIRED } = require("../scripts/verify-sampling-timer-vsix");

async function makeVsix(file, names) {
    const zip = new yazl.ZipFile();
    for (const name of names) zip.addBuffer(Buffer.from("fixture"), name);
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-timer-vsix-"));
    try {
        const complete = path.join(dir, "complete.vsix");
        await makeVsix(complete, REQUIRED);
        await verifySamplingTimerVsix(complete);
        const missing = path.join(dir, "missing.vsix");
        await makeVsix(missing, REQUIRED.slice(0, -1));
        await assert.rejects(verifySamplingTimerVsix(missing), /missing Windows timer dependency/);
        console.log("Windows sampling timer VSIX content tests passed");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
