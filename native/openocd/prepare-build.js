"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { createHash } = require("crypto");
const repo = path.resolve(__dirname, "../..");
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "build-lock.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (command, args, cwd) =>
    execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

function prepare(assets, cache) {
    const integrity = lock.helperIntegrity.split("-")[1];
    const digest = Buffer.from(integrity, "base64").toString("hex");
    const cachedHelper = path.join(
        cache,
        "xpacks-cache/content-v2/sha512",
        digest.slice(0, 2),
        digest.slice(2, 4),
        digest.slice(4)
    );
    const helperBytes = fs.readFileSync(cachedHelper);
    assert.strictEqual(createHash("sha512").update(helperBytes).digest("base64"), integrity);
    const helperSource = path.join(cache, "downloads/xbb-helper-4.2.0.tar.gz");
    fs.writeFileSync(helperSource, helperBytes);
    // Rehydrate fixed upstream scripts before applying our sole Wine-test change.
    // This also prevents previous development builds modifying the shared xpm store.
    const restored = fs.mkdtempSync(path.join(cache, "helper-source-"));
    try {
        run("tar", ["-xzf", helperSource, "-C", restored, "--strip-components=1"], repo);
        const helperRoot = path.join(assets, "xpacks/@xpack-dev-tools/xbb-helper");
        const scripts = path.join(helperRoot, "build-scripts");
        for (const name of run("find", [scripts, "-type", "f"], repo).split("\n").filter(Boolean))
            fs.chmodSync(name, 0o644);
        fs.cpSync(path.join(restored, "build-scripts"), scripts, { recursive: true });
    } finally {
        fs.rmSync(restored, { recursive: true, force: true });
    }
    for (const [name, version] of Object.entries(lock.systemPackages))
        assert.strictEqual(run("dpkg-query", ["-W", "-f=${Version}", name], assets), version);
    assert.strictEqual(run("git", ["rev-parse", "HEAD"], path.dirname(assets)), lock.xpackRevision);
    const file = path.join(assets, "scripts/dependencies/openocd.sh");
    let recipe = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const submodules = Object.entries(lock.submodules)
        .map(([name, revision]) => `      git -C "${name}" checkout --detach ${revision}`)
        .join("\n");
    recipe = recipe.replace(
        "      run_verbose git submodule update --init --recursive --remote",
        "      run_verbose git submodule update --init --recursive\n" + submodules
    );
    assert.ok(!recipe.includes("--remote"), "Floating submodules are forbidden");
    const anchor = "      openocd_download\n";
    assert.ok(recipe.includes(anchor));
    if (!recipe.includes("# EmberProbe locked scatter hook"))
        recipe = recipe.replace(
            anchor,
            anchor +
                `
      # EmberProbe locked scatter hook
      test "$(git -C "\${XBB_SOURCES_FOLDER_PATH}/\${openocd_src_folder_name}" rev-parse HEAD)" = ${lock.openocdRevision}
      if ! grep -q 'int mem_ap_read_scatter(' "\${XBB_SOURCES_FOLDER_PATH}/\${openocd_src_folder_name}/src/target/arm_adi_v5.c"; then
        (cd "\${XBB_SOURCES_FOLDER_PATH}/\${openocd_src_folder_name}";
          git apply --check "\${XBB_BUILD_ROOT_PATH}/patches/emberprobe-scatter.git.patch"
          git apply "\${XBB_BUILD_ROOT_PATH}/patches/emberprobe-scatter.git.patch")
      fi
      # EmberProbe locked STM32C5 hook: stldr driver, stm32c5x.cfg, bundled loaders
      if [ ! -e "\${XBB_SOURCES_FOLDER_PATH}/\${openocd_src_folder_name}/src/flash/nor/stldr.c" ]; then
        (cd "\${XBB_SOURCES_FOLDER_PATH}/\${openocd_src_folder_name}";
          for patch in stldr stm32c5x c5-loaders; do
            git apply --check "\${XBB_BUILD_ROOT_PATH}/patches/emberprobe-\${patch}.git.patch"
            git apply "\${XBB_BUILD_ROOT_PATH}/patches/emberprobe-\${patch}.git.patch"
          done
          # New files must be tracked so the corresponding-source export (git ls-files) includes them.
          git add --intent-to-add src/flash/nor/stldr.c tcl/target/stm32c5x.cfg)
      fi
`
        );
    recipe = recipe.replace(
        '  tests_add "openocd_test" "${XBB_EXECUTABLES_INSTALL_FOLDER_PATH}/bin"',
        "  : # Native smoke tests run in CI"
    );
    fs.writeFileSync(file, recipe);
    const pkgPath = path.join(assets, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    for (const [name, version] of Object.entries(lock.toolchains)) {
        const installed = path.join(cache, "xpacks-store/@xpack-dev-tools", name, version, "package.json");
        assert.strictEqual(JSON.parse(fs.readFileSync(installed, "utf8")).version, version);
    }
    if (!pkg.xpack.properties.commandBashBuild.includes("--disable-tests"))
        pkg.xpack.properties.commandBashBuild += " --disable-tests";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    const helper = path.join(assets, "xpacks/@xpack-dev-tools/xbb-helper/build-scripts/build-common.sh");
    fs.chmodSync(helper, 0o644);
    fs.writeFileSync(
        helper,
        fs.readFileSync(helper, "utf8").replace("  tests_prime_wine\n", "  : # No Wine in release builds\n")
    );
    for (const [name, item] of Object.entries(lock.downloads)) {
        const file = path.join(cache, "downloads", name);
        if (fs.existsSync(file))
            assert.strictEqual(sha256(fs.readFileSync(file)), item.sha256, `Changed download: ${name}`);
    }
}

function finish(assets, cache, output) {
    const { buildIdentity } = require("../../scripts/openocd-bundle");
    const identity = buildIdentity(repo);
    const buildId = sha256(JSON.stringify(identity));
    for (const platform of ["win32-x64", "linux-x64"]) {
        const source = path.join(assets, "build", platform, "sources/openocd.git");
        assert.strictEqual(run("git", ["rev-parse", "HEAD"], source), lock.openocdRevision);
        for (const [name, revision] of Object.entries(lock.submodules))
            assert.strictEqual(run("git", ["rev-parse", "HEAD"], path.join(source, name)), revision);
        const application = path.join(assets, "build", platform, "application");
        if (platform === "linux-x64") {
            const licenses = path.join(application, "distro-info/licenses/libudev-241");
            fs.mkdirSync(licenses, { recursive: true });
            fs.writeFileSync(
                path.join(licenses, "LICENSE.LGPL2.1"),
                run(
                    "tar",
                    ["-xOf", path.join(cache, "downloads/systemd_241.orig.tar.gz"), "systemd-241/LICENSE.LGPL2.1"],
                    repo
                ) + "\n"
            );
            fs.writeFileSync(
                path.join(licenses, "SOURCE.txt"),
                "libudev from Debian systemd 241-7~deb10u10 (LGPL-2.1-or-later).\n" +
                    "Matching upstream tar, Debian patches and .dsc are included in emberprobe-openocd-source.tar.gz downloads/.\n"
            );
        }
        fs.writeFileSync(
            path.join(application, "BUILD-INFO.json"),
            JSON.stringify({ platform, buildId, identity }, null, 4) + "\n"
        );
        run(
            "tar",
            [
                "--sort=name",
                "--mtime=@0",
                "--owner=0",
                "--group=0",
                "--numeric-owner",
                "-czf",
                path.join(output, `${platform}.tar.gz`),
                "-C",
                application,
                "."
            ],
            repo
        );
    }
    const staging = path.join(cache, "corresponding-source-" + buildId.slice(0, 16));
    fs.mkdirSync(staging, { recursive: true });
    const source = path.join(assets, "build/linux-x64/sources/openocd.git");
    // Export actual tracked source bytes (including xPack/patch edits), not generated
    // host executables, absolute autotools links, or Git object databases.
    for (const name of run("git", ["ls-files", "--recurse-submodules", "-z"], source).split("\0").filter(Boolean)) {
        const from = path.join(source, name);
        const to = path.join(staging, "openocd", name);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, { preserveTimestamps: true, verbatimSymlinks: true });
    }
    fs.mkdirSync(path.join(staging, "recipes"), { recursive: true });
    const { PATCHES } = require("../../scripts/openocd-bundle");
    for (const name of ["build.sh", "prepare-build.js", "build-lock.json", ...PATCHES])
        fs.copyFileSync(path.join(__dirname, name), path.join(staging, "recipes", name));
    fs.cpSync(path.join(assets, "scripts"), path.join(staging, "recipes/xpack/scripts"), { recursive: true });
    fs.copyFileSync(path.join(assets, "package.json"), path.join(staging, "recipes/xpack/package.json"));
    fs.copyFileSync(path.join(assets, "package-lock.json"), path.join(staging, "recipes/xpack/package-lock.json"));
    fs.cpSync(
        path.join(assets, "xpacks/@xpack-dev-tools/xbb-helper/build-scripts"),
        path.join(staging, "recipes/xbb-helper"),
        { recursive: true }
    );
    fs.mkdirSync(path.join(staging, "downloads"), { recursive: true });
    fs.mkdirSync(path.join(staging, "packaging/scripts"), { recursive: true });
    for (const name of ["openocd-bundle.js", "package-openocd-targets.js"])
        fs.copyFileSync(path.join(repo, "scripts", name), path.join(staging, "packaging/scripts", name));
    for (const name of ["package.json", "package-lock.json"])
        fs.copyFileSync(path.join(repo, name), path.join(staging, "packaging", name));
    for (const [name, item] of Object.entries(lock.downloads)) {
        const bytes = fs.readFileSync(path.join(cache, "downloads", name));
        assert.strictEqual(sha256(bytes), item.sha256, `Changed source download: ${name}`);
        fs.writeFileSync(path.join(staging, "downloads", name), bytes);
    }
    const files = {};
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.isFile() && entry.name !== "source-manifest.json")
                files[path.relative(staging, file).split(path.sep).join("/")] = sha256(fs.readFileSync(file));
        }
    }
    walk(staging);
    fs.writeFileSync(path.join(staging, "source-manifest.json"), JSON.stringify({ identity, files }, null, 4) + "\n");
    run(
        "tar",
        [
            "--sort=name",
            "--mtime=@0",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            "-czf",
            path.join(output, "emberprobe-openocd-source.tar.gz"),
            "-C",
            staging,
            "."
        ],
        repo
    );
}
if (require.main === module) {
    const [action, assets, cache, output] = process.argv.slice(2);
    if (action === "prepare") prepare(assets, cache);
    else if (action === "finish") finish(assets, cache, output);
    else throw new Error("Expected prepare or finish");
}
module.exports = { prepare, finish };
