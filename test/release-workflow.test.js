"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const { publishRelease } = require("../scripts/publish-release");
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
assert.strictEqual(release.jobs.gates.uses, "./.github/workflows/ci.yml");
assert.deepStrictEqual(release.jobs.build.needs, ["gates", "driver-helper"]);
assert.ok(release.jobs["driver-helper"].steps.some((s) => s.run === "node scripts/verify-driver-helper.js"));
assert.ok(!release.jobs["driver-helper"].steps.some((s) => /sign-driver-helper\.ps1/.test(s.run || "")));
assert.ok(release.jobs.build.steps.some((s) => s.run === "node scripts/verify-driver-helper.js"));
assert.ok(release.jobs.build.steps.some((s) => s.run === "node scripts/verify-driver-helper.js dist/emberprobe.vsix"));
assert.strictEqual(release.jobs.publish.needs, "build");
assert.strictEqual(release.permissions.contents, "read");
assert.strictEqual(release.jobs.publish.permissions.contents, "write");
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
    }
}
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
assert.throws(() => publishRelease("main"), /stable/);
console.log("Workflow and release behavior tests passed");
