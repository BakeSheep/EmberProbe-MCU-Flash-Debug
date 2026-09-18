"use strict";

const fs = require("fs");
const path = require("path");

function executableName(name, platform = process.platform) {
    return platform === "win32" && !/\.exe$/i.test(name) ? `${name}.exe` : name;
}

function isExecutable(file) {
    if (!file) return false;
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function findOnPath(name, envPath = process.env.PATH || "", platform = process.platform) {
    const executable = executableName(name, platform);
    for (const entry of String(envPath).split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(entry, executable);
        if (isExecutable(candidate)) {
            try {
                return fs.realpathSync(candidate);
            } catch {
                return candidate;
            }
        }
    }
    return "";
}

function siblingNm(objdumpPath) {
    const base = path.basename(String(objdumpPath || ""));
    if (!/^.*objdump(?:\.exe)?$/i.test(base)) return "";
    const nm = base.replace(/objdump(\.exe)?$/i, "nm$1");
    return path.join(path.dirname(objdumpPath), nm);
}

function validObjdumpPair(objdumpPath) {
    if (!isExecutable(objdumpPath)) return null;
    const nmPath = siblingNm(objdumpPath);
    return nmPath && isExecutable(nmPath) ? { objdumpPath, nmPath } : null;
}

function resolveCortexToolchain(options = {}) {
    const platform = options.platform || process.platform;
    const prefix = String(options.prefix || "arm-none-eabi").replace(/-+$/, "");
    const candidates = [];
    if (options.configuredObjdump) {
        const configured = String(options.configuredObjdump);
        candidates.push(
            path.isAbsolute(configured) || configured.includes(path.sep)
                ? configured
                : findOnPath(configured, options.envPath, platform)
        );
    }
    if (options.toolchainPath)
        candidates.push(path.join(String(options.toolchainPath), executableName(`${prefix}-objdump`, platform)));
    candidates.push(findOnPath(`${prefix}-objdump`, options.envPath, platform));
    candidates.push(findOnPath("objdump", options.envPath, platform));
    for (const candidate of candidates.filter(Boolean)) {
        const pair = validObjdumpPair(candidate);
        if (pair) return pair;
    }
    return null;
}

function resolveCortexToolchainForWorkspace(vscode, folder) {
    const cfg = vscode.workspace.getConfiguration("cortex-debug", folder?.uri);
    const own = vscode.workspace.getConfiguration("emberprobe", folder?.uri);
    const platformKey = process.platform === "darwin" ? "osx" : process.platform;
    return resolveCortexToolchain({
        configuredObjdump: own.get("objdumpPath") || cfg.get(`objdumpPath.${platformKey}`) || cfg.get("objdumpPath"),
        toolchainPath:
            own.get("armToolchainPath") || cfg.get(`armToolchainPath.${platformKey}`) || cfg.get("armToolchainPath"),
        prefix: own.get("armToolchainPrefix") || cfg.get("armToolchainPrefix", "arm-none-eabi"),
        envPath: process.env.PATH,
        platform: process.platform
    });
}

module.exports = {
    executableName,
    findOnPath,
    siblingNm,
    validObjdumpPair,
    resolveCortexToolchain,
    resolveCortexToolchainForWorkspace
};
