"use strict";

const fs = require("fs");
const path = require("path");
const { quote } = require("../debug/mi");
const { readElf32Header } = require("../elfFormat");

const HOOKS = [
    "preLaunchCommands",
    "postLaunchCommands",
    "preAttachCommands",
    "postAttachCommands",
    "preResetCommands",
    "postResetCommands"
];
const gdbPath = (file) => file.replace(/\\/g, "/");

function address(value, signed = false) {
    if (
        (typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "number" && !Number.isSafeInteger(value)) ||
        !/^-?(?:0x[\da-f]+|\d+)$/i.test(String(value))
    )
        throw new Error("Image addresses must be integer or hexadecimal literals");
    const negative = String(value).startsWith("-");
    const number = BigInt(negative ? String(value).slice(1) : String(value)) * (negative ? -1n : 1n);
    if (number > 0xffffffffn || number < (signed ? -0xffffffffn : 0n))
        throw new Error("Image address is outside ARM32 range");
    return number < 0n ? `-0x${(-number).toString(16)}` : `0x${number.toString(16)}`;
}
function imageFile(value, cwd) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value))
        throw new Error("Provide a valid image file path");
    const file = path.resolve(cwd, value);
    if (!fs.statSync(file).isFile()) throw new Error(`Image is not a file: ${file}`);
    return fs.realpathSync(file);
}
function loadRange(start, length, offset) {
    const base =
        BigInt(start) + (String(offset).startsWith("-") ? -BigInt(String(offset).slice(1)) : BigInt(offset || 0));
    if (base < 0n || base + BigInt(length) > 0x100000000n)
        throw new Error("Load image relocation exceeds the ARM32 address range");
}
function validateLoadImage(image) {
    if (image.format === "bin") return;
    const size = fs.statSync(image.file).size;
    if (image.format === "elf") {
        const fd = fs.openSync(image.file, "r");
        try {
            const headerBytes = Buffer.alloc(52);
            if (fs.readSync(fd, headerBytes, 0, 52, 0) !== 52) throw new Error("Truncated ELF load image");
            const header = readElf32Header(headerBytes);
            if (header.machine !== 0x28) throw new Error("ELF load image must target ARM");
            if (header.phnum > 4096 || header.phentsize < 32 || header.phoff + header.phnum * header.phentsize > size)
                throw new Error("Invalid ELF load segment table");
            const segment = Buffer.alloc(32);
            for (let index = 0; index < header.phnum; index++) {
                if (fs.readSync(fd, segment, 0, 32, header.phoff + index * header.phentsize) !== 32)
                    throw new Error("Truncated ELF load segment");
                if (segment.readUInt32LE(0) !== 1) continue;
                const length = segment.readUInt32LE(16);
                if (segment.readUInt32LE(4) + length > size) throw new Error("ELF load segment exceeds the file");
                if (length) loadRange(segment.readUInt32LE(12), length, image.offset);
            }
        } finally {
            fs.closeSync(fd);
        }
        return;
    }
    if (size > 64 * 1024 * 1024) throw new Error("HEX validation file budget exceeded (64 MiB)");
    let base = 0,
        ended = false;
    for (const line of fs.readFileSync(image.file, "utf8").split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        if (ended || !/^:[\da-f]+$/i.test(text) || text.length > 521 || text.length % 2 !== 1)
            throw new Error("Invalid Intel HEX record");
        const record = Buffer.from(text.slice(1), "hex");
        if (record.length < 5) throw new Error("Truncated Intel HEX record");
        const count = record[0],
            address = record.readUInt16BE(1),
            type = record[3];
        if (record.length !== count + 5 || record.reduce((sum, byte) => sum + byte, 0) % 256)
            throw new Error("Invalid Intel HEX length or checksum");
        if (type === 0) {
            if (count) loadRange(base + address, count, image.offset);
        } else if (type === 1 && count === 0 && address === 0) ended = true;
        else if ((type === 2 || type === 4) && count === 2 && address === 0)
            base = record.readUInt16BE(4) * (type === 2 ? 16 : 65536);
        else if ((type === 3 || type === 5) && count === 4 && address === 0) {
            /* Entry point record, not a transfer. */
        } else throw new Error("Unsupported Intel HEX record type or length");
    }
    if (!ended) throw new Error("Intel HEX end-of-file record is missing");
}
function normalizeDebugImages(config, cwd = config.cwd || process.cwd()) {
    const result = {};
    for (const key of HOOKS) {
        const commands = config[key];
        if (commands === undefined) continue;
        if (
            !Array.isArray(commands) ||
            commands.length > 64 ||
            commands.some(
                (command) =>
                    typeof command !== "string" ||
                    !command.trim() ||
                    command.length > 16384 ||
                    /[\x00-\x1f]/.test(command)
            )
        )
            throw new Error(`${key} must contain at most 64 single-line GDB commands`);
        result[key] = [...commands];
    }
    for (const key of ["symbolFiles", "loadFiles"]) {
        if (config[key] === undefined) continue;
        if (!Array.isArray(config[key]) || config[key].length > 32)
            throw new Error(`${key} must contain at most 32 images`);
        result[key] = config[key].map((value) => {
            const entry = typeof value === "string" ? { file: value } : value;
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid ${key} entry`);
            const allowed =
                key === "symbolFiles"
                    ? ["file", "offset", "textaddress", "sections"]
                    : ["file", "format", "address", "offset"];
            if (Object.keys(entry).some((name) => !allowed.includes(name)))
                throw new Error(`Unknown ${key} image property`);
            const item = { file: imageFile(entry.file, cwd) };
            if (entry.offset !== undefined) item.offset = address(entry.offset, true);
            if (key === "symbolFiles") {
                if (entry.textaddress !== undefined) item.textaddress = address(entry.textaddress);
                if (entry.sections !== undefined) {
                    if (!Array.isArray(entry.sections) || entry.sections.length > 128)
                        throw new Error("Image sections must be an array with at most 128 entries");
                    const seen = new Set();
                    item.sections = entry.sections.map((section) => {
                        if (
                            !section ||
                            !/^[.\w$][.\w$-]{0,127}$/.test(section.name || "") ||
                            seen.has(section.name) ||
                            Object.keys(section).some((name) => !["name", "address"].includes(name))
                        )
                            throw new Error("Invalid or duplicate image section name");
                        seen.add(section.name);
                        return { name: section.name, address: address(section.address) };
                    });
                }
            } else {
                item.format = entry.format || path.extname(item.file).slice(1).toLowerCase();
                if (!["elf", "hex", "bin"].includes(item.format))
                    throw new Error("Load images must be ELF, HEX or BIN");
                if (entry.address !== undefined) item.address = address(entry.address);
                if (item.format === "bin" && item.address === undefined)
                    throw new Error("BIN load images require an explicit address");
                if (item.format === "bin" && item.offset !== undefined)
                    throw new Error("Use address, not offset, for BIN images");
                if (item.format !== "bin" && item.address !== undefined)
                    throw new Error("Use offset for ELF/HEX; their base addresses come from the file");
                if (item.format === "bin" && BigInt(item.address) + BigInt(fs.statSync(item.file).size) > 0x100000000n)
                    throw new Error("BIN load image exceeds the ARM32 address range");
                validateLoadImage(item);
            }
            return item;
        });
        if (key === "symbolFiles") {
            const files = result[key].map((item) => item.file);
            if (new Set(files).size !== files.length)
                throw new Error("Each symbol image must have a distinct file identity");
        }
    }
    return result;
}

function symbolImages(config) {
    return config.symbolFiles ?? [{ file: config.executable }];
}

class DebugImages {
    constructor(session) {
        this.session = session;
    }
    async hooks(key) {
        const commands = this.session.config[key] || [];
        if (commands.length) this.session.symbolDirectory.reset();
        for (const [index, command] of commands.entries()) {
            this.session.variableDiagnostic(`GDB ${key} hook ${index + 1}/${commands.length}\n`);
            try {
                await this.session.mi.command(`-interpreter-exec console ${quote(command)}`);
            } catch (error) {
                throw new Error(`${key} failed (${command.slice(0, 100)}): ${error.message}`);
            }
        }
    }
    async symbols() {
        const { config, mi } = this.session;
        const images = symbolImages(config);
        config.primarySymbolFile = images[0]?.file || null;
        if (config.symbolFiles === undefined) {
            await mi.command(`-file-exec-and-symbols ${quote(gdbPath(config.executable))}`);
        } else {
            await mi.command(`-file-exec-file ${quote(gdbPath(config.executable))}`);
            await mi.command("-file-symbol-file");
            for (const [index, image] of images.entries()) {
                const sections = image.sections || [];
                if (index === 0 && image.textaddress === undefined && !sections.length) {
                    const command = `symbol-file ${quote(gdbPath(image.file))}${image.offset ? ` -o ${image.offset}` : ""}`;
                    await mi.command(`-interpreter-exec console ${quote(command)}`);
                } else {
                    const command =
                        `add-symbol-file ${quote(gdbPath(image.file))}${image.offset ? ` -o ${image.offset}` : ""}${image.textaddress !== undefined ? ` ${image.textaddress}` : ""}` +
                        sections.map((section) => ` -s ${section.name} ${section.address}`).join("");
                    await mi.command(`-interpreter-exec console ${quote(command)}`);
                }
            }
        }
        this.session.symbolDirectory.reset();
        await this.verifyRtosPrimary();
    }
    async verifyRtosPrimary() {
        const { config, mi } = this.session;
        if (!this.session.rtosAware || !["FreeRTOS", "auto"].includes(config.rtos) || symbolImages(config).length < 2)
            return;
        const entries = await this.session.symbolDirectory.load({ symbolSetup: true });
        if (config.rtos === "auto" && !entries.some((entry) => entry.name === "pxCurrentTCB")) return;
        const primary = gdbPath(config.primarySymbolFile || "");
        const matches = entries.filter((entry) => entry.image === primary && entry.name === "pxCurrentTCB");
        if (matches.length !== 1 || !matches[0].expression || !matches[0].symbolAddress)
            throw new Error("FreeRTOS primary symbol image is missing an unambiguous pxCurrentTCB");
        const result = await mi.command('-data-evaluate-expression "(unsigned long long)&(pxCurrentTCB)"');
        const address = String(result.value).match(/^\s*(0x[\da-f]+|\d+)(?=\s|$)/i);
        if (!address || BigInt(address[1]) !== BigInt(matches[0].symbolAddress))
            throw new Error("GDB RTOS symbol lookup does not select the primary image");
    }
    async download() {
        const { config, mi } = this.session;
        if (config.attach) return;
        if (config.loadFiles === undefined) {
            await mi.command("-target-download", 60000);
            return;
        }
        for (const image of config.loadFiles) {
            const binary = image.format === "bin";
            if (binary) await mi.command("-gdb-set gnutarget binary");
            try {
                const command = `load ${quote(gdbPath(image.file))}${binary ? ` ${image.address}` : image.offset ? ` ${image.offset}` : ""}`;
                await mi.command(`-interpreter-exec console ${quote(command)}`, 60000);
            } finally {
                if (binary && !mi.closed) await mi.command("-gdb-set gnutarget auto");
            }
        }
        // GDB load can alter its symbol tables; restore the configured identities before breakpoints.
        if (config.loadFiles.length) await this.symbols();
    }
}

module.exports = { normalizeDebugImages, symbolImages, DebugImages, HOOKS, address };
