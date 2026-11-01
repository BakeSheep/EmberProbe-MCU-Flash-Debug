"use strict";
const {
    isSupportedDebugSession,
    normalizeDebugServerOptions,
    resolveRtos,
    startupTrace,
    validateDebugConfiguration
} = require("./debugConfiguration");
const { SharedDebugGroup } = require("./sharedDebugGroup");
const { resolvePrettyPrinting, configuredPrettyPrintingMode } = require("./prettyPrinting");
const { normalizeDebugImages } = require("./debugImages");
const { resolveExternalSettings } = require("./externalDebugService");
const path = require("path");
const { assertWriteIdentity } = require("../../skills/_emberprobe/probe-connection");
const { flashSpeedKhz } = require("../../skills/_emberprobe/openocd-flash");
const { serializeError, toUiError } = require("./errorEnvelope");
const { COMMAND_FAILURE_TITLES } = require("./noticeService");
const { debugReadPlanKey } = require("./liveWatchService");
const { addPeripheralViewerSvd } = require("./peripheralViewerIntegration");
const crypto = require("crypto");
const { DebugLifecycle, DEBUG_STARTUP_TIMEOUT_MS } = require("./debugLifecycle");
const { GdbWarmup } = require("./gdbWarmup");
const { cleanWindowsPath } = require("../validation");
const { CACHE_KEYS } = require("../cacheKeys");

