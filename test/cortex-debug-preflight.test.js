"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    resolveDebugTools,
    ensureDebugTools,
    readWindowsPath,
    readCurrentPath
} = require("../src/services/cortexDebugPreflight");
const { executableName } = require("../src/services/cortexToolchainService");

(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-debug-preflight-")));
    try {
        const bin = path.join(root, "bin");
        fs.mkdirSync(bin);
        const tool = (name) => path.join(bin, executableName(`arm-none-eabi-${name}`));
        for (const name of ["gdb", "objdump", "nm"]) {
            fs.writeFileSync(tool(name), "fixture");
            fs.chmodSync(tool(name), 0o755);
        }
        const expected = {
            gdbPath: tool("gdb"),
            objdumpPath: tool("objdump"),
            armToolchainPath: bin,
            toolchainPrefix: "arm-none-eabi"
        };
        assert.deepStrictEqual(resolveDebugTools({ envPath: bin }), expected);
        assert.deepStrictEqual(resolveDebugTools({ toolchainPath: bin, envPath: "" }), expected);
        assert.deepStrictEqual(resolveDebugTools({ gdbPath: tool("gdb"), envPath: "" }), expected);
        assert.deepStrictEqual(resolveDebugTools({ configuredObjdump: tool("objdump"), envPath: "" }), expected);
        assert.strictEqual(resolveDebugTools({ gdbPath: path.join(root, "missing"), envPath: bin }), null);
        assert.strictEqual(resolveDebugTools({ gdbPath: bin, envPath: "" }), null);
        assert.strictEqual(resolveDebugTools({ toolchainPath: root, envPath: "" }), null);
        assert.strictEqual(resolveDebugTools({ toolchainPath: bin, prefix: "other", envPath: "" }), null);
        fs.unlinkSync(tool("nm"));
        assert.strictEqual(resolveDebugTools({ toolchainPath: bin, envPath: "" }), null);
        fs.writeFileSync(tool("nm"), "fixture");
        fs.chmodSync(tool("nm"), 0o755);

        const settings = { gdbPath: path.join(root, "missing") };
        const ownSettings = {};
        const saved = new Map();
        const state = { get: (key) => saved.get(key), update: async (key, value) => saved.set(key, value) };
        const folder = { uri: { toString: () => "workspace-one" } };
        let warning = "msg.selectDebugToolchain";
        let selections = [[{ fsPath: root }]];
        let errors = 0;
        const vscode = {
            workspace: {
                getConfiguration: (section, uri) => {
                    assert.ok(["cortex-debug", "emberprobe"].includes(section));
                    assert.strictEqual(uri, folder.uri);
                    return {
                        get: (key, fallback) =>
                            section === "emberprobe" ? (ownSettings[key] ?? fallback) : (settings[key] ?? fallback)
                    };
                }
            },
            window: {
                showWarningMessage: async () => warning,
                showOpenDialog: async () => selections.shift(),
                showErrorMessage: async () => {
                    errors++;
                    return "msg.selectDebugToolchain";
                }
            }
        };
        let currentPath = "";
        const run = () =>
            ensureDebugTools(
                vscode,
                folder,
                state,
                (key) => key,
                async () => currentPath
            );
        assert.deepStrictEqual(await run(), expected);
        assert.strictEqual(saved.get("emberprobeToolchain:workspace-one"), bin);
        warning = undefined;
        assert.deepStrictEqual(await run(), expected, "remembered directory works without prompting");
        saved.clear();
        assert.strictEqual(await run(), null, "dismissed warning cancels startup");
        warning = "msg.selectDebugToolchain";
        selections = [undefined];
        assert.strictEqual(await run(), null, "cancelled picker cancels startup");
        saved.set("cortexDebugToolchain:workspace-one", path.join(root, "removed"));
        selections = [[{ fsPath: path.join(root, "invalid") }], [{ fsPath: bin }]];
        assert.deepStrictEqual(await run(), expected);
        assert.strictEqual(errors, 1, "invalid directory can be corrected");
        settings.gdbPath = tool("gdb");
        warning = undefined;
        assert.deepStrictEqual(await run(), expected, "valid explicit settings take priority");
        settings.gdbPath = path.join(root, "missing");
        ownSettings.gdbPath = tool("gdb");
        assert.deepStrictEqual(await run(), expected, "EmberProbe settings override legacy configuration");
        ownSettings.gdbPath = path.join(root, "missing");
        assert.deepStrictEqual(
            await ensureDebugTools(
                vscode,
                folder,
                state,
                (key) => key,
                async () => "",
                { gdbPath: tool("gdb") }
            ),
            expected,
            "launch settings override EmberProbe settings"
        );
        delete ownSettings.gdbPath;
        saved.clear();
        delete settings.gdbPath;
        currentPath = bin;
        assert.deepStrictEqual(await run(), expected, "refreshed PATH works without restarting the host");
        assert.strictEqual(await readWindowsPath("linux"), "");
        const windowsPath = await readWindowsPath("win32", (file, args, options, callback) => {
            assert.ok(file.endsWith("powershell.exe"));
            assert.ok(args.includes("-NoProfile"));
            assert.strictEqual(options.windowsHide, true);
            assert.strictEqual(options.timeout, 5000);
            callback(null, "C:\\machine;\r\nC:\\user;\r\n");
        });
        assert.strictEqual(windowsPath, "C:\\machine;;C:\\user;");
        assert.strictEqual(
            await readWindowsPath("win32", (file, args, options, callback) => callback(new Error("timeout"), "")),
            "",
            "failed environment lookup falls back to manual selection"
        );
        for (const shell of ["/bin/bash", "/bin/zsh", "/usr/bin/fish", "/bin/sh", "/bin/dash", "/bin/ksh"]) {
            const refreshed = await readCurrentPath(
                "linux",
                (file, args, options, callback) => {
                    assert.strictEqual(file, shell);
                    assert.strictEqual(args[0], ["sh", "dash"].includes(path.basename(shell)) ? "-lc" : "-ilc");
                    assert.strictEqual(options.cwd, os.homedir());
                    assert.strictEqual(options.timeout, 5000);
                    assert.strictEqual(options.env.SHELL, shell);
                    callback(null, `profile banner\nPATH=/wrong\0\0EMBERPROBE_PATH\0${bin}\0trailing output`);
                },
                { SHELL: shell }
            );
            assert.strictEqual(refreshed, bin);
        }
        for (const output of ["banner only", "\0EMBERPROBE_PATH\0unterminated", "\0EMBERPROBE_PATH\0\0"]) {
            assert.strictEqual(
                await readCurrentPath("linux", (_file, _args, _opts, callback) => callback(null, output), {}),
                ""
            );
        }
        assert.strictEqual(
            await readCurrentPath("linux", (_file, _args, _opts, callback) => callback(new Error("timeout"), ""), {}),
            ""
        );
        for (const shell of ["relative/bash", "/bin/unsupported", "/bin/bash -c evil"]) {
            assert.strictEqual(
                await readCurrentPath(
                    "linux",
                    () => {
                        throw new Error("must not spawn");
                    },
                    { SHELL: shell }
                ),
                ""
            );
        }
        assert.strictEqual(
            await readCurrentPath("darwin", () => {
                throw new Error("must not spawn");
            }),
            ""
        );
        assert.strictEqual(
            await readCurrentPath("win32", (_file, _args, _opts, callback) => callback(null, "C:\\tools")),
            "C:\\tools"
        );
        console.log("Cortex-Debug preflight tests passed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
