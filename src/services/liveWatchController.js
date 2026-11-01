"use strict";
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

// Live sampling for the sidebar and the chart panels: which variables each consumer reads, how the merged plan reaches
// the sampling session or the debug server, and the decode types of each consumer. host is the MainViewProvider.
class LiveWatchController {
    constructor(host) {
        this.host = host;
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
        const server = this.host._managedDebugServer;
        if (!server || server.capabilities?.runtimeRead === false) return [];
        const plan = this.runtimeRamPlan(this.activeReadPlan());
        const itemKey = (items) => items.map((item) => `${item.name}:${item.address}:${item.size}`).join("|");
        const deniedKey = itemKey(plan.denied);
        if (deniedKey && deniedKey !== this._runtimeDeniedKey) {
            this._runtimeDeniedKey = deniedKey;
            const t = Date.now();
            this.host._handleRawSamples(
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
            this.host._handleRawSamples(
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
            expansions.push(this.host._panelRuntimeExpansions(entry.watchKey));
        }
        // Sidebar cards read the parts they opened, like chart cards; write cards read runtime objects whole.
        lists.push(this.host._scalarWatchList(CACHE_KEYS.sidebarWatchList));
        expansions.push(this.host._panelRuntimeExpansions(CACHE_KEYS.sidebarWatchList));
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
                graphIntervalMs: this.host._liveIntervalMs,
                unlimited: this.host._unlimitedSamplingEnabled()
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
        this.host._refreshPointerPeripherals();
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
            this.host._samplingCoordinator.setDebugIntent(this.host._debugBridge, this.host._samplingIntent);
            if (
                this.host._managedDebugServer &&
                this.host._managedDebugServer.capabilities?.runtimeRead !== false &&
                this.host._managedDebugSessionId &&
                !this.host._debugBridge.paused
            ) {
                try {
                    const allowed = this.configureManagedRuntimeWatch();
                    const enabled = this.host._samplingCoordinator.setRuntimeEnabled(
                        this.host._managedDebugServer,
                        this.host._samplingIntent && allowed.length > 0,
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
                        intentEnabled: this.host._samplingIntent,
                        running: this.host._samplingIntent
                    });
                } catch (error) {
                    this.host._managedDebugServer.setSamplingEnabled(false);
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
            if (!active.length && this.host._samplingIntent)
                this.host._postConsumerStatuses(this.host._debugBridge.status({ key: "live.needVar" }));
            return;
        }
        if (this.host._liveSession) {
            if (active.length) this.applySamplingPlan(this.host._liveSession, active);
            else {
                this.host.stopLiveWatch({ preserveIntent: true });
                this.host._postConsumerStatuses({ key: "live.needVar" });
            }
            return;
        }
        if (this.host._externalDebug?.held) return;
        if (
            this.host._samplingIntent &&
            active.length &&
            !this.host._downloadRunning &&
            !this.host._debugStarting &&
            !this.host._debugCommandPending
        )
            await this.host.startLiveWatch(undefined, this.host._liveIntervalMs, "refresh");
        else if (this.host._samplingIntent && !active.length) this.host._postConsumerStatuses({ key: "live.needVar" });
    }
}

module.exports = { LiveWatchController };
