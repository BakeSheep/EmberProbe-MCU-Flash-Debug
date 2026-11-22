"use strict";
const fs = require("fs");
const { execFileSync } = require("child_process");
const { parseReleaseTag } = require("./validate-release");

const DEFAULT_VSIX_PATH = "dist/emberprobe.vsix";
const VSCE_PACKAGE = "@vscode/vsce@4.1.1";
const OVSX_PACKAGE = "ovsx@1.4.0";

const STORE_TARGETS = Object.freeze({
    marketplace: Object.freeze({
        pkg: VSCE_PACKAGE,
        authFlag: "--oidc"
    }),
    openvsx: Object.freeze({
        pkg: OVSX_PACKAGE,
        authFlag: "--trusted-publishing"
    })
});

function storeError(code, message) {
    return Object.assign(new Error(message), { code });
}

function buildStoreCommand(target, vsixPath = DEFAULT_VSIX_PATH, platform = process.platform) {
    const spec = STORE_TARGETS[target];
    if (!spec) {
        throw storeError("INVALID_STORE_TARGET", `Expected marketplace or openvsx, received ${target || "(empty)"}`);
    }
    const command = platform === "win32" ? "npx.cmd" : "npx";
    const args = ["--yes", spec.pkg, "publish", spec.authFlag, "--skip-duplicate", "--packagePath", vsixPath];
    return { command, args };
}

function buildChildEnv(baseEnv = process.env) {
    const env = { ...baseEnv };
    delete env.VSCE_PAT;
    delete env.OVSX_PAT;
    return env;
}

function assertVsixReady(vsixPath) {
    let stat;
    try {
        stat = fs.statSync(vsixPath);
    } catch {
        throw storeError("MISSING_VSIX", `Verified VSIX package not found: ${vsixPath}`);
    }
    if (!stat.isFile() || stat.size <= 0) {
        throw storeError("MISSING_VSIX", `Verified VSIX package is empty or not a regular file: ${vsixPath}`);
    }
}

function publishStore(
    target,
    tag,
    run = (command, args, execOptions) => execFileSync(command, args, { stdio: "inherit", env: execOptions.env }),
    options = {}
) {
    if (!STORE_TARGETS[target]) {
        throw storeError("INVALID_STORE_TARGET", `Expected marketplace or openvsx, received ${target || "(empty)"}`);
    }
    const { version, prerelease } = parseReleaseTag(tag);
    if (options.rebuild === true) {
        return { target, published: false, reason: "rebuild" };
    }
    if (prerelease) {
        return { target, published: false, reason: "prerelease" };
    }
    const vsixPath = options.vsixPath || DEFAULT_VSIX_PATH;
    const checkVsix = options.assertVsix || assertVsixReady;
    checkVsix(vsixPath);
    const { command, args } = buildStoreCommand(target, vsixPath, options.platform);
    run(command, args, { env: buildChildEnv(options.env) });
    return { target, published: true, version, vsixPath };
}

if (require.main === module) {
    try {
        const target = process.argv[2] || process.env.STORE_TARGET;
        const tag = process.argv[3] || process.env.RELEASE_TAG;
        console.log(
            publishStore(target, tag, undefined, {
                rebuild: process.env.REBUILD_RELEASE === "true",
                vsixPath: process.env.VSIX_PATH || DEFAULT_VSIX_PATH
            })
        );
    } catch (error) {
        console.error(error.stderr?.toString() || error.message || error);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_VSIX_PATH,
    VSCE_PACKAGE,
    OVSX_PACKAGE,
    STORE_TARGETS,
    buildStoreCommand,
    buildChildEnv,
    assertVsixReady,
    publishStore
};
