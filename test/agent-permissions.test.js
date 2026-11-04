"use strict";
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { AgentPermissions, FULL_ACCESS_KEY } = require("../src/services/agentPermissions");
const { createSidebarHandler } = require("../src/controllers/sidebarRoutes");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const { ConfigurationStore } = require("../src/services/configurationStore");

(async () => {
    const state = new Map();
    let available = true,
        channel = false,
        starts = 0,
        saveFails = false;
    const options = {
        storage: {
            get: (key, fallback) => (state.has(key) ? state.get(key) : fallback),
            update: async (key, value) => {
                if (saveFails) throw new Error("save failed");
                state.set(key, value);
            }
        },
        available: () => available,
        channelEnabled: () => channel,
        enableChannel: async () => {
            starts++;
            channel = true;
        }
    };
    const permissions = new AgentPermissions(options);
    await scenario("Grant, restore and revoke full access only in an available workspace", async () => {
        assert.strictEqual(permissions.isAllowed(), false);
        assert.strictEqual((await permissions.setEnabled(true)).fullAccess, true);
        assert.strictEqual(starts, 1);
        assert.strictEqual(state.get(FULL_ACCESS_KEY), true);
        assert.strictEqual(new AgentPermissions(options).isAllowed(), true);
        available = false;
        assert.strictEqual(permissions.isAllowed(), false);
        await assert.rejects(permissions.setEnabled(true), { code: "WORKSPACE_UNTRUSTED" });
        available = true;
        channel = false;
        assert.strictEqual(permissions.isAllowed(), false);
        channel = true;
        await permissions.setEnabled(false);
        assert.strictEqual(permissions.isAllowed(), false);
        assert.strictEqual(channel, true, "revoking full access preserves ordinary Agent access");
        await assert.rejects(permissions.setEnabled("true"), { code: "INVALID_PARAMS" });
        saveFails = true;
        await assert.rejects(permissions.setEnabled(true), /save failed/);
        assert.strictEqual(permissions.isAllowed(), false);
        saveFails = false;
    });
    await scenario(
        "Concurrent toggles cannot race a grant and workspace trust is rechecked after channel startup",
        async () => {
            const start = options.enableChannel;
            let resume;
            options.enableChannel = () =>
                new Promise((resolve) => {
                    resume = resolve;
                });
            const pending = permissions.setEnabled(true);
            assert.strictEqual(permissions.status().busy, true);
            await assert.rejects(permissions.setEnabled(false), { code: "AGENT_PERMISSIONS_BUSY" });
            available = false;
            resume();
            await assert.rejects(pending, { code: "WORKSPACE_UNTRUSTED" });
            assert.strictEqual(permissions.isAllowed(), false);
            assert.strictEqual(permissions.status().busy, false);
            available = true;
            options.enableChannel = start;
        }
    );
    await scenario(
        "Sidebar route returns authoritative state on success and failure; Bridge cannot grant access",
        async () => {
            const posts = [];
            const host = { _agentPermissions: permissions };
            const handler = createSidebarHandler(
                host,
                { webview: { postMessage: (message) => posts.push(message) } },
                {}
            );
            await handler({ type: "getAgentPermissions" });
            assert.strictEqual(posts.at(-1).fullAccess, false);
            await handler({ type: "setAgentFullAccess", enabled: true });
            assert.strictEqual(posts.at(-1).fullAccess, true);
            await handler({ type: "setAgentFullAccess", enabled: "false" });
            assert.strictEqual(posts.at(-1).fullAccess, true);
            assert.match(posts.at(-1).error, /boolean/);
            assert.strictEqual(createAgentRoutes(host)["setAgentFullAccess"], undefined);
            const config = new ConfigurationStore({
                vscode: { workspace: { getConfiguration: () => ({}) } },
                context: { workspaceState: options.storage },
                cacheKeys: {}
            });
            await assert.rejects(config.update({ agentFullAccess: true }), { code: "UNSUPPORTED_CONFIG" });
            await assert.rejects(config.update({ "emberprobe.agentFullAccess": true }), { code: "UNSUPPORTED_CONFIG" });
            await permissions.setEnabled(false);
        }
    );
    console.log("Workspace Agent full-access grants, revocation and UI-only authorization passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
