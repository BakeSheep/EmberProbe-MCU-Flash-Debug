"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeRtos } = require("../../skills/_emberprobe/openocd-launch");
const { resolvePrettyPrinting } = require("./prettyPrinting");

function isSupportedDebugSession(session) {
    return ["emberprobe", "cortex-debug"].includes(session?.type);
}

// launch.json wins whenever the key carries a value, including an explicit empty string that turns
// RTOS awareness off. Only undefined/null count as absent and fall back to the workspace setting.
// A truthy || chain cannot express that, so the presence check is spelled out.
function resolveRtos(launch, configured) {
    const explicit = Object.hasOwn(launch || {}, "rtos") && launch.rtos !== undefined && launch.rtos !== null;
    return normalizeRtos(explicit ? launch.rtos : configured);
}

function validateDebugConfiguration(config, folder) {
    if (!folder) throw new Error("Open a workspace folder before debugging");
    if (!["launch", "attach"].includes(config.request)) throw new Error("Use launch or attach for EmberProbe");
    const result = { ...config };
    resolvePrettyPrinting(result);
    if (result.executable) {
        result.executable = path.resolve(folder.uri.fsPath, result.executable);
        if (!fs.statSync(result.executable).isFile()) throw new Error("Debug executable must be an ELF file");
    }
    if (result.cwd) {
        result.cwd = path.resolve(folder.uri.fsPath, result.cwd);
        if (!fs.statSync(result.cwd).isDirectory()) throw new Error("Debug cwd must be a directory");
    }
    if (result.runToEntryPoint !== undefined && typeof result.runToEntryPoint !== "string")
        throw new Error("runToEntryPoint must be a string");
    // Keep null absent so resolveRtos can fall back to the workspace setting.
    if (result.rtos !== undefined && result.rtos !== null) result.rtos = normalizeRtos(result.rtos);
    if (
        result.sourceFileMap !== undefined &&
        (!result.sourceFileMap ||
            Array.isArray(result.sourceFileMap) ||
            typeof result.sourceFileMap !== "object" ||
            Object.values(result.sourceFileMap).some((value) => typeof value !== "string"))
    )
        throw new Error("sourceFileMap must map source prefixes to local paths");
    delete result.gdbTarget;
    delete result.__emberprobeManagedToken;
    return result;
}

module.exports = { isSupportedDebugSession, validateDebugConfiguration, resolveRtos };
