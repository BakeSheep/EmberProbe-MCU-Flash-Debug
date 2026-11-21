"use strict";

const fs = require("fs");
const { readElf32Header } = require("../elfFormat");
const { MAX_ELF_BYTES } = require("../../skills/_emberprobe/elf-file");

const ADDRESS_LIMIT = 0x100000000;
const MAX_HEADERS = 4096;

function imageSize(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_ELF_BYTES) throw new Error("Expected a regular image of at most 64 MiB");
    return stat.size;
}

function offsetValue(offset = "0") {
    const text = String(offset || "0");
    return Number(text.startsWith("-") ? -BigInt(text.slice(1)) : BigInt(text));
}

function relocate(start, length, offset) {
    const base = start + offset;
    if (!Number.isSafeInteger(base) || base < 0 || base + length > ADDRESS_LIMIT)
        throw new Error("Load image relocation exceeds the ARM32 address range");
    return [base, base + length];
}

function readAt(fd, buffer, at, label) {
    if (fs.readSync(fd, buffer, 0, buffer.length, at) !== buffer.length) throw new Error(`Truncated ${label}`);
    return buffer;
}

function elfRanges(file, size, offset, mode) {
    const fd = fs.openSync(file, "r");
    try {
        const header = readElf32Header(readAt(fd, Buffer.alloc(52), 0, "ELF load image"));
        if (header.machine !== 0x28) throw new Error("ELF load image must target ARM");
        if (
            header.phnum > MAX_HEADERS ||
            header.phentsize < 32 ||
            header.phoff + header.phnum * header.phentsize > size
        )
            throw new Error("Invalid ELF load segment table");
        const segment = Buffer.alloc(32);
        const loads = [];
        let allPhysicalAddressesZero = true;
        for (let index = 0; index < header.phnum; index++) {
            readAt(fd, segment, header.phoff + index * header.phentsize, "ELF load segment");
            if (segment.readUInt32LE(0) !== 1) continue;
            const start = segment.readUInt32LE(4);
            const virtual = segment.readUInt32LE(8);
            const physical = segment.readUInt32LE(12);
            const bytes = segment.readUInt32LE(16);
            const memory = segment.readUInt32LE(20);
            if (memory && physical) allPhysicalAddressesZero = false;
            if (start + bytes > size || (mode !== "validate" && (bytes > memory || virtual + memory > ADDRESS_LIMIT)))
                throw new Error("ELF load segment exceeds the file or memory range");
            loads.push({ start, virtual, physical, bytes, memory });
        }
        // Match OpenOCD's ELF address selection for tools that zero out all p_paddr fields.
        const useVirtual =
            mode !== "validate" && allPhysicalAddressesZero && loads.filter((load) => load.memory).length > 1;
        const loadAddress = (load) => (useVirtual ? load.virtual : load.physical);
        if (mode !== "gdb")
            return loads.filter((load) => load.bytes).map((load) => relocate(loadAddress(load), load.bytes, offset));

        // BFD loads allocated sections with file contents. Resolve their LMAs through the segment mapping
        // instead of treating a section's runtime VMA (in particular .data in SRAM) as its Flash address.
        if (
            !header.shoff ||
            !header.shnum ||
            header.shnum > MAX_HEADERS ||
            header.shentsize < 40 ||
            header.shoff + header.shnum * header.shentsize > size
        )
            throw new Error("Invalid ELF load section table");
        const section = Buffer.alloc(40);
        const ranges = [];
        for (let index = 0; index < header.shnum; index++) {
            readAt(fd, section, header.shoff + index * header.shentsize, "ELF load section");
            const bytes = section.readUInt32LE(20);
            if (!bytes || !(section.readUInt32LE(8) & 2) || section.readUInt32LE(4) === 8) continue;
            const virtual = section.readUInt32LE(12);
            const start = section.readUInt32LE(16);
            const addresses = new Set();
            for (const load of loads) {
                const delta = virtual - load.virtual;
                if (delta >= 0 && start === load.start + delta && delta + bytes <= load.bytes)
                    addresses.add(loadAddress(load) + delta);
            }
            if (addresses.size !== 1) throw new Error("ELF section has no unambiguous load address");
            ranges.push(relocate([...addresses][0], bytes, offset));
        }
        return ranges;
    } finally {
        fs.closeSync(fd);
    }
}

function hexRanges(file, offset, collect = true) {
    const ranges = [];
    let base = 0;
    let ended = false;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        if (ended || !/^:[\da-f]+$/i.test(text) || text.length > 521 || text.length % 2 !== 1)
            throw new Error("Invalid Intel HEX record");
        const record = Buffer.from(text.slice(1), "hex");
        if (record.length < 5) throw new Error("Truncated Intel HEX record");
        const count = record[0];
        const address = record.readUInt16BE(1);
        const type = record[3];
        if (record.length !== count + 5 || record.reduce((sum, byte) => (sum + byte) % 256, 0))
            throw new Error("Invalid Intel HEX length or checksum");
        if (type === 0) {
            if (!count) continue;
            const range = relocate(base + address, count, offset);
            if (!collect) continue;
            const last = ranges.at(-1);
            if (last && last[1] === range[0]) last[1] = range[1];
            else ranges.push(range);
            if (ranges.length > MAX_HEADERS) throw new Error("Intel HEX load range budget exceeded");
        } else if (type === 1 && count === 0 && address === 0) ended = true;
        else if ((type === 2 || type === 4) && count === 2 && address === 0)
            base = record.readUInt16BE(4) * (type === 2 ? 16 : 65536);
        else if (!((type === 3 || type === 5) && count === 4 && address === 0))
            throw new Error("Unsupported Intel HEX record type or length");
    }
    if (!ended) throw new Error("Intel HEX end-of-file record is missing");
    return ranges;
}

function imageRanges({ file, format = "elf", offset = undefined, address = undefined }, forGdb = false) {
    const size = imageSize(file);
    if (format === "bin") return size ? [relocate(offsetValue(address), size, 0)] : [];
    const displacement = offsetValue(offset);
    return format === "hex"
        ? hexRanges(file, displacement)
        : elfRanges(file, size, displacement, forGdb ? "gdb" : "openocd");
}

function validateLoadImage({ file, format = undefined, offset = undefined }) {
    const displacement = offsetValue(offset);
    if (format === "elf") elfRanges(file, fs.statSync(file).size, displacement, "validate");
    else if (format === "hex") {
        if (fs.statSync(file).size > MAX_ELF_BYTES) throw new Error("HEX validation file budget exceeded (64 MiB)");
        hexRanges(file, displacement, false);
    }
}

module.exports = { imageRanges, validateLoadImage };
