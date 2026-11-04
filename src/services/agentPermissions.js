"use strict";

const FULL_ACCESS_KEY = "emberprobe.agentFullAccess";

// Only the sidebar can change this workspace grant; it is not an Agent configuration field or Bridge method.
class AgentPermissions {
    constructor(options) {
        this.options = options;
    }

    isAllowed = () =>
        this.options.available() &&
        this.options.channelEnabled() &&
        this.options.storage.get(FULL_ACCESS_KEY, false) === true;

    status() {
        return {
            type: "agentPermissions",
            fullAccess: this.isAllowed(),
            available: this.options.available(),
            busy: !!this.updating
        };
    }

    async setEnabled(enabled) {
        if (typeof enabled !== "boolean")
            throw Object.assign(new Error("enabled must be a boolean"), { code: "INVALID_PARAMS" });
        if (this.updating)
            throw Object.assign(new Error("Agent permissions are being updated"), { code: "AGENT_PERMISSIONS_BUSY" });
        this.updating = true;
        try {
            if (enabled) {
                if (!this.options.available())
                    throw Object.assign(new Error("Agent permissions require an open, trusted workspace"), {
                        code: "WORKSPACE_UNTRUSTED"
                    });
                await this.options.enableChannel();
                if (!this.options.available())
                    throw Object.assign(new Error("Workspace trust changed"), { code: "WORKSPACE_UNTRUSTED" });
            }
            await this.options.storage.update(FULL_ACCESS_KEY, enabled);
        } finally {
            this.updating = false;
        }
        return this.status();
    }
}

module.exports = { AgentPermissions, FULL_ACCESS_KEY };
