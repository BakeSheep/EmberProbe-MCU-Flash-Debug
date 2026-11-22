"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("yaml");
const { publishRelease } = require("../scripts/publish-release");
const {
    DEFAULT_VSIX_PATH,
    VSCE_PACKAGE,
    OVSX_PACKAGE,
    buildStoreCommand,
    buildChildEnv,
    publishStore
} = require("../scripts/publish-store");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
const read = (name) => yaml.parse(fs.readFileSync(path.join(__dirname, "../.github/workflows", name + ".yml"), "utf8"));
const ci = read("ci"),
    release = read("release"),
    hil = read("hil");
assert.deepStrictEqual(ci.on.push.branches, ["master"]);
assert.ok(Object.hasOwn(ci.on, "pull_request") && Object.hasOwn(ci.on, "workflow_call"));
assert.deepStrictEqual(ci.jobs.check.strategy.matrix.os, ["windows-latest", "ubuntu-latest", "macos-latest"]);
assert.strictEqual(ci.jobs.check.name, "Node ${{ matrix.os }}");
assert.strictEqual(ci.jobs.check.steps.filter((s) => s.run === "npm run check").length, 1);
assert.ok(!ci.jobs.check.steps.some((s) => s.run === "npm run quality"));
assert.ok(ci.jobs.quality.steps.some((s) => s.run === "npm run quality"));
assert.ok(ci.jobs["driver-helper"].steps.some((s) => s.run === "./scripts/build-driver-helper.ps1"));
for (const job of Object.values(ci.jobs)) {
    assert.ok(job["timeout-minutes"] <= 20);
    assert.ok(job.steps.some((s) => s.if === "failure()" && s.with?.["retention-days"] === 14));
}
assert.deepStrictEqual(release.on.push.tags, ["v*.*.*"], "tag trigger must cover stable and prerelease tags");
assert.strictEqual(release.jobs.gates.uses, "./.github/workflows/ci.yml");
assert.deepStrictEqual(release.jobs.build.needs, ["gates", "driver-helper"]);
assert.ok(release.jobs["driver-helper"].steps.some((s) => s.run === "node scripts/verify-driver-helper.js"));
assert.ok(!release.jobs["driver-helper"].steps.some((s) => /sign-driver-helper\.ps1/.test(s.run || "")));
assert.ok(release.jobs.build.steps.some((s) => s.run === "node scripts/verify-driver-helper.js"));
assert.ok(release.jobs.build.steps.some((s) => s.run === "node scripts/verify-driver-helper.js dist/emberprobe.vsix"));
assert.ok(release.jobs.build.steps.some((s) => s.run === "node scripts/verify-openocd-vsix.js dist/emberprobe.vsix"));
assert.ok(ci.jobs.check.steps.some((s) => s.run === "npm run check:openocd-bundle"));
assert.ok(
    release.jobs.build.steps.some(
        (s) => s.with?.name === "emberprobe-openocd-source" && s.uses === "actions/upload-artifact@v7"
    )
);
assert.ok(
    release.jobs.publish.steps.some(
        (s) => s.with?.name === "emberprobe-openocd-source" && s.uses === "actions/download-artifact@v8"
    )
);
assert.strictEqual(release.jobs.publish.needs, "build");
assert.strictEqual(release.permissions.contents, "read");
assert.strictEqual(release.jobs.publish.permissions.contents, "write");
assert.ok(!release.jobs.publish.permissions["id-token"]);
assert.strictEqual(release.on.workflow_dispatch.inputs.rebuild.type, "boolean");
assert.strictEqual(release.on.workflow_dispatch.inputs.rebuild.default, false);
const releaseSource = "${{ inputs.rebuild && github.sha || inputs.tag || github.ref }}";
assert.strictEqual(release.jobs.gates.with.ref, releaseSource);
for (const name of ["build", "driver-helper", "publish", "publish-marketplace", "publish-openvsx"]) {
    assert.strictEqual(
        release.jobs[name].steps.find((step) => step.uses === "actions/checkout@v7").with.ref,
        releaseSource
    );
}
assert.strictEqual(release.jobs.publish.env.REPLACE_RELEASE_ASSET, "${{ inputs.rebuild && 'true' || 'false' }}");
for (const [jobName, target] of [
    ["publish-marketplace", "marketplace"],
    ["publish-openvsx", "openvsx"]
]) {
    const job = release.jobs[jobName];
    assert.ok(job, `missing ${jobName} job`);
    assert.ok(job["timeout-minutes"] <= 15);
    assert.deepStrictEqual(job.needs, ["build", "publish"]);
    assert.strictEqual(job.if, "${{ !inputs.rebuild && !contains(inputs.tag || github.ref_name, '-') }}");
    assert.strictEqual(job.environment, "release");
    assert.deepStrictEqual(job.permissions, { contents: "read", "id-token": "write" });
    assert.strictEqual(job.env.RELEASE_TAG, "${{ inputs.tag || github.ref_name }}");
    assert.strictEqual(job.env.REBUILD_RELEASE, "${{ inputs.rebuild && 'true' || 'false' }}");
    assert.ok(
        job.steps.some(
            (step) =>
                step.uses === "actions/download-artifact@v8" &&
                step.with?.name === "emberprobe-vsix" &&
                step.with?.path === "dist"
        )
    );
    assert.ok(job.steps.some((step) => step.run === `node scripts/publish-store.js ${target}`));
}
assert.ok(
    pkg.scripts.package.includes(VSCE_PACKAGE),
    `package script and publish-store.js must pin the same vsce version (${VSCE_PACKAGE})`
);
const buildScript = fs.readFileSync(path.join(__dirname, "../scripts/build-driver-helper.ps1"), "utf8");
assert.match(buildScript, /manifest\.json/);
assert.match(buildScript, /Get-FileHash -LiteralPath \$file -Algorithm SHA256/);
assert.strictEqual(release.concurrency["cancel-in-progress"], false);
assert.strictEqual(hil.jobs["flash-verify"].if, "vars.HIL_ENABLED == 'true'");
assert.ok(!Object.hasOwn(hil.on, "pull_request") && !Object.hasOwn(hil.on, "push"));
assert.strictEqual(hil.jobs["flash-verify"].strategy["max-parallel"], 1);
for (const state of ["missing", "draft", "public"]) {
    const calls = [];
    const result = publishRelease("v1.2.3", (args) => {
        calls.push(args);
        if (args[1] === "view") {
            if (state === "missing") throw new Error("release not found");
            return JSON.stringify({ isDraft: state === "draft" });
        }
        return "";
    });
    assert.strictEqual(result.published, state !== "public");
    if (state === "public") assert.strictEqual(calls.length, 1);
    else {
        assert.deepStrictEqual(
            calls.slice(-2).map((args) => args[1]),
            ["upload", "edit"]
        );
        assert.ok(calls[calls.length - 1].includes("--draft=false"));
        assert.ok(
            calls.find((args) => args[1] === "upload").includes("native/openocd/emberprobe-openocd-source.tar.gz")
        );
    }
}
for (const replaceAsset of [true, false, "true"]) {
    const calls = [];
    const result = publishRelease(
        "v1.2.3",
        (args) => {
            calls.push(args);
            return args[1] === "view" ? '{"isDraft":false}' : "";
        },
        { replaceAsset }
    );
    assert.strictEqual(result.published, replaceAsset === true);
    assert.strictEqual(calls.length, replaceAsset === true ? 2 : 1);
    if (replaceAsset === true)
        assert.deepStrictEqual(calls[1], [
            "release",
            "upload",
            "v1.2.3",
            "dist/emberprobe.vsix",
            "native/openocd/emberprobe-openocd-source.tar.gz",
            "--clobber"
        ]);
}
assert.throws(
    () =>
        publishRelease(
            "v1.2.3",
            (args) => {
                if (args[1] === "view") return '{"isDraft":false}';
                throw new Error("replacement upload failed");
            },
            { replaceAsset: true }
        ),
    /replacement upload failed/
);
const failed = [];
assert.throws(
    () =>
        publishRelease("v1.2.3", (args) => {
            failed.push(args);
            if (args[1] === "view") return '{"isDraft":true}';
            if (args[1] === "upload") throw new Error("upload failed");
            return "";
        }),
    /upload failed/
);
assert.ok(!failed.some((args) => args.includes("--draft=false")));
assert.throws(
    () =>
        publishRelease("v1.2.3", () => {
            throw new Error("HTTP 403");
        }),
    /403/
);
for (const [tag, prerelease] of [
    ["v1.2.3", false],
    ["v1.2.3-rc.1", true]
]) {
    for (const state of ["missing", "draft"]) {
        const calls = [];
        publishRelease(tag, (args) => {
            calls.push(args);
            if (args[1] === "view") {
                if (state === "missing") throw new Error("release not found");
                return '{"isDraft":true}';
            }
            return "";
        });
        const prepare = calls.find((args) => args[1] === (state === "missing" ? "create" : "edit"));
        assert.strictEqual(prepare.includes("--prerelease"), prerelease, `${tag} ${state}`);
    }
}
assert.throws(
    () => publishRelease("main"),
    (error) => error.code === "INVALID_RELEASE_TAG"
);
assert.throws(
    () => publishRelease("v1.2.3-nightly.1"),
    (error) => error.code === "INVALID_RELEASE_TAG"
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-store-"));
try {
    const validVsix = path.join(tempDir, "emberprobe.vsix");
    const emptyVsix = path.join(tempDir, "empty.vsix");
    const missingVsix = path.join(tempDir, "missing.vsix");
    fs.writeFileSync(validVsix, "vsix-bytes");
    fs.writeFileSync(emptyVsix, "");

    for (const [target, expectedPkg, expectedFlag] of [
        ["marketplace", VSCE_PACKAGE, "--oidc"],
        ["openvsx", OVSX_PACKAGE, "--trusted-publishing"]
    ]) {
        const linuxCmd = buildStoreCommand(target, DEFAULT_VSIX_PATH, "linux");
        assert.strictEqual(linuxCmd.command, "npx");
        assert.deepStrictEqual(linuxCmd.args, [
            "--yes",
            expectedPkg,
            "publish",
            expectedFlag,
            "--skip-duplicate",
            "--packagePath",
            DEFAULT_VSIX_PATH
        ]);
        assert.strictEqual(buildStoreCommand(target, DEFAULT_VSIX_PATH, "win32").command, "npx.cmd");

        const calls = [];
        const result = publishStore(
            target,
            "v1.2.3",
            (command, args, execOptions) => {
                calls.push({ command, args, env: execOptions.env });
            },
            {
                vsixPath: validVsix,
                platform: "linux",
                env: { PATH: "/usr/bin", VSCE_PAT: "secret-a", OVSX_PAT: "secret-b" }
            }
        );
        assert.deepStrictEqual(result, { target, published: true, version: "1.2.3", vsixPath: validVsix });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].command, "npx");
        assert.deepStrictEqual(calls[0].args, [
            "--yes",
            expectedPkg,
            "publish",
            expectedFlag,
            "--skip-duplicate",
            "--packagePath",
            validVsix
        ]);
        assert.strictEqual(calls[0].env.PATH, "/usr/bin");
        assert.ok(!Object.hasOwn(calls[0].env, "VSCE_PAT"));
        assert.ok(!Object.hasOwn(calls[0].env, "OVSX_PAT"));

        for (const prereleaseTag of ["v1.2.3-alpha.1", "v1.2.3-beta.2", "v1.2.3-rc.1"]) {
            let called = false;
            const skipped = publishStore(
                target,
                prereleaseTag,
                () => {
                    called = true;
                },
                { vsixPath: missingVsix }
            );
            assert.deepStrictEqual(skipped, { target, published: false, reason: "prerelease" });
            assert.strictEqual(called, false);
        }

        let rebuildCalled = false;
        const skippedRebuild = publishStore(
            target,
            "v1.2.3",
            () => {
                rebuildCalled = true;
            },
            { rebuild: true, vsixPath: missingVsix }
        );
        assert.deepStrictEqual(skippedRebuild, { target, published: false, reason: "rebuild" });
        assert.strictEqual(rebuildCalled, false);

        let stringRebuildCalled = false;
        const stringRebuild = publishStore(
            target,
            "v1.2.3",
            () => {
                stringRebuildCalled = true;
            },
            { rebuild: "true", vsixPath: validVsix }
        );
        assert.strictEqual(stringRebuild.published, true);
        assert.strictEqual(stringRebuildCalled, true);

        for (const badPath of [missingVsix, emptyVsix]) {
            let missingCalled = false;
            assert.throws(
                () =>
                    publishStore(
                        target,
                        "v1.2.3",
                        () => {
                            missingCalled = true;
                        },
                        { vsixPath: badPath }
                    ),
                (error) => error.code === "MISSING_VSIX"
            );
            assert.strictEqual(missingCalled, false);
        }

        assert.throws(
            () =>
                publishStore(
                    target,
                    "v1.2.3",
                    () => {
                        throw new Error("oidc exchange failed");
                    },
                    { vsixPath: validVsix }
                ),
            /oidc exchange failed/
        );
    }

    const sanitized = buildChildEnv({ KEEP: "1", VSCE_PAT: "x", OVSX_PAT: "y" });
    assert.deepStrictEqual(sanitized, { KEEP: "1" });
    assert.throws(
        () => publishStore("unknown", "v1.2.3", () => {}),
        (error) => error.code === "INVALID_STORE_TARGET"
    );
    assert.throws(
        () => buildStoreCommand("unknown"),
        (error) => error.code === "INVALID_STORE_TARGET"
    );
    assert.throws(
        () => publishStore("marketplace", "main", () => {}),
        (error) => error.code === "INVALID_RELEASE_TAG"
    );
    assert.throws(
        () => publishStore("openvsx", "v1.2.3-nightly.1", () => {}),
        (error) => error.code === "INVALID_RELEASE_TAG"
    );
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("Workflow and release behavior tests passed");
