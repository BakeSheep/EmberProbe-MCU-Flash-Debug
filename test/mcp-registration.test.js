"use strict";
// MCP 注册：VS Code provider 与 Cursor 扩展 API 的特性检测与可用性、稳定启动器与 POSIX 包装脚本、
// 绝对路径的启动命令、按客户端安装（CLI / 安装链接 / 剪贴板）与 CLI 查找和调用。
const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");
const { execFileSync } = require("child_process");
const {
    McpRegistration,
    configSnippet,
    cursorInstallLink,
    findExecutable,
    installArgs,
    launcherSource,
    removeArgs,
    runCli,
    serverCommand,
    wrapperSource
} = require("../src/services/mcpRegistration");

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mcp-registration-")));
const RUNTIME = "C:\\Program Files\\Microsoft VS Code\\Code.exe";

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
    const opened = [];
    const cli = [];
    const vscode = {
        EventEmitter,
        Uri: { parse: (value) => ({ value }) },
        window: {
            showQuickPick: async (items) => {
                state.picks = items;
                return items.find((item) => item.client === state.pick);
            },
            showWarningMessage: (...args) => messages.push(["warn", ...args]),
            showErrorMessage: (...args) => messages.push(["error", ...args]),
            showInformationMessage: async (...args) => {
                messages.push(["info", ...args]);
                return args[1]?.modal ? state.confirm : undefined;
            }
        },
        env: {
            remoteName: state.remoteName,
            clipboard: { writeText: async (value) => clipboard.push(value) },
            openExternal: async (uri) => {
                opened.push(uri.value);
                return state.openExternal !== false;
            }
        },
        workspace: { workspaceFolders: state.workspace ? [{ uri: { fsPath: state.workspace } }] : [] },
        ...vscodeExtra
    };
    const events = { resolved: 0, configured: 0 };
    const registration = new McpRegistration({
        vscode,
        context,
        t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
        isAvailable: () => state.available !== false,
        isEnabled: () => state.enabled === true,
        instanceId: () => "a".repeat(32),
        toolsets: () => state.toolsets || "",
        onResolve: async () => {
            events.resolved++;
        },
        onConfigured: () => events.configured++,
        platform: state.platform || "win32",
        runtime: state.runtime || RUNTIME,
        findExecutable: (name) => (state.executables || {})[name] || "",
        runCli: async (file, args) => {
            cli.push([file, ...args]);
            return (state.cliResults || []).shift() || { ok: true, stdout: "", stderr: "" };
        }
    });
    return { registration, context, messages, clipboard, opened, cli, events, vscode, state };
}

function cursorApi() {
    const calls = [];
    return {
        calls,
        mcp: {
            registerServer: (config) => calls.push(["register", config]),
            unregisterServer: (name) => calls.push(["unregister", name])
        }
    };
}

