"use strict";
const { canonicalPath } = require("../../skills/_emberprobe/bridge-locator");

function hasWorkspaceSkills(status) {
    const workspace = status?.scopes?.workspace;
    return !!workspace && workspace.state !== "notInstalled";
}

// 全局安装已停止维护：仍含可执行脚本、且版本过期/被修改/不完整的全局副本需要提示清理。
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
        this.bridgeWarned = false;
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

    warnIfModified() {
        if (this.bridgeWarned || this.lastStatus?.state !== "modified") return;
        this.bridgeWarned = true;
        const manage = this.t("msg.skillsManage");
        this.vscode.window.showWarningMessage(this.t("msg.skillsModifiedBridgeWarn"), manage).then((choice) => {
            if (choice === manage) this.vscode.commands.executeCommand("mcu-vscode.manageAgentSkills");
        });
    }
    // meta 来自 Bridge 请求头：skill 通道按实际发起调用的副本检查；MCP 服务器代码随扩展安装，
    // 不检查 skill 哈希；没有 meta 的旧脚本沿用合并视图检查。请求头不构成鉴权。
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
        // 自定义副本（不在已知的 workspace/global 根下）总是需要审批；已知根只在内容偏离时审批。
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
        // 缓存键为“根目录 + 该根目录指纹”：批准 workspace 副本不会连带放行全局副本。
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
