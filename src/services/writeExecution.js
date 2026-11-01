"use strict";
const path = require("path");
const { isNonHaltingWordWrite, runtimeWriteDisabledError } = require("../writeAccess");
const elfSymbols = require("../elfSymbols");
const { writeUnavailableKey } = require("../webview/runtime");
const { writeConnectionIdentity } = require("../writeAuthorization");
const { FirmwareRecord } = require("./firmwareRecord");
const agentPlans = require("./agentPlans");
const { assertWriteIdentity } = require("../../skills/_emberprobe/probe-connection");
const { CACHE_KEYS } = require("../cacheKeys");

const TARGET_CHANGED_WRITE_MESSAGES = {
    notWritten:
        "The debug target changed state (pause, step or breakpoint) before the write; nothing was written. Retry once it is running again",
    unverified:
        "The debug target changed state (pause, step or breakpoint) during the write; {written}/{total} value(s) were written but not verified. Check the current value before retrying",
    verified:
        "The value was written and read back, but the debug target changed state (pause, step or breakpoint) right after; the result may be stale"
};

// A cancelled runtime write must say whether target memory already changed.
/** @param {"notWritten" | "unverified" | "verified"} state @param {{ writtenItems: number, totalItems: number, results?: object[] }} progress */
function targetChangedWriteError(state, { writtenItems, totalItems, results }) {
    const params = { written: writtenItems, total: totalItems };
    const message = TARGET_CHANGED_WRITE_MESSAGES[state].replace(/\{(\w+)\}/g, (_, key) => String(params[key]));
    return Object.assign(new Error(message), {
        code: "DEBUG_STATE_CHANGED",
        retryable: state === "notWritten",
        i18nKey: `sb.writeTargetChanged.${state}`,
        i18nParams: params,
        details: {
            written: writtenItems > 0,
            writtenItems,
            totalItems,
            verified: state === "verified",
            ...(results && { results })
        }
    });
}

