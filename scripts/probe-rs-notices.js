"use strict";
const fs = require("fs");
const path = require("path");

function notices(metadata) {
    const sections = [];
    for (const entry of metadata.packages) {
        if (entry.name === "emberprobe-probe-rs") continue;
        const root = path.dirname(entry.manifest_path);
        sections.push(
            `\n${entry.name} ${entry.version}\nLicense: ${entry.license || "see license file"}\n${entry.repository || ""}\n`
        );
        const candidates = fs
            .readdirSync(root)
            .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name));
        if (entry.license_file) candidates.push(entry.license_file);
        for (const name of [...new Set(candidates)]) {
            const file = path.resolve(root, name);
            const relative = path.relative(root, file);
            if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("License path escapes package");
            const stat = fs.statSync(file);
            if (!stat.isFile()) continue;
            if (stat.size > 1024 * 1024) throw new Error("License file exceeds its byte budget");
            sections.push(`--- ${name} ---\n${fs.readFileSync(file, "utf8")}\n`);
        }
    }
    return "EmberProbe native sampler dependency notices\n" + sections.join("\n");
}
module.exports = { notices };
