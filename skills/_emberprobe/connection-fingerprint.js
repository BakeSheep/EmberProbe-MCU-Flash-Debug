"use strict";
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

// Hash the complete scripts tree: sourced Tcl dependencies need not be statically discoverable.
// Symlinks disable reuse rather than trusting an incomplete fingerprint.
async function connectionFingerprint(launch) {
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify([launch.executable, launch.scriptsRoot, launch.probePath, launch.targetPath]));
    hash.update(await fs.readFile(launch.executable));
    async function visit(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error("Untracked script dependency");
            if (entry.isDirectory()) await visit(file);
            else if (entry.isFile()) {
                hash.update(path.relative(launch.scriptsRoot, file));
                hash.update("\0");
                hash.update(
                    crypto
                        .createHash("sha256")
                        .update(await fs.readFile(file))
                        .digest()
                );
            }
        }
    }
    await visit(launch.scriptsRoot);
    return hash.digest("hex");
}
module.exports = { connectionFingerprint };
