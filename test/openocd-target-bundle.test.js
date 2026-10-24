"use strict";

const assert = require("assert");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");
const tar = require("tar");
const { archiveInventory, originalPayloadDigest } = require("../scripts/package-openocd-targets");
const { MCU_CORE_LIST } = require("../src/services/targetCatalog");
const { verifyBundle } = require("../scripts/openocd-bundle");
const manifest = require("../resources/openocd-targets-manifest.json");
const root = path.resolve(__dirname, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

(async () => {
    assert.strictEqual(manifest.schemaVersion, 2);
    await verifyBundle();
    assert.strictEqual(manifest.targets.length, 6);
    assert.strictEqual(new Set(manifest.targets.map((target) => target.path)).size, 6);
    assert.deepStrictEqual(manifest.archives.map((archive) => archive.platform).sort(), ["linux-x64", "win32-x64"]);
    for (const archive of manifest.archives) {
        const file = path.join(root, "resources", archive.file);
        assert.strictEqual(sha256(fs.readFileSync(file)), archive.sha256, archive.file);
        const inventory = await archiveInventory(file);
        const entries = new Map(inventory.map((entry) => [entry.path, entry]));
        assert.strictEqual(entries.size, inventory.length, "duplicate tar entries are forbidden");
        assert.strictEqual(
            originalPayloadDigest(inventory, archive, manifest.targets),
            archive.originalPayloadSha256,
            "every original file, link and permission must survive repacking"
        );
        assert.strictEqual(entries.get(archive.binary).sha256, archive.binarySha256, "executable bytes changed");
        if (archive.platform === "linux-x64") assert.ok(entries.get(archive.binary).mode & 0o111);
        for (const target of manifest.targets) {
            const bytes = fs.readFileSync(path.join(root, "resources", "openocd-targets", target.path));
            assert.strictEqual(sha256(bytes), target.sha256);
            assert.strictEqual(entries.get(`${archive.scriptsRoot}/${target.path}`).sha256, target.sha256);
            assert.ok(entries.has(`${archive.scriptsRoot}/${target.canonical}`), target.canonical);
        }
        for (const name of MCU_CORE_LIST) {
            assert.ok(entries.has(`${archive.scriptsRoot}/target/${name}`), `catalog entry absent: ${name}`);
        }
        const provenancePath = `${archive.prefix}distro-info/emberprobe-targets.json`;
        let provenance;
        await tar.t({
            file,
            onentry(entry) {
                if (entry.path.replace(/^\.\//, "") !== provenancePath) return;
                const chunks = [];
                entry.on("data", (chunk) => chunks.push(chunk));
                entry.on("end", () => {
                    provenance = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                });
            }
        });
        assert.deepStrictEqual(provenance.targets, manifest.targets);
        assert.strictEqual(provenance.baseArchiveSha256, archive.baseArchiveSha256);
        assert.strictEqual(provenance.originalPayloadSha256, archive.originalPayloadSha256);
        assert.strictEqual(provenance.binarySha256, archive.binarySha256);
    }
    console.log("Both patched OpenOCD archives preserve reviewed payloads and contain all catalog configurations");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
