"use strict";
// MCU target and firmware-image heuristics shared by the extension's auto-detect and the
// mcu-flash skill, so both infer the same OpenOCD target from the same workspace.
// Pure functions only: callers own file enumeration, size budgets and I/O.

const path = require("path");

// Matches never start inside a longer identifier (rp2040 in "xrp2040"), but underscores,
// separators and compiler define flags may precede them: "startup_stm32f407xx.s",
// "-DSTM32F407xx" and "/DSTM32F407xx" all count.
const B = "(?<![a-ce-z0-9])(?<!(?:^|[^-/])d)";

/** @typedef {Readonly<{ pattern: RegExp, cfg: string, family: string, arch: string, specific: boolean }>} TargetRule */

/** @returns {TargetRule} */
function rule(pattern, cfg, family, arch, specific = false) {
    return Object.freeze({ pattern: new RegExp(pattern), cfg, family, arch, specific });
}

/**
 * Ordered most specific first. `family` groups variants of one target script so that a
 * file mentioning both "STM32H743xx" and "stm32h7xx_hal" is not treated as ambiguous.
 * An empty cfg marks a recognized family without a reliable OpenOCD target script.
 * @type {ReadonlyArray<TargetRule>}
 */
const TARGET_RULES = Object.freeze([
    // XL-density STM32F101/F103 (768 KiB/1 MiB) have a second bank at 0x08080000.
    rule(`${B}stm32f10[13][a-z][fg]|${B}stm32f10x_xl(?![a-z0-9])`, "stm32xl.cfg", "stm32f1", "arm", true),
    rule(`${B}stm32f1`, "stm32f1x.cfg", "stm32f1", "arm"),
    rule(`${B}stm32f0`, "stm32f0x.cfg", "stm32f0", "arm"),
    rule(`${B}stm32f2`, "stm32f2x.cfg", "stm32f2", "arm"),
    rule(`${B}stm32f3`, "stm32f3x.cfg", "stm32f3", "arm"),
    rule(`${B}stm32f4`, "stm32f4x.cfg", "stm32f4", "arm"),
    rule(`${B}stm32f7`, "stm32f7x.cfg", "stm32f7", "arm"),
    rule(`${B}stm32c0`, "stm32c0x.cfg", "stm32c0", "arm"),
    rule(`${B}stm32g0`, "stm32g0x.cfg", "stm32g0", "arm"),
    rule(`${B}stm32g4`, "stm32g4x.cfg", "stm32g4", "arm"),
    // Dual-bank H7 parts; stm32h7x.cfg alone declares only bank 1.
    rule(`${B}stm32h7(?:4[2357]|5[357]|a3|b3)`, "stm32h7x_dual_bank.cfg", "stm32h7", "arm", true),
    rule(`${B}stm32h7`, "stm32h7x.cfg", "stm32h7", "arm"),
    rule(`${B}stm32l0`, "stm32l0.cfg", "stm32l0", "arm"),
    rule(`${B}stm32l1`, "stm32l1.cfg", "stm32l1", "arm"),
    rule(`${B}stm32l4`, "stm32l4x.cfg", "stm32l4", "arm"),
    rule(`${B}stm32l5`, "stm32l5x.cfg", "stm32l5", "arm"),
    rule(`${B}stm32u0`, "stm32u0x.cfg", "stm32u0", "arm"),
    rule(`${B}stm32u5`, "stm32u5x.cfg", "stm32u5", "arm"),
    rule(`${B}stm32wba`, "stm32wbax.cfg", "stm32wba", "arm"),
    // STM32WB0x is a Cortex-M0+ line unrelated to the WB55 flash layout.
    rule(`${B}stm32wb0`, "", "stm32wb0", "arm"),
    rule(`${B}stm32wb(?![a0])`, "stm32wbx.cfg", "stm32wb", "arm"),
    rule(`${B}stm32wl`, "stm32wlx.cfg", "stm32wl", "arm"),
    rule(`${B}apm32f0`, "geehy/apm32f0x.cfg", "apm32f0", "arm"),
    rule(`${B}apm32f1`, "geehy/apm32f1x.cfg", "apm32f1", "arm"),
    rule(`${B}apm32f4`, "geehy/apm32f4x.cfg", "apm32f4", "arm"),
    rule(`${B}gd32vf103`, "gd32vf103.cfg", "gd32vf103", "riscv"),
    rule(`${B}gd32e23`, "gd32e23x.cfg", "gd32e23", "arm"),
    rule(`${B}nrf51`, "nordic/nrf51.cfg", "nrf51", "arm"),
    rule(`${B}nrf52`, "nordic/nrf52.cfg", "nrf52", "arm"),
    rule(`${B}nrf53`, "nordic/nrf53.cfg", "nrf53", "arm"),
    rule(`${B}nrf54l`, "nordic/nrf54l.cfg", "nrf54l", "arm"),
    rule(`${B}nrf91`, "nordic/nrf91.cfg", "nrf91", "arm"),
    rule(`${B}rp2040`, "rp2040.cfg", "rp2040", "arm"),
    // RP2350 boots either Cortex-M33 or Hazard3 RISC-V images.
    rule(`${B}rp2350`, "rp2350.cfg", "rp2350", ""),
    rule(`${B}esp32[-_]?s3`, "esp32s3.cfg", "esp32s3", "xtensa"),
    rule(`${B}esp32[-_]?s2`, "esp32s2.cfg", "esp32s2", "xtensa"),
    // RISC-V ESP32 variants; their scripts ship with Espressif's OpenOCD only.
    rule(`${B}esp32[-_]?c2`, "esp32c2.cfg", "esp32c2", "riscv"),
    rule(`${B}esp32[-_]?c3`, "esp32c3.cfg", "esp32c3", "riscv"),
    rule(`${B}esp32[-_]?c6`, "esp32c6.cfg", "esp32c6", "riscv"),
    rule(`${B}esp32[-_]?h2`, "esp32h2.cfg", "esp32h2", "riscv"),
    rule(`${B}esp32[-_]?p4`, "esp32p4.cfg", "esp32p4", "riscv"),
    rule(`${B}esp32(?![-_]?[a-z]\\d)(?![a-z0-9])`, "esp32.cfg", "esp32", "xtensa")
]);

