"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    resolveDebugTools,
    findDebugTools,
    findWarmupDebugTools,
    ensureDebugTools,
    readWindowsPath,
    readCurrentPath
} = require("../src/services/debugToolPreflight");
const { executableName } = require("../src/services/cortexToolchainService");

(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-debug-preflight-")));
    const originalPath = process.env.PATH;
    process.env.PATH = "";
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

        const ownSettings = { gdbPath: path.join(root, "missing") };
        const saved = new Map();
        const state = { get: (key) => saved.get(key), update: async (key, value) => saved.set(key, value) };
        const folder = { uri: { toString: () => "workspace-one" } };
        let warning = "msg.selectDebugToolchain";
        let selections = [[{ fsPath: root }]];
        let errors = 0;
        const vscode = {
            workspace: {
                getConfiguration: (section, uri) => {
                    assert.strictEqual(section, "emberprobe", "Cortex-Debug settings are not consulted");
                    assert.strictEqual(uri, folder.uri);
                    return { get: (key, fallback) => ownSettings[key] ?? fallback };
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
        let discovered = null;
        let discoveryCalls = 0;
        const discover = () => {
            discoveryCalls++;
            return discovered;
        };
        const run = () =>
            ensureDebugTools(
                vscode,
                folder,
                state,
                (key) => key,
                async () => currentPath,
                {},
                discover
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
        // A toolchain directory remembered for Cortex-Debug is no longer reused.
        saved.set("cortexDebugToolchain:workspace-one", bin);
        selections = [[{ fsPath: path.join(root, "invalid") }], [{ fsPath: bin }]];
        assert.deepStrictEqual(await run(), expected);
        assert.strictEqual(errors, 1, "invalid directory can be corrected");
        ownSettings.gdbPath = tool("gdb");
        warning = undefined;
        assert.deepStrictEqual(await run(), expected, "valid explicit settings take priority");
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
        saved.clear();
        const prompts = { ...vscode.window };
        vscode.window.showWarningMessage = async () => assert.fail("background lookup never prompts");
        assert.strictEqual(
            findDebugTools(vscode, folder, state, {}, discover),
            null,
            "background lookup never prompts"
        );
        saved.set("emberprobeToolchain:workspace-one", bin);
        assert.deepStrictEqual(
            findDebugTools(vscode, folder, state, {}, discover),
            expected,
            "background lookup uses the saved choice"
        );
        saved.clear();
        delete ownSettings.gdbPath;
        Object.assign(vscode.window, prompts);
        currentPath = bin;
        assert.deepStrictEqual(await run(), expected, "refreshed PATH works without restarting the host");
        const warmupLookup = (readPath, discoverTools = discover, platform = "win32") =>
            findWarmupDebugTools(vscode, folder, state, readPath, discoverTools, platform);
        assert.deepStrictEqual(
            await warmupLookup(
                async () => bin,
                () => assert.fail("refreshed PATH must precede ST discovery")
            ),
            expected,
            "Windows background warm-up resolves the same refreshed PATH as launch"
        );
        ownSettings.armToolchainPath = bin;
        assert.deepStrictEqual(
            await warmupLookup(() => assert.fail("configured tools need no system PATH refresh")),
            expected
        );
        delete ownSettings.armToolchainPath;
        assert.strictEqual(
            await warmupLookup(() => assert.fail("background must not run a login shell"), discover, "linux"),
            null
        );
        vscode.window.showWarningMessage = async () => assert.fail("warm-up must never prompt");
        assert.strictEqual(await warmupLookup(async () => ""), null);
        Object.assign(vscode.window, prompts);
        const otherBin = path.join(root, "other-bin");
        fs.mkdirSync(otherBin);
        for (const name of ["gdb", "objdump", "nm"]) {
            fs.copyFileSync(tool(name), path.join(otherBin, path.basename(tool(name))));
            fs.chmodSync(path.join(otherBin, path.basename(tool(name))), 0o755);
        }
        const other = resolveDebugTools({ toolchainPath: otherBin, envPath: "" });
        discovered = other;
        discoveryCalls = 0;
        ownSettings.gdbPath = tool("gdb");
        saved.set("emberprobeToolchain:workspace-one", otherBin);
        process.env.PATH = otherBin;
        assert.deepStrictEqual(await run(), expected, "explicit settings beat saved, PATH and ST installations");
        assert.strictEqual(discoveryCalls, 0);
        ownSettings.gdbPath = path.join(root, "missing");
        saved.set("emberprobeToolchain:workspace-one", bin);
        assert.deepStrictEqual(await run(), expected, "remembered directory beats PATH and ST installations");
        assert.strictEqual(discoveryCalls, 0);
        saved.set("emberprobeToolchain:workspace-one", path.join(root, "removed"));
        assert.deepStrictEqual(await run(), other, "PATH recovers from stale explicit and remembered paths");
        assert.strictEqual(discoveryCalls, 0);
        process.env.PATH = "";
        assert.deepStrictEqual(await run(), expected, "refreshed PATH beats ST installations even with stale settings");
        assert.strictEqual(discoveryCalls, 0);
        currentPath = "";
        vscode.window.showWarningMessage = async () => assert.fail("installed ST tools prevent the picker");
        assert.deepStrictEqual(await run(), other, "ST discovery precedes the missing-toolchain prompt");
        assert.strictEqual(
            saved.get("emberprobeToolchain:workspace-one"),
            path.join(root, "removed"),
            "discovery does not overwrite the remembered manual choice"
        );
        assert.deepStrictEqual(
            findDebugTools(vscode, folder, state, {}, discover),
            other,
            "background lookup also discovers ST tools without prompting"
        );
        discovered = null;
        Object.assign(vscode.window, prompts);
        warning = "msg.selectDebugToolchain";
        selections = [[{ fsPath: bin }]];
        assert.deepStrictEqual(await run(), expected, "missing ST tools fall back to manual selection");
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
        console.log("Debug tool preflight tests passed");
    } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
