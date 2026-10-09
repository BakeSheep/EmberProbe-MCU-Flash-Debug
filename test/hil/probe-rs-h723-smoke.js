"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { parseElfSymbols, parseElfSections } = require("../../src/elfSymbols");
const { parseDwarf } = require("../../src/dwarf");
const { filterRuntimeRamPlan } = require("../../src/services/liveWatchService");
const { resolveProbeRsDebugConfiguration } = require("../../src/services/probeRsConfiguration");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DapClient {
    constructor(executable) {
        this.child = spawn(executable, ["dap-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.buffer = Buffer.alloc(0);
        this.nextSeq = 0;
        this.pending = new Map();
        this.stderr = "";
        this.rtt = "";
        this.child.stdout.on("data", (chunk) => this.consume(chunk));
        this.child.stderr.on("data", (chunk) => {
            this.stderr = (this.stderr + chunk.toString()).slice(-4000);
        });
        this.child.on("error", (error) => this.fail(error));
        this.child.on("exit", (code) => this.fail(new Error(`probe-rs DAP exited (${code}): ${this.stderr}`)));
    }

    fail(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    consume(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            const match = /Content-Length:\s*(\d+)/i.exec(this.buffer.toString("ascii", 0, headerEnd));
            if (!match) return this.fail(new Error("Invalid DAP frame"));
            const length = Number(match[1]);
            if (!Number.isSafeInteger(length) || length > 8 * 1024 * 1024)
                return this.fail(new Error("DAP frame is too large"));
            if (this.buffer.length < headerEnd + 4 + length) return;
            const message = JSON.parse(this.buffer.toString("utf8", headerEnd + 4, headerEnd + 4 + length));
            this.buffer = this.buffer.subarray(headerEnd + 4 + length);
            if (message.type === "response") {
                const pending = this.pending.get(message.request_seq);
                if (!pending) continue;
                this.pending.delete(message.request_seq);
                clearTimeout(pending.timer);
                if (message.success) pending.resolve(message.body || {});
                else pending.reject(new Error(message.message || JSON.stringify(message.body)));
            } else if (message.type === "event" && message.event === "probe-rs-rtt-channel-config") {
                void this.request("rttWindowOpened", {
                    channelNumber: message.body.channelNumber,
                    windowIsOpen: true
                }).catch((error) => this.fail(error));
            } else if (message.type === "event" && message.event === "probe-rs-rtt-data") {
                this.rtt += String(message.body?.data || "");
            }
        }
    }

    request(command, args = {}, timeoutMs = 15000) {
        const seq = ++this.nextSeq;
        const payload = JSON.stringify({ seq, type: "request", command, arguments: args });
        const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq);
                reject(new Error(`DAP ${command} timed out: ${this.stderr}`));
            }, timeoutMs);
            this.pending.set(seq, { resolve, reject, timer });
            this.child.stdin.write(frame, (error) => {
                if (error) {
                    clearTimeout(timer);
                    this.pending.delete(seq);
                    reject(error);
                }
            });
        });
    }

    async close() {
        try {
            await this.request("disconnect", { terminateDebuggee: false, suspendDebuggee: false }, 3000);
        } catch {
            // The adapter may already have exited; the process is still terminated below.
        }
        this.child.kill();
    }
}

async function main() {
    if (process.env.EMBERPROBE_HIL_CONFIRM !== "YES")
        throw new Error("Set EMBERPROBE_HIL_CONFIRM=YES for this dedicated-board test");
    const elfPath = process.env.EMBERPROBE_HIL_ELF;
    if (!elfPath) throw new Error("Set EMBERPROBE_HIL_ELF to the flashed smoke app ELF");
    const bytes = fs.readFileSync(elfPath);
    const symbols = parseElfSymbols(bytes).symbols;
    const dwarf = parseDwarf(bytes);
    const globals = new Map();
    for (const name of ["TICKS", "TUNE_MS", "APPLIED_MS"]) {
        const found = symbols.filter((symbol) => dwarf.displayNames.get(symbol.name)?.endsWith(`::${name}`));
        assert.equal(found.length, 1, `Expected exactly one Rust ${name} symbol`);
        assert.equal(dwarf.types.get(found[0].name).watchType, "u32");
        globals.set(name, found[0]);
    }
    const ram = filterRuntimeRamPlan([...globals.values()], parseElfSections(bytes).sections);
    assert.equal(ram.denied.length, 0, "All smoke globals must be in writable RAM");

    const chip = process.env.EMBERPROBE_HIL_CHIP || "STM32H723VGTx";
    const probe = process.env.EMBERPROBE_HIL_PROBE || "";
    const config = resolveProbeRsDebugConfiguration(
        {
            request: "attach",
            executable: elfPath,
            wireProtocol: "Swd",
            rttEnabled: true,
            rttChannelFormats: [{ channelNumber: 0, dataFormat: "Defmt" }]
        },
        { uri: { fsPath: path.dirname(elfPath) } },
        elfPath,
        { chip, probe, speed: 0 }
    );
    const dap = new DapClient(process.env.EMBERPROBE_HIL_PROBE_RS || "probe-rs");
    let tuned = false;
    const read32 = async (name) => {
        const address = globals.get(name).address;
        const response = await dap.request("readMemory", { memoryReference: `0x${address.toString(16)}`, count: 4 });
        const value = Buffer.from(response.data || "", "base64");
        assert.equal(value.length, 4, `Incomplete ${name} DAP read`);
        return value.readUInt32LE();
    };
    const write32 = async (name, number) => {
        const data = Buffer.alloc(4);
        data.writeUInt32LE(number);
        const response = await dap.request("writeMemory", {
            memoryReference: `0x${globals.get(name).address.toString(16)}`,
            data: data.toString("base64"),
            allowPartial: false
        });
        if (response.bytesWritten !== undefined) assert.equal(response.bytesWritten, 4);
    };
    try {
        await dap.request("initialize", { adapterID: "probe-rs", linesStartAt1: true, columnsStartAt1: true });
        await dap.request("attach", config, 30000);
        await dap.request("configurationDone");
        const before = await read32("TICKS");
        await sleep(600);
        const after = await read32("TICKS");
        assert.ok(after > before, `TICKS did not advance: ${before} -> ${after}`);
        assert.equal(await read32("TUNE_MS"), 100);
        await write32("TUNE_MS", 250);
        tuned = true;
        await sleep(700);
        assert.equal(await read32("TUNE_MS"), 250);
        assert.equal(await read32("APPLIED_MS"), 250);
        await write32("TUNE_MS", 100);
        tuned = false;
        await sleep(350);
        assert.equal(await read32("APPLIED_MS"), 100);
        await sleep(1200);
        assert.match(dap.rtt, /emberprobe smoke ticks=/, "Expected defmt RTT data from the smoke app");
        console.log(
            JSON.stringify({
                chip,
                probe: probe || "unique",
                ticksBefore: before,
                ticksAfter: after,
                rttBytes: dap.rtt.length
            })
        );
    } finally {
        if (tuned) {
            try {
                await write32("TUNE_MS", 100);
            } catch {
                // A disconnected probe cannot restore RAM; reboot reinitializes it to 100 ms.
            }
        }
        await dap.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
