"use strict";

function hasWorkspaceSkills(status) {
    const workspace = status?.scopes?.workspace;
    return !!workspace && workspace.state !== "notInstalled";
}

class SkillStatusService {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.installer = options.installer;
        this.getLang = options.getLang;
        this.t = options.t;
        this.onStatus = options.onStatus;
        this.lastStatus = null;
        this.bridgeWarned = false;
        this.upgradePrompted = false;
    }

    post(status) {
        this.onStatus(status);
    }

    async refresh() {
        const status = await this.installer.inspectSkills(this.vscode, this.context);
        this.lastStatus = status;
        this.post(status);

        return status;
    }

    warnIfModified() {
        if (this.bridgeWarned || this.lastStatus?.state !== "modified") return;
        this.bridgeWarned = true;
        const manage = this.t("msg.skillsManage");
        this.vscode.window.showWarningMessage(this.t("msg.skillsModifiedBridgeWarn"), manage).then((choice) => {
            if (choice === manage) this.vscode.window.showInformationMessage(this.t("msg.skillsDiffers"));
        });
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
                this.vscode.window.showInformationMessage(this.t("msg.openWorkspaceFirst"));
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
module.exports = { SkillStatusService, hasWorkspaceSkills };