// Variable writes from the sidebar and the Agent: the probe connection a write goes through, firmware and identity
// checks, the plan-bound confirmation grants, and the shared write execution with read-back. host is the
// MainViewProvider.
class WriteExecution {
    /** @param {any} host @param {{ vscode: any }} modules Taken from the provider module. */
    constructor(host, { vscode }) {
        this.host = host;
        this._vscode = vscode;
        // Sidebar writes run one at a time; _uiLatest maps a variable to its newest queued ticket.
        /** @type {Promise<unknown>} */
        this._uiPromise = Promise.resolve();
        this._uiTicket = 0;
        this._uiLatest = new Map();
    }
    // Queues a sidebar write behind the one in flight. A queued value that a newer request for the same variable
    // supersedes is skipped and resolves to null, so releasing a dragged slider does not replay the backlog.
    queueUiWrite(name, value, options) {
        const ticket = ++this._uiTicket;
        this._uiLatest.set(name, ticket);
        const run = this._uiPromise
            .catch(() => {})
            .then(async () => {
                if (this._uiLatest.get(name) !== ticket) return null;
                try {
                    return await this.writeUiVariable(name, value, options);
                } finally {
                    if (this._uiLatest.get(name) === ticket) this._uiLatest.delete(name);
                }
            });
        this._uiPromise = run;
        return run;
    }
    assertSessionCurrent(session) {
        if (session === this.host._debugBridge && this.host._debugBridge.replBusy)
            throw Object.assign(new Error("Wait for the GDB console command before writing"), {
                code: "DEBUG_CONTROL_BUSY"
            });
        const physical =
            session === this.host._debugBridge
                ? this.host.debugLaunch.managedServer || this.host._debugBridge.activeSession
                : session;
        if (!physical) throw Object.assign(new Error("No active write session"), { code: "PROBE_SESSION_MISSING" });
        this.host._probeConnectionService.assertCurrent(physical);
        assertWriteIdentity(physical.options);
    }
    sessionConnection(session) {
        this.assertSessionCurrent(session);
        if (session === this.host._debugBridge) {
            if (
                this.host.debugLaunch.managedServer?.options &&
                !this.host.debugLaunch.managedGroup &&
                !this.host._externalDebug?.active
            )
                return writeConnectionIdentity(this.host.debugLaunch.managedServer.options);
            const active = this.host._debugBridge.activeSession;
            if (!active) this.host._debugBridge.assertUniqueSession();
            return writeConnectionIdentity({
                kind: "dap",
                selectionIdentity: this.host.debugLaunch.managedServer?.options?.selectionIdentity,
                sessionId: active.id,
                workspace: active.workspaceFolder?.uri?.fsPath || "",
                ...(active.configuration?.servertype === "external"
                    ? { stopEpoch: this.host._debugBridge.stopEpoch }
                    : {})
            });
        }
        return writeConnectionIdentity(session.options);
    }
    async prepareConnection() {
        this.assertGroupedReadElf();
        if (this.host._sampling.running && this.host._sampling.session)
            return this.sessionConnection(this.host._sampling.session);
        if (this.host._debugBridge.activeSession && this.host._debugBridge.agentStatus().state === "paused")
            return this.sessionConnection(this.host._debugBridge);
        // A managed debug server remains the connection that will execute an
        // Agent write even while the DAP bridge is between stop events and reports
        // canWrite=false. Bind the confirmation to that server instead of preparing
        // a second standalone OpenOCD identity, which would be rejected at execution.
        if (this.host.debugLaunch.managedServer) return this.sessionConnection(this.host._debugBridge);
        if (this.host._debugBridge.canWrite) return this.sessionConnection(this.host._debugBridge);
        const config = this.host._configurationStore.snapshot();
        const executable = await this.host._resolveOpenOcdPath(config.openocdPath);
        return writeConnectionIdentity(
            await this.host._probeConnectionService.prepare({
                executable,
                probe: config.debugger,
                target: config.mcu,
                sampling: true
            })
        );
    }
    assertGroupedReadElf() {
        if (
            !this.host.debugLaunch.managedGroup &&
            this.host._debugBridge.activeSession?.configuration?.servertype !== "external"
        )
            return;
        const session = this.host._debugBridge.assertUniqueSession();
        const selectedElf = this.host._context.workspaceState.get(CACHE_KEYS.elfPath);
        const sessionElf = session.configuration?.executable;
        const normalize = (file) => {
            if (typeof file !== "string" || !file) return "";
            const resolved = path.resolve(
                session.configuration?.cwd || session.workspaceFolder?.uri?.fsPath || ".",
                file
            );
            return process.platform === "win32" ? resolved.toLowerCase() : resolved;
        };
        if (!selectedElf || !sessionElf || normalize(selectedElf) !== normalize(sessionElf))
            throw Object.assign(new Error("Select the active core's ELF before reading or writing sidebar variables"), {
                code: "DEBUG_ELF_SESSION_MISMATCH"
            });
    }
    async quiesceRuntimeRead() {
        this.assertGroupedReadElf();
        const server = this.host.debugLaunch.managedServer;
        if (!server || server.capabilities?.runtimeRead === false) return;
        server.setSamplingEnabled(false);
        const idle = await server.waitForIdle(2000);
        if (!idle) {
            throw Object.assign(new Error("Timed out waiting for the managed OpenOCD runtime read to finish"), {
                code: "LIVE_READ_QUIESCE_TIMEOUT",
                retryable: true
            });
        }
    }
    // Parses a write request: only scalar symbols and single scalar leaf paths of composites are allowed, and the
    // target address must lie in a writable ELF section (SHF_ALLOC|SHF_WRITE, i.e. .data/.bss), so flash and peripheral
    // registers are never written by mistake.
    // Core of a write inside a session: read before, write, read back and verify. Shared by agent and sidebar UI
    // writes.
    async execute(session, source, plan) {
        const connection = this.sessionConnection(session);
        if (!plan.connection || JSON.stringify(connection) !== JSON.stringify(writeConnectionIdentity(plan.connection)))
            throw Object.assign(new Error("The active connection changed after write confirmation"), {
                code: "WRITE_CONNECTION_CHANGED",
                details: { expected: plan.connection, actual: connection }
            });
        const { elfResult, items } = plan;
        const runtimeWrite = session === this.host.debugLaunch.managedServer;
        const debugSession = runtimeWrite ? this.host._debugBridge.activeSession : null;
        const stopEpoch = runtimeWrite ? this.host._debugBridge.stopEpoch : null;
        if (runtimeWrite) {
            if (!items.every(isNonHaltingWordWrite)) throw runtimeWriteDisabledError();
            const status = this.host._sampling.status();
            if (status.mode !== "debug-running-sampling" || !status.canWrite)
                throw Object.assign(new Error("Runtime writes require an active managed OpenOCD sampling session"), {
                    code: "RUNTIME_WRITE_DISABLED"
                });
            this.assertGroupedReadElf();
            this.host._sampling.runtimeRamPlan(
                items.map((item) => ({ ...item, size: item.bytes.length })),
                true
            );
        }
        let transaction;
        try {
            transaction = await session.writeAndVerify(
                items.map((i) => ({ name: i.name, address: i.address, bytes: i.bytes }))
            );
        } catch (error) {
            if (error?.code !== "LIVE_READ_CANCELLED") throw error;
            const writtenItems = Number(error.details?.writtenItems) || 0;
            throw targetChangedWriteError(writtenItems ? "unverified" : "notWritten", {
                writtenItems,
                totalItems: items.length
            });
        }
        const targetChanged =
            runtimeWrite &&
            (session !== this.host.debugLaunch.managedServer ||
                debugSession !== this.host._debugBridge.activeSession ||
                stopEpoch !== this.host._debugBridge.stopEpoch ||
                this.host._debugBridge.agentStatus().state !== "running");
        const halted = transaction.halted === true;
        const before = new Map(transaction.before.map((s) => [s.name, s]));
        const after = new Map(transaction.after.map((s) => [s.name, s]));
        const results = items.map((i) => {
            const prev = before.get(i.name);
            const post = after.get(i.name);
            const verified =
                !!post?.bytes && post.bytes.length >= i.bytes.length && i.bytes.every((b, k) => post.bytes[k] === b);
            return {
                name: i.requestedName,
                resolvedName: i.name,
                address: `0x${i.address.toString(16).toUpperCase()}`,
                type: i.type,
                previous: prev?.bytes ? elfSymbols.decodeValue(prev.bytes, i.type) : null,
                previousText: prev?.bytes ? elfSymbols.decodeValueText(prev.bytes, i.type) : null,
                written: i.value,
                writtenText: i.valueText,
                readBack: post?.bytes ? elfSymbols.decodeValue(post.bytes, i.type) : null,
                readBackText: post?.bytes ? elfSymbols.decodeValueText(post.bytes, i.type) : null,
                verified,
                ...(!post?.bytes && { readBackError: post?.diagnostic?.message || "no read-back data" })
            };
        });
        // The transaction finished, but its results belong to a target state that no longer exists.
        if (targetChanged)
            throw targetChangedWriteError(results.every((r) => r.verified) ? "verified" : "unverified", {
                writtenItems: items.length,
                totalItems: items.length,
                results
            });
        const unreadable = results.filter((r) => r.readBackError);
        if (unreadable.length) {
            const msg = unreadable
                .map(
                    (r) =>
                        `${this.host._variableDisplayName({ name: r.resolvedName || r.name }, elfResult.symbols)}: ${r.readBackError}`
                )
                .join("; ");
            throw Object.assign(new Error(`The value was written, but reading it back failed: ${msg}`), {
                code: "WRITE_READBACK_FAILED",
                retryable: false,
                i18nKey: "sb.writeReadBackFailed",
                i18nParams: { msg },
                details: { results, targetHaltedDuringWrite: halted }
            });
        }
        if (results.some((r) => !r.verified)) {
            throw Object.assign(
                new Error(
                    halted
                        ? "Write verification failed while the target was halted: the value read back does not match (check RAM accessibility, MPU/cache configuration, and debug transport)"
                        : "Write verification failed: the value read back differs; the running firmware may have modified it right after the write"
                ),
                {
                    code: "WRITE_VERIFY_FAILED",
                    retryable: true,
                    i18nKey: halted ? "sb.writeVerifyFailedHalted" : "sb.writeVerifyFailedRunning",
                    details: { results, targetHaltedDuringWrite: halted, alignedWordWrites: true }
                }
            );
        }
        return { source, elf: elfResult.elf, results, halted };
    }
    // High-risk operation: the first call returns a chat confirmation request whose one-time ID binds the ELF, address,
    // type and value. The user may authorize just this.host write or remember the authorization for this.host workspace after the
    // first successful write.
    async writeAgentVariables(params) {
        // "false" or 0 must never be read as a request to remember write permission.
        if (params.remember !== undefined && typeof params.remember !== "boolean")
            throw Object.assign(new Error("remember must be a boolean"), { code: "INVALID_PARAMS" });
        await this.host._elfView.prepareLayouts(params.values);
        const plan = agentPlans.writePlan(params.values, () => this.host.readElfSymbols());
        plan.connection = await this.prepareConnection();
        const consistency = this.firmwareConsistency(plan.elfResult);
        // A remembered write permission never applies while the ELF differs from the last
        // EmberProbe-programmed image: the addresses may target different data on the device.
        const authorization = this.host._writeAuthorization.authorize(plan, {
            confirmationId: params.confirmationId,
            remember: params.remember,
            allowTrusted: consistency.firmwareConsistency.status !== "mismatch"
        });
        if (!authorization.authorized) return { ...authorization.response, ...consistency };
        // Use the real DAP bridge for a paused managed debug session. The generic Agent probe
        // helper deliberately wraps paused reads in a read-only session; passing that wrapper to
        // the write path loses the DAP connection identity between confirmation and execution.
        // Sampling may be off, so no snapshot exists yet and canWrite is false: prime one from
        // the write plan itself instead of falling back to a second standalone OpenOCD identity.
        if (this.host._debugBridge.agentStatus().state === "paused") {
            if (!this.host._debugBridge.canWritePaused) await this.host._debugBridge.prepareWriteSnapshot(plan.items);
            const result = await this.execute(this.host._debugBridge, "debug-dap", plan);
            return { ...result, ...consistency, permission: await this.permissionGrant(authorization, plan) };
        }
        if (this.host.debugLaunch.managedServer && this.host._debugBridge.agentStatus().state === "running") {
            const result = await this.execute(this.host.debugLaunch.managedServer, "debug-running-openocd", plan);
            return { ...result, ...consistency, permission: await this.permissionGrant(authorization, plan) };
        }
        const result = await this.host._agentOps.withProbe(
            ({ session, source }) => this.execute(session, source, plan),
            {
                allowPausedDebugRead: true
            }
        );
        return { ...result, ...consistency, permission: await this.permissionGrant(authorization, plan) };
    }
    firmwareConsistency(elfResult) {
        const record = this.host._firmwareRecord || new FirmwareRecord(null);
        const firmwareConsistency = record.check(elfResult?.elf);
        const warning = record.warning(elfResult?.elf);
        return { firmwareConsistency, ...(warning ? { warnings: [warning] } : {}) };
    }
    async permissionGrant(authorization, plan) {
        if (!authorization.remember)
            return { mode: authorization.mode, trusted: this.host._writeAuthorization.isTrusted(plan) };
        try {
            return {
                mode: "workspace",
                ...(await this.host._writeAuthorization.trustWorkspace(plan)),
                remembered: true
            };
        } catch (error) {
            return { mode: "once", trusted: false, remembered: false, warning: error.message };
        }
    }
    // Sidebar write list: the user acts directly in the UI, without WriteAuthorization confirmation, but every safety
    // check of agentPlans.writePlan still applies (known DWARF type, target address inside writable .data/.bss). Writes are
    // only allowed while live sampling runs and reuse its Tcl session. A rebuilt but unflashed ELF moves RAM addresses,
    // and read-back verification reads the same wrong address, so one explicit choice per ELF digest is required before
    // UI writes proceed.
    async _confirmUiFirmware(requestedAt) {
        let elf;
        try {
            elf = this.host.readElfSymbols().elf;
        } catch {
            return; // The write plan reports the ELF error itself.
        }
        const { firmwareConsistency } = this.firmwareConsistency({ elf });
        if (firmwareConsistency.status !== "mismatch" || this.host._uiFirmwareMismatchAck === elf.sha256) return;
        const declined = () =>
            Object.assign(new Error(this.host._t("sb.writeFirmwareMismatchDeclined")), {
                code: "ELF_TARGET_MISMATCH",
                i18nKey: "sb.writeFirmwareMismatchDeclined",
                details: firmwareConsistency
            });
        // Writes queued (e.g. by a slider drag) while the user was declining are not re-prompted.
        const last = this.host._uiFirmwareMismatchDeclined;
        if (last?.sha256 === elf.sha256 && requestedAt <= last.at) throw declined();
        const anyway = this.host._t("sb.writeFirmwareMismatchAnyway");
        const choice = await this._vscode.window.showWarningMessage(
            this.host._t("sb.writeFirmwareMismatch"),
            { modal: true },
            anyway
        );
        if (choice === anyway) {
            this.host._uiFirmwareMismatchAck = elf.sha256;
            return;
        }
        this.host._uiFirmwareMismatchDeclined = { sha256: elf.sha256, at: Date.now() };
        throw declined();
    }
    async writeUiVariable(name, value, options = {}) {
        if (this.host._sampling.closing || this.host._sampling.exitUnconfirmed)
            throw Object.assign(new Error("The previous probe connection has not closed"), {
                code: "PROBE_EXIT_UNCONFIRMED"
            });
        await this._confirmUiFirmware(options.requestedAt ?? Date.now());
        const status = this.host._sampling.status();
        const dapSession = status.canWrite && this.host._debugBridge.canWrite ? this.host._debugBridge : null;
        const runtimeSession =
            status.canWrite && status.mode === "debug-running-sampling" ? this.host.debugLaunch.managedServer : null;
        const session =
            dapSession ||
            runtimeSession ||
            (status.canWrite && this.host._sampling.running ? this.host._sampling.session : null);
        if (!session) {
            const key = writeUnavailableKey(status) || "sb.writeUnavailable";
            throw Object.assign(new Error(this.host._t(key)), { i18nKey: key });
        }
        await this.host._elfView.prepareLayouts([{ name }]);
        const plan = agentPlans.writePlan([{ name, value }], () => this.host.readElfSymbols());
        // The ELF may have been replaced while the mismatch prompt was open.
        if (
            this.firmwareConsistency(plan.elfResult).firmwareConsistency.status === "mismatch" &&
            this.host._uiFirmwareMismatchAck !== plan.elfResult.elf.sha256
        )
            throw Object.assign(new Error(this.host._t("sb.writeFirmwareMismatchDeclined")), {
                code: "ELF_TARGET_MISMATCH",
                i18nKey: "sb.writeFirmwareMismatchDeclined"
            });
        if (!status.haltWrite && !plan.items.every(isNonHaltingWordWrite)) throw runtimeWriteDisabledError();
        plan.connection = this.sessionConnection(session);
        // UI writes are already serialized and the bridge rejects concurrent DAP operations itself;
        // posting a "writing" status here would disable the write controls mid-drag.
        return await this.execute(
            session,
            dapSession ? "debug-dap" : runtimeSession ? "debug-running-openocd" : "active-sampling",
            plan
        );
    }
    async agentPermission(params) {
        const action = String(params?.action || "status");
        if (action === "status") {
            try {
                await this.host._elfService.ready();
                return this.host._writeAuthorization.status({
                    elfResult: this.host.readElfSymbols(),
                    connection: await this.prepareConnection()
                });
            } catch {
                return this.host._writeAuthorization.status();
            }
        }
        if (action === "reset") {
            return this.host._writeAuthorization.reset();
        }
        throw Object.assign(new Error(`Unsupported write permission action: ${action}`), {
            code: "INVALID_PERMISSION_ACTION"
        });
    }
}

module.exports = { WriteExecution };
