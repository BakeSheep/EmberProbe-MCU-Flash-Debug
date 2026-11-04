"use strict";
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const jsonc = require("jsonc-parser");
const { getStaticTOMLValue, parseForESLint } = require("toml-eslint-parser");
const { scenario } = require("./helpers/scenario");
const { configSnippet } = require("../src/services/mcpClientConfig");
const { yamlTargets } = require("../src/services/mcpConfigEdits");
const {
    FILE_CLIENTS,
    MAX_CONFIG_BYTES,
    clientStatus,
    configTargets,
    prepareClientUninstall,
    prepareClientInstall,
    commitClientInstall
} = require("../src/services/mcpConfigFiles");

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-mcp-config-files-")));
const spec = { command: process.execPath, args: [path.join(base, "mcp.js")], env: { EMBERPROBE_MCP_TOOLSETS: "core" } };
let fixtureNumber = 0;
function fixture() {
    const home = path.join(base, `home-${++fixtureNumber}`);
    fs.mkdirSync(home);
    return { home, env: {} };
}
async function write(file, text) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, { mode: 0o640 });
}
function readServer(client, text) {
    if (client === "dsh") return yamlTargets(text).targets[0].toJSON().config;
    if (client === "codex") return getStaticTOMLValue(parseForESLint(text).ast).mcp_servers.emberprobe;
    return client === "opencode" ? jsonc.parse(text).mcp.emberprobe : JSON.parse(text).mcpServers.emberprobe;
}
function assertClean(home) {
    assert.deepStrictEqual(
        fs.readdirSync(home, { recursive: true }).filter((file) => /\.lock$|\.tmp$/.test(file)),
        []
    );
}

