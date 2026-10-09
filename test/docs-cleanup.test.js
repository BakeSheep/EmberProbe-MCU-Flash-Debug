"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { cleanDocs } = require("../scripts/docs-cleanup");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-docs-"));
try {
    assert.deepStrictEqual(cleanDocs(root), []);
    const kept = ["RELEASING.md", "CPU-LOAD-MONITORING.md", "images/chart.png"];
    const removed = ["WAVEFORM-AUDIT.md", "evidence.json", "plans/design.md"];
    for (const file of [...kept, ...removed]) {
        const target = path.join(root, "docs", file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "fixture\n");
    }
    assert.deepStrictEqual(cleanDocs(root), removed);
    for (const file of removed) assert.ok(fs.existsSync(path.join(root, "docs", file)), "preview must not delete");
    assert.deepStrictEqual(cleanDocs(root, { dryRun: false }), removed);
    for (const file of kept) assert.ok(fs.existsSync(path.join(root, "docs", file)), `must keep ${file}`);
    for (const file of removed) assert.ok(!fs.existsSync(path.join(root, "docs", file)), `must remove ${file}`);
    assert.deepStrictEqual(cleanDocs(root), []);
    const invalid = spawnSync(process.execPath, [path.join(__dirname, "../scripts/docs-cleanup.js"), "--unknown"]);
    assert.strictEqual(invalid.status, 1);
    assert.match(invalid.stderr.toString(), /Usage:/);
    console.log("Docs cleanup tests passed");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
