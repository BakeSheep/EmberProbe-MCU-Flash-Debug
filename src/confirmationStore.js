"use strict";
const crypto = require("crypto");

const fingerprint = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

class ConfirmationStore {
    constructor(options = {}) {
        this.now = options.now || (() => Date.now());
        this.ttlMs = options.ttlMs || 300000;
        this.createId = options.createId || (() => crypto.randomBytes(16).toString("hex"));
        this.pending = new Map();
    }
    prune() {
        for (const [id, entry] of this.pending) if (entry.expiresAt <= this.now()) this.pending.delete(id);
        while (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value);
    }
    request(identity) {
        this.prune();
        const confirmationId = this.createId();
        const expiresAt = this.now() + this.ttlMs;
        this.pending.set(confirmationId, { identity, fingerprint: fingerprint(identity), expiresAt });
        return { confirmationId, expiresAt: new Date(expiresAt).toISOString() };
    }
    consume(id, identity) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        return !!entry && entry.expiresAt > this.now() && entry.fingerprint === fingerprint(identity);
    }
    clear() {
        this.pending.clear();
    }
}
module.exports = { ConfirmationStore, fingerprint };
