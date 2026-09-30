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
    ThreadEvent,
    Event
} = require("@vscode/debugadapter");
const { MiClient, quote } = require("./mi");
const { DebugVariables } = require("./variables");
const { initializePrettyPrinting } = require("../services/prettyPrinting");

// GDB reports a single thread as a bare tuple rather than a one-element list, so -thread-info can
// yield either shape depending on the build and the number of tasks.
function threadList(result) {
    const threads = result?.threads;
    return Array.isArray(threads) ? threads : threads ? [threads] : [];
}

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
        this.silentVariableOutput = 0;
        this.thread = 1;
        this.threads = new Set();
        this.rtosAware = false;
        this.handles = new Map();
        this.nextHandle = 1;
        this.variablesByName = new Map();
        this.varObjects = new Set();
        this.variableStore = new DebugVariables(this);
        this.breakpoints = new Map();
        this.nextBreakpoint = 1;
        this.entryBreakpoint = null;
        this.queue = Promise.resolve();
        this.internalStop = null;
        this.stopWaiters = new Set();
        this.mi.on("output", (text) => {
            if (!this.silentVariableOutput) this.sendEvent(new OutputEvent(text, "console"));
        });
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
        this.variableStore.reset();
        this.handles.clear();
        this.sendEvent(new TerminatedEvent());
    }
    async close() {
        this.end();
        await this.mi.stop();
    }
    onRecord(record) {
        if (record.kind === "=") return this.onAsyncThreadRecord(record);
        if (record.kind !== "*") return;
        if (record.class === "running") {
            this.running = true;
            this.selectedFrame = undefined;
            this.variableStore.reset();
            this.handles.clear();
            this.variablesByName.clear();
            if (this.ready) this.sendEvent(new ContinuedEvent(this.stopThreadId(), true));
        }
        if (record.class !== "stopped") return;
        this.running = false;
        const stopped = this.confirmThread(record.data["thread-id"]);
        if (stopped) this.thread = stopped;
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
            const event = new StoppedEvent(dapReason, this.stopThreadId());
            Object.assign(event.body, { allThreadsStopped: true });
            this.sendEvent(event);
        }
    }
    // GDB reports RTOS task lifecycle here. =thread-selected is deliberately ignored: it changes
    // when the user browses another task in the call stack, which is not a stop notification.
    onAsyncThreadRecord(record) {
        if (!this.rtosAware) return;
        const id = Number(record.data.id);
        if (!Number.isInteger(id) || id < 1) return;
        if (record.class === "thread-created") {
            if (this.threads.has(id)) return;
            this.threads.add(id);
            if (this.ready) this.sendEvent(new ThreadEvent("started", id));
        } else if (record.class === "thread-exited") this.forgetThread(id);
    }
    confirmThread(id) {
        const thread = Number(id);
        if (!Number.isInteger(thread) || thread < 1) return null;
        this.threads.add(thread);
        return thread;
    }
    forgetThread(id) {
        if (!this.threads.delete(id)) return;
        this.variableStore.invalidateThread(id);
        if (this.selectedFrame?.thread === id) this.selectedFrame = undefined;
        // Dropping the stopped task is what stops a later command from reusing the task GDB last
        // selected while the user was browsing stacks.
        if (this.thread === id) this.thread = null;
        if (this.ready) this.sendEvent(new ThreadEvent("exited", id));
    }
    // GDB is the only source of truth, so every list query reconciles the confirmed set.
    recalibrate(ids) {
        const seen = new Set();
        for (const id of ids) {
            const confirmed = this.confirmThread(id);
            if (confirmed) seen.add(confirmed);
        }
        for (const id of [...this.threads]) if (!seen.has(id)) this.forgetThread(id);
        return seen;
    }
    async syncThreads() {
        return this.recalibrate(threadList(await this.mi.command("-thread-info")).map((thread) => thread.id));
    }
    async seedThreads() {
        const result = await this.mi.command("-thread-info");
        const ids = this.recalibrate(threadList(result).map((thread) => thread.id));
        const current = Number(result["current-thread-id"]);
        this.thread = ids.has(current) ? current : ([...ids].sort((left, right) => left - right)[0] ?? null);
    }
    // A stopped event may name no thread, but it must never name one GDB has not confirmed.
    stopThreadId() {
        return this.threads.has(this.thread) ? this.thread : undefined;
    }
    // Returns the task to pin, or null to keep the unpinned command form used without an RTOS.
    async ensureThread(requested) {
        if (!this.rtosAware) return null;
        const thread = Number(requested);
        if (!Number.isInteger(thread) || thread < 1)
            throw Object.assign(new Error(`A positive integer thread ID is required, got: ${requested}`), {
                code: "DEBUG_THREAD_INVALID"
            });
        // The task may have been created after the client last refreshed its list.
        if (!this.threads.has(thread)) await this.syncThreads();
        if (!this.threads.has(thread))
            throw Object.assign(new Error(`RTOS task ${thread} no longer exists; refresh the call stack and retry`), {
                code: "DEBUG_TASK_EXITED"
            });
        return thread;
    }
    handleFor(value) {
        const id = this.nextHandle++;
        this.handles.set(id, value);
        value.ref ||= id;
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
        const generation = this.variableStore.snapshot(frame);
        await this.mi.command(`-thread-select ${frame.thread}`);
        this.variableStore.check(generation);
        await this.mi.command(`-stack-select-frame ${frame.level}`);
        this.variableStore.check(generation);
        this.selectedFrame = frame;
        return frame;
    }
    async clearVariables() {
        this.variableStore.reset();
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
                this.sendEvent(new StoppedEvent("entry", this.stopThreadId()));
                return;
            }
            // Deliberately unpinned: run-to-entry must resume the whole system, not one task.
            await this.execute("-exec-continue");
        } else this.sendEvent(new StoppedEvent("entry", this.stopThreadId()));
    }
    async launch(args, attach) {
        if (this.ready || this.ended) throw new Error("Debug session has already started or ended");
        if (!args.executable || !fs.statSync(args.executable).isFile())
            throw new Error("A valid ELF executable is required");
        if (!args.gdbPath || !/^127\.0\.0\.1:\d+$/.test(args.gdbTarget || ""))
            throw new Error("Missing managed GDB connection");
        this.config = { ...args, runToEntryPoint: args.runToEntryPoint ?? "main", attach };
        const rtos = typeof args.rtos === "string" ? args.rtos.trim() : "";
        this.rtosAware = rtos !== "" && rtos !== "none";
        this.mi.start(args.gdbPath, args.cwd || path.dirname(args.executable));
        await this.mi.command("-gdb-set mi-async on");
        await this.mi.command("-gdb-set pagination off");
        await initializePrettyPrinting(this.mi, this.config, (message) => this.variableDiagnostic(message));
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
        // Only report task ids GDB has actually confirmed. Without an RTOS that is just thread 1,
        // which keeps the single-thread command stream byte-identical to a non-RTOS session.
        if (this.rtosAware) await this.seedThreads();
        else this.threads.add(1);
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
    // Runs one command with its console text captured instead of forwarded to the client. A counter
    // rather than a flag, so a nested capture cannot unmask the outer one.
    async captureConsole(run) {
        let output = "";
        const listener = (value) => {
            output += value;
        };
        this.mi.on("output", listener);
        this.silentVariableOutput++;
        try {
            await run();
        } finally {
            this.mi.off("output", listener);
            this.silentVariableOutput--;
        }
        return output;
    }
    variableDiagnostic(message) {
        this.sendEvent(new OutputEvent(message, "console"));
    }
    variable(item, displayName) {
        return this.variableStore.present(this.variableStore.register(item), displayName);
    }
    async createVariable(expression, frame) {
        // Pin the varobj to its task and frame so a later -var-list-children / -var-assign cannot
        // follow GDB's selected thread once the user browses a different task in the call stack.
        const context = this.rtosAware && frame ? `--thread ${frame.thread} --frame ${frame.level} ` : "";
        const ownerFrame = frame || this.selectedFrame || { thread: this.thread, level: 0 };
        const generation = this.variableStore.snapshot(ownerFrame);
        const item = await this.mi.command(`-var-create ${context}- * ${quote(expression)}`);
        this.varObjects.add(item.name);
        this.variableStore.check(generation);
        this.variableStore.root(item, ownerFrame);
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
                    supportsDelayedStackTraceLoading: true,
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
                if (this.config.attach) this.sendEvent(new StoppedEvent("pause", this.stopThreadId()));
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
                const threads = threadList(result);
                // The client re-reads the list after every stop, so this is also the point where a
                // task that vanished without a =thread-exited record gets pruned.
                if (this.rtosAware) this.recalibrate(threads.map((t) => t.id));
                return {
                    threads: threads.map((t) => ({
                        id: Number(t.id),
                        name: t.name || t["target-id"] || `Thread ${t.id}`
                    }))
                };
            }
            case "stackTrace": {
                this.paused();
                const thread = Number(args.threadId);
                if (!Number.isInteger(thread) || thread < 1) throw new Error("Invalid thread");
                const start = args.startFrame ?? 0;
                const levels = args.levels || 20;
                if (
                    !Number.isSafeInteger(start) ||
                    start < 0 ||
                    !Number.isSafeInteger(levels) ||
                    levels < 1 ||
                    levels > 1000 ||
                    start + levels > 0x7fffffff
                )
                    throw new Error("Stack paging requires a nonnegative start and levels <= 1000");
                await this.ensureThread(thread);
                await this.mi.command(`-thread-select ${thread}`);
                const result = await this.mi.command(`-stack-list-frames ${start} ${start + levels - 1}`);
                const frames = (result.stack || []).map((entry) => entry.frame || entry);
                return {
                    ...(frames.length < levels ? { totalFrames: start + frames.length } : {}),
                    stackFrames: frames.map((f) => ({
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
            case "variables":
                return this.variableStore.variables(args);
            case "evaluate": {
                this.paused();
                // Without a frame this is a session-level watch, which intentionally evaluates
                // against the task the user last selected in the call stack.
                const frame = args.frameId ? await this.selectFrame(args.frameId) : this.selectedFrame;
                if (frame && !args.frameId) {
                    await this.mi.command(`-thread-select ${frame.thread}`);
                    await this.mi.command(`-stack-select-frame ${frame.level}`);
                }
                const item = await this.createVariable(args.expression, frame);
                await this.variableStore.stl.prepare(this.variableStore.nodes.get(item.name));
                const variable = this.variable(item);
                const { name: _name, value, ...metadata } = variable;
                return { result: value, ...metadata };
            }
            case "setVariable":
                return this.variableStore.setVariable(args);
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
                // --thread is atomic, unlike -thread-select followed by the command, which would act
                // on whatever task the user last browsed. Never combine it with --all.
                const thread = await this.ensureThread(args.threadId);
                await this.clearVariables();
                const operation = { continue: "continue", next: "next", stepIn: "step", stepOut: "finish" }[command];
                await this.execute(`-exec-${operation}${thread === null ? "" : ` --thread ${thread}`}`);
                return command === "continue" ? { allThreadsContinued: true } : {};
            }
            case "restart":
                await this.interrupt();
                await this.clearVariables();
                await this.mi.command(`-interpreter-exec console ${quote("monitor reset halt")}`);
                // A reset destroys every TCB, so the confirmed task list has to be rebuilt.
                if (this.rtosAware) await this.seedThreads();
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
        if (bytes.length) {
            await this.mi.command(`-data-write-memory-bytes ${location} ${bytes.toString("hex")}`);
            await this.clearVariables();
        }
        return { bytesWritten: bytes.length, offset: 0 };
    }
}

module.exports = { EmberDebugSession };
