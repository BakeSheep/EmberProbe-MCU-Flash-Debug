"use strict";

// Standard little-endian ARM32 SEGGER RTT layout. Callers hold the session lock; these helpers never acquire it.
const { parseMemoryElements } = require("./liveWatchReadPlan");
const { RTT_ID } = require("./rttControlBlock");

const HEADER_BYTES = 24;
const DESCRIPTOR_BYTES = 24;
const MAX_SNAPSHOT_BYTES = 4096;
const MAX_TARGET_COMMANDS = 24;
const MAX_TARGET_TRANSACTION_MS = 250;
const ADDRESS_SPACE = 0x100000000;
const MODES = ["skip", "trim", "block"];
const IDENTITY_FIELDS = ["index", "descriptorAddress", "nameAddress", "bufferAddress", "size"];
const rttError = (code, message, details) => Object.assign(new Error(message), { code, retryable: false, details });
const validIndex = (index) => Number.isSafeInteger(index) && index >= 0 && index < 256;

function validateTargetRequest(request) {
    const block = request?.block;
    if (block?.exact !== true)
        throw rttError(
            "RTT_EXACT_ADDRESS_REQUIRED",
            "RTT target access requires an explicit or ELF control block address"
        );
    if (
        !Number.isSafeInteger(block.address) ||
        block.address <= 0 ||
        block.address % 4 !== 0 ||
        !Number.isSafeInteger(block.size) ||
        block.size < HEADER_BYTES ||
        block.address + block.size > ADDRESS_SPACE
    )
        throw rttError("RTT_INVALID_LAYOUT", "Invalid ARM32 RTT control block address or range");
    if (request.operation === "snapshot") {
        if (
            !Array.isArray(request.channels) ||
            request.channels.length > 256 ||
            !request.channels.every(validIndex) ||
            new Set(request.channels).size !== request.channels.length
        )
            throw rttError("RTT_INVALID_CHANNEL", "RTT snapshot requires unique up-channel indices in 0..255");
        if (HEADER_BYTES * 2 + request.channels.length * DESCRIPTOR_BYTES > MAX_SNAPSHOT_BYTES)
            throw rttError("RTT_TARGET_BUDGET_EXCEEDED", "RTT snapshot exceeds its byte budget");
    } else if (!validIndex(request.channel) || !MODES.includes(request.mode)) {
        throw rttError("RTT_INVALID_MODE", "RTT mode requires an up-channel index and skip, trim or block");
    }
    if (request.expected !== undefined && (!request.expected || typeof request.expected !== "object"))
        throw rttError("RTT_INVALID_EXPECTED", "RTT expected descriptor must be an object");
}

function decodeHeader(bytes, address) {
    // The ID occupies a fixed 16-byte, NUL-padded field, followed by two unsigned 32-bit counts.
    const expectedId = Buffer.alloc(16);
    expectedId.write(RTT_ID, "ascii");
    if (!bytes.subarray(0, 16).equals(expectedId))
        throw rttError("RTT_INVALID_LAYOUT", "RTT control block identifier does not match SEGGER RTT");
    const upCount = bytes.readUInt32LE(16);
    const downCount = bytes.readUInt32LE(20);
    const end = address + HEADER_BYTES + (upCount + downCount) * DESCRIPTOR_BYTES;
    if (upCount > 256 || downCount > 256 || end > ADDRESS_SPACE)
        throw rttError("RTT_INVALID_LAYOUT", "RTT control block counts or descriptor range are invalid");
    return { address, upCount, downCount, end };
}

function decodeDescriptor(bytes, header, index) {
    const [nameAddress, bufferAddress, size, writeOffset, readOffset, flags] = Array.from({ length: 6 }, (_, word) =>
        bytes.readUInt32LE(word * 4)
    );
    const descriptorAddress = header.address + HEADER_BYTES + index * DESCRIPTOR_BYTES;
    if (!size || !bufferAddress)
        throw rttError("RTT_CHANNEL_UNINITIALIZED", `RTT up-channel ${index} is not initialized`, { channel: index });
    if (
        size < 2 ||
        size > 0x10000000 ||
        bufferAddress + size > ADDRESS_SPACE ||
        (bufferAddress < header.end && bufferAddress + size > header.address) ||
        writeOffset >= size ||
        readOffset >= size ||
        (flags & 3) === 3 ||
        (nameAddress >= header.address && nameAddress < header.end)
    )
        throw rttError("RTT_INVALID_LAYOUT", `RTT up-channel ${index} has an invalid descriptor`, { channel: index });
    return {
        index,
        descriptorAddress,
        nameAddress,
        bufferAddress,
        size,
        flags,
        mode: MODES[flags & 3],
        writeOffset,
        readOffset,
        usedBytes: (writeOffset - readOffset + size) % size,
        capacity: size - 1
    };
}

function assertIdentity(before, after) {
    if (IDENTITY_FIELDS.some((field) => before[field] !== after[field]))
        throw rttError("RTT_IDENTITY_CHANGED", "RTT channel identity changed during the transaction");
}

