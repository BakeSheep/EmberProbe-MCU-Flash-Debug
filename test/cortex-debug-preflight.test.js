"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveDebugTools, ensureDebugTools, readWindowsPath } = require("../src/services/cortexDebugPreflight");
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
        const saved = new Map();
        const state = { get: (key) => saved.get(key), update: async (key, value) => saved.set(key, value) };
        const folder = { uri: { toString: () => "workspace-one" } };
        let warning = "msg.selectDebugToolchain";
        let selections = [[{ fsPath: root }]];
        let errors = 0;
        const vscode = {
            workspace: {
                getConfiguration: (section, uri) => {
                    assert.strictEqual(section, "cortex-debug");
                    assert.strictEqual(uri, folder.uri);
                    return { get: (key, fallback) => settings[key] ?? fallback };
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
        assert.strictEqual(saved.get("cortexDebugToolchain:workspace-one"), bin);
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
        saved.clear();
        delete settings.gdbPath;
        currentPath = bin;
        assert.deepStrictEqual(await run(), expected, "newly saved Windows PATH works without restarting the host");
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
        console.log("Cortex-Debug preflight tests passed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