// Project metadata kinds ordered by trust: device fields written by vendor tools win over
// linker/startup names, which win over free text in build scripts.
/** @type {ReadonlyArray<[RegExp, number]>} */
const SOURCE_PRIORITIES = Object.freeze([
    [/\.ioc$/i, 0],
    [/\.(?:uvprojx|uvproj|ewp)$/i, 1],
    [/^\.cproject$/i, 1],
    [/^(?:platformio\.ini|sdkconfig)$/i, 1],
    [/\.ld$/i, 2],
    [/^startup_.*\.s$/i, 2],
    [/^(?:CMakeLists\.txt|Makefile)$/, 3],
    [/\.cmake$/i, 3]
]);
// Files that also identify the project root used to pair firmware images with the target.
const PROJECT_ROOT_SOURCE =
    /\.(?:ioc|uvprojx|uvproj|ewp)$|^(?:\.cproject|platformio\.ini|sdkconfig|CMakeLists\.txt|Makefile)$/i;
const PROJECT_FILE_GLOB =
    "**/{*.ioc,*.IOC,*.uvprojx,*.uvproj,*.ewp,.cproject,platformio.ini,sdkconfig,*.ld,startup_*.s,startup_*.S,CMakeLists.txt,Makefile,*.cmake}";
// Generated, vendored or tool-owned trees; metadata found there does not describe the project.
const PROJECT_IGNORED_DIRS = Object.freeze([
    "node_modules",
    ".git",
    ".agents",
    ".pio",
    "build",
    "dist",
    "out",
    "Debug",
    "Release",
    "CMakeFiles"
]);
const PROJECT_EXCLUDE_GLOB = `{${PROJECT_IGNORED_DIRS.map((dir) => `**/${dir}/**`).join(",")},**/.emberprobe-cubemx-*/**}`;
// Keil MDK writes .axf and IAR writes .out; both are ELF images.
const ELF_EXTENSIONS = Object.freeze([".elf", ".axf", ".out"]);
const ELF_FILE_GLOB = "**/*.{elf,axf,out,ELF,AXF,OUT}";
const ELF_IGNORED_DIRS = Object.freeze(["node_modules", ".git", "CMakeFiles"]);
const ELF_EXCLUDE_GLOB = `{${ELF_IGNORED_DIRS.map((dir) => `**/${dir}/**`).join(",")},**/.emberprobe-cubemx-*/**}`;
const MAX_PROJECT_FILES = 80;
const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024;

function sourcePriority(file) {
    const name = path.basename(String(file || ""));
    for (const [pattern, priority] of SOURCE_PRIORITIES) if (pattern.test(name)) return priority;
    return -1;
}

function isIgnoredProjectPath(file, root = "") {
    const relative = root ? path.relative(root, file) : String(file);
    const parts = relative.split(/[\\/]/).slice(0, -1);
    return parts.some((part) => PROJECT_IGNORED_DIRS.includes(part) || part.startsWith(".emberprobe-cubemx-"));
}

function isElfCandidateName(file) {
    return ELF_EXTENSIONS.includes(path.extname(String(file || "")).toLowerCase());
}

// Deterministic, trust-ordered, bounded list of project metadata files.
function orderProjectFiles(files, limit = MAX_PROJECT_FILES) {
    return files
        .filter((file) => sourcePriority(file) >= 0)
        .map((file) => ({ file, priority: sourcePriority(file), depth: String(file).split(/[\\/]/).length }))
        .sort(
            (a, b) => a.priority - b.priority || a.depth - b.depth || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
        )
        .slice(0, limit)
        .map((entry) => entry.file);
}

function rulesIn(text) {
    const value = String(text || "").toLowerCase();
    const matched = [];
    for (const candidate of TARGET_RULES) if (candidate.pattern.test(value)) matched.push(candidate);
    return matched;
}

// One family wins outright; its most specific matching variant selects the script.
function mergeRules(rules) {
    const families = [...new Set(rules.map((rule) => rule.family))];
    if (families.length !== 1) return { rule: null, families };
    const rule = rules.find((candidate) => candidate.specific) || rules[0];
    return { rule, families };
}

// Explicit device fields from vendor project files, most authoritative first.
const DEVICE_FIELDS = Object.freeze([
    /^Mcu\.UserName\s*=\s*(\S+)/im,
    /^Mcu\.CPN\s*=\s*(\S+)/im,
    /^ProjectManager\.DeviceId\s*=\s*(\S+)/im,
    /<Device>\s*([^<]+?)\s*<\/Device>/i,
    /OGChipSelectEditMenu<\/name>\s*<state>([^<\t]+)/i,
    /option\.target_mcu"[^>]*?\bvalue="([^"]+)"/i,
    /^\s*board_build\.mcu\s*=\s*(\S+)/im,
    /^CONFIG_IDF_TARGET\s*=\s*"([^"]+)"/m
]);

function deviceField(text) {
    for (const pattern of DEVICE_FIELDS) {
        const match = pattern.exec(text);
        if (match && match[1].trim()) return match[1].trim();
    }
    return "";
}

/**
 * Infers a target from one file. Structured device fields decide alone; otherwise the file
 * name, then its text; a file naming several families contributes nothing.
 * @returns {{ rules: TargetRule[], ambiguous: string[], device: string }}
 */
