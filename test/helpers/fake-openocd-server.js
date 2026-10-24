"use strict";
const fs = require("fs");
const net = require("net");

const SUB = "\x1a";

class FakeOpenOcdServer {
    constructor() {
        this.server = null;
        this.port = 0;
        this.commands = [];
        this.responses = [];
        this.memory = new Map();
        this.sockets = new Set();
        this.state = "running";
        this.readLatencyMs = 0;
        this.rejectBatchCommand = false;
        this.transientFailures = 0;
        this.timeoutNext = false;
        this.activeInFlight = 0;
        this.maxInFlight = 0;
        // Emulates Cortex-M7/AHB-AP byte lanes that acknowledge but discard 8/16-bit writes.
        this.dropNarrowWrites = false;
        this.scatterVersion = null;
        this.scatterFailures = 0;
        this.scatterReply = null;
    }

    seed(address, bytes) {
        bytes.forEach((byte, index) => this.memory.set((address + index) >>> 0, byte & 0xff));
    }

    bytes(address, count) {
        return Array.from({ length: count }, (_, index) => this.memory.get((address + index) >>> 0) || 0);
    }

    async start() {
        this.server = net.createServer((socket) => {
            this.sockets.add(socket);
            let pending = "";
            socket.setEncoding("latin1");
            socket.on("close", () => this.sockets.delete(socket));
            // Closing a client may reset the transport; other errors must fail the test.
            socket.on("error", (error) => {
                if (!["ECONNRESET", "ECONNABORTED", "EPIPE"].includes(error.code)) throw error;
            });
            socket.on("data", (chunk) => {
                pending += chunk;
                let boundary;
                while ((boundary = pending.indexOf(SUB)) >= 0) {
                    const command = pending.slice(0, boundary).trim();
                    pending = pending.slice(boundary + 1);
                    if (command) this._handle(socket, command);
                }
            });
        });
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", resolve);
        });
        this.port = this.server.address().port;
        return this.port;
    }

    async _handle(socket, command) {
        this.activeInFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.activeInFlight);
        try {
            if (this.readLatencyMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, this.readLatencyMs));
            }
            if (this.timeoutNext) {
                this.timeoutNext = false;
                return;
            }
            const prefix = "set _ep_rc [catch {";
            const suffix = "} _ep_msg]";
            if (command.startsWith(prefix)) {
                const boundary = command.indexOf(suffix, prefix.length);
                if (boundary >= 0) {
                    const inner = command.slice(prefix.length, boundary);
                    const result = this._execute(inner);
                    const responseFile = command.match(/set _ep_file \[open "([^"]+)" w\]/);
                    if (responseFile) {
                        const targetPath = responseFile[1].replace(/\\\\/g, "\\");
                        fs.writeFileSync(targetPath, `${result.ok ? 0 : 1}\n${result.response}`);
                        this.responses.push("");
                        socket.write(SUB);
                    } else {
                        const response = (result.ok ? "EP_OK:" : "EP_ERR:") + result.response;
                        this.responses.push(response);
                        socket.write(response + SUB);
                    }
                    return;
                }
            }
            const result = this._execute(command);
            this.responses.push(result.response);
            socket.write(result.response + SUB);
        } finally {
            this.activeInFlight--;
        }
    }

    _executeRead(command) {
        const read = command.match(/^(?:ocd_)?read_memory\s+(0x[0-9a-f]+)\s+(8|16|32)\s+(\d+)$/i);
        if (!read) return null;
        if (this.transientFailures > 0) {
            this.transientFailures--;
            return { ok: false, response: "target memory read failed" };
        }
        const elementBytes = Number(read[2]) / 8;
        const raw = this.bytes(parseInt(read[1], 16), Number(read[3]) * elementBytes);
        const values = [];
        for (let offset = 0; offset < raw.length; offset += elementBytes) {
            let value = 0;
            for (let index = 0; index < elementBytes; index++) value += raw[offset + index] * 2 ** (index * 8);
            values.push("0x" + (value >>> 0).toString(16));
        }
        return { ok: true, response: values.join(" ") };
    }

    _execute(command) {
        this.commands.push(command);
        if (command === "emberprobe_read_scatter version") {
            return this.scatterVersion === null
                ? { ok: false, response: 'invalid command name "emberprobe_read_scatter"' }
                : { ok: true, response: this.scatterVersion };
        }
        if (command.startsWith("emberprobe_read_scatter ")) {
            if (this.scatterFailures > 0) {
                this.scatterFailures--;
                return { ok: false, response: "scatter memory read failed" };
            }
            if (this.scatterReply !== null) return { ok: true, response: this.scatterReply };
            const segments = [...command.matchAll(/\{(0x[0-9a-f]+) (8|16|32) (\d+)\}/g)];
            const sizes = segments.map((match) => (Number(match[2]) / 8) * Number(match[3]));
            if (!segments.length || segments.length > 64 || sizes.reduce((a, b) => a + b, 0) > 4096)
                return { ok: false, response: "scatter limits exceeded" };
            return {
                ok: true,
                response: segments
                    .map((match, index) =>
                        Buffer.from(this.bytes(parseInt(match[1], 16), sizes[index])).toString("hex")
                    )
                    .join("\n")
            };
        }
        if (command.startsWith("join [list")) {
            if (this.rejectBatchCommand) {
                return { ok: false, response: 'invalid command name "join"' };
            }
            if (this.transientFailures > 0) {
                this.transientFailures--;
                return { ok: false, response: "target memory read failed" };
            }
            const innerCommands = [];
            const re = /\[((?:ocd_)?read_memory\s+[^\]]+)\]/g;
            let m;
            while ((m = re.exec(command)) !== null) {
                innerCommands.push(m[1]);
            }
            if (innerCommands.length === 0) {
                return { ok: false, response: "invalid batch command syntax" };
            }
            const results = [];
            for (const subCmd of innerCommands) {
                const res = this._executeRead(subCmd);
                if (!res || !res.ok) return res || { ok: false, response: "unknown batch subcmd" };
                results.push(res.response);
            }
            return { ok: true, response: results.join("\n") };
        }
        const readRes = this._executeRead(command);
        if (readRes) return readRes;
        const write = command.match(/^(?:ocd_)?write_memory\s+(0x[0-9a-f]+)\s+(8|16|32)\s+\{([^}]*)\}$/i);
        if (write) {
            const elementBytes = Number(write[2]) / 8;
            const elements = write[3]
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .map((value) => Number.parseInt(value, 0) >>> 0);
            const values = [];
            for (const element of elements) {
                for (let index = 0; index < elementBytes; index++) values.push((element >>> (index * 8)) & 0xff);
            }
            if (!(this.dropNarrowWrites && elementBytes < 4)) this.seed(parseInt(write[1], 16), values);
            return { ok: true, response: "" };
        }
        if (command === "[target current] curstate") return { ok: true, response: this.state };
        if (command === "halt") {
            this.state = "halted";
            return { ok: true, response: "" };
        }
        if (command === "resume") {
            this.state = "running";
            return { ok: true, response: "" };
        }
        if (command === "shutdown") {
            return { ok: true, response: "" };
        }
        return { ok: false, response: `invalid command name "${command.split(/\s+/)[0]}"` };
    }

    async connect() {
        return await new Promise((resolve, reject) => {
            const socket = net.connect({ host: "127.0.0.1", port: this.port });
            socket.once("connect", () => resolve(socket));
            socket.once("error", reject);
        });
    }

    async stop() {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        if (!this.server) return;
        const server = this.server;
        this.server = null;
        await new Promise((resolve) => server.close(resolve));
    }
}

module.exports = { FakeOpenOcdServer, SUB };
