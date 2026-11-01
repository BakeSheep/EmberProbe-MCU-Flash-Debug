"use strict";
const { isSupportedDebugSession } = require("./debugConfiguration");
const { withWriteAccessStatus } = require("../writeAccess");
const {
    DEFAULT_FREQUENCY_HZ,
    frequencyHzFromInterval,
    intervalMsFromHz,
    normalizeFrequencyHz
} = require("../samplingFrequency");
const { writeConnectionIdentity } = require("../writeAuthorization");
const { serializeError, toUiError } = require("./errorEnvelope");
const { collectRuntimeHistoryLeaves } = require("./liveWatchService");
const { RuntimeSampleHold } = require("./runtimeSampleHold");
const { HostLoopDelay } = require("./hostLoopDelay");
const liveWatch = require("../liveWatch");
const elfSymbols = require("../elfSymbols");
const validation = require("../validation");
const {
    buildActiveReadPlan,
    debugReadPlanKey,
    filterRuntimeRamPlan,
    runtimePointerRanges,
    writableRamSectionRanges
} = require("./liveWatchService");
const { CACHE_KEYS } = require("../cacheKeys");

// Waveform sampling without a rate cap (the slider's "Max rate" notch), remembered per workspace.
const UNLIMITED_SAMPLING_STATE_KEY = "liveWatch.unlimitedSampling";
// Waveform runtime objects read only the parts their view opened (default) or everything parsed.
const POINTER_EXPANDED_ONLY_STATE_KEY = "liveWatch.pointerExpandedOnly";
// A pending webview batch keeps one sample per name (latest wins), so one message never carries an
// older and a newer state of the same variable.
function latestByName(pending, next) {
    return [...new Map([...(pending || []), ...(next || [])].map((sample) => [sample.name, sample])).values()];
}

