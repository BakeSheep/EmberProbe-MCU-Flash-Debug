"use strict";
// Per-workspace Agent access switch: starting and stopping the Bridge depends only on trust, the explicit switch and
// (for compatibility) workspace skills. Uninstalling skills does not close an explicitly enabled channel; the switch is
// stored only in workspaceState.
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");

const vscode = { workspace: { isTrusted: true, workspaceFolders: [] }, window: {} };
const P = loadProvider(vscode);

function createProvider(status) {
    const state = new Map();
    const events = { starts: [], stops: 0, posts: [], updates: [] };
    const provider = Object.create(P.prototype);
    Object.assign(provider, {
        _context: {
            workspaceState: {
                get: (key) => state.get(key),
                update: async (key, value) => {
                    events.updates.push([key, value]);
                    if (value === undefined) state.delete(key);
                    else state.set(key, value);
                }
            }
        },
        _skillStatusService: {
            lastStatus: status,
            scopeHasContent: (scope) => !!scope && scope.state !== "notInstalled",
            manage: async () => provider._skillStatusService.lastStatus
        },
        _agentService: {
            accessState: "",
            start: async (options) => events.starts.push(options),
            stop: async () => {
                events.stops++;
            }
        },
        _webviewView: { webview: { postMessage: (message) => events.posts.push(message) } }
    });
    return { provider, state, events };
}
const withSkills = { scopes: { workspace: { state: "installed" }, global: { state: "notInstalled" } } };
const withoutSkills = { scopes: { workspace: { state: "notInstalled" }, global: { state: "notInstalled" } } };

(async () => {
    await scenario("Start the Bridge for installed workspace skills when access is unset", async () => {
        const { provider, events } = createProvider(withSkills);
        await provider._syncAgentBridge();
        assert.deepStrictEqual(events.starts, [{ legacyPointer: true }]);
        assert.strictEqual(events.posts.at(-1).card, "", "the skills switch already shows this state");
        assert.strictEqual(events.posts.at(-1).access, "unset");
    });

    await scenario("Keep explicit access independent of workspace skills", async () => {
        const { provider, events, state } = createProvider(withoutSkills);
        await provider._syncAgentBridge();
        assert.strictEqual(events.stops, 1);
        assert.strictEqual(provider._agentService.accessState, "disabled");
        await provider.setAgentAccess("enabled");
        assert.deepStrictEqual(events.updates, [["emberprobe.agentAccess", "enabled"]]);
        assert.deepStrictEqual(events.starts, [{ legacyPointer: false }], "no workspace pointer without skills");
        assert.strictEqual(events.posts.at(-1).card, "enabled");
        // Uninstalling skills no longer closes an explicitly enabled channel implicitly
        provider._skillStatusService.lastStatus = withoutSkills;
        await provider._syncAgentBridge(withoutSkills);
        assert.strictEqual(events.starts.length, 2);
        await provider.setAgentAccess("disabled");
        assert.strictEqual(state.get("emberprobe.agentAccess"), "disabled");
        assert.strictEqual(events.stops, 2);
        assert.strictEqual(events.posts.at(-1).card, "disabled");
    });

    await scenario("Let an explicit disable win over installed skills until they are reinstalled", async () => {
        const { provider, events, state } = createProvider(withSkills);
        state.set("emberprobe.agentAccess", "disabled");
        await provider._syncAgentBridge();
        assert.strictEqual(events.starts.length, 0);
        assert.strictEqual(events.posts.at(-1).card, "disabled");
        await provider.manageAgentSkills();
        assert.strictEqual(state.has("emberprobe.agentAccess"), false, "reinstalling skills clears the disable");
        assert.deepStrictEqual(events.starts, [{ legacyPointer: true }]);
    });

    await scenario("Never start the Bridge in an untrusted workspace", async () => {
        const { provider, events, state } = createProvider(withSkills);
        state.set("emberprobe.agentAccess", "enabled");
        vscode.workspace.isTrusted = false;
        try {
            await provider._syncAgentBridge();
        } finally {
            vscode.workspace.isTrusted = true;
        }
        assert.strictEqual(events.starts.length, 0);
        assert.strictEqual(provider._agentService.accessState, "untrusted");
        assert.strictEqual(events.posts.at(-1).card, "");
    });

    await scenario("Offer enabling and cleanup when only a legacy global copy exists", async () => {
        const legacy = {
            scopes: {
                workspace: { state: "notInstalled" },
                global: {
                    state: "outdated",
                    hasScripts: true,
                    root: "/home/u/.agents/skills",
                    skills: [{ installedVersion: "1.0.0" }]
                }
            }
        };
        const { provider, events } = createProvider(legacy);
        await provider._syncAgentBridge();
        const view = events.posts.at(-1);
        assert.strictEqual(view.type, "agentAccess");
        assert.strictEqual(view.card, "disabled");
        assert.deepStrictEqual(view.legacyGlobal, {
            state: "outdated",
            version: "1.0.0",
            root: "/home/u/.agents/skills"
        });
        assert.strictEqual(events.starts.length, 0, "a global copy alone never starts the Bridge");
    });

    await scenario("Start the Bridge when VS Code resolves the MCP server for this window", async () => {
        const { provider, events, state } = createProvider(withoutSkills);
        const settings = { "mcp.toolsets": ["debug", "core"] };
        const global = new Map();
        provider._context.globalState = { get: (key) => global.get(key), update: async (key, v) => global.set(key, v) };
        provider._bridgeRegistry = {};
        vscode.workspace.getConfiguration = () => ({ get: (key) => settings[key] });
        vscode.workspace.workspaceFolders = [{ uri: { fsPath: "/work" } }];
        try {
            assert.strictEqual(provider._mcpAvailable(), true);
            assert.strictEqual(provider._mcpToolsets(), "", "the default toolsets inject no variable");
            settings["mcp.toolsets"] = ["cubemx", "core", "bogus"];
            assert.strictEqual(provider._mcpToolsets(), "core,cubemx");
            await provider._requestMcpBridge();
            assert.deepStrictEqual(events.starts, [{ legacyPointer: false }], "MCP never writes a workspace pointer");
            state.set("emberprobe.agentAccess", "disabled");
            assert.strictEqual(provider._mcpAvailable(), false, "an explicit disable hides the server definition");
            await provider._syncAgentBridge();
            assert.strictEqual(events.stops, 1, "an explicit disable wins over an MCP request");
            state.delete("emberprobe.agentAccess");
            provider._mcpBridgeRequested = false;
            await provider._syncAgentBridge();
            assert.strictEqual(events.posts.at(-1).card, "");
            await provider._markMcpConfigured();
            assert.strictEqual(global.get("emberprobe.mcpConfigured"), true);
            assert.strictEqual(events.posts.at(-1).card, "disabled", "a configured external client offers enabling");
            vscode.workspace.workspaceFolders = [];
            assert.strictEqual(provider._mcpAvailable(), false, "no folder, no server definition");
        } finally {
            vscode.workspace.workspaceFolders = [];
            delete vscode.workspace.getConfiguration;
        }
    });

    console.log("Agent access tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
