"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isOfficialRelease, versionLabel } = require("../src/buildInfo");
const { getModernWebviewContent } = require("../src/modernView");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-build-info-"));
try {
    assert.strictEqual(isOfficialRelease("0.7.13", "v0.7.13"), true);
    assert.strictEqual(isOfficialRelease("0.7.13", "v0.7.12"), false);
    assert.strictEqual(isOfficialRelease("0.7.14-beta.1", "v0.7.14-beta.1"), false);
    assert.strictEqual(versionLabel("0.7.13", directory), "v0.7.13 beta");
    fs.writeFileSync(path.join(directory, "buildInfo.json"), '{"version":"0.7.13","officialRelease":true}');
    assert.strictEqual(versionLabel("0.7.13", directory), "v0.7.13");
    assert.strictEqual(versionLabel("0.7.14", directory), "v0.7.14 beta");
    const html = getModernWebviewContent({ versionLabel: versionLabel("0.7.13", directory) }, "en");
    assert.match(html, /<strong>EmberProbe<\/strong><span class="build-version">v0\.7\.13<\/span>/);
    assert.ok(!html.includes("v0.7.13 beta"));
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}

console.log("Build version label tests passed");
