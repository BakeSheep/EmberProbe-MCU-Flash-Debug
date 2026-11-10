"use strict";

const fs = require("fs");
const path = require("path");

// Preserve case-sensitive path components; only the Windows drive spelling is folded.
function normalizeFileIdentity(value, platform = process.platform) {
    const file = String(value);
    return platform === "win32"
        ? file.replace(/\\/g, "/").replace(/^([a-z]):/i, (_, drive) => drive.toUpperCase() + ":")
        : file;
}

function canonicalFileSync(file) {
    return normalizeFileIdentity(process.platform === "win32" ? fs.realpathSync.native(file) : fs.realpathSync(file));
}

async function canonicalFile(file) {
    return normalizeFileIdentity(await fs.promises.realpath(file));
}

// True when a path.relative() result leaves its base directory. A child named "..build" starts with
// ".." but stays inside, so only a whole ".." segment counts.
function leavesDirectory(relative, pathModule = path) {
    return relative === ".." || /^\.\.[\\/]/.test(relative) || pathModule.isAbsolute(relative);
}

// Resolve an output file the caller asked for: a relative path that stays inside the workspace, also after
// following symlinks in its existing ancestors. The file itself may not exist yet.
function workspaceOutputPath(workspace, requested, option = "--output") {
    const outside = (message) => Object.assign(new Error(`${option} ${message}`), { code: "PATH_OUTSIDE_WORKSPACE" });
    const raw = String(requested || "").trim();
    if (!raw || path.isAbsolute(raw)) throw outside("must be a relative path inside the workspace");
    const root = fs.realpathSync(path.resolve(workspace));
    const output = path.resolve(root, raw);
    const relative = path.relative(root, output);
    if (!relative || leavesDirectory(relative)) throw outside("must be a relative path inside the workspace");
    let ancestor = path.dirname(output);
    while (!fs.existsSync(ancestor)) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
    }
    if (leavesDirectory(path.relative(root, fs.realpathSync(ancestor))))
        throw outside("resolves through a symlink outside the workspace");
    return output;
}

module.exports = { normalizeFileIdentity, canonicalFileSync, canonicalFile, leavesDirectory, workspaceOutputPath };
