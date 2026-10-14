"use strict";
const fs = require("fs/promises");
const {
    detectProbe,
    usbInventory,
    probeFromText: debuggerFromInventory
} = require("../skills/_emberprobe/probe-detection");
const targets = require("../skills/_emberprobe/target-detection");

const MAX_ELF_CANDIDATES = 2000;

async function readHeader(file) {
    const handle = await fs.open(file, "r");
    try {
        const header = Buffer.alloc(20);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        return header.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

// Every ELF image in the workspace with its mtime and architecture; non-ELF *.out files are dropped.
async function elfImages(vscode) {
    const files = await vscode.workspace.findFiles(targets.ELF_FILE_GLOB, targets.ELF_EXCLUDE_GLOB, MAX_ELF_CANDIDATES);
    const images = await Promise.all(
        files.map(async (uri) => {
            try {
                const [stat, header] = await Promise.all([fs.stat(uri.fsPath), readHeader(uri.fsPath)]);
                const info = stat.isFile() && targets.elfHeaderInfo(header);
                return info ? { file: uri.fsPath, mtimeMs: stat.mtimeMs, arch: info.arch } : null;
            } catch {
                return null;
            }
        })
    );
    return images.filter(Boolean);
}

async function projectEntries(vscode) {
    const uris = await vscode.workspace.findFiles(targets.PROJECT_FILE_GLOB, targets.PROJECT_EXCLUDE_GLOB, 1000);
    const files = targets.orderProjectFiles(uris.map((uri) => uri.fsPath));
    const entries = [];
    for (const file of files) {
        try {
            const stat = await fs.stat(file);
            if (!stat.isFile() || stat.size > targets.MAX_PROJECT_FILE_BYTES) continue;
            entries.push({ file, text: await fs.readFile(file, "utf8") });
        } catch {}
    }
    return entries;
}

/**
 * @param {any} vscode
 * @param {{ ioc?: string, targets?: string[] }} [options] `ioc` is a user-selected project
 *   file that decides alone; `targets` lists the scripts the configured OpenOCD provides.
 */
async function detectMcu(vscode, options = {}) {
    const entries = await projectEntries(vscode);
    if (options.ioc && !entries.some((entry) => entry.file === options.ioc)) {
        try {
            entries.unshift({ file: options.ioc, text: await fs.readFile(options.ioc, "utf8") });
        } catch {}
    }
    const resolved = targets.resolveTarget(entries, { preferred: options.ioc });
    const available = Array.isArray(options.targets) && options.targets.length ? new Set(options.targets) : null;
    if (!available) return { ...resolved, unavailable: "" };
    const candidates = resolved.candidates.filter((cfg) => available.has(cfg));
    if (resolved.target && !available.has(resolved.target))
        return { ...resolved, target: "", candidates, unavailable: resolved.target };
    return { ...resolved, candidates, unavailable: "" };
}

async function detectDebugger(options = {}) {
    const detected = await (options.detectProbe || detectProbe)();
    const available =
        Array.isArray(options.interfaces) && options.interfaces.length ? new Set(options.interfaces) : null;
    const candidates = available ? detected.candidates.filter((cfg) => available.has(cfg)) : detected.candidates;
    return { debugger: candidates.length === 1 ? candidates[0] : "", probeCandidates: candidates };
}

/**
 * @param {any} vscode
 * @param {{ ioc?: string, mcu?: string, targets?: string[], interfaces?: string[], detectProbe?: Function }} [options]
 *   `mcu` is the configured target used to pair firmware when detection finds none.
 */
async function detectWorkspace(vscode, options = {}) {
    const [mcu, images, debuggerConfig] = await Promise.all([
        detectMcu(vscode, options),
        elfImages(vscode),
        detectDebugger(options)
    ]);
    const { elf, rejected } = targets.chooseElf(images, {
        target: mcu.target || options.mcu || "",
        projectDir: mcu.projectDir
    });
    return {
        elf,
        elfRejected: rejected,
        mcu: mcu.target,
        mcuCandidates: mcu.candidates,
        mcuSource: mcu.source,
        mcuUnavailable: mcu.unavailable,
        ...debuggerConfig
    };
}

const targetFromText = targets.targetFromText;
module.exports = { detectWorkspace, detectMcu, elfImages, targetFromText, debuggerFromInventory, usbInventory };
