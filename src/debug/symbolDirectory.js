"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const { symbolImages } = require("../services/debugImages");
const { readElf32Header, readSectionEntries, readSectionNames } = require("../elfFormat");
const { quote } = require("./mi");

const runFile = promisify(execFile);
const MAX_SYMBOLS = 100000;
const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const fileKey = (value) => String(value || "").replace(/\\/g, "/");
const qualified = (file, name) => `'${file.replace(/'/g, "\\'")}'::${name}`;
const identity = (entry) => `${entry.isStatic}:${entry.file}:${entry.name}`;

function symbolExpression(name) {
    // GDB includes ABI tags in the catalog, although C++ source expressions omit them.
    return String(name).replace(/\[abi:[^\]]+\]/g, "");
}

function debugSymbols(result) {
    const entries = [];
    for (const group of asList(result.symbols?.debug)) {
        const file = fileKey(group.fullname || group.filename);
        for (const item of asList(group.symbols)) {
            if (typeof item.name !== "string" || !item.name) continue;
            const name = symbolExpression(item.name);
            const isStatic = /^\s*static\b/.test(item.description || "");
            entries.push({
                name,
                type: item.type,
                file,
                isStatic,
                expression: isStatic ? qualified(file, name) : `::${name}`
            });
            if (entries.length > MAX_SYMBOLS) throw new Error("Debug symbol directory limit exceeded");
        }
    }
    return entries;
}

function nmSymbols(output) {
    const entries = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*([\da-fA-F]+)\s+([\da-fA-F]+)\s+([bBdDrRsSvVgGu])\s+([^\t]+)(?:\t(.+?):\d+)?$/);
        if (!match) continue;
        const name = symbolExpression(match[4].trim());
        const file = fileKey(match[5]);
        const isStatic = /[bdrsg]/.test(match[3]);
        // Internal-linkage objects without a source file cannot be safely disambiguated.
        if (isStatic && !file) continue;
        entries.push({
            name,
            file,
            isStatic,
            address: `0x${match[1]}`,
            size: parseInt(match[2], 16),
            expression: isStatic ? qualified(file, name) : `::${name}`
        });
        if (entries.length > MAX_SYMBOLS) throw new Error("Debug symbol directory limit exceeded");
    }
    return entries;
}

function signedInteger(value) {
    return String(value).startsWith("-") ? -BigInt(String(value).slice(1)) : BigInt(value);
}
function imageSections(image) {
    if (image.textaddress === undefined && !image.sections?.length) return null;
    if (fs.statSync(image.file).size > 64 * 1024 * 1024) throw new Error("Symbol image section budget exceeded");
    const buffer = fs.readFileSync(image.file);
    const header = readElf32Header(buffer);
    const sections = readSectionEntries(buffer, header);
    const names = readSectionNames(buffer, sections, header.shstrndx);
    return sections.map((section, index) => ({ ...section, name: names[index] }));
}
function relocatedAddress(entry, image, sections) {
    const address = BigInt(entry.address);
    let offset = signedInteger(image.offset || "0");
    if (sections) {
        const candidates = sections.filter(
            (section) =>
                section.flags & 2 &&
                address >= BigInt(section.addr) &&
                address < BigInt(section.addr) + BigInt(section.size)
        );
        if (candidates.length !== 1) return null;
        const section = candidates[0];
        const replacement =
            image.sections?.find((item) => item.name === section.name)?.address ??
            (section.name === ".text" ? image.textaddress : undefined);
        if (replacement !== undefined) offset = BigInt(replacement) - BigInt(section.addr);
    }
    const result = address + offset;
    return result >= 0n && result <= 0xffffffffn ? `0x${result.toString(16)}` : null;
}

