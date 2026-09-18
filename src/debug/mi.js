"use strict";

// C-string decoding adapted from Cortex-Debug backend/mi_parse.ts.
// Copyright 2017-2023 Marcel Ball. MIT; see THIRD_PARTY_NOTICES.md.
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

function quote(value) {
    return JSON.stringify(String(value));
}

function parseRecord(line) {
    line = line.trimEnd();
    const match = /^(\d*)([\^*+=~@&])(.*)$/.exec(line);
    if (!match) return null;
    let input = match[3];
    let offset = 0;
    function string() {
        offset++;
        const bytes = [];
        while (offset < input.length) {
            let char = input[offset++];
            if (char === '"') return Buffer.concat(bytes).toString("utf8");
            if (char === "\\") {
                char = input[offset++];
                const octal = /^[0-7]{1,3}/.exec(input.slice(offset - 1));
                if (octal) {
                    bytes.push(Buffer.from([parseInt(octal[0], 8)]));
                    offset += octal[0].length - 1;
                    continue;
                }
                char = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" }[char] || char;
            }
            if (char === undefined) break;
            const code = char.charCodeAt(0);
            if (code >= 0xd800 && code <= 0xdbff && offset < input.length) char += input[offset++];
            bytes.push(Buffer.from(char));
        }
        throw new Error("Unterminated MI string");
    }
    function value(depth = 0) {
        if (depth > 64) throw new Error("MI nesting limit exceeded");
        if (input[offset] === '"') return string();
        const opening = input[offset++];
        if (opening !== "{" && opening !== "[") throw new Error("Invalid MI value");
        const closing = opening === "{" ? "}" : "]";
        const values = [];
        const fields = Object.create(null);
        let keyed = opening === "{";
        while (input[offset] !== closing) {
            const key = /^([\w-]+)=/.exec(input.slice(offset));
            if (key) {
                offset += key[0].length;
                const child = value(depth + 1);
                if (opening === "[") values.push({ [key[1]]: child });
                else fields[key[1]] = child;
                keyed = opening === "{";
            } else values.push(value(depth + 1));
            if (input[offset] === closing) break;
            if (input[offset++] !== ",") throw new Error("Invalid MI separator");
        }
        offset++;
        return keyed ? fields : values;
    }
    const record = { token: Number(match[1]), kind: match[2], class: "", data: Object.create(null), text: "" };
    if ("~@&".includes(record.kind)) record.text = string();
    else {
        const name = /^[\w-]+/.exec(input);
        if (!name) throw new Error("Invalid MI record");
        record.class = name[0];
        offset = name[0].length;
        while (offset < input.length) {
            // target-download reports an unnamed tuple: +download,{section=...}.
            if (record.kind === "+" && record.class === "download" && input.slice(offset, offset + 2) === ",{") {
                offset++;
                Object.assign(record.data, value());
                continue;
            }
            const field = /^,([\w-]+)=/.exec(input.slice(offset));
            if (!field) throw new Error("Invalid MI result");
            offset += field[0].length;
            record.data[field[1]] = value();
        }
    }
    if (offset !== input.length) throw new Error("Trailing MI data");
    return record;
}

class MiClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.spawn = options.spawn || spawn;
        this.timeoutMs = options.timeoutMs || 15000;
        this.pending = new Map();
        this.token = 0;
        this.buffer = "";
        this.decoder = new StringDecoder("utf8");
        this.closed = false;
        this.process = null;
    }
    start(executable, cwd) {
        this.process = this.spawn(executable, ["--interpreter=mi2", "--quiet", "--nx"], {
            cwd,
            windowsHide: true,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"]
        });
        this.process.stdout.on("data", (chunk) => this.feed(this.decoder.write(chunk)));
        this.process.stderr.on("data", (chunk) => this.emit("output", String(chunk)));
        this.process.stdin.on("error", (error) => this.fail(error));
        this.process.on("error", (error) => this.fail(error));
        this.process.on("exit", () => this.fail(new Error("GDB exited")));
    }
    feed(chunk) {
        this.buffer += chunk;
        if (this.buffer.length > 8 * 1024 * 1024) return this.fail(new Error("GDB output limit exceeded"));
        let index;
        while ((index = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, index).replace(/\r$/, "");
            this.buffer = this.buffer.slice(index + 1);
            try {
                const record = parseRecord(line);
                if (!record) continue;
                if (record.kind === "^") {
                    const pending = this.pending.get(record.token);
                    if (!pending) continue;
                    clearTimeout(pending.timer);
                    this.pending.delete(record.token);
                    if (record.class === "error") pending.reject(new Error(record.data.msg || "GDB command failed"));
                    else pending.resolve(record.data);
                } else if ("~@&".includes(record.kind)) this.emit("output", record.text);
                else this.emit("record", record);
            } catch (error) {
                error.message += ` (GDB/MI record: ${line.slice(0, 300)})`;
                this.fail(error);
            }
        }
    }
    command(command, timeoutMs = this.timeoutMs) {
        if (this.closed || !this.process) return Promise.reject(new Error("GDB is not running"));
        if (/[\r\n]/.test(command)) return Promise.reject(new Error("Invalid MI command"));
        return new Promise((resolve, reject) => {
            const token = ++this.token;
            const timer = setTimeout(() => {
                this.fail(new Error(`GDB command timed out: ${command.split(" ")[0]}`));
            }, timeoutMs);
            this.pending.set(token, { resolve, reject, timer });
            this.process.stdin.write(`${token}${command}\n`, (error) => {
                if (error) this.fail(error);
            });
        });
    }
    fail(error) {
        if (this.closed) return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.process?.kill();
        this.emit("closed", error);
    }
    async stop() {
        if (this.closed) return;
        try {
            await this.command("-gdb-exit", 2000);
        } catch {
            /* Escalate to process termination below. */
        }
        this.fail(new Error("Debug session ended"));
    }
}

module.exports = { MiClient, parseRecord, quote };
