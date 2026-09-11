"use strict";

const MIN_DAP_INTERVAL_MS = 250;
const MAX_READ_BYTES = 4096;
const SNAPSHOT_INITIAL_DELAY_MS = 180;
const SNAPSHOT_RETRY_DELAYS_MS = Object.freeze([150, 300, 600, 1000]);
const CONTROL_TIMEOUT_MS = 5000;

function sessionFolderKey(session) {
    return session?.workspaceFolder?.uri?.toString?.() || "";
}

function unwrapResponse(value) {
    return value && typeof value === "object" && value.body && typeof value.body === "object"
        ? value.body
        : value || {};
}

function mergeReadPlan(items, maxBytes = MAX_READ_BYTES) {
    const sorted = (items || [])
        .filter((item) => Number.isFinite(Number(item.address)) && Number(item.size) > 0)
        .map((item) => ({ ...item, address: Number(item.address), size: Number(item.size) }))
        .sort((a, b) => a.address - b.address || a.size - b.size);
    const groups = [];
    for (const item of sorted) {
        const last = groups[groups.length - 1];
        const end = item.address + item.size;
        if (last && item.address <= last.address + last.size && end - last.address <= maxBytes) {
            last.size = Math.max(last.size, end - last.address);
            last.items.push(item);
        } else {
            groups.push({ address: item.address, size: item.size, items: [item] });
        }
    }
    return groups;
}

class DebugSessionBridge {
    constructor(options = {}) {
        this.schedule = options.schedule || setTimeout;
        this.cancel = options.cancel || clearTimeout;
        this.now = options.now || Date.now;
        this.getReadPlan = options.getReadPlan || (() => []);
        this.getIntervalMs = options.getIntervalMs || (() => MIN_DAP_INTERVAL_MS);
        this.onSamples = options.onSamples || (() => {});
        this.onStatus = options.onStatus || (() => {});
        this.onError = options.onError || (() => {});
        this.onTargetState = options.onTargetState || (() => {});
        this.beforePausedRead = options.beforePausedRead || (async () => {});
        this.allSessions = new Map();
        this.sessions = new Map();
        this.intentEnabled = false;
        this.workspaceKey = "";
        this.paused = false;
        this.capabilities = { read: null, write: null, restart: null, functionBreakpoints: null };
        this.stopReason = "";
        this.threadId = null;
        this.stopEpoch = 0;
        this.stateWaiters = new Set();
        this.epoch = 0;
        this.timer = null;
        this.polling = false;
        this.writing = false;
        this.consecutiveErrors = 0;
        this.snapshotPending = false;
        this.snapshotReady = false;
        this.controlTimeoutMs = Number.isFinite(options.controlTimeoutMs)
            ? Math.max(1, Number(options.controlTimeoutMs))
            : CONTROL_TIMEOUT_MS;
        this.controlInFlight = null;
        this.transitionKind = "";
        this.transitionCommand = "";
        this.transitionRequestSeq = null;
    }

    get activeSession() {
        if (this.sessions.size !== 1) return null;
        return this.sessions.values().next().value;
    }

    get hasSession() {
        return this.sessions.size > 0;
    }
    get hasAnySession() {
        return this.allSessions.size > 0;
    }
    get conflict() {
        return this.sessions.size > 1;
    }
    get canRead() {
        return !!(
            this.intentEnabled &&
            this.paused &&
            !this.transitionKind &&
            !this.conflict &&
            this.activeSession &&
            this.capabilities.read
        );
    }
    get canWrite() {
        return !!(this.canRead && this.snapshotReady && this.capabilities.write);
    }

    agentStatus() {
        let state = "none";
        if (this.conflict || (this.allSessions.size && !this.hasSession)) state = "conflict";
        else if (this.hasSession) state = this.paused ? "paused" : "running";
        const session = this.activeSession;
        return {
            state,
            paused: state === "paused",
            reason: this.stopReason,
            threadId: this.threadId,
            epoch: this.stopEpoch,
            session: session
                ? {
                      id: session.id,
                      name: session.name || session.configuration?.name || "Cortex-Debug",
                      workspace: session.workspaceFolder?.uri?.fsPath || sessionFolderKey(session)
                  }
                : null,
            capabilities: { ...this.capabilities }
        };
    }

