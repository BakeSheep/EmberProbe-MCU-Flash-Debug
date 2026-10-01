"use strict";

// In-memory ARM remote target for opt-in real-GDB acceptance. It cannot access a probe or board.
const net = require("net");

class RspMemory {
    constructor() {
        this.memory = new Map();
        this.writes = [];
        this.sockets = new Set();
        this.packets = [];
        this.registers = Buffer.alloc(17 * 4);
        this.registers.writeUInt32LE(0x08000000, 15 * 4);
        this.registers.writeUInt32LE(0x01000000, 16 * 4);
        this.xml =
            '<?xml version="1.0"?><!DOCTYPE target SYSTEM "gdb-target.dtd"><target><architecture>arm</architecture><feature name="org.gnu.gdb.arm.m-profile">' +
            Array.from(
                { length: 17 },
                (_, i) =>
                    `<reg name="${i < 13 ? `r${i}` : ["sp", "lr", "pc", "xpsr"][i - 13]}" bitsize="32" regnum="${i}"/>`
            ).join("") +
            "</feature></target>";
    }
    async start() {
        this.server = net.createServer((socket) => {
            this.sockets.add(socket);
            socket.on("close", () => this.sockets.delete(socket));
            socket.on("error", (error) => {
                this.packets.push(`socket: ${error.message}`);
            });
            let input = Buffer.alloc(0);
            socket.on("data", (bytes) => {
                input = Buffer.concat([input, bytes]);
                while (input.length) {
                    if (input[0] !== 36) {
                        input = input.subarray(1);
                        continue;
                    }
                    const end = input.indexOf(35, 1);
                    if (end < 0 || end + 3 > input.length) break;
                    const payload = input.subarray(1, end);
                    const checksum = payload.reduce((sum, byte) => (sum + byte) & 255, 0);
                    const received = Number.parseInt(input.subarray(end + 1, end + 3).toString(), 16);
                    input = input.subarray(end + 3);
                    if (received !== checksum) {
                        socket.write("-");
                        continue;
                    }
                    socket.write("+");
                    const decoded = [];
                    for (let i = 0; i < payload.length; i++)
                        decoded.push(payload[i] === 125 ? payload[++i] ^ 32 : payload[i]);
                    const packet = Buffer.from(decoded).toString("latin1");
                    this.packets.push(packet.slice(0, 200));
                    const response = this.reply(packet);
                    const encoded = Buffer.from(response, "latin1");
                    const sum = encoded.reduce((value, byte) => (value + byte) & 255, 0);
                    socket.write(
                        Buffer.concat([Buffer.from("$"), encoded, Buffer.from(`#${sum.toString(16).padStart(2, "0")}`)])
                    );
                }
            });
        });
        await new Promise((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", resolve);
        });
        return `127.0.0.1:${this.server.address().port}`;
    }
    read(address, length) {
        return Buffer.from(Array.from({ length }, (_, index) => this.memory.get(address + index) || 0));
    }
    reply(packet) {
        if (packet.startsWith("qSupported")) return "PacketSize=4000;qXfer:features:read+";
        if (packet.startsWith("qXfer:features:read:target.xml:")) {
            const [offset, length] = packet
                .slice(packet.lastIndexOf(":") + 1)
                .split(",")
                .map((n) => parseInt(n, 16));
            return (offset + length >= this.xml.length ? "l" : "m") + this.xml.slice(offset, offset + length);
        }
        if (packet === "?") return "T05thread:1;";
        if (packet === "qfThreadInfo") return "m1";
        if (packet === "qsThreadInfo") return "l";
        if (packet === "qC") return "QC1";
        if (packet.startsWith("qAttached")) return "1";
        if (packet.startsWith("qSymbol")) return "OK";
        if (packet === "g") return this.registers.toString("hex");
        if (/^p[\da-f]+$/.test(packet))
            return (
                this.registers
                    .subarray(parseInt(packet.slice(1), 16) * 4, parseInt(packet.slice(1), 16) * 4 + 4)
                    .toString("hex") || "00000000"
            );
        if (packet.startsWith("G")) {
            this.registers = Buffer.from(packet.slice(1), "hex");
            return "OK";
        }
        if (packet.startsWith("P")) {
            const [index, value] = packet.slice(1).split("=");
            Buffer.from(value, "hex").copy(this.registers, parseInt(index, 16) * 4);
            return "OK";
        }
        const read = packet.match(/^m([\da-f]+),([\da-f]+)$/);
        if (read) return this.read(parseInt(read[1], 16), parseInt(read[2], 16)).toString("hex");
        const write = packet.match(/^([MX])([\da-f]+),([\da-f]+):([\s\S]*)$/);
        if (write) {
            const address = parseInt(write[2], 16),
                length = parseInt(write[3], 16);
            const bytes = Buffer.from(write[4], write[1] === "M" ? "hex" : "latin1");
            if (bytes.length !== length) return "E01";
            for (let i = 0; i < length; i++) this.memory.set(address + i, bytes[i]);
            this.writes.push({ address, length });
            return "OK";
        }
        if (/^(?:H|T|!|D|k|qRcmd,)/.test(packet)) return "OK";
        return "";
    }
    async stop() {
        for (const socket of this.sockets) socket.destroy();
        if (this.server) await new Promise((resolve) => this.server.close(resolve));
    }
}

module.exports = { RspMemory };
