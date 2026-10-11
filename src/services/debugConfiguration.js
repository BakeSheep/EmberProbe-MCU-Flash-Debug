"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeRtos, normalizeTargetSelection } = require("../../skills/_emberprobe/openocd-launch");
const { resolvePrettyPrinting } = require("./prettyPrinting");
const { normalizeDebugImages } = require("./debugImages");
const { normalizeExternalConfiguration } = require("./externalDebugService");

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

/** @returns {{servertype: string, serverpath?: string, serverGroup?: string, numberOfProcessors?: number, targetProcessor?: number, targetName?: string}} */
function normalizeDebugServerOptions(config = {}, internal = false) {
    const servertype = config.servertype ?? "openocd";
    if (servertype === "external") return normalizeExternalConfiguration(config, internal);
    if (servertype !== "openocd")
        throw Object.assign(new Error(`Unsupported EmberProbe server: ${servertype}`), {
            code: "DEBUG_SERVER_UNSUPPORTED"
        });
    if (
        config.serverpath !== undefined &&
        (typeof config.serverpath !== "string" || !config.serverpath.trim() || /[\x00-\x1f]/.test(config.serverpath))
    )
        throw Object.assign(new Error("serverpath must name an OpenOCD executable"), {
            code: "DEBUG_SERVER_PATH_INVALID"
        });
    const selection = normalizeTargetSelection(config);
    if (
        config.serverGroup !== undefined &&
        (typeof config.serverGroup !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(config.serverGroup) ||
            !selection.numberOfProcessors ||
            selection.numberOfProcessors < 2)
    )
        throw Object.assign(
            new Error("serverGroup requires an identifier and an explicit multi-target processor count"),
            {
                code: "DEBUG_GROUP_INVALID"
            }
        );
    return {
        servertype,
        ...(config.serverpath === undefined ? {} : { serverpath: config.serverpath.trim() }),
        ...selection,
        ...(config.serverGroup === undefined ? {} : { serverGroup: config.serverGroup })
    };
}

function validateDebugConfiguration(config, folder) {
    if (!folder) throw new Error("Open a workspace folder before debugging");
    if (!["launch", "attach"].includes(config.request)) throw new Error("Use launch or attach for EmberProbe");
    const result = { ...config };
    Object.assign(result, normalizeDebugServerOptions(result));
    const pretty = resolvePrettyPrinting(
        result,
        {},
        result.cwd ? path.resolve(folder.uri.fsPath, result.cwd) : folder.uri.fsPath
    );
    // Preserve absent keys so workspace settings can still apply during managed startup.
    if (result.prettyPrinterFiles !== undefined) result.prettyPrinterFiles = pretty.prettyPrinterFiles;
    if (result.executable) {
        result.executable = path.resolve(folder.uri.fsPath, result.executable);
        if (!fs.statSync(result.executable).isFile()) throw new Error("Debug executable must be an ELF file");
    }
    if (result.cwd) {
        result.cwd = path.resolve(folder.uri.fsPath, result.cwd);
        if (!fs.statSync(result.cwd).isDirectory()) throw new Error("Debug cwd must be a directory");
    }
    if (result.serverpath && /[/\\]/.test(result.serverpath))
        result.serverpath = path.resolve(result.cwd || folder.uri.fsPath, result.serverpath);
    Object.assign(result, normalizeDebugImages(result, result.cwd || folder.uri.fsPath));
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
    if (result.servertype !== "external") delete result.gdbTarget;
    delete result.__emberprobeManagedToken;
    return result;
}

module.exports = { isSupportedDebugSession, validateDebugConfiguration, resolveRtos, normalizeDebugServerOptions };
