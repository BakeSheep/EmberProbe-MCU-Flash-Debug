"use strict";

function resolvePrettyPrinting(launch = {}, settings = {}) {
    const enablePrettyPrinting = launch.enablePrettyPrinting ?? settings.enablePrettyPrinting ?? true;
    const prettyPrinterPath = launch.prettyPrinterPath ?? settings.prettyPrinterPath ?? "";
    if (typeof enablePrettyPrinting !== "boolean") throw new Error("enablePrettyPrinting must be a boolean");
    if (typeof prettyPrinterPath !== "string") throw new Error("prettyPrinterPath must be a directory path");
    return { enablePrettyPrinting, prettyPrinterPath };
}

async function initializePrettyPrinting(mi, config, report) {
    // Session-local settings: no scripts, inferior calls, or printer runtime are required.
    await mi.command("-gdb-set auto-load off");
    await mi.command("-gdb-set print raw-values on");
    await mi.command("-gdb-set may-call-functions off");
    if (config.prettyPrinterPath)
        report("prettyPrinterPath is deprecated and ignored. EmberProbe uses its built-in STL display.\n");
    return config.enablePrettyPrinting !== false;
}

module.exports = { resolvePrettyPrinting, initializePrettyPrinting };
