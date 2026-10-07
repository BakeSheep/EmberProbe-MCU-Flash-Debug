"use strict";

const path = require("path");
const fs = require("fs");
const { performance } = require("perf_hooks");
const { AsyncLocalStorage } = require("async_hooks");
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
const { SymbolDirectory } = require("./symbolDirectory");
const { FreeRtosSnapshot } = require("../services/freeRtosSnapshot");
const { safePath } = require("./stl");
const { normalizeDebugImages, DebugImages } = require("../services/debugImages");
const { normalizeDebugServerOptions } = require("../services/debugConfiguration");
const { initializePrettyPrinting } = require("../services/prettyPrinting");
const { normalizeExternalTarget } = require("../services/externalDebugService");

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
        this.executionEpoch = 0;
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
        this.pendingVarCleanup = [];
        this.varCleanupScheduled = false;
        this.varCleanupRunning = false;
        this.varCleanupWaitingForStop = false;
        this.controlPending = false;
        this.hoverEvaluations = new Map();
        this.variableStore = new DebugVariables(this);
        this.symbolDirectory = new SymbolDirectory(this);
        this.debugImages = new DebugImages(this);
        this.clientCapabilities = {};
        this.breakpoints = new Map();
        this.nextBreakpoint = 1;
        this.entryBreakpoint = null;
        this.queue = Promise.resolve();
        this.requests = [];
        this.pendingRequests = new Set();
        this.activeRequest = null;
        this.requestLoop = false;
        this.requestContext = new AsyncLocalStorage();
        const command = this.mi.command.bind(this.mi);
        this.mi.command = (...args) => {
            const cleanup = args[0] === "-gdb-exit" || (args[0] === "-target-disconnect" && this.disconnecting);
            if (!cleanup) this.checkRequest();
            const task = this.requestContext.getStore();
            if (task) task.miCount++;
            return command(...args);
        };
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
            if (this.config.servertype === "external") {
                void this.close()
                    .catch(() => {})
                    .finally(() => this.shutdown());
                return;
            }
            this.end();
            this.shutdown();
        });
    }
    shutdown() {
        if (this.shuttingDown) return;
        this.shuttingDown = true;
        this.pendingVarCleanup.length = 0;
        const closing = this.config.servertype === "external" ? this.closeExternal() : this.mi.stop();
        void closing.catch(() => {}).finally(() => super.shutdown());
    }
    get threadAware() {
        return this.rtosAware || this.config.servertype === "external";
    }
    closeExternal() {
        if (this.externalClosing) return this.externalClosing;
        this.beginDisconnect();
        this.externalClosing = (async () => {
            try {
                if (!this.mi.closed && this.mi.process) await this.mi.command("-target-disconnect", 2000);
            } catch {
                // Still terminate our GDB, never the external server or its target.
            }
            await this.mi.stop();
            const confirmed = await this.mi.waitForExit();
            if (!confirmed) throw new Error("Local GDB exit could not be confirmed; external probe hold retained");
            this.sendEvent(new Event("emberprobe.externalGdbProcess", { exited: true }));
        })();
        return this.externalClosing;
    }
    dispatchRequest(request) {
        const read =
            ["threads", "stackTrace", "scopes", "variables", "readMemory", "emberprobe.rtosSnapshot"].includes(
                request.command
            ) ||
            (request.command === "evaluate" && request.arguments?.context === "hover");
        const control = ["continue", "next", "stepIn", "stepOut", "restart"].includes(request.command);
        const terminating = ["disconnect", "terminate"].includes(request.command);
        const task = {
            read,
            terminating,
            metadata: request.command === "initialize",
            cancelled: !terminating && request.command !== "initialize" && !!(this.disconnecting || this.ended),
            execute: null,
            miCount: 0
        };
        this.pendingRequests.add(task);
        const queuedAt = performance.now();
        const response = {
            seq: 0,
            type: "response",
            request_seq: request.seq,
            command: request.command,
            success: true
        };
        const execute = () =>
            this.requestContext.run(task, async () => {
                const startedAt = performance.now();
                const epoch = this.executionEpoch;
                try {
                    if (read && request.command !== "threads" && this.running) task.cancelled = true;
                    if (task.cancelled)
                        throw new Error("Debug read cancelled by execution control; refresh after stopping");
                    response.body = await this.handle(request.command, request.arguments || {});
                    if (task.cancelled)
                        throw new Error("Debug read cancelled by execution control; refresh after stopping");
                    this.sendResponse(response);
                    if (["disconnect", "terminate"].includes(request.command)) {
                        this.end();
                        this.shutdown();
                    }
                    if (request.command === "launch" || request.command === "attach")
                        this.sendEvent(new InitializedEvent());
                } catch (error) {
                    const stale = task.cancelled || (read && epoch !== this.executionEpoch);
                    this.sendErrorResponse(response, { id: 1, format: error.message, showUser: !stale });
                    if (!this.disconnecting && ["launch", "attach", "configurationDone"].includes(request.command))
                        await this.close();
                } finally {
                    this.pendingRequests.delete(task);
                    if (this.config.performanceTrace) {
                        const timing = {
                            command: request.command,
                            queueMs: Math.round(startedAt - queuedAt),
                            durationMs: Math.round(performance.now() - startedAt),
                            miCommands: task.miCount,
                            cancelled: task.cancelled
                        };
                        this.sendEvent(
                            new OutputEvent(`[EmberProbe performance] ${JSON.stringify(timing)}\n`, "console")
                        );
                    }
                }
            });
        // Interrupt does not touch frame context and must not wait for an unrelated read.
        if (terminating || (request.command === "pause" && this.running)) {
            if (terminating) this.beginDisconnect();
            const urgent = execute();
            this.queue = Promise.all([this.queue, urgent]).then(() => {});
            return;
        }
        task.execute = execute;
        if (control) {
            let index = this.requests.length;
            while (index > 0 && this.requests[index - 1].read) index--;
            for (let i = index; i < this.requests.length; i++) this.requests[i].cancelled = true;
            this.requests.splice(index, 0, task);
            if (index === 0 && this.activeRequest?.read) this.activeRequest.cancelled = true;
        } else this.requests.push(task);
        if (!this.requestLoop) {
            this.requestLoop = true;
            const loop = Promise.resolve().then(() => this.drainRequests());
            this.queue = Promise.all([this.queue, loop]).then(() => {});
        }
    }
    checkRequest() {
        if (this.disconnecting || this.ended) throw new Error("Debug session ended");
        if ((this.requestContext.getStore() || this.activeRequest)?.cancelled)
            throw new Error("Debug read cancelled by execution control; refresh after stopping");
    }
    beginDisconnect() {
        if (!this.disconnecting) {
            this.disconnecting = true;
            this.executionEpoch++;
            this.pendingVarCleanup.length = 0;
            this.hoverEvaluations.clear();
            this.variableStore.reset();
            this.handles.clear();
        }
        // Capabilities are local metadata. Even a pipelined initialize/disconnect handshake
        // must receive its initialize response; target operations are cancelled immediately.
        for (const task of this.pendingRequests) if (!task.terminating && !task.metadata) task.cancelled = true;
    }
    async drainRequests() {
        try {
            while (this.requests.length) {
                this.activeRequest = this.requests.shift();
                await this.activeRequest.execute();
                this.activeRequest = null;
            }
        } finally {
            this.activeRequest = null;
            this.requestLoop = false;
            this.scheduleVariableCleanup([]);
        }
    }
    end() {
        if (this.ended) return;
        this.beginDisconnect();
        this.ended = true;
        this.pendingVarCleanup.length = 0;
        this.hoverEvaluations.clear();
        this.variableStore.reset();
        this.handles.clear();
        this.sendEvent(new TerminatedEvent());
    }
    async close() {
        this.beginDisconnect();
        if (this.config.servertype === "external") {
            try {
                await this.closeExternal();
            } finally {
                this.end();
            }
            return;
        }
        this.end();
        await this.mi.stop();
    }
    onRecord(record) {
        if (this.disconnecting || this.ended) return;
        if (record.kind === "=") return this.onAsyncThreadRecord(record);
        if (record.kind !== "*") return;
        if (record.class === "running") {
            this.executionEpoch++;
            this.running = true;
            this.selectedFrame = undefined;
            this.hoverEvaluations.clear();
            const names = [...this.varObjects];
            this.varObjects.clear();
            this.scheduleVariableCleanup(names);
            this.variableStore.reset();
            this.handles.clear();
            this.variablesByName.clear();
            if (this.ready) this.sendEvent(new ContinuedEvent(this.stopThreadId(), true));
        }
        if (record.class !== "stopped") return;
        this.executionEpoch++;
        this.running = false;
        if (this.varCleanupWaitingForStop) {
            this.varCleanupWaitingForStop = false;
            this.scheduleVariableCleanup([]);
        }
        this.hoverEvaluations.clear();
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
        if (record.class === "thread-selected") this.selectedFrame = undefined;
        if (!this.threadAware) return;
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
        this.hoverEvaluations.clear();
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
        if (!this.threadAware) return null;
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
        this.checkRequest();
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
        await this.ensureThread(frame.thread);
        this.variableStore.check(generation);
        const sameFrame = this.selectedFrame?.thread === frame.thread && this.selectedFrame?.level === frame.level;
        if (!sameFrame) {
            await this.mi.command(`-thread-select ${frame.thread}`);
            this.variableStore.check(generation);
            await this.mi.command(`-stack-select-frame ${frame.level}`);
            this.variableStore.check(generation);
        }
        this.selectedFrame = frame;
        return frame;
    }
    scheduleVariableCleanup(names) {
        if (this.ended) return;
        this.pendingVarCleanup.push(...names);
        if (!this.pendingVarCleanup.length) return;
        if (this.varCleanupScheduled || this.varCleanupRunning) return;
        this.varCleanupScheduled = true;
        setImmediate(() => {
            this.varCleanupScheduled = false;
            void this.drainVariableCleanup();
        });
    }
    async drainVariableCleanup() {
        if (this.varCleanupRunning || this.ended) return;
        if (this.running || this.controlPending || this.requestLoop) {
            this.varCleanupWaitingForStop = true;
            return;
        }
        this.varCleanupRunning = true;
        try {
            while (this.pendingVarCleanup.length && !this.ended) {
                if (this.running || this.controlPending || this.requestLoop) {
                    this.varCleanupWaitingForStop = true;
                    break;
                }
                const name = this.pendingVarCleanup.shift();
                try {
                    await this.mi.command(`-var-delete ${quote(name)}`);
                } catch {
                    /* GDB can invalidate objects itself. */
                }
                await new Promise((resolve) => setImmediate(resolve));
            }
        } finally {
            this.varCleanupRunning = false;
        }
    }
    async clearVariables({ defer = false } = {}) {
        const names = [...this.varObjects];
        this.variableStore.reset();
        this.varObjects.clear();
        this.handles.clear();
        this.variablesByName.clear();
        this.hoverEvaluations.clear();
        this.selectedFrame = undefined;
        if (defer) {
            this.scheduleVariableCleanup(names);
            return;
        }
        for (const name of names) {
            try {
                await this.mi.command(`-var-delete ${quote(name)}`);
            } catch {
                /* GDB can invalidate objects itself. */
            }
        }
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
        if (args.servertype === "external") this.config = { servertype: "external" };
        if (!args.executable || !fs.statSync(args.executable).isFile())
            throw new Error("A valid ELF executable is required");
        const external = args.servertype === "external";
        if (external) {
            normalizeExternalTarget(args.gdbTarget);
            if (!attach || !["remote", "extended-remote"].includes(args.__emberprobeExternalMode))
                throw new Error("Invalid external GDB attach connection");
        }
        if (!args.gdbPath || (!external && !/^127\.0\.0\.1:\d+$/.test(args.gdbTarget || "")))
            throw new Error("Missing managed GDB connection");
        this.config = {
            ...args,
            ...normalizeDebugServerOptions({ ...args, request: attach ? "attach" : "launch" }, true),
            ...normalizeDebugImages(args, args.cwd || path.dirname(args.executable)),
            runToEntryPoint: args.runToEntryPoint ?? "main",
            attach
        };
        this.symbolDirectory.reset();
        if (this.config.serverGroup || external)
            this.sendEvent(new Event("capabilities", { capabilities: { supportsRestartRequest: false } }));
        const rtos = typeof args.rtos === "string" ? args.rtos.trim() : "";
        this.config.rtos = rtos;
        this.rtosAware = rtos !== "" && rtos !== "none";
        this.mi.start(args.gdbPath, args.cwd || path.dirname(args.executable));
        if (external) this.sendEvent(new Event("emberprobe.externalGdbProcess", { pid: this.mi.process?.pid }));
        await this.mi.command("-gdb-set mi-async on");
        if (external) await this.mi.command("-gdb-set non-stop off");
        await this.mi.command("-gdb-set pagination off");
        await initializePrettyPrinting(this.mi, this.config, (message) => this.variableDiagnostic(message));
        await this.debugImages.symbols();
        await this.mi.command(
            `-target-select ${external ? args.__emberprobeExternalMode : "extended-remote"} ${args.gdbTarget}`
        );
        await this.debugImages.hooks(attach ? "preAttachCommands" : "preLaunchCommands");
        if (!external && attach) {
            await this.mi.command(`-interpreter-exec console ${quote("monitor halt")}`);
        } else if (!external) {
            await this.mi.command(`-interpreter-exec console ${quote("monitor reset halt")}`);
            await this.debugImages.download();
            // Reload the reset vector after downloading a different firmware.
            await this.mi.command(`-interpreter-exec console ${quote("monitor reset halt")}`);
        }
        await this.debugImages.hooks(attach ? "postAttachCommands" : "postLaunchCommands");
        if (external) {
            const threads = threadList(await this.mi.command("-thread-info"));
            if (!threads.length || threads.some((thread) => !["stopped", "running"].includes(thread.state)))
                throw new Error("External GDB did not confirm the target's thread state");
            this.running = threads.some((thread) => thread.state === "running");
            if (this.running) {
                await this.interrupt();
                const stopped = threadList(await this.mi.command("-thread-info"));
                if (!stopped.length || stopped.some((thread) => thread.state !== "stopped"))
                    throw new Error("External GDB target did not stop");
            }
        }
        await this.debugImages.verifyRtosPrimary();
        // Only report task ids GDB has actually confirmed. Without an RTOS that is just thread 1,
        // which keeps the single-thread command stream byte-identical to a non-RTOS session.
        if (this.threadAware) await this.seedThreads();
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
        const requested = args.breakpoints || [];
        const wanted = new Set(
            requested.map((bp) => JSON.stringify([functions ? bp.name : bp.line, bp.condition || ""]))
        );
        const noOp =
            requested.every(
                (bp) =>
                    !bp.hitCondition &&
                    !bp.logMessage &&
                    (functions
                        ? typeof bp.name === "string" && bp.name.length > 0
                        : Number.isInteger(bp.line) && bp.line > 0)
            ) &&
            wanted.size === old.size &&
            [...old.keys()].every((identity) => wanted.has(identity));
        if (noOp)
            return {
                breakpoints: requested.map(
                    (bp) => old.get(JSON.stringify([functions ? bp.name : bp.line, bp.condition || ""]))?.dap
                )
            };
        this.internalStop = resume ? { interrupted: false } : null;
        try {
            if (resume) await this.interrupt();
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
        this.checkRequest();
        const epoch = ++this.executionEpoch;
        const wasRunning = this.running;
        // ^running may arrive before *running. Block stopped reads before the MI write, and
        // never overwrite a fast stop (or a newer running event) when this command settles.
        this.running = true;
        await this.clearVariables({ defer: true });
        try {
            return await this.mi.command(command);
        } catch (error) {
            if (epoch === this.executionEpoch) this.running = wasRunning;
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
        const context = this.threadAware && frame ? `--thread ${frame.thread} --frame ${frame.level} ` : "";
        const ownerFrame = frame || this.selectedFrame || { thread: this.thread, level: 0 };
        const generation = this.variableStore.snapshot(ownerFrame);
        const { result: item, failure } = await this.variableStore.printerOperation(
            `-var-create ${context}- * ${quote(expression)}`,
            generation
        );
        this.varObjects.add(item.name);
        this.variableStore.check(generation);
        this.variableStore.root(item, ownerFrame);
        this.variableStore.nodes.get(item.name).expression = expression;
        if (failure) {
            const node = this.variableStore.nodes.get(item.name);
            await this.variableStore.rawFallback(node, failure, generation);
            Object.assign(item, node.item);
        }
        return item;
    }
    invalidateVariables() {
        this.hoverEvaluations.clear();
        if (this.clientCapabilities.supportsInvalidatedEvent)
            this.sendEvent(new Event("invalidated", { areas: ["stacks", "variables"] }));
    }
    async evaluate(args) {
        this.paused();
        if (typeof args.expression !== "string" || !args.expression.trim() || args.expression.length > 16384)
            throw new Error("Provide a nonempty expression of at most 16384 characters");
        if (args.context === "hover") safePath(args.expression);
        else this.hoverEvaluations.clear();
        const frame = args.frameId ? await this.selectFrame(args.frameId) : this.selectedFrame;
        const expression = args.expression.trim();
        const hoverKey = args.context === "hover" && frame ? `${frame.thread}:${frame.level}:${expression}` : null;
        if (hoverKey) {
            const cached = this.hoverEvaluations.get(hoverKey);
            if (cached) {
                try {
                    const generation = this.variableStore.snapshot(frame);
                    this.variableStore.check(generation);
                    const result = await this.mi.command(`-var-evaluate-expression ${quote(cached.item.name)}`);
                    this.variableStore.check(generation);
                    cached.item.value = result.value ?? cached.item.value;
                    const { name: _name, value, ...metadata } = this.variable(cached.item);
                    return { result: value, ...metadata };
                } catch {
                    this.hoverEvaluations.delete(hoverKey);
                    this.paused();
                    this.checkRequest();
                }
            }
        }
        if (frame && !args.frameId) {
            const generation = this.variableStore.snapshot(frame);
            await this.ensureThread(frame.thread);
            this.variableStore.check(generation);
            if (this.selectedFrame?.thread !== frame.thread || this.selectedFrame?.level !== frame.level) {
                await this.mi.command(`-thread-select ${frame.thread}`);
                this.variableStore.check(generation);
                await this.mi.command(`-stack-select-frame ${frame.level}`);
                this.variableStore.check(generation);
                this.selectedFrame = frame;
            }
        }
        const context = frame ? this.variableStore.stl.context(frame) : undefined;
        if (context && frame) context.frameKey = `${frame.thread}:${frame.level}`;
        const item = await this.createVariable(expression, frame);
        const node = this.variableStore.nodes.get(item.name);
        await this.variableStore.stl.prepare(node, context);
        await this.variableStore.metadata(node, context);
        if (hoverKey && !node.stl && !Number(node.item.numchild) && node.item.dynamic !== "1")
            this.hoverEvaluations.set(hoverKey, node);
        const { name: _name, value, ...metadata } = this.variable(item);
        return { result: value, ...metadata };
    }
    async setExpression(args) {
        if (typeof args.value !== "string" || !args.value.trim()) throw new Error("Provide an expression value");
        await this.evaluate(args);
        // Find the root by its expression: STL preparation may have materialized additional nodes.
        const root = [...this.variableStore.nodes.values()]
            .reverse()
            .find((entry) => entry.expression === args.expression && entry.root === entry);
        if (!root?.item.name || root.readOnly) throw new Error("Expression is read only or unavailable");
        const generation = this.variableStore.snapshot(root.frame);
        const attributes = await this.mi.command(`-var-show-attributes ${quote(root.item.name)}`);
        this.variableStore.check(generation);
        if ((attributes.attr ?? attributes.status) !== "editable") throw new Error("GDB expression is not editable");
        await this.mi.command(`-var-assign ${quote(root.item.name)} ${quote(args.value)}`);
        this.variableStore.check(generation);
        const frame = root.frame;
        await this.clearVariables({ defer: true });
        this.selectedFrame = frame;
        const refreshed = await this.evaluate({ expression: args.expression });
        this.invalidateVariables();
        const { result: value, ...metadata } = refreshed;
        return { value, ...metadata };
    }
    async handle(command, args) {
        switch (command) {
            case "initialize":
                this.clientCapabilities = { ...args };
                return {
                    supportsConfigurationDoneRequest: true,
                    supportsFunctionBreakpoints: true,
                    supportsConditionalBreakpoints: true,
                    supportsSetVariable: true,
                    supportsSetExpression: true,
                    supportsEvaluateForHovers: true,
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
                this.checkRequest();
                const threads = threadList(result);
                // The client re-reads the list after every stop, so this is also the point where a
                // task that vanished without a =thread-exited record gets pruned.
                if (this.threadAware) this.recalibrate(threads.map((t) => t.id));
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
                const generation = this.variableStore.snapshot({ thread });
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
                this.variableStore.check(generation);
                this.selectedFrame = undefined;
                await this.mi.command(`-thread-select ${thread}`);
                this.variableStore.check(generation);
                let result;
                try {
                    result = await this.mi.command(`-stack-list-frames ${start} ${start + levels - 1}`);
                } catch (error) {
                    this.variableStore.check(generation);
                    if (start === 0 || !/^-?stack-list-frames: Not enough frames in stack\.$/.test(error.message))
                        throw error;
                    // A full page does not establish the total depth. GDB errors when the next
                    // page starts past the end; confirm that boundary within a traversal budget.
                    const limit = Math.min(start + 1, 1000);
                    const info = await this.mi.command(`-stack-info-depth ${limit}`);
                    this.variableStore.check(generation);
                    if (!/^\d+$/.test(info.depth || "")) throw error;
                    const depth = Number(info.depth);
                    if (!Number.isSafeInteger(depth) || depth < 0 || depth >= limit || depth > start) throw error;
                    return { stackFrames: [], totalFrames: depth };
                }
                this.variableStore.check(generation);
                const frames = (result.stack || []).map((entry) => entry.frame || entry);
                return {
                    ...(frames.length < levels ? { totalFrames: start + frames.length } : {}),
                    stackFrames: frames.map((f) => ({
                        id: this.handleFor({
                            kind: "frame",
                            thread,
                            level: Number(f.level),
                            file: f.fullname || f.file
                        }),
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
            case "scopes": {
                const frame = this.reference(args.frameId, "frame");
                return {
                    scopes: [
                        ["Locals & Arguments", "locals", false],
                        ["Globals", "globals", true],
                        [`Statics: ${frame.file ? path.basename(frame.file) : "<unknown file>"}`, "statics", true],
                        ["Registers", "registers", false]
                    ].map(([name, scopeKind, expensive]) => ({
                        name,
                        expensive,
                        variablesReference: this.handleFor({ kind: "scope", scopeKind, frame, frameId: args.frameId })
                    }))
                };
            }
            case "variables":
                return this.variableStore.variables(args);
            case "evaluate":
                return this.evaluate(args);
            case "emberprobe.rtosSnapshot":
                return new FreeRtosSnapshot(this).snapshot(args);
            case "setExpression":
                return this.setExpression(args);
            case "setVariable": {
                const result = await this.variableStore.setVariable(args);
                this.invalidateVariables();
                return result;
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
                // --thread is atomic, unlike -thread-select followed by the command, which would act
                // on whatever task the user last browsed. Never combine it with --all.
                const thread = await this.ensureThread(args.threadId);
                this.controlPending = true;
                try {
                    const operation = { continue: "continue", next: "next", stepIn: "step", stepOut: "finish" }[
                        command
                    ];
                    await this.execute(`-exec-${operation}${thread === null ? "" : ` --thread ${thread}`}`);
                } finally {
                    this.controlPending = false;
                    if (!this.running && this.varCleanupWaitingForStop) {
                        this.varCleanupWaitingForStop = false;
                        void this.drainVariableCleanup();
                    }
                }
                return command === "continue" ? { allThreadsContinued: true } : {};
            }
            case "restart":
                if (this.config.servertype === "external") throw new Error("External GDB restart is unsupported");
                if (this.config.serverGroup)
                    throw new Error("Shared serverGroup restart is unsupported; stop all cores before resetting");
                await this.interrupt();
                this.controlPending = true;
                try {
                    await this.clearVariables({ defer: true });
                    await this.debugImages.hooks("preResetCommands");
                    await this.mi.command(`-interpreter-exec console ${quote("monitor reset halt")}`);
                    await this.debugImages.hooks("postResetCommands");
                    // A reset destroys every TCB, so the confirmed task list has to be rebuilt.
                    if (this.rtosAware) await this.seedThreads();
                    await this.enter();
                } finally {
                    this.controlPending = false;
                    if (!this.running && this.varCleanupWaitingForStop) {
                        this.varCleanupWaitingForStop = false;
                        void this.drainVariableCleanup();
                    }
                }
                return {};
            case "disconnect":
            case "terminate":
                this.beginDisconnect();
                if (this.config.servertype === "external") await this.closeExternal();
                else await this.mi.stop();
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
            const generation = this.variableStore.snapshot();
            const result = await this.mi.command(`-data-read-memory-bytes ${location} ${args.count}`);
            this.variableStore.check(generation);
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
            await this.clearVariables({ defer: true });
            this.invalidateVariables();
        }
        return { bytesWritten: bytes.length, offset: 0 };
    }
}

module.exports = { EmberDebugSession };
