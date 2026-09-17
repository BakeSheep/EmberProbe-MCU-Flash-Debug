"use strict";

const fs = require("fs");
const path = require("path");

function normalizeTransport(value = "auto") {
    if (!["auto", "swd", "jtag", "hla_swd", "hla_jtag"].includes(value)) {
        throw Object.assign(new Error(`Unsupported OpenOCD transport: ${value}`), {
            code: "OPENOCD_TRANSPORT_INVALID"
        });
    }
    return value;
}

function buildOpenOcdConfigArgs(launch, transport = "auto") {
    normalizeTransport(transport);
    return [
        "-s",
        launch.scriptsRoot,
        "-f",
        launch.probePath,
        ...(transport === "auto" ? [] : ["-c", `transport select ${transport}`]),
        "-f",
        launch.targetPath
    ];
}

function assertNativeExecutable(file) {
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
        throw Object.assign(new Error("Select the actual OpenOCD executable, not a .cmd/.bat wrapper"), {
            code: "OPENOCD_EXECUTABLE_UNSUPPORTED"
        });
    }
}

// OpenOCD accepts configuration paths relative to its scripts directory.
// Allow vendor subdirectories (for example geehy/apm32f4x.cfg), while rejecting
// absolute paths, Windows separators, control characters and path traversal.
function isSafeCfgPath(value) {
    if (typeof value !== "string" || !value.endsWith(".cfg") || value.includes("\\")) return false;
    if (value.startsWith("/") || /[\x00-\x1f:]/.test(value)) return false;
    const parts = value.split("/");
    return parts.length > 0 && parts.every((part) => part && part !== "." && part !== "..");
}

function resolveExecutablePath(executable) {
    const configured = String(executable || "").trim();
    if (!configured) return "";
    assertNativeExecutable(configured);
    if (configured.includes("/") || configured.includes("\\")) {
        const absolute = path.resolve(configured);
        try {
            return fs.realpathSync(absolute);
        } catch (error) {
            return absolute;
        }
    }
    const pathEntries = String(process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean);
    const extensions =
        process.platform === "win32"
            ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
                  .split(";")
                  .filter(Boolean)
            : [""];
    for (const entry of pathEntries) {
        for (const extension of extensions) {
            const candidate = path.join(
                entry,
                process.platform === "win32" && !path.extname(configured)
                    ? configured + extension.toLowerCase()
                    : configured
            );
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                if (!fs.statSync(candidate).isFile()) continue;
                assertNativeExecutable(candidate);
                return fs.realpathSync(candidate);
            } catch (error) {
                if (error.code === "OPENOCD_EXECUTABLE_UNSUPPORTED") throw error;
                /* try the next PATH entry */
            }
        }
    }
    return configured;
}

function scriptsRootCandidates(executable) {
    const binary = resolveExecutablePath(executable);
    if (!binary || (!binary.includes("/") && !binary.includes("\\"))) return [];
    const prefix = path.dirname(path.dirname(binary));
    const candidates = [
        process.env.OPENOCD_SCRIPTS,
        path.join(prefix, "scripts"),
        // xPack archives keep bin/ and openocd/scripts/ as siblings.
        path.join(prefix, "openocd", "scripts"),
        // System packages and EmberProbe's bundled build use share/openocd/scripts/.
        path.join(prefix, "share", "openocd", "scripts")
    ].filter(Boolean);
    return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function resolveConfigFile(scriptsRoot, kind, config) {
    if (!isSafeCfgPath(config) || (kind !== "interface" && kind !== "target")) {
        throw Object.assign(new Error(`非法的 OpenOCD ${kind} 配置名：${config}`), { code: "OPENOCD_CONFIG_INVALID" });
    }
    let base;
    const candidate = path.join(scriptsRoot, kind, ...config.split("/"));
    let resolved;
    try {
        base = fs.realpathSync(path.join(scriptsRoot, kind));
        resolved = fs.realpathSync(candidate);
        if (!fs.statSync(resolved).isFile()) throw new Error("Not a configuration file");
    } catch (error) {
        throw Object.assign(new Error(`OpenOCD 配置脚本不存在：${kind}/${config}`), {
            code: "OPENOCD_CONFIG_NOT_FOUND",
            details: { candidate }
        });
    }
    const relative = path.relative(base, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw Object.assign(new Error(`OpenOCD 配置脚本越界：${kind}/${config}`), { code: "OPENOCD_CONFIG_INVALID" });
    }
    return resolved;
}

// OpenOCD 会优先从 cwd 查找相对脚本。所有启动入口都应该使用这个解析结果，
// 并以 scriptsRoot 作为 OpenOCD 的 cwd，防止工作区中的 target/ / interface/ / mem_helper.tcl 遮蔽官方脚本。
function resolveOpenOcdLaunch(executable, probe, target, transport = "auto") {
    normalizeTransport(transport);
    const resolvedExecutable = resolveExecutablePath(executable);
    try {
        if (!fs.statSync(resolvedExecutable).isFile()) throw new Error("Not a file");
        fs.accessSync(resolvedExecutable, fs.constants.X_OK);
    } catch (cause) {
        throw Object.assign(new Error(`OpenOCD executable is missing or not executable: ${executable}`), {
            code: "OPENOCD_NOT_FOUND",
            cause
        });
    }
    const scriptsRoot = findScriptsRoot(resolvedExecutable);
    if (!scriptsRoot) {
        throw Object.assign(new Error(`无法定位与 OpenOCD 匹配的 scripts 目录：${executable}`), {
            code: "OPENOCD_SCRIPTS_NOT_FOUND"
        });
    }
    const canonicalRoot = fs.realpathSync(scriptsRoot);
    return {
        executable: resolvedExecutable,
        scriptsRoot: canonicalRoot,
        cwd: canonicalRoot,
        probePath: resolveConfigFile(canonicalRoot, "interface", probe),
        targetPath: resolveConfigFile(canonicalRoot, "target", target)
    };
}

function findScriptsRoot(executable) {
    for (const candidate of scriptsRootCandidates(executable)) {
        try {
            if (fs.statSync(path.join(candidate, "target")).isDirectory()) return candidate;
        } catch (error) {
            /* try the next supported layout */
        }
    }
    return "";
}

function walkCfgFiles(root, current = root, output = []) {
    let entries;
    try {
        entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
        return output;
    }
    for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) walkCfgFiles(root, absolute, output);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cfg")) {
            const relative = path.relative(root, absolute).split(path.sep).join("/");
            if (isSafeCfgPath(relative)) output.push(relative);
        }
    }
    return output;
}

function discoverTargetConfigs(executable) {
    const scriptsRoot = findScriptsRoot(executable);
    if (!scriptsRoot) return [];
    return walkCfgFiles(path.join(scriptsRoot, "target")).sort((a, b) =>
        a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })
    );
}

function discoverInterfaceConfigs(executable) {
    const scriptsRoot = findScriptsRoot(executable);
    if (!scriptsRoot) return [];
    return walkCfgFiles(path.join(scriptsRoot, "interface")).sort((a, b) =>
        a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })
    );
}

module.exports = {
    normalizeTransport,
    buildOpenOcdConfigArgs,
    isSafeCfgPath,
    resolveExecutablePath,
    scriptsRootCandidates,
    findScriptsRoot,
    resolveConfigFile,
    resolveOpenOcdLaunch,
    discoverTargetConfigs,
    discoverInterfaceConfigs
};
