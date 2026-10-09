"use strict";
const fs = require("fs");
const path = require("path");

// Durable docs. Images and other assets are always kept; no link parser is needed.
const MAIN_DOCS = new Set([
    "AGENT-TRUST-BOUNDARIES.md",
    "CPU-LOAD-MONITORING.md",
    "CUBEMX-GENERATION.md",
    "ENUM-VARIABLES.md",
    "EXTERNAL-GDB-SERVER.md",
    "JLINK-COMPATIBILITY.md",
    "LAYERED-SAMPLING.md",
    "PROBE-RS-EMBASSY.md",
    "RELEASING.md",
    "RTOS-AWARENESS.md",
    "SHARED-DEBUG-GROUPS.md"
]);

function cleanDocs(root, { dryRun = true } = {}) {
    const docsRoot = path.join(root, "docs");
    const removed = [];
    if (!fs.existsSync(docsRoot)) return removed;
    const walk = (directory, relative = "") => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(directory, entry.name), file);
            else if (entry.isFile() && /\.(md|json)$/i.test(file) && !MAIN_DOCS.has(file)) removed.push(file);
        }
    };
    walk(docsRoot);
    removed.sort();
    if (!dryRun) {
        for (const file of removed) fs.rmSync(path.join(docsRoot, file));
    }
    return removed;
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length > 1 || args.some((arg) => !["--write", "--dry-run"].includes(arg))) {
            throw new Error("Usage: node scripts/docs-cleanup.js [--write|--dry-run]");
        }
        const dryRun = !args.includes("--write");
        const removed = cleanDocs(path.resolve(__dirname, ".."), { dryRun });
        console.log(`${dryRun ? "Would remove" : "Removed"} ${removed.length} docs: ${removed.join(", ")}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { cleanDocs };
