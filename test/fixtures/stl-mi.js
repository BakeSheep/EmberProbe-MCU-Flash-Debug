"use strict";

const { EventEmitter } = require("events");

class StlMi extends EventEmitter {
    constructor(width = 4) {
        super();
        this.width = width;
        this.commands = [];
        this.items = new Map();
        this.aliases = new Map();
        this.blocks = [];
        this.offsets = new Map();
        this.serial = 0;
        this.little = true;
    }
    item(name, type, value = "{...}", children = [], address = 0x20000000n) {
        const item = {
            name,
            exp: name.split(".").at(-1),
            type,
            value,
            children,
            numchild: String(children.length),
            address
        };
        this.items.set(name, item);
        return item;
    }
    allocation(address, bytes) {
        this.blocks.push({ address: BigInt(address), bytes });
    }
    async stop() {}
    async command(command) {
        this.commands.push(command);
        if (this.onCommand) this.onCommand(command);
        const quoted = command.match(/"(?:[^"\\]|\\.)*"/g)?.map((text) => JSON.parse(text)) || [];
        const name = quoted[0];
        if (command.startsWith("-interpreter-exec console")) {
            if (name === "show endian")
                this.emit("output", `The target is ${this.little ? "little" : "big"} endian.\n`);
            else {
                const path = name.replace(/^(?:whatis|ptype) \/r /, "");
                const item = this.items.get(path);
                this.emit("output", `type = ${this.aliases.get(item?.type) || item?.type || "int"}\n`);
            }
            return {};
        }
        if (command.startsWith("-var-info-path-expression")) return { path_expr: this.items.get(name)?.path || name };
        if (command.startsWith("-var-list-children")) {
            const range = command.match(/ (\d+) (\d+)$/);
            return {
                children: this.items
                    .get(name)
                    .children.slice(Number(range[1]), Number(range[2]))
                    .map((child) => ({ child }))
            };
        }
        if (command.startsWith("-var-evaluate-expression")) return { value: this.items.get(name).value };
        if (command.startsWith("-data-evaluate-expression")) {
            if (name === "sizeof(void*)") return { value: String(this.width) };
            if (/^sizeof/.test(name)) return { value: name.includes("char") ? "1" : "4" };
            if (name.includes("*)0)->")) {
                const field = name.split("*)0)->")[1];
                return {
                    value: String(
                        this.offsets.get(field) ??
                            { _M_parent: 4, _M_left: 8, _M_right: 12, "_M_storage._M_storage": 16, _M_nxt: 0, _M_u: 0 }[
                                field
                            ]
                    )
                };
            }
            const path = name.match(/&\((.*)\)$/)?.[1];
            return { value: String(this.items.get(path).address) };
        }
        if (command.startsWith("-data-read-memory-bytes")) {
            const match = command.match(/ (0x[\da-f]+) (\d+)$/i);
            const address = BigInt(match[1]),
                length = Number(match[2]);
            const block = this.blocks.find(
                (entry) =>
                    address >= entry.address && address + BigInt(length) <= entry.address + BigInt(entry.bytes.length)
            );
            if (!block) throw new Error("Cannot access memory at address " + address);
            const offset = Number(address - block.address);
            return {
                memory: [{ begin: match[1], contents: block.bytes.subarray(offset, offset + length).toString("hex") }]
            };
        }
        if (command.startsWith("-var-create")) {
            const expression = quoted.at(-1);
            let item = this.items.get(expression);
            if (!item) {
                const indexed = expression.match(/^\((.*)\)\[(\d+)\]$/);
                const cast = expression.match(/\*\(\((.*?)\*\)0x([\da-f]+)\)/i);
                const scalar = expression.match(/^\*\((.*)\)$/);
                if (indexed) {
                    const index = Number(indexed[2]);
                    const pointer = this.items.get(indexed[1]);
                    const value = pointer.values?.[index] ?? index;
                    item = this.item(`element${++this.serial}`, "int", String(value));
                    item.index = index;
                    item.source = pointer;
                } else if (cast) {
                    const address = BigInt("0x" + cast[2]);
                    const pointee = [...this.items.values()].find(
                        (entry) => entry.pointee && BigInt(entry.value) === address
                    );
                    if (pointee) return pointee.pointee;
                    const start = [...this.items.values()].find(
                        (entry) => entry.exp === "_M_start" && /\*$/.test(entry.type)
                    );
                    const finish = start && this.items.get(start.name.replace("_M_start", "_M_finish"));
                    if (start && address >= BigInt(start.value) && address < BigInt(finish.value)) {
                        const index = Number((address - BigInt(start.value)) / 4n);
                        item = this.item(`element${++this.serial}`, "int", String(start.values?.[index] ?? index));
                        item.index = index;
                        item.source = start;
                        return item;
                    }
                    const block = this.blocks.find(
                        (entry) => address >= entry.address && address < entry.address + BigInt(entry.bytes.length)
                    );
                    const offset = Number(address - block.address);
                    if (cast[1] === "char")
                        return this.item(`char${++this.serial}`, "char", String(block.bytes[offset]));
                    if (!cast[1].includes("std::pair"))
                        return this.item(`cast${++this.serial}`, "int", String(block.bytes.readInt32LE(offset)));
                    const label = `pair${++this.serial}`;
                    const first = this.item(label + ".first", "const int", String(block.bytes.readInt32LE(offset)));
                    const second = this.item(label + ".second", "int", String(block.bytes.readInt32LE(offset + 4)));
                    item = this.item(label, "std::pair<const int, int>", "{...}", [first, second]);
                } else if (scalar && this.items.get(scalar[1])?.pointee) item = this.items.get(scalar[1]).pointee;
                else throw new Error("Unknown fixture expression: " + expression);
            }
            return item;
        }
        if (command.startsWith("-var-show-attributes"))
            return { attr: this.editable === false ? "noneditable" : "editable" };
        if (command.startsWith("-var-assign")) {
            const item = this.items.get(name);
            item.value = quoted[1];
            if (item.source) {
                item.source.values ||= [];
                item.source.values[item.index] = Number(quoted[1]);
            }
            return { value: quoted[1] };
        }
        return {};
    }
}

module.exports = { StlMi };
