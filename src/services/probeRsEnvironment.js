"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function probeRsInstallCandidates(options = {}) {
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const home = options.home || os.homedir();
    const paths = platform === "win32" ? path.win32 : path.posix;
    const binary = platform === "win32" ? "probe-rs.exe" : "probe-rs";
    const override = env.PROBE_RS_TOOLS_INSTALL_DIR || env.CARGO_DIST_FORCE_INSTALL_DIR;
    const roots = [override, env.CARGO_HOME, paths.join(home, ".cargo")].filter(Boolean);
    return [...new Set(roots.map((root) => paths.resolve(root, "bin", binary)))];
}

// An existing VS Code process may not have the PATH written by the official installer.
function resolveProbeRsExecutable(executable, options = {}) {
    const target = String(executable || "").trim();
    const platform = options.platform || process.platform;
    if (target !== "probe-rs" && !(platform === "win32" && target === "probe-rs.exe")) return target;
    const env = options.env || process.env;
    const paths = platform === "win32" ? path.win32 : path.posix;
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
    const directories = String(env[pathKey] || "")
        .split(platform === "win32" ? ";" : ":")
        .map((directory) => directory.replace(/^"|"$/g, ""))
        .filter((directory) => paths.isAbsolute(directory));
    const binary = platform === "win32" ? "probe-rs.exe" : "probe-rs";
    const candidates = [
        ...directories.map((directory) => paths.join(directory, binary)),
        ...probeRsInstallCandidates(options)
    ];
    for (const candidate of candidates) {
        try {
            if (!fs.statSync(candidate).isFile()) continue;
            fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
            return candidate;
        } catch {
            // Keep searching the standard user installation directories.
        }
    }
    return target;
}

module.exports = { probeRsInstallCandidates, resolveProbeRsExecutable };
