"use strict";
const assert = require("assert");
const jsonc = require("jsonc-parser");
const YAML = require("yaml");
const { parseForESLint, getStaticTOMLValue } = require("toml-eslint-parser");
const { scenario } = require("./helpers/scenario");
const { editConfig, yamlTargets } = require("../src/services/mcpConfigEdits");
const { configSnippet } = require("../src/services/mcpClientConfig");

const spec = { command: "C:\\Program Files\\Code.exe", args: ["C:\\用户\\mcp.js"], env: { ELECTRON_RUN_AS_NODE: "1" } };
const snippet = (client, workspace = "/project") => configSnippet(client, spec, "win32", workspace);
const parseToml = (text) => getStaticTOMLValue(parseForESLint(text).ast);

scenario("Merge JSON server fields without replacing user settings or custom options", () => {
    for (const client of ["claude", "gemini", "antigravity"]) {
        const original =
            '{"token":"kept","mcpServers":{"other":{"command":"keep"},"emberprobe":{"command":"old","env":{"CUSTOM":"keep"},"disabledTools":["flash_program"]}}}';
        const next = editConfig(client, original, snippet(client));
        const value = JSON.parse(next);
        assert.strictEqual(value.token, "kept");
        assert.strictEqual(value.mcpServers.other.command, "keep");
        assert.strictEqual(value.mcpServers.emberprobe.command, spec.command);
        assert.deepStrictEqual(value.mcpServers.emberprobe.disabledTools, ["flash_program"]);
        assert.deepStrictEqual(value.mcpServers.emberprobe.env, {
            CUSTOM: "keep",
            ...spec.env,
            EMBERPROBE_WORKSPACE: "/project"
        });
        assert.strictEqual(editConfig(client, next, snippet(client)), next, "reinstallation is byte-idempotent");
    }
});

scenario("Preserve OpenCode JSONC comments and CRLF while switching a remote entry to local", () => {
    const before =
        '{\r\n\t// model and credentials\r\n\t"model": "keep",\r\n\t"mcp": {"other":{"type":"remote","url":"https://keep"},"emberprobe":{"type":"remote","url":"https://old","headers":{"X":"secret"},"custom":123}},\r\n}\r\n';
    const next = editConfig("opencode", before, snippet("opencode"));
    assert.ok(next.startsWith('{\r\n\t// model and credentials\r\n\t"model": "keep",'));
    const value = jsonc.parse(next);
    assert.deepStrictEqual(value.mcp.other, { type: "remote", url: "https://keep" });
    assert.strictEqual(value.mcp.emberprobe.custom, 123);
    assert.deepStrictEqual(value.mcp.emberprobe.command, [spec.command, ...spec.args]);
    assert.ok(!Object.hasOwn(value.mcp.emberprobe, "url"));
    assert.ok(!Object.hasOwn(value.mcp.emberprobe, "headers"));
    assert.strictEqual(value.mcp.emberprobe.environment.EMBERPROBE_WORKSPACE, "/project");
});

scenario("Do not retain a stale manual workspace binding when exporting without an open folder", () => {
    const original = '{"mcpServers":{"emberprobe":{"env":{"EMBERPROBE_WORKSPACE":"/old","CUSTOM":"keep"}}}}';
    const value = JSON.parse(editConfig("claude", original, snippet("claude", "")));
    assert.ok(!Object.hasOwn(value.mcpServers.emberprobe.env, "EMBERPROBE_WORKSPACE"));
    assert.strictEqual(value.mcpServers.emberprobe.env.CUSTOM, "keep");
});

scenario("Reject ambiguous or malformed JSON without exposing its contents in errors", () => {
    for (const original of [
        '{"secret":"DO_NOT_ECHO",broken}',
        "[]",
        '{"mcpServers":[]}',
        '{"mcpServers":{"emberprobe":null}}',
        '{"mcpServers":{"emberprobe":{"env":[]}}}',
        '{"mcpServers":{},"mcpServers":{}}',
        '{"a":1,}',
        "// comment\n{}"
    ]) {
        assert.throws(
            () => editConfig("claude", original, snippet("claude")),
            (error) => {
                assert.ok(!error.message.includes("DO_NOT_ECHO"));
                return /JSON/.test(error.message);
            }
        );
    }
    assert.throws(() => editConfig("unknown", "{}", "{}"), /No configuration file adapter/);
});

scenario("Edit native TOML values while preserving models, comments and multiline strings", () => {
    const original =
        '# user header\nmodel = "keep"\nprompt = """\n[mcp_servers.emberprobe]\nnot a real table\n"""\n[mcp_servers.emberprobe] # server comment\ncommand = "old" # retain this comment\nurl = "https://old"\ndisabled_tools = ["flash_program"]\n[mcp_servers.emberprobe.env]\nCUSTOM = "keep"\n[mcp_servers.other]\ncommand = "keep"\n[model_providers.custom]\nbase_url = "https://keep"\n';
    const next = editConfig("codex", original, snippet("codex"));
    assert.ok(next.startsWith(original.slice(0, original.indexOf('command = "old"'))));
    assert.ok(next.includes("# retain this comment"));
    assert.ok(
        next.endsWith('[mcp_servers.other]\ncommand = "keep"\n[model_providers.custom]\nbase_url = "https://keep"\n')
    );
    const value = parseToml(next);
    assert.strictEqual(value.model, "keep");
    assert.strictEqual(value.mcp_servers.emberprobe.command, spec.command);
    assert.strictEqual(value.mcp_servers.emberprobe.tool_timeout_sec, 1800);
    assert.strictEqual(value.mcp_servers.emberprobe.env.CUSTOM, "keep");
    assert.ok(!Object.hasOwn(value.mcp_servers.emberprobe, "url"));
    assert.deepStrictEqual(value.mcp_servers.emberprobe.disabled_tools, ["flash_program"]);
    assert.strictEqual(editConfig("codex", next, snippet("codex")), next);
});

