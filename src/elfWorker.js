"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { parentPort, workerData, isMainThread } = require("worker_threads");
const { parseElfSymbols } = require("./elfSymbols");
const { parseDwarfInternal } = require("./dwarf/parser");
const { buildVariableTypes, createCompositeLayoutResolver } = require("./dwarf/types");

const MAX_ELF_BYTES = 64 * 1024 * 1024;
const CHUNK_SIZE = 1000;

async function sendChunks(port, kind, entries, acks) {
    for (let offset = 0; offset < entries.length; offset += CHUNK_SIZE) {
        await new Promise((resolve) => {
            acks.set(kind, resolve);
            port.postMessage({ type: kind, entries: entries.slice(offset, offset + CHUNK_SIZE) });
        });
    }
    port.postMessage({ type: `${kind}Done` });
}

async function run(port, filePath) {
    let resolveLayout;
    let symbolNames;
    const acks = new Map();
    port.on("message", (message) => {
        if (message?.type === "ack") {
            acks.get(message.kind)?.();
            acks.delete(message.kind);
            return;
        }
        if (message?.type !== "layout" || !Number.isSafeInteger(message.id)) return;
        try {
            if (!resolveLayout || !symbolNames.has(message.name)) {
                port.postMessage({ type: "layoutResult", id: message.id, name: message.name, layout: null });
                return;
            }
            const layout = resolveLayout(message.name);
            if (layout && Buffer.byteLength(JSON.stringify(layout)) > 4 * 1024 * 1024) {
                throw Object.assign(new Error("DWARF layout response budget exceeded"), {
                    code: "DWARF_BUDGET_EXCEEDED"
                });
            }
            port.postMessage({ type: "layoutResult", id: message.id, name: message.name, layout });
        } catch (error) {
            port.postMessage({
                type: "layoutResult",
                id: message.id,
                name: message.name,
                error: { code: error.code || "DWARF_PARSE_FAILED", message: error.message }
            });
        }
    });
    try {
        const before = fs.statSync(filePath);
        if (before.size > MAX_ELF_BYTES) {
            throw Object.assign(new Error("ELF exceeds the 64 MiB limit"), { code: "ELF_TOO_LARGE" });
        }
        const buffer = fs.readFileSync(filePath);
        const after = fs.statSync(filePath);
        if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
            throw Object.assign(new Error("ELF changed while it was being read"), { code: "ELF_READ_FAILED" });
        }
        const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
        const result = parseElfSymbols(buffer);
        symbolNames = new Set(result.symbols.map((symbol) => symbol.name));
        port.postMessage({
            type: "metadata",
            elf: { path: filePath, mtimeMs: before.mtimeMs, size: before.size, sha256 },
            warnings: result.warnings,
            symbolCount: result.symbols.length
        });
        await sendChunks(port, "symbols", result.symbols, acks);
        await sendChunks(port, "functions", result.functions, acks);
        try {
            const parsed = parseDwarfInternal(buffer);
            const types = buildVariableTypes(parsed);
            await sendChunks(port, "types", Array.from(types), acks);
            resolveLayout = createCompositeLayoutResolver(parsed);
            port.postMessage({
                type: "dwarfReady",
                diagnostics: parsed.diagnostics,
                heapUsed: process.memoryUsage().heapUsed
            });
        } catch (error) {
            port.postMessage({
                type: "dwarfFailed",
                diagnostic: { code: error.code || "DWARF_PARSE_FAILED", stage: "parse", message: error.message }
            });
        }
    } catch (error) {
        port.postMessage({
            type: "failed",
            error: { code: error.code === "ELF_TOO_LARGE" ? error.code : "ELF_READ_FAILED", message: error.message }
        });
    }
}

if (!isMainThread) run(parentPort, workerData.path);

module.exports = { run };
