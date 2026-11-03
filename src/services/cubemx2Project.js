"use strict";
const path = require("path");
const crypto = require("crypto");
const { failure } = require("./cubemxEnvironment");

const MAX_IOC2_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 512;
const ENTRY_PREFIX = "File: ";
// exported-files.json groups that CubeMX2 regenerates; user_code and RTE files belong to the user once written.
const OWNED_GROUPS = new Set(["generated", "project_file", "pack"]);
const USER_GROUPS = new Set(["user_code", "RTE"]);
const EXPORTED_FILES = ".settings/exported-files.json";

const invalid = (message, details) => failure("CUBEMX2_PROJECT_INVALID", message, details);

function readBasic(text, start, multiline) {
    let value = "";
    let index = start;
    const end = multiline ? '"""' : '"';
    if (multiline && text[index] === "\r" && text[index + 1] === "\n") index += 2;
    else if (multiline && text[index] === "\n") index++;
    while (index < text.length) {
        if (text.startsWith(end, index)) {
            // A closing """ may be preceded by up to two quotes that belong to the value.
            if (multiline) while (text[index + 3] === '"' && value.length < MAX_IOC2_BYTES) value += text[index++];
            return { value, next: index + end.length };
        }
        const char = text[index];
        if (!multiline && (char === "\n" || char === "\r")) break;
        if (char !== "\\") {
            value += char;
            index++;
            continue;
        }
        const escape = text[index + 1];
        const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" }[escape];
        if (simple !== undefined) {
            value += simple;
            index += 2;
        } else if (escape === "u" || escape === "U") {
            const size = escape === "u" ? 4 : 8;
            const hex = text.slice(index + 2, index + 2 + size);
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== size) break;
            value += String.fromCodePoint(parseInt(hex, 16));
            index += 2 + size;
        } else if (multiline && /[ \t\r\n]/.test(escape || "")) {
            // Line-ending backslash: skip the newline and following whitespace.
            index++;
            while (/[ \t\r\n]/.test(text[index] || "")) index++;
        } else break;
    }
    throw invalid("Unterminated or malformed string in .ioc2");
}

function readValue(text, index) {
    if (text.startsWith('"""', index)) return readBasic(text, index + 3, true);
    if (text.startsWith("'''", index)) {
        let start = index + 3;
        if (text[start] === "\r" && text[start + 1] === "\n") start += 2;
        else if (text[start] === "\n") start++;
        const close = text.indexOf("'''", start);
        if (close < 0) throw invalid("Unterminated literal string in .ioc2");
        return { value: text.slice(start, close), next: close + 3 };
    }
    if (text[index] === '"') return readBasic(text, index + 1, false);
    if (text[index] === "'") {
        const close = text.indexOf("'", index + 1);
        const value = close < 0 ? "" : text.slice(index + 1, close);
        if (close < 0 || /[\r\n]/.test(value)) throw invalid("Unterminated literal string in .ioc2");
        return { value, next: close + 1 };
    }
    throw invalid("Only string values are supported in .ioc2");
}

function readKey(text, index) {
    if (text[index] === '"') return readBasic(text, index + 1, false);
    const match = /^[A-Za-z0-9_-]+/.exec(text.slice(index, index + 256));
    if (!match) throw invalid("Malformed key in .ioc2");
    return { value: match[0], next: index + match[0].length };
}

function skipLine(text, index) {
    while (text[index] === " " || text[index] === "\t") index++;
    if (text[index] === "#") while (index < text.length && text[index] !== "\n") index++;
    if (text[index] === "\r") index++;
    if (index < text.length && text[index] !== "\n") throw invalid("Unexpected content after a value in .ioc2");
    return index + 1;
}

function safeRelative(file) {
    const normalized = file.replace(/\\/g, "/");
    return (
        !!normalized &&
        !normalized.startsWith("/") &&
        !/^[A-Za-z]:/.test(normalized) &&
        !normalized.split("/").some((part) => part === ".." || part === "") &&
        !/[\0\r\n]/.test(normalized)
    );
}