scenario("Support Codex inline tables, dotted keys and empty configuration", () => {
    for (const original of [
        "",
        '# comment\nmodel="keep"',
        'mcp_servers = { other = { command="keep" } }\n',
        'mcp_servers = { emberprobe = { url="old", env={CUSTOM="keep"} }, other={command="keep"} }\n',
        '[mcp_servers]\nemberprobe.command="old"\nemberprobe.env.EMBERPROBE_WORKSPACE="/old"\nother.command="keep"\n',
        '[mcp_servers.emberprobe]\ncommand="old"',
        'mcp_servers.emberprobe = { command="old", url="old" }\n'
    ]) {
        const next = editConfig("codex", original, snippet("codex", ""));
        const value = parseToml(next);
        assert.strictEqual(value.mcp_servers.emberprobe.command, spec.command);
        assert.deepStrictEqual(value.mcp_servers.emberprobe.args, spec.args);
        assert.strictEqual(value.mcp_servers.emberprobe.tool_timeout_sec, 1800);
        assert.ok(!Object.hasOwn(value.mcp_servers.emberprobe.env, "EMBERPROBE_WORKSPACE"));
        if (value.mcp_servers.other) assert.strictEqual(value.mcp_servers.other.command, "keep");
        assert.strictEqual(editConfig("codex", next, snippet("codex", "")), next);
    }
});

scenario("Reject malformed TOML tables, duplicate keys and invalid environment shapes", () => {
    for (const original of [
        'x = "DO_NOT_ECHO',
        "mcp_servers=3",
        "mcp_servers.emberprobe=false",
        "mcp_servers.emberprobe.env=[]",
        "x=1\nx=2"
    ]) {
        assert.throws(
            () => editConfig("codex", original, snippet("codex")),
            (error) => /TOML/.test(error.message) && !error.message.includes("DO_NOT_ECHO")
        );
    }
});

scenario("Reject TOML prototype keys before static conversion, including inline tables in arrays", () => {
    for (const text of [
        "[__proto__]\nemberprobePolluted = true",
        "items=[{__proto__.emberprobePolluted=true}]",
        "constructor.prototype.emberprobePolluted=true"
    ]) {
        assert.throws(() => editConfig("codex", text, snippet("codex")), /TOML/);
        assert.ok(!Object.hasOwn(Object.prototype, "emberprobePolluted"));
    }
});

scenario("Append DSH MCP patches without reserializing unrelated YAML tags or comments", () => {
    for (const original of [
        "",
        "# profile\n[]\n",
        '- id: native\n  config: !!js "() => 1"\n',
        "[{id: native, config: {keep: true}}]\n"
    ]) {
        const next = editConfig("dsh", original, snippet("dsh"));
        assert.strictEqual(yamlTargets(next).targets.length, 1);
        if (original.includes("!!js")) assert.ok(next.startsWith(original));
        if (original.startsWith("#")) assert.ok(next.startsWith("# profile\n"));
        assert.strictEqual(editConfig("dsh", next, snippet("dsh")), next);
    }
});

scenario("Update an existing DSH server by name, retaining its id and custom options", () => {
    const prefix = '- id: native\n  config: !!js "() => 1"\n';
    const original =
        prefix +
        '- insert:\n    - id: custom-id\n      name: "@deepseek-ai/dsh-mcp-client"\n      disabled: true\n      config:\n        serverName: emberprobe\n        transport: streamable-http\n        url: https://old\n        custom: 123\n        env: {CUSTOM: keep}\n';
    const next = editConfig("dsh", original, snippet("dsh", "/project\u0085one\u2028two\u2029three"));
    assert.ok(next.startsWith(prefix));
    const entry = yamlTargets(next).targets[0].toJSON();
    assert.strictEqual(entry.id, "custom-id");
    assert.strictEqual(entry.disabled, false);
    assert.strictEqual(entry.config.transport, "stdio");
    assert.strictEqual(entry.config.custom, 123);
    assert.strictEqual(entry.config.env.CUSTOM, "keep");
    assert.strictEqual(entry.config.env.EMBERPROBE_WORKSPACE, "/project\u0085one\u2028two\u2029three");
    assert.ok(!Object.hasOwn(entry.config, "url"));
    const noWorkspace = editConfig("dsh", next, snippet("dsh", ""));
    assert.ok(!Object.hasOwn(yamlTargets(noWorkspace).targets[0].toJSON().config.env, "EMBERPROBE_WORKSPACE"));
});

scenario("Refuse DSH duplicate servers, id collisions, aliases and tagged managed nodes", () => {
    const own = YAML.parse(snippet("dsh"))[0].insert[0];
    for (const text of [
        "config: {}",
        "- insert: {}",
        "- null",
        "- id: mcp-emberprobe\n  name: other",
        YAML.stringify([{ insert: [own, { ...own, id: "second" }] }]),
        YAML.stringify([{ id: "mcp-emberprobe", config: {} }, { insert: [own] }]),
        '- insert:\n    - &managed\n      id: mcp-emberprobe\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: {serverName: emberprobe, transport: stdio, command: old}\n',
        '- insert:\n    - id: mcp-emberprobe\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: {serverName: emberprobe, env: []}\n'
    ])
        assert.throws(() => editConfig("dsh", text, snippet("dsh")), /DSH YAML/);
});

console.log("MCP native configuration edit tests passed");
