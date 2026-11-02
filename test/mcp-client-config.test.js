"use strict";
const assert = require("assert");
const YAML = require("yaml");
const { scenario } = require("./helpers/scenario");
const { CLIENTS, configSnippet, installArgs } = require("../src/services/mcpClientConfig");

const spec = Object.freeze({
    command: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    args: Object.freeze(["C:\\用户\\Ember Probe\\mcp.js"]),
    env: Object.freeze({ ELECTRON_RUN_AS_NODE: "1", EMBERPROBE_MCP_TOOLSETS: "core,cubemx" })
});
const workspace = "C:\\工作区\\MCU #1: 'demo' & firmware";
const env = { ...spec.env, EMBERPROBE_WORKSPACE: workspace };

scenario("Export harness-specific JSON without changing the shared launch spec", () => {
    for (const client of ["claude", "gemini", "antigravity", "json"]) {
        const config = JSON.parse(configSnippet(client, spec, "win32", workspace)).mcpServers.emberprobe;
        const timeout =
            client === "gemini" ? { timeout: 1800000 } : client === "antigravity" ? { timeoutSeconds: 1800 } : {};
        assert.deepStrictEqual(config, { command: spec.command, args: spec.args, env, ...timeout });
        assert.ok(!Object.hasOwn(config, "trust"), "export must not disable client confirmations");
    }
    assert.ok(!Object.hasOwn(spec.env, "EMBERPROBE_WORKSPACE"));
    assert.ok(!Object.hasOwn(env, "EMBERPROBE_BRIDGE_INSTANCE"));
});

scenario("Export OpenCode local command arrays and environment rather than mcpServers", () => {
    const config = JSON.parse(configSnippet("opencode", spec, "win32", workspace));
    assert.deepStrictEqual(config, {
        mcp: {
            emberprobe: {
                type: "local",
                command: [spec.command, ...spec.args],
                environment: env,
                enabled: true,
                timeout: 1800000
            }
        }
    });
    const empty = JSON.parse(configSnippet("opencode", { command: "/s/mcp", args: [], env: {} }, "linux"));
    assert.deepStrictEqual(empty.mcp.emberprobe.command, ["/s/mcp"]);
    assert.ok(!Object.hasOwn(empty.mcp.emberprobe, "environment"));
});

scenario("Export Codex native TOML with escaped paths, quoted keys and second-based timeout", () => {
    const value = configSnippet("codex", spec, "win32", workspace);
    assert.strictEqual(
        value,
        "[mcp_servers.emberprobe]\n" +
            'command = "C:\\\\Program Files\\\\Microsoft VS Code\\\\Code.exe"\n' +
            'args = ["C:\\\\用户\\\\Ember Probe\\\\mcp.js"]\n' +
            "tool_timeout_sec = 1800\n\n" +
            "[mcp_servers.emberprobe.env]\n" +
            '"ELECTRON_RUN_AS_NODE" = "1"\n' +
            '"EMBERPROBE_MCP_TOOLSETS" = "core,cubemx"\n' +
            '"EMBERPROBE_WORKSPACE" = "C:\\\\工作区\\\\MCU #1: \'demo\' & firmware"\n'
    );
    const empty = configSnippet("codex", { command: "/s/mcp", args: [], env: {} }, "linux");
    assert.strictEqual(empty, '[mcp_servers.emberprobe]\ncommand = "/s/mcp"\nargs = []\ntool_timeout_sec = 1800\n');
    const escaped = configSnippet("codex", {
        command: '/home/o\'neil/"MCU"/mcp',
        args: ["one\ntwo", "tab\tend", "\u0000", "\u007f"],
        env: { 'key."\n': "value\\\r\u007f" }
    });
    assert.ok(escaped.includes('args = ["one\\ntwo", "tab\\tend", "\\u0000", "\\u007f"]'));
    assert.ok(escaped.includes('"key.\\"\\n" = "value\\\\\\r\\u007f"'));
    assert.ok(!/[\u0000\u007f\r]/.test(escaped));
});

scenario("Preserve DSH YAML and Cursor install-link formats", () => {
    const patch = YAML.parse(configSnippet("dsh", spec, "win32", workspace));
    assert.deepStrictEqual(patch[0].insert[0].config, {
        serverName: "emberprobe",
        transport: "stdio",
        command: spec.command,
        args: spec.args,
        env,
        toolCallTimeoutMs: 1800000
    });
    const link = new URL(configSnippet("cursor", spec, "win32", workspace));
    const config = JSON.parse(Buffer.from(link.searchParams.get("config"), "base64").toString());
    assert.deepStrictEqual(config, { command: spec.command, args: spec.args, env: spec.env });
});

scenario("Generate Gemini user-scope CLI arguments without granting client trust", () => {
    assert.deepStrictEqual(installArgs("gemini", spec), [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "stdio",
        "--timeout",
        "1800000",
        "--env",
        "ELECTRON_RUN_AS_NODE=1",
        "--env",
        "EMBERPROBE_MCP_TOOLSETS=core,cubemx",
        "emberprobe",
        spec.command,
        "--",
        ...spec.args
    ]);
});

scenario("Reject unknown clients and unsupported CLI adapters rather than using a different format", () => {
    assert.throws(() => configSnippet("unknown", spec), /Unsupported MCP client/);
    assert.throws(() => configSnippet("toString", spec), /Unsupported MCP client/);
    for (const client of CLIENTS.filter((name) => !["claude", "codex", "gemini"].includes(name))) {
        assert.throws(() => installArgs(client, spec), /No MCP install CLI/);
    }
});

console.log("MCP client configuration tests passed");
