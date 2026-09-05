"use strict";
const assert = require("assert");
const { SkillStatusService } = require("../src/services/skillStatusService");
const { hasWorkspaceSkills } = require("../src/services/skillStatusService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
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
        const quickPicks = [{ id: "install:global" }, { id: "uninstall" }, { id: "global" }];
        const notices = [];
        const managedSkills = new SkillStatusService({
            vscode: {
                workspace: { workspaceFolders: [] },
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
                    return skillStatus;
                },
                uninstallSkill: async (_vscode, _context, _lang, scope) => {
                    skillCalls.push(`uninstall:${scope}`);
                    return skillStatus;
                }
            },
            getLang: () => "en",
            t: (key) => key,
            onStatus: () => {}
        });
        assert.strictEqual(await managedSkills.manage(), skillStatus);
        assert.strictEqual(await managedSkills.manage(), skillStatus);
        assert.ok(skillCalls.includes("install:global") && skillCalls.includes("uninstall:global"));
        managedSkills.lastStatus = { state: "modified" };
        managedSkills.warnIfModified();
        managedSkills.promptUpgrade({ state: "outdated" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(notices.length >= 3);
        assert.ok(skillCalls.includes("mcu-vscode.manageAgentSkills"));
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
