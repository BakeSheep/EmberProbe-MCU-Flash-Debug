"use strict";

const fs = require("fs");
const path = require("path");

// OpenOCD accepts configuration paths relative to its scripts directory.
// Allow vendor subdirectories (for example geehy/apm32f4x.cfg), while rejecting
// absolute paths, Windows separators, control characters and path traversal.
function isSafeCfgPath(value) {
    if (typeof value !== "string" || !value.endsWith(".cfg") || value.includes("\\")) return false;
    if (value.startsWith("/") || /[\x00-\x1f:]/.test(value)) return false;
    const parts = value.split("/");
    return parts.length > 0 && parts.every(part => part && part !== "." && part !== "..");
}

function scriptsRootCandidates(executable) {
    const configured = String(executable || "").trim();
    if (!configured || (!configured.includes("/") && !configured.includes("\\"))) return [];
    let binary = path.resolve(configured);
    try { binary = fs.realpathSync(binary); } catch (error) { /* use configured path */ }
    const prefix = path.dirname(path.dirname(binary));
    const candidates = [
        process.env.OPENOCD_SCRIPTS,
        path.join(prefix, "scripts"),
        // xPack archives keep bin/ and openocd/scripts/ as siblings.
        path.join(prefix, "openocd", "scripts"),
        // System packages and EmberProbe's bundled build use share/openocd/scripts/.
        path.join(prefix, "share", "openocd", "scripts")
    ].filter(Boolean);
    return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

function findScriptsRoot(executable) {
    for (const candidate of scriptsRootCandidates(executable)) {
        try {
            if (fs.statSync(path.join(candidate, "target")).isDirectory()) return candidate;
        } catch (error) { /* try the next supported layout */ }
    }
    return "";
}

function walkCfgFiles(root, current = root, output = []) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) { return output; }
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
    return walkCfgFiles(path.join(scriptsRoot, "target"))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}

module.exports = { isSafeCfgPath, scriptsRootCandidates, findScriptsRoot, discoverTargetConfigs };