// .ioc2 is TOML: one "File: <relative path>" string per internal settings file, then a
// ["Project Description"] table. Only that subset is accepted.
function parseIoc2(content) {
    const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content ?? "");
    if (Buffer.byteLength(text) > MAX_IOC2_BYTES) throw invalid(".ioc2 exceeds 8 MiB");
    const files = new Map();
    const tables = { "": {} };
    let table = "";
    let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    while (index < text.length) {
        while (/[ \t\r\n]/.test(text[index] || "")) index++;
        if (index >= text.length) break;
        if (text[index] === "#") {
            index = skipLine(text, index);
            continue;
        }
        if (text[index] === "[") {
            const header = /^\[\s*(?:"([^"\r\n]{1,128})"|([A-Za-z0-9_-]{1,128}))\s*\]/.exec(
                text.slice(index, index + 300)
            );
            if (!header) throw invalid("Malformed table header in .ioc2");
            table = header[1] ?? header[2];
            if (tables[table]) throw invalid("Duplicate table in .ioc2", { table });
            tables[table] = {};
            index = skipLine(text, index + header[0].length);
            continue;
        }
        const key = readKey(text, index);
        index = key.next;
        while (text[index] === " " || text[index] === "\t") index++;
        if (text[index] !== "=") throw invalid("Expected '=' in .ioc2");
        index++;
        while (text[index] === " " || text[index] === "\t") index++;
        const value = readValue(text, index);
        index = skipLine(text, value.next);
        if (table === "" && key.value.startsWith(ENTRY_PREFIX)) {
            const file = key.value.slice(ENTRY_PREFIX.length);
            if (!safeRelative(file)) throw invalid("Unsafe internal path in .ioc2", { file });
            if (files.has(file)) throw invalid("Duplicate internal file in .ioc2", { file });
            if (files.size >= MAX_ENTRIES) throw invalid(".ioc2 has too many internal files");
            files.set(file, value.value);
        } else {
            if (Object.prototype.hasOwnProperty.call(tables[table], key.value))
                throw invalid("Duplicate key in .ioc2", { key: key.value });
            tables[table][key.value] = value.value;
        }
    }
    const description = tables["Project Description"];
    if (!description || !files.size || typeof description.mx2Version !== "string")
        throw invalid("Not a CubeMX2 project: Project Description or internal files are missing");
    return { files, description, tables };
}

function json(project, file) {
    const text = project.files.get(file);
    if (text === undefined) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function findFile(project, pattern) {
    return [...project.files.keys()].filter((file) => pattern.test(file)).sort();
}

// Settings read without starting CubeMX2: chip, project name, export configuration, enabled peripherals and pins.
function summarize(project, iocPath) {
    let chip = "";
    for (const file of findFile(project, /(^|\/)\.settings\/hw-composition\.store\.json$/)) {
        for (const board of json(project, file)?.boards || [])
            if (typeof board?.mcuUID === "string" && !chip) chip = board.mcuUID.split("::").pop() || "";
    }
    const exportSettings = json(project, ".settings/export-settings.store.json")?.export || {};
    const format = typeof exportSettings.lastUsedFormat === "string" ? exportSettings.lastUsedFormat : "";
    const configuration = (format && exportSettings.configurations?.[format]) || {};
    const peripherals = [];
    for (const file of findFile(project, /(^|\/)\.settings\/peripherals\.store\.json$/))
        for (const [name, value] of Object.entries(json(project, file)?.configuration || {}))
            peripherals.push({ name, ...(typeof value?.mode === "string" ? { mode: value.mode } : {}) });
    const pins = [];
    const pinout = json(project, ".settings/pinout.store.json")?.["pinout-configuration"] || {};
    for (const entry of [...(pinout.userConfigurations || []), ...(pinout.needConfigurations || [])]) {
        if (typeof entry?.pin?.name !== "string" || typeof entry.signal?.name !== "string" || pins.length >= 256)
            continue;
        pins.push({
            pin: entry.pin.name,
            signal: entry.signal.name,
            ...(typeof entry.signal.alternateFunctionId === "string"
                ? { alternateFunction: entry.signal.alternateFunctionId }
                : {})
        });
    }
    const solution = findFile(project, /^[^/]+\.csolution\.yml$/)[0] || "";
    return {
        generator: "cubemx2",
        chip,
        projectName: solution ? solution.replace(/\.csolution\.yml$/, "") : path.basename(iocPath || "", ".ioc2"),
        cubemx2Version: project.description.mx2Version,
        format,
        toolchain: typeof configuration.toolchain === "string" ? configuration.toolchain : "",
        buildProfile: typeof configuration.buildProfile === "string" ? configuration.buildProfile : "",
        outputPath: typeof configuration.outputPath === "string" ? configuration.outputPath : "",
        peripherals,
        pins,
        internalFiles: project.files.size
    };
}

/** @type {Array<[string, RegExp]>} */
const SECTIONS = [
    ["clock", /clock\.store\.json$/],
    ["pins", /(pinout|exti)\.store\.json$/],
    ["nvic", /nvic\.store\.json$/],
    ["dma", /dma\.store\.json$/],
    ["peripherals", /(peripherals|sw-configuration|part-resource-manager)\.store\.json$/],
    ["middleware", /(sw-composition|middleware-utilities-resource-manager|global-project-components)\.store\.json$/],
    ["export", /export-settings\.store\.json$/]
];

function section(file) {
    return (SECTIONS.find(([, pattern]) => pattern.test(file)) || ["other"])[0];
}

// Arrays of objects that carry a unique id (clock elements, pin configurations) are compared by that id,
// so an element CubeMX2 inserts or moves is reported once instead of shifting every later index.
function keyed(list) {
    for (const field of ["id", "needId", "name"]) {
        const keys = list.map((item) => (item && typeof item === "object" ? item[field] : undefined));
        if (keys.every((key) => typeof key === "string") && new Set(keys).size === keys.length)
            return Object.fromEntries(list.map((item, index) => [`[${field}=${keys[index]}]`, item]));
    }
    return null;
}

function leafChanges(before, after, prefix, out, limit) {
    if (out.length >= limit) return;
    const objects = (value) => value && typeof value === "object";
    if (Array.isArray(before) && Array.isArray(after)) {
        const left = keyed(before);
        const right = left && keyed(after);
        if (left && right) {
            for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
                leafChanges(left[key], right[key], prefix + key, out, limit);
            return;
        }
    }
    if (objects(before) && objects(after) && Array.isArray(before) === Array.isArray(after)) {
        for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort())
            leafChanges(before[key], after[key], prefix ? `${prefix}.${key}` : key, out, limit);
        return;
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const shown = (value) => {
        const textValue = value === undefined ? undefined : JSON.stringify(value);
        return textValue !== undefined && textValue.length > 200 ? textValue.slice(0, 200) + "..." : textValue;
    };
    out.push({ path: prefix, before: shown(before), after: shown(after) });
}

// Semantic differences per internal file. JSON stores are compared by value so that CubeMX2's key
// reordering on save is not reported; YAML and other text is compared as text.
function changes(before, after, limit = 2000) {
    const result = [];
    const files = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
    for (const file of files) {
        const left = before.files.get(file);
        const right = after.files.get(file);
        if (left === right) continue;
        const entry = { file, section: section(file) };
        if (left === undefined || right === undefined) {
            result.push({ ...entry, action: left === undefined ? "added" : "deleted" });
            continue;
        }
        let parsed;
        try {
            parsed = [JSON.parse(left), JSON.parse(right)];
        } catch {
            parsed = null;
        }
        if (parsed) {
            const leaves = [];
            leafChanges(parsed[0], parsed[1], "", leaves, limit);
            for (const leaf of leaves) result.push({ ...entry, action: "modified", ...leaf });
        } else result.push({ ...entry, action: "modified" });
        if (result.length >= limit) break;
    }
    return result.slice(0, limit);
}

function categorize(list) {
    const groups = Object.fromEntries([...SECTIONS.map(([name]) => name), "other"].map((name) => [name, []]));
    for (const item of list) groups[item.section].push(item);
    return groups;
}

// The working area (CubeMX2's per-project scratch directory) is keyed by workingAreaId. Staged copies get
// their own id so they never share a working area with the user's project.
function withWorkingArea(content, id) {
    const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
    const pattern = /^(workingAreaId\s*=\s*)"[^"\r\n]*"/m;
    if (!pattern.test(text)) throw invalid(".ioc2 has no workingAreaId");
    return text.replace(pattern, `$1"${id}"`);
}

