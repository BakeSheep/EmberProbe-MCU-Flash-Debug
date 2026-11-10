"use strict";
const elfSymbols = require("../elfSymbols");
const validation = require("../validation");
const { assertAgentSettable } = require("./configurationStore");
const agentPlans = require("./agentPlans");
const { selectPausedDebugReadSession } = require("./liveWatchService");
const { CACHE_KEYS } = require("../cacheKeys");
const { listSymbols } = require("./agentSymbolList");

// What the Agent Bridge routes do on the probe: reads and multi-sample runs on their own short probe session (or the
// running sampling/debug session), sampling control, watch list additions, CSV export, fault reads, CubeMX runs and
// configuration changes. Each probe use goes through withProbe, which arbitrates against UI sampling and debugging.
// host is the MainViewProvider.
class AgentOperations {
    /**
     * @param {any} host
     * @param {{ vscode: any, ManagedOpenOcdSession: any }} modules Taken from the provider module, so tests can replace
     *     them through loadProvider.
     */
    constructor(host, { vscode, ManagedOpenOcdSession }) {
        this.host = host;
        this._vscode = vscode;
        this._ManagedOpenOcdSession = ManagedOpenOcdSession;
        this.readSession = null;
        this.readCancelled = false;
        this._sampleRuns = new Set();
        this._samplingStatus = null;
    }
    get readRunning() {
        return this.host._probeCoordinator?.isActive("agentRead") ?? false;
    }
    executeCubeMx(params) {
        return this._vscode.window.withProgress(
            {
                location: this._vscode.ProgressLocation.Notification,
                title: this.host._t("cubemx.generating"),
                cancellable: true
            },
            async (progress, token) => {
                const controller = new AbortController();
                const subscription = token.onCancellationRequested(() => controller.abort());
                progress.report({ message: this.host._t("cubemx.generating") });
                try {
                    return await this.host._cubemxService.execute(params || {}, controller.signal, (stage) =>
                        progress.report({ message: this.host._t("cubemx." + stage) })
                    );
                } finally {
                    subscription.dispose();
                }
            }
        );
    }
    async setConfiguration(values) {
        // openocdPath could point probe calls at any executable, so the Agent Bridge may not change it; the user
        // changes it in settings or the sidebar
        assertAgentSettable(values);
        const updated = await this.host._configurationStore.update(values);
        if (Object.hasOwn(values || {}, "svd")) {
            const folder = this.host._svdManager.workspaceForElf();
            if (folder) {
                if (updated.svd)
                    await this.host._svdManager.importAndBind(
                        updated.svd,
                        folder,
                        this.host._svdManager.identityFor(folder),
                        {
                            source: "agent-workspace",
                            originalPath: updated.svd
                        }
                    );
                else await this.host._svdManager.library.bind(folder.uri, "");
            }
        }
        return this.host._configurationSnapshot();
    }
    async exportCsv(params) {
        const requestedPanelId = params.panelId === undefined ? null : Number(params.panelId);
        const entry =
            requestedPanelId === null ? this.host._focusedLivePanel() : this.host._livePanels.get(requestedPanelId);
        if (!entry || !entry.ready) {
            throw Object.assign(new Error("Open a Live Watch chart panel before exporting its history"), {
                code: "LIVE_PANEL_NOT_OPEN"
            });
        }
        const names = Array.isArray(params.variables)
            ? Array.from(new Set(params.variables.map((value) => String(value || "").trim()).filter(Boolean)))
            : [];
        const from = params.from === undefined ? undefined : Number(params.from);
        const to = params.to === undefined ? Date.now() : Number(params.to);
        if (
            (from !== undefined && !Number.isFinite(from)) ||
            !Number.isFinite(to) ||
            (from !== undefined && from > to)
        ) {
            throw Object.assign(new Error("CSV export time range is invalid"), { code: "INVALID_CSV_RANGE" });
        }
        const scope = this.host._debugSamplingScope(entry.watchKey);
        const available = this.host._samplingArchive.status(scope).variables;
        if (!available.length) {
            throw Object.assign(new Error("The selected chart has no sampled series"), { code: "CSV_EXPORT_EMPTY" });
        }
        const selected = names.length
            ? names.flatMap((name) =>
                  available.filter((recorded) => recorded === name || recorded.startsWith(`${name} [`))
              )
            : available;
        const missing = names.filter(
            (name) => !available.some((recorded) => recorded === name || recorded.startsWith(`${name} [`))
        );
        if (missing.length) {
            throw Object.assign(new Error(`Chart series not found: ${missing.join(", ")}`), {
                code: "CSV_SERIES_NOT_FOUND",
                details: { missing }
            });
        }
        const result = await this.host._samplingArchive.readCsv({
            scope,
            names: [...new Set(selected)],
            fromMs: from,
            toMs: to
        });
        return {
            panelId: entry.panelId,
            names: [...new Set(selected)],
            from: result.firstValueTimestampMs,
            to: result.lastValueTimestampMs,
            seriesCount: result.seriesCount,
            rowCount: result.rows,
            // The archive stops recording once it hits its size cap while the chart keeps drawing, so
            // an Agent must be told the CSV covers less than the session it asked about.
            historyTruncated: result.limitReached === true,
            csv: result.csv
        };
    }
    // The lists watch.add edits: the sidebar and the focused chart panel, which sampling_control start reads.
    listWatch() {
        let symbols = null;
        try {
            symbols = this.host.readElfSymbols().symbols;
        } catch {
            // Stored names are reported even while the ELF is unavailable.
        }
        const describe = (key) =>
            this.host._scalarWatchList(key).map((item) => {
                const displayName = this.host._variableDisplayName(item, symbols);
                return {
                    name: item.name,
                    ...(displayName && displayName !== item.name ? { displayName } : {}),
                    type: item.type || ""
                };
            });
        const panel = this.host._focusedLivePanel();
        return {
            sidebar: describe(CACHE_KEYS.sidebarWatchList),
            chart: { panelId: panel?.panelId ?? null, variables: describe(panel?.watchKey || CACHE_KEYS.watchList) }
        };
    }
    // Removes stored entries by raw name, display name or a composite prefix (sensor removes sensor.x, sensor[0]).
    // Sampling plans refresh through _saveWatchList; recorded chart history is kept.
    async removeWatch(params) {
        const names = Array.isArray(params?.variables) ? params.variables.map((name) => String(name).trim()) : [];
        if (!names.length || names.some((name) => !name))
            throw Object.assign(new Error("No variables supplied"), { code: "NO_VARIABLES" });
        const destination = params.destination || "sidebar";
        if (!["sidebar", "chart", "both"].includes(destination))
            throw Object.assign(new Error("destination must be sidebar, chart, or both"), {
                code: "INVALID_DESTINATION"
            });
        let resolveSymbol = null;
        try {
            resolveSymbol = elfSymbols.createSymbolResolver(this.host.readElfSymbols().symbols);
        } catch {
            // Without ELF metadata only stored names match.
        }
        // A display or file-qualified name (ep7, main.c::cfg) maps to the raw identity the list stores.
        const rawName = (name) => {
            try {
                const parsed = elfSymbols.parseMemberPath(name);
                const base = parsed ? parsed.base : name;
                return resolveSymbol ? resolveSymbol(base, name).name + name.slice(base.length) : null;
            } catch {
                return null;
            }
        };
        const covers = (stored, name) =>
            stored === name || stored.startsWith(`${name}.`) || stored.startsWith(`${name}[`);
        const results = {};
        const removeFrom = async (key, target) => {
            const current = this.host._scalarWatchList(key);
            const removed = new Set();
            const notFound = [];
            for (const name of names) {
                let hits = current.filter((item) => covers(item.name, name));
                const raw = hits.length ? null : rawName(name);
                if (raw) hits = current.filter((item) => covers(item.name, raw));
                if (!hits.length) notFound.push(name);
                for (const item of hits) removed.add(item.name);
            }
            if (removed.size)
                await this.host._saveWatchList(
                    key,
                    current.filter((item) => !removed.has(item.name))
                );
            results[target] = { removed: [...removed], notFound };
        };
        const chartKey = this.host._focusedLivePanel()?.watchKey || CACHE_KEYS.watchList;
        if (destination === "sidebar" || destination === "both")
            await removeFrom(CACHE_KEYS.sidebarWatchList, "sidebar");
        if (destination === "chart" || destination === "both") await removeFrom(chartKey, "chart");
        return results;
    }
    listVariables(params) {
        return listSymbols(this.host.readElfSymbols(), params || {});
    }
    async addWatch(params) {
        const names = Array.isArray(params.variables) ? params.variables.map(String) : [];
        if (!names.length) throw Object.assign(new Error("No variables supplied"), { code: "NO_VARIABLES" });
        const destination = params.destination || "sidebar";
        if (!["sidebar", "chart", "both"].includes(destination))
            throw Object.assign(new Error("destination must be sidebar, chart, or both"), {
                code: "INVALID_DESTINATION"
            });
        await this.host._elfView.prepareLayouts(names);
        const resolveSymbol = elfSymbols.createSymbolResolver(this.host.readElfSymbols().symbols);
        const resolved = [];
        const resolvedNames = new Set();
        // Requested base name -> raw ELF name, for requests that matched a display name.
        const aliases = {};
        const appendResolved = (item) => {
            if (!resolvedNames.has(item.name)) {
                resolvedNames.add(item.name);
                resolved.push(item);
            }
        };
        for (const rawName of names) {
            // Supports path syntax: sensor.x, buf[0], buf[1:5]
            const parsed = elfSymbols.parseMemberPath(rawName);
            const baseName = parsed ? parsed.base : rawName;
            // A bare name defined in several compilation units throws VARIABLE_AMBIGUOUS; the first match is never
            // added to the watch list.
            const symbol = resolveSymbol(baseName, rawName);
            if (symbol.name !== baseName) aliases[baseName] = symbol.name;
            // Watch lists persist raw ELF identities; normalizeWatchList does not resolve
            // display names, so a requested `ep7` must be stored as `_ZL3ep7`.
            const rawPath = parsed ? symbol.name + rawName.trim().slice(baseName.length) : symbol.name;
            const expanded = elfSymbols.expandedStaticLeaves(symbol, parsed);
            if (expanded.length) {
                for (const leaf of expanded) appendResolved({ ...leaf, name: leaf.path });
                continue;
            }
            const runtime = require("./runtimeWatch").runtimeWatchEntry(rawPath, symbol, parsed?.segments || []);
            if (runtime) {
                appendResolved(runtime);
                continue;
            }
            if (require("../webview/runtime").requiresRuntimePath(symbol, parsed?.segments || []))
                throw Object.assign(new Error(`Invalid runtime member path: ${rawName}`), {
                    code: "INVALID_VARIABLE_PATH"
                });
            if (symbol.isComposite) {
                if (!symbol.compositeLayout)
                    throw Object.assign(new Error(`Composite variable has no DWARF layout: ${rawName}`), {
                        code: "UNSUPPORTED_VARIABLE"
                    });
                if (parsed && parsed.segments.length) {
                    const leaves = elfSymbols.expandCompositeLeaves(symbol, symbol.compositeLayout, parsed);
                    if (!leaves.length)
                        throw Object.assign(new Error(`Invalid composite member path: ${rawName}`), {
                            code: "INVALID_VARIABLE_PATH"
                        });
                    for (const leaf of leaves) {
                        appendResolved({
                            name: leaf.path,
                            address: leaf.address,
                            size: leaf.size,
                            type: leaf.type,
                            ...(Number.isInteger(leaf.bitSize)
                                ? { bitSize: leaf.bitSize, bitOffset: leaf.bitOffset }
                                : {})
                        });
                    }
                } else {
                    appendResolved({
                        name: symbol.name,
                        address: symbol.address,
                        size: symbol.size,
                        type: "",
                        isComposite: true,
                        compositeLayout: symbol.compositeLayout
                    });
                }
            } else {
                if (!symbol.watchType)
                    throw Object.assign(new Error(`Variable is not a supported scalar: ${rawName}`), {
                        code: "UNSUPPORTED_VARIABLE"
                    });
                appendResolved({
                    name: symbol.name,
                    address: symbol.address,
                    size: symbol.size,
                    type: params.types?.[baseName] || symbol.watchType
                });
            }
        }
        // `added` and `alreadyPresent` report the stored raw identities; `resolvedNames`
        // maps each display-name request back to the raw name it was saved under.
        const results = Object.keys(aliases).length ? { resolvedNames: aliases } : {};
        const addTo = async (key, target) => {
            const current = this.host._scalarWatchList(key);
            const existing = new Set(current.map((item) => item.name));
            const added = resolved.filter((item) => !existing.has(item.name));
            await this.host._saveWatchList(key, current.concat(added));
            results[target] = {
                added: added.map((item) => item.name),
                alreadyPresent: resolved.filter((item) => existing.has(item.name)).map((item) => item.name)
            };
        };
        const focusedPanel = this.host._focusedLivePanel();
        const chartKey = focusedPanel?.watchKey || CACHE_KEYS.watchList;
        if (destination === "sidebar" || destination === "both") await addTo(CACHE_KEYS.sidebarWatchList, "sidebar");
        if (destination === "chart" || destination === "both") await addTo(chartKey, "chart");
        return results;
    }
    // Plans each item separately: a resolution or layout failure of one variable goes to variableErrors without
    // affecting the rest of the batch. If all fail, the first error is thrown (keeping the error code of a
    // single-variable request), with details.variableErrors when several failed.
    _postSampling(running, key, params) {
        this._samplingStatus = running ? { running, key, params, agentOwned: true } : null;
        this.host._postLive({ type: "liveStatus", running, key, params, agentOwned: running });
    }
    // Each wait owns its timer: reads sharing a live or debug connection run concurrently, and a
    // shared timer let one wait clear another's, leaving that sample loop pending forever.
    // `run` is the sample loop's entry in _agentSampleRuns; cancelling the run ends its wait early.
    _waitInterval(intervalMs, run = null) {
        return new Promise((resolve) => {
            let timer = null;
            const finish = () => {
                clearTimeout(timer);
                if (run?.wake === finish) run.wake = null;
                resolve(undefined);
            };
            if (run) run.wake = finish;
            timer = setTimeout(finish, intervalMs);
        });
    }
    _wakeReadDelays() {
        for (const run of [...(this._sampleRuns || [])]) if (run.temporary) run.wake?.();
    }
    // sampling.stop must also end samples on a connection the Agent read borrows (live sampling or a
    // running/paused debug server), not only its own temporary probe session.
    _cancelSharedSamples() {
        for (const run of [...(this._sampleRuns || [])]) {
            if (run.temporary) continue;
            run.cancelled = true;
            run.wake?.();
        }
    }
    async _runSamples(params, count, intervalMs, syncStatus) {
        const layoutErrors = new Map();
        await this.host._elfView.prepareLayouts(params.variables, { layoutErrors });
        const { elfResult, plan, compositePlan, variableErrors } = agentPlans.readPlan(
            params,
            () => this.host.readElfSymbols(),
            layoutErrors
        );
        // Merges the actual reads of scalar and composite variables: each composite is read once by base address
        // (deduplicated by name) and navigated per path while decoding, so one struct is not read repeatedly.
        const readItems = [];
        const seenRead = new Set();
        for (const item of plan) {
            if (!seenRead.has(item.name)) {
                seenRead.add(item.name);
                readItems.push({ name: item.name, address: item.address, size: item.size });
            }
        }
        for (const comp of compositePlan) {
            if (!seenRead.has(comp.name)) {
                seenRead.add(comp.name);
                readItems.push(
                    comp.runtimeLayout ? { ...comp } : { name: comp.name, address: comp.address, size: comp.size }
                );
            }
        }

        return this.withProbe(
            async ({ session, source, temporary }) => {
                if (temporary && syncStatus)
                    this._postSampling(true, "live.agentSampling", { current: 0, total: count });
                const result = [];
                const effectiveIntervalMs = intervalMs;
                const run = { temporary, cancelled: false, wake: null };
                (this._sampleRuns ??= new Set()).add(run);
                try {
                    for (let index = 0; index < count; index++) {
                        if ((temporary && !this.readRunning) || run.cancelled)
                            throw Object.assign(new Error("Agent sampling was cancelled by the user"), {
                                code: "AGENT_READ_CANCELLED"
                            });
                        const sampleStart = Date.now();
                        result.push(
                            agentPlans.decodeSample(
                                plan,
                                await session.readOnce(this.host._sampling.runtimeReadRanges(readItems, elfResult)),
                                compositePlan
                            )
                        );
                        if (temporary && syncStatus)
                            this._postSampling(true, "live.agentSampling", { current: index + 1, total: count });
                        // The interval runs from sample start to sample start, so read time does not stretch it.
                        if (index + 1 < count)
                            await this._waitInterval(
                                Math.max(0, effectiveIntervalMs - (Date.now() - sampleStart)),
                                run
                            );
                    }
                } finally {
                    this._sampleRuns.delete(run);
                }
                return {
                    source,
                    elf: elfResult.elf,
                    ...this.host._writes.firmwareConsistency(elfResult),
                    samples: result,
                    ...(variableErrors.length ? { partial: true, variableErrors } : {})
                };
            },
            { syncStatus, total: count, allowPausedDebugRead: true }
        );
    }
    async withProbe(handler, options = {}) {
        if (this.host._debugBridge.replBusy)
            throw Object.assign(new Error("Wait for the GDB console command before inspecting memory"), {
                code: "DEBUG_CONTROL_BUSY"
            });
        if (this.host._sampling.closing || this.host._sampling.exitUnconfirmed)
            throw Object.assign(new Error("The previous probe connection has not closed"), {
                code: "PROBE_EXIT_UNCONFIRMED"
            });
        const syncStatus = !!options.syncStatus;
        const total = options.total || 0;
        // If the UI is starting sampling, wait briefly for it to connect and then reuse the same Tcl session.
        const liveDeadline = Date.now() + 7000;
        while (this.host._sampling.starting && Date.now() < liveDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        let operationLease = null;
        let session =
            this.host._sampling.running &&
            (!options.peripheralAccess || (this.host._sampling.intent && !this.host._sampling.session?.stopped))
                ? this.host._sampling.session
                : null;
        let temporary = false;
        let source = "active-sampling";
        if (!session && options.allowPausedDebugRead) {
            session = selectPausedDebugReadSession(this.host._debugBridge);
            if (session) {
                this.host._writes.assertGroupedReadElf();
                source = "debug-session";
            } else if (
                this.host.debugLaunch.managedServer &&
                this.host.debugLaunch.managedSessionId &&
                this.host._debugBridge.agentStatus().state === "running"
            ) {
                const managed = this.host.debugLaunch.managedServer;
                if (managed.capabilities?.runtimeRead === false)
                    throw Object.assign(new Error("Pause the selected core before reading multicore memory"), {
                        code: "DEBUG_RUNTIME_READ_UNSUPPORTED"
                    });
                session = options.peripheralAccess
                    ? managed
                    : {
                          readOnce: async (items) => {
                              const plan = this.host._sampling.runtimeRamPlan(items, true);
                              const epoch = this.host._debugBridge.stopEpoch;
                              const samples = await managed.readOnce(plan.allowed);
                              if (
                                  this.host._debugBridge.stopEpoch !== epoch ||
                                  this.host._debugBridge.agentStatus().state !== "running"
                              ) {
                                  throw Object.assign(new Error("Debug target state changed during the runtime read"), {
                                      code: "DEBUG_STATE_CHANGED",
                                      retryable: true
                                  });
                              }
                              return samples;
                          }
                      };
                source = "debug-running-openocd";
            }
        }
        if (!session && options.peripheralAccess)
            throw Object.assign(new Error("Start sampling or debugging before accessing peripheral registers"), {
                code: "PERIPHERAL_SAMPLING_REQUIRED"
            });
        if (!session) {
            if (this.readRunning)
                throw Object.assign(new Error("Another Agent variable read is in progress"), {
                    code: "AGENT_READ_BUSY"
                });
            // An RTT-owned session is not shared; it gives way and comes back once this read ends.
            await this.host._rtt?.yieldOwnSession("agentRead");
            if (
                this.host._downloadRunning ||
                this.host._chipInfoRunning ||
                this.host.debugLaunch.starting ||
                this.host.debugLaunch.liveSession()
            ) {
                throw Object.assign(new Error("The debug probe is busy with another operation"), {
                    code: "PROBE_BUSY",
                    details: {
                        activeOperation:
                            this.host.debugLaunch.starting || this.host.debugLaunch.liveSession() ? "debug" : "probe",
                        debugState: this.host._debugBridge.agentStatus().state
                    }
                });
            }
            operationLease = this.host._probeCoordinator.acquire("agentRead");
            this._readLease = operationLease;
            this.readCancelled = false;
            let prepared;
            const preparation = new Promise((resolve) => {
                prepared = resolve;
            });
            this._readPreparation = preparation;
            const assertActive = () => {
                if (operationLease.released || this.readCancelled || this._readLease !== operationLease)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
            };
            try {
                const debuggerCfg =
                    this.host._context.workspaceState.get(CACHE_KEYS.debugger) ||
                    (await this.host._probeConnectionService.resolveProbe());
                const mcuCore = this.host._context.workspaceState.get(CACHE_KEYS.mcuCore);
                assertActive();
                if (!debuggerCfg || !mcuCore) {
                    throw Object.assign(new Error(this.host._t("live.needConfig")), {
                        code: "CONFIG_INCOMPLETE",
                        i18nKey: "live.needConfig"
                    });
                }
                const cfg = this._vscode.workspace.getConfiguration("emberprobe");
                const executable = await this.host._resolveOpenOcdPath(cfg.get("openocdPath", "openocd"));
                assertActive();
                if (!executable) {
                    throw Object.assign(new Error(this.host._t("live.notReady")), {
                        code: "OPENOCD_NOT_READY",
                        i18nKey: "live.notReady"
                    });
                }
                if (operationLease.released || this.readCancelled)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
                const { cwd } = this.host._commandContext();
                const connection = await this.host._probeConnectionService.prepare({
                    executable,
                    probe: debuggerCfg,
                    target: mcuCore,
                    sampling: true
                });
                assertActive();
                const port = await this.host._resolveTclPort(cfg);
                assertActive();
                session = new this._ManagedOpenOcdSession(
                    {
                        executable,
                        isolated: true,
                        transport: this._vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                        probe: debuggerCfg,
                        target: mcuCore,
                        ...connection,
                        cwd,
                        port,
                        intervalMs: 10000
                    },
                    {
                        onConnectionConfirmed: () => {
                            if (!operationLease.released && this.readSession === session)
                                void this.host._probeConnectionService.recordSuccess(session.options);
                        }
                    }
                );
                if (operationLease.released)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
                this.readSession = session;
                temporary = true;
                source = "temporary-probe";
            } catch (error) {
                operationLease?.release();
                throw error;
            } finally {
                prepared();
                if (this._readPreparation === preparation) this._readPreparation = null;
            }
        }

        let completed = false;
        try {
            if (temporary) {
                if (syncStatus) this._postSampling(true, "live.agentStarting", { total });
                if (this.readCancelled || operationLease.released || this.readSession !== session)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
                await session.start();
                if (operationLease.released || this.readCancelled || this.readSession !== session)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
            }
            const result = await handler({ session, source, temporary });
            completed = true;
            return result;
        } finally {
            if (temporary) {
                await this._confirmExit(session);
                if (this.readSession === session) this.readSession = null;
                operationLease?.release();
                if (this._readLease === operationLease) this._wakeReadDelays();
                if (syncStatus && this._readLease === operationLease) {
                    const key = this.readCancelled
                        ? "live.agentStopped"
                        : completed
                          ? "live.agentDone"
                          : "live.agentFailed";
                    this._postSampling(false, key, { total });
                }
                if (this._readLease === operationLease) this.readCancelled = false;
            }
        }
    }
    async _confirmExit(session) {
        if ((await session.stop()) === false)
            throw Object.assign(new Error("OpenOCD exit has not been confirmed"), { code: "PROBE_EXIT_UNCONFIRMED" });
    }
    async readVariables(params) {
        const result = await this._runSamples(params, 1, 0, false);
        return {
            source: result.source,
            elf: result.elf,
            firmwareConsistency: result.firmwareConsistency,
            ...(result.warnings ? { warnings: result.warnings } : {}),
            ...result.samples[0],
            ...(result.variableErrors ? { partial: true, variableErrors: result.variableErrors } : {})
        };
    }
    async sampleVariables(params) {
        const count = validation.clampInteger(params.count, 10, 2, 1000);
        const intervalMs = validation.clampInteger(params.intervalMs, 200, 5, 60000);
        return this._runSamples(params, count, intervalMs, true);
    }
    // Reads and decodes the Cortex-M fault registers; shares the _chipInfoRunning lock with chip.read (only one
    // one-shot OpenOCD process at a time)
    async readFault() {
        const busy = (key, code) => {
            throw Object.assign(new Error(this.host._t(key)), { i18nKey: key, code });
        };
        if (this.host._chipInfoRunning) busy("chip.reading", "CHIP_READ_RUNNING");
        if (this.host._downloadRunning) busy("chip.busyDownload", "PROBE_BUSY");
        if (this.host._sampling.running) busy("chip.busyLive", "PROBE_BUSY");
        if (this.readRunning) busy("chip.busyAgent", "PROBE_BUSY");
        if (this.host.debugLaunch.starting || this.host.debugLaunch.liveSession()) busy("chip.busyDebug", "PROBE_BUSY");
        const elfLoad = this.host._elfService.load().catch(() => null);
        const debuggerCfg =
            this.host._context.workspaceState.get(CACHE_KEYS.debugger) ||
            (await this.host._probeConnectionService.resolveProbe());
        const mcuCore = this.host._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore) busy("chip.needConfig", "CONFIG_INCOMPLETE");
        await this.host._rtt?.yieldOwnSession("chipInfo");
        this.host._chipInfoLease = this.host._probeCoordinator.acquire("chipInfo");
        try {
            const executable = await this.host._resolveOpenOcdPath(
                this._vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd")
            );
            if (!executable) busy("chip.notReady", "OPENOCD_NOT_READY");
            const { cwd } = this.host._commandContext();
            await elfLoad;
            return await this.host._faultService.read(
                {
                    executable,
                    transport: this._vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                    probe: debuggerCfg,
                    target: mcuCore,
                    ...(await this.host._probeConnectionService.prepare({
                        executable,
                        probe: debuggerCfg,
                        target: mcuCore
                    })),
                    cwd
                },
                () => this.host.readElfSymbols().functions || []
            );
        } finally {
            this.host._chipInfoLease?.release();
        }
    }
    // Background generation has no withProgress window of its own (the Bridge call returns an operationId immediately),
    // so a cancellable notification is attached to the running operation, reusing the existing progress and cancel
    // handling
    startCubeMxOperation(params) {
        return this.host._cubemxService.start(params).then((started) => {
            if (started?.operationId) this.showCubeMxProgress(started.operationId);
            return started;
        });
    }
    showCubeMxProgress(operationId) {
        const execution = this.host._cubemxService.activeExecutions.get(operationId);
        if (!execution) return;
        this._vscode.window.withProgress(
            {
                location: this._vscode.ProgressLocation.Notification,
                title: this.host._t("cubemx.generating"),
                cancellable: true
            },
            async (progress, token) => {
                progress.report({ message: this.host._t("cubemx.generating") });
                const subscription = token.onCancellationRequested(() =>
                    this.host._cubemxService.cancel({ operationId })
                );
                try {
                    await execution;
                } finally {
                    subscription.dispose();
                }
            }
        );
    }
    /** @param {{ intervalMs?: number }} params */
    async controlSampling(action, params = {}) {
        if (
            !params ||
            typeof params !== "object" ||
            Array.isArray(params) ||
            Object.keys(params).some((key) => action !== "start" || key !== "intervalMs") ||
            (params.intervalMs !== undefined &&
                (!Number.isInteger(params.intervalMs) || params.intervalMs < 5 || params.intervalMs > 10000))
        ) {
            throw Object.assign(new Error("Sampling accepts only an integer intervalMs from 5 to 10000 on start"), {
                code: "INVALID_PARAMS"
            });
        }
        if (action === "start") {
            // Use the same watch union, probe ownership and UI notifications as the sidebar.
            await this.host._sampling.start(
                undefined,
                params.intervalMs ?? this.host._sampling.intervalMs,
                "sidebar",
                false
            );
        } else if (action === "stop") {
            // Cancel Agent samples (temporary or on a borrowed connection) as well as persistent sampling;
            // leave debugging active.
            this._cancelSharedSamples();
            const agentStopped = this.stopReadIfRunning();
            const liveStopped = this.host._sampling.stop({ variablesOnly: true });
            await Promise.all([agentStopped, liveStopped]);
        }
        return {
            ...this.host._sampling.status(),
            starting: this.host._sampling.starting,
            intervalMs: this.host._sampling.intervalMs
        };
    }
    stopReadIfRunning() {
        if (!this.readRunning && !this.readSession) return null;
        this.readCancelled = true;
        this._wakeReadDelays();
        this._postSampling(false, "live.agentStopped");
        const session = this.readSession;
        const lease = this._readLease;
        if (!session) return this._readPreparation || null;
        return Promise.resolve(session.stop()).then((closed) => {
            if (closed === false)
                throw Object.assign(new Error("OpenOCD exit has not been confirmed"), {
                    code: "PROBE_EXIT_UNCONFIRMED"
                });
            if (this.readSession === session) this.readSession = null;
            lease?.release();
        });
    }
}

module.exports = { AgentOperations };
