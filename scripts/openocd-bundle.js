"use strict";

const assert = require("assert");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");
const tar = require("tar");
const { archiveInventory, originalPayloadDigest, scriptAdditions } = require("./package-openocd-targets");

const ROOT = path.resolve(__dirname, "..");
const PLATFORMS = ["win32-x64", "linux-x64"];
const SOURCE_FILE = "native/openocd/emberprobe-openocd-source.tar.gz";
// Applied in this order; 0002/0003 are pending upstream reviews 9697/9699 pinned by build-lock.json.
const PATCHES = [
    "0001-emberprobe-read-scatter.patch",
    "0002-stldr-flash-driver.patch",
    "0003-stm32c5x-target.patch",
    "0004-emberprobe-c5-local-loaders.patch"
];
const DISTRIBUTION = "EmberProbe OpenOCD 0.12.0-7 + scatter v1 + stldr/STM32C5";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function safePath(value) {
    assert.strictEqual(typeof value, "string");
    assert.ok(value && !value.includes("\\") && !value.includes(":"), "Invalid archive path");
    assert.ok(!value.startsWith("/") && !value.split("/").includes(".."), "Archive path escapes its root");
    return value;
}

async function inspectArchive(file) {
    const entries = await archiveInventory(file);
    const names = new Set();
    for (const entry of entries) {
        safePath(entry.path);
        assert.ok(!names.has(entry.path), `Duplicate archive entry: ${entry.path}`);
        names.add(entry.path);
        assert.ok(["File", "SymbolicLink", "Link"].includes(entry.type), `Unsupported entry: ${entry.path}`);
        if (entry.type !== "File") {
            assert.ok(!path.posix.isAbsolute(entry.linkpath), "Absolute archive link");
            safePath(
                path.posix.normalize(
                    entry.type === "Link"
                        ? entry.linkpath
                        : path.posix.join(path.posix.dirname(entry.path), entry.linkpath)
                )
            );
        }
    }
    return entries;
}

