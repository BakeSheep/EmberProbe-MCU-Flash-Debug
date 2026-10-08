"use strict";

const crypto = require("crypto");
const { ConfirmationStore } = require("./confirmationStore");

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function stableIdentity(plan) {
    return {
        svd: {
            path: String(plan?.svd?.path || ""),
            sha256: String(plan?.svd?.sha256 || "")
        },
        session: {
            id: String(plan?.session?.id || plan?.session?.session?.id || ""),
            epoch: Number(plan?.session?.epoch || 0)
        },
        items: (plan?.items || []).map((item) => ({
            target: String(item.target || ""),
            address: String(item.address || ""),
            size: Number(item.size || 0),
            previous: String(item.previous || ""),
            written: String(item.written || ""),
            bytes: Array.from(item.bytes || [])
        }))
    };
}

function fingerprint(plan) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(stableIdentity(plan)))
        .digest("hex");
}

function invalid(message, details) {
    return Object.assign(new Error(message), {
        code: "PERIPHERAL_WRITE_CONFIRMATION_INVALID",
        category: "user_decision",
        retryable: false,
        ...(details ? { details } : {})
    });
}

class PeripheralWriteAuthorization {
    constructor(options = {}) {
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this.now = options.now || (() => Date.now());
        this.createId = options.createId || (() => crypto.randomBytes(16).toString("hex"));
        this.confirmations = new ConfirmationStore({ ttlMs: this.ttlMs, now: this.now, createId: this.createId });
        this.pending = this.confirmations.pending;
    }

    _prune() {
        this.confirmations.prune();
    }

    request(plan) {
        this._prune();
        const { confirmationId, expiresAt } = this.confirmations.request(stableIdentity(plan));
        return {
            confirmationRequired: true,
            confirmationId,
            expiresAt,
            choices: ["once", "deny"],
            question: "Allow this one-time MCU peripheral register write?",
            svd: stableIdentity(plan).svd,
            session: stableIdentity(plan).session,
            items: (plan.items || []).map((item) => ({
                target: item.target,
                register: item.register,
                address: item.address,
                size: item.size,
                access: item.access,
                previous: item.previous,
                requested: item.requested,
                written: item.written
            }))
        };
    }

    authorize(plan, confirmationId) {
        this._prune();
        const id = String(confirmationId || "").trim();
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (!pending || pending.expiresAt <= this.now())
            throw invalid("Peripheral write confirmation is invalid or expired");
        const current = stableIdentity(plan);
        if (fingerprint(plan) !== pending.fingerprint) {
            throw invalid("The SVD, debug stop, register value, or requested peripheral write changed", {
                previous: pending.identity,
                current
            });
        }
        return { authorized: true, mode: "once" };
    }
}

module.exports = { PeripheralWriteAuthorization, stableIdentity, fingerprint, DEFAULT_TTL_MS };
