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

module.exports = { normalizeFileIdentity, canonicalFileSync, canonicalFile, leavesDirectory };
