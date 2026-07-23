"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { inspectSkill, installSkill, inspectSkills } = require("../src/skillInstaller");

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-skills-"));
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");
    const entry = { name: "demo", version: "1.0.0", required: ["SKILL.md", "scripts/run.js"] };
    try {
        fs.mkdirSync(path.join(sourceRoot, "demo", "scripts"), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, "demo", "SKILL.md"), "demo");
        fs.writeFileSync(path.join(sourceRoot, "demo", "scripts", "run.js"), "demo");
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "notInstalled");

        fs.mkdirSync(path.join(targetRoot, "demo"), { recursive: true });
        fs.writeFileSync(path.join(targetRoot, "demo", "SKILL.md"), "demo");
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "partial");

        fs.mkdirSync(path.join(targetRoot, "demo", "scripts"), { recursive: true });
        fs.writeFileSync(path.join(targetRoot, "demo", "scripts", "run.js"), "demo");
        fs.writeFileSync(path.join(targetRoot, "demo", ".emberprobe-skill.json"), JSON.stringify({ version: "0.9.0" }));
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "outdated");

        fs.writeFileSync(path.join(targetRoot, "demo", ".emberprobe-skill.json"), JSON.stringify({ version: "1.0.0" }));
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "installed");

        fs.writeFileSync(path.join(targetRoot, "demo", "scripts", "run.js"), "changed");
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "modified");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-install-"));
    const vscode = {
        workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] },
        window: { showInformationMessage() {} }
    };
    const context = { extensionPath: path.resolve(__dirname, "..") };
    try {
        const installed = await installSkill(vscode, context, "en");
        assert.strictEqual(installed.state, "installed");
        assert.strictEqual(installed.installed, 4);
        fs.unlinkSync(path.join(workspace, ".agents", "skills", "mcu-chip-info", "scripts", "read-chip.js"));
        const partial = await inspectSkills(vscode, context);
        assert.strictEqual(partial.state, "partial");
        assert.strictEqual(partial.skills.find(item => item.name === "mcu-chip-info").state, "partial");
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
    console.log("Skill installer tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
