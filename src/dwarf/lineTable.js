"use strict";

const path = require("node:path");
const { readElfHeader, readSectionHeaders, readSectionNames } = require("../elfFormat");
const { debugSectionData, readULEB, readSLEB } = require("./binary");

function sourceKey(value) {
    const windows = /^[a-z]:[\\/]|^\\\\/i.test(value);
    return windows ? path.win32.normalize(value).replace(/\\/g, "/").toLowerCase() : path.posix.normalize(value);
}

// Decode only exact file/line matches. No basename guesses or invented addresses.
function resolveSourceLines(buffer, units, source, breakpoints, options = {}) {
    if (typeof source !== "string" || source.length > 4096 || !Array.isArray(breakpoints) || breakpoints.length > 256)
        throw new Error("Invalid source breakpoint lookup");
    if (buffer.length > 64 * 1024 * 1024) throw new Error("ELF exceeds the source lookup byte budget");
    const deadline = Date.now() + (options.timeoutMs ?? 1000);
    let operations = 0;
    const tick = () => {
        if (++operations > (options.maxOperations ?? 1000000) || (operations % 256 === 0 && Date.now() > deadline))
            throw Object.assign(new Error("DWARF line table budget exceeded"), { code: "DWARF_BUDGET_EXCEEDED" });
    };
    const header = readElfHeader(buffer);
    const entries = readSectionHeaders(buffer, header);
    const names = readSectionNames(buffer, entries, header.shstrndx);
    const sections = new Map();
    const budget = { decoded: 0, max: 32 * 1024 * 1024 };
    entries.forEach((entry, index) => {
        const name = names[index].replace(/^\.zdebug_/, ".debug_");
        if ([".debug_line", ".debug_line_str", ".debug_str"].includes(name))
            sections.set(name, debugSectionData(buffer, entry, names[index], budget));
    });
    const lines = sections.get(".debug_line");
    const found = breakpoints.map(() => null);
    if (!lines) return found;
    const executable = entries.filter((entry) => (entry.flags & 6) === 6 && entry.type === 1);
    const directories = new Map(units.map((unit) => [unit.stmtList, unit.compDir || ""]));
    const key = sourceKey(source);
    let p = 0;
    let limit = lines.length;
    const uint = (width) => {
        tick();
        if (p + width > limit) throw new Error("Truncated DWARF line table");
        const value = width === 8 ? Number(lines.readBigUInt64LE(p)) : lines.readUIntLE(p, width);
        p += width;
        if (!Number.isSafeInteger(value)) throw new Error("Oversized DWARF line value");
        return value;
    };
    const leb = (signed = false) => {
        tick();
        const cursor = { p };
        const value = (signed ? readSLEB : readULEB)(lines.subarray(0, limit), cursor);
        p = cursor.p;
        if (!Number.isSafeInteger(value)) throw new Error("Oversized DWARF line value");
        return value;
    };
    const stringAt = (data, offset) => {
        const end = data?.indexOf(0, offset) ?? -1;
        if (!Number.isSafeInteger(offset) || offset < 0 || end < offset || end - offset > 4096)
            throw new Error("Invalid DWARF source path");
        return data.toString("utf8", offset, end);
    };
    const string = () => {
        tick();
        const value = stringAt(lines.subarray(0, limit), p);
        p += Buffer.byteLength(value) + 1;
        return value;
    };
    const form = (kind, offsetSize) => {
        if (kind === 0x08) return string();
        if (kind === 0x0e || kind === 0x1f)
            return stringAt(sections.get(kind === 0x0e ? ".debug_str" : ".debug_line_str"), uint(offsetSize));
        if (kind === 0x0f) return leb();
        if (kind === 0x1e) {
            if (p + 16 > limit) throw new Error("Truncated DWARF line digest");
            p += 16;
            return null;
        }
        const width = { 0x0b: 1, 0x05: 2, 0x06: 4, 0x07: 8, 0x17: offsetSize }[kind];
        if (!width) throw new Error(`Unsupported DWARF line form: ${kind}`);
        return uint(width);
    };
    const table = (offsetSize) => {
        const formats = Array.from({ length: uint(1) }, () => [leb(), leb()]);
        const count = leb();
        if (count > 20000) throw new Error("DWARF source file table is too large");
        return Array.from({ length: count }, () => {
            const record = {};
            for (const [kind, encoding] of formats) record[kind] = form(encoding, offsetSize);
            return { name: record[1], directory: record[2] || 0 };
        });
    };
    let programs = 0;
    while (p < lines.length) {
        tick();
        if (++programs > 8192) throw new Error("Too many DWARF line programs");
        limit = lines.length;
        const start = p;
        let length = uint(4);
        const offsetSize = length === 0xffffffff ? 8 : 4;
        if (offsetSize === 8) length = uint(8);
        const end = p + length;
        if (!length || end > lines.length) throw new Error("Invalid DWARF line program size");
        limit = end;
        const version = uint(2);
        if (![2, 3, 4, 5].includes(version)) throw new Error("Unsupported DWARF line version");
        const addressSize = version === 5 ? uint(1) : 4;
        if (version === 5 && uint(1) !== 0) throw new Error("Segmented DWARF addresses are unsupported");
        if (addressSize !== 4) throw new Error("Source breakpoints require ELF32 addresses");
        const headerLength = uint(offsetSize);
        const headerEnd = p + headerLength;
        if (headerEnd > end) throw new Error("Invalid DWARF line header size");
        limit = headerEnd;
        const minimum = uint(1);
        const maxOps = version >= 4 ? uint(1) : 1;
        const defaultStatement = uint(1) !== 0;
        const rawBase = uint(1);
        const lineBase = rawBase > 127 ? rawBase - 256 : rawBase;
        const lineRange = uint(1);
        const opcodeBase = uint(1);
        if (!minimum || maxOps !== 1 || !lineRange || !opcodeBase)
            throw new Error("Unsupported DWARF line machine parameters");
        const operandCounts = Array.from({ length: opcodeBase - 1 }, () => uint(1));
        const compDir = directories.get(start) || "";
        let dirs;
        let files;
        const readFile = () => ({ name: string(), directory: leb(), time: leb(), size: leb() });
        if (version === 5) {
            dirs = table(offsetSize).map((entry) => entry.name);
            files = table(offsetSize);
        } else {
            dirs = [compDir];
            while (lines[p] !== 0 && p < limit) {
                if (dirs.length > 20000) throw new Error("Too many DWARF source directories");
                dirs.push(string());
            }
            uint(1);
            files = [null];
            while (lines[p] !== 0 && p < limit) {
                if (files.length > 20000) throw new Error("Too many DWARF source files");
                files.push(readFile());
            }
            uint(1);
        }
        const matches = (file) => {
            if (!file?.name || typeof file.name !== "string") return false;
            const directory = dirs[file.directory];
            if (directory === undefined) return false;
            const windows = /^[a-z]:[\\/]|^\\\\/i.test(file.name) || /^[a-z]:[\\/]|^\\\\/i.test(compDir || directory);
            const format = windows ? path.win32 : path.posix;
            let full = format.isAbsolute(file.name) ? file.name : format.join(directory, file.name);
            if (!format.isAbsolute(full)) full = format.join(compDir, full);
            return format.isAbsolute(full) && sourceKey(full) === key;
        };
        const matching = new Set(
            files.map((file, index) => (matches(file) ? index : -1)).filter((index) => index >= 0)
        );
        p = headerEnd;
        limit = end;
        if (!matching.size) {
            p = end;
            continue;
        }
        let address;
        let line;
        let file;
        let column;
        let statement;
        const reset = () => {
            address = 0;
            line = 1;
            file = 1;
            column = 0;
            statement = defaultStatement;
        };
        const emit = () => {
            if (!statement || !matching.has(file) || address % 2 || !address || line < 1) return;
            if (!executable.some((section) => address >= section.addr && address < section.addr + section.size)) return;
            breakpoints.forEach((bp, index) => {
                if (bp.line !== line) return;
                const exact = bp.column > 1 && bp.column === column;
                if (!found[index] || (exact && found[index].column !== bp.column))
                    found[index] = { address, line, column: column || 1 };
            });
        };
        reset();
        while (p < end) {
            const opcode = uint(1);
            if (opcode === 0) {
                const size = leb();
                const extendedEnd = p + size;
                if (!size || extendedEnd > end) throw new Error("Invalid extended DWARF line opcode");
                const previousLimit = limit;
                limit = extendedEnd;
                const kind = uint(1);
                if (kind === 1) reset();
                else if (kind === 2) address = uint(addressSize);
                else if (kind === 3 && version < 5) {
                    const entry = readFile();
                    if (files.length > 20000) throw new Error("Too many DWARF source files");
                    if (matches(entry)) matching.add(files.length);
                    files.push(entry);
                }
                p = extendedEnd;
                limit = previousLimit;
            } else if (opcode >= opcodeBase) {
                const adjusted = opcode - opcodeBase;
                address += Math.floor(adjusted / lineRange) * minimum;
                line += lineBase + (adjusted % lineRange);
                emit();
            } else if (opcode === 1) emit();
            else if (opcode === 2) address += leb() * minimum;
            else if (opcode === 3) line += leb(true);
            else if (opcode === 4) file = leb();
            else if (opcode === 5) column = leb();
            else if (opcode === 6) statement = !statement;
            else if (opcode === 8) address += Math.floor((255 - opcodeBase) / lineRange) * minimum;
            else if (opcode === 9) address += uint(2);
            else for (let index = 0; index < operandCounts[opcode - 1]; index++) leb();
            if (address > 0xffffffff || !Number.isSafeInteger(line)) throw new Error("Invalid DWARF source address");
        }
    }
    return found;
}

module.exports = { resolveSourceLines, sourceKey };
