"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { inspectSkill, installSkill, uninstallSkill, inspectSkills, readManifest } = require("../src/skillInstaller");

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

    // Install/uninstall in both scopes: the global directory resolves through os.homedir(), redirected to a temporary
    // directory for determinism
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
        assert.strictEqual(installed.installed, 10);
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

        // Shared reference documents (Markdown) are part of the integrity check too: a missing one needs repair and a
        // changed one an update; checking only the .js runtime scripts under _emberprobe is not enough.
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

        // manifest.shared must match the files actually in the source _emberprobe directory, so new shared files are
        // never missed
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

        // Project-scope uninstall removes only manifest skills and the shared runtime, keeping user-created skills
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

        // After global uninstall the empty skills directory is removed
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

// Symlinks/junctions in the workspace are never followed by install or uninstall. A repository could commit a
// .agents/skills/_emberprobe link to any directory; following it with readdir and removing entries one by one would
// amount to rm -rf outside the workspace.
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

    // (a) _emberprobe links outside the workspace
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

    // (b) .agents/skills itself is a link
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

    // (c) a single skill directory is a link
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

    // (d) .agents itself is a link (recursive mkdir would follow it)
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

    // (e) uninstallSkill must not follow .agents/skills when it is a link
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
