"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SkillStatusService, legacyGlobalSkills } = require("../src/services/skillStatusService");
const { hasWorkspaceSkills } = require("../src/services/skillStatusService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, context } = fixture;
    try {
        const skillEvents = [];
        const skillStatus = {
            state: "installed",
            scopes: { workspace: null, global: { state: "installed", installed: 2, total: 2, root: temp } }
        };
        const skillService = new SkillStatusService({
            vscode: { window: {}, commands: {}, workspace: { workspaceFolders: [] } },
            context,
            installer: { inspectSkills: async () => skillStatus },
            getLang: () => "en",
            t: (key, params) => (params ? `${key}:${params.installed}/${params.total}` : key),
            onStatus: (status) => skillEvents.push(status)
        });
        assert.strictEqual(await skillService.refresh(), skillStatus);
        assert.strictEqual(skillService.scopeStateText(skillStatus.scopes.global), "skill.installed:2/2");
        assert.deepStrictEqual(skillEvents, [skillStatus]);
        assert.strictEqual(hasWorkspaceSkills(skillStatus), false, "global Skills must not enable a workspace Bridge");
        assert.strictEqual(hasWorkspaceSkills({ scopes: { workspace: { state: "notInstalled" } } }), false);
        assert.strictEqual(hasWorkspaceSkills({ scopes: { workspace: { state: "installed" } } }), true);
        assert.strictEqual(hasWorkspaceSkills({ scopes: { workspace: { state: "partial" } } }), true);

        const skillCalls = [];
        const quickPicks = [];
        const notices = [];
        const managedSkills = new SkillStatusService({
            vscode: {
                workspace: { workspaceFolders: [{ uri: { fsPath: temp } }] },
                commands: { executeCommand: (command) => skillCalls.push(command) },
                window: {
                    showQuickPick: async () => quickPicks.shift(),
                    showWarningMessage: async (...args) => {
                        notices.push(args);
                        return args.at(-1);
                    },
                    showInformationMessage: async (...args) => {
                        notices.push(args);
                        return args.at(-1);
                    }
                }
            },
            context,
            installer: {
                inspectSkills: async () => skillStatus,
                installSkill: async (_vscode, _context, _lang, scope) => {
                    skillCalls.push(`install:${scope}`);
                    skillStatus.scopes.workspace = { state: "installed", root: temp };
                    return skillStatus;
                },
                uninstallSkill: async (_vscode, _context, _lang, scope) => {
                    skillCalls.push(`uninstall:${scope}`);
                    skillStatus.scopes.workspace = { state: "notInstalled", root: temp };
                    return skillStatus;
                }
            },
            getLang: () => "en",
            t: (key) => key,
            onStatus: () => {}
        });
        skillStatus.scopes.workspace ??= { state: "notInstalled", root: temp };
        assert.strictEqual(await managedSkills.manage(), skillStatus);
        assert.strictEqual(await managedSkills.manage(), skillStatus);
        assert.ok(skillCalls.includes("install:workspace") && skillCalls.includes("uninstall:workspace"));
        managedSkills.promptUpgrade({ state: "outdated" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(notices.length >= 1);
        assert.ok(!skillCalls.some((call) => call.includes(":global")));
        for (const state of ["outdated", "modified", "partial"]) {
            skillStatus.scopes.workspace = { state, root: temp };
            const count = skillCalls.length;
            await Promise.all([managedSkills.refresh(true), managedSkills.refresh(true), managedSkills.refresh()]);
            assert.deepStrictEqual(skillCalls.slice(count), ["install:workspace"]);
            assert.strictEqual(managedSkills.busy, false);
            assert.strictEqual(managedSkills.lastStatus.scopes.workspace.state, "installed");
        }
        for (const state of ["installed", "notInstalled"]) {
            skillStatus.scopes.workspace = { state, root: temp };
            const count = skillCalls.length;
            await managedSkills.refresh(true);
            assert.strictEqual(skillCalls.length, count);
        }
        skillStatus.scopes.workspace = { state: "modified", root: temp };
        const count = skillCalls.length;
        await managedSkills.refresh();
        assert.strictEqual(skillCalls.length, count, "ordinary status reads must not write Skills");
        const install = managedSkills.installer.installSkill;
        managedSkills.installer.installSkill = async () => {
            throw new Error("disk full");
        };
        await assert.rejects(managedSkills.refresh(true), /disk full/);
        assert.strictEqual(managedSkills.busy, false);
        assert.strictEqual(managedSkills.startupUpdate, null);
        managedSkills.installer.installSkill = install;
        await managedSkills.refresh(true);
    } finally {
        fixture.dispose();
    }

    await scenario("Invalidate skill approval when its fingerprint changes", async () => {
        let skillHash = "one",
            skillDialogs = 0;
        const skills = new SkillStatusService({
            installer: {
                inspectSkills: async () => ({ state: "modified", scopes: { workspace: { fingerprint: skillHash } } })
            },
            onStatus() {},
            t: (key) => key,
            vscode: {
                window: {
                    showWarningMessage: async () => {
                        skillDialogs++;
                        return "approval.skillsAllow";
                    }
                }
            }
        });
        await skills.checkForCall();
        await skills.checkForCall();
        assert.strictEqual(skillDialogs, 1);
        skillHash = "two";
        await skills.checkForCall();
        assert.strictEqual(skillDialogs, 2);
        skills.vscode.window.showWarningMessage = async () => {
            skillHash = "changed-in-dialog";
            return "approval.skillsAllow";
        };
        skillHash = "three";
        await assert.rejects(skills.checkForCall(), { code: "SKILLS_CHANGED_DURING_APPROVAL" });
    });

    await scenario("Check the skill copy that actually issued the call", async () => {
        const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-skill-root-")));
        const workspaceRoot = path.join(base, "project", ".agents", "skills");
        const globalRoot = path.join(base, "home", ".agents", "skills");
        const customRoot = path.join(base, "checkout", "skills");
        for (const dir of [workspaceRoot, globalRoot, customRoot]) fs.mkdirSync(dir, { recursive: true });
        const scopes = {
            workspace: { scope: "workspace", root: workspaceRoot, state: "installed", fingerprint: "ws-1" },
            global: { scope: "global", root: globalRoot, state: "modified", fingerprint: "global-1" }
        };
        let customFingerprint = "custom-1";
        const dialogs = [];
        let answer = "approval.skillsAllow";
        const skills = new SkillStatusService({
            context: {},
            installer: {
                // The merged view puts the workspace first, so checking only it would report everything as fine
                inspectSkills: async () => ({ state: "installed", scopes }),
                inspectSkillRoot: async (_context, root, scope) => ({
                    scope,
                    root,
                    state: "outdated",
                    fingerprint: customFingerprint
                })
            },
            onStatus() {},
            t: (key) => key,
            vscode: {
                window: {
                    showWarningMessage: async (message, options) => {
                        dialogs.push({ message, detail: JSON.parse(options.detail) });
                        return answer;
                    }
                }
            }
        });
        try {
            await skills.checkForCall();
            assert.strictEqual(dialogs.length, 0, "calls without metadata keep the merged-view behavior");
            await skills.checkForCall({ channel: "skill", skillRoot: workspaceRoot });
            assert.strictEqual(dialogs.length, 0, "a clean workspace copy runs without approval");
            answer = undefined;
            await assert.rejects(skills.checkForCall({ channel: "skill", skillRoot: globalRoot + path.sep }), {
                code: "SKILLS_APPROVAL_DENIED"
            });
            assert.strictEqual(dialogs[0].message, "approval.skills");
            assert.strictEqual(dialogs[0].detail.scope, "global");
            answer = "approval.skillsAllow";
            await skills.checkForCall({ channel: "skill", skillRoot: globalRoot });
            await skills.checkForCall({ channel: "skill", skillRoot: globalRoot });
            assert.strictEqual(dialogs.length, 2, "approval is cached per root and fingerprint");
            scopes.workspace.state = "modified";
            await skills.checkForCall({ channel: "skill", skillRoot: workspaceRoot });
            assert.strictEqual(dialogs.length, 3, "approving the global copy does not approve the workspace copy");
            scopes.global.fingerprint = "global-2";
            await skills.checkForCall({ channel: "skill", skillRoot: globalRoot });
            assert.strictEqual(dialogs.length, 4, "a changed global copy needs a new approval");
            if (process.platform === "win32") {
                await skills.checkForCall({ channel: "skill", skillRoot: globalRoot.toUpperCase() });
                assert.strictEqual(dialogs.length, 4, "Windows roots compare case-insensitively");
            }
            // Copies outside every known root always need approval, with the real path in detail
            await skills.checkForCall({ channel: "skill", skillRoot: customRoot });
            assert.strictEqual(dialogs[4].message, "approval.skillsCustom");
            assert.strictEqual(dialogs[4].detail.root, customRoot);
            assert.strictEqual(dialogs[4].detail.scope, "custom");
            await skills.checkForCall({ channel: "skill", skillRoot: customRoot });
            assert.strictEqual(dialogs.length, 5);
            customFingerprint = "custom-2";
            await skills.checkForCall({ channel: "skill", skillRoot: customRoot });
            assert.strictEqual(dialogs.length, 6);
            skills.vscode.window.showWarningMessage = async () => {
                customFingerprint = "custom-changed";
                return "approval.skillsAllow";
            };
            customFingerprint = "custom-3";
            await assert.rejects(skills.checkForCall({ channel: "skill", skillRoot: customRoot }), {
                code: "SKILLS_CHANGED_DURING_APPROVAL"
            });
            // The MCP server code ships with the extension, so no skill hashes are checked
            skills.vscode.window.showWarningMessage = async () => assert.fail("MCP calls must not prompt");
            await skills.checkForCall({ channel: "mcp", client: "test/1" });
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    await scenario("Flag legacy global copies that still ship scripts", () => {
        const status = (global) => ({ scopes: { workspace: null, global } });
        assert.strictEqual(legacyGlobalSkills(status({ state: "outdated", hasScripts: false })), null);
        assert.strictEqual(legacyGlobalSkills(status({ state: "installed", hasScripts: true })), null);
        assert.strictEqual(legacyGlobalSkills(status({ state: "notInstalled", hasScripts: false })), null);
        assert.deepStrictEqual(
            legacyGlobalSkills(
                status({
                    state: "outdated",
                    hasScripts: true,
                    root: "/home/u/.agents/skills",
                    skills: [{ installedVersion: "" }, { installedVersion: "1.1.0" }]
                })
            ),
            { state: "outdated", version: "1.1.0", root: "/home/u/.agents/skills" }
        );
    });
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
