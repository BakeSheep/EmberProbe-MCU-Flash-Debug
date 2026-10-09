"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-release-"));
try {
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ version: "1.2.3" }, null, 2) + "\n");
    fs.writeFileSync(
        path.join(temp, "package-lock.json"),
        JSON.stringify(
            {
                version: "1.2.3",
                packages: { "": { version: "1.2.3" } }
            },
            null,
            2
        ) + "\n"
    );
    fs.writeFileSync(path.join(temp, "README.md"), "当前扩展版本为 `1.2.3`。\n");
    fs.writeFileSync(path.join(temp, "README_EN.md"), "The current extension version is `1.2.3`.\n");
    fs.writeFileSync(
        path.join(temp, "CHANGELOG.md"),
        "# Change Log\n\n## [Unreleased]\n\n### Fixed\n\n- pending\n\n## [1.2.3] - 2026-01-01\n"
    );

    const { validateVersion, prepareRelease, parseCli } = require("../scripts/release");
    assert.strictEqual(validateVersion("2.0.0"), "2.0.0");
    assert.strictEqual(validateVersion("2.0.0-beta.1"), "2.0.0-beta.1");
    assert.throws(
        () => validateVersion("v2"),
        (error) => error.code === "INVALID_VERSION"
    );

    fs.mkdirSync(path.join(temp, "docs"));
    const audit = path.join(temp, "docs", "WAVEFORM-AUDIT.md");
    fs.writeFileSync(audit, "# audit\n");
    assert.strictEqual(parseCli(["1.3.0", "--no-clean-docs"]).cleanDocs, false);
    const dryRun = prepareRelease(temp, "1.3.0", { date: "2026-07-30", dryRun: true });
    assert.deepStrictEqual(dryRun.docsRemoved, ["WAVEFORM-AUDIT.md"]);
    assert.ok(fs.existsSync(audit), "dry run keeps docs");
    assert.deepStrictEqual(
        prepareRelease(temp, "1.3.0", { date: "2026-07-30", dryRun: true, cleanDocs: false }).docsRemoved,
        []
    );
    assert.ok(dryRun.changed.includes("package.json"));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp, "package.json"), "utf8")).version, "1.2.3");

    const result = prepareRelease(temp, "1.3.0", { date: "2026-07-30" });
    assert.ok(!fs.existsSync(audit), "release preparation cleans docs");
    assert.strictEqual(result.version, "1.3.0");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp, "package.json"), "utf8")).version, "1.3.0");
    const lock = JSON.parse(fs.readFileSync(path.join(temp, "package-lock.json"), "utf8"));
    assert.strictEqual(lock.version, "1.3.0");
    assert.strictEqual(lock.packages[""].version, "1.3.0");
    assert.ok(fs.readFileSync(path.join(temp, "README.md"), "utf8").includes("`1.3.0`"));
    assert.ok(fs.readFileSync(path.join(temp, "README_EN.md"), "utf8").includes("`1.3.0`"));
    const changelog = fs.readFileSync(path.join(temp, "CHANGELOG.md"), "utf8");
    assert.ok(changelog.includes("## [1.3.0] - 2026-07-30"));
    assert.ok(changelog.indexOf("## [Unreleased]") < changelog.indexOf("## [1.3.0]"));

    assert.throws(
        () => prepareRelease(temp, "1.3.0", { date: "2026-07-30" }),
        (error) => error.code === "VERSION_EXISTS"
    );
    fs.writeFileSync(audit, "# audit\n");
    fs.writeFileSync(
        path.join(temp, "CHANGELOG.md"),
        changelog.replace("## [Unreleased]", "## [Unreleased]\n\n- pending")
    );
    const skipped = prepareRelease(temp, "1.4.0", { date: "2026-07-31", cleanDocs: false });
    assert.deepStrictEqual(skipped.docsRemoved, []);
    assert.ok(fs.existsSync(audit), "--no-clean-docs keeps docs");
    require("../scripts/validate-release").validateRelease(temp, "v1.4.0");
    console.log("Release script tests passed");
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
