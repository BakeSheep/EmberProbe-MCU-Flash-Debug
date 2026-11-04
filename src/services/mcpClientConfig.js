"use strict";
// Client-specific MCP formats. Keep one stdio launch spec; translate only at the client boundary, as cc-switch does.
const SERVER_NAME = "emberprobe";
const CLIENTS = Object.freeze(["claude", "codex", "gemini", "opencode", "cursor", "antigravity", "dsh", "json"]);
const CLI_CLIENTS = Object.freeze({ claude: "claude", codex: "codex", gemini: "gemini" });
// Covers human confirmation and CubeMX without changing Bridge operation budgets.
const LONG_CALL_TIMEOUT_MS = 30 * 60 * 1000;

function stdioConfig(spec) {
    return { command: spec.command, args: spec.args, ...(Object.keys(spec.env).length ? { env: spec.env } : {}) };
}

function cursorInstallLink(spec) {
    const config = Buffer.from(JSON.stringify(stdioConfig(spec))).toString("base64");
    return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

// JSON basic strings also work in TOML; TOML additionally prohibits a literal DEL character.
function tomlString(value) {
    return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

function codexConfig(config) {
    return [
        `[mcp_servers.${SERVER_NAME}]`,
        `command = ${tomlString(config.command)}`,
        `args = [${config.args.map(tomlString).join(", ")}]`,
        `tool_timeout_sec = ${LONG_CALL_TIMEOUT_MS / 1000}`,
        ...(config.env
            ? [
                  "",
                  `[mcp_servers.${SERVER_NAME}.env]`,
                  ...Object.entries(config.env).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
              ]
            : []),
        ""
    ].join("\n");
}

function dshConfig(config) {
    const values = {
        serverName: SERVER_NAME,
        transport: "stdio",
        ...config,
        toolCallTimeoutMs: LONG_CALL_TIMEOUT_MS
    };
    // JSON flow values are valid YAML; escape line breaks YAML would otherwise normalize.
    return [
        "- insert:",
        "    - id: mcp-emberprobe",
        '      name: "@deepseek-ai/dsh-mcp-client"',
        "      config:",
        ...Object.entries(values).map(([key, value]) => {
            const scalar = JSON.stringify(value).replace(
                /[\u0085\u2028\u2029]/g,
                (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
            );
            return `        ${key}: ${scalar}`;
        }),
        ""
    ].join("\n");
}

/**
 * Native configuration for clipboard/manual merging, or Cursor's install link. It lands in user-level configuration
 * shared by every project, so the server locates the Bridge through MCP roots or its working directory: neither a
 * workspace binding nor an ephemeral Bridge instance, token or port is added.
 * @param {string} client
 * @param {{ command: string, args: string[], env: Record<string, string> }} spec
 */
function configSnippet(client, spec) {
    if (!CLIENTS.includes(client)) throw new Error(`Unsupported MCP client: ${client}`);
    if (client === "cursor") return cursorInstallLink(spec);
    const config = stdioConfig(spec);
    if (client === "codex") return codexConfig(config);
    if (client === "dsh") return dshConfig(config);
    if (client === "opencode") {
        return JSON.stringify(
            {
                mcp: {
                    [SERVER_NAME]: {
                        type: "local",
                        command: [config.command, ...config.args],
                        ...(config.env ? { environment: config.env } : {}),
                        enabled: true,
                        timeout: LONG_CALL_TIMEOUT_MS
                    }
                }
            },
            null,
            2
        );
    }
    const timeout =
        client === "gemini"
            ? { timeout: LONG_CALL_TIMEOUT_MS }
            : client === "antigravity"
              ? { timeoutSeconds: LONG_CALL_TIMEOUT_MS / 1000 }
              : {};
    return JSON.stringify({ mcpServers: { [SERVER_NAME]: { ...config, ...timeout } } }, null, 2);
}

function installArgs(client, spec) {
    const env = Object.entries(spec.env).map(([key, value]) => `${key}=${value}`);
    if (client === "claude")
        // Claude's -e is variadic: put the server name before environment options.
        return [
            "mcp",
            "add",
            "--scope",
            "user",
            SERVER_NAME,
            ...env.flatMap((item) => ["-e", item]),
            "--",
            spec.command,
            ...spec.args
        ];
    if (client === "codex")
        return ["mcp", "add", SERVER_NAME, ...env.flatMap((item) => ["--env", item]), "--", spec.command, ...spec.args];
    if (client === "gemini")
        return [
            "mcp",
            "add",
            "--scope",
            "user",
            "--transport",
            "stdio",
            "--timeout",
            String(LONG_CALL_TIMEOUT_MS),
            ...env.flatMap((item) => ["--env", item]),
            SERVER_NAME,
            spec.command,
            "--",
            ...spec.args
        ];
    throw new Error(`No MCP install CLI for client: ${client}`);
}

module.exports = { CLIENTS, CLI_CLIENTS, SERVER_NAME, configSnippet, cursorInstallLink, installArgs };
