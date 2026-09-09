"use strict";

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { executableName, findOnPath, resolveCortexToolchain } = require("./cortexToolchainService");

function resolveDebugTools(options = {}) {
    const platform = options.platform || process.platform;
    const prefix = String(options.prefix || "arm-none-eabi").replace(/-+$/, "");
    const pair = resolveCortexToolchain(options);
    const candidates = options.gdbPath
        ? [options.gdbPath]
        : [
              options.toolchainPath && path.join(options.toolchainPath, executableName(`${prefix}-gdb`, platform)),
              pair && path.join(path.dirname(pair.objdumpPath), executableName(`${prefix}-gdb`, platform)),
              findOnPath(`${prefix}-gdb`, options.envPath, platform)
          ];
    for (const candidate of candidates.filter(Boolean)) {
        const file = path.isAbsolute(candidate) ? candidate : findOnPath(candidate, options.envPath, platform);
        try {
            fs.accessSync(file, fs.constants.X_OK);
            if (!fs.statSync(file).isFile()) continue;
            const tools = pair || resolveCortexToolchain({ ...options, toolchainPath: path.dirname(file) });
            if (tools) {
                return {
                    gdbPath: file,
                    objdumpPath: tools.objdumpPath,
                    armToolchainPath: path.dirname(tools.objdumpPath),
                    toolchainPrefix: prefix
                };
            }
        } catch {
            // Missing executables are handled by the directory picker before probe acquisition.
        }
    }
    return null;
}

function readWindowsPath(platform = process.platform, run = execFile) {
    if (platform !== "win32") return Promise.resolve("");
    const powershell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
    );
    return new Promise((resolve) => {
        run(
            powershell,
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
                    "[Environment]::GetEnvironmentVariable('Path', 'Machine'); " +
                    "[Environment]::GetEnvironmentVariable('Path', 'User')"
            ],
            { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: "utf8" },
            (error, stdout) => resolve(error ? "" : String(stdout).trim().split(/\r?\n/).join(";"))
        );
    });
}

async function ensureDebugTools(vscode, folder, state, t, readPath = readWindowsPath) {
    const cfg = vscode.workspace.getConfiguration("cortex-debug", folder.uri);
    const platformKey = process.platform === "darwin" ? "osx" : process.platform;
    const setting = (name) => cfg.get(`${name}.${platformKey}`) || cfg.get(name);
    const options = {
        gdbPath: setting("gdbPath"),
        configuredObjdump: setting("objdumpPath"),
        toolchainPath: setting("armToolchainPath"),
        prefix: cfg.get("armToolchainPrefix", "arm-none-eabi")
    };
    const configured = resolveDebugTools(options);
    if (configured) return configured;
    const key = `cortexDebugToolchain:${folder.uri.toString()}`;
    const selectedOptions = { prefix: options.prefix, envPath: "" };
    const saved = state.get(key);
    if (saved) {
        const tools = resolveDebugTools({ ...selectedOptions, toolchainPath: saved });
        if (tools) return tools;
    }
    // Long-running VS Code processes may still hold PATH from before toolchain installation.
    const currentPath = await readPath();
    if (currentPath) {
        const tools = resolveDebugTools({ ...options, envPath: currentPath });
        if (tools) return tools;
    }
    const select = t("msg.selectDebugToolchain");
    if ((await vscode.window.showWarningMessage(t("msg.debugToolchainMissing"), select)) !== select) return null;
    while (true) {
        const selection = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: select,
            title: t("msg.debugToolchainDirectory")
        });
        if (!selection?.length) return null;
        const directory = selection[0].fsPath;
        for (const toolchainPath of [directory, path.join(directory, "bin")]) {
            const tools = resolveDebugTools({ ...selectedOptions, toolchainPath });
            if (tools) {
                await state.update(key, toolchainPath);
                return tools;
            }
        }
        if ((await vscode.window.showErrorMessage(t("msg.debugToolchainInvalid"), select)) !== select) return null;
    }
}

module.exports = { resolveDebugTools, ensureDebugTools, readWindowsPath };
