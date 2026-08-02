"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");

assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- ["']v\*\.\*\.\*["']/u);
assert.match(workflow, /workflow_dispatch:/u);
assert.match(workflow, /contents: write/u);
assert.match(workflow, /concurrency:\s*[\s\S]*cancel-in-progress: false/u);
assert.match(workflow, /node scripts\/validate-release\.js/u);
assert.match(workflow, /npm run check/u);
assert.match(workflow, /npm run quality/u);
assert.match(workflow, /xvfb-run -a npm run test:e2e/u);
assert.match(workflow, /npm run package/u);
assert.match(workflow, /gh release create[\s\S]*--draft/u);
assert.match(workflow, /gh release upload[\s\S]*--clobber/u);
assert.match(workflow, /gh release edit[\s\S]*--draft=false/u);
assert.doesNotMatch(workflow, /Marketplace|VSCE_PAT|environment: release/u);
assert.doesNotMatch(workflow, /@vscode\/vsce@[^\s]+ publish/u);

const uploadIndex = workflow.indexOf("gh release upload");
const promoteIndex = workflow.indexOf("--draft=false");
assert.ok(
    uploadIndex >= 0 && promoteIndex > uploadIndex,
    "The VSIX must be uploaded before the GitHub draft is public"
);

console.log("Release workflow tests passed");
