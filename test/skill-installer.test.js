"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { inspectSkill, installSkill, uninstallSkill, inspectSkills } = require("../src/skillInstaller");

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

    // 双范围安装/卸载:全局目录经 os.homedir() 解析,测试内重定向到临时目录保证确定性
    const realHomedir = os.homedir;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-home-"));
    os.homedir = () => home;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-install-"));
    const vscode = {
        workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] },
        window: { showInformationMessage() {} }
    };
    const noWorkspaceVscode = { workspace: { workspaceFolders: [] }, window: { showInformationMessage() {} } };
    const context = { extensionPath: path.resolve(__dirname, "..") };
    try {
        const installed = await installSkill(vscode, context, "en");
        assert.strictEqual(installed.state, "installed");
        assert.strictEqual(installed.installed, 8);
        assert.strictEqual(installed.scopes.workspace.state, "installed");
        assert.strictEqual(installed.scopes.global.state, "notInstalled");
        fs.unlinkSync(path.join(workspace, ".agents", "skills", "mcu-chip-info", "scripts", "read-chip.js"));
        const partial = await inspectSkills(vscode, context);
        assert.strictEqual(partial.state, "partial");
        assert.strictEqual(partial.skills.find(item => item.name === "mcu-chip-info").state, "partial");

        // 全局安装不要求工作区,与项目范围相互独立
        const globalInstall = await installSkill(noWorkspaceVscode, context, "en", "global");
        assert.strictEqual(globalInstall.state, "installed");
        assert.strictEqual(globalInstall.scopes.global.state, "installed");
        assert.strictEqual(globalInstall.scopes.workspace, null);
        assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "mcu-chip-info", "SKILL.md")));

        // 项目范围卸载:只移除 manifest 内 skill 与共享运行时,保留用户自建 skill
        fs.mkdirSync(path.join(workspace, ".agents", "skills", "user-skill"), { recursive: true });
        const uninstalled = await uninstallSkill(vscode, context, "en", "workspace");
        assert.strictEqual(uninstalled.scopes.workspace.state, "notInstalled");
        assert.ok(!fs.existsSync(path.join(workspace, ".agents", "skills", "_emberprobe")));
        assert.ok(!fs.existsSync(path.join(workspace, ".agents", "skills", "mcu-chip-info")));
        assert.ok(fs.existsSync(path.join(workspace, ".agents", "skills", "user-skill")), "user-created skills must be preserved");

        // 全局卸载后目录已空,应整体移除 skills 目录
        const globalUninstall = await uninstallSkill(vscode, context, "en", "global");
        assert.strictEqual(globalUninstall.scopes.global.state, "notInstalled");
        assert.strictEqual(globalUninstall.state, "notInstalled");
        assert.ok(!fs.existsSync(path.join(home, ".agents", "skills")));
    } finally {
        os.homedir = realHomedir;
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
    console.log("Skill installer tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