    assertUniqueSession() {
        if (this.conflict || (this.allSessions.size && !this.hasSession))
            throw Object.assign(new Error("More than one Cortex-Debug session matches this workspace"), {
                code: "DEBUG_SESSION_CONFLICT"
            });
        if (!this.activeSession)
            throw Object.assign(new Error("No Cortex-Debug session is active for this workspace"), {
                code: "DEBUG_SESSION_NOT_ACTIVE"
            });
        return this.activeSession;
    }

    assertPausedAccess(options = {}) {
        this.assertUniqueSession();
        if (!this.paused)
            throw Object.assign(new Error("The Cortex-Debug target must be paused"), { code: "TARGET_NOT_PAUSED" });
        if (this.transitionKind)
            throw Object.assign(new Error("Cortex-Debug execution control is in progress"), {
                code: "DEBUG_STATE_TRANSITION",
                details: { transition: this.transitionKind }
            });
        if (this.capabilities.read !== true)
            throw Object.assign(new Error("Cortex-Debug does not support DAP readMemory"), {
                code: "DEBUG_MEMORY_READ_UNSUPPORTED"
            });
        if (options.write && this.capabilities.write !== true)
            throw Object.assign(new Error("Cortex-Debug does not support DAP writeMemory"), {
                code: "DEBUG_MEMORY_WRITE_UNSUPPORTED"
            });
        return this.activeSession;
    }

    status(extra = {}) {
        let mode = "standalone-sampling";
        let key = this.intentEnabled ? "sb.sampling" : "sb.stopped";
        let source = "openocd";
        if (this.conflict || (this.allSessions.size && !this.hasSession)) {
            mode = "debug-session-conflict";
            key = "live.debugConflict";
            source = "dap";
        } else if (this.hasSession) {
            source = "dap";
            if (!this.paused) {
                mode = "debug-running-waiting";
                key = "live.debugWaiting";
            } else if (!this.intentEnabled) {
                mode = "debug-disabled";
                key = "sb.stopped";
            } else if (this.capabilities.read === false) {
                mode = "debug-paused-unsupported";
                key = "live.dapReadUnsupported";
            } else if (!this.snapshotReady) {
                mode = "debug-paused-reading";
                key = "live.dapReading";
            } else {
                mode = "debug-paused-ready";
                key = "live.dapReady";
            }
        }
        return {
            running: this.intentEnabled,
            mode,
            intentEnabled: this.intentEnabled,
            canRead: this.canRead,
            canWrite: this.canWrite,
            snapshotReady: this.snapshotReady,
            source,
            key,
            ...extra
        };
    }

    setWorkspace(folder) {
        this.workspaceKey = folder?.uri?.toString?.() || folder?.toString?.() || "";
        this._recomputeSessions();
    }

    attach(session) {
        if (!session || session.type !== "cortex-debug") return;
        this.allSessions.set(session.id, session);
        this._recomputeSessions();
    }

    detach(session) {
        if (!session) return;
        this.allSessions.delete(session.id);
        this._recomputeSessions();
    }

    _recomputeSessions() {
        const previous = [...this.sessions.keys()].sort().join("|");
        const matching = [...this.allSessions.entries()].filter(([, session]) => {
            const key = sessionFolderKey(session);
            return !this.workspaceKey || !key || key === this.workspaceKey;
        });
        this.sessions = new Map(matching);
        const current = [...this.sessions.keys()].sort().join("|");
        if (previous !== current) {
            this.paused = false;
            this.capabilities = { read: null, write: null, restart: null, functionBreakpoints: null };
            this.stopReason = "";
            this.threadId = null;
            this.stopEpoch += 1;
            this.snapshotPending = false;
            this.snapshotReady = false;
            this.transitionKind = "";
            this.transitionCommand = "";
            this.transitionRequestSeq = null;
            this._invalidate();
        }
        this.onStatus(this.status());
        this._notifyState();
    }