async function archiveJson(file, name) {
    let bytes = Buffer.alloc(0);
    let found = false;
    await tar.t({
        file,
        strict: true,
        onentry(entry) {
            if (entry.path.replace(/^\.\//, "") !== name) return;
            assert.ok(!found, `Duplicate metadata: ${name}`);
            found = true;
            entry.on("data", (chunk) => {
                assert.ok(bytes.length + chunk.length <= 8 * 1024 * 1024, "Archive metadata exceeds budget");
                bytes = Buffer.concat([bytes, chunk]);
            });
        }
    });
    assert.ok(found, `Missing metadata: ${name}`);
    return JSON.parse(bytes.toString("utf8"));
}

function buildIdentity(root = ROOT) {
    const lock = readJson(path.join(root, "native/openocd/build-lock.json"));
    return {
        lockSha256: sha256(fs.readFileSync(path.join(root, "native/openocd/build-lock.json"))),
        patches: Object.fromEntries(
            PATCHES.map((name) => [name, sha256(fs.readFileSync(path.join(root, "native/openocd", name)))])
        ),
        buildScriptSha256: sha256(fs.readFileSync(path.join(root, "native/openocd/build.sh"))),
        prepareScriptSha256: sha256(fs.readFileSync(path.join(root, "native/openocd/prepare-build.js"))),
        image: lock.image,
        openocdRevision: lock.openocdRevision,
        xpackRevision: lock.xpackRevision,
        submodules: lock.submodules
    };
}

function checkBuild(info, identity, platform) {
    assert.deepStrictEqual(info.identity, identity, "Build does not match the reviewed sources and recipes");
    assert.strictEqual(info.platform, platform, "Build platform mismatch");
    assert.strictEqual(info.buildId, sha256(JSON.stringify(identity)), "Mixed build identity");
}

async function verifySources(file, identity) {
    const entries = new Map((await inspectArchive(file)).map((entry) => [entry.path, entry]));
    const source = await archiveJson(file, "source-manifest.json");
    assert.deepStrictEqual(source.identity, identity, "Corresponding sources belong to another build");
    assert.ok(source.files && Object.keys(source.files).length > 0, "Missing source inventory");
    for (const [name, entry] of entries) {
        if (entry.type === "File" && name !== "source-manifest.json")
            assert.strictEqual(source.files[name], entry.sha256, `Unlisted source: ${name}`);
    }
    for (const name of [
        "openocd/src/target/arm_adi_v5.c",
        "openocd/src/flash/nor/stldr.c",
        "openocd/tcl/target/stm32c5x.cfg",
        "openocd/jimtcl/jim.c",
        "openocd/src/jtag/drivers/libjaylink/libjaylink/core.c",
        "openocd/COPYING",
        "recipes/build.sh",
        "recipes/prepare-build.js",
        "recipes/build-lock.json",
        ...PATCHES.map((name) => `recipes/${name}`)
    ])
        assert.ok(entries.has(name), `Corresponding source missing: ${name}`);
    for (const [name, digest] of Object.entries(source.files)) {
        assert.strictEqual(entries.get(safePath(name))?.sha256, digest, `Source digest mismatch: ${name}`);
    }
    const lock = await archiveJson(file, "recipes/build-lock.json");
    for (const [name, dependency] of Object.entries(lock.downloads)) {
        assert.strictEqual(entries.get(`downloads/${name}`)?.sha256, dependency.sha256, `Missing source: ${name}`);
    }
    assert.strictEqual(entries.get("recipes/build-lock.json").sha256, identity.lockSha256);
    assert.strictEqual(entries.get("recipes/build.sh").sha256, identity.buildScriptSha256);
    assert.strictEqual(entries.get("recipes/prepare-build.js").sha256, identity.prepareScriptSha256);
    for (const name of PATCHES)
        assert.strictEqual(entries.get(`recipes/${name}`).sha256, identity.patches[name], `Patch mismatch: ${name}`);
    return source;
}

async function verifyBundle(root = ROOT) {
    const manifest = readJson(path.join(root, "resources/openocd-targets-manifest.json"));
    assert.strictEqual(manifest.schemaVersion, 2);
    assert.deepStrictEqual(manifest.archives.map((archive) => archive.platform).sort(), [...PLATFORMS].sort());
    const identity = buildIdentity(root);
    assert.deepStrictEqual(manifest.build.identity, identity);
    assert.strictEqual(manifest.build.buildId, sha256(JSON.stringify(identity)));
    assert.strictEqual(manifest.source.file, SOURCE_FILE);
    const sourcePath = path.join(root, safePath(manifest.source.file));
    assert.strictEqual(sha256(fs.readFileSync(sourcePath)), manifest.source.sha256, "Source archive changed");
    await verifySources(sourcePath, identity);
    for (const archive of manifest.archives) {
        const file = path.join(root, "resources", safePath(archive.file));
        assert.strictEqual(sha256(fs.readFileSync(file)), archive.sha256, "Runtime archive changed");
        const inventory = await inspectArchive(file);
        const entries = new Map(inventory.map((entry) => [entry.path, entry]));
        assert.strictEqual(
            originalPayloadDigest(inventory, archive, scriptAdditions(manifest)),
            archive.originalPayloadSha256
        );
        assert.strictEqual(entries.get(archive.binary)?.sha256, archive.binarySha256);
        if (archive.platform === "linux-x64") assert.ok(entries.get(archive.binary).mode & 0o111);
        for (const required of archive.requiredFiles)
            assert.ok(entries.has(required), `Runtime dependency missing: ${required}`);
        for (const target of manifest.targets) {
            assert.strictEqual(entries.get(`${archive.scriptsRoot}/${target.path}`)?.sha256, target.sha256);
            assert.ok(entries.has(`${archive.scriptsRoot}/${target.canonical}`));
        }
        for (const loader of manifest.flashLoaders || [])
            assert.strictEqual(entries.get(`${archive.scriptsRoot}/${loader.path}`)?.sha256, loader.sha256);
        checkBuild(await archiveJson(file, `${archive.prefix}BUILD-INFO.json`), identity, archive.platform);
        const provenance = await archiveJson(file, `${archive.prefix}distro-info/emberprobe-targets.json`);
        assert.deepStrictEqual(provenance, {
            upstream: manifest.upstream,
            build: manifest.build,
            source: manifest.source,
            binarySha256: archive.binarySha256,
            originalPayloadSha256: archive.originalPayloadSha256,
            targets: manifest.targets,
            ...(manifest.flashLoaders ? { flashLoaders: manifest.flashLoaders } : {})
        });
    }
    return manifest;
}

module.exports = {
    ROOT,
    PLATFORMS,
    SOURCE_FILE,
    PATCHES,
    DISTRIBUTION,
    sha256,
    readJson,
    safePath,
    inspectArchive,
    archiveJson,
    buildIdentity,
    checkBuild,
    verifySources,
    verifyBundle
};
