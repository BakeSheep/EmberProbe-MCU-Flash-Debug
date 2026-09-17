"use strict";

const fs = require("fs");

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

module.exports = { normalizeFileIdentity, canonicalFileSync, canonicalFile };