    setIntent(enabled) {
        const changed = this.intentEnabled !== !!enabled;
        this.intentEnabled = !!enabled;
        if (changed) {
            this._invalidate();
            this.snapshotReady = false;
            this.snapshotPending = this.intentEnabled && this.paused;
            this.consecutiveErrors = 0;
        }
        this.onStatus(this.status());
        this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
    }

    refreshSnapshot() {
        if (!this.intentEnabled || !this.paused || !this.hasSession || this.conflict) return;
        this._invalidate();
        this.consecutiveErrors = 0;
        this.snapshotReady = false;
        this.snapshotPending = true;
        this.onStatus(this.status());
        this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
    }

    handleRequest(session, message) {
        if (!session || !this.sessions.has(session.id) || message?.type !== "request") return;
        const transitions = {
            next: "step",
            stepIn: "step",
            stepOut: "step",
            restart: "reset",
            pause: "pause",
            continue: "continue",
            disconnect: "terminate",
            terminate: "terminate"
        };
        const transition = transitions[message.command];
        if (!transition) return;
        this.transitionKind = transition;
        this.transitionCommand = message.command;
        this.transitionRequestSeq = Number.isInteger(message.seq) ? message.seq : null;
        this._invalidate();
        this.snapshotPending = false;
        this.snapshotReady = false;
        this.onTargetState({
            state: "transition",
            transition,
            command: message.command,
            epoch: this.stopEpoch,
            session
        });
        this.onStatus(this.status());
    }

    handleMessage(session, message) {
        if (!session || !this.sessions.has(session.id) || !message) return;
        const failedTransition =
            message.type === "response" &&
            message.success === false &&
            this.transitionKind &&
            (message.command === this.transitionCommand ||
                (this.transitionRequestSeq !== null && message.request_seq === this.transitionRequestSeq));
        if (failedTransition) {
            const transition = this.transitionKind;
            this.transitionKind = "";
            this.transitionCommand = "";
            this.transitionRequestSeq = null;
            this._invalidate();
            this.snapshotPending = this.intentEnabled && this.paused;
            this.snapshotReady = false;
            this.onTargetState({
                state: "transition-failed",
                transition,
                command: message.command,
                epoch: this.stopEpoch,
                session
            });
            this.onStatus(this.status());
            this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
            return;
        }
        if (message.type === "response" && message.command === "initialize" && message.success !== false) {
            const body = unwrapResponse(message);
            this.capabilities.read = body.supportsReadMemoryRequest === true;
            this.capabilities.write = body.supportsWriteMemoryRequest === true;
            this.capabilities.restart = body.supportsRestartRequest === true;
            this.capabilities.functionBreakpoints = body.supportsFunctionBreakpoints === true;
            if (this.intentEnabled && this.paused && this.capabilities.read && !this.snapshotReady)
                this.snapshotPending = true;
            this.onStatus(this.status());
            this._notifyState();
            this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
            return;
        }
        if (message.type !== "event") return;
        if (message.event === "stopped") {
            const transition = this.transitionKind;
            this.transitionKind = "";
            this.transitionCommand = "";
            this.transitionRequestSeq = null;
            this.paused = true;
            this.stopReason = String(message.body?.reason || "paused");
            this.threadId = Number.isInteger(message.body?.threadId) ? message.body.threadId : this.threadId;
            this.stopEpoch += 1;
            this.consecutiveErrors = 0;
            this._invalidate();
            this.snapshotReady = false;
            this.snapshotPending = this.intentEnabled;
            this.onTargetState({
                state: "stopped",
                transition,
                epoch: this.stopEpoch,
                reason: this.stopReason,
                session
            });
            this.onStatus(this.status());
            this._notifyState();
            this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
        } else if (message.event === "continued") {
            const transition = this.transitionKind;
            if (transition === "continue") {
                this.transitionKind = "";
                this.transitionCommand = "";
                this.transitionRequestSeq = null;
            }
            this.paused = false;
            this.stopReason = "";
            if (Number.isInteger(message.body?.threadId)) this.threadId = message.body.threadId;
            this.stopEpoch += 1;
            this._invalidate();
            this.snapshotPending = false;
            this.snapshotReady = false;
            this.onTargetState({ state: "continued", transition, epoch: this.stopEpoch, session });
            this.onStatus(this.status());
            this._notifyState();
        } else if (message.event === "terminated" || message.event === "exited") {
            const transition = this.transitionKind;
            this.transitionKind = "";
            this.transitionCommand = "";
            this.transitionRequestSeq = null;
            this.paused = false;
            this.stopReason = message.event;
            this.stopEpoch += 1;
            this._invalidate();
            this.snapshotPending = false;
            this.snapshotReady = false;
            this.onTargetState({ state: message.event, transition, epoch: this.stopEpoch, session });
            this.onStatus(this.status({ mode: "restoring", key: "live.restoring" }));
            this._notifyState();
        }
    }

