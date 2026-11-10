"use strict";
const { ConfirmationStore, fingerprint } = require("./confirmationStore");

const KEY = "agent.rttInputTrusted";
const TRUST_TTL_MS = 24 * 60 * 60 * 1000;

function invalid(message) {
    return Object.assign(new Error(message), {
        code: "RTT_INPUT_CONFIRMATION_INVALID",
        category: "user_decision",
        retryable: false
    });
}

// Agent input to firmware over an RTT down channel. Firmware decides what the bytes do (a shell can reset, erase or
// move hardware), so without full access each write is confirmed against its exact bytes and the current attachment.
// The 24-hour workspace choice covers one channel of one firmware build on one probe and target; a rebuilt ELF, another
// probe/target or another channel asks again.
class RttInputAuthorization {
    constructor(storage, options = {}) {
        this.storage = storage;
        this.fullAccess = options.fullAccess || (() => false);
        this.confirmations = new ConfirmationStore(options);
        this.now = this.confirmations.now;
    }

    _saved() {
        const saved = this.storage.get(KEY);
        return Array.isArray(saved) ? saved.filter((entry) => entry?.expiresAt > this.now()) : [];
    }

    status(trust) {
        const entry = trust && this._saved().find((item) => item.identity === fingerprint(trust));
        return {
            trusted: !!entry,
            scope: "workspace",
            ...(entry ? { expiresAt: new Date(entry.expiresAt).toISOString() } : {})
        };
    }

    // plan: { trust, identity, preview } from RttAgentService. trust is null when the firmware identity is unknown, and
    // then only a one-time approval is offered.
    request(plan) {
        if (this.fullAccess()) return { confirmationRequired: false, mode: "full" };
        if (plan.trust && this.status(plan.trust).trusted) return { confirmationRequired: false, mode: "workspace" };
        return {
            confirmationRequired: true,
            ...this.confirmations.request(plan.identity),
            choices: plan.trust ? ["once", "workspace", "deny"] : ["once", "deny"],
            question: plan.trust
                ? "Allow sending this input to the firmware over RTT once, or for this channel and firmware for 24 hours?"
                : "Allow sending this input to the firmware over RTT once?",
            ...plan.preview
        };
    }

    // Returns the mode that allowed the write. A confirmation ID always wins, so a stale ID is never silently replaced
    // by full access or a remembered permission.
    authorize(plan, id, remember) {
        if (remember && !id) throw invalid("remember needs the confirmation ID the user approved");
        if (remember && !plan.trust)
            throw invalid("This RTT input cannot be remembered: the firmware identity is unknown");
        if (!id) {
            if (this.fullAccess()) return "full";
            if (plan.trust && this.status(plan.trust).trusted) return "workspace";
            throw invalid("RTT input needs the user's confirmation");
        }
        if (!this.confirmations.consume(String(id), plan.identity))
            throw invalid("RTT input confirmation expired, or the input or RTT attachment changed; request it again");
        return remember ? "workspace" : "once";
    }

    async remember(plan) {
        const identity = fingerprint(plan.trust);
        const kept = this._saved().filter((entry) => entry.identity !== identity);
        kept.push({ identity, target: plan.trust, expiresAt: this.now() + TRUST_TTL_MS });
        // A handful of channels/builds at most; the oldest grants go first.
        await this.storage.update(KEY, kept.slice(-16));
    }

    summary() {
        const saved = this._saved();
        return {
            scope: "workspace",
            saved: saved.length > 0,
            grants: saved.map((entry) => ({
                channel: entry.target?.channel ?? null,
                elfPath: entry.target?.elfPath || "",
                expiresAt: new Date(entry.expiresAt).toISOString()
            }))
        };
    }

    async reset() {
        this.confirmations.clear();
        await this.storage.update(KEY, undefined);
        return { trusted: false, scope: "workspace" };
    }
}

module.exports = { RttInputAuthorization, TRUST_TTL_MS };
