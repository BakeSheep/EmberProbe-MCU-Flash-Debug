"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
    inspectSkill,
    installSkill,
    uninstallSkill,
    inspectSkills,
    readManifest,
    isUnmodifiedLegacySkill,
    removeUnmodifiedLegacySkills
} = require("../src/skillInstaller");

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

    // 重命名迁移只删除元数据、版本、文件集和指纹都与已发布版本一致的旧 Skill。
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-legacy-"));
    const legacyEntry = {
        name: "old-skill",
        version: "1.0.0",
        files: {
            "SKILL.md": crypto.createHash("sha256").update("legacy skill").digest("hex"),
            "scripts/run.js": crypto.createHash("sha256").update("legacy script").digest("hex")
        }
    };
    try {
        const legacySkill = path.join(legacyRoot, legacyEntry.name);
        fs.mkdirSync(path.join(legacySkill, "scripts"), { recursive: true });
        fs.writeFileSync(path.join(legacySkill, "SKILL.md"), "legacy skill");
        fs.writeFileSync(path.join(legacySkill, "scripts", "run.js"), "legacy script");
        fs.writeFileSync(
            path.join(legacySkill, ".emberprobe-skill.json"),
            JSON.stringify({ name: legacyEntry.name, version: legacyEntry.version })
        );
        assert.strictEqual(await isUnmodifiedLegacySkill(legacyRoot, legacyEntry), true);
        fs.writeFileSync(path.join(legacySkill, "scripts", "run.js"), "user modified");
        assert.strictEqual(await isUnmodifiedLegacySkill(legacyRoot, legacyEntry), false);
        assert.deepStrictEqual(await removeUnmodifiedLegacySkills({ legacySkills: [legacyEntry] }, legacyRoot), []);
        assert.ok(fs.existsSync(legacySkill), "modified legacy skill must be preserved");
        fs.writeFileSync(path.join(legacySkill, "scripts", "run.js"), "legacy script");
        assert.deepStrictEqual(await removeUnmodifiedLegacySkills({ legacySkills: [legacyEntry] }, legacyRoot), [
            legacyEntry.name
        ]);
        assert.ok(!fs.existsSync(legacySkill), "unmodified legacy skill should be removed during migration");
    } finally {
        fs.rmSync(legacyRoot, { recursive: true, force: true });
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
        assert.strictEqual(installed.installed, 9);
        const pointer = path.join(workspace, ".agents", "skills", "_emberprobe", "agent-bridge.json");
        fs.writeFileSync(pointer, JSON.stringify({ descriptorPath: "existing-bridge" }));
        await installSkill(vscode, context, "en");
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(pointer, "utf8")), { descriptorPath: "existing-bridge" });
        assert.strictEqual(installed.scopes.workspace.state, "installed");
        assert.strictEqual(installed.scopes.global.state, "notInstalled");
        fs.unlinkSync(path.join(workspace, ".agents", "skills", "mcu-chip-info", "scripts", "read-chip.js"));
        const partial = await inspectSkills(vscode, context);
        assert.strictEqual(partial.state, "partial");
        assert.strictEqual(partial.skills.find((item) => item.name === "mcu-chip-info").state, "partial");

        // Global installation is disabled; retain read/cleanup compatibility with legacy copies.
        await assert.rejects(installSkill(noWorkspaceVscode, context, "en", "global"), /workspace-only/);
        const legacyGlobal = path.join(home, ".agents", "skills");
        fs.cpSync(path.join(workspace, ".agents", "skills"), legacyGlobal, { recursive: true });
        fs.copyFileSync(
            path.join(context.extensionPath, "skills/mcu-chip-info/scripts/read-chip.js"),
            path.join(legacyGlobal, "mcu-chip-info/scripts/read-chip.js")
        );
        const globalInstall = await inspectSkills(noWorkspaceVscode, context);
        assert.strictEqual(globalInstall.state, "installed");
        assert.strictEqual(globalInstall.scopes.global.state, "installed");
        assert.strictEqual(globalInstall.scopes.workspace, null);
        assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "mcu-chip-info", "SKILL.md")));
        const workspaceStillWins = await inspectSkills(vscode, context);
        assert.strictEqual(
            workspaceStillWins.state,
            "partial",
            "a clean global copy must not hide the workspace copy that agents resolve first"
        );

        const staleExtra = path.join(workspace, ".agents", "skills", "mcu-flash", "scripts", "stale.js");
        fs.writeFileSync(staleExtra, "stale");
        await installSkill(vscode, context, "en", "workspace");
        assert.ok(
            !fs.existsSync(staleExtra),
            "reinstall must replace EmberProbe-owned skill directories instead of merging extras"
        );

        // 任务1：共享参考文档(Markdown)也必须纳入完整性检查——缺失触发需修复、变更触发更新，
        // 不能只检测 _emberprobe 下的 .js 运行时脚本。
        assert.strictEqual((await inspectSkills(vscode, context)).scopes.workspace.state, "installed");
        const sharedDoc = path.join(workspace, ".agents", "skills", "_emberprobe", "agent-workflow.md");
        assert.ok(fs.existsSync(sharedDoc), "shared agent-workflow.md must be installed with the runtime");
        fs.rmSync(sharedDoc);
        const missingDoc = await inspectSkills(vscode, context);
        assert.strictEqual(
            missingDoc.scopes.workspace.state,
            "partial",
            "missing shared Markdown must mark runtime skills as needing repair"
        );
        assert.ok(
            missingDoc.skills
                .find((item) => item.name === "mcu-flash")
                .missing.includes("../_emberprobe/agent-workflow.md"),
            "missing shared doc must be reported in the runtime skill's missing list"
        );

        await installSkill(vscode, context, "en", "workspace");
        fs.writeFileSync(sharedDoc, "tampered by user");
        const modifiedDoc = await inspectSkills(vscode, context);
        assert.strictEqual(
            modifiedDoc.skills.find((item) => item.name === "mcu-flash").state,
            "modified",
            "modified shared Markdown must mark runtime skills as modified"
        );

        // manifest.shared 必须与源 _emberprobe 目录实际文件完全一致，防止新增共享文件漏检
        const manifest = await readManifest(context);
        const sharedSourceDir = path.join(context.extensionPath, "skills", "_emberprobe");
        const actualShared = fs
            .readdirSync(sharedSourceDir)
            .filter((name) => fs.statSync(path.join(sharedSourceDir, name)).isFile())
            .sort();
        assert.deepStrictEqual(
            Array.isArray(manifest.shared) ? manifest.shared.slice().sort() : manifest.shared,
            actualShared,
            "manifest.shared must exactly match skills/_emberprobe contents"
        );

        // 项目范围卸载:只移除 manifest 内 skill 与共享运行时,保留用户自建 skill
        fs.mkdirSync(path.join(workspace, ".agents", "skills", "user-skill"), { recursive: true });
        fs.mkdirSync(path.join(workspace, ".emberprobe"), { recursive: true });
        fs.writeFileSync(path.join(workspace, ".emberprobe", "agent-bridge.json"), "{}");
        const uninstalled = await uninstallSkill(vscode, context, "en", "workspace");
        assert.strictEqual(uninstalled.scopes.workspace.state, "notInstalled");
        assert.ok(!fs.existsSync(path.join(workspace, ".agents", "skills", "_emberprobe")));
        assert.ok(!fs.existsSync(path.join(workspace, ".agents", "skills", "mcu-chip-info")));
        assert.ok(
            fs.existsSync(path.join(workspace, ".agents", "skills", "user-skill")),
            "user-created skills must be preserved"
        );
        assert.ok(
            !fs.existsSync(path.join(workspace, ".emberprobe")),
            "workspace uninstall must remove the Bridge pointer directory"
        );

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
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// §1 回归：工作区中的符号链接/junction 绝不可被安装/卸载流程穿透。
// 攻击者可在仓库里提交 .agents/skills/_emberprobe → 任意目录 的链接，
// 旧实现会 readdir 跟随链接并逐个 rm 条目，等价于对工作区外目录执行 rm -rf。
(async () => {
    const context = { extensionPath: path.resolve(__dirname, "..") };
    const linkType = process.platform === "win32" ? "junction" : "dir";

    async function runCase(label, setup, action, assertions) {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `emberprobe-symlink-${label}-ws-`));
        const victim = fs.mkdtempSync(path.join(os.tmpdir(), `emberprobe-symlink-${label}-victim-`));
        const vscode = {
            workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] },
            window: { showInformationMessage() {} }
        };
        try {
            fs.writeFileSync(path.join(victim, "sensitive.txt"), "user data");
            fs.mkdirSync(path.join(victim, "subdir"), { recursive: true });
            fs.writeFileSync(path.join(victim, "subdir", "nested.txt"), "nested data");
            await setup(workspace, victim);
            await action(vscode);
            assert.ok(fs.existsSync(path.join(victim, "sensitive.txt")), `${label}: victim sensitive.txt must survive`);
            assert.ok(
                fs.existsSync(path.join(victim, "subdir", "nested.txt")),
                `${label}: victim subdir/nested.txt must survive`
            );
            await assertions(workspace, victim);
        } finally {
            fs.rmSync(workspace, { recursive: true, force: true });
            fs.rmSync(victim, { recursive: true, force: true });
        }
    }

    // (a) _emberprobe 是指向工作区外目录的链接
    await runCase(
        "runtime",
        async (workspace, victim) => {
            fs.mkdirSync(path.join(workspace, ".agents", "skills"), { recursive: true });
            fs.symlinkSync(victim, path.join(workspace, ".agents", "skills", "_emberprobe"), linkType);
        },
        (vscode) => installSkill(vscode, context, "en", "workspace"),
        async (workspace) => {
            const st = fs.lstatSync(path.join(workspace, ".agents", "skills", "_emberprobe"));
            assert.ok(!st.isSymbolicLink(), "runtime: _emberprobe must not remain a symlink");
            assert.ok(st.isDirectory(), "runtime: _emberprobe must be a real directory after install");
        }
    );

    // (b) .agents/skills 本身是链接
    await runCase(
        "target-root",
        async (workspace, victim) => {
            fs.mkdirSync(path.join(workspace, ".agents"), { recursive: true });
            fs.symlinkSync(victim, path.join(workspace, ".agents", "skills"), linkType);
        },
        (vscode) => installSkill(vscode, context, "en", "workspace"),
        async (workspace) => {
            const st = fs.lstatSync(path.join(workspace, ".agents", "skills"));
            assert.ok(!st.isSymbolicLink(), "target-root: .agents/skills must not remain a symlink");
        }
    );

    // (c) 单个 skill 目录是链接
    await runCase(
        "per-skill",
        async (workspace, victim) => {
            fs.mkdirSync(path.join(workspace, ".agents", "skills"), { recursive: true });
            fs.symlinkSync(victim, path.join(workspace, ".agents", "skills", "mcu-flash"), linkType);
        },
        (vscode) => installSkill(vscode, context, "en", "workspace"),
        async (workspace) => {
            const st = fs.lstatSync(path.join(workspace, ".agents", "skills", "mcu-flash"));
            assert.ok(!st.isSymbolicLink(), "per-skill: mcu-flash must not remain a symlink");
        }
    );

    // (d) .agents 本身是链接（mkdir recursive 会穿透）
    await runCase(
        "agents-dir",
        async (workspace, victim) => {
            fs.symlinkSync(victim, path.join(workspace, ".agents"), linkType);
        },
        (vscode) => installSkill(vscode, context, "en", "workspace"),
        async (workspace) => {
            const st = fs.lstatSync(path.join(workspace, ".agents"));
            assert.ok(!st.isSymbolicLink(), "agents-dir: .agents must not remain a symlink");
        }
    );

    // (e) uninstallSkill 遇到 .agents/skills 是链接时也不得穿透
    await runCase(
        "uninstall",
        async (workspace, victim) => {
            fs.mkdirSync(path.join(workspace, ".agents"), { recursive: true });
            fs.symlinkSync(victim, path.join(workspace, ".agents", "skills"), linkType);
        },
        (vscode) => uninstallSkill(vscode, context, "en", "workspace"),
        async () => {}
    );

    console.log("Skill installer symlink hardening tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
