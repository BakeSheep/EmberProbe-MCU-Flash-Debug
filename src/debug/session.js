"use strict";

const path = require("path");
const fs = require("fs");
const {
    DebugSession,
    InitializedEvent,
    StoppedEvent,
    ContinuedEvent,
    TerminatedEvent,
    OutputEvent,
    Event
} = require("@vscode/debugadapter");
const { MiClient, quote } = require("./mi");

// The MI command sequence follows Cortex-Debug's GDB/MI backend. This adapter
// owns only GDB; the extension owns the OpenOCD server and probe lease.
class EmberDebugSession extends DebugSession {
    constructor(options = {}) {
        super();
        this.mi = options.mi || new MiClient();
        this.running = false;
        this.ready = false;
        this.ended = false;
        this.config = {};
        this.thread = 1;
        this.handles = new Map();
        this.nextHandle = 1;
        this.variablesByName = new Map();
        this.varObjects = new Set();
        this.breakpoints = new Map();
        this.nextBreakpoint = 1;
        this.entryBreakpoint = null;
        this.queue = Promise.resolve();
        this.internalStop = null;
        this.stopWaiters = new Set();
        this.mi.on("output", (text) => this.sendEvent(new OutputEvent(text, "console")));
        this.mi.on("record", (record) => this.onRecord(record));
        this.mi.on("closed", (error) => {
            for (const waiter of this.stopWaiters) waiter.reject(error);
            this.stopWaiters.clear();
            if (this.disconnecting) return;
            if (!this.ended) this.sendEvent(new OutputEvent(`${error.message}\n`, "stderr"));
            this.end();
            this.shutdown();
        });
    }
    shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        void this.mi.stop().finally(() => super.shutdown());
    }
    dispatchRequest(request) {
        const response = {
            seq: 0,
            type: "response",
            request_seq: request.seq,
            command: request.command,
            success: true
        };
        const execute = async () => {
            try {
                response.body = await this.handle(request.command, request.arguments || {});
                this.sendResponse(response);
                if (["disconnect", "terminate"].includes(request.command)) {
                    this.end();
                    this.shutdown();
                }
                if (request.command === "launch" || request.command === "attach")
                    this.sendEvent(new InitializedEvent());
            } catch (error) {
                this.sendErrorResponse(response, { id: 1, format: error.message, showUser: true });
                if (["launch", "attach", "configurationDone"].includes(request.command)) await this.close();
            }
        };
        // A blocked MI operation must not prevent the client from terminating it.
        if (["disconnect", "terminate"].includes(request.command)) void execute();
        else this.queue = this.queue.then(execute, execute);
    }
    end() {
        if (this.ended) return;
        this.ended = true;
        this.handles.clear();
        this.sendEvent(new TerminatedEvent());
    }
    async close() {
        this.end();
        await this.mi.stop();
    }
    onRecord(record) {
        if (record.kind !== "*") return;
        if (record.class === "running") {
            this.running = true;
            this.handles.clear();
            this.variablesByName.clear();
            if (this.ready) this.sendEvent(new ContinuedEvent(this.thread, true));
        }
        if (record.class !== "stopped") return;
        this.running = false;
        this.thread = Number(record.data["thread-id"]) || this.thread;
        const reason = record.data.reason || "pause";
        if (record.data.bkptno === this.entryBreakpoint) this.entryBreakpoint = null;
        if (reason.startsWith("exited")) {
            this.end();
            return;
        }
        const internal = this.internalStop && reason === "signal-received" && record.data["signal-name"] === "SIGINT";
        if (this.internalStop) this.internalStop.interrupted = !!internal;
        for (const waiter of this.stopWaiters) waiter.resolve(record);
        this.stopWaiters.clear();
        if (this.ready && !internal) {
            const dapReason =
                reason === "breakpoint-hit"
                    ? "breakpoint"
                    : ["end-stepping-range", "function-finished"].includes(reason)
                      ? "step"
                      : "pause";
            const event = new StoppedEvent(dapReason, this.thread);
            Object.assign(event.body, { allThreadsStopped: true });
            this.sendEvent(event);
        }
    }
    handleFor(value) {
        const id = this.nextHandle++;
        this.handles.set(id, value);
        return id;
    }
    paused() {
        if (this.running || !this.ready) throw new Error("Target must be paused");
    }
    reference(id, kind) {
        this.paused();
        const value = this.handles.get(id);
        if (!value || (kind && value.kind !== kind)) throw new Error("Stale or invalid debug reference");
        return value;
    }
    async interrupt() {
        if (!this.running) return;
        let waiter;
        let timer;
        const stopped = new Promise((resolve, reject) => {
            waiter = { resolve, reject };
            this.stopWaiters.add(waiter);
            timer = setTimeout(() => reject(new Error("Timed out waiting for target to stop")), 5000);
        });
        try {
            await Promise.all([stopped, this.mi.command("-exec-interrupt --all")]);
        } finally {
            clearTimeout(timer);
            this.stopWaiters.delete(waiter);
        }
    }
    async selectFrame(id) {
        const frame = this.reference(id, "frame");
        await this.mi.command(`-thread-select ${frame.thread}`);
        await this.mi.command(`-stack-select-frame ${frame.level}`);
        return frame;
    }
    async clearVariables() {
        for (const name of this.varObjects) {
            try {
                await this.mi.command(`-var-delete ${quote(name)}`);
            } catch {
                /* GDB can invalidate objects itself. */
            }
        }
        this.varObjects.clear();
        this.handles.clear();
        this.variablesByName.clear();
    }
    async enter() {
        if (this.entryBreakpoint) {
            try {
                await this.mi.command(`-break-delete ${this.entryBreakpoint}`);
            } catch (error) {
                this.sendEvent(new OutputEvent(`${error.message}\n`, "console"));
            }
            this.entryBreakpoint = null;
        }
        const entry = this.config.runToEntryPoint;
        if (entry) {
            try {
                const result = await this.mi.command(`-break-insert -t ${quote(entry)}`);
                this.entryBreakpoint = result.bkpt.number;
            } catch (error) {
                this.sendEvent(new OutputEvent(`Cannot stop at ${entry}: ${error.message}\n`, "stderr"));
                this.sendEvent(new StoppedEvent("entry", this.thread));
                return;
            }
            await this.execute("-exec-continue");
        } else this.sendEvent(new StoppedEvent("entry", this.thread));
    }
    async launch(args, attach) {
        if (this.ready || this.ended) throw new Error("Debug session has already started or ended");
        if (!args.executable || !fs.statSync(args.executable).isFile())
            throw new Error("A valid ELF executable is required");
        if (!args.gdbPath || !/^127\.0\.0\.1:\d+$/.test(args.gdbTarget || ""))
            throw new Error("Missing managed GDB connection");
        this.config = { ...args, runToEntryPoint: args.runToEntryPoint ?? "main", attach };
        this.mi.start(args.gdbPath, args.cwd || path.dirname(args.executable));
        await this.mi.command("-gdb-set mi-async on");
        await this.mi.command("-gdb-set pagination off");
        await this.mi.command(`-file-exec-and-symbols ${quote(args.executable.replace(/\\/g, "/"))}`);
        await this.mi.command(`-target-select extended-remote ${args.gdbTarget}`);
        if (attach) {
            await this.mi.command(`-interpreter-exec console ${quote("monitor halt")}`);
        } else {
            await this.mi.command(`-interpreter-exec console ${quote("monitor reset halt")}`);
            await this.mi.command("-target-download", 60000);
            // Reload the reset vector after downloading a different firmware.
            await this.mi.command(`-interpreter-exec console ${quote("monitor reset halt")}`);
        }
        this.running = false;
        this.ready = true;
        return {};
    }
    async setBreakpoints(args, functions) {
        if (!this.ready) throw new Error("Debugger is not initialized");
        const source = args.source?.path;
        if (!functions && !source) throw new Error("A source path is required");
        const key = functions ? "functions" : source;
        const old = this.breakpoints.get(key) || new Map();
        const updated = new Map();
        const results = [];
        const resume = this.running;
        this.internalStop = resume ? { interrupted: false } : null;
        try {
            if (resume) await this.interrupt();
            const wanted = new Set(
                (args.breakpoints || []).map((bp) =>
                    JSON.stringify([functions ? bp.name : bp.line, bp.condition || ""])
                )
            );
            for (const [identity, item] of old) {
                if (!wanted.has(identity)) {
                    await this.mi.command(`-break-delete ${item.number}`);
                    old.delete(identity);
                }
            }
            for (const bp of args.breakpoints || []) {
                const identity = JSON.stringify([functions ? bp.name : bp.line, bp.condition || ""]);
                if (updated.has(identity)) {
                    results.push(updated.get(identity).dap);
                    continue;
                }
                if (old.has(identity)) {
                    updated.set(identity, old.get(identity));
                    results.push(old.get(identity).dap);
                    old.delete(identity);
                    continue;
                }
                try {
                    if (bp.hitCondition || bp.logMessage)
                        throw new Error("Hit conditions and logpoints are not supported");
                    if (!functions && (!Number.isInteger(bp.line) || bp.line < 1))
                        throw new Error("Invalid breakpoint line");
                    const location = functions ? bp.name : `${this.remoteSource(source)}:${bp.line}`;
                    if (!location) throw new Error("A function name is required");
                    const result = await this.mi.command(
                        `-break-insert ${bp.condition ? `-c ${quote(bp.condition)} ` : ""}${quote(location)}`
                    );
                    const item = result.bkpt;
                    const dap = {
                        id: this.nextBreakpoint++,
                        verified: item.addr !== "<PENDING>",
                        line: Number(item.line) || bp.line
                    };
                    if (!dap.verified) dap.message = "Breakpoint has not resolved";
                    updated.set(identity, { number: item.number, dap });
                    results.push(dap);
                } catch (error) {
                    results.push({ verified: false, message: error.message, line: bp.line });
                }
            }
            for (const item of old.values()) await this.mi.command(`-break-delete ${item.number}`);
            this.breakpoints.set(key, updated);
            return { breakpoints: results };
        } finally {
            const interrupted = this.internalStop?.interrupted;
            this.internalStop = null;
            if (resume && interrupted && !this.ended) await this.execute("-exec-continue");
        }
    }
    async execute(command) {
        try {
            return await this.mi.command(command);
        } catch (error) {
            if (/breakpoint|hardware resource/i.test(error.message)) {
                for (const group of this.breakpoints.values())
                    for (const item of group.values()) {
                        item.dap.verified = false;
                        item.dap.message = error.message;
                        this.sendEvent(new Event("breakpoint", { reason: "changed", breakpoint: item.dap }));
                    }
            }
            throw error;
        }
    }
    mapSource(file, reverse = false) {
        const mappings = Object.entries(this.config.sourceFileMap || {}).map(([from, to]) =>
            reverse ? [String(to), from] : [from, String(to)]
        );
        const normalized = String(file).replace(/\\/g, "/");
        mappings.sort((a, b) => b[0].length - a[0].length);
        for (const [from, to] of mappings) {
            const prefix = from.replace(/\\/g, "/").replace(/\/$/, "");
            if (normalized === prefix || normalized.startsWith(prefix + "/"))
                return to.replace(/\\/g, "/") + normalized.slice(prefix.length);
        }
        return reverse || path.isAbsolute(normalized)
            ? normalized
            : path.resolve(this.config.cwd || path.dirname(this.config.executable), normalized);
    }
    remoteSource(file) {
        return this.mapSource(file, true);
    }
    variable(item, displayName) {
        const name = item.name;
        const ref = Number(item.numchild) > 0 ? this.handleFor({ kind: "variable", name }) : 0;
        return {
            name: displayName || item.exp || name,
            value: item.value ?? "",
            type: item.type,
            variablesReference: ref
        };
    }
    async createVariable(expression) {
        const item = await this.mi.command(`-var-create - * ${quote(expression)}`);
        this.varObjects.add(item.name);
        return item;
    }
    async handle(command, args) {
        switch (command) {
            case "initialize":
                return {
                    supportsConfigurationDoneRequest: true,
                    supportsFunctionBreakpoints: true,
                    supportsConditionalBreakpoints: true,
                    supportsSetVariable: true,
                    supportsReadMemoryRequest: true,
                    supportsWriteMemoryRequest: true,
                    supportsRestartRequest: true,
                    supportsTerminateRequest: true
                };
            case "launch":
                return this.launch(args, false);
            case "attach":
                return this.launch(args, true);
            case "configurationDone":
                if (this.config.attach) this.sendEvent(new StoppedEvent("pause", this.thread));
                else await this.enter();
                return {};
            case "setExceptionBreakpoints":
                return {};
            case "setBreakpoints":
                return this.setBreakpoints(args, false);
            case "setFunctionBreakpoints":
                return this.setBreakpoints(args, true);
            case "threads": {
                const result = await this.mi.command("-thread-info");
                return {
                    threads: (result.threads || []).map((t) => ({
                        id: Number(t.id),
                        name: t.name || t["target-id"] || `Thread ${t.id}`
                    }))
                };
            }
            case "stackTrace": {
                this.paused();
                const thread = Number(args.threadId);
                if (!Number.isInteger(thread) || thread < 1) throw new Error("Invalid thread");
                await this.mi.command(`-thread-select ${thread}`);
                const result = await this.mi.command("-stack-list-frames");
                const frames = (result.stack || []).map((entry) => entry.frame || entry);
                return {
                    totalFrames: frames.length,
                    stackFrames: frames
                        .slice(args.startFrame || 0, args.levels ? (args.startFrame || 0) + args.levels : undefined)
                        .map((f) => ({
                            id: this.handleFor({ kind: "frame", thread, level: Number(f.level) }),
                            name: f.func || f.addr,
                            line: Number(f.line) || 0,
                            column: 0,
                            instructionPointerReference: f.addr,
                            source:
                                f.fullname || f.file
                                    ? {
                                          name: path.basename(f.fullname || f.file),
                                          path: this.mapSource(f.fullname || f.file)
                                      }
                                    : undefined
                        }))
                };
            }
            case "scopes":
                this.reference(args.frameId, "frame");
                return {
                    scopes: [
                        {
                            name: "Locals & Arguments",
                            expensive: false,
                            variablesReference: this.handleFor({ kind: "scope", frameId: args.frameId })
                        }
                    ]
                };
            case "variables": {
                const handle = this.reference(args.variablesReference, null);
                let items;
                if (handle.kind === "scope") {
                    await this.selectFrame(handle.frameId);
                    const result = await this.mi.command("-stack-list-variables --simple-values");
                    items = [];
                    for (const local of result.variables || []) {
                        try {
                            items.push({ ...(await this.createVariable(local.name)), exp: local.name });
                        } catch {
                            items.push({
                                ...local,
                                exp: local.name,
                                value: local.value || "<unavailable>",
                                numchild: "0",
                                name: ""
                            });
                        }
                    }
                } else if (handle.kind === "variable") {
                    const result = await this.mi.command(`-var-list-children --all-values ${quote(handle.name)}`);
                    items = (result.children || []).map((c) => c.child || c);
                } else throw new Error("Invalid variable reference");
                const names = new Map();
                const variables = items.map((item) => {
                    names.set(item.exp || item.name, item.name);
                    return this.variable(item);
                });
                this.variablesByName.set(args.variablesReference, names);
                return { variables };
            }
            case "evaluate": {
                this.paused();
                if (args.frameId) await this.selectFrame(args.frameId);
                const item = await this.createVariable(args.expression);
                const variable = this.variable(item);
                return { result: variable.value, type: variable.type, variablesReference: variable.variablesReference };
            }
            case "setVariable": {
                this.reference(args.variablesReference, null);
                const name = this.variablesByName.get(args.variablesReference)?.get(args.name);
                if (!name) throw new Error("Variable is unavailable or has not been expanded");
                const item = await this.mi.command(`-var-assign ${quote(name)} ${quote(args.value)}`);
                await this.mi.command("-var-update --all-values *");
                return { value: item.value, variablesReference: 0 };
            }
            case "readMemory":
            case "writeMemory":
                return this.memory(command, args);
            case "pause":
                await this.interrupt();
                return {};
            case "continue":
            case "next":
            case "stepIn":
            case "stepOut": {
                this.paused();
                await this.clearVariables();
                const operation = { continue: "continue", next: "next", stepIn: "step", stepOut: "finish" }[command];
                await this.execute(`-exec-${operation}`);
                return command === "continue" ? { allThreadsContinued: true } : {};
            }
            case "restart":
                await this.interrupt();
                await this.clearVariables();
                await this.mi.command(`-interpreter-exec console ${quote("monitor reset halt")}`);
                await this.enter();
                return {};
            case "disconnect":
            case "terminate":
                this.disconnecting = true;
                await this.mi.stop();
                return {};
            default:
                throw new Error(`Unsupported debug request: ${command}`);
        }
    }
    async memory(command, args) {
        this.paused();
        if (!/^(?:0x[\da-f]+|\d+)$/i.test(args.memoryReference || "")) throw new Error("Invalid memory address");
        if (!Number.isSafeInteger(args.offset || 0)) throw new Error("Invalid memory offset");
        const address = BigInt(args.memoryReference) + BigInt(args.offset || 0);
        if (address < 0n || address > 0xffffffffn) throw new Error("Memory address outside Cortex-M range");
        const location = `0x${address.toString(16)}`;
        if (command === "readMemory") {
            if (!Number.isInteger(args.count) || args.count < 0 || args.count > 65536)
                throw new Error("Memory read limit is 65536 bytes");
            if (address + BigInt(args.count) > 0x100000000n) throw new Error("Memory range overflow");
            if (!args.count) return { address: location, data: "" };
            const result = await this.mi.command(`-data-read-memory-bytes ${location} ${args.count}`);
            let cursor = address;
            let hex = "";
            for (const block of result.memory || []) {
                if (BigInt(block.begin) !== cursor || !/^(?:[\da-f]{2})*$/i.test(block.contents)) break;
                hex += block.contents;
                cursor += BigInt(block.contents.length / 2);
            }
            const bytes = Buffer.from(hex, "hex").subarray(0, args.count);
            return { address: location, data: bytes.toString("base64"), unreadableBytes: args.count - bytes.length };
        }
        if (
            typeof args.data !== "string" ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)
        )
            throw new Error("Invalid base64 memory data");
        const bytes = Buffer.from(args.data, "base64");
        if (bytes.length > 65536 || address + BigInt(bytes.length) > 0x100000000n)
            throw new Error("Memory write limit exceeded");
        if (bytes.length) await this.mi.command(`-data-write-memory-bytes ${location} ${bytes.toString("hex")}`);
        return { bytesWritten: bytes.length, offset: 0 };
    }
}

module.exports = { EmberDebugSession };