// Debug sessions on the managed probe: the debug and attach commands, the managed OpenOCD debug server, shared debug
// groups, the startup watchdog and its failure cleanup, external GDB attach, the VS Code debug session and adapter
// events, and sampling restored afterwards. host is the MainViewProvider.
class DebugLaunch {
    /**
     * @param {any} host
     * @param {{ vscode: any, ensureDebugTools: Function, findWarmupDebugTools: Function, openocdScripts: any,
     *     OpenOcdDebugController: any, allocateDebugPorts: Function }} modules Taken from the provider module, so
     *     tests can replace them through loadProvider.
     */
    constructor(host, { vscode, ...modules }) {
        this.host = host;
        this._vscode = vscode;
        this._modules = modules;
        this.lifecycle = new DebugLifecycle();
        this.gdbWarmup = new GdbWarmup();
        this.managedServer = null;
        this.managedGroup = null;
        this.managedToken = "";
        this.managedSessionId = "";
        this.runtimeResumeTimer = null;
        this.commandPending = false;
        this.gdbWarmupTimer = null;
        this.terminatedSessionIds = new Set();
        this.sessionReleases = new Map();
    }
    get starting() {
        return this.host._probeCoordinator?.isActive("debugStart") ?? false;
    }
    // Start debugging. startOptions.attach keeps a managed OpenOCD but sends an attach request that only halts,
    // without reset or download, to preserve the current state.
    async start(resource, configuration, interactive = true, startOptions) {
        let probePrepared = false;
        let startAccepted = false;
        let ownsPending = false;
        const cmd = startOptions?.attach ? "mcu-vscode.attachDebug" : "mcu-vscode.debug";
        const warn = (key) => {
            this.host._notices.notify("flash", cmd, { level: "warning", key });
            return false;
        };
        try {
            if (configuration?.servertype === "external")
                throw new Error("Use an explicit F5 external attach configuration");
            this.host._externalDebug?.assertPhysicalAvailable();
            if (this.host._agentOps.readRunning) return warn("msg.agentReadBusy");
            if (this.commandPending || this.starting) return warn("msg.debugBusy");
            this.commandPending = true;
            this.host._postProbeOperationStatus();
            ownsPending = true;
            this._startupCmd = cmd;
            this.startupErrorReported = false;
            this.startupFailureCleanedUp = false;
            const startup = configuration?.performanceTrace ? startupTrace() : null;
            const serverOptions = normalizeDebugServerOptions(configuration || {});
            let elfPath = configuration?.executable || this.host._context.workspaceState.get(CACHE_KEYS.elfPath);
            const debuggerCfg =
                this.host._context.workspaceState.get(CACHE_KEYS.debugger) ||
                (await this.host._probeConnectionService.resolveProbe());
            const mcuCore = this.host._context.workspaceState.get(CACHE_KEYS.mcuCore);
            if (!elfPath || !debuggerCfg || !mcuCore) return warn("msg.configIncomplete");
            // Parsed before taking the probe lease, so an invalid value fails without any startup cleanup. Parsed
            // once, because the OpenOCD arguments and the adapter launch config must see the same value.
            const rtos = resolveRtos(
                configuration,
                this._vscode.workspace.getConfiguration("emberprobe").get("rtos", "")
            );
            elfPath = cleanWindowsPath(elfPath);
            const { folder: workspaceFolder } = this.host._commandContext(resource);
            if (!workspaceFolder) return warn("msg.openWorkspaceForDebug");
            let cortexTools = await this._modules.ensureDebugTools(
                this._vscode,
                workspaceFolder,
                this.host._context.workspaceState,
                (key) => this.host._t(key),
                undefined,
                configuration || {}
            );
            // The user dismissed the toolchain prompt: a cancellation, not a failure.
            if (!cortexTools) return null;
            startup?.phase("tools");
            // Finish a cold start before holding the probe. Background preparation normally already
            // completed; overlap any remainder with OpenOCD/SVD resolution, never a second cold GDB.
            const warming = this.gdbWarmup?.warm(cortexTools.gdbPath);
            const ownDebug = this._vscode.workspace.getConfiguration("emberprobe", workspaceFolder.uri);
            const images = normalizeDebugImages(configuration || {}, configuration?.cwd || workspaceFolder.uri.fsPath);
            const pretty = resolvePrettyPrinting(
                configuration || {},
                {
                    enablePrettyPrinting: ownDebug.get("enablePrettyPrinting", true),
                    prettyPrinterPath: ownDebug.get("prettyPrinterPath", ""),
                    prettyPrintingMode: configuredPrettyPrintingMode(ownDebug),
                    prettyPrinterFiles: ownDebug.get("prettyPrinterFiles", [])
                },
                configuration?.cwd || workspaceFolder.uri.fsPath
            );
            // Use the same OpenOCD path as programming, so debugging works when OpenOCD is not on PATH
            const configuredOpenOcdPath =
                serverOptions.serverpath ||
                this._vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const [resolvedSvdPath, openocdPath] = await Promise.all([
                this.host._svdManager.currentPath(workspaceFolder),
                this.host._resolveOpenOcdPath(configuredOpenOcdPath)
            ]);
            if (!openocdPath) return false;
            startup?.phase("openocd");
            await warming;
            startup?.phase("warmup");
            if (this.host._shutdownPromise || this._vscode.workspace.isTrusted === false) return false;
            const svdPath = cleanWindowsPath(resolvedSvdPath);
            this._modules.openocdScripts.resolveOpenOcdLaunch(openocdPath, debuggerCfg, mcuCore);
            if (serverOptions.serverGroup) {
                const grouped = await this.prepareGroupedConfiguration({
                    folder: workspaceFolder,
                    executable: openocdPath,
                    probe: debuggerCfg,
                    target: mcuCore,
                    cfg: this._vscode.workspace.getConfiguration("emberprobe"),
                    interactive,
                    rtos,
                    serverOptions,
                    debugConfig: {
                        ...configuration,
                        ...serverOptions,
                        ...cortexTools,
                        ...pretty,
                        ...images,
                        type: "emberprobe",
                        executable: elfPath,
                        cwd: configuration?.cwd || workspaceFolder.uri.fsPath,
                        runToEntryPoint: configuration?.runToEntryPoint ?? "main",
                        ...(svdPath ? { svdFile: svdPath } : {}),
                        rtos
                    }
                });
                startAccepted = true;
                return addPeripheralViewerSvd(grouped, svdPath);
            }
            await this.prepareProbe(workspaceFolder);
            startup?.phase("prepare");
            probePrepared = true;
            this.startLease = this.host._probeCoordinator.acquire("debugStart");
            const managed = await this.startManagedServer(
                openocdPath,
                debuggerCfg,
                mcuCore,
                this._vscode.workspace.getConfiguration("emberprobe"),
                interactive,
                rtos,
                {
                    ...serverOptions,
                    request: configuration?.request || (startOptions?.attach ? "attach" : "launch")
                },
                startup?.phase
            );
            this.serverLease = this.startLease.transition("debugServer");
            this.managedToken = crypto.randomUUID();
            const debugConfig = addPeripheralViewerSvd(
                {
                    ...configuration,
                    ...serverOptions,
                    type: "emberprobe",
                    name: configuration?.name || this.host._t("msg.debugConfigName"),
                    request: configuration?.request || (startOptions?.attach ? "attach" : "launch"),
                    cwd: configuration?.cwd || workspaceFolder.uri.fsPath,
                    executable: elfPath,
                    gdbTarget: managed.gdbTarget,
                    runToEntryPoint: configuration?.runToEntryPoint ?? "main",
                    __emberprobeManagedToken: this.managedToken
                },
                svdPath
            );
            if (svdPath) debugConfig.svdFile = svdPath;
            // The adapter uses this.host to decide whether it runs RTOS-aware; an explicit empty value must override an
            // old value in launch.json.
            if (rtos) debugConfig.rtos = rtos;
            else delete debugConfig.rtos;
            Object.assign(debugConfig, cortexTools);
            Object.assign(debugConfig, pretty);
            Object.assign(debugConfig, images);
            // A changed image downloads at the sidebar's programming clock (see docs/FLASH-PERFORMANCE.md).
            if (debugConfig.request === "launch" && this.managedServer?.options)
                debugConfig.__emberprobeDownloadSpeedKhz = flashSpeedKhz(this.managedServer.options);
            if (startup)
                debugConfig.__emberprobeStartupTrace = startup.finish(this.gdbWarmup?.snapshot?.(cortexTools.gdbPath));
            const startupGate = this.armStartupWatchdog();
            if (configuration) {
                startAccepted = true;
                return debugConfig;
            }
            const startRequest = Promise.resolve(
                this._vscode.debug.startDebugging(workspaceFolder, debugConfig, { suppressDebugView: true })
            ).then(
                (started) => ({ kind: "result", started }),
                (error) => ({ kind: "error", error })
            );
            const outcome = await Promise.race([startRequest, startupGate]);
            if (outcome.kind === "error") throw outcome.error;
            if (outcome.kind === "timeout" || outcome.kind === "terminated" || outcome.kind === "failed") {
                await this.handleStartupFailure(this.lifecycle.session, this.host._t("msg.debugStartFailed"));
                return false;
            }
            const started = outcome.kind === "ready" ? true : outcome.started;
            startAccepted = started === true;
            if (!started) {
                await this.handleStartupFailure(this.lifecycle.session, this.host._t("msg.debugStartFailed"));
                return false;
            }
            // VS Code may accept the request before GDB has attached. Keep the sidebar pending
            // until both initialized and launch have arrived, terminates, or the bounded watchdog fires.
            if (outcome.kind === "result") {
                const initialized = await startupGate;
                if (initialized.kind !== "ready") {
                    await this.handleStartupFailure(this.lifecycle.session, this.host._t("msg.debugStartFailed"));
                    return false;
                }
            }
            return true;
        } catch (err) {
            this.clearStartupWatchdog();
            console.error("Debug start failed:", err.stack || err.message);
            this.host._notices.notify("flash", cmd, {
                level: "error",
                titleKey: COMMAND_FAILURE_TITLES[cmd],
                error: err
            });
            if (probePrepared) {
                await this.stopManagedServer();
                await this.restoreSampling();
            }
            throw err; // Reported above; callers outside the sidebar still see the failure.
        } finally {
            if (ownsPending) {
                if (this.starting && !this.managedServer) this.startLease?.release();
                if (!startAccepted) this.clearStartupWatchdog();
                this.commandPending = false;
                this.host._postProbeOperationStatus();
            }
        }
    }
    async startManagedServer(
        executable,
        probe,
        target,
        cfg,
        interactive = true,
        rtos = "",
        serverOptions = {},
        phase = undefined
    ) {
        const selection = normalizeDebugServerOptions(serverOptions);
        const connection = await this.host._probeConnectionService.prepare({ executable, probe, target }, interactive);
        phase?.("preflight");
        // Launch downloads firmware through GDB; attach can still inspect an unverified USB attachment.
        if (serverOptions.request !== "attach") assertWriteIdentity(connection);
        let lastError = null;
        const inspect = typeof cfg.inspect === "function" ? cfg.inspect("tclPort") : null;
        const fixedTcl = !!(inspect && (inspect.workspaceValue !== undefined || inspect.globalValue !== undefined));
        for (let attempt = 0; attempt < (fixedTcl ? 1 : 3); attempt++) {
            const fixedPort = fixedTcl ? await this.host._resolveTclPort(cfg) : null;
            const coreCount = selection.numberOfProcessors || 1;
            const allocated = await this._modules.allocateDebugPorts(
                coreCount + (fixedTcl ? 0 : 1),
                fixedTcl ? [fixedPort] : []
            );
            const tclPort = fixedTcl ? fixedPort : allocated.shift();
            const gdbPort = allocated[selection.targetProcessor || 0];
            const server = new this._modules.OpenOcdDebugController(
                this._vscode,
                {
                    ...selection,
                    executable,
                    isolated: true,
                    probe,
                    transport: cfg.get("transport", "auto"),
                    rtos,
                    target,
                    ...connection,
                    port: tclPort,
                    gdbPort,
                    ...(selection.numberOfProcessors ? { gdbPorts: allocated } : {}),
                    mode: "debug",
                    intervalMs: this.host._sampling.intervalMs
                },
                {
                    onConnectionConfirmed: () => {
                        if (this.managedServer === server)
                            void this.host._probeConnectionService.recordSuccess(server.options);
                    },
                    onSample: (samples, t, consumers) => this.host._sampling.handleRawSamples(samples, t, consumers),
                    onSampleGap: () => {
                        if (this.managedServer === server) this.host._sampling.handleSampleGap();
                    },
                    onStatus: (status) => {
                        if (this.managedServer !== server) return;
                        if (status?.key === "live.debugRuntimeSampling") {
                            // Recovery notifications can arrive after GDB paused or sampling was disabled.
                            this.host._postConsumerStatuses(this.host._sampling.status());
                        } else if (status?.key === "live.debugTclDegraded") {
                            this.host._postConsumerStatuses({
                                mode: "debug-running-degraded",
                                key: status.key,
                                source: "openocd",
                                canRead: false,
                                canWrite: false,
                                snapshotReady: false,
                                intentEnabled: this.host._sampling.intent,
                                running: this.host._sampling.intent
                            });
                        }
                    },
                    onError: (message) =>
                        this.host._postLive({
                            type: "liveError",
                            ...toUiError(message)
                        }),
                    onDegraded: (error) =>
                        this.host._postConsumerStatuses(
                            {
                                mode: "debug-running-degraded",
                                key: error?.i18nKey || "live.debugTclDegraded",
                                params: error?.i18nParams,
                                source: "openocd",
                                canRead: false,
                                canWrite: false,
                                snapshotReady: false,
                                message: error?.message,
                                diagnostic: serializeError(error)
                            },
                            true
                        ),
                    onDisconnect: (error) => {
                        if (this.managedGroup && this.managedServer === server)
                            void this.handleSharedServerExit(error).catch((failure) =>
                                this.host._postLive({ type: "liveError", ...toUiError(failure) })
                            );
                        if (this.lifecycle.pending) this.reportStartupFailure(error.message);
                        this.host._postConsumerStatuses(
                            {
                                mode: "debug-server-exited",
                                key: error?.i18nKey || "live.serviceExited",
                                params: error?.i18nParams,
                                source: "none",
                                canRead: false,
                                canWrite: false,
                                snapshotReady: false,
                                message: error?.message,
                                diagnostic: serializeError(error)
                            },
                            true
                        );
                    }
                }
            );
            this.managedServer = server;
            try {
                const info = await server.start();
                phase?.("server");
                return info;
            } catch (error) {
                lastError = error;
                await server.stop();
                if (this.managedServer === server) this.managedServer = null;
                if (fixedTcl || !/address already in use|couldn't bind|bind failed|in use/i.test(error.message || ""))
                    break;
            }
        }
        throw lastError || new Error("Unable to start managed OpenOCD");
    }
    async stopManagedServer() {
        if (this.runtimeResumeTimer) clearTimeout(this.runtimeResumeTimer);
        this.runtimeResumeTimer = null;
        const server = this.managedServer;
        const lease = this.serverLease || this.startLease;
        const group = this.managedGroup;
        if (group) {
            await group.stop();
            this.managedGroup = null;
        }
        if (server && !group) {
            server.setSamplingEnabled?.(false);
            // Keep the process and lease reachable if exit cannot be confirmed.
            await server.stop?.();
        }
        if (this.managedServer === server) {
            this.managedServer = null;
            this.serverLease = null;
            this.managedToken = "";
            this.managedSessionId = "";
            this.host._sampling.resetRuntimeNotices();
        }
        if (!group) lease?.release();
    }
    armStartupWatchdog() {
        return this.lifecycle.arm(DEBUG_STARTUP_TIMEOUT_MS, () => this.recoverStartupTimeout());
    }
    matchesManagedSession(session) {
        if (this.host._externalDebug?.matches(session)) return true;
        if (this.managedGroup) return !!this.managedGroup.match(session);
        return !!(
            session &&
            this.managedToken &&
            session.configuration?.__emberprobeManagedToken === this.managedToken
        );
    }
    async prepareGroupedConfiguration({
        folder,
        executable,
        probe,
        target,
        cfg,
        interactive,
        rtos,
        serverOptions,
        debugConfig
    }) {
        const workspace = folder.uri.toString();
        let group = this.managedGroup;
        const created = !group;
        if (!group) {
            await this.prepareProbe(folder);
            this.startLease = this.host._probeCoordinator.acquire("debugStart");
            try {
                const connection = await this.startManagedServer(executable, probe, target, cfg, interactive, rtos, {
                    ...serverOptions,
                    request: debugConfig.request || "launch"
                });
                this.serverLease = this.startLease.transition("debugServer");
                group = new SharedDebugGroup({
                    id: serverOptions.serverGroup,
                    workspace,
                    controller: this.managedServer,
                    lease: this.serverLease,
                    connection,
                    onFailure: (token, message) =>
                        this.failGroupedCore(token, message).catch((error) =>
                            this.host._postLive({
                                type: "liveError",
                                ...toUiError(error)
                            })
                        )
                });
                this.managedGroup = group;
            } catch (error) {
                await this.stopManagedServer();
                await this.restoreSampling();
                throw error;
            }
        }
        try {
            if (debugConfig.request !== "attach") assertWriteIdentity(group.controller.options);
            this.host._probeConnectionService.assertCurrent(group.controller);
            const member = group.reserve(
                workspace,
                {
                    ...group.controller.options,
                    ...serverOptions,
                    executable,
                    probe,
                    target,
                    transport: cfg.get("transport", "auto"),
                    rtos,
                    targetName: serverOptions.targetName
                },
                debugConfig.request
            );
            return {
                ...debugConfig,
                ...serverOptions,
                gdbTarget: member.connection,
                targetName: member.target,
                __emberprobeManagedToken: member.token
            };
        } catch (error) {
            if (created) {
                await this.stopManagedServer();
                await this.restoreSampling();
            }
            throw error;
        }
    }
    async failGroupedCore(token, message) {
        const group = this.managedGroup;
        const member = group?.members.get(token);
        if (!member || member.failing) return;
        member.failing = true;
        member.lifecycle.clear({ kind: "failed", message });
        this.host._postLive({ type: "liveError", message });
        try {
            if (member.session) {
                let stopTimer;
                try {
                    await Promise.race([
                        this._vscode.debug.stopDebugging(member.session),
                        new Promise((resolve) => {
                            stopTimer = setTimeout(resolve, 2000);
                        })
                    ]);
                } finally {
                    clearTimeout(stopTimer);
                }
                await this.host._debugBridge.waitForState(() => this.terminatedSessionIds.has(member.session.id), 2000);
            }
        } finally {
            // A wedged adapter can hang stopDebugging or time out the terminate wait, and
            // member.failing already blocks any retry. Dropping the member regardless is what
            // frees the group's probe lease; skipping it wedges the probe until window reload.
            await group.release(token);
        }
        await this.closeStoppedGroup(group);
    }
    // A failing core and its session's terminate event can both observe the group stop; they share one teardown
    // so OpenOCD is stopped and sampling restored exactly once, and both resolve only after it finishes.
    closeStoppedGroup(group) {
        if (this._groupClosing?.group === group) return this._groupClosing.promise;
        if (!group.stopped || this.managedGroup !== group) return Promise.resolve();
        const promise = (async () => {
            await this.stopManagedServer();
            await this.restoreSampling();
        })().finally(() => {
            if (this._groupClosing?.promise === promise) this._groupClosing = null;
        });
        this._groupClosing = { group, promise };
        return promise;
    }
    async handleSharedServerExit(error) {
        const group = this.managedGroup;
        if (!group) return;
        await Promise.all([...group.members.keys()].map((token) => this.failGroupedCore(token, error.message)));
    }
    clearStartupWatchdog(outcome) {
        this.lifecycle.clear(outcome);
    }
    markStartupReady(session) {
        this.lifecycle?.markInitialized(session, this.matchesManagedSession(session));
    }
    findManagedSession(session) {
        const managedId = this.managedSessionId;
        const candidates = [
            session,
            this.lifecycle?.session,
            managedId ? this.host._debugBridge?.allSessions?.get(managedId) : null
        ];
        return (
            candidates.find(
                (candidate) =>
                    typeof candidate?.id === "string" &&
                    isSupportedDebugSession(candidate) &&
                    this.matchesManagedSession(candidate) &&
                    (!managedId || candidate.id === managedId)
            ) || null
        );
    }
    async handleStartupFailure(session, message) {
        if (this.host._externalDebug?.active) {
            this.reportStartupFailure(message);
            const externalSession = this.findManagedSession(session);
            if (externalSession) {
                await Promise.race([
                    Promise.resolve(this._vscode.debug.stopDebugging(externalSession)).catch(() => {}),
                    new Promise((resolve) => setTimeout(resolve, 2000))
                ]);
                this.host._debugBridge.detach(externalSession);
            }
            this.clearStartupWatchdog({ kind: "failed" });
            await this.host._externalDebug.finish(externalSession);
            return;
        }
        if (this.startupFailureCleanedUp) return;
        this.startupFailureCleanedUp = true;
        const targetSession = this.findManagedSession(session);
        this.reportStartupFailure(message);
        try {
            if (targetSession) {
                if (targetSession.id) this.terminatedSessionIds?.add(targetSession.id);
                try {
                    await Promise.race([
                        Promise.resolve(this._vscode.debug?.stopDebugging?.(targetSession)).catch(() => false),
                        new Promise((resolve) => setTimeout(() => resolve(false), 2000))
                    ]);
                } catch {
                    /* The adapter may already have exited. */
                }
                this.host._debugBridge?.detach(targetSession);
                this.host._debugReadPlanKey = "";
                this.host._runtimeSampleHold?.reset();
            }
            if (typeof this.stopManagedServer === "function") await this.stopManagedServer();
            if (typeof this.restoreSampling === "function") await this.restoreSampling();
        } finally {
            if (!this.managedServer) {
                if (this.starting) this.startLease?.release();
                this.serverLease?.release();
            }
            this.commandPending = false;
            this.host._postProbeOperationStatus();
        }
    }
    reportStartupFailure(message) {
        if (this.startupErrorReported) return;
        this.startupErrorReported = true;
        const cmd = this._startupCmd || "mcu-vscode.debug";
        this.host._notices.notify("flash", cmd, {
            level: "error",
            titleKey: COMMAND_FAILURE_TITLES[cmd],
            message: message || this.host._t("msg.debugStartFailed")
        });
        this.clearStartupWatchdog({ kind: "failed" });
    }
    async recoverStartupTimeout() {
        const session = this.findManagedSession();
        const timeoutMs = this.lifecycle?.timeoutMs || DEBUG_STARTUP_TIMEOUT_MS;
        this.host._postConsumerStatuses(
            {
                mode: "debug-start-failed",
                key: "live.debugStartTimeout",
                source: "none",
                canRead: false,
                canWrite: false
            },
            true
        );
        const timeoutMessage = this.host._t("msg.debugStartTimeout", { seconds: timeoutMs / 1000 });
        await this.handleStartupFailure(session, timeoutMessage);
    }
    handleTargetState(event) {
        if (!event?.session || !this.managedSessionId || event.session.id !== this.managedSessionId) return;
        if (this.runtimeResumeTimer) clearTimeout(this.runtimeResumeTimer);
        this.runtimeResumeTimer = null;
        const server = this.managedServer;
        if (!server || server.capabilities?.runtimeRead === false) return;
        server.invalidateTarget?.();
        server.setSamplingEnabled(false);
        if (event.state !== "continued") return;
        if (event.transition && !["continue", "repl"].includes(event.transition)) return;
        const epoch = event.epoch;
        this.runtimeResumeTimer = setTimeout(() => {
            this.runtimeResumeTimer = null;
            if (
                !this.managedServer ||
                this.managedServer !== server ||
                this.host._debugBridge.paused ||
                this.host._debugBridge.replBusy ||
                this.host._debugBridge.stopEpoch !== epoch ||
                !this.host._sampling.intent
            )
                return;
            try {
                const allowed = this.host._sampling.configureManagedRuntimeWatch();
                if (!allowed.length) {
                    this.host._postConsumerStatuses({
                        mode: "debug-running-waiting",
                        key: "live.needVar",
                        source: "openocd",
                        canRead: false,
                        canWrite: false,
                        snapshotReady: false
                    });
                    return;
                }
                const enabled = this.host._samplingCoordinator.setRuntimeEnabled(
                    server,
                    this.host._sampling.intent,
                    this.host._debugBridge
                );
                this.host._postConsumerStatuses({
                    mode: enabled ? "debug-running-sampling" : "debug-running-degraded",
                    key: enabled ? "live.debugRuntimeSampling" : "live.debugTclDegraded",
                    source: "openocd",
                    canRead: enabled,
                    canWrite: enabled,
                    snapshotReady: enabled,
                    intentEnabled: true,
                    running: true
                });
            } catch (error) {
                server.setSamplingEnabled(false);
                this.host._postConsumerStatuses(
                    {
                        mode: "debug-running-degraded",
                        key:
                            error.code === "LIVE_READ_BUDGET_EXCEEDED"
                                ? "live.runtimeBudgetExceeded"
                                : "live.runtimeAddressRejected",
                        source: "openocd",
                        canRead: false,
                        canWrite: false,
                        snapshotReady: false,
                        message: error.message
                    },
                    true
                );
            }
        }, 150);
    }
    async externalSettingsChanged() {
        await this.host._externalDebug.releaseIfDisabled();
    }
    async prepareExternal(folder, config) {
        if (!this._vscode.workspace.isTrusted) throw new Error("Debugging requires a trusted workspace");
        const connection = resolveExternalSettings(this._vscode.workspace.getConfiguration("emberprobe", folder.uri));
        if (this.commandPending || this.starting || this.managedServer || this.host._debugBridge.hasAnySession)
            throw Object.assign(new Error("Stop the active debug session before external attach"), {
                code: "PROBE_BUSY"
            });
        if (this.host._connectedProbes.driverSwitching)
            throw Object.assign(new Error("Wait for the driver operation before external attach"), {
                code: "PROBE_DRIVER_BUSY"
            });
        this.commandPending = true;
        this.host._postProbeOperationStatus();
        let reserved = false;
        try {
            const validated = validateDebugConfiguration(
                {
                    ...config,
                    executable: config.executable || this.host._context.workspaceState.get(CACHE_KEYS.elfPath)
                },
                folder
            );
            if (!validated.executable) throw new Error("A valid ELF executable is required");
            const tools = await this._modules.ensureDebugTools(
                this._vscode,
                folder,
                this.host._context.workspaceState,
                (key) => this.host._t(key),
                undefined,
                validated
            );
            if (!tools) return undefined;
            const own = this._vscode.workspace.getConfiguration("emberprobe", folder.uri);
            const pretty = resolvePrettyPrinting(
                validated,
                {
                    enablePrettyPrinting: own.get("enablePrettyPrinting", true),
                    prettyPrintingMode: configuredPrettyPrintingMode(own),
                    prettyPrinterFiles: own.get("prettyPrinterFiles", [])
                },
                validated.cwd || folder.uri.fsPath
            );
            const svd = await this.host._svdManager.currentPath(folder);
            const rtos = resolveRtos(validated, own.get("rtos", ""));
            if (!own.get("experimental.externalGdb.enabled", false))
                throw new Error("External GDB was disabled during startup");
            const stoppedAgent = this.host._agentOps.stopReadIfRunning();
            if (stoppedAgent) await stoppedAgent;
            if (this.host._sampling.inUse) await this.host._sampling.stop({ preserveIntent: true });
            this.host._debugBridge.setWorkspace(folder);
            // Freeze settings read at entry. No probe detection or extra TCP readiness connection.
            const reservation = await this.host._externalDebug.reserve(folder.uri.fsPath, connection);
            reserved = true;
            const result = {
                ...validated,
                ...tools,
                ...pretty,
                cwd: validated.cwd || folder.uri.fsPath,
                gdbTarget: reservation.gdbTarget,
                __emberprobeExternalMode: reservation.mode,
                __emberprobeManagedToken: reservation.token,
                rtos,
                ...(svd ? { svdFile: svd } : {})
            };
            this.armStartupWatchdog();
            return result;
        } catch (error) {
            if (reserved) await this.host._externalDebug.finish();
            throw error;
        } finally {
            this.commandPending = false;
            this.host._postProbeOperationStatus();
        }
    }
    async prepareProbe(folder) {
        this.host._connectedProbes.assertDriverIdle();
        this.host._debugBridge.setWorkspace(folder || this.host._commandContext().folder);
        // A session that ended with an unconfirmed OpenOCD exit leaves its server reachable; retry
        // the stop here so that one slow exit does not block every later debug start.
        if (this.managedServer?.state === "stop-failed" && !this.managedGroup) await this.stopManagedServer();
        if (this.managedServer) {
            throw Object.assign(new Error("The debug probe is owned by an EmberProbe managed debug session"), {
                code: "PROBE_BUSY"
            });
        }
        const agentStopped = this.host._agentOps.stopReadIfRunning();
        if (agentStopped) await agentStopped;
        if (this.host._sampling.inUse) {
            const stopped = this.host._sampling.stop({ preserveIntent: true });
            if (stopped) await stopped;
            this.host._postConsumerStatuses({
                mode: "debug-running-waiting",
                key: "live.debugWaiting",
                source: "dap",
                canRead: false,
                canWrite: false,
                snapshotReady: false
            });
        } else if (this.host._sampling.intent) {
            this.host._postConsumerStatuses({
                mode: "debug-running-waiting",
                key: "live.debugWaiting",
                source: "dap",
                snapshotReady: false
            });
        }
    }
    handleSessionStart(session) {
        if (!session || !isSupportedDebugSession(session)) return;
        if (this.terminatedSessionIds.has(session.id)) return;
        this.host._externalDebug?.bind(session);
        const grouped = this.managedGroup?.bind(session);
        if (this.lifecycle.pending && this.matchesManagedSession(session)) this.lifecycle.session = session;
        this.host._debugReadPlanKey = debugReadPlanKey(this.host._sampling.activeReadPlan());
        // In multi-root workspaces the session belongs to VS Code's actual debug folder, not the folder of the cached
        // ELF.
        this.host._debugBridge.setWorkspace(session.workspaceFolder || this.host._commandContext().folder);
        if (
            session.configuration?.__emberprobeManagedToken &&
            session.configuration.__emberprobeManagedToken === this.managedToken &&
            this.managedServer
        ) {
            this.managedSessionId = session.id;
            this.managedServer.invalidateTarget?.();
            this.managedServer.setSamplingEnabled(false);
        }
        this.host._debugBridge.attach(session);
        if (grouped) {
            this.managedServer.invalidateTarget?.();
            this.managedServer.setSamplingEnabled(false);
        }
        this.host._samplingCoordinator?.setDebugIntent(this.host._debugBridge, this.host._sampling.intent);
    }
    handleAdapterMessage(session, message) {
        void this.host._externalDebug?.message(session, message).catch(console.error);
        if (
            message?.type === "event" &&
            message.event === "emberprobe.firmwareLoaded" &&
            !this.host._externalDebug?.matches(session) &&
            this.matchesManagedSession(session)
        ) {
            const { cwd, executable } = session.configuration || {};
            void this.host._firmwareRecord
                ?.recordDebugLaunch(
                    executable && path.resolve(cwd || "", executable),
                    message.body,
                    this.managedServer?.options
                )
                .catch((error) => console.error("Unable to record debug firmware:", error));
        }
        if (this.managedGroup?.match(session)) {
            this.managedGroup.message(session, message);
            this.host._debugBridge.handleMessage(session, message);
            return;
        }
        const matches = this.matchesManagedSession(session);
        if (message?.type === "response" && ["launch", "attach"].includes(message.command) && matches) {
            if (!message.success) {
                const errorMsg = message.message || message.body?.error?.format;
                if (session.configuration?.servertype === "external") this.clearStartupWatchdog({ kind: "failed" });
                else this.reportStartupFailure(errorMsg);
            } else {
                this.lifecycle?.markLaunchResponse(session, matches, true);
                if (!this.terminatedSessionIds.has(session.id) && session.configuration?.servertype !== "external") {
                    void this.host._probeConnectionService.recordSuccess(this.managedServer?.options);
                }
            }
        }
        if (message?.type === "event" && message.event === "initialized") this.markStartupReady(session);
        this.host._debugBridge.handleMessage(session, message);
    }
    handleAdapterRequest(session, message) {
        void this.host._externalDebug?.request(session, message).catch(console.error);
        this.host._debugBridge.handleRequest(session, message);
    }
    // VS Code clears activeDebugSession only after the terminate event, so a session already torn down here
    // must not keep reporting the probe as busy.
    liveSession() {
        const session = this._vscode.debug.activeDebugSession;
        return session && !this.terminatedSessionIds?.has(session.id) ? session : null;
    }
    // Detaching a session settles the Agent's debug.stop wait before OpenOCD has exited; this.host resolves once the
    // session's probe lease is released, or rejects when the server exit cannot be confirmed.
    sessionReleased(session) {
        return this.sessionReleases?.get(session?.id);
    }
    async handleSessionTerminate(session) {
        if (!session || !isSupportedDebugSession(session)) return;
        if (this.terminatedSessionIds.has(session.id)) return;
        this.terminatedSessionIds.add(session.id);
        const released = this._releaseTerminatedSession(session);
        // A failed release stays recorded so a concurrent debug.stop still reports it.
        this.sessionReleases?.set(session.id, released);
        const restore = await released;
        this.sessionReleases?.delete(session.id);
        if (restore) await this.restoreSampling();
    }
    // Returns whether sampling should be restored after the probe has been released.
    async _releaseTerminatedSession(session) {
        if (this.host._externalDebug?.matches(session)) {
            this.clearStartupWatchdog({ kind: "terminated" });
            this.host._debugBridge.detach(session);
            await this.host._externalDebug.finish(session);
            this.host._sampling.intent = false;
            this.host._debugBridge.setIntent(false);
            return false;
        }
        const group = this.managedGroup;
        const member = group?.match(session);
        if (member) {
            this.host._debugBridge.detach(session);
            await group.release(member.token);
            await this.closeStoppedGroup(group);
            return false;
        }
        if (
            this.lifecycle.pending &&
            (this.lifecycle.session?.id === session.id || this.matchesManagedSession(session))
        ) {
            this.clearStartupWatchdog({ kind: "terminated" });
        }
        const managed = !!this.managedSessionId && session.id === this.managedSessionId;
        this.host._debugBridge.detach(session);
        if (this.host._debugBridge.hasSession) return false;
        this.host._debugReadPlanKey = "";
        this.host._runtimeSampleHold?.reset();
        if (managed) await this.stopManagedServer();
        return true;
    }
    handleAdapterExit(session) {
        if (!session || !isSupportedDebugSession(session)) return;
        const managedStartup =
            this.lifecycle.pending &&
            (this.lifecycle.session?.id === session.id || this.matchesManagedSession(session));
        if (!managedStartup && !this.host._debugBridge.hasAnySession && !this.managedGroup?.match(session)) return;
        return this.handleSessionTerminate(session);
    }
    async restoreSampling() {
        if (this.host._shutdownPromise) return;
        if (this.host._externalDebug?.held) return;
        if (this.managedGroup?.members.size) return;
        if (this.host._debugBridge.hasAnySession) {
            this.host._postConsumerStatuses(this.host._debugBridge.status());
            return;
        }
        if (this.managedServer) await this.stopManagedServer();
        if (!this.host._sampling.intent) {
            this.host._postConsumerStatuses({ mode: "stopped", key: "sb.stopped", source: "none" });
            return;
        }
        this.host._postConsumerStatuses({
            mode: "restoring",
            key: "live.restoring",
            source: "openocd",
            canRead: false,
            canWrite: false
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (!this.host._sampling.intent || this.host._debugBridge.hasAnySession) return;
        try {
            await this.host._sampling.start(undefined, this.host._sampling.intervalMs, "restore");
        } catch (error) {
            this.host._postConsumerStatuses({ mode: "restore-failed", ...toUiError(error), source: "none" }, true);
        }
    }
    // Background GDB start for a workspace that has already chosen firmware; see services/gdbWarmup.js.
    scheduleGdbWarmup(delayMs = 0) {
        if (this.gdbWarmupTimer) clearTimeout(this.gdbWarmupTimer);
        this.gdbWarmupTimer = setTimeout(async () => {
            this.gdbWarmupTimer = null;
            // Workspace settings choose the executable, so an untrusted workspace never runs it.
            if (this.host._shutdownPromise || !this._vscode.workspace.isTrusted) return;
            if (!this.host._context.workspaceState.get(CACHE_KEYS.elfPath)) return;
            const { folder } = this.host._commandContext();
            if (!folder) return;
            try {
                const tools = await this._modules.findWarmupDebugTools(
                    this._vscode,
                    folder,
                    this.host._context.workspaceState
                );
                if (tools && !this.host._shutdownPromise && this._vscode.workspace.isTrusted)
                    void this.gdbWarmup.warm(tools.gdbPath);
            } catch (error) {
                console.error("GDB warm-up skipped:", error);
            }
        }, delayMs);
        this.gdbWarmupTimer.unref?.();
    }
}

module.exports = { DebugLaunch };
