"use strict";
const fs = require("fs/promises");
const path = require("path");
const { parseProperties } = require("./javaProperties");
const { inside, failure } = require("./cubemxEnvironment");

function categorizeChanges(changesList) {
    const summary = {
        ips: [],
        pins: [],
        clock: [],
        metadata: [],
        other: []
    };
    for (const item of changesList) {
        const key = item.key;
        if (
            /^Mcu\.IP/i.test(key) ||
            /^(?:USART|UART|SPI|I2C|TIM|CAN|ADC|DAC|DMA|NVIC|USB|ETH|FMC|RTC)\d*\./i.test(key)
        ) {
            summary.ips.push(item);
        } else if (/^Mcu\.Pin/i.test(key) || /^(?:P[A-K]\d+|VP_|\w+\.Signal)/i.test(key)) {
            summary.pins.push(item);
        } else if (/^(?:RCC\b|Clock|PLL|HCLK|SYSCLK|APB|Prescaler)/i.test(key) || /Clock/i.test(key)) {
            summary.clock.push(item);
        } else if (/^(?:ProjectManager\.|MxCube\.|Mcu\.Name|Mcu\.Family|Mcu\.CPN|Mcu\.Package)/i.test(key)) {
            summary.metadata.push(item);
        } else {
            summary.other.push(item);
        }
    }
    return summary;
}

function validateStructuralIoc(values) {
    if (values["Mcu.IPNb"] !== undefined) {
        const n = parseInt(values["Mcu.IPNb"], 10);
        if (Number.isNaN(n) || n < 0 || String(n) !== values["Mcu.IPNb"].trim())
            throw failure("CUBEMX_IOC_INVALID", "Mcu.IPNb must be a non-negative integer", {
                value: values["Mcu.IPNb"]
            });
        const seenIPs = new Set();
        for (let i = 0; i < n; i++) {
            const key = `Mcu.IP${i}`;
            const val = values[key];
            if (val === undefined)
                throw failure("CUBEMX_IOC_INVALID", `Missing contiguous IP definition ${key} (IPNb=${n})`, { key });
            if (seenIPs.has(val))
                throw failure("CUBEMX_IOC_INVALID", `Duplicate IP definition in ${key}: ${val}`, { key, ip: val });
            seenIPs.add(val);
        }
        for (const key of Object.keys(values)) {
            const match = key.match(/^Mcu\.IP(\d+)$/);
            if (match && parseInt(match[1], 10) >= n) {
                throw failure("CUBEMX_IOC_INVALID", `Orphaned IP definition ${key} exceeds declared Mcu.IPNb=${n}`, {
                    key
                });
            }
        }
    }

    const pinNbKey = values["Mcu.PinsNb"] !== undefined ? "Mcu.PinsNb" : "Mcu.PinNb";
    if (values[pinNbKey] !== undefined) {
        const rawValue = values[pinNbKey];
        const n = parseInt(rawValue, 10);
        if (Number.isNaN(n) || n < 0 || String(n) !== String(rawValue).trim())
            throw failure("CUBEMX_IOC_INVALID", `${pinNbKey} must be a non-negative integer`, {
                value: rawValue
            });
        const seenPins = new Set();
        for (let i = 0; i < n; i++) {
            const key = `Mcu.Pin${i}`;
            const val = values[key];
            if (val === undefined)
                throw failure("CUBEMX_IOC_INVALID", `Missing contiguous Pin definition ${key} (${pinNbKey}=${n})`, {
                    key
                });
            if (seenPins.has(val))
                throw failure("CUBEMX_IOC_INVALID", `Duplicate Pin definition in ${key}: ${val}`, { key, pin: val });
            seenPins.add(val);
        }
        for (const key of Object.keys(values)) {
            const match = key.match(/^Mcu\.Pin(\d+)$/);
            if (match && parseInt(match[1], 10) >= n) {
                throw failure(
                    "CUBEMX_IOC_INVALID",
                    `Orphaned Pin definition ${key} exceeds declared ${pinNbKey}=${n}`,
                    {
                        key
                    }
                );
            }
        }
    }
}

