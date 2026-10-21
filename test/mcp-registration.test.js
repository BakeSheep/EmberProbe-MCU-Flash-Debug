"use strict";
// MCP 注册：VS Code provider 的特性检测与可用性、稳定启动器、按客户端生成的配置片段与 Node 检测。
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { McpRegistration, configSnippet, launcherSource, nodeVersion } = require("../src/services/mcpRegistration");

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mcp-registration-")));

class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => this.listeners.push(listener);
    }
    fire() {
        for (const listener of this.listeners) listener();
    }
    dispose() {}
}
class McpStdioServerDefinition {
    constructor(label, command, args, env, version) {
        Object.assign(this, { label, command, args, env, version });
    }
}

function setup(vscodeExtra = {}, state = {}) {
    const context = {
        extensionPath: path.join(base, "extension"),
        globalStorageUri: { fsPath: path.join(base, "storage") },
        extension: { packageJSON: { version: "0.9.0" } },
        subscriptions: []
    };
    const messages = [];
    const clipboard = [];
    const vscode = {
        EventEmitter,
        window: {
            showQuickPick: async (items) => items.find((item) => item.client === state.pick),
            showWarningMessage: (...args) => messages.push(["warn", ...args]),
            showInformationMessage: (...args) => messages.push(["info", ...args])
        },
        env: { clipboard: { writeText: async (value) => clipboard.push(value) } },
        ...vscodeExtra
    };
    const events = { resolved: 0, configured: 0 };
    const registration = new McpRegistration({
        vscode,
        context,
        t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
        isAvailable: () => state.available !== false,
        instanceId: () => "a".repeat(32),
        toolsets: () => state.toolsets || "",
        onResolve: async () => {
            events.resolved++;
        },
        onConfigured: () => events.configured++,
        nodeVersion: async () => state.node || { found: true, version: "v20.11.0", supported: true }
    });
    return { registration, context, messages, clipboard, events, vscode };
}

