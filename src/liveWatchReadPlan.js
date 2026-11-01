"use strict";
// Read plans for the OpenOCD session: per-cycle budget checks, batch compilation by address (merging neighbours
// inside RAM sections), and the 8/16/32-bit element shapes a byte range is transferred with.
const { isDeepStrictEqual } = require("util");

const MAX_DEBUG_READ_BYTES = 4096;
const MAX_DEBUG_READ_COMMANDS = 32;
const MAX_BATCH_GROUPS = 8;
const MAX_BATCH_BYTES = 1024;
const MAX_READ_GAP_BYTES = 32;
const MAX_RAM_SECTION_RANGES = 4096;

function normalizeRamSectionRanges(ranges) {
    return (Array.isArray(ranges) ? ranges.slice(0, MAX_RAM_SECTION_RANGES) : [])
        .filter(
            (range) =>
                Number.isInteger(range?.start) &&
                Number.isInteger(range?.end) &&
                range.start >= 0 &&
                range.end <= 0x100000000 &&
                range.start < range.end
        )
        .map(({ start, end }) => ({ start, end }));
}

function parseMemoryElements(text, widthBits) {
    if (!text || ![8, 16, 32].includes(widthBits)) return [];
    const max = widthBits === 32 ? 0xffffffff : widthBits === 16 ? 0xffff : 0xff;
    const cleaned = String(text).replace(/(^|\s)(0x)?[0-9a-fA-F]+:/g, " ");
    const out = [];
    for (const tok of cleaned.trim().split(/\s+/)) {
        if (!tok) continue;
        let n;
        if (/^0x[0-9a-fA-F]+$/i.test(tok)) n = parseInt(tok, 16);
        else if (/^[0-9a-fA-F]*[a-f][0-9a-fA-F]*$/i.test(tok)) n = parseInt(tok, 16);
        else if (/^-?[0-9]+$/.test(tok)) n = parseInt(tok, 10);
        else return [];
        if (Number.isInteger(n) && n < 0 && n >= -(2 ** (widthBits - 1))) n += 2 ** widthBits;
        if (!Number.isInteger(n) || n < 0 || n > max) return [];
        out.push(n >>> 0);
    }
    return out;
}

function transferShape(address, byteCount) {
    if ((address & 3) === 0 && byteCount % 4 === 0) return { widthBits: 32, elementBytes: 4, count: byteCount / 4 };
    if ((address & 1) === 0 && byteCount % 2 === 0) return { widthBits: 16, elementBytes: 2, count: byteCount / 2 };
    return { widthBits: 8, elementBytes: 1, count: byteCount };
}

function bytesToElements(bytes, elementBytes) {
    const elements = [];
    for (let offset = 0; offset < bytes.length; offset += elementBytes) {
        let value = 0;
        for (let index = 0; index < elementBytes; index++) value += (bytes[offset + index] & 0xff) * 2 ** (index * 8);
        elements.push(value >>> 0);
    }
    return elements;
}

function elementsToBytes(elements, elementBytes) {
    const bytes = [];
    for (const element of elements) {
        for (let index = 0; index < elementBytes; index++) bytes.push((element >>> (index * 8)) & 0xff);
    }
    return bytes;
}

// Read batches are compiled by address and samples are keyed by name, so consumer order never affects a plan.
function sameConsumerItems(a, b) {
    const byName = (items) => [...items].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    return a.length === b.length && isDeepStrictEqual(byName(a), byName(b));
}

function validateManagedReadPlan(items, maxBytes = MAX_DEBUG_READ_BYTES, maxCommands = MAX_DEBUG_READ_COMMANDS) {
    const ranges = (Array.isArray(items) ? items : [])
        .map((item) => ({ start: Number(item?.address), size: Number(item?.size) }))
        .filter((item) => Number.isInteger(item.start) && Number.isInteger(item.size) && item.size > 0)
        .sort((a, b) => a.start - b.start || a.size - b.size);
    let total = 0;
    let commandCount = 0;
    let current = null;
    for (const range of ranges) {
        const end = range.start + range.size;
        if (!Number.isSafeInteger(end) || range.start < 0 || end > 0x100000000) {
            throw Object.assign(new Error("Runtime read range overflows the 32-bit target address space"), {
                code: "LIVE_ADDRESS_NOT_RAM"
            });
        }
        if (current && range.start <= current.end) current.end = Math.max(current.end, end);
        else {
            if (current) {
                total += current.end - current.start;
                commandCount++;
            }
            current = { start: range.start, end };
        }
    }
    if (current) {
        total += current.end - current.start;
        commandCount++;
    }
    if (total > maxBytes || commandCount > maxCommands) {
        throw Object.assign(
            new Error(`Runtime read plan exceeds the per-cycle budget (${maxBytes} bytes / ${maxCommands} commands)`),
            {
                code: "LIVE_READ_BUDGET_EXCEEDED",
                details: { totalBytes: total, maxBytes, commandCount, maxCommands }
            }
        );
    }
    return total;
}

