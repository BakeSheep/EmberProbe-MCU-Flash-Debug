"use strict";
const { canonicalPath } = require("../../skills/_emberprobe/bridge-locator");

function hasWorkspaceSkills(status) {
    const workspace = status?.scopes?.workspace;
    return !!workspace && workspace.state !== "notInstalled";
}

// Global installs are no longer maintained: global copies that still contain executable scripts and are outdated,
// modified or partial should be cleaned up.
function legacyGlobalSkills(status) {
    const global = status?.scopes?.global;
    if (!global || !global.hasScripts || !["outdated", "modified", "partial"].includes(global.state)) return null;
    const version = global.skills?.find((skill) => skill.installedVersion)?.installedVersion || "";
    return { state: global.state, version, root: global.root };
}

class SkillStatusService {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.installer = options.installer;
        this.getLang = options.getLang;
        this.t = options.t;
        this.onStatus = options.onStatus;
        // Messages go to the host's notice box; without one they fall back to VS Code notifications.
        this.notify = options.notify || ((notice) => this.vscode.window.showInformationMessage(this.t(notice.key)));
        this.lastStatus = null;
        this.upgradePrompted = false;
        this.approvedRoots = new Map();
    }

    post(status) {
        this.onStatus(status);
    }

    async refresh(autoUpdate = false) {
        if (this.startupUpdate) return this.startupUpdate;
        if (autoUpdate && !this.busy) {
            this.startupUpdate = this.updateEnabledSkills();
            try {
                return await this.startupUpdate;
            } finally {
                this.startupUpdate = null;
            }
        }
        const status = await this.installer.inspectSkills(this.vscode, this.context);
        this.lastStatus = status;
        this.post(status);

        return status;
    }

    async updateEnabledSkills() {
        this.busy = true;
        try {
            let status = await this.installer.inspectSkills(this.vscode, this.context);
            const workspace = status.scopes?.workspace;
            if (workspace && ["outdated", "modified", "partial"].includes(workspace.state)) {
                this.post({ ...status, busy: true });
                status = await this.installer.installSkill(this.vscode, this.context, this.getLang(), "workspace");
            }
            this.lastStatus = status;
            this.post(status);
            return status;
        } catch (error) {
            const status = await this.installer.inspectSkills(this.vscode, this.context);
            this.lastStatus = status;
            this.post(status);
            throw error;
        } finally {
            this.busy = false;
        }
    }

    // meta comes from Bridge request headers: the skill channel checks the copy that issued the call; MCP server code
    // ships with the extension and skips skill hashes; old scripts without meta are checked against the merged view.
    // Request headers are not authentication.
    async checkForCall(meta) {
        if (meta?.channel === "mcp") return;
        if (meta?.channel === "skill" && typeof meta.skillRoot === "string" && meta.skillRoot)
            return this.checkSkillRoot(meta.skillRoot);
        return this.checkMerged();
    }

    async inspectCallerRoot(skillRoot) {
        const status = await this.refresh(false);
        const actual = canonicalPath(skillRoot);
        for (const name of ["workspace", "global"]) {
            const scope = status.scopes?.[name];
            if (scope?.root && canonicalPath(scope.root) === actual) return { actual, scope, custom: false };
        }
        const scope = await this.installer.inspectSkillRoot(this.context, skillRoot, "custom");
        return { actual, scope, custom: true };
    }

    async checkSkillRoot(skillRoot) {
        const { actual, scope, custom } = await this.inspectCallerRoot(skillRoot);
        // Custom copies (outside the known workspace/global roots) always need approval; known roots only when their
        // content deviates.
        if (!custom && !["modified", "partial", "outdated", "notInstalled"].includes(scope.state)) return;
        if (this.approvedRoots.get(actual) === scope.fingerprint) return;
        const allow = this.t("approval.skillsAllow");
        const choice = await this.vscode.window.showWarningMessage(
            this.t(custom ? "approval.skillsCustom" : "approval.skills"),
            {
                modal: true,
                detail: JSON.stringify(
                    {
                        root: skillRoot,
                        scope: custom ? "custom" : scope.scope,
                        state: scope.state,
                        skills: scope.skills
                    },
                    null,
                    2
                )
            },
            allow
        );
        if (choice !== allow)
            throw Object.assign(new Error(this.t("approval.denied")), { code: "SKILLS_APPROVAL_DENIED" });
        const current = await this.inspectCallerRoot(skillRoot);
        if (current.scope.fingerprint !== scope.fingerprint)
            throw Object.assign(new Error("Skills changed during approval; review them again"), {
                code: "SKILLS_CHANGED_DURING_APPROVAL"
            });
        // The cache key is root + that root's fingerprint, so approving a workspace copy does not also approve a global
        // one.
        this.approvedRoots.set(actual, scope.fingerprint);
    }

    async checkMerged() {
        const status = await this.refresh(false);
        const key = JSON.stringify(status.scopes);
        if (!["modified", "partial", "outdated"].includes(status.state) || this.approvedContents === key) return;
        const allow = this.t("approval.skillsAllow");
        const choice = await this.vscode.window.showWarningMessage(
            this.t("approval.skills"),
            {
                modal: true,
                detail: JSON.stringify(status.scopes?.workspace || status.scopes?.global, null, 2)
            },
            allow
        );
        if (choice !== allow)
            throw Object.assign(new Error(this.t("approval.denied")), { code: "SKILLS_APPROVAL_DENIED" });
        const current = await this.refresh(false);
        if (JSON.stringify(current.scopes) !== key)
            throw Object.assign(new Error("Skills changed during approval; review them again"), {
                code: "SKILLS_CHANGED_DURING_APPROVAL"
            });
        this.approvedContents = key;
    }

    promptUpgrade(status) {
        if (this.upgradePrompted || !["outdated", "modified", "partial"].includes(status.state)) return;
        this.upgradePrompted = true;
        const manage = this.t("msg.skillsManage");
        this.vscode.window.showInformationMessage(this.t("msg.skillsDiffers"), manage).then((choice) => {
            if (choice === manage) this.vscode.commands.executeCommand("mcu-vscode.manageAgentSkills");
        });
    }

    scopeStateText(scope) {
        if (!scope) return this.t("skill.noWorkspace");
        const hasCount = Number.isFinite(scope.installed) && Number.isFinite(scope.total) && scope.total > 0;
        if (scope.state === "installed" && hasCount) {
            return this.t("skill.installed", { installed: scope.installed, total: scope.total });
        }
        if (scope.state === "partial" && hasCount) {
            return this.t("skill.partial", { installed: scope.installed, total: scope.total });
        }
        const key = {
            outdated: "skill.outdated",
            modified: "skill.modified",
            notInstalled: "skill.notInstalled"
        }[scope.state];
        return this.t(key || "skill.notInstalled");
    }

    scopeHasContent(scope) {
        return !!scope && scope.state !== "notInstalled";
    }

    async manage() {
        if (this.busy) return false;
        this.busy = true;
        try {
            const status = await this.installer.inspectSkills(this.vscode, this.context);
            if (!status.scopes?.workspace) {
                this.post(status);
                this.notify({ level: "warning", key: "msg.openWorkspaceFirst" });
                return false;
            }
            this.post({ ...status, busy: true });
            const operation = hasWorkspaceSkills(status) ? "uninstallSkill" : "installSkill";
            const result = await this.installer[operation](this.vscode, this.context, this.getLang(), "workspace");
            this.lastStatus = result;
            this.post(result);
            return result;
        } catch (error) {
            await this.refresh();
            throw error;
        } finally {
            this.busy = false;
        }
    }
}
module.exports = { SkillStatusService, hasWorkspaceSkills, legacyGlobalSkills };
