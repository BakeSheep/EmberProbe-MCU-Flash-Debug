"use strict";
const net = require("net");

const SUB = "\x1a";

class FakeOpenOcdServer {
    constructor() {
        this.server = null;
        this.port = 0;
        this.commands = [];
        this.memory = new Map();
        this.sockets = new Set();
    }

    seed(address, bytes) {
        bytes.forEach((byte, index) => this.memory.set((address + index) >>> 0, byte & 0xff));
    }

    bytes(address, count) {
        return Array.from({ length: count }, (_, index) => this.memory.get((address + index) >>> 0) || 0);
    }

    async start() {
        this.server = net.createServer(socket => {
            this.sockets.add(socket);
            let pending = "";
            socket.setEncoding("latin1");
            socket.on("close", () => this.sockets.delete(socket));
            socket.on("data", chunk => {
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

    _handle(socket, command) {
        this.commands.push(command);
        const read = command.match(/^(?:ocd_)?read_memory\s+(0x[0-9a-f]+)\s+8\s+(\d+)$/i);
        if (read) {
            const values = this.bytes(parseInt(read[1], 16), Number(read[2]));
            socket.write(values.join(" ") + SUB);
            return;
        }
        const write = command.match(/^(?:ocd_)?write_memory\s+(0x[0-9a-f]+)\s+8\s+\{([^}]*)\}$/i);
        if (write) {
            const values = write[2].trim().split(/\s+/).filter(Boolean).map(value => parseInt(value, 16));
            this.seed(parseInt(write[1], 16), values);
            socket.write(SUB);
            return;
        }
        if (command === "shutdown") {
            socket.write(SUB);
            return;
        }
        socket.write("invalid command" + SUB);
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
        await new Promise(resolve => server.close(resolve));
    }
}

module.exports = { FakeOpenOcdServer, SUB };