// Sampling keeps every item that fits the per-cycle budget. Smaller items are admitted first so one
// oversized struct cannot starve the rest; the result keeps the input order of each side.
function partitionManagedReadPlan(items, maxBytes = MAX_DEBUG_READ_BYTES, maxCommands = MAX_DEBUG_READ_COMMANDS) {
    const list = Array.isArray(items) ? items : [];
    const order = list
        .map((item, index) => ({ item, index }))
        .sort((a, b) => Number(a.item?.size) - Number(b.item?.size) || a.index - b.index);
    const admitted = [];
    const rejected = new Set();
    for (const entry of order) {
        try {
            validateManagedReadPlan([...admitted, entry.item], maxBytes, maxCommands);
            admitted.push(entry.item);
        } catch (error) {
            if (error.code !== "LIVE_READ_BUDGET_EXCEEDED") throw error;
            rejected.add(entry.item);
        }
    }
    return {
        allowed: list.filter((item) => !rejected.has(item)),
        overBudget: list.filter((item) => rejected.has(item))
    };
}

function compileReadBatches(items, ramSectionRanges = [], debug = false, reservedBytes = 0) {
    if (!Array.isArray(items) || !items.length) return [];
    const sorted = items.slice().sort((a, b) => (a.address >>> 0) - (b.address >>> 0));
    const groups = [];
    for (const v of sorted) {
        const last = groups[groups.length - 1];
        if (last && v.address <= last.end) {
            last.vars.push(v);
            last.end = Math.max(last.end, v.address + v.size);
        } else {
            groups.push({ start: v.address, end: v.address + v.size, vars: [v] });
        }
    }
    let totalBytes = groups.reduce((total, group) => total + group.end - group.start, reservedBytes);
    let commands = groups.reduce((total, group) => total + Math.ceil((group.end - group.start) / MAX_BATCH_BYTES), 0);
    const mergeNeighbours = () => {
        for (let index = 1; index < groups.length;) {
            const previous = groups[index - 1];
            const group = groups[index];
            const gap = Math.max(0, group.start - previous.end);
            const end = Math.max(previous.end, group.end);
            const nextCommands =
                commands -
                Math.ceil((previous.end - previous.start) / MAX_BATCH_BYTES) -
                Math.ceil((group.end - group.start) / MAX_BATCH_BYTES) +
                Math.ceil((end - previous.start) / MAX_BATCH_BYTES);
            if (
                gap <= MAX_READ_GAP_BYTES &&
                ramSectionRanges.some((range) => previous.start >= range.start && end <= range.end) &&
                (!debug || (totalBytes + gap <= MAX_DEBUG_READ_BYTES && nextCommands <= MAX_DEBUG_READ_COMMANDS))
            ) {
                previous.end = end;
                previous.vars.push(...group.vars);
                groups.splice(index, 1);
                totalBytes += gap;
                commands = nextCommands;
            } else index++;
        }
    };
    mergeNeighbours();
    for (const group of groups) {
        const start = Math.floor(group.start / 4) * 4;
        const end = Math.ceil(group.end / 4) * 4;
        const extra = end - start - (group.end - group.start);
        const nextCommands =
            commands -
            Math.ceil((group.end - group.start) / MAX_BATCH_BYTES) +
            Math.ceil((end - start) / MAX_BATCH_BYTES);
        if (
            extra &&
            ramSectionRanges.some((range) => start >= range.start && end <= range.end) &&
            (!debug || (totalBytes + extra <= MAX_DEBUG_READ_BYTES && nextCommands <= MAX_DEBUG_READ_COMMANDS))
        ) {
            group.start = start;
            group.end = end;
            totalBytes += extra;
            commands = nextCommands;
        }
    }
    mergeNeighbours();
    const batches = [];
    let currentBatch = [];
    let currentBatchBytes = 0;
    for (const g of groups) {
        g.byteCount = g.end - g.start;
        for (let start = g.start; start < g.end; start += MAX_BATCH_BYTES) {
            const byteCount = Math.min(MAX_BATCH_BYTES, g.end - start);
            if (
                currentBatch.length >= MAX_BATCH_GROUPS ||
                (currentBatch.length > 0 && currentBatchBytes + byteCount > MAX_BATCH_BYTES)
            ) {
                batches.push(currentBatch);
                currentBatch = [];
                currentBatchBytes = 0;
            }
            currentBatch.push({ start, byteCount, shape: transferShape(start, byteCount), group: g, vars: g.vars });
            currentBatchBytes += byteCount;
        }
    }
    if (currentBatch.length) batches.push(currentBatch);
    return batches;
}

module.exports = {
    MAX_DEBUG_READ_BYTES,
    MAX_DEBUG_READ_COMMANDS,
    MAX_BATCH_GROUPS,
    MAX_BATCH_BYTES,
    normalizeRamSectionRanges,
    parseMemoryElements,
    transferShape,
    bytesToElements,
    elementsToBytes,
    sameConsumerItems,
    validateManagedReadPlan,
    partitionManagedReadPlan,
    compileReadBatches
};
