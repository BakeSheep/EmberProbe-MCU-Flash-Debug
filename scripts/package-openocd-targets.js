"use strict";

const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tar = require("tar");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "resources", "openocd-targets-manifest.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function archiveInventory(file) {
    const entries = [];
    await tar.t({
        file,
        strict: true,
        onentry(entry) {
            const name = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
            if (!name || entry.type === "Directory") return;
            const chunks = [];
            entry.on("data", (chunk) => chunks.push(chunk));
            entry.on("end", () => {
                entries.push({
                    path: name,
                    type: entry.type,
                    mode: entry.mode & 0o777,
                    linkpath: entry.linkpath || "",
                    sha256: sha256(Buffer.concat(chunks))
                });
            });
        }
    });
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function originalPayloadDigest(entries, archive, targets) {
    const added = new Set(targets.map((target) => `${archive.scriptsRoot}/${target.path}`));
    added.add(`${archive.prefix}distro-info/emberprobe-targets.json`);
    return sha256(JSON.stringify(entries.filter((entry) => !added.has(entry.path))));
}

async function packageTargets() {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const target of manifest.targets) {
        const bytes = fs.readFileSync(path.join(root, "resources", "openocd-targets", target.path));
        if (sha256(bytes) !== target.sha256) throw new Error(`Review changed wrapper: ${target.path}`);
    }
    for (const archive of manifest.archives) {
        const file = path.join(root, "resources", archive.file);
        const inventory = await archiveInventory(file);
        const digest = originalPayloadDigest(inventory, archive, manifest.targets);
        if (digest !== archive.originalPayloadSha256) throw new Error(`Original payload changed: ${archive.file}`);
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-targets-"));
        const nextArchive = path.join(os.tmpdir(), `emberprobe-targets-${process.pid}-${archive.platform}.tar.gz`);
        try {
            const added = new Set(manifest.targets.map((target) => `${archive.scriptsRoot}/${target.path}`));
            added.add(`${archive.prefix}distro-info/emberprobe-targets.json`);
            for (const target of manifest.targets) {
                const dest = path.join(staging, archive.scriptsRoot, target.path);
                const existing = inventory.find((entry) => entry.path === `${archive.scriptsRoot}/${target.path}`);
                if (existing && existing.sha256 !== target.sha256)
                    throw new Error(`Refusing to replace a different script: ${target.path}`);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(path.join(root, "resources", "openocd-targets", target.path), dest);
                fs.chmodSync(dest, 0o644);
            }
            const provenance = path.join(staging, archive.prefix, "distro-info", "emberprobe-targets.json");
            fs.mkdirSync(path.dirname(provenance), { recursive: true });
            fs.writeFileSync(
                provenance,
                JSON.stringify(
                    {
                        upstream: manifest.upstream,
                        ...(manifest.schemaVersion === 2
                            ? { build: manifest.build, source: manifest.source }
                            : { baseArchiveSha256: archive.baseArchiveSha256 }),
                        binarySha256: archive.binarySha256,
                        originalPayloadSha256: archive.originalPayloadSha256,
                        targets: manifest.targets
                    },
                    null,
                    4
                ) + "\n"
            );
            fs.chmodSync(provenance, 0o644);
            await tar.c(
                {
                    file: nextArchive,
                    cwd: staging,
                    portable: false,
                    noMtime: true,
                    gzip: true,
                    strict: true,
                    sync: true,
                    // Stream original tar entries directly: extracting on Windows loses Unix modes
                    // and can dereference Linux links. Exclude only our own previous additions.
                    filter: (name, entry) =>
                        !("type" in entry && added.has(name.replace(/^\.\//, "").replace(/\/$/, ""))),
                    onWriteEntry: (entry) => {
                        if (entry.stat && added.has(entry.path.replace(/^\.\//, ""))) {
                            entry.stat.mode = 0o644;
                            entry.portable = true;
                        }
                    }
                },
                [`@${file}`, ...added].map((name) => (name.startsWith("@") ? `@${path.resolve(name.slice(1))}` : name))
            );
            const result = await archiveInventory(nextArchive);
            if (originalPayloadDigest(result, archive, manifest.targets) !== digest)
                throw new Error(`Repacking changed original files or links: ${archive.file}`);
            fs.copyFileSync(nextArchive, file);
            archive.sha256 = sha256(fs.readFileSync(file));
            console.log(`Merged ${manifest.targets.length} compatible configurations into ${archive.file}`);
        } finally {
            fs.rmSync(staging, { recursive: true, force: true });
            fs.rmSync(nextArchive, { force: true });
        }
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + "\n");
}

if (require.main === module) {
    packageTargets().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { archiveInventory, originalPayloadDigest };
