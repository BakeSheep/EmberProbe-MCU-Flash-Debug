"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const tar = require("tar");
const { originalPayloadDigest, scriptAdditions } = require("./package-openocd-targets");
const {
    ROOT,
    PLATFORMS,
    SOURCE_FILE,
    PATCHES,
    DISTRIBUTION,
    sha256,
    safePath,
    readJson,
    inspectArchive,
    archiveJson,
    buildIdentity,
    checkBuild,
    verifySources,
    verifyBundle
} = require("./openocd-bundle");

// Keep the native build's actual sources and identity. Ship separately identified Tcl overrides alongside them.
async function stageScriptSources(input, destination, overrides, root, staging) {
    const source = await archiveJson(input, "source-manifest.json");
    const entries = new Map((await inspectArchive(input)).map((entry) => [entry.path, entry]));
    const additions = ["source-manifest.json"];
    for (const override of overrides) {
        const name = safePath(override.path);
        assert.ok(/^target\/[^\s]+\.cfg$/.test(name), "Only target Tcl scripts can override a compiled build");
        assert.strictEqual(
            entries.get(`openocd/tcl/${name}`)?.sha256,
            override.baseSha256,
            `Base script changed: ${name}`
        );
        const bytes = fs.readFileSync(path.join(root, "resources/openocd-targets", name));
        assert.strictEqual(sha256(bytes), override.sha256, `Review changed script: ${name}`);
        const sourceName = `runtime-script-overrides/${name}`;
        const file = path.join(staging, sourceName);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        source.files[sourceName] = override.sha256;
        additions.push(sourceName);
    }
    source.runtimeScriptOverrides = overrides;
    fs.writeFileSync(path.join(staging, "source-manifest.json"), JSON.stringify(source, null, 4) + "\n");
    const replaced = new Set(additions);
    await tar.c(
        {
            file: destination,
            cwd: staging,
            noMtime: true,
            gzip: true,
            strict: true,
            sync: true,
            filter: (name, entry) => !("type" in entry && replaced.has(name.replace(/^\.\//, ""))),
            onWriteEntry: (entry) => {
                if (entry.stat && replaced.has(entry.path.replace(/^\.\//, ""))) {
                    entry.stat.mode = 0o644;
                    entry.portable = true;
                }
            }
        },
        [`@${input}`, ...additions]
    );
}

// Publish the manifest last. A failed rename rolls every published file back to its previous bytes.
function publishFiles(staging, root, files, rename = fs.renameSync) {
    const published = [];
    const backups = new Map();
    try {
        for (const name of files) {
            const target = path.join(root, name);
            const backup = path.join(staging, "backups", name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (fs.existsSync(target)) {
                fs.mkdirSync(path.dirname(backup), { recursive: true });
                fs.copyFileSync(target, backup);
                backups.set(name, backup);
            }
            rename(path.join(staging, name), target);
            published.push(name);
        }
    } catch (error) {
        for (const name of published.reverse()) {
            if (backups.has(name)) fs.copyFileSync(backups.get(name), path.join(root, name));
            else fs.rmSync(path.join(root, name), { force: true });
        }
        throw error;
    }
}

async function packageRuntime(input, root = ROOT, options = {}) {
    assert.ok(input, "Usage: npm run openocd:package -- --input <build-output>");
    input = path.resolve(input);
    const identity = buildIdentity(root);
    const sourceInput = path.join(input, path.basename(SOURCE_FILE));
    await verifySources(sourceInput, identity);
    const manifest = readJson(path.join(root, "resources/openocd-targets-manifest.json"));
    const previousOverrides = new Map((manifest.scriptOverrides || []).map((item) => [item.path, item.sha256]));
    if (options.scriptOverrides) manifest.scriptOverrides = options.scriptOverrides;
    const staging = fs.mkdtempSync(path.join(root, ".openocd-package-"));
    try {
        manifest.schemaVersion = 2;
        manifest.build = {
            distribution: DISTRIBUTION,
            buildId: sha256(JSON.stringify(identity)),
            identity
        };
        manifest.archives = [];
        fs.mkdirSync(path.join(staging, "resources"), { recursive: true });
        fs.mkdirSync(path.join(staging, "native/openocd"), { recursive: true });
        const stagedSource = path.join(staging, SOURCE_FILE);
        if (manifest.scriptOverrides?.length)
            await stageScriptSources(sourceInput, stagedSource, manifest.scriptOverrides, root, staging);
        else fs.copyFileSync(sourceInput, stagedSource);
        manifest.source = { file: SOURCE_FILE, sha256: sha256(fs.readFileSync(stagedSource)) };
        for (const name of ["build-lock.json", "build.sh", "prepare-build.js", ...PATCHES])
            fs.copyFileSync(path.join(root, "native/openocd", name), path.join(staging, "native/openocd", name));
        for (const platform of PLATFORMS) {
            const raw = path.join(input, `${platform}.tar.gz`);
            const inventory = await inspectArchive(raw);
            checkBuild(await archiveJson(raw, "BUILD-INFO.json"), identity, platform);
            const binary = platform === "win32-x64" ? "bin/openocd.exe" : "bin/openocd";
            const requiredFiles = [
                binary,
                "distro-info/licenses/openocd-0.12.0/COPYING",
                ...(platform === "win32-x64"
                    ? ["bin/libusb-1.0.dll", "bin/libftdi1.dll"]
                    : [
                          "libexec/libusb-1.0.so.0",
                          "libexec/libftdi1.so.2",
                          "libexec/libhidapi-hidraw.so.0",
                          "libexec/libudev.so.1",
                          "distro-info/licenses/libudev-241/LICENSE.LGPL2.1",
                          "distro-info/licenses/libudev-241/SOURCE.txt"
                      ])
            ];
            const entries = new Map(inventory.map((entry) => [entry.path, entry]));
            for (const name of requiredFiles) assert.ok(entries.has(name), `Missing runtime dependency: ${name}`);
            const archive = {
                platform,
                file: `openocd-${platform}.tar.gz`,
                prefix: "",
                scriptsRoot: "openocd/scripts",
                binary,
                binarySha256: entries.get(binary).sha256,
                originalPayloadSha256: "",
                requiredFiles,
                sha256: ""
            };
            archive.originalPayloadSha256 = originalPayloadDigest(inventory, archive, scriptAdditions(manifest));
            const additions = [];
            for (const target of scriptAdditions(manifest)) {
                const name = `${archive.scriptsRoot}/${target.path}`;
                assert.ok(
                    target.baseSha256
                        ? entries.has(name) &&
                              [target.baseSha256, target.sha256, previousOverrides.get(target.path)].includes(
                                  entries.get(name).sha256
                              )
                        : !entries.has(name) || entries.get(name).sha256 === target.sha256,
                    `Target collision: ${name}`
                );
                const bytes = fs.readFileSync(path.join(root, "resources/openocd-targets", target.path));
                assert.strictEqual(sha256(bytes), target.sha256, `Review changed target: ${target.path}`);
                const dest = path.join(staging, "additions", platform, name);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, bytes);
                additions.push(name);
            }
            const provenanceName = "distro-info/emberprobe-targets.json";
            const provenance = {
                upstream: manifest.upstream,
                build: manifest.build,
                source: manifest.source,
                binarySha256: archive.binarySha256,
                originalPayloadSha256: archive.originalPayloadSha256,
                targets: manifest.targets,
                ...(manifest.targetHelpers ? { targetHelpers: manifest.targetHelpers } : {}),
                ...(manifest.flashLoaders ? { flashLoaders: manifest.flashLoaders } : {}),
                ...(manifest.scriptOverrides ? { scriptOverrides: manifest.scriptOverrides } : {})
            };
            fs.mkdirSync(path.join(staging, "additions", platform, "distro-info"), { recursive: true });
            fs.writeFileSync(
                path.join(staging, "additions", platform, provenanceName),
                JSON.stringify(provenance, null, 4) + "\n"
            );
            additions.push(provenanceName);
            const replaced = new Set(additions);
            const file = path.join(staging, "resources", archive.file);
            await tar.c(
                {
                    file,
                    cwd: path.join(staging, "additions", platform),
                    noMtime: true,
                    gzip: true,
                    strict: true,
                    sync: true,
                    filter: (name, entry) => !("type" in entry && replaced.has(name.replace(/^\.\//, ""))),
                    onWriteEntry: (entry) => {
                        if (entry.stat && replaced.has(entry.path.replace(/^\.\//, ""))) {
                            entry.stat.mode = 0o644;
                            entry.portable = true;
                        }
                    }
                },
                [`@${raw}`, ...additions]
            );
            archive.sha256 = sha256(fs.readFileSync(file));
            manifest.archives.push(archive);
        }
        fs.writeFileSync(
            path.join(staging, "resources/openocd-targets-manifest.json"),
            JSON.stringify(manifest, null, 4) + "\n"
        );
        await verifyBundle(staging);
        publishFiles(staging, root, [
            ...manifest.archives.map((archive) => `resources/${archive.file}`),
            SOURCE_FILE,
            "resources/openocd-targets-manifest.json"
        ]);
        console.log(`Packaged both OpenOCD runtimes and corresponding sources (${manifest.build.buildId})`);
        return manifest;
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

async function packageScriptUpdate(paths, root = ROOT) {
    const current = await verifyBundle(root);
    const source = path.join(root, SOURCE_FILE);
    const entries = new Map((await inspectArchive(source)).map((entry) => [entry.path, entry]));
    const overrides = new Map((current.scriptOverrides || []).map((item) => [item.path, item]));
    for (const value of paths) {
        const name = safePath(value);
        assert.ok(/^target\/[^\s]+\.cfg$/.test(name), "Only target Tcl scripts can override a compiled build");
        const base = entries.get(`openocd/tcl/${name}`);
        assert.ok(base, `Compiled build has no source for ${name}`);
        overrides.set(name, {
            path: name,
            baseSha256: base.sha256,
            sha256: sha256(fs.readFileSync(path.join(root, "resources/openocd-targets", name)))
        });
    }
    const input = fs.mkdtempSync(path.join(root, ".openocd-script-update-"));
    try {
        fs.copyFileSync(source, path.join(input, path.basename(SOURCE_FILE)));
        for (const archive of current.archives)
            fs.copyFileSync(path.join(root, "resources", archive.file), path.join(input, `${archive.platform}.tar.gz`));
        return await packageRuntime(input, root, { scriptOverrides: [...overrides.values()] });
    } finally {
        fs.rmSync(input, { recursive: true, force: true });
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const input = args.length === 2 && args[0] === "--input" ? args[1] : "";
    const packaging =
        args[0] === "--scripts" && args.length > 1 ? packageScriptUpdate(args.slice(1)) : packageRuntime(input);
    packaging.catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { packageRuntime, packageScriptUpdate, publishFiles };
