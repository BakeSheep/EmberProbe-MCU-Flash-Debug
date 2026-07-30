"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const readText = file => fs.readFileSync(path.join(root, file), "utf8");

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const manifest = readJson("skills/manifest.json");
const changelog = readText("CHANGELOG.md");
const readmeZh = readText("README.md");
const readmeEn = readText("README_EN.md");

assert.strictEqual(lock.version, pkg.version, "package-lock top-level version must match package.json");
assert.strictEqual(lock.packages[""].version, pkg.version, "package-lock root package version must match package.json");
assert.ok(changelog.includes(`## [${pkg.version}]`), `CHANGELOG must contain a ${pkg.version} release heading`);
assert.ok(readmeZh.includes(`当前扩展版本为 \`${pkg.version}\``), "Chinese README must report the package version");
assert.ok(readmeEn.includes(`current extension version is \`${pkg.version}\``), "English README must report the package version");
assert.ok(pkg.files.includes("ROADMAP.md"), "published package must include ROADMAP.md");
for (const script of ["release:prepare", "quality", "test:e2e", "test:hil"]) {
    assert.ok(pkg.scripts[script], `package.json must expose the ${script} workflow`);
}

for (const skill of manifest.skills) {
    assert.ok(readmeZh.includes(`\`${skill.name}\``), `Chinese README must document ${skill.name}`);
    assert.ok(readmeEn.includes(`\`${skill.name}\``), `English README must document ${skill.name}`);
}

assert.ok(!readmeZh.includes("无法加入采样（暂不展开成员）"), "Chinese README must not describe composite sampling as unsupported");
assert.ok(!readmeEn.includes("members are not expanded yet"), "English README must not describe composite sampling as unsupported");

console.log("Release consistency tests passed");
