"use strict";

const fs = require("fs");
const path = require("path");

function isSupportedDebugSession(session) {
    return ["emberprobe", "cortex-debug"].includes(session?.type);
}

function validateDebugConfiguration(config, folder) {
    if (!folder) throw new Error("Open a workspace folder before debugging");
    if (!["launch", "attach"].includes(config.request)) throw new Error("Use launch or attach for EmberProbe");
    const result = { ...config };
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

module.exports = { isSupportedDebugSession, validateDebugConfiguration };