(async () => {
    try {
        await scenario("Skip quietly when the VS Code MCP API is missing", () => {
            const { registration, context } = setup();
            assert.strictEqual(registration.register(), false);
            assert.strictEqual(context.subscriptions.length, 0);
            assert.strictEqual(setup({ lm: {} }).registration.register(), false);
        });

        await scenario("Offer a stdio definition bound to this window's Bridge instance", async () => {
            let provider;
            const state = { toolsets: "core,debug,cubemx" };
            const { registration, context, events } = setup(
                {
                    McpStdioServerDefinition,
                    lm: {
                        registerMcpServerDefinitionProvider: (id, value) => {
                            assert.strictEqual(id, "emberprobe");
                            provider = value;
                            return { dispose() {} };
                        }
                    }
                },
                state
            );
            assert.strictEqual(registration.register(), true);
            assert.strictEqual(context.subscriptions.length, 2);
            const [definition] = provider.provideMcpServerDefinitions();
            assert.strictEqual(definition.command, process.execPath);
            assert.deepStrictEqual(definition.args, [path.join(context.extensionPath, "dist", "mcp-server.js")]);
            assert.deepStrictEqual(definition.env, {
                ELECTRON_RUN_AS_NODE: "1",
                EMBERPROBE_BRIDGE_INSTANCE: "a".repeat(32),
                EMBERPROBE_MCP_TOOLSETS: "core,debug,cubemx"
            });
            assert.strictEqual(definition.version, "0.9.0");
            assert.strictEqual(await provider.resolveMcpServerDefinition(definition), definition);
            assert.strictEqual(events.resolved, 1, "resolving starts the Bridge for this window");
            let changes = 0;
            provider.onDidChangeMcpServerDefinitions(() => changes++);
            registration.changed();
            assert.strictEqual(changes, 1);
            state.available = false;
            assert.deepStrictEqual(provider.provideMcpServerDefinitions(), []);
            assert.strictEqual(await provider.resolveMcpServerDefinition(definition), undefined);
            assert.strictEqual(events.resolved, 1, "a disabled workspace never starts the Bridge");
        });

        await scenario("Write a stable launcher that loads the installed server", async () => {
            const { registration, context } = setup();
            const file = await registration.writeLauncher();
            assert.strictEqual(file, path.join(context.globalStorageUri.fsPath, "mcp", "emberprobe-mcp.js"));
            const source = fs.readFileSync(file, "utf8");
            assert.strictEqual(source, launcherSource(registration.serverPath()));
            assert.ok(source.includes(JSON.stringify(path.join(context.extensionPath, "dist", "mcp-server.js"))));
            // 启动器调用打包入口导出的 main()：用一个假服务器验证
            const fake = path.join(base, "fake-server.js");
            fs.writeFileSync(fake, "exports.main = async () => { process.stdout.write('started'); };");
            const launcher = path.join(base, "launcher.js");
            fs.writeFileSync(launcher, launcherSource(fake));
            const { execFileSync } = require("child_process");
            assert.strictEqual(execFileSync(process.execPath, [launcher], { encoding: "utf8" }), "started");
        });

        await scenario("Generate per-client configuration without writing any client file", () => {
            const launcher = "C:\\Users\\me\\AppData\\Code\\emberprobe-mcp.js";
            assert.strictEqual(
                configSnippet("claude", launcher, "", "win32"),
                `claude mcp add --scope user emberprobe -- node "${launcher}"`
            );
            assert.strictEqual(
                configSnippet("claude", "/home/o'neil/mcp.js", "core,cubemx", "linux"),
                "claude mcp add --scope user -e EMBERPROBE_MCP_TOOLSETS=core,cubemx emberprobe -- node '/home/o'\\''neil/mcp.js'"
            );
            assert.strictEqual(
                configSnippet("codex", launcher, ""),
                `[mcp_servers.emberprobe]\ncommand = "node"\nargs = [${JSON.stringify(launcher)}]`
            );
            assert.ok(configSnippet("codex", launcher, "all").endsWith('env = { EMBERPROBE_MCP_TOOLSETS = "all" }'));
            assert.deepStrictEqual(JSON.parse(configSnippet("json", launcher, "")), {
                mcpServers: { emberprobe: { command: "node", args: [launcher] } }
            });
            assert.deepStrictEqual(JSON.parse(configSnippet("json", launcher, "core")).mcpServers.emberprobe.env, {
                EMBERPROBE_MCP_TOOLSETS: "core"
            });
        });

        await scenario("Copy the snippet and report the Node.js check", async () => {
            const state = { pick: "json" };
            const { registration, clipboard, messages, events } = setup({}, state);
            const result = await registration.copyConfig();
            assert.strictEqual(result.client, "json");
            assert.strictEqual(clipboard[0], result.snippet);
            assert.strictEqual(events.configured, 1);
            assert.strictEqual(messages.at(-1)[0], "info");
            state.node = { found: false, version: "", error: "ENOENT" };
            await registration.copyConfig();
            assert.ok(messages.at(-1)[1].startsWith("mcp.nodeMissing"));
            state.node = { found: true, version: "v16.20.0", supported: false };
            await registration.copyConfig();
            assert.ok(messages.at(-1)[1].includes("v16.20.0"));
            state.pick = undefined;
            assert.strictEqual(await registration.copyConfig(), null, "dismissing the picker copies nothing");
            assert.strictEqual(clipboard.length, 3);
        });

        await scenario("Detect the Node.js version on PATH", async () => {
            const fake = (stdout, error) => (_file, _args, _options, callback) => callback(error, stdout);
            assert.deepStrictEqual(await nodeVersion(fake("v20.1.0\n")), {
                found: true,
                version: "v20.1.0",
                supported: true
            });
            assert.strictEqual((await nodeVersion(fake("v16.0.0"))).supported, false);
            assert.deepStrictEqual(
                await nodeVersion(fake("", Object.assign(new Error("missing"), { code: "ENOENT" }))),
                {
                    found: false,
                    version: "",
                    error: "ENOENT"
                }
            );
        });
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
    console.log("MCP registration tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