class SymbolDirectory {
    constructor(session, run = runFile) {
        this.session = session;
        this.run = run;
        this.entries = null;
    }
    reset() {
        this.entries = null;
    }
    async load(options = { symbolSetup: false }) {
        if (this.entries) return this.entries;
        const config = this.session.config || {};
        const images = symbolImages(config);
        if (!images.length) return (this.entries = []);
        const deadline = Date.now() + 15000;
        const symbolSetup = options.symbolSetup && !this.session.ready && !this.session.running;
        let entries;
        let fallback = false;
        try {
            entries = debugSymbols(await this.session.mi.command("-symbol-info-variables"));
        } catch (error) {
            // Only an unsupported MI command warrants a fallback. Transport failures must propagate.
            if (!/undefined MI command|unknown command|not supported|unrecognized/i.test(error.message)) throw error;
            fallback = true;
            this.session.variableDiagnostic("GDB symbol catalog unavailable; using the nm directory.\n");
        }
        if (fallback || images.length > 1) {
            // MI omits objfile identity. Match its typed catalog to each configured image's nm directory.
            const nm = config.nmPath || (config.objdumpPath && config.objdumpPath.replace(/objdump(\.exe)?$/i, "nm$1"));
            if (!nm) throw new Error("Symbol image identity requires the matching nm/objdump toolchain");
            if (typeof nm !== "string" || !nm.trim() || /[\x00-\x1f]/.test(nm))
                throw new Error("nmPath must name an nm executable");
            const catalog = new Map((entries || []).map((entry) => [identity(entry), entry]));
            const byImage = [];
            for (const image of images) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw new Error("Symbol image directory time budget exceeded");
                const result = await this.run(nm, ["--defined-only", "-S", "-l", "-C", image.file], {
                    windowsHide: true,
                    timeout: Math.min(10000, remaining),
                    maxBuffer: 8 * 1024 * 1024
                });
                const sections = imageSections(image);
                for (const entry of nmSymbols(String(result.stdout))) {
                    const typed = catalog.get(identity(entry));
                    if (!fallback && !typed) continue;
                    byImage.push({
                        ...entry,
                        ...typed,
                        image: fileKey(image.file),
                        symbolAddress: relocatedAddress(entry, image, sections)
                    });
                    if (byImage.length > MAX_SYMBOLS) throw new Error("Debug symbol directory limit exceeded");
                }
            }
            entries = byImage;
        } else entries = entries.map((entry) => ({ ...entry, image: fileKey(images[0].file) }));
        // Include image and source identity: repeated firmware filenames must not merge objects.
        const unique = new Map(entries.map((entry) => [`${entry.image}:${identity(entry)}`, entry]));
        const ordered = [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
        const counts = new Map();
        const fileCounts = new Map();
        for (const entry of ordered) {
            const name = `${entry.isStatic}:${entry.name}`;
            counts.set(name, (counts.get(name) || 0) + 1);
            fileCounts.set(identity(entry), (fileCounts.get(identity(entry)) || 0) + 1);
        }
        for (const entry of ordered) {
            if (fileCounts.get(identity(entry)) > 1) entry.expression = null;
            else if (!entry.isStatic && counts.get(`false:${entry.name}`) > 1)
                entry.expression = entry.file ? qualified(entry.file, entry.name) : null;
            if (images.length > 1 && entry.expression && counts.get(`${entry.isStatic}:${entry.name}`) > 1)
                await this.verifyExpression(entry, deadline, symbolSetup);
        }
        return (this.entries = ordered);
    }
    async verifyExpression(entry, deadline, symbolSetup = false) {
        if (Date.now() > deadline) throw new Error("Symbol image directory time budget exceeded");
        if (!symbolSetup) this.session.paused?.();
        if (!entry.symbolAddress) {
            entry.expression = null;
            return;
        }
        try {
            const evaluate = async (expression) => {
                const result = await this.session.mi.command(`-data-evaluate-expression ${quote(expression)}`);
                const match = String(result.value).match(/^\s*(0x[\da-f]+|\d+)(?=\s|$)/i);
                return match ? BigInt(match[1]) : null;
            };
            const actual = await evaluate(`(unsigned long long)&(${entry.expression})`);
            if (actual === BigInt(entry.symbolAddress)) return;
            // GDB can resolve a file-qualified global to the other image. Only scalar builtin
            // types have an independent, unambiguous type; complex objects must remain unavailable.
            const type = String(entry.type || "").trim();
            const words = type.replace(/\*/g, " ").trim().split(/\s+/);
            const builtin =
                /^[a-z\s*]+$/.test(type) &&
                words.every((word) =>
                    /^(?:const|volatile|signed|unsigned|long|short|int|char|bool|float|double|void)$/.test(word)
                );
            entry.expression =
                builtin && entry.size > 0 && (await evaluate(`sizeof(${type})`)) === BigInt(entry.size)
                    ? `*(${type} *)${entry.symbolAddress}`
                    : null;
        } catch (error) {
            if (!/No symbol|not defined|not available|Cannot resolve|syntax error|optimized/i.test(error.message))
                throw error;
            entry.expression = null;
        }
    }
    async variables(kind, file) {
        const entries = (await this.load()).filter((entry) =>
            kind === "globals" ? !entry.isStatic : entry.isStatic && fileKey(entry.file) === fileKey(file)
        );
        const counts = new Map();
        for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) || 0) + 1);
        return entries.map((entry) => ({
            ...entry,
            name:
                counts.get(entry.name) > 1
                    ? `${entry.name} (${entry.file}${entry.image ? `; ${entry.image}` : ""})`
                    : entry.name
        }));
    }
}

module.exports = { SymbolDirectory, debugSymbols, nmSymbols, relocatedAddress, fileKey, asList };