    _notifyState() {
        const current = this.agentStatus();
        for (const waiter of [...this.stateWaiters]) {
            if (!waiter.predicate(current)) continue;
            this.stateWaiters.delete(waiter);
            this.cancel(waiter.timer);
            waiter.signal?.removeEventListener("abort", waiter.onAbort);
            waiter.resolve(current);
        }
    }

    waitForState(predicate, timeoutMs = CONTROL_TIMEOUT_MS, signal) {
        const current = this.agentStatus();
        if (predicate(current)) return Promise.resolve(current);
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, timer: null, signal, onAbort: null };
            waiter.onAbort = () => {
                this.stateWaiters.delete(waiter);
                this.cancel(waiter.timer);
                reject(Object.assign(new Error("Debug state wait was cancelled"), { code: "DEBUG_CONTROL_CANCELLED" }));
            };
            waiter.timer = this.schedule(() => {
                this.stateWaiters.delete(waiter);
                signal?.removeEventListener("abort", waiter.onAbort);
                reject(
                    Object.assign(new Error("Timed out waiting for Cortex-Debug state change"), {
                        code: "DEBUG_CONTROL_TIMEOUT",
                        details: { status: this.agentStatus() }
                    })
                );
            }, timeoutMs);
            if (signal?.aborted) {
                waiter.onAbort();
                return;
            }
            signal?.addEventListener("abort", waiter.onAbort, { once: true });
            this.stateWaiters.add(waiter);
        });
    }

    _invalidate() {
        this.epoch += 1;
        if (this.timer) this.cancel(this.timer);
        this.timer = null;
    }

    _schedule(delay) {
        if (!this.canRead || !this.snapshotPending || this.snapshotReady || this.polling || this.writing || this.timer)
            return;
        this.timer = this.schedule(
            () => {
                this.timer = null;
                this._poll().catch((error) => this.onError(error));
            },
            Math.max(0, delay)
        );
    }

    async _poll() {
        if (!this.canRead || !this.snapshotPending || this.snapshotReady || this.polling) return;
        const session = this.activeSession;
        const epoch = this.epoch;
        this.polling = true;
        try {
            await this.beforePausedRead();
            if (epoch !== this.epoch || !this.canRead || !this.snapshotPending || this.snapshotReady) return;
            const plan = this.getReadPlan() || [];
            if (!plan.length) {
                this.snapshotPending = false;
                this.onStatus(this.status({ key: "live.needVar" }));
                return;
            }
            const samples = await this.read(plan, session, epoch);
            if (epoch !== this.epoch || !this.canRead || session !== this.activeSession) return;
            this.consecutiveErrors = 0;
            this.snapshotPending = false;
            this.snapshotReady = true;
            this.onSamples(samples, this.now());
            this.onStatus(this.status());
        } catch (error) {
            if (epoch !== this.epoch) return;
            this.consecutiveErrors += 1;
            const retryDelay = SNAPSHOT_RETRY_DELAYS_MS[this.consecutiveErrors - 1];
            if (retryDelay === undefined) {
                this.snapshotPending = false;
                this.snapshotReady = false;
                this.onError(error);
                this.onStatus(this.status({ key: "live.dapFailed", error: true, message: error.message }));
            } else {
                this.snapshotPending = true;
                this.onStatus(this.status({ key: "live.dapRetrying" }));
            }
        } finally {
            this.polling = false;
            const retryDelay = SNAPSHOT_RETRY_DELAYS_MS[this.consecutiveErrors - 1];
            if (this.snapshotPending && !this.snapshotReady)
                this._schedule(retryDelay === undefined ? SNAPSHOT_INITIAL_DELAY_MS : retryDelay);
        }
    }

    async _readBlock(session, address, count) {
        if (
            !Number.isSafeInteger(address) ||
            address < 0 ||
            !Number.isInteger(count) ||
            count < 1 ||
            count > MAX_READ_BYTES
        )
            throw Object.assign(new Error("Invalid DAP memory read range"), { code: "INVALID_MEMORY_RANGE" });
        const result = unwrapResponse(
            await session.customRequest("readMemory", {
                memoryReference: `0x${address.toString(16)}`,
                offset: 0,
                count
            })
        );
        if (
            typeof result.data !== "string" ||
            result.data.length !== Math.ceil(count / 3) * 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.data) ||
            (result.unreadableBytes !== undefined && result.unreadableBytes !== 0)
        )
            throw new Error("DAP readMemory returned invalid or incomplete data");
        const data = Uint8Array.from(Buffer.from(result.data, "base64"));
        if (data.length !== count) throw new Error("DAP readMemory returned a partial block");
        return data;
    }

    async readPausedMemory(address, count) {
        const session = this.assertPausedAccess();
        const epoch = this.stopEpoch;
        const data = await this._readBlock(session, Number(address), Number(count));
        if (session !== this.activeSession || epoch !== this.stopEpoch || !this.paused || this.transitionKind)
            throw Object.assign(new Error("Target changed during memory read"), { code: "DEBUG_STATE_CHANGED" });
        return data;
    }

    async writePausedMemory(address, bytes) {
        const session = this.assertPausedAccess({ write: true });
        const data = Uint8Array.from(bytes || []);
        if (
            !Number.isSafeInteger(Number(address)) ||
            Number(address) < 0 ||
            !data.length ||
            data.length > MAX_READ_BYTES
        )
            throw Object.assign(new Error("Invalid DAP memory write range"), { code: "INVALID_MEMORY_RANGE" });
        const result = unwrapResponse(
            await session.customRequest("writeMemory", {
                memoryReference: `0x${Number(address).toString(16)}`,
                offset: 0,
                data: Buffer.from(data).toString("base64"),
                allowPartial: false
            })
        );
        if (Number.isFinite(result.bytesWritten) && result.bytesWritten !== data.length)
            throw Object.assign(new Error("DAP performed a partial peripheral register write"), {
                code: "PERIPHERAL_WRITE_PARTIAL",
                details: { requested: data.length, written: result.bytesWritten }
            });
        return { bytesWritten: Number.isFinite(result.bytesWritten) ? result.bytesWritten : data.length };
    }

    async _selectThread(requestedThreadId) {
        if (Number.isInteger(requestedThreadId)) return requestedThreadId;
        if (Number.isInteger(this.threadId)) return this.threadId;
        const session = this.assertUniqueSession();
        const result = unwrapResponse(await session.customRequest("threads", {}));
        const threads = arrayThreads(result.threads).filter((thread) => Number.isInteger(thread?.id));
        if (!threads.length)
            throw Object.assign(new Error("Cortex-Debug returned no thread for execution control"), {
                code: "DEBUG_THREAD_NOT_FOUND"
            });
        threads.sort((left, right) => left.id - right.id);
        return threads[0].id;
    }

    async control(action, requestedThreadId) {
        if (this.controlInFlight)
            throw Object.assign(new Error("Another debug control action is still in progress"), {
                code: "DEBUG_CONTROL_BUSY",
                details: { action, activeAction: this.controlInFlight.action }
            });
        const operationToken = { action };
        this.controlInFlight = operationToken;
        try {
            return await this._control(action, requestedThreadId);
        } finally {
            if (this.controlInFlight === operationToken) this.controlInFlight = null;
        }
    }

    async _control(action, requestedThreadId) {
        const session = this.assertUniqueSession();
        const before = this.agentStatus();
        const threadId = await this._selectThread(requestedThreadId);
        const mapping = {
            pause: { command: "pause", paused: false, args: { threadId }, expect: "paused" },
            continue: { command: "continue", paused: true, args: { threadId, singleThread: false }, expect: "running" },
            stepOver: { command: "next", paused: true, args: { threadId, singleThread: false }, expect: "paused" },
            stepIn: { command: "stepIn", paused: true, args: { threadId, singleThread: false }, expect: "paused" },
            stepOut: { command: "stepOut", paused: true, args: { threadId, singleThread: false }, expect: "paused" },
            restart: { command: "restart", paused: null, args: {}, expect: null }
        };
        const operation = mapping[action];
        if (!operation)
            throw Object.assign(new Error(`Unsupported debug control action: ${action}`), {
                code: "DEBUG_ACTION_UNSUPPORTED"
            });
        if (action === "restart" && this.capabilities.restart !== true)
            throw Object.assign(new Error("Cortex-Debug does not advertise restart support"), {
                code: "DEBUG_ACTION_UNSUPPORTED",
                details: { action }
            });
        if (operation.paused === true && !this.paused)
            throw Object.assign(new Error(`${action} requires a paused target`), { code: "TARGET_NOT_PAUSED" });
        if (operation.paused === false && this.paused)
            throw Object.assign(new Error(`${action} requires a running target`), { code: "DEBUG_STATE_INVALID" });
        const startEpoch = this.stopEpoch;
        const stateAbort = new AbortController();
        const stateOutcome = this.waitForState(
            (next) => {
                if (next.state === "none" || next.state === "conflict" || next.session?.id !== session.id) return true;
                if (next.epoch <= startEpoch) return false;
                if (operation.expect) return next.state === operation.expect;
                return next.state === "running" || next.state === "paused";
            },
            this.controlTimeoutMs,
            stateAbort.signal
        ).then(
            (status) => ({ kind: "state", status, error: null }),
            (error) => ({ kind: "stateError", status: null, error })
        );
        // Some Cortex-Debug backends emit the conclusive state event but never settle
        // customRequest(). Observe both concurrently so a confirmed transition is not
        // misreported as BRIDGE_TIMEOUT. The mapped promise also absorbs a late reject.
        const requestOutcome = Promise.resolve()
            .then(() => session.customRequest(operation.command, operation.args))
            .then(
                () => ({ kind: "response", status: null, error: null }),
                (error) => ({ kind: "requestError", status: null, error })
            );
        const first = await Promise.race([stateOutcome, requestOutcome]);
        if (first.kind === "requestError") {
            stateAbort.abort();
            throw first.error || new Error("Cortex-Debug rejected the control request");
        }
        const final = first.kind === "response" ? await stateOutcome : first;
        if (final.kind === "stateError") {
            const stateError = final.error || new Error("Cortex-Debug state wait failed");
            stateError.details = { ...(stateError.details || {}), action, threadId, before };
            throw stateError;
        }
        const status = final.status;
        if (status.state === "conflict")
            throw Object.assign(new Error("Multiple Cortex-Debug sessions match this workspace"), {
                code: "DEBUG_SESSION_CONFLICT",
                details: { action, threadId, before, status }
            });
        if (status.state === "none" || status.session?.id !== session.id)
            throw Object.assign(new Error("Cortex-Debug session ended during execution control"), {
                code: "DEBUG_SESSION_NOT_ACTIVE",
                details: { action, threadId, before, status }
            });
        return { action, threadId, before, status };
    }

    async read(items, session = this.activeSession, expectedEpoch = null) {
        if (!session || this.conflict) throw new Error("No unique Cortex-Debug session is available");
        if (!this.capabilities.read) throw new Error("Cortex-Debug does not support DAP readMemory");
        const samples = [];
        for (const group of mergeReadPlan(items)) {
            if (expectedEpoch !== null && expectedEpoch !== this.epoch)
                throw Object.assign(new Error("DAP memory read was cancelled by a target state change"), {
                    code: "DEBUG_STATE_CHANGED"
                });
            const data = await this._readBlock(session, group.address, group.size);
            if (expectedEpoch !== null && expectedEpoch !== this.epoch)
                throw Object.assign(new Error("DAP memory read was cancelled by a target state change"), {
                    code: "DEBUG_STATE_CHANGED"
                });
            for (const item of group.items) {
                const offset = item.address - group.address;
                const bytes = data.slice(offset, Math.min(data.length, offset + item.size));
                if (bytes.length !== item.size) throw new Error(`DAP partially read ${item.name}`);
                samples.push({ name: item.name, bytes });
            }
        }
        return samples;
    }

    async readPausedItems(items) {
        const session = this.assertPausedAccess();
        const stopEpoch = this.stopEpoch;
        const epoch = this.epoch;
        const samples = await this.read(items, session, epoch);
        if (session !== this.activeSession || !this.paused || this.stopEpoch !== stopEpoch)
            throw Object.assign(new Error("Target state changed during paused DAP memory read"), {
                code: "TARGET_NOT_PAUSED",
                details: { status: this.agentStatus() }
            });
        return samples;
    }

    async writeAndVerify(items) {
        const session = this.activeSession;
        if (!this.canWrite || !session)
            throw new Error("Cortex-Debug target must be paused and support DAP writeMemory");
        this._invalidate();
        const waitDeadline = this.now() + 2000;
        while (this.polling && this.canWrite && this.now() < waitDeadline)
            await new Promise((resolve) => this.schedule(resolve, 5));
        if (this.polling) throw new Error("A DAP memory read is still in progress; write was not started");
        if (!this.canWrite || session !== this.activeSession)
            throw new Error("Target continued before the DAP write could start");
        this.writing = true;
        this._invalidate();
        const epoch = this.epoch;
        const plan = items.map((item) => ({ ...item, size: item.bytes.length }));
        try {
            const before = await this.read(plan, session);
            for (const item of items) {
                if (epoch !== this.epoch || !this.canWrite)
                    throw new Error("Target continued while a DAP write was in progress");
                const address = Number(item.address);
                const alignedStart = Math.floor(address / 4) * 4;
                const alignedEnd = Math.ceil((address + item.bytes.length) / 4) * 4;
                const alignedBytes = await this._readBlock(session, alignedStart, alignedEnd - alignedStart);
                if (epoch !== this.epoch || session !== this.activeSession || !this.canWrite)
                    throw new Error("Target state changed before the DAP write could start");
                if (alignedBytes.length !== alignedEnd - alignedStart)
                    throw new Error(`DAP could not read adjacent bytes before writing ${item.name}`);
                alignedBytes.set(item.bytes, address - alignedStart);
                const result = unwrapResponse(
                    await session.customRequest("writeMemory", {
                        memoryReference: `0x${alignedStart.toString(16)}`,
                        offset: 0,
                        data: Buffer.from(alignedBytes).toString("base64"),
                        allowPartial: false
                    })
                );
                if (Number.isFinite(result.bytesWritten) && result.bytesWritten !== alignedBytes.length) {
                    throw new Error(`DAP partially wrote ${item.name}`);
                }
            }
            if (epoch !== this.epoch || !this.canWrite)
                throw new Error("Target continued before DAP write verification");
            const after = await this.read(plan, session);
            if (epoch === this.epoch && this.paused) {
                this.snapshotReady = true;
                this.snapshotPending = false;
                this.onSamples(after, this.now());
                this.onStatus(this.status());
            }
            return { before, after };
        } finally {
            this.writing = false;
        }
    }

    dispose() {
        this._invalidate();
        for (const waiter of this.stateWaiters) {
            this.cancel(waiter.timer);
            waiter.signal?.removeEventListener("abort", waiter.onAbort);
            waiter.reject(
                Object.assign(new Error("Debug session bridge was disposed"), { code: "DEBUG_SESSION_NOT_ACTIVE" })
            );
        }
        this.stateWaiters.clear();
        this.controlInFlight = null;
        this.allSessions.clear();
        this.sessions.clear();
    }
}

function arrayThreads(value) {
    return Array.isArray(value) ? value : [];
}

module.exports = {
    DebugSessionBridge,
    MIN_DAP_INTERVAL_MS,
    SNAPSHOT_INITIAL_DELAY_MS,
    SNAPSHOT_RETRY_DELAYS_MS,
    CONTROL_TIMEOUT_MS,
    mergeReadPlan,
    unwrapResponse
};
