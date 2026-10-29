"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tar = require("tar");
const yazl = require("yazl");
const { pipeline } = require("stream/promises");
const {
    PLATFORMS,
    SOURCE_FILE,
    PATCHES,
    sha256,
    safePath,
    buildIdentity,
    checkBuild,
    verifyBundle,
    verifySources,
    inspectArchive
} = require("../scripts/openocd-bundle");
const { packageRuntime, publishFiles } = require("../scripts/package-openocd-runtime");
const { verifyOpenOcdVsix } = require("../scripts/verify-openocd-vsix");

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-runtime-package-"));
    const root = path.join(tmp, "repo");
    const input = path.join(tmp, "input");
    const put = (name, bytes) => {
        fs.mkdirSync(path.dirname(name), { recursive: true });
        fs.writeFileSync(name, bytes);
    };
    const json = (name, value) => put(name, JSON.stringify(value));
    const sourceDir = path.join(tmp, "sources");
    const source = path.join(input, path.basename(SOURCE_FILE));
    try {
        for (const name of ["build.sh", "prepare-build.js", ...PATCHES, "README.md"])
            put(path.join(root, "native/openocd", name), `fixture ${name}`);
        json(path.join(root, "native/openocd/build-lock.json"), {
            image: "fixture@sha256:" + "a".repeat(64),
            openocdRevision: "b".repeat(40),
            xpackRevision: "c".repeat(40),
            submodules: { jimtcl: "d".repeat(40) },
            downloads: { "dependency.tar.gz": { sha256: sha256(Buffer.from("dependency source")) } }
        });
        put(path.join(root, "THIRD_PARTY_NOTICES.md"), "fixture notices");
        const identity = buildIdentity(root);
        const buildId = sha256(JSON.stringify(identity));
        const targetBytes = "source [find target/canonical.cfg]\n";
        const targets = [
            { path: "target/wrapper.cfg", canonical: "target/canonical.cfg", sha256: sha256(Buffer.from(targetBytes)) }
        ];
        put(path.join(root, "resources/openocd-targets/target/wrapper.cfg"), targetBytes);
        const loaderBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]);
        const flashLoaders = [{ path: "flash_loaders/fixture/loader.xldr", sha256: sha256(loaderBytes) }];
        put(path.join(root, "resources/openocd-targets/flash_loaders/fixture/loader.xldr"), loaderBytes);
        json(path.join(root, "resources/openocd-targets-manifest.json"), {
            schemaVersion: 1,
            upstream: { revision: "upstream" },
            targets,
            flashLoaders,
            archives: []
        });
        for (const name of [
            "openocd/src/target/arm_adi_v5.c",
            "openocd/src/flash/nor/stldr.c",
            "openocd/tcl/target/stm32c5x.cfg",
            "openocd/jimtcl/jim.c",
            "openocd/src/jtag/drivers/libjaylink/libjaylink/core.c",
            "openocd/COPYING"
        ])
            put(path.join(sourceDir, name), "source " + name);
        for (const name of ["build.sh", "prepare-build.js", "build-lock.json", ...PATCHES])
            put(path.join(sourceDir, "recipes", name), fs.readFileSync(path.join(root, "native/openocd", name)));
        put(path.join(sourceDir, "downloads/dependency.tar.gz"), "dependency source");
        const sourceFiles = {};
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const name = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(name);
                else
                    sourceFiles[path.relative(sourceDir, name).split(path.sep).join("/")] = sha256(
                        fs.readFileSync(name)
                    );
            }
        };
        walk(sourceDir);
        json(path.join(sourceDir, "source-manifest.json"), { identity, files: sourceFiles });
        fs.mkdirSync(input, { recursive: true });
        await tar.c({ file: source, cwd: sourceDir, gzip: true }, fs.readdirSync(sourceDir));
        const rawDirs = {};
        const makeRaw = async (platform, overrides = {}) => {
            const dir = path.join(tmp, platform);
            rawDirs[platform] = dir;
            const binary = platform === "win32-x64" ? "bin/openocd.exe" : "bin/openocd";
            for (const name of [
                binary,
                "distro-info/licenses/openocd-0.12.0/COPYING",
                "openocd/scripts/target/canonical.cfg",
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
            ])
                put(path.join(dir, name), "fixture " + name);
            fs.chmodSync(path.join(dir, binary), 0o755);
            json(path.join(dir, "BUILD-INFO.json"), { platform, buildId, identity, ...overrides });
            await tar.c(
                {
                    file: path.join(input, `${platform}.tar.gz`),
                    cwd: dir,
                    gzip: true,
                    onWriteEntry: (entry) => {
                        if (entry.stat && entry.path === binary) entry.stat.mode = 0o755;
                    }
                },
                fs.readdirSync(dir)
            );
        };
        await makeRaw("win32-x64");
        await assert.rejects(packageRuntime(input, root), /ENOENT/);
        assert.strictEqual(
            JSON.parse(fs.readFileSync(path.join(root, "resources/openocd-targets-manifest.json"))).schemaVersion,
            1
        );
        await makeRaw("linux-x64", { buildId: "different build" });
        await assert.rejects(packageRuntime(input, root), /Mixed build/);
        await makeRaw("linux-x64");
        const manifest = await packageRuntime(input, root);
        assert.strictEqual(manifest.schemaVersion, 2);
        assert.deepStrictEqual(manifest.flashLoaders, flashLoaders);
        await verifyBundle(root);
        // Flash loaders are reviewed additions like target wrappers: shipped in every archive, bytes pinned.
        for (const platform of PLATFORMS) {
            const entries = await inspectArchive(path.join(root, `resources/openocd-${platform}.tar.gz`));
            const loader = entries.find((entry) => entry.path === `openocd/scripts/${flashLoaders[0].path}`);
            assert.strictEqual(loader?.sha256, flashLoaders[0].sha256, platform);
        }
        const loaderFile = path.join(root, "resources/openocd-targets", flashLoaders[0].path);
        fs.writeFileSync(loaderFile, "changed loader");
        await assert.rejects(packageRuntime(input, root), /Review changed target/);
        fs.writeFileSync(loaderFile, loaderBytes);
        const unchanged = fs.readFileSync(path.join(root, "resources/openocd-targets-manifest.json"));
        fs.rmSync(path.join(rawDirs["win32-x64"], "bin/libusb-1.0.dll"));
        await tar.c(
            { file: path.join(input, "win32-x64.tar.gz"), cwd: rawDirs["win32-x64"], gzip: true },
            fs.readdirSync(rawDirs["win32-x64"])
        );
        await assert.rejects(packageRuntime(input, root), /Missing runtime dependency/);
        assert.deepStrictEqual(fs.readFileSync(path.join(root, "resources/openocd-targets-manifest.json")), unchanged);
        for (const bad of ["../escape", "/absolute", "C:/windows", "a\\b", ""]) assert.throws(() => safePath(bad));
        assert.strictEqual(safePath("bin/openocd"), "bin/openocd");
        assert.throws(() => checkBuild({ identity: {}, buildId, platform: "linux-x64" }, identity, "linux-x64"));
        const malicious = path.join(tmp, "malicious.tar.gz");
        await tar.c({ file: malicious, cwd: sourceDir, gzip: true, prefix: "../escape" }, ["source-manifest.json"]);
        await assert.rejects(inspectArchive(malicious), /escapes/);
        // Source inventories bind contents as well as the build identity.
        put(path.join(sourceDir, "openocd/COPYING"), "tampered");
        await tar.c({ file: source, cwd: sourceDir, gzip: true }, fs.readdirSync(sourceDir));
        await assert.rejects(verifySources(source, identity), /Unlisted source/);
        // Verify bytes inside the VSIX rather than trusting repository inputs alone.
        const vsix = path.join(tmp, "test.vsix");
        const names = [
            "resources/openocd-targets-manifest.json",
            ...PLATFORMS.map((platform) => `resources/openocd-${platform}.tar.gz`),
            ...["build.sh", "prepare-build.js", "build-lock.json", ...PATCHES, "README.md"].map(
                (name) => "native/openocd/" + name
            ),
            "THIRD_PARTY_NOTICES.md"
        ];
        const zip = async (changed = "", omit = "") => {
            const archive = new yazl.ZipFile();
            for (const name of names) {
                if (name !== omit)
                    archive.addBuffer(
                        name === changed ? Buffer.from("changed") : fs.readFileSync(path.join(root, name)),
                        "extension/" + name
                    );
            }
            archive.end();
            await pipeline(archive.outputStream, fs.createWriteStream(vsix));
        };
        await zip();
        await verifyOpenOcdVsix(vsix, root);
        await zip("resources/openocd-win32-x64.tar.gz");
        await assert.rejects(verifyOpenOcdVsix(vsix, root), /VSIX bytes differ/);
        await zip("", "native/openocd/build-lock.json");
        await assert.rejects(verifyOpenOcdVsix(vsix, root), /VSIX missing/);
        const stage = path.join(tmp, "transaction");
        put(path.join(root, "one"), "old");
        put(path.join(stage, "one"), "new");
        put(path.join(stage, "two"), "second");
        assert.throws(
            () =>
                publishFiles(stage, root, ["one", "two"], (from, to) => {
                    if (to === path.join(root, "two")) throw new Error("simulated publication failure");
                    fs.renameSync(from, to);
                }),
            /publication failure/
        );
        assert.strictEqual(fs.readFileSync(path.join(root, "one"), "utf8"), "old");
        assert.ok(!fs.existsSync(path.join(root, "two")));
        console.log("OpenOCD bundle staging, identity, source, dependency, VSIX tampering and rollback tests passed");
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
