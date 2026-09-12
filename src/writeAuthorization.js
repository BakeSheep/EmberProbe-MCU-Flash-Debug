"use strict";
const crypto = require("crypto");

const DEFAULT_STORAGE_KEY = "agent.writeTrusted";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
// workspace 信任有效期：持久放行会让任何持有 Bridge token 的进程在用户无感知的情况下静默写 RAM，
// 限制为 24 小时，到期后必须重新走两阶段确认
const DEFAULT_TRUST_TTL_MS = 24 * 60 * 60 * 1000;

function writePlanIdentity(plan) {
    const elf = plan?.elfResult?.elf || {};
    return {
        elf: { path: String(elf.path || ""), sha256: String(elf.sha256 || "") },
        items: (plan?.items || []).map((item) => ({
            name: item.name,
            address: Number(item.address) >>> 0,
            type: item.type,
            bytes: Array.from(item.bytes || [])
        }))
    };
}

function fingerprintWritePlan(plan) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(writePlanIdentity(plan)))
        .digest("hex");
}

function authorizationError(message, code, details) {
    return Object.assign(new Error(message), { code, retryable: false, ...(details ? { details } : {}) });
}

class WriteAuthorization {
    constructor(storage, options = {}) {
        this.storage = storage;
        this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this.trustTtlMs = options.trustTtlMs || DEFAULT_TRUST_TTL_MS;
        this.now = options.now || (() => Date.now());
        this.createId = options.createId || (() => crypto.randomBytes(16).toString("hex"));
        this.pending = new Map();
    }

    isTrusted(plan = null) {
        const trust = this.storage.get(this.storageKey, null);
        const sha256 = plan?.elfResult?.elf?.sha256;
        const age = this.now() - trust?.trustedAt;
        // Legacy timestamps/booleans and missing fingerprints fail closed.
        return !!(
            trust &&
            typeof trust === "object" &&
            Number.isFinite(trust.trustedAt) &&
            age >= 0 &&
            age < this.trustTtlMs &&
            typeof sha256 === "string" &&
            sha256 &&
            trust.elfSha256 === sha256
        );
    }

    status(plan = null) {
        return this.isTrusted(plan)
            ? {
                  trusted: true,
                  scope: "workspace",
                  elfSha256: this.storage.get(this.storageKey).elfSha256,
                  trustedExpiresAt: new Date(
                      this.storage.get(this.storageKey).trustedAt + this.trustTtlMs
                  ).toISOString()
              }
            : { trusted: false, scope: "workspace" };
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
                question:
                    "Allow this MCU memory write? Choose once, or allow future writes for this ELF in this workspace for 24 hours. Changing the ELF requires confirmation again.",
                choices: ["once", "workspace"],
                elf: identity.elf,
                items: (plan.items || []).map((item) => ({
                    name: item.name,
                    address: `0x${(Number(item.address) >>> 0).toString(16).toUpperCase()}`,
                    type: item.type,
                    value: item.value
                }))
            }
        };
    }

    authorize(plan, options = {}) {
        if (this.isTrusted(plan)) return { authorized: true, mode: "workspace", remember: false };
        const confirmationId = String(options.confirmationId || "").trim();
        if (!confirmationId) {
            if (options.remember)
                throw authorizationError("--remember requires a valid confirmation ID", "WRITE_CONFIRMATION_INVALID");
            return this._request(plan);
        }

        this._prune();
        const pending = this.pending.get(confirmationId);
        this.pending.delete(confirmationId);
        if (!pending || pending.expiresAt <= this.now()) {
            throw authorizationError(
                "Write confirmation is invalid or expired; request confirmation again",
                "WRITE_CONFIRMATION_INVALID"
            );
        }

        const currentIdentity = writePlanIdentity(plan);
        if (
            currentIdentity.elf.path !== pending.identity.elf.path ||
            currentIdentity.elf.sha256 !== pending.identity.elf.sha256
        ) {
            throw authorizationError(
                "The configured ELF changed after write confirmation was requested; review the new addresses and confirm again",
                "ELF_CHANGED_DURING_WRITE_CONFIRMATION",
                { previous: pending.identity.elf, current: currentIdentity.elf }
            );
        }
        if (fingerprintWritePlan(plan) !== pending.fingerprint) {
            throw authorizationError(
                "The requested variables or values changed; request confirmation again",
                "WRITE_CONFIRMATION_INVALID"
            );
        }
        return { authorized: true, mode: options.remember ? "workspace" : "once", remember: !!options.remember };
    }

    async trustWorkspace(plan) {
        const elfSha256 = plan?.elfResult?.elf?.sha256;
        if (typeof elfSha256 !== "string" || !elfSha256) {
            throw authorizationError(
                "ELF fingerprint is required to remember write permission",
                "WRITE_CONFIRMATION_INVALID"
            );
        }
        await this.storage.update(this.storageKey, { trustedAt: this.now(), elfSha256 });
        return this.status(plan);
    }

    async reset() {
        this.pending.clear();
        await this.storage.update(this.storageKey, false);
        return this.status();
    }
}

module.exports = {
    WriteAuthorization,
    writePlanIdentity,
    fingerprintWritePlan,
    DEFAULT_STORAGE_KEY,
    DEFAULT_TTL_MS,
    DEFAULT_TRUST_TTL_MS
};