function newWorkingAreaId() {
    return crypto.randomUUID();
}

// exported-files.json: relative path -> fileGroup. The file lists itself only implicitly.
function exportedGroups(bytes) {
    let data;
    try {
        data = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
        throw failure("CUBEMX2_OUTPUT_INVALID", "Generated .settings/exported-files.json is not valid JSON");
    }
    if (!Array.isArray(data?.files))
        throw failure("CUBEMX2_OUTPUT_INVALID", "Generated .settings/exported-files.json has no file list");
    const groups = new Map();
    for (const entry of data.files) {
        if (typeof entry?.file !== "string" || typeof entry.fileGroup !== "string" || !safeRelative(entry.file))
            throw failure("CUBEMX2_OUTPUT_INVALID", "Generated file list contains an unsafe entry", {
                file: String(entry?.file)
            });
        groups.set(entry.file.replace(/\\/g, "/"), entry.fileGroup);
    }
    return groups;
}

// Compare exported-files.json without its generation timestamp.
function comparable(file, bytes) {
    if (file.replace(/\\/g, "/") !== EXPORTED_FILES) return bytes;
    try {
        const { timestamp: _timestamp, ...rest } = JSON.parse(Buffer.from(bytes).toString("utf8"));
        return Buffer.from(JSON.stringify(rest));
    } catch {
        return bytes;
    }
}

function sameContent(file, left, right) {
    if (!left || !right) return left === right;
    if (left.hash === right.hash) return true;
    return Buffer.compare(comparable(file, left.bytes), comparable(file, right.bytes)) === 0;
}

module.exports = {
    MAX_IOC2_BYTES,
    OWNED_GROUPS,
    USER_GROUPS,
    EXPORTED_FILES,
    parseIoc2,
    summarize,
    changes,
    categorize,
    section,
    withWorkingArea,
    newWorkingAreaId,
    exportedGroups,
    sameContent,
    safeRelative
};
