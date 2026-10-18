"use strict";

const crypto = require("crypto");
const { ConfirmationStore } = require("./confirmationStore");
const { normalizeFileIdentity } = require("../skills/_emberprobe/file-identity");
const { normalizeTransport } = require("./openocdScripts");
const {
    normalizeProbeSerial,
    normalizeAdapterSpeed,
    probeFamily,
    assertWriteIdentity,
    canRememberWrite
} = require("../skills/_emberprobe/probe-connection");

const DEFAULT_TTL_MS = 5 * 60 * 1000;
// 烧录的 workspace 授权：绑定 ELF 路径与连接，不绑定 ELF 内容，便于迭代编译后重复烧录；
// 每次烧录仍在结果中报告实际 SHA-256。仅限 flash.execute，校验（flash.verify）始终逐次确认。
const DEFAULT_TRUST_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STORAGE_KEY = "agent.flashTrusted";

function flashIdentity(plan) {
    assertWriteIdentity(plan);
    const operation = plan?.operation || "flash.execute";
    if (!["flash.execute", "flash.verify"].includes(operation)) throw invalid("Invalid Flash operation");
    return {
        operation,
        elf: {
            path: normalizeFileIdentity(plan?.elf?.path || ""),
            sha256: String(plan?.elf?.sha256 || "")
        },
        transport: normalizeTransport(plan?.transport),
        probeSerial: normalizeProbeSerial(plan?.probeSerial, probeFamily(plan || {})),
        ...(plan?.selectionIdentity ? { selectionIdentity: plan.selectionIdentity } : {}),
        adapterSpeedKhz: normalizeAdapterSpeed(plan?.adapterSpeedKhz),
        target: String(plan?.target || ""),
        probe: String(plan?.probe || ""),
        openocd: String(plan?.openocd || "")
    };
}

// The remembered identity is the confirmation identity without the image digest.
function flashTrustIdentity(plan) {
    const { elf, ...identity } = flashIdentity(plan);
    return { ...identity, elfPath: elf.path };
}

function fingerprint(plan) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(flashIdentity(plan)))
        .digest("hex");
}

function trustFingerprint(plan) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(flashTrustIdentity(plan)))
        .digest("hex");
}

function invalid(message) {
    return Object.assign(new Error(message), {
        code: "FLASH_CONFIRMATION_INVALID",
        category: "user_decision",
        retryable: false
    });
}

class FlashAuthorization {
    constructor(options = {}) {
        this.storage = options.storage || null;
        this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this.trustTtlMs = options.trustTtlMs || DEFAULT_TRUST_TTL_MS;
        this.now = options.now || (() => Date.now());
        this.createId = options.createId || (() => crypto.randomBytes(16).toString("hex"));
        this.confirmations = new ConfirmationStore({ ttlMs: this.ttlMs, now: this.now, createId: this.createId });
        this.pending = this.confirmations.pending;
    }

    _prune() {
        this.confirmations.prune();
    }

    canRemember(plan) {
        return !!this.storage && (plan?.operation || "flash.execute") === "flash.execute" && canRememberWrite(plan);
    }

    _saved() {
        const saved = this.storage?.get(this.storageKey, null);
        return saved && typeof saved === "object" && Number.isFinite(saved.trustedAt) ? saved : null;
    }

    isTrusted(plan) {
        if (!this.canRemember(plan)) return false;
        const saved = this._saved();
        const age = this.now() - (saved?.trustedAt ?? NaN);
        return !!saved && age >= 0 && age < this.trustTtlMs && saved.identity === trustFingerprint(plan);
    }

    status(plan = null) {
        const saved = this._saved();
        const trusted = !!plan && this.isTrusted(plan);
        return {
            scope: "workspace",
            trusted,
            saved: !!saved,
            ...(saved
                ? {
                      target: saved.target || null,
                      expiresAt: new Date(saved.trustedAt + this.trustTtlMs).toISOString(),
                      expired: this.now() - saved.trustedAt >= this.trustTtlMs
                  }
                : {})
        };
    }

    authorize(plan, confirmationId, options = {}) {
        this._prune();
        const id = String(confirmationId || "").trim();
        const remember = !!options.remember;
        if (remember && !this.canRemember(plan))
            throw invalid("This Flash operation or probe supports one-time permission only");
        if (!id) {
            if (remember) throw invalid("--remember requires a valid confirmation ID");
            const identity = flashIdentity(plan);
            if (this.isTrusted(plan))
                return {
                    authorized: true,
                    confirmationRequired: false,
                    mode: "workspace",
                    trustedExpiresAt: this.status(plan).expiresAt,
                    ...identity
                };
            const { confirmationId: nextId, expiresAt } = this.confirmations.request(identity);
            const rememberable = this.canRemember(plan);
            return {
                authorized: false,
                confirmationRequired: true,
                confirmationId: nextId,
                expiresAt,
                choices: rememberable ? ["once", "workspace", "deny"] : ["once", "deny"],
                question:
                    identity.operation === "flash.verify"
                        ? "Allow this one-time Flash verification? It temporarily halts the target and restores its prior state."
                        : rememberable
                          ? "Allow this MCU flash erase and firmware download once, or allow programming this ELF path through this probe, target and OpenOCD in this workspace for 24 hours? Rebuilding the same ELF path keeps the permission; changing the path, target, probe or OpenOCD requires confirmation again."
                          : "Allow this one-time MCU flash erase and firmware download?",
                ...identity
            };
        }
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (!pending || pending.expiresAt <= this.now()) throw invalid("Flash confirmation is invalid or expired");
        if (pending.fingerprint !== fingerprint(plan)) {
            throw invalid("The ELF, target, probe, or OpenOCD executable changed after confirmation was requested");
        }
        return { authorized: true, mode: remember ? "workspace" : "once", remember, ...flashIdentity(plan) };
    }

    async remember(plan) {
        if (!this.canRemember(plan)) throw invalid("This Flash operation or probe supports one-time permission only");
        const identity = flashTrustIdentity(plan);
        await this.storage.update(this.storageKey, {
            trustedAt: this.now(),
            identity: trustFingerprint(plan),
            target: { elfPath: identity.elfPath, target: identity.target, probe: identity.probe }
        });
        return this.status(plan);
    }

    async reset() {
        this.pending.clear();
        if (this.storage) await this.storage.update(this.storageKey, undefined);
        return { scope: "workspace", trusted: false, saved: false };
    }
}

module.exports = {
    FlashAuthorization,
    flashIdentity,
    flashTrustIdentity,
    fingerprint,
    trustFingerprint,
    DEFAULT_TTL_MS,
    DEFAULT_TRUST_TTL_MS,
    DEFAULT_STORAGE_KEY
};
