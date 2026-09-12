"use strict";
const fs = require("fs/promises");
const path = require("path");
const { parseProperties } = require("./javaProperties");
const { inside, failure } = require("./cubemxEnvironment");

function deriveCandidate(content, updates) {
    if (!updates || typeof updates !== "object" || Array.isArray(updates))
        throw new Error("Changes must be a JSON object");
    const records = [];
    const before = parseProperties(content, records);
    const lines = content.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
    const newline = content.match(/\r\n|\n|\r/)?.[0] || "\n";
    const escape = (value) =>
        value.replace(
            /[\\\t\r\n\f =:#!]/g,
            (c) => ({ "\t": "\\t", "\r": "\\r", "\n": "\\n", "\f": "\\f" })[c] || "\\" + c
        );
    const changes = [];
    const replacements = [];
    let appended = "";
    for (const [key, value] of Object.entries(updates)) {
        if (!key || typeof value !== "string" || /\0/.test(key + value))
            throw new Error("Keys must be nonempty and values must be strings without NUL");
        if (before[key] === value) continue;
        changes.push({ key, previous: before[key] ?? null, requested: value });
        const record = records.find((entry) => entry.key === key);
        const assignment = escape(key) + "=" + escape(value);
        if (record) {
            const ending = lines[record.end]?.match(/(?:\r\n|\n|\r)$/)?.[0] || "";
            const bom = record.start === 0 && content.startsWith("\uFEFF") ? "\uFEFF" : "";
            replacements.push({ ...record, text: bom + assignment + ending });
        } else appended += assignment + newline;
    }
    for (const record of replacements.sort((a, b) => b.start - a.start))
        lines.splice(record.start, record.end - record.start + 1, record.text);
    let candidate = lines.join("");
    if (appended) candidate += (candidate && !/[\r\n]$/.test(candidate) ? newline : "") + appended;
    parseProperties(candidate);
    return { content: candidate, changes };
}
async function generateCandidate(options, params) {
    const source = await fs.realpath(options.config().iocPath || "");
    const roots = await Promise.all(options.roots().map((root) => fs.realpath(root)));
    const workspace = roots.find((root) => inside(root, source));
    if (!workspace || path.extname(source).toLowerCase() !== ".ioc")
        throw failure("PATH_OUTSIDE_WORKSPACE", "Select a workspace .ioc first");
    if (!params.outputPath) throw failure("INVALID_ARGUMENT", "Specify a new candidate output path");
    const output = path.resolve(workspace, params.outputPath);
    const parent = await fs.realpath(path.dirname(output));
    if (!inside(workspace, parent) || output === source)
        throw failure("PATH_OUTSIDE_WORKSPACE", "Candidate must be a separate workspace file");
    if ((await fs.stat(source)).size > 1024 * 1024) throw failure("CUBEMX_IOC_INVALID", "Source exceeds 1 MiB");
    const result = deriveCandidate(await fs.readFile(source, "utf8"), params.changes || {});
    if (Buffer.byteLength(result.content) > 1024 * 1024) throw failure("CUBEMX_IOC_INVALID", "Candidate exceeds 1 MiB");
    const candidatePath = path.join(parent, path.basename(output));
    await fs.writeFile(candidatePath, result.content, { flag: "wx" });
    return { source, candidatePath, changes: result.changes, validated: "properties-syntax-only" };
}
module.exports = { deriveCandidate, generateCandidate };
