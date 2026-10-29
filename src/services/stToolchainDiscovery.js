"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { executableName } = require("./cortexToolchainService");

// Known layouts only: no recursive disk/workspace search and no tool execution.
function stToolchainCandidates(options = {}) {
    const platform = options.platform || process.platform;
    if (!["win32", "linux", "darwin"].includes(platform)) return [];
    const env = options.env || process.env;
    const home =
        options.home ??
        ((platform === "win32" ? env.USERPROFILE || env.HOME : env.HOME) || (options.env ? "" : os.homedir()));
    const data =
        platform === "win32"
            ? env.LOCALAPPDATA || (home && path.join(home, "AppData", "Local"))
            : platform === "linux"
              ? env.XDG_DATA_HOME || (home && path.join(home, ".local", "share"))
              : home && path.join(home, "Library", "Application Support");
    let remainingEntries = 4096;
    function directories(directory, pattern) {
        if (!directory || !path.isAbsolute(directory) || remainingEntries <= 0) return [];
        let handle;
        const names = [];
        try {
            handle = fs.opendirSync(directory);
            for (let count = 0; count < 256 && remainingEntries > 0; count++, remainingEntries--) {
                const entry = handle.readSync();
                if (!entry) break;
                if (entry.isDirectory() && pattern.test(entry.name)) names.push(entry.name);
            }
        } catch {
            // Missing, removed, or inaccessible installations are optional candidates.
        } finally {
            handle?.closeSync();
        }
        return names.sort((a, b) => b.localeCompare(a, "en", { numeric: true })).slice(0, 32);
    }
    const candidates = [];
    const bundleRoot = data && path.isAbsolute(data) && path.join(data, "stm32cube", "bundles");
    if (bundleRoot) {
        const gdbRoot = path.join(bundleRoot, "gnu-gdb-for-stm32");
        const versions = /^\d+(?:\.\d+)*(?:[-+][\w.-]+)?$/;
        const gdbBins = directories(gdbRoot, versions).map((version) => path.join(gdbRoot, version, "bin"));
        const toolsRoot = path.join(bundleRoot, "gnu-tools-for-stm32");
        for (const version of directories(toolsRoot, versions)) {
            const toolchainPath = path.join(toolsRoot, version, "bin");
            candidates.push({ toolchainPath });
            for (const bin of gdbBins)
                candidates.push({
                    toolchainPath,
                    gdbPath: path.join(bin, executableName("arm-none-eabi-gdb", platform))
                });
        }
    }
    const roots =
        options.roots ||
        (platform === "win32"
            ? [
                  "C:\\ST",
                  ...[env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
                      .filter(Boolean)
                      .flatMap((root) => [path.join(root, "STMicroelectronics"), path.join(root, "ST")])
              ]
            : platform === "linux"
              ? ["/opt/st", "/opt/ST", "/opt", "/usr/local/STMicroelectronics", home && path.join(home, "ST")]
              : ["/Applications/STMicroelectronics", "/Applications", home && path.join(home, "Applications")]);
    for (const root of new Set(roots.filter((root) => typeof root === "string" && path.isAbsolute(root)))) {
        const installs = [root];
        for (const name of directories(root, /^stm32cube(?:clt|ide)(?:[_\d.-]|$)/i))
            installs.push(path.join(root, name));
        for (const install of installs) {
            candidates.push({ toolchainPath: path.join(install, "GNU-tools-for-STM32", "bin") });
            for (const plugins of [
                path.join(install, "plugins"),
                path.join(install, "STM32CubeIDE", "plugins"),
                path.join(install, "Contents", "Eclipse", "plugins")
            ]) {
                for (const name of directories(
                    plugins,
                    /^com\.st\.stm32cube\.ide\.mcu\.externaltools\.gnu-tools-for-stm32[._-]/i
                ))
                    candidates.push({ toolchainPath: path.join(plugins, name, "tools", "bin") });
            }
        }
    }
    return candidates.map((candidate) => ({ ...candidate, platform }));
}

module.exports = { stToolchainCandidates };