function analyzeProjectFile(file, text) {
    const device = deviceField(String(text || ""));
    // An explicit but unrecognized device (GD32F303, AT32...) must not fall back to
    // incidental STM32 mentions elsewhere in the same project file.
    const evidence = device ? [device] : [path.basename(String(file || "")), String(text || "")];
    for (const value of evidence) {
        const rules = rulesIn(value);
        if (!rules.length) continue;
        if (mergeRules(rules).rule) return { rules, ambiguous: [], device };
        return { rules: [], ambiguous: candidatesFor(rules), device };
    }
    return { rules: [], ambiguous: [], device };
}

function candidatesFor(rules) {
    const byFamily = new Map();
    for (const rule of rules) {
        const current = byFamily.get(rule.family);
        if (!current || (rule.specific && !current.specific)) byFamily.set(rule.family, rule);
    }
    return [...new Set([...byFamily.values()].map((rule) => rule.cfg).filter(Boolean))];
}

/**
 * @param {Array<{ file: string, text: string }>} entries ordered by orderProjectFiles
 * @param {{ preferred?: string }} [options] a user-selected project file that decides alone
 * @returns {{ target: string, source: string, device: string, candidates: string[], projectDir: string }}
 */
function resolveTarget(entries, options = {}) {
    const empty = { target: "", source: "", device: "", candidates: [], projectDir: "" };
    const analyzed = entries.map((entry) => ({ ...entry, ...analyzeProjectFile(entry.file, entry.text) }));
    const preferred = options.preferred && analyzed.find((entry) => samePath(entry.file, options.preferred));
    if (preferred) {
        const { rule } = mergeRules(preferred.rules);
        if (rule) return decidedTarget(rule, [preferred]);
        if (preferred.ambiguous.length) return { ...empty, candidates: preferred.ambiguous };
    }
    const ambiguous = new Set();
    const tiers = [...new Set(analyzed.map((entry) => sourcePriority(entry.file)))].sort((a, b) => a - b);
    for (const tier of tiers) {
        const members = analyzed.filter((entry) => sourcePriority(entry.file) === tier);
        for (const entry of members) for (const cfg of entry.ambiguous) ambiguous.add(cfg);
        const deciding = members.filter((entry) => entry.rules.length);
        if (!deciding.length) continue;
        const rules = deciding.flatMap((entry) => entry.rules);
        const { rule } = mergeRules(rules);
        if (!rule) return { ...empty, candidates: candidatesFor(rules) };
        return decidedTarget(rule, deciding);
    }
    return { ...empty, candidates: [...ambiguous] };
}

