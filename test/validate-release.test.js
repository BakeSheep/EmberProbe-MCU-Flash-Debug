"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { validateRelease } = require("../scripts/validate-release");

function writeFixture(root, version = "1.2.3") {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }, null, 2) + "\n");
    fs.writeFileSync(
        path.join(root, "package-lock.json"),
        JSON.stringify({ version, packages: { "": { version } } }, null, 2) + "\n"
    );
    fs.writeFileSync(path.join(root, "README.md"), `当前扩展版本为 \`${version}\`。\n`);
    fs.writeFileSync(path.join(root, "README_EN.md"), `The current extension version is \`${version}\`.\n`);
    fs.writeFileSync(
        path.join(root, "CHANGELOG.md"),
        `# Change Log\n\n## [Unreleased]\n\n## [${version}] - 2026-07-31\n\n### Added\n\n- release\n`
    );
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-validate-release-"));
try {
    writeFixture(temp);
    assert.deepStrictEqual(validateRelease(temp, "v1.2.3"), {
        tag: "v1.2.3",
        version: "1.2.3",
        prerelease: false
    });

    for (const tag of ["1.2.3", "v1.2", "v1.2.3-beta", "v1.2.3-beta.0", "v1.2.3-preview.1", "v1.2.3+build.1"]) {
        assert.throws(
            () => validateRelease(temp, tag),
            (error) => error.code === "INVALID_RELEASE_TAG",
            tag
        );
    }
    assert.throws(
        () => validateRelease(temp, "v1.2.3-beta.1"),
        (error) => error.code === "RELEASE_VERSION_MISMATCH"
    );
    for (const version of ["1.2.3-alpha.1", "1.2.3-beta.2", "1.2.3-rc.10"]) {
        writeFixture(temp, version);
        assert.deepStrictEqual(validateRelease(temp, `v${version}`), {
            tag: `v${version}`,
            version,
            prerelease: true
        });
    }
    writeFixture(temp);
    assert.throws(
        () => validateRelease(temp, "v1.2.4"),
        (error) => error.code === "RELEASE_VERSION_MISMATCH"
    );

    const lock = JSON.parse(fs.readFileSync(path.join(temp, "package-lock.json"), "utf8"));
    lock.packages[""].version = "1.2.2";
    fs.writeFileSync(path.join(temp, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    assert.throws(
        () => validateRelease(temp, "v1.2.3"),
        (error) => error.code === "RELEASE_METADATA_MISMATCH"
    );

    console.log("Release validation tests passed");
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
