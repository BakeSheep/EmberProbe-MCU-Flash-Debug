"use strict";
const crypto = require("crypto");
class HumanApprovalService {
    constructor(vscode, translate, storage) {
        this.vscode = vscode;
        this.translate = translate;
        this.storage = storage;
        this.pending = false;
        this.epoch = 0;
    }
    async approve(kind, plan, allowWorkspace = false) {
        const epoch = this.epoch;
        const scope = plan.trust || { elf: plan.elf, connection: plan.connection };
        const key = crypto.createHash("sha256").update(JSON.stringify({ kind, scope })).digest("hex");
        const grants = this.storage?.get("agent.humanApprovals.v1") || {};
        if (allowWorkspace && grants[key]?.expiresAt > Date.now()) return { remember: false, mode: "workspace" };
        if (this.pending) throw Object.assign(new Error("Another approval is pending"), { code: "APPROVAL_BUSY" });
        const detail = JSON.stringify(plan, null, 2);
        if (detail.length > 65536)
            throw Object.assign(new Error("Approval plan is too large"), { code: "APPROVAL_PLAN_TOO_LARGE" });
        const once = this.translate("approval.once");
        const workspace = this.translate("approval.workspace");
        this.pending = true;
        try {
            const choice = await this.vscode.window.showWarningMessage(
                this.translate("approval.request", { operation: kind }),
                { modal: true, detail },
                once,
                ...(allowWorkspace ? [workspace] : [])
            );
            if (choice !== once && (!allowWorkspace || choice !== workspace))
                throw Object.assign(new Error(this.translate("approval.denied")), {
                    code: "HUMAN_APPROVAL_DENIED",
                    retryable: false
                });
            if (epoch !== this.epoch)
                throw Object.assign(new Error("Approval was revoked while the dialog was open"), {
                    code: "HUMAN_APPROVAL_REVOKED"
                });
            if (choice === workspace && this.storage) {
                const latest = this.storage.get("agent.humanApprovals.v1") || {};
                const current = Object.fromEntries(
                    Object.entries(latest)
                        .filter(([, grant]) => grant.expiresAt > Date.now())
                        .slice(-31)
                );
                current[key] = { kind, expiresAt: Date.now() + 86400000 };
                await this.storage.update("agent.humanApprovals.v1", current);
            }
            return { remember: choice === workspace };
        } finally {
            this.pending = false;
        }
    }
    async reset(kind) {
        this.epoch++;
        if (!this.storage) return;
        const grants = this.storage.get("agent.humanApprovals.v1") || {};
        await this.storage.update(
            "agent.humanApprovals.v1",
            Object.fromEntries(
                Object.entries(grants).filter(([, grant]) => grant.kind !== kind && grant.expiresAt > Date.now())
            )
        );
    }
}
module.exports = { HumanApprovalService };
