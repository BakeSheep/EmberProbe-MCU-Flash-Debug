"use strict";
// Target memory writes over the Tcl connection: the managed-debug write budget, natural-width writes of only the
// variable's own bytes with read-back, the aligned 32-bit read-modify-write fallback, the write_memory command fallback,
// and halting a running target around a transaction. The session keeps the exclusive arbiter and the read guards.
const { isNonHaltingWordWrite, runtimeWriteDisabledError } = require("./writeAccess");
const { MAX_DEBUG_READ_COMMANDS, bytesToElements, validateManagedReadPlan } = require("./liveWatchReadPlan");

// Split a byte range into naturally aligned 8/16/32-bit accesses, merging equal widths.
function naturalWriteChunks(address, bytes) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length;) {
        const at = address + offset;
        const remaining = bytes.length - offset;
        const width = at % 4 === 0 && remaining >= 4 ? 4 : at % 2 === 0 && remaining >= 2 ? 2 : 1;
        const last = chunks[chunks.length - 1];
        const part = bytes.slice(offset, offset + width);
        if (last && last.width === width && last.address + last.bytes.length === at) last.bytes.push(...part);
        else chunks.push({ address: at, width, bytes: part });
        offset += width;
    }
    return chunks;
}

function validateManagedWritePlan(items) {
    if (!items.every(isNonHaltingWordWrite)) throw runtimeWriteDisabledError();
    for (const item of items) {
        if (!Number.isInteger(item.address) || item.address < 0 || item.address + 4 > 0x100000000)
            throw Object.assign(new Error("Runtime write range overflows the 32-bit target address space"), {
                code: "LIVE_ADDRESS_NOT_RAM"
            });
        if (Array.from(item.bytes).some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
            throw Object.assign(new Error("Runtime writes require integer bytes in the range 0..255"), {
                code: "INVALID_WRITE_VALUE"
            });
    }
    validateManagedReadPlan(items.map((item) => ({ address: item.address, size: item.bytes.length })));
    // Reads may merge adjacent ranges; each word write still requires its own Tcl command.
    if (items.length > MAX_DEBUG_READ_COMMANDS)
        throw Object.assign(new Error("Runtime write plan exceeds the per-cycle command budget"), {
            code: "LIVE_WRITE_BUDGET_EXCEEDED",
            details: { commandCount: items.length, maxCommands: MAX_DEBUG_READ_COMMANDS }
        });
}

class MemoryWriter {
    // tcl: the session's connection. readBytes(address, count): little-endian bytes, or null for an unusable response.
    constructor({ tcl, mode, readBytes }) {
        this.tcl = tcl;
        this.mode = mode;
        this.readBytes = readBytes;
        this.writeCmd = "ocd_write_memory"; // preferred write command, falling back to write_memory
        this.writeAltTried = false;
    }

    // Aligned single words are written directly. Other variables first write only their own bytes at their natural
    // width, so neighbouring bytes just updated by DMA or peripherals during the halt are not overwritten with stale
    // values; if read-back shows the narrow write was dropped (byte lanes on some Cortex-M7/AHB-AP), fall back to an
    // aligned 32-bit read-modify-write.
    async writeBytes(addr, bytes) {
        if (this.mode === "debug") validateManagedWritePlan([{ address: addr, bytes }]);
        const address = addr >>> 0;
        const input = Array.from(bytes || [], (value) => value & 0xff);
        if (!input.length) return true;
        const alignedStart = (address & 0xfffffffc) >>> 0;
        const alignedEnd = Math.ceil((address + input.length) / 4) * 4;
        if (alignedStart === address && alignedEnd - alignedStart === input.length) {
            await this._writeElements(alignedStart, 4, input);
            return true;
        }
        let narrowError = null;
        try {
            for (const chunk of naturalWriteChunks(address, input))
                await this._writeElements(chunk.address, chunk.width, chunk.bytes);
        } catch (error) {
            narrowError = error;
        }
        const words = await this.readBytes(alignedStart, alignedEnd - alignedStart);
        if (!words) {
            if (narrowError) throw narrowError;
            throw new Error("Memory write failed: cannot read back the written bytes");
        }
        const offset = address - alignedStart;
        if (!narrowError && input.every((value, index) => words[offset + index] === value)) return true;
        const writeBytes = words.slice();
        writeBytes.splice(offset, input.length, ...input);
        await this._writeElements(alignedStart, 4, writeBytes);
        return true;
    }

    async _writeElements(address, width, bytes) {
        const hex = "0x" + (address >>> 0).toString(16);
        const data = bytesToElements(bytes, width)
            .map((value) => "0x" + value.toString(16))
            .join(" ");
        const build = (cmd) => `${cmd} ${hex} ${width * 8} {${data}}`;
        try {
            await this.tcl.sendChecked(build(this.writeCmd));
        } catch (error) {
            if (!this.writeAltTried && /invalid command name|unknown command/i.test(error.message)) {
                this.writeAltTried = true;
                this.writeCmd = this.writeCmd === "ocd_write_memory" ? "write_memory" : "ocd_write_memory";
                try {
                    await this.tcl.sendChecked(build(this.writeCmd));
                } catch (fallbackError) {
                    throw Object.assign(new Error("Memory write failed: " + fallbackError.message), {
                        cause: fallbackError
                    });
                }
            } else {
                throw Object.assign(new Error("Memory write failed: " + error.message), { cause: error });
            }
        }
    }

    // Runs `transaction`, halting a running target first unless `nonHalting` and resuming it afterwards. The
    // transaction's own error wins over a failed resume.
    async withHalt(nonHalting, transaction) {
        let haltedByUs = false;
        let primaryError = null;
        let result = null;
        try {
            if (!nonHalting) {
                const state = (await this.tcl.sendChecked("[target current] curstate")).trim();
                if (state !== "halted") {
                    await this.tcl.sendChecked("halt");
                    haltedByUs = true;
                }
            }
            result = await transaction();
        } catch (error) {
            primaryError = error;
        }
        if (haltedByUs) {
            try {
                await this.tcl.sendChecked("resume");
            } catch (resumeError) {
                if (!primaryError) primaryError = resumeError;
            }
        }
        if (primaryError) throw primaryError;
        return result;
    }
}

module.exports = { MemoryWriter, validateManagedWritePlan };