async function targetTransaction(session, request, check, send) {
    let bytesRead = 0;
    let commandCount = 0;
    let attempted = null;
    let acknowledged = false;
    let verified = false;
    const completed = [];
    const command = async (text) => {
        check();
        if (++commandCount > MAX_TARGET_COMMANDS)
            throw rttError("RTT_TARGET_BUDGET_EXCEEDED", "RTT target transaction exceeded its command budget");
        const response = await send(text);
        check();
        return response;
    };
    const discover = async (operation) => {
        const names = String(await command("info commands *" + operation))
            .trim()
            .split(/\s+/);
        const selected = ["ocd_" + operation, operation].find((name) => names.includes(name));
        if (!selected) throw rttError("RTT_ACCESS_UNSUPPORTED", `OpenOCD does not expose ${operation}`);
        return selected;
    };
    try {
        const endian = String(await command("[target current] cget -endian")).trim();
        if (endian !== "little")
            throw rttError("RTT_ACCESS_UNSUPPORTED", "RTT target access requires verified little-endian memory", {
                endian
            });
        const readCommand = await discover("read_memory");
        // Resolve both aliases before touching Flags. A write is never retried to choose an alias.
        const writeCommand = request.operation === "setMode" ? await discover("write_memory") : null;
        const read = async (address, size) => {
            bytesRead += size;
            if (bytesRead > MAX_SNAPSHOT_BYTES)
                throw rttError("RTT_TARGET_BUDGET_EXCEEDED", "RTT target transaction exceeded its byte budget");
            const text = await command(`${readCommand} 0x${address.toString(16)} 32 ${size / 4}`);
            const values = parseMemoryElements(text, 32);
            if (values.length !== size / 4) throw rttError("RTT_READ_FAILED", "Incomplete RTT target memory response");
            const bytes = Buffer.alloc(size);
            values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
            return bytes;
        };
        const readHeader = async () =>
            decodeHeader(await read(request.block.address, HEADER_BYTES), request.block.address);
        const header = await readHeader();
        const indices = request.operation === "snapshot" ? request.channels : [request.channel];
        if (indices.some((index) => index >= header.upCount))
            throw rttError("RTT_CHANNEL_UNINITIALIZED", "Requested RTT up-channel is not initialized", {
                channels: indices,
                upCount: header.upCount
            });
        const readDescriptor = async (index) =>
            decodeDescriptor(
                await read(header.address + HEADER_BYTES + index * DESCRIPTOR_BYTES, DESCRIPTOR_BYTES),
                header,
                index
            );
        const channels = [];
        // Merge adjacent selected descriptors without reading intervening, unselected channels.
        const sorted = indices.slice().sort((a, b) => a - b);
        for (let index = 0; index < sorted.length;) {
            const start = index++;
            while (index < sorted.length && sorted[index] === sorted[index - 1] + 1) index++;
            const bytes = await read(
                header.address + HEADER_BYTES + sorted[start] * DESCRIPTOR_BYTES,
                (index - start) * DESCRIPTOR_BYTES
            );
            for (let at = start; at < index; at++)
                channels.push(decodeDescriptor(bytes.subarray((at - start) * DESCRIPTOR_BYTES), header, sorted[at]));
        }
        const checkHeader = async () => {
            const after = await readHeader();
            if (header.upCount !== after.upCount || header.downCount !== after.downCount)
                throw rttError("RTT_IDENTITY_CHANGED", "RTT control block counts changed during the transaction");
        };
        await checkHeader();
        if (request.operation === "snapshot")
            return {
                snapshot: {
                    address: header.address,
                    upCount: header.upCount,
                    downCount: header.downCount,
                    targetEpoch: session.targetEpoch,
                    channels: indices.map((index) => channels.find((channel) => channel.index === index))
                }
            };
        const before = channels[0];
        if (request.expected) {
            // nameAddress is optional in the public expected descriptor; validate it when supplied.
            const fields = [...IDENTITY_FIELDS.filter((field) => field !== "nameAddress"), "flags"];
            if (request.expected.nameAddress !== undefined) fields.push("nameAddress");
            if (fields.some((field) => request.expected[field] !== before[field]))
                throw rttError("RTT_VALUE_CHANGED", "RTT descriptor differs from the expected snapshot");
        }
        const current = await readDescriptor(request.channel);
        assertIdentity(before, current);
        if (current.flags !== before.flags) throw rttError("RTT_VALUE_CHANGED", "RTT Flags changed before writing");
        const flags = ((current.flags & 0xfffffffc) | MODES.indexOf(request.mode)) >>> 0;
        if (flags === current.flags) return { channel: current, changed: false };
        check();
        attempted = current.descriptorAddress + 20;
        await command(`${writeCommand} 0x${attempted.toString(16)} 32 {0x${flags.toString(16)}}`);
        acknowledged = true;
        await checkHeader();
        const after = await readDescriptor(request.channel);
        assertIdentity(current, after);
        if (after.flags !== flags)
            throw rttError("RTT_READBACK_MISMATCH", "RTT Flags read-back does not match the requested mode", {
                expectedFlags: flags,
                actualFlags: after.flags
            });
        verified = true;
        completed.push(after);
        return { channel: after, changed: true };
    } catch (error) {
        if (!error.code) error.code = attempted === null ? "RTT_READ_FAILED" : "RTT_WRITE_FAILED";
        if (
            error.code === "OPENOCD_TCL_ERROR" &&
            attempted === null &&
            /unknown command|invalid command name/i.test(error.message)
        )
            error.code = "RTT_ACCESS_UNSUPPORTED";
        error.retryable = false;
        error.details = {
            ...error.details,
            commandCount,
            bytesRead,
            ...(request.operation === "setMode"
                ? {
                      attempted,
                      writeAcknowledged: acknowledged,
                      resultUnknown: attempted !== null && !verified,
                      completed
                  }
                : {})
        };
        throw error;
    }
}

module.exports = {
    MAX_SNAPSHOT_BYTES,
    MAX_TARGET_COMMANDS,
    MAX_TARGET_TRANSACTION_MS,
    targetTransaction,
    validateTargetRequest
};