(async () => {
    try {
        await scenario("Skip quietly when no MCP registration API is available", () => {
            const { registration, context } = setup();
            assert.strictEqual(registration.register(), false);
            assert.strictEqual(context.subscriptions.length, 0);
            assert.strictEqual(setup({ lm: {} }).registration.register(), false);
            assert.strictEqual(setup({ cursor: { mcp: {} } }).registration.register(), false);
        });

        await scenario("Offer a VS Code stdio definition bound to this window's Bridge instance", async () => {
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
            assert.strictEqual(registration.host, "vscode");
            assert.strictEqual(context.subscriptions.length, 2);
            const [definition] = provider.provideMcpServerDefinitions();
            assert.strictEqual(definition.command, process.execPath);
            assert.deepStrictEqual(definition.args, [path.join(context.extensionPath, "dist", "mcp-server.js")]);
            assert.deepStrictEqual(definition.env, {
                ELECTRON_RUN_AS_NODE: "1",
                EMBERPROBE_MCP_TOOLSETS: "core,debug,cubemx",
                EMBERPROBE_BRIDGE_INSTANCE: "a".repeat(32)
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

        await scenario("Register with Cursor only while Agent access is enabled", () => {
            const cursor = cursorApi();
            const state = { enabled: false };
            const lmCalls = [];
            const { registration, context, events } = setup(
                {
                    cursor,
                    McpStdioServerDefinition,
                    lm: { registerMcpServerDefinitionProvider: () => lmCalls.push(1) }
                },
                state
            );
            assert.strictEqual(registration.register(), true);
            assert.strictEqual(registration.host, "cursor");
            assert.strictEqual(lmCalls.length, 0, "Cursor's own API wins over the VS Code provider");
            assert.deepStrictEqual(cursor.calls, [], "nothing is registered before Agent access is enabled");
            state.enabled = true;
            registration.changed();
            assert.deepStrictEqual(cursor.calls, [
                [
                    "register",
                    {
                        name: "emberprobe",
                        server: {
                            command: RUNTIME,
                            args: [path.join(context.extensionPath, "dist", "mcp-server.js")],
                            env: { ELECTRON_RUN_AS_NODE: "1" }
                        }
                    }
                ]
            ]);
            registration.syncCursor();
            assert.strictEqual(cursor.calls.length, 1, "an unchanged registration is not repeated");
            state.toolsets = "all";
            registration.changed();
            assert.deepStrictEqual(
                cursor.calls.slice(1).map(([kind]) => kind),
                ["unregister", "register"]
            );
            assert.deepStrictEqual(cursor.calls[2][1].server.env, {
                ELECTRON_RUN_AS_NODE: "1",
                EMBERPROBE_MCP_TOOLSETS: "all"
            });
            assert.ok(!("EMBERPROBE_BRIDGE_INSTANCE" in cursor.calls[2][1].server.env), "not bound to one window");
            state.enabled = false;
            registration.changed();
            assert.deepStrictEqual(cursor.calls.at(-1), ["unregister", "emberprobe"]);
            assert.strictEqual(events.resolved, 0, "registering never starts the Bridge");
        });

        await scenario("Keep a failing Cursor registration retryable", () => {
            const cursor = cursorApi();
            let fail = true;
            cursor.mcp.registerServer = (config) => {
                if (fail) throw new Error("not ready");
                cursor.calls.push(["register", config]);
            };
            const { registration } = setup({ cursor }, { enabled: true });
            const warn = console.warn;
            console.warn = () => {};
            try {
                registration.register();
            } finally {
                console.warn = warn;
            }
            assert.strictEqual(registration.cursorServer, "");
            fail = false;
            registration.syncCursor();
            assert.strictEqual(cursor.calls.length, 1);
        });

        await scenario("Skip Cursor registration in remote windows", () => {
            const cursor = cursorApi();
            const { registration } = setup({ cursor }, { enabled: true, remoteName: "ssh-remote" });
            assert.strictEqual(registration.register(), false);
            assert.deepStrictEqual(cursor.calls, []);
        });

        await scenario("Write a stable launcher that loads the installed server", async () => {
            const { registration, context } = setup();
            const file = await registration.writeLauncher();
            assert.strictEqual(file, path.join(context.globalStorageUri.fsPath, "mcp", "emberprobe-mcp.js"));
            assert.strictEqual(fs.readFileSync(file, "utf8"), launcherSource(registration.serverPath()));
            assert.ok(!fs.existsSync(registration.wrapperPath()), "Windows needs no shell wrapper");
            // 启动器调用打包入口导出的 main()：用一个假服务器验证
            const fake = path.join(base, "fake-server.js");
            fs.writeFileSync(fake, "exports.main = async () => { process.stdout.write('started'); };");
            const launcher = path.join(base, "launcher.js");
            fs.writeFileSync(launcher, launcherSource(fake));
            assert.strictEqual(execFileSync(process.execPath, [launcher], { encoding: "utf8" }), "started");
        });

        await scenario("Write an executable POSIX wrapper around the editor runtime", async () => {
            const { registration } = setup({}, { platform: "linux", runtime: process.execPath });
            const launcher = await registration.writeLauncher();
            const wrapper = registration.wrapperPath();
            assert.strictEqual(fs.readFileSync(wrapper, "utf8"), wrapperSource(process.execPath, launcher));
            const fake = path.join(base, "it's server.js");
            fs.writeFileSync(
                fake,
                "exports.main = async () => { process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE)); };"
            );
            const launch = path.join(base, "launch.js");
            fs.writeFileSync(launch, launcherSource(fake));
            const env = { ...process.env };
            delete env.ELECTRON_RUN_AS_NODE;
            assert.strictEqual(execFileSync(process.execPath, [launch], { encoding: "utf8", env }), "undefined");
            if (process.platform === "win32") return;
            assert.ok(fs.statSync(wrapper).mode & 0o100, "wrapper is executable");
            const script = path.join(base, "wrapper-check");
            fs.writeFileSync(script, wrapperSource(process.execPath, launch), { mode: 0o755 });
            assert.strictEqual(execFileSync(script, { encoding: "utf8", env }), "1");
            // 运行时已不存在时回退到 PATH 中的 node
            fs.writeFileSync(script, wrapperSource(path.join(base, "gone"), launch));
            env.PATH = `${path.dirname(process.execPath)}:${process.env.PATH}`;
            assert.strictEqual(execFileSync(script, { encoding: "utf8", env }), "undefined");
        });

        await scenario("Use absolute runtime paths instead of node on PATH", () => {
            const common = { runtime: RUNTIME, launcher: "C:\\s\\mcp.js", wrapper: "/s/mcp" };
            assert.deepStrictEqual(serverCommand({ platform: "win32", ...common }), {
                command: RUNTIME,
                args: ["C:\\s\\mcp.js"],
                env: { ELECTRON_RUN_AS_NODE: "1" }
            });
            assert.deepStrictEqual(serverCommand({ platform: "darwin", ...common, toolsets: "core" }), {
                command: "/s/mcp",
                args: [],
                env: { EMBERPROBE_MCP_TOOLSETS: "core" }
            });
        });

        await scenario("Generate per-client install commands, links and configuration", () => {
            const spec = { command: RUNTIME, args: ["C:\\Users\\me\\mcp.js"], env: { ELECTRON_RUN_AS_NODE: "1" } };
            assert.deepStrictEqual(installArgs("claude", spec), [
                "mcp",
                "add",
                "--scope",
                "user",
                "emberprobe",
                "-e",
                "ELECTRON_RUN_AS_NODE=1",
                "--",
                RUNTIME,
                "C:\\Users\\me\\mcp.js"
            ]);
            assert.deepStrictEqual(installArgs("codex", spec), [
                "mcp",
                "add",
                "emberprobe",
                "--env",
                "ELECTRON_RUN_AS_NODE=1",
                "--",
                RUNTIME,
                "C:\\Users\\me\\mcp.js"
            ]);
            assert.deepStrictEqual(removeArgs("claude"), ["mcp", "remove", "--scope", "user", "emberprobe"]);
            assert.deepStrictEqual(removeArgs("codex"), ["mcp", "remove", "emberprobe"]);
            assert.strictEqual(
                configSnippet("claude", spec, "win32"),
                `claude mcp add --scope user emberprobe -e ELECTRON_RUN_AS_NODE=1 -- "${RUNTIME}" C:\\Users\\me\\mcp.js`
            );
            const posix = { command: "/home/o'neil/mcp", args: [], env: { EMBERPROBE_MCP_TOOLSETS: "core,cubemx" } };
            assert.strictEqual(
                configSnippet("codex", posix, "linux"),
                "codex mcp add emberprobe --env EMBERPROBE_MCP_TOOLSETS=core,cubemx -- '/home/o'\\''neil/mcp'"
            );
            assert.deepStrictEqual(JSON.parse(configSnippet("json", spec)), {
                mcpServers: { emberprobe: { command: RUNTIME, args: ["C:\\Users\\me\\mcp.js"], env: spec.env } }
            });
            assert.deepStrictEqual(JSON.parse(configSnippet("json", { command: "/s/mcp", args: [], env: {} })), {
                mcpServers: { emberprobe: { command: "/s/mcp", args: [] } }
            });
            const link = new URL(cursorInstallLink(spec));
            assert.strictEqual(link.protocol, "cursor:");
            assert.strictEqual(link.host, "anysphere.cursor-deeplink");
            assert.strictEqual(link.pathname, "/mcp/install");
            assert.strictEqual(link.searchParams.get("name"), "emberprobe");
            assert.deepStrictEqual(JSON.parse(Buffer.from(link.searchParams.get("config"), "base64").toString()), {
                command: RUNTIME,
                args: ["C:\\Users\\me\\mcp.js"],
                env: { ELECTRON_RUN_AS_NODE: "1" }
            });
            assert.strictEqual(configSnippet("cursor", spec), cursorInstallLink(spec));
        });

        await scenario("Export Antigravity JSON and a DSH patch with explicit workspace and long-call limits", () => {
            const workspace = "C:\\工作区\\MCU #1: 'demo' & ${value}\\firmware";
            const spec = {
                command: RUNTIME,
                args: ["C:\\Users\\me\\mcp.js"],
                env: { ELECTRON_RUN_AS_NODE: "1", EMBERPROBE_MCP_TOOLSETS: "core,cubemx" }
            };
            const env = { ...spec.env, EMBERPROBE_WORKSPACE: workspace };
            const antigravity = JSON.parse(configSnippet("antigravity", spec, "win32", workspace));
            assert.deepStrictEqual(antigravity, {
                mcpServers: {
                    emberprobe: { command: RUNTIME, args: spec.args, env, timeoutSeconds: 1800 }
                }
            });
            const patch = YAML.parse(configSnippet("dsh", spec, "win32", workspace));
            assert.deepStrictEqual(patch, [
                {
                    insert: [
                        {
                            id: "mcp-emberprobe",
                            name: "@deepseek-ai/dsh-mcp-client",
                            config: {
                                serverName: "emberprobe",
                                transport: "stdio",
                                command: RUNTIME,
                                args: spec.args,
                                env,
                                toolCallTimeoutMs: 1800000
                            }
                        }
                    ]
                }
            ]);
            assert.ok(!Object.hasOwn(spec.env, "EMBERPROBE_WORKSPACE"), "export must not mutate the base spec");
            assert.ok(!Object.hasOwn(env, "EMBERPROBE_BRIDGE_INSTANCE"), "exports survive Bridge restarts");
        });

        await scenario("Preserve POSIX paths and YAML-sensitive characters without requiring a workspace", () => {
            const spec = {
                command: "/home/o'neil/Ember Probe/mcp",
                args: [],
                env: { VALUE: 'true: # \\"quoted\\"\n!!js x\u0085y\u2028z\u2029end' }
            };
            for (const workspace of [undefined, "/tmp/MCU\u0085one\u2028two\u2029three"]) {
                const antigravity = JSON.parse(configSnippet("antigravity", spec, "linux", workspace));
                const dsh = YAML.parse(configSnippet("dsh", spec, "linux", workspace))[0].insert[0].config;
                const env = workspace ? { ...spec.env, EMBERPROBE_WORKSPACE: workspace } : spec.env;
                assert.deepStrictEqual(antigravity.mcpServers.emberprobe.env, env);
                assert.deepStrictEqual(dsh.env, env);
                assert.strictEqual(dsh.command, spec.command);
                assert.deepStrictEqual(dsh.args, []);
            }
            const empty = YAML.parse(configSnippet("dsh", { command: "/s/mcp", args: [], env: {} }, "linux"));
            assert.ok(!Object.hasOwn(empty[0].insert[0].config, "env"));
        });

        await scenario("Find client CLIs on PATH", () => {
            const first = path.join(base, "bin one");
            const second = path.join(base, "bin-two");
            fs.mkdirSync(first, { recursive: true });
            fs.mkdirSync(second, { recursive: true });
            fs.writeFileSync(path.join(first, "claude.ps1"), "");
            fs.writeFileSync(path.join(second, "claude.cmd"), "");
            fs.writeFileSync(path.join(second, "codex"), "", { mode: 0o755 });
            fs.mkdirSync(path.join(first, "codex.exe"));
            if (process.platform === "win32") {
                const winEnv = { Path: `"${first}";${second}` };
                assert.strictEqual(findExecutable("claude", winEnv, "win32"), path.join(second, "claude.cmd"));
                assert.strictEqual(
                    findExecutable("codex", winEnv, "win32"),
                    "",
                    "directories and bare scripts are skipped"
                );
                assert.strictEqual(findExecutable("gemini", winEnv, "win32"), "");
            }
            assert.strictEqual(findExecutable("codex", {}, "linux"), "");
            if (process.platform !== "win32") {
                assert.strictEqual(
                    findExecutable("codex", { PATH: `${first}:${second}` }, "linux"),
                    path.join(second, "codex")
                );
                fs.chmodSync(path.join(second, "codex"), 0o644);
                assert.strictEqual(findExecutable("codex", { PATH: second }, "linux"), "", "must be executable");
            }
        });

        await scenario("Run CLIs without a shell, and .cmd shims through quoted cmd.exe", async () => {
            const calls = [];
            const fake = (file, args, options, callback) => {
                calls.push({ file, args, options });
                callback(calls.length === 2 ? Object.assign(new Error("boom"), { code: 1 }) : null, "out", "err");
            };
            const direct = await runCli("/usr/bin/claude", ["mcp", "add"], { platform: "linux", execFile: fake });
            assert.deepStrictEqual(direct, { ok: true, stdout: "out", stderr: "err" });
            assert.strictEqual(calls[0].file, "/usr/bin/claude");
            assert.strictEqual(calls[0].options.windowsHide, true);
            const shim = await runCli("C:\\npm\\codex.cmd", ["mcp", "add", "C:\\a b\\x.js"], {
                platform: "win32",
                execFile: fake,
                env: { ComSpec: "C:\\Windows\\cmd.exe" }
            });
            assert.deepStrictEqual(shim, { ok: false, stdout: "out", stderr: "err", error: "1" });
            assert.strictEqual(calls[1].file, "C:\\Windows\\cmd.exe");
            assert.deepStrictEqual(calls[1].args, [
                "/d",
                "/s",
                "/c",
                '""C:\\npm\\codex.cmd" "mcp" "add" "C:\\a b\\x.js""'
            ]);
            assert.strictEqual(calls[1].options.windowsVerbatimArguments, true);
            const unsafe = await runCli("C:\\npm\\codex.cmd", ["100%"], { platform: "win32", execFile: fake });
            assert.strictEqual(unsafe.error, "UNSAFE_ARGUMENT");
            assert.strictEqual(calls.length, 2, "unsafe arguments never reach cmd.exe");
            const exe = await runCli("C:\\bin\\claude.exe", ["x"], { platform: "win32", execFile: fake });
            assert.strictEqual(exe.ok, true);
            assert.strictEqual(calls[2].file, "C:\\bin\\claude.exe");
            if (process.platform !== "win32") return;
            // 真实的 .cmd 包装：路径含空格、括号与 &，参数应原样到达
            const dir = path.join(base, "npm (x86) & co");
            fs.mkdirSync(dir, { recursive: true });
            const echo = path.join(dir, "echo-args.js");
            fs.writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
            const cmd = path.join(dir, "tool.cmd");
            fs.writeFileSync(cmd, `@"${process.execPath}" "%~dp0echo-args.js" %*\r\n`);
            const args = [
                "mcp",
                "add",
                "-e",
                "EMBERPROBE_MCP_TOOLSETS=core,debug",
                "--",
                "C:\\Program Files (x86)\\A & B\\Code.exe"
            ];
            const real = await runCli(cmd, args);
            assert.strictEqual(real.ok, true, real.stderr);
            assert.deepStrictEqual(JSON.parse(real.stdout), args);
        });

        await scenario("Install into Claude Code through its CLI after confirmation", async () => {
            const state = { pick: "claude", confirm: "mcp.install", executables: { claude: "C:\\npm\\claude.cmd" } };
            const { registration, cli, messages, clipboard, events, context } = setup({}, state);
            const result = await registration.installClient();
            assert.deepStrictEqual(
                state.picks.map((pick) => pick.client),
                ["claude", "codex", "cursor", "antigravity", "dsh", "json"]
            );
            assert.ok(state.picks[0].description.startsWith("mcp.method.cli"));
            assert.ok(state.picks[1].description.startsWith("mcp.method.cliMissing"));
            const launcher = path.join(context.globalStorageUri.fsPath, "mcp", "emberprobe-mcp.js");
            assert.ok(fs.existsSync(launcher), "the launcher is written before installing");
            const confirm = messages.find((message) => message[2]?.modal);
            assert.strictEqual(confirm[2].detail, result.snippet, "the exact command is shown before it runs");
            assert.deepStrictEqual(cli, [
                [
                    "C:\\npm\\claude.cmd",
                    ...installArgs("claude", { command: RUNTIME, args: [launcher], env: { ELECTRON_RUN_AS_NODE: "1" } })
                ]
            ]);
            assert.strictEqual(result.ok, true);
            assert.strictEqual(events.configured, 1);
            assert.ok(messages.at(-1)[1].startsWith("mcp.installed"));
            assert.strictEqual(clipboard.length, 0);
        });

        await scenario("Replace an existing entry only after the first add fails", async () => {
            const state = {
                pick: "codex",
                confirm: "mcp.install",
                executables: { codex: "/usr/bin/codex" },
                cliResults: [{ ok: false, stdout: "", stderr: "already exists", error: "1" }]
            };
            const { registration, cli, events } = setup({}, state);
            const result = await registration.installClient();
            assert.deepStrictEqual(
                cli.map((call) => call.slice(1, 3)),
                [
                    ["mcp", "add"],
                    ["mcp", "remove"],
                    ["mcp", "add"]
                ]
            );
            assert.strictEqual(result.ok, true);
            assert.strictEqual(events.configured, 1);
        });

        await scenario("Copy the command when the CLI fails, is missing or the user cancels", async () => {
            const failing = setup(
                {},
                {
                    pick: "codex",
                    confirm: "mcp.install",
                    executables: { codex: "/usr/bin/codex" },
                    cliResults: [
                        { ok: false, stdout: "", stderr: "x".repeat(400), error: "1" },
                        { ok: true, stdout: "", stderr: "" },
                        { ok: false, stdout: "", stderr: "config.toml is read-only", error: "1" }
                    ]
                }
            );
            const failed = await failing.registration.installClient();
            assert.strictEqual(failed.ok, false);
            assert.deepStrictEqual(failing.clipboard, [failed.snippet]);
            assert.ok(failing.messages.at(-1)[1].includes("config.toml is read-only"));
            assert.strictEqual(failing.events.configured, 0);

            const unsafe = setup(
                {},
                {
                    pick: "claude",
                    confirm: "mcp.install",
                    executables: { claude: "C:\\npm\\claude.cmd" },
                    cliResults: [{ ok: false, stdout: "", stderr: "", error: "UNSAFE_ARGUMENT" }]
                }
            );
            assert.strictEqual((await unsafe.registration.installClient()).ok, false);
            assert.strictEqual(unsafe.cli.length, 1, "an unsafe command is not retried with remove");

            const missing = setup({}, { pick: "claude" });
            const copied = await missing.registration.installClient();
            assert.strictEqual(copied.method, "clipboard");
            assert.deepStrictEqual(missing.clipboard, [copied.snippet]);
            assert.ok(copied.snippet.startsWith("claude mcp add --scope user emberprobe"));
            assert.strictEqual(missing.messages.at(-1)[0], "warn");
            assert.deepStrictEqual(missing.cli, []);

            const cancelled = setup({}, { pick: "claude", executables: { claude: "/usr/bin/claude" } });
            assert.strictEqual(await cancelled.registration.installClient(), null);
            assert.deepStrictEqual(cancelled.cli, []);
            assert.strictEqual(cancelled.events.configured, 0);

            const dismissed = setup({}, {});
            assert.strictEqual(
                await dismissed.registration.installClient(),
                null,
                "dismissing the picker does nothing"
            );
            assert.deepStrictEqual(dismissed.clipboard, []);
        });

        await scenario("Open the Cursor install link and copy other clients' JSON", async () => {
            const cursor = setup({}, { pick: "cursor" });
            const result = await cursor.registration.installClient();
            assert.strictEqual(result.method, "link");
            assert.deepStrictEqual(cursor.opened, [result.snippet]);
            assert.ok(
                result.snippet.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=emberprobe&config=")
            );
            assert.strictEqual(cursor.events.configured, 1);

            const blocked = setup({}, { pick: "cursor", openExternal: false });
            const fallback = await blocked.registration.installClient();
            assert.strictEqual(fallback.method, "clipboard");
            assert.deepStrictEqual(blocked.clipboard, [fallback.snippet]);

            const json = setup({}, { pick: "json" });
            const copied = await json.registration.installClient();
            assert.strictEqual(copied.method, "clipboard");
            assert.ok(JSON.parse(json.clipboard[0]).mcpServers.emberprobe.command);
            assert.strictEqual(json.messages.at(-1)[0], "info");
            assert.strictEqual(json.events.configured, 1);
        });

        await scenario(
            "Copy named client configurations with setup guidance and no CLI or link side effects",
            async () => {
                for (const client of ["antigravity", "dsh"]) {
                    const workspace = path.join(base, "MCU workspace");
                    const { registration, clipboard, cli, opened, messages, events, state } = setup(
                        {},
                        {
                            pick: client,
                            workspace
                        }
                    );
                    const result = await registration.installClient();
                    assert.strictEqual(result.client, client);
                    assert.strictEqual(result.method, "clipboard");
                    assert.deepStrictEqual(clipboard, [result.snippet]);
                    const spec =
                        client === "antigravity"
                            ? JSON.parse(result.snippet).mcpServers.emberprobe
                            : YAML.parse(result.snippet)[0].insert[0].config;
                    assert.strictEqual(spec.env.EMBERPROBE_WORKSPACE, workspace);
                    assert.ok(fs.existsSync(spec.args[0]), "the exported launcher exists");
                    assert.ok(
                        state.picks
                            .find((pick) => pick.client === client)
                            .description.startsWith(`mcp.method.${client}`)
                    );
                    assert.strictEqual(messages.at(-1)[1], `mcp.configCopied.${client}`);
                    assert.strictEqual(events.configured, 1);
                    assert.deepStrictEqual(cli, []);
                    assert.deepStrictEqual(opened, []);
                }
            }
        );

        await scenario("Hide the Cursor link inside Cursor and in remote windows", async () => {
            const inCursor = setup({ cursor: cursorApi() }, { pick: "json" });
            inCursor.registration.register();
            await inCursor.registration.installClient();
            assert.ok(!inCursor.state.picks.some((pick) => pick.client === "cursor"));
            const remote = setup({}, { pick: "json", remoteName: "wsl" });
            await remote.registration.installClient();
            assert.ok(!remote.state.picks.some((pick) => pick.client === "cursor"));
        });
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
    console.log("MCP registration tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
