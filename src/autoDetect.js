"use strict";
const fs = require("fs/promises");
const {
    detectProbe,
    usbInventory,
    probeFromText: debuggerFromInventory
} = require("../skills/_emberprobe/probe-detection");
const targets = require("../skills/_emberprobe/target-detection");
const elfFormat = require("./elfFormat");

const MAX_ELF_CANDIDATES = 2000;
const ELF_HEADER_BYTES = 52;
// Firmware images need a few KiB for both tables; larger ones are left unchecked.
const MAX_SECTION_TABLE_BYTES = 64 * 1024;
const MAX_SECTION_NAMES_BYTES = 64 * 1024;
const SHT_NOBITS = 8;
const DWARF_INFO_SECTIONS = new Set([".debug_info", ".zdebug_info"]);

async function readAt(handle, offset, length) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
}

// Reads only the section header table and section name table. Returns undefined when the
// layout cannot be checked, so the image keeps ranking like one with debug info.
async function hasDwarf(handle, header) {
    try {
        const elf = elfFormat.readElf32Header(header);
        if (!elf.shoff) return false;
        const tableBytes = elf.shnum * elf.shentsize;
        if (!elf.shnum || elf.shentsize < 40 || tableBytes > MAX_SECTION_TABLE_BYTES) return undefined;
        const table = await readAt(handle, elf.shoff, tableBytes);
        if (table.length < tableBytes) return undefined;
        const entries = Array.from({ length: elf.shnum }, (_, index) => {
            const at = index * elf.shentsize;
            return {
                nameOffset: table.readUInt32LE(at),
                type: table.readUInt32LE(at + 4),
                offset: table.readUInt32LE(at + 16),
                size: table.readUInt32LE(at + 20)
            };
        });
        const names = entries[elf.shstrndx];
        if (!names || names.size > MAX_SECTION_NAMES_BYTES) return undefined;
        const strings = await readAt(handle, names.offset, names.size);
        if (strings.length < names.size) return undefined;
        // readSectionNames addresses the name table by file offset; it was read on its own.
        const local = entries.slice();
        local[elf.shstrndx] = { ...names, offset: 0 };
        return elfFormat
            .readSectionNames(strings, local, elf.shstrndx)
            .some(
                (name, index) =>
                    DWARF_INFO_SECTIONS.has(name) && entries[index].size > 0 && entries[index].type !== SHT_NOBITS
            );
    } catch {
        return undefined;
    }
}

async function readImageInfo(file) {
    const handle = await fs.open(file, "r");
    try {
        const header = await readAt(handle, 0, ELF_HEADER_BYTES);
        const info = targets.elfHeaderInfo(header);
        return info && { arch: info.arch, dwarf: await hasDwarf(handle, header) };
    } finally {
        await handle.close();
    }
}

// Every ELF image in the workspace with its mtime, architecture and DWARF presence
// (undefined when unknown); non-ELF *.out files are dropped.
async function elfImages(vscode) {
    const files = await vscode.workspace.findFiles(targets.ELF_FILE_GLOB, targets.ELF_EXCLUDE_GLOB, MAX_ELF_CANDIDATES);
    const images = await Promise.all(
        files.map(async (uri) => {
            try {
                const stat = await fs.stat(uri.fsPath);
                const info = stat.isFile() && (await readImageInfo(uri.fsPath));
                return info ? { file: uri.fsPath, mtimeMs: stat.mtimeMs, ...info } : null;
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