(async () => {
    try {
        await scenario("Automatically install every named file-based client without needing its CLI", async () => {
            for (const client of FILE_CLIENTS) {
                const options = fixture();
                const snippet = configSnippet(client, spec);
                const plan = await prepareClientInstall(client, snippet, options);
                assert.ok(
                    plan.files.every((entry) => !fs.existsSync(entry.file)),
                    "planning writes no client files"
                );
                const result = await commitClientInstall(plan);
                assert.strictEqual(result.changed, client === "dsh" ? 2 : 1);
                for (const file of result.files) {
                    const server = readServer(client, fs.readFileSync(file, "utf8"));
                    assert.ok(!Object.hasOwn(server.env || server.environment, "EMBERPROBE_WORKSPACE"));
                    assert.strictEqual(client === "opencode" ? server.command[0] : server.command, spec.command);
                    if (process.platform !== "win32") assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
                }
                const second = await prepareClientInstall(client, snippet, options);
                assert.strictEqual(
                    (await commitClientInstall(second)).changed,
                    0,
                    "reinstallation avoids replacing unchanged files"
                );
                assertClean(options.home);
            }
        });

        await scenario("Resolve native paths and supported environment overrides", async () => {
            const options = fixture();
            const custom = path.join(options.home, "custom");
            assert.deepStrictEqual((await configTargets("claude", options)).targets, [
                path.join(options.home, ".claude.json")
            ]);
            for (const [client, env, expected] of [
                ["claude", { CLAUDE_CONFIG_DIR: custom }, path.join(custom, ".claude.json")],
                ["codex", { CODEX_HOME: custom }, path.join(custom, "config.toml")],
                [
                    "opencode",
                    { OPENCODE_CONFIG: path.join(custom, "special.jsonc") },
                    path.join(custom, "special.jsonc")
                ],
                ["opencode", { XDG_CONFIG_HOME: custom }, path.join(custom, "opencode", "opencode.json")]
            ])
                assert.deepStrictEqual((await configTargets(client, { ...options, env })).targets, [expected]);
            const dsh = await configTargets("dsh", { ...options, env: { DSH_HOME: custom } });
            assert.deepStrictEqual(
                dsh.targets,
                ["web", "desktop"].map((name) => path.join(custom, "profiles", name, "cordis.patch.yml"))
            );
            for (const [client, env] of [
                ["codex", { CODEX_HOME: "relative" }],
                ["opencode", { OPENCODE_CONFIG: "relative.json" }]
            ]) {
                await assert.rejects(configTargets(client, { ...options, env }), /absolute paths/);
            }
            await assert.rejects(configTargets("json", options), /No configuration file adapter/);
            await assert.rejects(configTargets("toString", options), /No configuration file adapter/);
        });

        await scenario("Stay in user-level files and prefer OpenCode JSONC over JSON", async () => {
            const options = fixture();
            const project = path.join(options.home, "project");
            const dir = path.join(options.home, ".config", "opencode");
            await write(path.join(dir, "opencode.json"), "{}");
            await write(path.join(dir, "opencode.jsonc"), "{} // global");
            assert.deepStrictEqual((await configTargets("opencode", options)).targets, [
                path.join(dir, "opencode.jsonc")
            ]);
            await write(path.join(project, "opencode.json"), "{}");
            await write(path.join(project, ".agents", "mcp_config.json"), "{}");
            const cwd = process.cwd();
            process.chdir(project);
            try {
                assert.deepStrictEqual((await configTargets("opencode", options)).targets, [
                    path.join(dir, "opencode.jsonc")
                ]);
                assert.deepStrictEqual((await configTargets("antigravity", options)).targets, [
                    path.join(options.home, ".gemini", "config", "mcp_config.json")
                ]);
            } finally {
                process.chdir(cwd);
            }
        });

        await scenario("Report each client as absent, current or outdated without writing", async () => {
            for (const client of FILE_CLIENTS) {
                const options = fixture();
                const snippet = configSnippet(client, spec);
                const { targets } = await configTargets(client, options);
                assert.deepStrictEqual(await clientStatus(client, snippet, options), {
                    state: "notInstalled",
                    files: targets
                });
                assert.deepStrictEqual(fs.readdirSync(options.home), [], "reading the status writes nothing");
                await commitClientInstall(await prepareClientInstall(client, snippet, options));
                assert.strictEqual((await clientStatus(client, snippet, options)).state, "installed", client);
                const moved = { ...spec, command: `${spec.command}-moved` };
                assert.strictEqual(
                    (await clientStatus(client, configSnippet(client, moved), options)).state,
                    "outdated",
                    client
                );
            }
        });

        await scenario("Treat a stale workspace binding and a partial install as outdated", async () => {
            const options = fixture();
            const snippet = configSnippet("claude", spec);
            const file = (await configTargets("claude", options)).targets[0];
            await commitClientInstall(await prepareClientInstall("claude", snippet, options));
            const value = JSON.parse(fs.readFileSync(file, "utf8"));
            value.mcpServers.emberprobe.env.EMBERPROBE_WORKSPACE = "/old";
            value.mcpServers.emberprobe.custom = "kept";
            await write(file, JSON.stringify(value));
            assert.strictEqual((await clientStatus("claude", snippet, options)).state, "outdated");
            await commitClientInstall(await prepareClientInstall("claude", snippet, options));
            assert.strictEqual((await clientStatus("claude", snippet, options)).state, "installed");
            assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.emberprobe.custom, "kept");

            const dsh = fixture();
            const dshSnippet = configSnippet("dsh", spec);
            await commitClientInstall(await prepareClientInstall("dsh", dshSnippet, dsh));
            fs.rmSync((await configTargets("dsh", dsh)).targets[1]);
            assert.strictEqual((await clientStatus("dsh", dshSnippet, dsh)).state, "outdated");
        });

        await scenario("Read Cursor's own file and surface unreadable configuration", async () => {
            const options = fixture();
            const snippet = configSnippet("json", spec);
            const file = path.join(options.home, ".cursor", "mcp.json");
            assert.strictEqual((await clientStatus("cursor", snippet, options)).state, "notInstalled");
            await write(file, JSON.stringify(JSON.parse(snippet)));
            assert.strictEqual((await clientStatus("cursor", snippet, options)).state, "installed");
            await write(file, "{broken");
            await assert.rejects(clientStatus("cursor", snippet, options), /Invalid or unsupported JSON/);
        });

        await scenario("Uninstall every client and leave missing files absent", async () => {
            for (const client of FILE_CLIENTS) {
                const options = fixture();
                const snippet = configSnippet(client, spec);
                const empty = await prepareClientUninstall(client, options);
                assert.deepStrictEqual(empty.files, [], "nothing to remove from files that do not exist");
                assert.strictEqual((await commitClientInstall(empty)).changed, 0);
                assert.deepStrictEqual(fs.readdirSync(options.home), []);
                await commitClientInstall(await prepareClientInstall(client, snippet, options));
                const result = await commitClientInstall(await prepareClientUninstall(client, options));
                assert.strictEqual(result.changed, client === "dsh" ? 2 : 1);
                assert.strictEqual((await clientStatus(client, snippet, options)).state, "notInstalled", client);
                assertClean(options.home);
            }
        });

        await scenario("Refuse to uninstall through a file changed after the preview", async () => {
            const options = fixture();
            const snippet = configSnippet("gemini", spec);
            await commitClientInstall(await prepareClientInstall("gemini", snippet, options));
            const plan = await prepareClientUninstall("gemini", options);
            await write(plan.files[0].file, '{"mcpServers":{"emberprobe":{},"added":{}}}');
            await assert.rejects(commitClientInstall(plan), /changed during installation/);
            assert.ok(fs.readFileSync(plan.files[0].file, "utf8").includes("added"));
        });

        await scenario("Write DSH Web/Desktop and initialized Headless/ACP profiles without touching SDK", async () => {
            const options = fixture();
            const root = path.join(options.home, ".dsh");
            for (const name of ["web", "headless", "acp", "sdk"])
                await write(path.join(root, "profiles", name, "cordis.patch.yml"), "# native\n[]\n");
            const plan = await prepareClientInstall("dsh", configSnippet("dsh", spec), options);
            assert.strictEqual(plan.files.length, 4);
            await commitClientInstall(plan);
            assert.strictEqual(
                fs.readFileSync(path.join(root, "profiles", "sdk", "cordis.patch.yml"), "utf8"),
                "# native\n[]\n"
            );
            assertClean(options.home);
        });

        await scenario("Preserve existing file permissions and UTF-8 BOM", async () => {
            const options = fixture();
            const file = path.join(options.home, ".claude.json");
            await write(file, '\ufeff{"mcpServers":{"other":{"command":"keep"}}}');
            const mode = fs.statSync(file).mode & 0o777;
            const plan = await prepareClientInstall("claude", configSnippet("claude", spec), options);
            await commitClientInstall(plan);
            assert.ok(fs.readFileSync(file, "utf8").startsWith("\ufeff"));
            assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8").slice(1)).mcpServers.other.command, "keep");
            if (process.platform !== "win32") assert.strictEqual(fs.statSync(file).mode & 0o777, mode);
        });

        await scenario("Reject malformed, oversized, non-file or non-UTF8 configuration before any write", async () => {
            for (const content of ['{"bad":', Buffer.alloc(MAX_CONFIG_BYTES + 1), Buffer.from([0xff, 0xfe])]) {
                const options = fixture();
                const file = path.join(options.home, ".claude.json");
                await write(file, content);
                const before = fs.readFileSync(file);
                await assert.rejects(prepareClientInstall("claude", configSnippet("claude", spec), options));
                assert.deepStrictEqual(fs.readFileSync(file), before);
                assertClean(options.home);
            }
            const options = fixture();
            const file = path.join(options.home, ".claude.json");
            fs.mkdirSync(file);
            await assert.rejects(
                prepareClientInstall("claude", configSnippet("claude", spec), options),
                /must be a file/
            );
            fs.rmdirSync(file);
            await write(file, "{}");
            await assert.rejects(
                prepareClientInstall("claude", configSnippet("claude", spec), {
                    ...options,
                    io: { ...fsp, readFile: async () => Buffer.alloc(MAX_CONFIG_BYTES + 1) }
                }),
                /exceeds 2 MiB/
            );
            await assert.rejects(
                configTargets("opencode", {
                    ...options,
                    io: {
                        ...fsp,
                        stat: async () => {
                            throw Object.assign(new Error("denied"), { code: "EACCES" });
                        }
                    }
                }),
                /denied/
            );
        });

        await scenario("Protect edits made after the file preview and respect an existing writer lock", async () => {
            const options = fixture();
            const file = path.join(options.home, ".claude.json");
            await write(file, "{}");
            const plan = await prepareClientInstall("claude", configSnippet("claude", spec), options);
            await write(file, '{"newer":"keep"}');
            await assert.rejects(commitClientInstall(plan), /changed during installation/);
            assert.strictEqual(fs.readFileSync(file, "utf8"), '{"newer":"keep"}');
            assertClean(options.home);
            const fresh = await prepareClientInstall("claude", configSnippet("claude", spec), options);
            await write(file + ".emberprobe.lock", "native writer");
            await assert.rejects(commitClientInstall(fresh), /locked by another writer/);
            assert.strictEqual(fs.readFileSync(file + ".emberprobe.lock", "utf8"), "native writer");
            await fsp.unlink(file + ".emberprobe.lock");
        });

        await scenario(
            "Refuse a DSH home override before writing profiles, including changes after preview",
            async () => {
                const options = fixture();
                const root = path.join(options.home, ".dsh", "cordis.patch.yml");
                const snippet = configSnippet("dsh", spec);
                const plan = await prepareClientInstall("dsh", snippet, options);
                await write(root, snippet);
                await assert.rejects(commitClientInstall(plan), /changed during installation/);
                assert.ok(plan.files.every((entry) => !fs.existsSync(entry.file)));
                await assert.rejects(prepareClientInstall("dsh", snippet, options), /home cordis.patch.yml overrides/);
                assertClean(options.home);
            }
        );

        await scenario("Roll back every committed DSH profile if a later replacement fails", async () => {
            const options = fixture();
            const snippet = configSnippet("dsh", spec);
            const { targets } = await configTargets("dsh", options);
            for (const file of targets) await write(file, "# original\n[]\n");
            const plan = await prepareClientInstall("dsh", snippet, options);
            let injected = false;
            const io = {
                ...fsp,
                rename: async (from, to) => {
                    if (to === plan.files[1].file && !injected) {
                        injected = true;
                        throw new Error("injected replacement failure");
                    }
                    return fsp.rename(from, to);
                }
            };
            await assert.rejects(commitClientInstall(plan, { io }), /injected replacement failure/);
            for (const file of targets) assert.strictEqual(fs.readFileSync(file, "utf8"), "# original\n[]\n");
            assertClean(options.home);
        });

        await scenario("Remove a newly created profile on rollback and preserve newer external edits", async () => {
            for (const externalEdit of [false, true]) {
                const options = fixture();
                const plan = await prepareClientInstall("dsh", configSnippet("dsh", spec), options);
                const io = {
                    ...fsp,
                    rename: async (from, to) => {
                        if (to === plan.files[1].file) {
                            if (externalEdit) await fsp.writeFile(plan.files[0].file, "# newer external edit\n[]\n");
                            throw new Error("injected failure");
                        }
                        return fsp.rename(from, to);
                    }
                };
                await assert.rejects(
                    commitClientInstall(plan, { io }),
                    externalEdit ? /rollback could not restore/ : /injected failure/
                );
                if (externalEdit)
                    assert.strictEqual(fs.readFileSync(plan.files[0].file, "utf8"), "# newer external edit\n[]\n");
                else assert.ok(!fs.existsSync(plan.files[0].file));
                assertClean(options.home);
            }
        });

        await scenario("Clean up staged files and locks when staging or lock creation fails", async () => {
            for (const where of ["stage", "lock"]) {
                const options = fixture();
                const plan = await prepareClientInstall("dsh", configSnippet("dsh", spec), options);
                let calls = 0;
                const io = {
                    ...fsp,
                    open: async (...args) => {
                        const match = where === "stage" ? args[0].endsWith(".tmp") : args[0].endsWith(".lock");
                        if (match && ++calls === 2) throw new Error(`${where} denied`);
                        return fsp.open(...args);
                    }
                };
                await assert.rejects(commitClientInstall(plan, { io }), /denied/);
                assert.ok(plan.files.every((entry) => !fs.existsSync(entry.file)));
                assertClean(options.home);
            }
        });

        await scenario("Deduplicate linked DSH profiles and reject a link redirected after preview", async () => {
            const options = fixture();
            const profiles = path.join(options.home, ".dsh", "profiles");
            const shared = path.join(profiles, "shared");
            const another = path.join(profiles, "another");
            fs.mkdirSync(shared, { recursive: true });
            fs.mkdirSync(another);
            const type = process.platform === "win32" ? "junction" : "dir";
            for (const name of ["web", "desktop"]) fs.symlinkSync(shared, path.join(profiles, name), type);
            const plan = await prepareClientInstall("dsh", configSnippet("dsh", spec), options);
            assert.strictEqual(plan.files.length, 1);
            fs.unlinkSync(path.join(profiles, "desktop"));
            fs.symlinkSync(another, path.join(profiles, "desktop"), type);
            await assert.rejects(commitClientInstall(plan), /path changed/);
            assert.ok(!fs.existsSync(plan.files[0].file));
            assertClean(options.home);
        });
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
    console.log("MCP native configuration file tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
