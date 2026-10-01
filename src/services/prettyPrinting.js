"use strict";

const fs = require("fs");
const path = require("path");
const { quote } = require("../debug/mi");

const MODES = ["builtin", "gdb", "raw"];

function configuredPrettyPrintingMode(settings) {
    const inspection = settings.inspect?.("prettyPrintingMode");
    if (
        inspection &&
        ![
            "globalValue",
            "workspaceValue",
            "workspaceFolderValue",
            "globalLanguageValue",
            "workspaceLanguageValue",
            "workspaceFolderLanguageValue"
        ].some((key) => inspection[key] !== undefined)
    )
        return undefined;
    return settings.get("prettyPrintingMode");
}

function resolvePrettyPrinting(launch = {}, settings = {}, cwd = launch.cwd || process.cwd()) {
    const enablePrettyPrinting = launch.enablePrettyPrinting ?? settings.enablePrettyPrinting ?? true;
    const prettyPrinterPath = launch.prettyPrinterPath ?? settings.prettyPrinterPath ?? "";
    if (typeof enablePrettyPrinting !== "boolean") throw new Error("enablePrettyPrinting must be a boolean");
    if (typeof prettyPrinterPath !== "string") throw new Error("prettyPrinterPath must be a directory path");
    const prettyPrintingMode =
        launch.prettyPrintingMode ?? settings.prettyPrintingMode ?? (enablePrettyPrinting ? "builtin" : "raw");
    if (!MODES.includes(prettyPrintingMode)) throw new Error("prettyPrintingMode must be builtin, gdb or raw");
    const files = launch.prettyPrinterFiles ?? settings.prettyPrinterFiles ?? [];
    if (
        !Array.isArray(files) ||
        files.length > 32 ||
        files.some((file) => typeof file !== "string" || !file.trim() || file.length > 4096 || /[\x00-\x1f]/.test(file))
    )
        throw new Error("prettyPrinterFiles must contain at most 32 explicit script paths");
    const prettyPrinterFiles = files.map((file) => path.resolve(cwd, file));
    if (prettyPrintingMode === "gdb") {
        for (const file of prettyPrinterFiles) {
            if (!fs.statSync(file).isFile()) throw new Error(`Pretty-printer script is not a file: ${file}`);
        }
    }
    return { enablePrettyPrinting, prettyPrinterPath, prettyPrintingMode, prettyPrinterFiles };
}

// Every mode disables implicit scripts and inferior function calls. The gdb branch re-asserts
// them because loading user scripts and -enable-pretty-printing can flip them back.
const HARDENING_COMMANDS = Object.freeze([
    "-gdb-set auto-load off",
    "-gdb-set print raw-values on",
    "-gdb-set may-call-functions off",
    "-gdb-set print object on"
]);
async function harden(mi) {
    for (const command of HARDENING_COMMANDS) await mi.command(command);
}

async function initializePrettyPrinting(mi, config, report) {
    const resolved = resolvePrettyPrinting(config);
    Object.assign(config, resolved);
    config.effectivePrettyPrintingMode = resolved.prettyPrintingMode;
    await harden(mi);
    if (config.prettyPrinterPath)
        report("prettyPrinterPath is deprecated and ignored. EmberProbe uses its built-in STL display.\n");
    if (resolved.prettyPrintingMode !== "gdb") return resolved.prettyPrintingMode === "builtin";
    try {
        const features = await mi.command("-list-features");
        if (!Array.isArray(features.features) || !features.features.includes("python"))
            throw new Error("GDB has no Python support");
        await mi.command('-interpreter-exec console "python import gdb"');
        // Enable MI printers only after all explicitly authorized scripts load successfully.
        for (const file of resolved.prettyPrinterFiles) {
            const literal = JSON.stringify(file.replace(/\\/g, "/"));
            const script = `python exec(compile(open(${literal}, "rb").read(), ${literal}, "exec"), {"__name__": "__main__", "__file__": ${literal}})`;
            await mi.command(`-interpreter-exec console ${quote(script)}`);
        }
        await harden(mi);
        await mi.command("-enable-pretty-printing");
        report("GDB Python printers enabled. Their internal memory reads are outside the JavaScript byte budget.\n");
        return false;
    } catch (error) {
        // A closed/timeout transport cannot be recovered by changing display modes.
        if (mi.closed || /timed out|not running|GDB exited|transport closed/i.test(error.message)) throw error;
        await harden(mi);
        config.effectivePrettyPrintingMode = "builtin";
        report(`GDB pretty-printer initialization failed: ${error.message}. Using built-in STL display.\n`);
        return true;
    }
}

module.exports = { resolvePrettyPrinting, initializePrettyPrinting, configuredPrettyPrintingMode, MODES };
