"use strict";
const crypto = require("crypto");

const DEFAULT_STORAGE_KEY = "agent.writeTrusted";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function writePlanIdentity(plan) {
    const elf = plan?.elfResult?.elf || {};
    return {
        elf: { path: String(elf.path || ""), sha256: String(elf.sha256 || "") },
        items: (plan?.items || []).map(item => ({
            name: item.name,
            address: Number(item.address) >>> 0,
            type: item.type,
            bytes: Array.from(item.bytes || [])
        }))
    };
}

function fingerprintWritePlan(plan) {
    return crypto.createHash("sha256").update(JSON.stringify(writePlanIdentity(plan))).digest("hex");
}

function authorizationError(message, code, details) {
    return Object.assign(new Error(message), { code, retryable: false, ...(details ? { details } : {}) });
}

class WriteAuthorization {
    constructor(storage, options = {}) {
        this.storage = storage;
        this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this.now = options.now || (() => Date.now());
        this.createId = options.createId || (() => crypto.randomBytes(16).toString("hex"));
        this.pending = new Map();
    }

    isTrusted() {
        return this.storage.get(this.storageKey, false) === true;
    }

    status() {
        return { trusted: this.isTrusted(), scope: "workspace" };
    }

    _prune() {
        const now = this.now();
        for (const [id, request] of this.pending) {
            if (request.expiresAt <= now) this.pending.delete(id);
        }
        while (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value);
    }

    _request(plan) {
        this._prune();
        const confirmationId = this.createId();
        const identity = writePlanIdentity(plan);
        const expiresAt = this.now() + this.ttlMs;
        this.pending.set(confirmationId, { identity, fingerprint: fingerprintWritePlan(plan), expiresAt });
        return {
            authorized: false,
            response: {
                confirmationRequired: true,
                confirmationId,
                expiresAt: new Date(expiresAt).toISOString(),
                scope: "workspace",
                question: "Allow this MCU memory write? Choose once, or allow future writes in this workspace without asking again.",
                choices: ["once", "workspace"],
                elf: identity.elf,
                items: (plan.items || []).map(item => ({
                    name: item.name,
                    address: `0x${(Number(item.address) >>> 0).toString(16).toUpperCase()}`,
                    type: item.type,
                    value: item.value
                }))
            }
        };
    }

    authorize(plan, options = {}) {
        if (this.isTrusted()) return { authorized: true, mode: "workspace", remember: false };
        const confirmationId = String(options.confirmationId || "").trim();
        if (!confirmationId) {
            if (options.remember) throw authorizationError("--remember requires a valid confirmation ID", "WRITE_CONFIRMATION_INVALID");
            return this._request(plan);
        }

        this._prune();
        const pending = this.pending.get(confirmationId);
        this.pending.delete(confirmationId);
        if (!pending || pending.expiresAt <= this.now()) {
            throw authorizationError("Write confirmation is invalid or expired; request confirmation again", "WRITE_CONFIRMATION_INVALID");
        }

        const currentIdentity = writePlanIdentity(plan);
        if (currentIdentity.elf.path !== pending.identity.elf.path || currentIdentity.elf.sha256 !== pending.identity.elf.sha256) {
            throw authorizationError(
                "The configured ELF changed after write confirmation was requested; review the new addresses and confirm again",
                "ELF_CHANGED_DURING_WRITE_CONFIRMATION",
                { previous: pending.identity.elf, current: currentIdentity.elf }
            );
        }
        if (fingerprintWritePlan(plan) !== pending.fingerprint) {
            throw authorizationError("The requested variables or values changed; request confirmation again", "WRITE_CONFIRMATION_INVALID");
        }
        return { authorized: true, mode: options.remember ? "workspace" : "once", remember: !!options.remember };
    }

    async trustWorkspace() {
        await this.storage.update(this.storageKey, true);
        return this.status();
    }

    async reset() {
        this.pending.clear();
        await this.storage.update(this.storageKey, false);
        return this.status();
    }
}

module.exports = { WriteAuthorization, writePlanIdentity, fingerprintWritePlan, DEFAULT_STORAGE_KEY, DEFAULT_TTL_MS };
