"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeProbeSerial, normalizeAdapterSpeed } = require("./probe-connection");

function normalizeTransport(value = "auto") {
    if (!["auto", "swd", "jtag", "hla_swd", "hla_jtag"].includes(value)) {
        throw Object.assign(new Error(`Unsupported OpenOCD transport: ${value}`), {
            code: "OPENOCD_TRANSPORT_INVALID"
        });
    }
    return value;
}

// Cortex-Debug 1.12.1 lists these OpenOCD names, plus "none" so a workspace can explicitly opt out
// even when the target .cfg already sets -rtos. The bundled xPack OpenOCD 0.12.0-7 also compiles
// hwthread and rtkernel; both are deliberately withheld because hwthread reports a single unnamed
// thread and rtkernel is RTEMS-only, so either looks like a bug when picked by accident.
// Names are case-sensitive: OpenOCD compares them with strcmp, so never lowercase the input.
const OPENOCD_RTOS_NAMES = Object.freeze([
    "auto",
    "none",
    "FreeRTOS",
    "ThreadX",
    "chibios",
    "Chromium-EC",
    "eCos",
    "embKernel",
    "linux",
    "mqx",
    "nuttx",
    "RIOT",
    "uCOS-III",
    "Zephyr"
]);

function normalizeRtos(value = "") {
    if (value === undefined || value === null) return "";
    const name = typeof value === "string" ? value.trim() : String(value);
    // An empty value turns RTOS awareness off, which is distinct from "none" (tell OpenOCD
    // explicitly). Anything else must be an allow-listed name; non-strings never are.
    if (name === "" && typeof value === "string") return "";
    if (!OPENOCD_RTOS_NAMES.includes(name)) {
        // A bare ${name} renders as nothing for values such as [], which reads as a broken sentence.
        const shown = name ? `"${name}"` : `${JSON.stringify(value)} (normalizes to an empty name)`;
        throw Object.assign(
            new Error(`Unsupported OpenOCD RTOS: ${shown}. Expected one of: ${OPENOCD_RTOS_NAMES.join(", ")}`),
            { code: "OPENOCD_RTOS_INVALID" }
        );
    }
    return name;
}

// OpenOCD needs -rtos on the *current* target after the target config is loaded and before init,
// which is what Cortex-Debug's CDRTOSConfigure does. Unlike Cortex-Debug this raises a Tcl error
// instead of logging to stderr, so OpenOCD exits non-zero and the caller's existing startup
// cleanup reports the failure instead of silently degrading to a non-RTOS session.
// The interpolated name is normalizeRtos's return value, so it can only be an allow-listed member
// matching /^[A-Za-z0-9-]+$/ -- no Tcl metacharacter can reach the command string.
function buildOpenOcdRtosArgs(rtos, allTargets = false) {
    const name = normalizeRtos(rtos);
    if (!name) return [];
    if (allTargets)
        return ["-c", `foreach _ep_rtos_target [target names] { $_ep_rtos_target configure -rtos ${name} }`];
    return [
        "-c",
        `set _ep_rtos_target ""; catch { set _ep_rtos_target [target current] }; ` +
            `if { $_ep_rtos_target eq "" } { error "EmberProbe: no current target to configure for RTOS ${name}" }; ` +
            `$_ep_rtos_target configure -rtos ${name}`
    ];
}

// A core is an OpenOCD target, not an RTOS thread. Keep absent fields absent so
// existing single-target launches retain their command stream.
/** @returns {{numberOfProcessors?: number, targetProcessor?: number, targetName?: string}} */
function normalizeTargetSelection(config = {}) {
    const keys = ["numberOfProcessors", "targetProcessor", "targetName"];
    if (keys.every((key) => config[key] === undefined)) return {};
    const count = config.numberOfProcessors ?? 1;
    const core = config.targetProcessor ?? 0;
    if (!Number.isInteger(count) || count < 1 || count > 32 || !Number.isInteger(core) || core < 0 || core >= count)
        throw Object.assign(new Error("OpenOCD core selection requires 1..32 processors and an in-range core index"), {
            code: "OPENOCD_TARGET_INVALID"
        });
    const name = config.targetName;
    if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)))
        throw Object.assign(new Error("targetName must be an OpenOCD target identifier"), {
            code: "OPENOCD_TARGET_INVALID"
        });
    return { numberOfProcessors: count, targetProcessor: core, ...(name === undefined ? {} : { targetName: name }) };
}

function buildOpenOcdTargetArgs(config, ports) {
    const selection = normalizeTargetSelection(config);
    if (!selection.numberOfProcessors) return [];
    const { numberOfProcessors: count, targetProcessor: core, targetName: name } = selection;
    if (
        !Array.isArray(ports) ||
        ports.length !== count ||
        new Set(ports).size !== count ||
        ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
    )
        throw Object.assign(new Error("Each OpenOCD target requires a distinct GDB port"), {
            code: "OPENOCD_TARGET_PORT_INVALID"
        });
    return [
        "-c",
        "set _ep_core_targets [target names]; " +
            `if { [llength $_ep_core_targets] != ${count} } { error "EmberProbe: configured processor count does not match OpenOCD targets" }; ` +
            (name
                ? `if { [lindex $_ep_core_targets ${core}] ne "${name}" } { error "EmberProbe: targetName does not match targetProcessor" }; `
                : "") +
            ports.map((port, index) => `[lindex $_ep_core_targets ${index}] configure -gdb-port ${port}; `).join("") +
            `targets [lindex $_ep_core_targets ${core}]`
    ];
}

function buildOpenOcdConfigArgs(launch, transport = "auto", connection = {}) {
    normalizeTransport(transport);
    const serial = normalizeProbeSerial(connection.probeSerial);
    const speed = normalizeAdapterSpeed(connection.adapterSpeedKhz);
    return [
        "-s",
        launch.scriptsRoot,
        "-f",
        launch.probePath,
        ...(serial ? ["-c", `adapter serial ${serial}`] : []),
        ...(transport === "auto" ? [] : ["-c", `transport select ${transport}`]),
        "-f",
        launch.targetPath,
        ...(speed ? ["-c", `adapter speed ${speed}`] : [])
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
    normalizeRtos,
    OPENOCD_RTOS_NAMES,
    buildOpenOcdConfigArgs,
    buildOpenOcdRtosArgs,
    normalizeTargetSelection,
    buildOpenOcdTargetArgs,
    isSafeCfgPath,
    resolveExecutablePath,
    scriptsRootCandidates,
    findScriptsRoot,
    resolveConfigFile,
    resolveOpenOcdLaunch,
    discoverTargetConfigs,
    discoverInterfaceConfigs
};