function decidedTarget(rule, sources) {
    const roots = sources.filter((entry) => PROJECT_ROOT_SOURCE.test(path.basename(entry.file)));
    const projectDirs = [...new Set(roots.map((entry) => path.dirname(entry.file)))];
    return {
        target: rule.cfg,
        source: sources[0].file,
        device: sources.find((entry) => entry.device)?.device || "",
        candidates: rule.cfg ? [rule.cfg] : [],
        projectDir: projectDirs.length === 1 ? projectDirs[0] : ""
    };
}

function samePath(a, b) {
    const left = path.resolve(String(a || ""));
    const right = path.resolve(String(b || ""));
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Backward-compatible single-text inference used by contracts and simple callers.
function targetFromText(text) {
    return resolveTarget([{ file: "", text: String(text || "") }]).target;
}

function targetArch(cfg) {
    const value = String(cfg || "");
    if (!value) return "";
    const rule = TARGET_RULES.find((candidate) => candidate.cfg === value);
    if (rule) return rule.arch;
    return /riscv|esp32[chp]\d/i.test(value) ? "riscv" : /esp32|xtensa/i.test(value) ? "xtensa" : "";
}

const ELF_MACHINES = Object.freeze({ 40: "arm", 94: "xtensa", 243: "riscv" });

// Reads e_machine from an ELF32 little-endian header; returns null for non-firmware files.
function elfHeaderInfo(header) {
    if (!header || header.length < 20) return null;
    if (header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 1 || header[5] !== 1) return null;
    const machine = header.readUInt16LE(18);
    return { machine, arch: ELF_MACHINES[machine] || "" };
}

function isInside(file, dir) {
    if (!dir) return false;
    const relative = path.relative(dir, file);
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Picks the firmware image for a target. Images whose architecture contradicts the target
 * are never chosen; images under the detected project root win over newer images elsewhere.
 * @param {Array<{ file: string, mtimeMs: number, arch: string }>} images
 * @param {{ target?: string, projectDir?: string }} [options]
 * @returns {{ elf: string, rejected: string[] }}
 */
function chooseElf(images, options = {}) {
    const expected = targetArch(options.target);
    const compatible = images.filter((image) => !expected || !image.arch || image.arch === expected);
    const rejected = images.filter((image) => !compatible.includes(image)).map((image) => image.file);
    const ranked = compatible
        .map((image) => ({ ...image, local: isInside(image.file, options.projectDir) ? 0 : 1 }))
        .sort((a, b) => a.local - b.local || b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return { elf: ranked[0]?.file || "", rejected };
}

module.exports = {
    TARGET_RULES,
    PROJECT_FILE_GLOB,
    PROJECT_EXCLUDE_GLOB,
    PROJECT_IGNORED_DIRS,
    ELF_EXTENSIONS,
    ELF_FILE_GLOB,
    ELF_EXCLUDE_GLOB,
    ELF_IGNORED_DIRS,
    MAX_PROJECT_FILES,
    MAX_PROJECT_FILE_BYTES,
    sourcePriority,
    isIgnoredProjectPath,
    isElfCandidateName,
    orderProjectFiles,
    deviceField,
    analyzeProjectFile,
    resolveTarget,
    targetFromText,
    targetArch,
    elfHeaderInfo,
    chooseElf
};
