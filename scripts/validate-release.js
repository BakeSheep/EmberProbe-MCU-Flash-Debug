"use strict";
const fs = require("fs");
const path = require("path");

const STABLE_TAG_RE = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

function releaseError(code, message, details) {
    return Object.assign(new Error(message), { code, details });
}

function validateRelease(root, value) {
    const tag = String(value || "").trim();
    const match = STABLE_TAG_RE.exec(tag);
    if (!match) {
        throw releaseError(
            "INVALID_RELEASE_TAG",
            `Expected a stable release tag like v1.2.3, received ${tag || "(empty)"}`
        );
    }

    const version = match[1];
    const readText = (file) => fs.readFileSync(path.join(root, file), "utf8");
    const readJson = (file) => JSON.parse(readText(file));
    const pkg = readJson("package.json");

    if (pkg.version !== version) {
        throw releaseError(
            "RELEASE_VERSION_MISMATCH",
            `Tag ${tag} does not match package.json version ${pkg.version}`,
            { tag, packageVersion: pkg.version }
        );
    }

    const lock = readJson("package-lock.json");
    const mismatches = [];
    if (lock.version !== version) mismatches.push("package-lock.json version");
    if (lock.packages?.[""]?.version !== version) mismatches.push("package-lock.json root package version");
    if (!readText("README.md").includes(`当前扩展版本为 \`${version}\``)) mismatches.push("README.md version");
    if (!readText("README_EN.md").includes(`current extension version is \`${version}\``)) {
        mismatches.push("README_EN.md version");
    }

    const escapedVersion = version.replace(/\./g, "\\.");
    const releaseHeading = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu");
    if (!releaseHeading.test(readText("CHANGELOG.md"))) mismatches.push("CHANGELOG.md release heading");

    if (mismatches.length) {
        throw releaseError(
            "RELEASE_METADATA_MISMATCH",
            `Release metadata for ${version} is inconsistent: ${mismatches.join(", ")}`,
            { version, mismatches }
        );
    }

    return { tag, version };
}

if (require.main === module) {
    try {
        const result = validateRelease(path.resolve(__dirname, ".."), process.argv[2] || process.env.GITHUB_REF_NAME);
        console.log(`Validated release ${result.tag} for version ${result.version}`);
    } catch (error) {
        console.error(`${error.code || "RELEASE_VALIDATION_ERROR"}: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { validateRelease };