function deriveCandidate(content, updates = {}, deletions = []) {
    if (!updates || typeof updates !== "object" || Array.isArray(updates))
        throw new Error("Changes must be a JSON object");
    if (!Array.isArray(deletions)) throw new Error("Deletions must be an array of string keys");

    const deleteSet = new Set();
    for (const key of deletions) {
        if (!key || typeof key !== "string" || /\0/.test(key))
            throw new Error("Deletion keys must be non-empty strings without NUL");
        if (Object.hasOwn(updates, key))
            throw failure("INVALID_ARGUMENT", "Cannot both update and delete the same property: " + key);
        deleteSet.add(key);
    }

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

    for (const delKey of deleteSet) {
        if (before[delKey] !== undefined) {
            changes.push({ key: delKey, previous: before[delKey], requested: null, action: "deleted" });
            const record = records.find((entry) => entry.key === delKey);
            if (record) {
                const bom = record.start === 0 && content.startsWith("\uFEFF") ? "\uFEFF" : "";
                replacements.push({ ...record, text: bom });
            }
        }
    }

    for (const [key, value] of Object.entries(updates)) {
        if (!key || typeof value !== "string" || /\0/.test(key + value))
            throw new Error("Keys must be nonempty and values must be strings without NUL");
        if (before[key] === value) continue;
        changes.push({
            key,
            previous: before[key] ?? null,
            requested: value,
            action: before[key] !== undefined ? "modified" : "added"
        });
        const record = records.find((entry) => entry.key === key);
        const assignment = escape(key) + "=" + escape(value);
        if (record) {
            const ending = lines[record.end]?.match(/(?:\r\n|\n|\r)$/)?.[0] || "";
            const bom = record.start === 0 && content.startsWith("\uFEFF") ? "\uFEFF" : "";
            replacements.push({ ...record, text: bom + assignment + ending });
        } else appended += assignment + newline;
    }

    for (const record of replacements.sort((a, b) => b.start - a.start)) {
        const replacementLines = record.text ? [record.text] : [];
        lines.splice(record.start, record.end - record.start + 1, ...replacementLines);
    }

    let candidate = lines.join("");
    if (appended) candidate += (candidate && !/[\r\n]$/.test(candidate) ? newline : "") + appended;
    const parsedCandidate = parseProperties(candidate);
    validateStructuralIoc(parsedCandidate);

    return { content: candidate, changes, categorizedChanges: categorizeChanges(changes) };
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

    let updates = params.changes || {};
    let deletions = params.deletions || [];

    if (params.changesFile) {
        if (params.changes && Object.keys(params.changes).length > 0)
            throw failure("INVALID_ARGUMENT", "Provide changes or changesFile, not both");
        const changesPath = path.resolve(workspace, params.changesFile);
        if (!inside(workspace, changesPath))
            throw failure("PATH_OUTSIDE_WORKSPACE", "Changes file must be inside workspace");
        const stat = await fs.stat(changesPath).catch(() => null);
        if (!stat || !stat.isFile()) throw failure("INVALID_ARGUMENT", "Changes file does not exist or is not a file");
        if (stat.size > 1024 * 1024) throw failure("INVALID_ARGUMENT", "Changes file exceeds 1 MiB");
        const parsed = JSON.parse(await fs.readFile(changesPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if (parsed.updates || parsed.deletions) {
                updates = parsed.updates || {};
                deletions = Array.from(new Set([...deletions, ...(parsed.deletions || [])]));
            } else {
                updates = parsed;
            }
        } else {
            throw failure("INVALID_ARGUMENT", "Changes file must contain a JSON object");
        }
    }

    const result = deriveCandidate(await fs.readFile(source, "utf8"), updates, deletions);
    if (Buffer.byteLength(result.content) > 1024 * 1024) throw failure("CUBEMX_IOC_INVALID", "Candidate exceeds 1 MiB");
    const candidatePath = path.join(parent, path.basename(output));
    await fs.writeFile(candidatePath, result.content, { flag: "wx" });
    return {
        source,
        candidatePath,
        changes: result.changes,
        categorizedChanges: result.categorizedChanges,
        validated: "structural-and-properties-syntax"
    };
}

module.exports = {
    deriveCandidate,
    generateCandidate,
    categorizeChanges,
    validateStructuralIoc
};
