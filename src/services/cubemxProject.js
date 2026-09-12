"use strict";
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { failure, inside } = require("./cubemxEnvironment");
const { parseProperties } = require("./javaProperties");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const ignored = (name) =>
    [".git", ".agents", "node_modules", "build", "dist", "Debug", "Release"].includes(name) ||
    name.startsWith(".emberprobe-cubemx-");

function parseIoc(content) {
    if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024 || content.includes("\0"))
        throw failure("CUBEMX_IOC_INVALID", ".ioc must be UTF-8 text under 1 MiB");
    const values = parseProperties(content);
    if (
        !/^STM32/i.test(values["Mcu.Name"] || "") ||
        !values["MxCube.Version"] ||
        !values["ProjectManager.TargetToolchain"]
    )
        throw failure("CUBEMX_IOC_INVALID", "Missing STM32 identity, CubeMX version or toolchain");
    if (values["ProjectManager.KeepUserCode"] !== "true")
        throw failure("CUBEMX_USER_CODE_DISABLED", "Enable Keep User Code before generating");
    for (const [key, value] of Object.entries(values)) {
        if (
            /User.*(?:Command|Script)|UAScript|(?:Pre|Post).*?(?:Command|Script)|Custom.*(?:Template|Firmware)|TemplatePath/i.test(
                key
            ) &&
            value &&
            !/^(false|none)$/i.test(value)
        )
            throw failure("CUBEMX_LAYOUT_UNSUPPORTED", "Custom generation hooks and templates are unsupported", {
                key
            });
        if (/(?:Path|Location|Folder|FileName)$/i.test(key) && /(?:\.\.|[A-Za-z]:|^[/\\])/.test(value))
            throw failure("CUBEMX_LAYOUT_UNSUPPORTED", "External project paths are unsupported", { key });
    }
    if (!["true", "false"].includes(values["ProjectManager.UnderRoot"]))
        throw failure("CUBEMX_LAYOUT_UNSUPPORTED", "UnderRoot must be true or false");
    return values;
}
function changes(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .sort()
        .filter((key) => before[key] !== after[key])
        .map((key) => ({ key, previous: before[key] ?? null, requested: after[key] ?? null }));
}
async function snapshot(root, relative = "", result = new Map()) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        if (ignored(entry.name)) continue;
        const name = path.join(relative, entry.name);
        const absolute = path.join(root, name);
        if (entry.isSymbolicLink() || !inside(root, await fs.realpath(absolute)))
            throw failure("CUBEMX_LAYOUT_UNSUPPORTED", "Linked project files are unsupported", { file: name });
        if (entry.isDirectory()) await snapshot(root, name, result);
        else if (entry.isFile()) {
            const bytes = await fs.readFile(absolute);
            result.set(name, { bytes, hash: hash(bytes) });
        } else throw failure("CUBEMX_LAYOUT_UNSUPPORTED", "Unsupported project entry", { file: name });
    }
    return result;
}
function fileDiff(before, after) {
    return [...new Set([...before.keys(), ...after.keys()])]
        .sort()
        .filter((name) => before.get(name)?.hash !== after.get(name)?.hash)
        .map((file) => ({ file, action: !before.has(file) ? "added" : !after.has(file) ? "deleted" : "modified" }));
}
async function materialize(root, files) {
    for (const [name, value] of files) {
        await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await fs.writeFile(path.join(root, name), value.bytes);
    }
}
async function currentHash(file) {
    return fs
        .readFile(file)
        .then(hash)
        .catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
}
function assertUserCodePreserved(before, after) {
    for (const [name, original] of before) {
        if (!/\.[ch]$/i.test(name)) continue;
        const text = original.bytes.toString("utf8");
        const output = after.get(name)?.bytes.toString("utf8") || "";
        for (const match of text.matchAll(/\/\* USER CODE BEGIN ([^*\r\n]+)\*\/([\s\S]*?)\/\* USER CODE END \1\*\//g)) {
            if (match[2].trim() && !output.replace(/\r\n/g, "\n").includes(match[0].replace(/\r\n/g, "\n")))
                throw failure("CUBEMX_USER_CODE_CHANGED", "Generation would remove or change user code", {
                    file: name,
                    block: match[1].trim()
                });
        }
    }
}
async function applyFiles(root, before, after, backup, options = {}) {
    const diff = fileDiff(before, after);
    const current = await snapshot(root);
    if (fileDiff(before, current).length)
        throw failure("CUBEMX_PROJECT_CHANGED", "Project changed during generation; prepare again");
    await materialize(backup, before);
    const applied = [];
    try {
        for (const item of diff) {
            const file = path.join(root, item.file);
            if ((await currentHash(file)) !== before.get(item.file)?.hash)
                throw failure("CUBEMX_PROJECT_CHANGED", "File changed during writeback", item);
            await fs.mkdir(path.dirname(file), { recursive: true });
            if (!inside(root, await fs.realpath(path.dirname(file))))
                throw failure("CUBEMX_PROJECT_CHANGED", "Output directory changed during generation");
            if (after.has(item.file)) {
                const temporary = path.join(
                    path.dirname(file),
                    ".emberprobe-cubemx-write-" + crypto.randomBytes(8).toString("hex")
                );
                try {
                    await (options.writeFile || fs.writeFile)(temporary, after.get(item.file).bytes, { flag: "wx" });
                    if ((await currentHash(file)) !== before.get(item.file)?.hash)
                        throw failure("CUBEMX_PROJECT_CHANGED", "File changed during writeback", item);
                    await fs.rename(temporary, file);
                } finally {
                    if (inside(root, await fs.realpath(path.dirname(file)))) await fs.unlink(temporary).catch(() => {});
                }
            } else await fs.unlink(file);
            applied.push(item);
        }
    } catch (error) {
        const conflicts = [];
        for (const item of applied.reverse()) {
            const file = path.join(root, item.file);
            try {
                if (
                    !inside(root, await fs.realpath(path.dirname(file))) ||
                    (await fs.lstat(file).catch(() => null))?.isSymbolicLink()
                ) {
                    conflicts.push(item.file);
                    continue;
                }
                if ((await currentHash(file)) !== after.get(item.file)?.hash) {
                    conflicts.push(item.file);
                    continue;
                }
                if (before.has(item.file)) await fs.writeFile(file, before.get(item.file).bytes);
                else await fs.unlink(file);
            } catch {
                conflicts.push(item.file);
            }
        }
        throw failure("CUBEMX_WRITE_FAILED", error.message, { backup, conflicts });
    }
    return diff;
}
module.exports = { hash, parseIoc, changes, snapshot, fileDiff, materialize, applyFiles, assertUserCodePreserved };
