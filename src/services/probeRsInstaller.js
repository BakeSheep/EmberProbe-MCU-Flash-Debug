"use strict";

const { execFile } = require("child_process");
const os = require("os");
const path = require("path");

const INSTALLATION_URL = "https://probe.rs/docs/getting-started/installation/";
const WINDOWS_INSTALL_COMMAND =
    "irm https://github.com/probe-rs/probe-rs/releases/latest/download/probe-rs-tools-installer.ps1 | iex";
const UNIX_INSTALL_COMMAND =
    "curl --proto '=https' --tlsv1.2 -LsSf https://github.com/probe-rs/probe-rs/releases/latest/download/probe-rs-tools-installer.sh | sh";

function canInstallProbeRs(platform = process.platform) {
    return ["win32", "linux", "darwin"].includes(platform);
}

function probeRsInstallerCommand(platform = process.platform, env = process.env) {
    if (platform === "win32") {
        return {
            executable: path.win32.join(
                env.SystemRoot || "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe"
            ),
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "$ErrorActionPreference = 'Stop'; $InformationPreference = 'Continue'; " +
                    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " +
                    WINDOWS_INSTALL_COMMAND
            ]
        };
    }
    if (platform === "linux" || platform === "darwin")
        return { executable: "/bin/bash", args: ["-o", "pipefail", "-c", UNIX_INSTALL_COMMAND] };
    throw Object.assign(new Error(`probe-rs installation is unavailable on ${platform}`), {
        code: "PROBE_RS_INSTALL_UNSUPPORTED"
    });
}

// Execute only the fixed official command. User paths never enter a shell command.
function installProbeRs(options = {}) {
    const command = probeRsInstallerCommand(options.platform, options.env);
    return new Promise((resolve, reject) => {
        const child = (options.run || execFile)(
            command.executable,
            command.args,
            {
                cwd: os.tmpdir(),
                env: options.env || process.env,
                windowsHide: true,
                timeout: options.timeoutMs || 10 * 60 * 1000,
                maxBuffer: 1024 * 1024
            },
            (error, stdout, stderr) => {
                if (error) {
                    const detail = String(stderr || stdout || error.message)
                        .trim()
                        .slice(-2000);
                    reject(Object.assign(new Error(detail), { code: "PROBE_RS_INSTALL_FAILED", cause: error }));
                } else resolve(true);
            }
        );
        for (const stream of [child.stdout, child.stderr]) {
            if (!stream) continue;
            let pending = "";
            stream.setEncoding("utf8");
            const report = (line) => {
                const text = line
                    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
                    .trim()
                    .slice(0, 300);
                if (text) options.onLine?.(text);
            };
            stream.on("data", (chunk) => {
                const lines = (pending + chunk).split(/[\r\n]/);
                pending = lines.pop().slice(-4096);
                for (const line of lines) report(line);
            });
            stream.on("end", () => report(pending));
        }
    });
}

module.exports = {
    INSTALLATION_URL,
    WINDOWS_INSTALL_COMMAND,
    UNIX_INSTALL_COMMAND,
    canInstallProbeRs,
    probeRsInstallerCommand,
    installProbeRs
};
