"use strict";

const crypto = require("crypto");
const { normalizeFileIdentity } = require("../skills/_emberprobe/file-identity");
const { normalizeTransport } = require("./openocdScripts");
const { normalizeProbeSerial, normalizeAdapterSpeed } = require("../skills/_emberprobe/probe-connection");

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function flashIdentity(plan) {
    return {
        elf: {
            path: normalizeFileIdentity(plan?.elf?.path || ""),
            sha256: String(plan?.elf?.sha256 || "")
        },
        transport: normalizeTransport(plan?.transport),
        probeSerial: normalizeProbeSerial(plan?.probeSerial),
        adapterSpeedKhz: normalizeAdapterSpeed(plan?.adapterSpeedKhz),
        target: String(plan?.target || ""),
        probe: String(plan?.probe || ""),
        openocd: String(plan?.openocd || "")
    };
}

function fingerprint(plan) {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(flashIdentity(plan)))
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
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this.now = options.now || (() => Date.now());
        this.createId = options.createId || (() => crypto.randomBytes(16).toString("hex"));
        this.pending = new Map();
    }

    _prune() {
        const now = this.now();
        for (const [id, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(id);
        while (this.pending.size > 32) this.pending.delete(this.pending.keys().next().value);
    }

    authorize(plan, confirmationId) {
        this._prune();
        const id = String(confirmationId || "").trim();
        if (!id) {
            const nextId = this.createId();
            const expiresAt = this.now() + this.ttlMs;
            const identity = flashIdentity(plan);
            this.pending.set(nextId, { expiresAt, fingerprint: fingerprint(plan), identity });
            return {
                authorized: false,
                confirmationRequired: true,
                confirmationId: nextId,
                expiresAt: new Date(expiresAt).toISOString(),
                choices: ["once", "deny"],
                question: "Allow this one-time MCU flash erase and firmware download?",
                ...identity
            };
        }
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (!pending || pending.expiresAt <= this.now()) throw invalid("Flash confirmation is invalid or expired");
        if (pending.fingerprint !== fingerprint(plan)) {
            throw invalid("The ELF, target, probe, or OpenOCD executable changed after confirmation was requested");
        }
        return { authorized: true, mode: "once", ...flashIdentity(plan) };
    }
}

module.exports = { FlashAuthorization, flashIdentity, fingerprint, DEFAULT_TTL_MS };
