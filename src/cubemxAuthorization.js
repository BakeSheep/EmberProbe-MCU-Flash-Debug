"use strict";
const { ConfirmationStore, fingerprint } = require("./confirmationStore");
const KEY = "agent.cubemxTrusted";

class CubeMxAuthorization {
    constructor(storage, options = {}) {
        this.storage = storage;
        this.confirmations = new ConfirmationStore(options);
        this.now = this.confirmations.now;
    }
    status(identity) {
        const saved = this.storage.get(KEY);
        const trusted = !!saved && saved.identity === fingerprint(identity) && saved.expiresAt > this.now();
        return {
            trusted,
            scope: "workspace",
            ...(trusted ? { expiresAt: new Date(saved.expiresAt).toISOString() } : {})
        };
    }
    request(plan) {
        if (this.status(plan.trust).trusted) return { confirmationRequired: false, mode: "workspace" };
        return {
            confirmationRequired: true,
            ...this.confirmations.request(plan.identity),
            choices: ["once", "workspace", "deny"],
            question: "Allow this .ioc change and CubeMX generation once, or for this project for 24 hours?"
        };
    }
    authorize(plan, id, remember) {
        if (!id && !remember && this.status(plan.trust).trusted) return;
        if (!this.confirmations.consume(id, plan.identity))
            throw Object.assign(new Error("CubeMX confirmation expired or the project changed; prepare again"), {
                code: "CUBEMX_CONFIRMATION_INVALID",
                retryable: false
            });
    }
    async remember(plan) {
        await this.storage.update(KEY, {
            identity: fingerprint(plan.trust),
            target: plan.trust,
            expiresAt: this.now() + 86400000
        });
    }
    summary() {
        const saved = this.storage.get(KEY);
        return {
            scope: "workspace",
            saved: !!saved,
            expired: !!saved && saved.expiresAt <= this.now(),
            ...(saved ? { target: saved.target || null, expiresAt: new Date(saved.expiresAt).toISOString() } : {})
        };
    }
    async reset() {
        this.confirmations.clear();
        await this.storage.update(KEY, undefined);
        return { trusted: false, scope: "workspace" };
    }
}
module.exports = { CubeMxAuthorization };
