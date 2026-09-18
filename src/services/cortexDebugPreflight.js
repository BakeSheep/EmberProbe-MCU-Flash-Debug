"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const { executableName, findOnPath, resolveCortexToolchain } = require("./cortexToolchainService");

function resolveDebugTools(options = {}) {
    const platform = options.platform || process.platform;
    const prefix = String(options.prefix || "arm-none-eabi").replace(/-+$/, "");
    const pair =
        options.gdbPath && path.isAbsolute(options.gdbPath) && !options.toolchainPath && !options.configuredObjdump
            ? resolveCortexToolchain({ ...options, toolchainPath: path.dirname(options.gdbPath) })
            : resolveCortexToolchain(options);
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

function readCurrentPath(platform = process.platform, run = execFile, env = process.env) {
    if (platform === "win32") return readWindowsPath(platform, run);
    if (platform !== "linux") return Promise.resolve("");
    // Read the user's login/interactive profile after a toolchain install. Never execute
    // workspace content or interpolate configuration into shell code. Bound slow profiles.
    const shell = env.SHELL || "/bin/sh";
    const name = path.basename(shell);
    if (!path.isAbsolute(shell) || !["bash", "zsh", "fish", "sh", "dash", "ksh"].includes(name))
        return Promise.resolve("");
    const marker = "\0EMBERPROBE_PATH\0";
    return new Promise((resolve) => {
        run(
            shell,
            [
                ["sh", "dash"].includes(name) ? "-lc" : "-ilc",
                "printf '\\000EMBERPROBE_PATH\\000'; /usr/bin/printenv -0 PATH"
            ],
            { cwd: os.homedir(), env, timeout: 5000, maxBuffer: 128 * 1024, encoding: "utf8" },
            (error, stdout) => {
                if (error) return resolve("");
                const output = String(stdout);
                const start = output.indexOf(marker);
                if (start < 0) return resolve("");
                const end = output.indexOf("\0", start + marker.length);
                resolve(end < 0 ? "" : output.slice(start + marker.length, end));
            }
        );
    });
}

async function ensureDebugTools(vscode, folder, state, t, readPath = readCurrentPath, launch = {}) {
    const cfg = vscode.workspace.getConfiguration("cortex-debug", folder.uri);
    const own = vscode.workspace.getConfiguration("emberprobe", folder.uri);
    const platformKey = process.platform === "darwin" ? "osx" : process.platform;
    const setting = (name) => launch[name] || own.get(name) || cfg.get(`${name}.${platformKey}`) || cfg.get(name);
    const options = {
        gdbPath: setting("gdbPath"),
        configuredObjdump: setting("objdumpPath"),
        toolchainPath: setting("armToolchainPath"),
        prefix: setting("armToolchainPrefix") || "arm-none-eabi"
    };
    const configured = resolveDebugTools({ ...options, envPath: "" });
    if (configured) return configured;
    const key = `emberprobeToolchain:${folder.uri.toString()}`;
    const selectedOptions = { prefix: options.prefix, envPath: "" };
    const saved = state.get(key) || state.get(`cortexDebugToolchain:${folder.uri.toString()}`);
    if (saved) {
        const tools = resolveDebugTools({ ...selectedOptions, toolchainPath: saved });
        if (tools) return tools;
    }
    const fromPath = resolveDebugTools(options);
    if (fromPath) return fromPath;
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

module.exports = { resolveDebugTools, ensureDebugTools, readWindowsPath, readCurrentPath };