// Live sampling for the sidebar and the chart panels: which variables each consumer reads, how the merged plan reaches
// the sampling session or the debug server, and the decode types of each consumer; the sampling session's lifecycle
// and how samples reach the views. host is the MainViewProvider; vscode and LiveWatchSession come from it so tests
// can replace them.
class LiveWatchController {
    /**
     * @param {any} host
     * @param {{ vscode?: any, LiveWatchSession?: any, frequencyHz?: number, unlimited?: boolean,
     *     pointerExpandedOnly?: boolean }} [settings]
     */
    constructor(
        host,
        {
            vscode,
            LiveWatchSession,
            frequencyHz = DEFAULT_FREQUENCY_HZ,
            unlimited = false,
            pointerExpandedOnly = true
        } = {}
    ) {
        this.host = host;
        this._vscode = vscode;
        this._LiveWatchSession = LiveWatchSession;
        this.frequencyHz = frequencyHz;
        this.intervalMs = intervalMsFromHz(frequencyHz);
        this._unlimitedRequested = unlimited === true;
        this.pointerExpandedOnly = pointerExpandedOnly !== false;
        this.session = null;
        this.intent = false;
        this.consumers = new Set();
        // Set while this controller writes the frequency setting, so the configuration event does not apply it again.
        this.savingFrequency = false;
        this._hostLoopDelay = null;
        this._runtimeDeniedKey = "";
        this._runtimeOverBudgetKey = "";
        this._runtimeRamCache = null;
        this._consumerTypesCache = null;
    }
    // A new ELF has other RAM sections.
    invalidateRuntimeRam() {
        this._runtimeRamCache = null;
    }
    // A new debug server reports rejected and over-budget runtime reads afresh.
    resetRuntimeNotices() {
        this._runtimeDeniedKey = "";
        this._runtimeOverBudgetKey = "";
    }
    runtimeRamPlan(items, strict = false) {
        const cache = this._runtimeRamSections(this.host.readElfSymbols());
        const result = filterRuntimeRamPlan(items, cache.sections, cache.regions);
        if (strict && result.denied.length) {
            throw Object.assign(new Error("Runtime reads are restricted to writable allocated ELF RAM sections"), {
                code: "LIVE_ADDRESS_NOT_RAM",
                details: {
                    variables: result.denied.map((item) => ({
                        name: item.name,
                        address: `0x${(Number(item.address) >>> 0).toString(16).toUpperCase()}`,
                        size: item.size
                    }))
                }
            });
        }
        // Explicit reads and writes must fit as a whole; continuous sampling drops only the items
        // that exceed the per-cycle budget so the rest keep running.
        if (strict) {
            liveWatch.validateManagedReadPlan(result.allowed);
            return { ...result, overBudget: [] };
        }
        const { allowed, overBudget } = liveWatch.partitionManagedReadPlan(result.allowed);
        return { ...result, allowed, overBudget };
    }
    configureManagedRuntimeWatch() {
        const server = this.host.debugLaunch.managedServer;
        if (!server || server.capabilities?.runtimeRead === false) return [];
        const plan = this.runtimeRamPlan(this.activeReadPlan());
        const itemKey = (items) => items.map((item) => `${item.name}:${item.address}:${item.size}`).join("|");
        const deniedKey = itemKey(plan.denied);
        if (deniedKey && deniedKey !== this._runtimeDeniedKey) {
            this._runtimeDeniedKey = deniedKey;
            const t = Date.now();
            this.handleRawSamples(
                plan.denied.map((item) => ({ name: item.name, bytes: null, t })),
                t
            );
            this.host._postLive({
                type: "liveError",
                key: "live.runtimeAddressRejectedNames",
                params: { names: plan.denied.map((item) => this.host._variableDisplayName(item)).join(", ") }
            });
        } else if (!deniedKey) this._runtimeDeniedKey = "";
        // Re-mark rejected items on every configuration: a paused snapshot may have filled them meanwhile.
        if (plan.overBudget.length) {
            const t = Date.now();
            const message = `Runtime read exceeds the per-cycle budget (${liveWatch.MAX_DEBUG_READ_BYTES} bytes / ${liveWatch.MAX_DEBUG_READ_COMMANDS} commands)`;
            this.handleRawSamples(
                plan.overBudget.map((item) => ({
                    name: item.name,
                    bytes: null,
                    diagnostic: { code: "LIVE_READ_BUDGET_EXCEEDED", message },
                    t
                })),
                t
            );
        }
        const overBudgetKey = itemKey(plan.overBudget);
        if (overBudgetKey && overBudgetKey !== this._runtimeOverBudgetKey) {
            this._runtimeOverBudgetKey = overBudgetKey;
            this.host._postLive({
                type: "liveError",
                key: "live.runtimeBudgetExceededNames",
                params: { names: plan.overBudget.map((item) => this.host._variableDisplayName(item)).join(", ") }
            });
        } else if (!overBudgetKey) this._runtimeOverBudgetKey = "";
        if (!plan.allowed.length && plan.overBudget.length)
            throw Object.assign(new Error("Every watched item exceeds the runtime read budget"), {
                code: "LIVE_READ_BUDGET_EXCEEDED"
            });
        this.applySamplingPlan(server, plan.allowed);
        return plan.allowed;
    }
    // Chart and sidebar keep separate watch lists, and a variable may use a different watch type on each side. The read
    // plan deduplicates by variable name using the wider width, so one read serves every consumer. Composites
    // (structs/arrays) expand into leaf reads merged over the variable's whole address range.
    activeReadPlan() {
        const lists = [];
        const expansions = [];
        for (const entry of this.host._livePanels.values()) {
            lists.push(this.host._scalarWatchList(entry.watchKey));
            expansions.push(this.panelRuntimeExpansions(entry.watchKey));
        }
        // Sidebar cards read the parts they opened, like chart cards; write cards read runtime objects whole.
        lists.push(this.host._scalarWatchList(CACHE_KEYS.sidebarWatchList));
        expansions.push(this.panelRuntimeExpansions(CACHE_KEYS.sidebarWatchList));
        // Write list variables are sampled too so write cards show current values; the stored list is not rewritten,
        // which would lose UI fields such as min/max
        try {
            const writeItems = this.host._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || [];
            lists.push(validation.normalizeWatchList(writeItems, this.host.readElfSymbols().symbols));
        } catch (e) {
            /* Ignore the write list when the ELF is unavailable */
        }
        const plan = buildActiveReadPlan(lists, elfSymbols, expansions);
        return this.runtimeReadRanges(plan);
    }
    runtimeReadRanges(plan, result) {
        if (!plan.some((item) => item.runtimeLayout)) return plan;
        const cache = this._runtimeRamSections(result ?? this.host.readElfSymbols());
        const ranges = runtimePointerRanges(cache.sections, cache.regions);
        return plan.map((item) => (item.runtimeLayout ? { ...item, runtimeRanges: ranges } : item));
    }
    _runtimeRamSections(elfResult) {
        if (!this._runtimeRamCache || this._runtimeRamCache.sha256 !== elfResult.elf.sha256) {
            const memory = elfResult.memory || {};
            this._runtimeRamCache = {
                sha256: elfResult.elf.sha256,
                sections: Array.isArray(memory.sections) ? memory.sections : [],
                regions: Array.isArray(memory.runtimeRegions) ? memory.runtimeRegions : []
            };
        }
        return this._runtimeRamCache;
    }
    applySamplingPlan(session, active) {
        let ramSectionRanges = [];
        try {
            ramSectionRanges = writableRamSectionRanges(this.host.readElfSymbols().memory?.sections);
        } catch {
            /* Without an ELF only overlapping or adjacent reads are merged. */
        }
        if (typeof session.setSamplingPlan !== "function") {
            session.setWatch(active, ramSectionRanges);
            return;
        }
        const { graphs, sidebar } = this.consumerTypes();
        const graphNames = new Set([...graphs.values()].flatMap((map) => [...map.keys()]));
        const graphItems = active.filter((item) => graphNames.has(item.name) || graphNames.has(item.parentName));
        const sidebarItems = active.filter((item) => sidebar.has(item.name) || sidebar.has(item.parentName));
        if (typeof session.setSamplingPlan === "function")
            session.setSamplingPlan({
                graphItems,
                sidebarItems,
                ramSectionRanges,
                graphIntervalMs: this.intervalMs,
                unlimited: this.unlimitedEnabled()
            });
        else session.setWatch(active, ramSectionRanges);
    }
    // Each consumer's watch type per variable, so the same raw bytes are decoded and pushed per type.
    consumerTypes() {
        const build = (key) => {
            const m = new Map();
            for (const item of this.host._scalarWatchList(key)) {
                if (item?.name)
                    m.set(
                        item.name,
                        Number.isInteger(item.bitSize) || item.enumInfo || item.isPointer ? item : item.type
                    );
            }
            return m;
        };
        const sidebar = build(CACHE_KEYS.sidebarWatchList);
        // Write list variables are decoded with their own watch type and pushed to the sidebar; for the same name the
        // watch list type wins
        for (const item of this.host._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || []) {
            if (item?.name && item.type && !sidebar.has(item.name)) {
                const symbols = this.host.readElfSymbols().symbols;
                const symbol =
                    symbols.find((entry) => entry.name === item.name) ||
                    validation.normalizeWatchList([item], symbols)[0];
                const enumInfo = symbol?.watchType === item.type ? symbol.enumInfo : null;
                sidebar.set(
                    item.name,
                    Number.isInteger(item.bitSize) || enumInfo || symbol?.isPointer
                        ? {
                              ...item,
                              ...(enumInfo ? { enumInfo } : {}),
                              ...(symbol?.isPointer
                                  ? {
                                        isPointer: true,
                                        pointerTarget: symbol.pointerTarget,
                                        ...(symbol.memberRole ? { memberRole: symbol.memberRole } : {})
                                    }
                                  : {})
                          }
                        : item.type
                );
            }
        }
        const graphs = new Map();
        for (const entry of this.host._livePanels.values()) graphs.set(entry.watchKey, build(entry.watchKey));
        return { graphs, sidebar };
    }
    cachedConsumerTypes() {
        if (!this._consumerTypesCache) this._consumerTypesCache = this.consumerTypes();
        return this._consumerTypesCache;
    }
    invalidateConsumerTypes() {
        this._consumerTypesCache = null;
    }
    // Runtime-only composites (an expanded pointee has a type graph, not a static layout) belong here
    // too, so a failed read reaches their tree as an error rather than becoming a scalar sample.
    compositeMap(key) {
        const map = new Map();
        for (const item of this.host._scalarWatchList(key)) {
            if (item.isComposite && (item.compositeLayout || item.runtimeLayout))
                map.set(item.name, { ...item, layout: item.compositeLayout || null });
        }
        return map;
    }
    async refreshSamplingPlan() {
        this._refreshPointerPeripherals();
        const active = this.activeReadPlan();
        // A changed plan (watch list, opened paths) gives runtime trees a new shape; keep no old ones.
        const holdKey = active
            .filter((item) => item.runtimeLayout)
            .map((item) => `${item.name}:${item.address}:${item.size}:${item.runtimeExpanded?.join(",") ?? "*"}`)
            .sort()
            .join("|");
        if (holdKey !== this._runtimeHoldKey) {
            this._runtimeHoldKey = holdKey;
            this.host._runtimeSampleHold?.reset();
        }
        for (const entry of this.host._livePanels.values()) this.host._configureChartHistory(entry);
        if (this.host._debugBridge.hasSession) {
            const planKey = debugReadPlanKey(active);
            this.host._samplingCoordinator.setDebugIntent(this.host._debugBridge, this.intent);
            if (
                this.host.debugLaunch.managedServer &&
                this.host.debugLaunch.managedServer.capabilities?.runtimeRead !== false &&
                this.host.debugLaunch.managedSessionId &&
                !this.host._debugBridge.paused
            ) {
                try {
                    const allowed = this.configureManagedRuntimeWatch();
                    const enabled = this.host._samplingCoordinator.setRuntimeEnabled(
                        this.host.debugLaunch.managedServer,
                        this.intent && allowed.length > 0,
                        this.host._debugBridge
                    );
                    this.host._postConsumerStatuses({
                        mode: enabled
                            ? "debug-running-sampling"
                            : allowed.length
                              ? "debug-running-degraded"
                              : "debug-running-waiting",
                        key: enabled
                            ? "live.debugRuntimeSampling"
                            : allowed.length
                              ? "live.debugTclDegraded"
                              : "live.needVar",
                        source: "openocd",
                        canRead: enabled,
                        canWrite: enabled,
                        snapshotReady: enabled,
                        intentEnabled: this.intent,
                        running: this.intent
                    });
                } catch (error) {
                    this.host.debugLaunch.managedServer.setSamplingEnabled(false);
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
                this.host._debugReadPlanKey = planKey;
                return;
            }
            if (planKey !== this.host._debugReadPlanKey) {
                this.host._debugReadPlanKey = planKey;
                this.host._debugBridge.refreshSnapshot();
            }
            if (!active.length && this.intent)
                this.host._postConsumerStatuses(this.host._debugBridge.status({ key: "live.needVar" }));
            return;
        }
        if (this.session) {
            if (active.length) this.applySamplingPlan(this.session, active);
            else {
                this.stop({ preserveIntent: true });
                this.host._postConsumerStatuses({ key: "live.needVar" });
            }
            return;
        }
        if (this.host._externalDebug?.held) return;
        if (
            this.intent &&
            active.length &&
            !this.host._downloadRunning &&
            !this.host.debugLaunch.starting &&
            !this.host.debugLaunch.commandPending
        )
            await this.start(undefined, this.intervalMs, "refresh");
        else if (this.intent && !active.length) this.host._postConsumerStatuses({ key: "live.needVar" });
    }
    get running() {
        return this.host._probeCoordinator?.isActive("liveWatch") ?? false;
    }
    // A session runs, starts or stops.
    get inUse() {
        return this.running || Boolean(this.session || this._startPromise || this.stopPromise);
    }
    get starting() {
        return this.host._probeCoordinator?.isActive("liveStart") ?? false;
    }
    pointerState() {
        return { type: "pointerSampling", expandedOnly: this.pointerExpandedOnly === true };
    }
    async setPointerExpandedOnly(enabled) {
        if (typeof enabled !== "boolean")
            throw Object.assign(new Error("Pointer sampling mode must be a boolean"), { code: "INVALID_PARAMS" });
        if (enabled === this.pointerExpandedOnly) return;
        this.pointerExpandedOnly = enabled;
        await this.host._context.workspaceState.update(POINTER_EXPANDED_ONLY_STATE_KEY, enabled);
        const state = this.pointerState();
        for (const entry of this.host._livePanels.values()) entry.post(state);
        await this.refreshSamplingPlan();
    }
    // Opened runtime paths of a chart's watch list while only expanded parts are sampled, else null.
    panelRuntimeExpansions(watchKey) {
        return this.pointerExpandedOnly === true ? this.host._runtimeExpansions(watchKey) : null;
    }
    unlimitedEnabled() {
        return this._unlimitedRequested === true;
    }
    unlimitedState() {
        return { type: "liveUnlimited", enabled: this.unlimitedEnabled() };
    }
    async setUnlimited(enabled) {
        if (typeof enabled !== "boolean")
            throw Object.assign(new Error("Unlimited sampling state must be a boolean"), { code: "INVALID_PARAMS" });
        this._unlimitedRequested = enabled;
        this._unlimitedChanged();
        await this.host._context.workspaceState.update(UNLIMITED_SAMPLING_STATE_KEY, enabled);
        return this.unlimitedEnabled();
    }
    _unlimitedChanged() {
        // Only the standalone OpenOCD session honours the flag; debug sessions keep their adaptive budget.
        if (this.session && !this.host._debugBridge.hasSession) {
            const active = this.activeReadPlan();
            if (active.length) this.applySamplingPlan(this.session, active);
        }
        const state = this.unlimitedState();
        for (const entry of this.host._livePanels.values()) entry.post(state);
    }
    setIntervalMs(intervalMs, frequencyHz) {
        const value = validation.clampInteger(intervalMs, intervalMsFromHz(this.frequencyHz), 5, 10000);
        this.frequencyHz =
            frequencyHz === undefined
                ? value === this.intervalMs
                    ? this.frequencyHz
                    : frequencyHzFromInterval(value)
                : normalizeFrequencyHz(frequencyHz);
        this.intervalMs = value;
        if (this.session) this.session.setIntervalMs(value);
        this.host.debugLaunch.managedServer?.setIntervalMs?.(value);
        this.host._postLive({ type: "liveFrequency", frequencyHz: this.frequencyHz, intervalMs: value });
        return value;
    }
    async saveFrequency(frequencyHz) {
        if (
            typeof frequencyHz !== "number" ||
            !Number.isFinite(frequencyHz) ||
            frequencyHz < 0.1 ||
            frequencyHz > 200 ||
            Math.abs(frequencyHz * 10 - Math.round(frequencyHz * 10)) > 1e-8
        )
            throw Object.assign(new Error("Sampling frequency must be 0.1 to 200 Hz in 0.1 Hz steps"), {
                code: "INVALID_SAMPLE_FREQUENCY"
            });
        const value = normalizeFrequencyHz(frequencyHz);
        this.setIntervalMs(intervalMsFromHz(value), value);
        this.savingFrequency = true;
        try {
            await this._vscode.workspace
                .getConfiguration("emberprobe")
                .update("sampleFrequencyHz", value, this._vscode.ConfigurationTarget.Workspace);
        } finally {
            this.savingFrequency = false;
        }
        return value;
    }
    _postWebviewBatch(entry, scalarSamples, compositeSamples, t) {
        if (!entry.ready) return;
        entry._pendingScalars = latestByName(entry._pendingScalars, scalarSamples);
        entry._pendingComposites = latestByName(entry._pendingComposites, compositeSamples);
        if (!entry._batchTimer)
            entry._batchTimer = setTimeout(() => {
                entry._batchTimer = null;
                const scalars = entry._pendingScalars,
                    composites = entry._pendingComposites;
                entry._pendingScalars = [];
                entry._pendingComposites = [];
                const status = this.status();
                if (scalars.length)
                    entry.post({
                        type: "chartValues",
                        samples: scalars,
                        t,
                        actualHz: status.actualHz,
                        bytesPerSecond: status.bytesPerSecond,
                        unlimitedActive: status.unlimitedActive,
                        limitedBy: status.limitedBy,
                        archive: this.host._samplingArchiveBudget()
                    });
                if (composites.length)
                    entry.post({
                        type: "liveCompositeSample",
                        samples: composites,
                        t,
                        actualHz: status.actualHz,
                        bytesPerSecond: status.bytesPerSecond
                    });
            }, 50);
    }
    _postSidebarBatch(scalarSamples, compositeSamples, t) {
        if (!this.host._webviewView?.webview) return;
        if (this.host._chartHistory && Date.now() - (this.host._sidebarStatsTime || 0) >= 1000) {
            this.host._sidebarStatsTime = Date.now();
            const status = this.status();
            this.host._webviewView.webview.postMessage({
                type: "liveStatus",
                ...status,
                frequencyHz: 20,
                actualHz: status.consumers?.sidebarHz ?? status.actualHz
            });
        }
        const interval = this.intervalMs ?? 100;
        if (interval >= 30 || !this.running) {
            if (scalarSamples?.length)
                this.host._webviewView.webview.postMessage({ type: "liveSample", samples: scalarSamples, t });
            if (compositeSamples?.length)
                this.host._webviewView.webview.postMessage({
                    type: "liveCompositeSample",
                    samples: compositeSamples,
                    t
                });
            return;
        }
        this.host._pendingSidebarScalars = (this.host._pendingSidebarScalars || []).concat(scalarSamples);
        this.host._pendingSidebarComposites = latestByName(this.host._pendingSidebarComposites, compositeSamples);
        if (!this.host._sidebarBatchTimer) {
            this.host._sidebarBatchTimer = setTimeout(() => {
                this.host._sidebarBatchTimer = null;
                const scalars = this.host._pendingSidebarScalars;
                const composites = this.host._pendingSidebarComposites;
                this.host._pendingSidebarScalars = [];
                this.host._pendingSidebarComposites = [];
                if (scalars?.length)
                    this.host._webviewView?.webview.postMessage({
                        type: "liveSample",
                        samples: scalars,
                        t: Date.now()
                    });
                if (composites?.length)
                    this.host._webviewView?.webview.postMessage({
                        type: "liveCompositeSample",
                        samples: composites,
                        t: Date.now()
                    });
            }, 25);
        }
    }
    _flushPendingWebviewSamples() {
        if (this.host._livePanels) {
            for (const entry of this.host._livePanels.values()) {
                if (entry._batchTimer) {
                    clearTimeout(entry._batchTimer);
                    entry._batchTimer = null;
                }
                if (entry._pendingScalars?.length) {
                    const scalars = entry._pendingScalars;
                    entry._pendingScalars = [];
                    entry.post({
                        type: "chartValues",
                        samples: scalars,
                        t: Date.now()
                    });
                }
                if (entry._pendingComposites?.length) {
                    const composites = entry._pendingComposites;
                    entry._pendingComposites = [];
                    entry.post({ type: "liveCompositeSample", samples: composites, t: Date.now() });
                }
            }
        }
        if (this.host._sidebarBatchTimer) {
            clearTimeout(this.host._sidebarBatchTimer);
            this.host._sidebarBatchTimer = null;
        }
        if (this.host._pendingSidebarScalars?.length) {
            const scalars = this.host._pendingSidebarScalars;
            this.host._pendingSidebarScalars = [];
            this.host._webviewView?.webview.postMessage({ type: "liveSample", samples: scalars, t: Date.now() });
        }
        if (this.host._pendingSidebarComposites?.length) {
            const composites = this.host._pendingSidebarComposites;
            this.host._pendingSidebarComposites = [];
            this.host._webviewView?.webview.postMessage({
                type: "liveCompositeSample",
                samples: composites,
                t: Date.now()
            });
        }
    }
    handleRawSamples(samples, t, consumers) {
        // Every source (managed sampling, worker, paused DAP reads) passes the same hold, so a runtime
        // object keeps its last consistent tree through transient misses (see runtimeSampleHold.js).
        samples = (this.host._runtimeSampleHold ||= new RuntimeSampleHold()).apply(samples, t);
        const types = this.cachedConsumerTypes();
        const graphNames = consumers && new Set(consumers.graphNames);
        const sidebarNames = consumers && new Set(consumers.sidebarNames);
        const graphSamples = graphNames ? samples.filter((sample) => graphNames.has(sample.name)) : samples;
        for (const entry of this.host._livePanels.values()) {
            if (!entry.historySignature) this.host._configureChartHistory(entry, t);
            const currentSamples =
                entry.historyClearedAt === undefined
                    ? graphSamples
                    : graphSamples.filter((sample) => (sample.t ?? t) > entry.historyClearedAt);
            const decoded = this.host._liveWatchService.decodeConsumerSamples(
                currentSamples,
                t,
                types.graphs.get(entry.watchKey),
                this.compositeMap(entry.watchKey),
                entry.latestSamples
            );
            if (entry.ready && (decoded.scalarSamples.length || decoded.compositeSamples.length)) {
                this._postWebviewBatch(entry, decoded.scalarSamples, decoded.compositeSamples, t);
            }
            // Scalars of runtime trees become silent channels as they appear, like static composite members.
            const runtimeLeaves = decoded.compositeSamples.length
                ? collectRuntimeHistoryLeaves(
                      decoded.compositeSamples,
                      this.host._scalarWatchList(entry.watchKey),
                      this.panelRuntimeExpansions(entry.watchKey),
                      (entry.runtimeHistoryLeaves ||= new Map())
                  )
                : { samples: [], added: false };
            if (runtimeLeaves.added) this.host._configureChartHistory(entry, t);
            // Keep every panel's decoding and type changes separate in exported history.
            const recorded = entry.historyItems
                ? this.host._liveWatchService.decodeHistorySamples(
                      currentSamples,
                      t,
                      entry.historyItems,
                      runtimeLeaves.samples.concat(decoded.scalarSamples)
                  )
                : decoded.scalarSamples;
            const graphTypes = new Map(
                entry.historyItems
                    ? entry.historyItems.map((item) => [item.name, item.type])
                    : types.graphs.get(entry.watchKey)
            );
            if (recorded.length && this.host._chartHistory) this.host._queueChartHistoryAppend(entry, recorded, t);
            this.host._samplingArchive.append(
                recorded.map((sample) => {
                    const spec = graphTypes.get(sample.name);
                    const type = typeof spec === "string" ? spec : spec.type;
                    const historyIdentity = entry.historyIdentities?.get(sample.name);
                    return {
                        ...sample,
                        name: `${sample.name} [${type}]`,
                        ...(historyIdentity ? { historyIdentity } : {})
                    };
                }),
                t,
                this.host._debugSamplingScope(entry.watchKey)
            );
        }
        const sidebar = this.host._liveWatchService.decodeConsumerSamples(
            sidebarNames ? samples.filter((sample) => sidebarNames.has(sample.name)) : samples,
            t,
            types.sidebar,
            this.compositeMap(CACHE_KEYS.sidebarWatchList),
            this.host._latestSidebarSamples
        );
        if (sidebar.scalarSamples.length || sidebar.compositeSamples.length) {
            this._postSidebarBatch(sidebar.scalarSamples, sidebar.compositeSamples, t);
        }
    }
    // The sampling Worker dropped its oldest backlog while the host was busy. Break each waveform there
    // instead of bridging the missing interval; pending points are sent first so the break stays ordered.
    handleSampleGap() {
        if (!this.host._chartHistory || this.host._chartHistory.failed) return;
        for (const entry of this.host._livePanels.values()) {
            if (!entry.historySignature || entry._historyRestoreTask) continue;
            this.host._flushChartHistoryAppend(entry);
            const scope = this.host._debugSamplingScope(entry.watchKey);
            this.host._chartHistory.request("markGap", [scope]).catch((error) => this.host._chartHistory.fail(error));
        }
    }
    setArchiveBackpressure(paused) {
        this.host._samplingCoordinator.setBackpressure(paused);
        const session = this.host.debugLaunch.managedServer || this.session;
        this.host._samplingCoordinator.setDeliveryHold(this.session);
        if (this.host.debugLaunch.managedServer)
            this.host._samplingCoordinator.setRuntimeEnabled(
                this.host.debugLaunch.managedServer,
                this.intent,
                this.host._debugBridge
            );
        session?.setPauseReason?.(paused ? "archive_backpressure" : null);
        this.host._samplingCoordinator.setDebugIntent(this.host._debugBridge, this.intent);
        // Only host-driven DAP sampling loses samples while paused; mark that hole with an empty row. Worker
        // sessions deliver their held backlog afterwards, which an empty row stamped now would precede.
        if (!paused && !session && this.host._liveWatchService && this.host._samplingArchive) {
            const active = this.activeReadPlan ? this.activeReadPlan() : [];
            if (active.length) {
                const t = Date.now();
                this.handleRawSamples(
                    active.map((item) => ({ name: item.name, bytes: null, t })),
                    t
                );
            }
        }
        this.host._postConsumerStatuses(this.status());
    }
    status() {
        const status = this.host._samplingCoordinator.status({
            intent: this.intent,
            bridge: this.host._debugBridge,
            standaloneRunning: this.running,
            managedServer: this.host.debugLaunch.managedServer,
            agentStatus: this.host._agentOps._samplingStatus
        });
        if (this.closing || this.exitUnconfirmed) {
            Object.assign(status, {
                running: false,
                canRead: false,
                canWrite: false,
                snapshotReady: false,
                mode: this.exitUnconfirmed ? "exit-unconfirmed" : "disconnecting",
                connectionState: this.exitUnconfirmed ? "exit-unconfirmed" : "closing"
            });
        }
        const session = this.host.debugLaunch.managedServer || this.session;
        if (session?.options?.settingsIdentity) {
            try {
                this.host._probeConnectionService.assertCurrent(session);
                status.connection = this.host.debugLaunch.managedGroup
                    ? this.host._debugBridge.activeSession
                        ? this.host._writes.sessionConnection(this.host._debugBridge)
                        : undefined
                    : writeConnectionIdentity(session.options);
            } catch (error) {
                status.canWrite = false;
                status.connectionStale = true;
                status.diagnostic = serializeError(error);
            }
        }
        const stats = typeof session?.stats === "function" ? session.stats() : null;
        status.intervalMs = this.intervalMs;
        status.frequencyHz = this.frequencyHz;
        status.effectiveIntervalMs = stats?.effectiveIntervalMs ?? this.intervalMs;
        status.actualHz = stats?.actualHz ?? 0;
        status.bytesPerSecond = stats?.bytesPerSecond ?? 0;
        status.consumers = stats?.consumers;
        status.sidebarTargetHz = 20;
        status.p95DurationMs = stats?.p95DurationMs ?? 0;
        status.missedDeadlines = stats?.missedDeadlines ?? 0;
        status.unlimited = stats?.unlimited ?? this.unlimitedEnabled();
        status.unlimitedActive = stats?.unlimitedActive === true;
        // DAP-driven debug sessions have no worker statistics but still ignore unlimited sampling.
        status.unlimitedSuppressedReason =
            stats?.unlimitedSuppressedReason ??
            (this.unlimitedEnabled() && this.host._debugBridge?.hasSession ? "debug" : null);
        status.limitedBy = stats?.limitedBy ?? null;
        status.hostHoldMs = stats?.hostHoldMs ?? 0;
        status.backlogBatches = stats?.backlogBatches ?? 0;
        status.backlogAgeMs = stats?.backlogAgeMs ?? 0;
        status.droppedBatches = stats?.droppedBatches ?? 0;
        // The event-loop monitor wakes the host periodically, so it runs only while sampling is requested.
        if (status.running) status.hostLoopDelayMs = (this._hostLoopDelay ||= new HostLoopDelay()).maxMs();
        else {
            this.dispose();
            status.hostLoopDelayMs = 0;
        }
        status.pauseReason =
            stats?.pauseReason ?? (this.host._samplingCoordinator.backpressured ? "archive_backpressure" : null);
        return withWriteAccessStatus(status);
    }
    // Stops the event-loop monitor; status() starts it again while sampling runs.
    dispose() {
        this._hostLoopDelay?.dispose();
        this._hostLoopDelay = null;
    }
    // Pointer cells name peripheral registers from the bound SVD. Loading is read-only,
    // shares the peripheral service cache and runs once per SVD binding.
    // A changed SVD binding renames peripheral pointer targets on the next plan refresh.
    peripheralsChanged() {
        this._pointerPeripheralsRequested = false;
        if (this.intent) this._refreshPointerPeripherals();
    }
    _refreshPointerPeripherals() {
        if (this._pointerPeripheralsRequested || !this.host._svdPeripheralService || !this.host._liveWatchService)
            return;
        this._pointerPeripheralsRequested = true;
        const generation = (this._pointerPeripheralGeneration = (this._pointerPeripheralGeneration || 0) + 1);
        const apply = (model) => {
            if (generation === this._pointerPeripheralGeneration) this.host._liveWatchService.setPeripheralModel(model);
        };
        Promise.resolve()
            .then(() => this.host._svdPeripheralService.model())
            .then(apply, () => apply(null));
    }
    pruneSampleMap(map, keys) {
        const names = new Set();
        for (const key of Array.isArray(keys) ? keys : [keys]) {
            for (const i of this.host._context.workspaceState.get(key) || []) if (i && i.name) names.add(i.name);
        }
        for (const n of map.keys()) if (!names.has(n)) map.delete(n);
    }
    // Restarts a running session with its current plan once the old one stopped, unless sampling was stopped or
    // started again meanwhile.
    restart() {
        const stopped = this.stop({ preserveIntent: true, discardPending: true });
        const generation = this._startGeneration;
        return Promise.resolve(stopped).then(() => {
            if (generation === this._startGeneration && this.intent)
                return this.start(undefined, this.intervalMs, "refresh", false);
        });
    }
    start(items, intervalMs, consumer = "graph", interactive = ["graph", "sidebar"].includes(consumer)) {
        if (this.stopPromise || this._startPromise)
            return Promise.reject(Object.assign(new Error(this.host._t("live.starting")), { code: "PROBE_BUSY" }));
        this.host._resetChartHistoryWarnings();
        const generation = (this._startGeneration = (this._startGeneration || 0) + 1);
        this._startPromise = this._start(items, intervalMs, consumer, interactive, generation).finally(() => {
            this._startPromise = null;
            this.host._postProbeOperationStatus();
        });
        this.host._postProbeOperationStatus();
        return this._startPromise;
    }
    async _start(items, intervalMs, consumer, interactive, generation) {
        if (this.host._externalDebug?.active && this.host._debugBridge.hasSession) {
            this.intent = true;
            this.host._samplingCoordinator.setDebugIntent(this.host._debugBridge, true);
            this.host._postConsumerStatuses(this.host._debugBridge.status());
            return;
        }
        this.host._externalDebug?.assertPhysicalAvailable();
        if (this.host._chartHistory) {
            const maxBytes =
                validation.clampInteger(
                    this._vscode.workspace.getConfiguration("emberprobe").get("chartHistoryMaxMiB", 512),
                    512,
                    64,
                    4096
                ) *
                1024 *
                1024;
            if (maxBytes !== this.host._chartHistory.options.maxBytes) {
                this.host._chartHistory.options.maxBytes = maxBytes;
                if (!this.host._chartHistory.failed) {
                    try {
                        const status = await this.host._chartHistory.request("setBudget", [maxBytes]);
                        if (status?.limited) this.host._warnChartHistoryLimited();
                    } catch (error) {
                        if (["CHART_HISTORY_FULL", "CHART_HISTORY_BACKPRESSURE"].includes(error.code))
                            this.host._warnChartHistoryLimited();
                        else throw error;
                    }
                }
            }
        }
        if (this.host._chartHistory?.failed) await this.host._recoverChartHistory();
        if (this.host._downloadRunning)
            throw Object.assign(new Error(this.host._t("live.downloadRunning")), { i18nKey: "live.downloadRunning" });
        if (this.host._chipInfoRunning)
            throw Object.assign(new Error(this.host._t("live.chipReading")), { i18nKey: "live.chipReading" });
        if (this.host._agentOps.readRunning)
            throw Object.assign(new Error(this.host._t("live.agentReading")), { i18nKey: "live.agentReading" });
        if (this.starting) throw Object.assign(new Error(this.host._t("live.starting")), { i18nKey: "live.starting" });
        const debuggerCfg =
            this.host._context.workspaceState.get(CACHE_KEYS.debugger) ||
            (await this.host._probeConnectionService.resolveProbe());
        const mcuCore = this.host._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore)
            throw Object.assign(new Error(this.host._t("live.needConfig")), { i18nKey: "live.needConfig" });
        if (this.host._elfService?.workerPath && this.host._context.workspaceState.get(CACHE_KEYS.elfPath)) {
            await this.host._elfService.ready();
            await this.host._elfView.rebindPromise;
        }
        if (generation !== this._startGeneration) return;
        {
            this.intent = true;
            this.host._samplingCoordinator.setDebugIntent(this.host._debugBridge, true);
        }
        if (intervalMs !== undefined) this.setIntervalMs(intervalMs);
        const activeItems = this.activeReadPlan();
        if (
            this.host._debugBridge.hasSession ||
            isSupportedDebugSession(this.host.debugLaunch.liveSession()) ||
            this.host.debugLaunch.starting ||
            this.host.debugLaunch.commandPending
        ) {
            const managedRunning =
                !!this.host.debugLaunch.managedServer &&
                !!this.host.debugLaunch.managedSessionId &&
                this.host._debugBridge.hasSession &&
                !this.host._debugBridge.paused;
            if (managedRunning && activeItems.length) {
                this.host.debugLaunch.handleTargetState({
                    state: "continued",
                    epoch: this.host._debugBridge.stopEpoch,
                    session: this.host._debugBridge.activeSession
                });
            }
            const status = managedRunning
                ? {
                      mode: "debug-running-connecting",
                      key: "live.debugSharedConnecting",
                      source: "openocd",
                      canRead: false,
                      canWrite: false,
                      snapshotReady: false,
                      intentEnabled: true,
                      running: true
                  }
                : this.host._debugBridge.hasSession
                  ? this.host._debugBridge.status(activeItems.length ? {} : { key: "live.needVar" })
                  : {
                        mode:
                            this.host.debugLaunch.starting || this.host.debugLaunch.commandPending
                                ? "debug-running-waiting"
                                : "debug-session-conflict",
                        key:
                            this.host.debugLaunch.starting || this.host.debugLaunch.commandPending
                                ? "live.debugWaiting"
                                : "live.debugConflict",
                        source: "dap",
                        canRead: false,
                        canWrite: false,
                        snapshotReady: false
                    };
            this.host._postConsumerStatuses(status);
            return;
        }
        if (!activeItems.length) {
            this.host._postConsumerStatuses({ key: "live.needVar" });
            return;
        }
        {
            this.consumers.add("graph");
            this.consumers.add("sidebar");
        }
        if (this.running && this.session) {
            this.applySamplingPlan(this.session, this.activeReadPlan());
            if (intervalMs !== undefined) this.setIntervalMs(intervalMs);
            this.host._postConsumerStatuses({ key: "sb.sampling" });
            return;
        }
        const cfg = this._vscode.workspace.getConfiguration("emberprobe");
        const configuredExecutable = cfg.get("openocdPath", "openocd");
        if (generation !== this._startGeneration) return;
        const startingLease = this.host._probeCoordinator.acquire("liveStart");
        this._startLease = startingLease;
        let session = null;
        try {
            const executable = await this.host._resolveOpenOcdPath(configuredExecutable);
            if (startingLease.released || generation !== this._startGeneration) return;
            if (!executable)
                throw Object.assign(new Error(this.host._t("live.notReady")), { i18nKey: "live.notReady" });
            const { cwd } = this.host._commandContext();
            const connection = await this.host._probeConnectionService.prepare(
                { executable, probe: debuggerCfg, target: mcuCore, sampling: true },
                interactive
            );
            if (startingLease.released || generation !== this._startGeneration) return;
            const port = await this.host._resolveTclPort(cfg);
            if (startingLease.released || generation !== this._startGeneration) return;
            this.exitUnconfirmed = false;
            session = new this._LiveWatchSession(
                this._vscode,
                {
                    executable,
                    isolated: true,
                    transport: this._vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                    probe: debuggerCfg,
                    target: mcuCore,
                    ...connection,
                    cwd,
                    port,
                    intervalMs: validation.clampInteger(intervalMs ?? this.intervalMs, this.intervalMs, 5, 10000)
                },
                {
                    onConnectionConfirmed: () => {
                        if (!startingLease.released && this.session === session)
                            void this.host._probeConnectionService.recordSuccess(session.options);
                        else if (this.running && this.session === session)
                            void this.host._probeConnectionService.recordSuccess(session.options);
                    },
                    onSample: (samples, t, consumers) => {
                        if (
                            this.session === session &&
                            !this.closing &&
                            !this.exitUnconfirmed &&
                            !session.stopped &&
                            !session.connectionFailed
                        )
                            this.handleRawSamples(samples, t, consumers);
                    },
                    onSampleGap: () => {
                        if (this.session === session && !this.closing && !session.stopped) this.handleSampleGap();
                    },
                    onStatus: (msg) => {
                        if (this.session === session && !this.closing && !this.exitUnconfirmed)
                            this.host._postConsumerStatuses(msg);
                    },
                    onError: (msg) => {
                        if (this.session === session) this.host._postLive({ type: "liveError", ...toUiError(msg) });
                    },
                    onDisconnect: (err) => {
                        if (this.session !== session) return;
                        const stopped = this.stop({ discardPending: true });
                        const stoppedGeneration = this._startGeneration;
                        void Promise.resolve(stopped)
                            .then(() => {
                                if (this.session || stoppedGeneration !== this._startGeneration) return;
                                this.host._postConsumerStatuses(
                                    {
                                        key: err?.i18nKey || "live.connectionClosed",
                                        params: err?.i18nParams,
                                        diagnostic: serializeError(err),
                                        source: "none",
                                        connectionState: "disconnected"
                                    },
                                    true
                                );
                            })
                            .catch(() => {});
                    }
                }
            );
            this.session = session;
            if (generation !== this._startGeneration) return;
            this.applySamplingPlan(session, this.activeReadPlan());
            this.session = session;
            await session.start();
            if (this.session !== session || startingLease.released || generation !== this._startGeneration) return;
            this.host._samplingCoordinator.setDeliveryHold(session);
            session.setSamplingEnabled(!!this.intent);
            this._lease = startingLease.transition("liveWatch");
            this.setIntervalMs(intervalMs ?? this.intervalMs);
            this.host._postConsumerStatuses({ key: this.intent ? "sb.sampling" : "sb.stopped" });
        } catch (error) {
            if (session && this.session === session) {
                const closed = await session.stop().catch(() => false);
                if (closed !== false) {
                    this.session = null;
                    if (this.running) this._lease?.release();
                }
            }
            this.consumers.clear();
            this.host._postConsumerStatuses(
                {
                    key: error.i18nKey,
                    params: error.i18nParams,
                    message: error.message,
                    diagnostic: serializeError(error)
                },
                true
            );
            throw error;
        } finally {
            if (!session || this.session !== session) startingLease.release();
        }
    }
    stop(options = {}) {
        this._startGeneration = (this._startGeneration || 0) + 1;
        if (options.discardPending) {
            for (const entry of this.host._livePanels?.values() || []) {
                entry._pendingScalars = [];
                entry._pendingComposites = [];
            }
            this.host._pendingSidebarScalars = [];
            this.host._pendingSidebarComposites = [];
        }
        const historyFlushed = this.host._flushPendingChartHistorySamples();
        this._flushPendingWebviewSamples();
        const preserveIntent = !!options.preserveIntent;
        this.consumers.clear();
        if (!preserveIntent) {
            this.intent = false;
            this.host._debugBridge.setIntent(false);
            this.host.debugLaunch.managedServer?.setSamplingEnabled(false);
        }
        this.session?.setSamplingEnabled?.(false);
        this.closing = !!(this._startPromise || this.session);
        this.exitUnconfirmed = false;
        this.host._postConsumerStatuses(
            preserveIntent && this.host._debugBridge.hasSession
                ? this.host._debugBridge.status()
                : {
                      key: this.closing ? "live.disconnecting" : preserveIntent ? "live.restoring" : "sb.stopped"
                  }
        );
        if (this.stopPromise) return this.stopPromise;
        const pending = this._startPromise;
        if (!pending && !this.session) {
            this._startLease?.release();
            this._lease?.release();
            return null;
        }
        this.stopPromise = (async () => {
            if (pending) await pending.catch(() => {});
            const session = this.session;
            if (session && (await session.stop()) === false)
                throw Object.assign(new Error("OpenOCD exit has not been confirmed"), {
                    code: "PROBE_EXIT_UNCONFIRMED",
                    i18nKey: "live.exitUnconfirmed"
                });
            await historyFlushed;
            if (this.session === session) this.session = null;
            this._startLease?.release();
            this._lease?.release();
            this.closing = false;
            this.host._postConsumerStatuses(
                preserveIntent && this.host._debugBridge.hasSession
                    ? this.host._debugBridge.status()
                    : {
                          key: preserveIntent ? "live.restoring" : "sb.stopped",
                          source: "none",
                          connectionState: "disconnected"
                      }
            );
            return true;
        })()
            .catch((error) => {
                this.exitUnconfirmed = true;
                this.host._postConsumerStatuses(
                    { key: "live.exitUnconfirmed", diagnostic: serializeError(error) },
                    true
                );
                throw error;
            })
            .finally(() => {
                this.closing = false;
                this.stopPromise = null;
                this.host._postProbeOperationStatus();
            });
        this.stopPromise.catch((error) => this.host._postLive?.({ type: "liveError", ...toUiError(error) }));
        return this.stopPromise;
    }
}

module.exports = { LiveWatchController, POINTER_EXPANDED_ONLY_STATE_KEY, UNLIMITED_SAMPLING_STATE_KEY };
