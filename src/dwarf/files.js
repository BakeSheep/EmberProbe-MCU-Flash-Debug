"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function readCompanion(unit, elfPath, remainingBytes) {
    const name = unit.dwoName;
    if (typeof name !== "string" || !name || /[\x00-\x1f]/.test(name) || !/\.dwo$/i.test(name))
        throw new Error("Invalid split DWARF companion filename");
    const root = path.dirname(path.resolve(elfPath));
    const candidates = [path.resolve(root, name)];
    // A selected ELF may contain hostile DW_AT_dwo_name text. Follow only paths
    // beneath the ELF directory; never let debug metadata read an arbitrary file.
    const safe = (candidate) => {
        const relative = path.relative(root, candidate);
        return (
            relative === "" ||
            (relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
        );
    };
    if (!safe(candidates[0])) throw new Error("Split DWARF companion path escapes the ELF directory");
    for (const candidate of new Set(candidates)) {
        const before = fs.statSync(candidate, { throwIfNoEntry: false });
        if (!before) continue;
        const resolved = fs.realpathSync(candidate);
        if (!safe(resolved)) throw new Error("Split DWARF companion path escapes the ELF directory");
        if (!before.isFile() || before.size > remainingBytes)
            throw Object.assign(new Error("Split DWARF companion exceeds its shared file budget"), {
                code: "DWARF_BUDGET_EXCEEDED"
            });
        const buffer = fs.readFileSync(candidate);
        const after = fs.statSync(candidate);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            throw new Error("Split DWARF companion changed while reading");
        return {
            path: resolved,
            buffer,
            identity: {
                path: resolved,
                size: after.size,
                mtimeMs: after.mtimeMs,
                sha256: crypto.createHash("sha256").update(buffer).digest("hex")
            }
        };
    }
    throw Object.assign(new Error("Matching split DWARF companion is missing: " + name), {
        paths: candidates.map((candidate) => ({ path: candidate, size: null, mtimeMs: null }))
    });
}

function companionsUnchanged(companions, filesystem = fs) {
    return (companions || []).every((entry) => {
        try {
            const stat = filesystem.statSync(entry.path, { throwIfNoEntry: false });
            return stat ? stat.size === entry.size && stat.mtimeMs === entry.mtimeMs : entry.size === null;
        } catch {
            return false;
        }
    });
}

module.exports = { readCompanion, companionsUnchanged };
