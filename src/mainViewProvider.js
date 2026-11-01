"use strict";
const {
    isSupportedDebugSession,
    resolveRtos,
    normalizeDebugServerOptions,
    startupTrace
} = require("./services/debugConfiguration");
const { OpenOcdDebugController, allocateDebugPorts } = require("./services/debugServerController");
const { SharedDebugGroup } = require("./services/sharedDebugGroup");
const { resolvePrettyPrinting, configuredPrettyPrintingMode } = require("./services/prettyPrinting");
const { normalizeDebugImages } = require("./services/debugImages");
const { ExternalDebugService, resolveExternalSettings } = require("./services/externalDebugService");
Object.defineProperty(exports, "__esModule", { value: true });
exports.MainViewProvider = void 0;
const vscode = require("vscode");
const path = require("path");
const modernView = require("./modernView");
const { versionLabel } = require("./buildInfo");
const autoDetect = require("./autoDetect");
const { ELF_FILE_GLOB } = require("../skills/_emberprobe/target-detection");
const skillInstaller = require("./skillInstaller");
const openocdRunner = require("./openocdRunner");
const openocdChecker = require("./openocdChecker");
const liveWatch = require("./liveWatch");
const { isNonHaltingWordWrite, runtimeWriteDisabledError, withWriteAccessStatus } = require("./writeAccess");
const liveWatchView = require("./liveWatchView");
const { configuredFrequencyHz, intervalMsFromHz } = require("./samplingFrequency");
const elfSymbols = require("./elfSymbols");
const dwarf = require("./dwarf");
const chipInfo = require("./chipInfo");
const faultInfo = require("./faultInfo");
const validation = require("./validation");
const { variableDisplayName, variableScope, writeUnavailableKey } = require("./webview/runtime");
const { displayWarnings } = require("./webview/elfDiagnostics");
const openocdScripts = require("./openocdScripts");
const { AgentBridge } = require("./agentBridge");
const { WriteAuthorization, writeConnectionIdentity } = require("./writeAuthorization");
const { CubeMxService } = require("./services/cubemxService");
const { CubeMxConfiguration } = require("./services/cubemxConfiguration");
const { CubeMxFirmware } = require("./services/cubemxFirmware");
const { PeripheralWriteAuthorization } = require("./peripheralWriteAuthorization");
const { FlashAuthorization } = require("./flashAuthorization");
const { ProbeCoordinator, PROBE_OPERATIONS } = require("./probeCoordinator");
// Operations that hold the workspace's probe; the refresh's own chip reads do not.
const PROBE_OPERATIONS_IN_USE = PROBE_OPERATIONS.filter((name) => name !== "targetScan");
const { ConfigurationStore, assertAgentSettable } = require("./services/configurationStore");
const { FlashService } = require("./services/flashService");
const { FirmwareRecord } = require("./services/firmwareRecord");
const { AgentFlashService } = require("./services/agentFlashService");
const { FaultService } = require("./services/faultService");
const { AgentService } = require("./services/agentService");
const { createAgentRoutes } = require("./services/agentRoutes");
const agentPlans = require("./services/agentPlans");
const { createSidebarHandler } = require("./controllers/sidebarRoutes");
const { createLivePanelHandler } = require("./controllers/livePanelRoutes");
const { ElfService } = require("./services/elfService");
const { MemoryAnalysisController } = require("./services/memoryAnalysisController");
const { OpenOcdStatusService } = require("./services/openocdStatusService");
const { SkillStatusService, hasWorkspaceSkills, legacyGlobalSkills } = require("./services/skillStatusService");
const { BridgeRegistry, cleanupStaleEntries } = require("./services/bridgeRegistry");
const { McpRegistration } = require("./services/mcpRegistration");
const { DEFAULT_TOOLSETS, TOOLSETS } = require("./mcp/tools");
const { ChipInfoService } = require("./services/chipInfoService");
const { ProbeConnectionService } = require("./services/probeConnectionService");
const { ProbeDriverService } = require("./services/probeDriverService");
const { resolveJlinkDriverTarget } = require("./services/jlinkDriverChoice");
const { ProbeSelectionStore } = require("./services/probeSelectionStore");
const { ProbeInventoryService } = require("./services/probeInventoryService");
const { waitForJlinkReady } = require("./services/jlinkProbeReady");
const { listProbes } = require("../skills/_emberprobe/probe-inventory");
const { assertWriteIdentity, probeFamily } = require("../skills/_emberprobe/probe-connection");
const { flashSpeedKhz } = require("../skills/_emberprobe/openocd-flash");
const { serializeError, toUiError } = require("./services/errorEnvelope");
const { describeTargetIdentity, describeTargetCore, sameTarget, targetMatchesModel } = require("./chip/targetIdentity");
const { NoticeService, COMMAND_FAILURE_TITLES } = require("./services/noticeService");
const {
    LiveWatchService,
    buildChartHistoryItems,
    selectFocusedPanel,
    selectPausedDebugReadSession,
    writableRamSectionRanges,
    debugReadPlanKey
} = require("./services/liveWatchService");
const { normalizeRuntimeExpansions } = require("./services/runtimeExpansion");
const { RuntimeSampleHold } = require("./services/runtimeSampleHold");
const { PointerSymbolizer } = require("./services/pointerSymbolizer");
const { WatchListStore } = require("./services/watchListStore");
const { LivePanelRegistry } = require("./services/livePanelRegistry");
const { SamplingCoordinator } = require("./services/samplingCoordinator");
const { DebugSessionBridge, MIN_DAP_INTERVAL_MS } = require("./services/debugSessionBridge");
const { SvdManager } = require("./services/svdManager");
const { SvdPeripheralService } = require("./services/svdPeripheralService");
const { PeripheralViewService } = require("./services/peripheralViewService");
const { RtosViewService } = require("./services/rtosViewService");
const { addPeripheralViewerSvd } = require("./services/peripheralViewerIntegration");
const { DebugControlService } = require("./services/debugControlService");
const { SamplingArchive, cleanupStaleSamplingArchives } = require("./services/samplingArchive");
const { ChartHistoryService, estimateHistoryBytes, MAX_BACKLOG_BYTES } = require("./services/chartHistoryService");
const { ensureDebugTools, findWarmupDebugTools } = require("./services/debugToolPreflight");
const { GdbWarmup } = require("./services/gdbWarmup");
const { externalizeWebviewHtml, pruneWebviewAssets } = require("./webviewAssets");
const fs = require("fs");
const crypto = require("crypto");
const i18n = require("./i18n");
const { DebugLifecycle, DEBUG_STARTUP_TIMEOUT_MS } = require("./services/debugLifecycle");
const { DEBUGGER_LIST, MCU_CORE_LIST } = require("./services/targetCatalog");
const { CACHE_KEYS } = require("./cacheKeys");
const JLINK_DRIVER_WARNING_IGNORED_KEY = "mcu.jlinkDriverWarningIgnored";
// Opened runtime paths per chart watch list, so a restarted chart samples the same parts.
const RUNTIME_EXPANSIONS_STATE_KEY = "liveWatch.runtimeExpansions";
const AGENT_ACCESS_STATE_KEY = "emberprobe.agentAccess";
const MCP_CONFIGURED_STATE_KEY = "emberprobe.mcpConfigured";
// Curve visibility per chart watch list, so a chart reopened after a restart shows the same curves.
const CURVE_VISIBILITY_STATE_KEY = "liveWatch.curveVisibility";
const MAX_CURVE_VISIBILITY_ENTRIES = 4096;
// Backoff before each chart-history worker restart attempt (at most three per run/clear).
const CHART_HISTORY_RECOVERY_DELAYS_MS = Object.freeze([250, 1000, 3000]);
function cleanWindowsPath(rawPath) {
    return validation.cleanWindowsPath(rawPath);
}
// Builds the symbol name index: original names (stable identities) first, plus unique displayName aliases so C++
// qualified names resolve. Resolved watch and write items still store the original symbol.name; displayName only serves
// lookups.
function buildSymbolNameIndex(symbols) {
    const list = Array.isArray(symbols) ? symbols : [];
    const byName = new Map(list.map((symbol) => [symbol.name, symbol]));
    const displaySeen = new Map();
    for (const symbol of list) {
        const dn = symbol.displayName;
        if (!dn || dn === symbol.name) continue;
        displaySeen.set(dn, displaySeen.has(dn) ? null : symbol);
    }
    for (const [dn, symbol] of displaySeen) {
        if (symbol && !byName.has(dn)) byName.set(dn, symbol);
    }
    return byName;
}
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

const {
    LiveWatchController,
    POINTER_EXPANDED_ONLY_STATE_KEY,
    UNLIMITED_SAMPLING_STATE_KEY
} = require("./services/liveWatchController");
// The sampling controller uses this module's vscode and LiveWatchSession, which tests replace through loadProvider.
function createSamplingController(host, settings = {}) {
    return new LiveWatchController(host, { vscode, LiveWatchSession: liveWatch.LiveWatchSession, ...settings });
}
class MainViewProvider {
    // Created on first use, so the provider's construction order does not matter.
    get _sampling() {
        return (this._samplingController ??= createSamplingController(this));
    }
    constructor(context) {
        this.commandHandlers = {};
        this._context = context;
        // Created by the `_notices` getter.
        this._noticeService = null;
        // The connected probe list's automatic chip read (_identifyConnectedTargets).
        this._probeTargetsReading = false;
        this._probeTargetsReadFor = "";
        /** @type {readonly number[]} */
        this._chartHistoryRecoveryDelaysMs = CHART_HISTORY_RECOVERY_DELAYS_MS;
        this._webviewAssetRootUri = vscode.Uri.joinPath(context.globalStorageUri, "webview-assets");
        // Language priority: an explicit user choice (globalState) > the VS Code display language (zh-* -> Chinese,
        // anything else -> English)
        const savedLang = context.globalState.get("emberprobe.lang");
        this._lang = i18n.SUPPORTED_LANGS.includes(savedLang) ? savedLang : i18n.matchVscodeLang(vscode.env.language);
        this._probeCoordinator = new ProbeCoordinator(() => this._postProbeOperationStatus());
        this._externalDebug = new ExternalDebugService({
            state: context.workspaceState,
            coordinator: this._probeCoordinator,
            settings: (folder) => vscode.workspace.getConfiguration("emberprobe", vscode.Uri.file(folder))
        });
        void this._externalDebug.releaseIfDisabled().catch(console.error);
        this._managedDebugServer = null;
        this._managedDebugGroup = null;
        this._managedDebugToken = "";
        this._managedDebugSessionId = "";
        this._runtimeResumeTimer = null;
        this._runtimeSampleHold = new RuntimeSampleHold();
        this._livePanels = new Map();
        this._livePanelRegistry = null;
        /** @type {WeakMap<object[], { length: number, index: Map<string, any> }>} */
        this._symbolNameIndexes = new WeakMap();
        /** @type {Set<Promise<void>>} */
        this._pendingChartHistoryAppends = new Set();
        this._queuedChartHistoryBytes = 0;
        this._webviewRenders = new WeakMap();
        this._livePanelFocusOrder = 0;
        this._liveWatchService = new LiveWatchService(
            elfSymbols,
            // Pointer offsets into structs resolve to member paths once the target layout is loaded.
            new PointerSymbolizer(null, { requestLayout: (name) => this._elfService?.layout(name) })
        );
        this._latestSidebarSamples = this._liveWatchService.latestSidebarSamples;
        this._samplingCoordinator = new SamplingCoordinator();
        this._debugCommandPending = false;
        this._debugLifecycle = new DebugLifecycle();
        this._gdbWarmup = new GdbWarmup();
        this._gdbWarmupTimer = null;
        this._terminatedDebugSessionIds = new Set();
        this._debugSessionReleases = new Map();
        this._debugReadPlanKey = "";
        this._shutdownPromise = null;
        this._samplingController = createSamplingController(this, {
            frequencyHz: configuredFrequencyHz(vscode.workspace.getConfiguration("emberprobe")),
            unlimited: context.workspaceState.get(UNLIMITED_SAMPLING_STATE_KEY) === true,
            pointerExpandedOnly: context.workspaceState.get(POINTER_EXPANDED_ONLY_STATE_KEY) !== false
        });
        /** @type {{ t: number, bytes: number }[]} Recent archive sizes for the remaining-time estimate. */
        this._archiveRateSamples = [];
        this._watchLists = new WatchListStore({
            state: context.workspaceState,
            serialize: (items) => this._watchIdentities(items),
            normalize: (items, symbols, key) => {
                // Current name -> persisted name, for items whose CU-qualified identity changed.
                const renamed = new Map();
                const changes = this._watchNameChanges;
                const normalized = validation.normalizeWatchList(items, symbols, {
                    onRename: (from, to) => {
                        renamed.set(to, from);
                        changes?.renamed.set(from, to);
                    },
                    onAmbiguous: (name, candidates) => changes?.ambiguous.set(name, candidates)
                });
                if (key !== CACHE_KEYS.sidebarWriteList) return normalized;
                const previous = new Map(items.map((item) => [item.name, item]));
                return normalized.map((item) => {
                    const { min, max, value } = previous.get(renamed.get(item.name) || item.name) || {};
                    return { ...item, min, max, value };
                });
            },
            symbols: () => this.readElfSymbols().symbols,
            onChanged: () => this._sampling.invalidateConsumerTypes(),
            onError: (error) => console.error("Watch list unavailable:", error.message)
        });
        this._agentReadSession = null;
        this._agentReadCancelled = false;
        // Running variables.sample loops, so cancellation can stop them during an interval wait.
        this._agentSampleRuns = new Set();
        this._agentSamplingStatus = null;
        this._uiWritePromise = Promise.resolve();
        this._uiWriteTicket = 0;
        this._uiWriteLatest = new Map();
        this._debugBridge = new DebugSessionBridge({
            getReadPlan: () => this._sampling.activeReadPlan(),
            getRamSectionRanges: () => writableRamSectionRanges(this.readElfSymbols().memory?.sections),
            getIntervalMs: () => Math.max(MIN_DAP_INTERVAL_MS, this._sampling.intervalMs),
            onSamples: (samples, t) => this._sampling.handleRawSamples(samples, t),
            onStatus: (status) => {
                this._syncDebugSampleContext();
                this._postProbeOperationStatus();
                this._postConsumerStatuses(status, !!status.error);
                this._postPeripheralDebugStatus();
            },
            onError: (error) =>
                this._postLive({
                    type: "liveError",
                    ...toUiError(error)
                }),
            onTargetState: (event) => this._handleManagedTargetState(event),
            beforePausedRead: () => this._quiesceManagedRuntimeRead()
        });
        this._rtosViewService = new RtosViewService(this._debugBridge);
        const archiveLimitMiB = validation.clampInteger(
            vscode.workspace.getConfiguration("emberprobe").get("samplingArchiveMaxMiB", 1024),
            1024,
            64,
            102400
        );
        cleanupStaleSamplingArchives(context.globalStorageUri.fsPath);
        this._samplingArchive = new SamplingArchive({
            rootDir: path.join(
                context.globalStorageUri.fsPath,
                `sampling-history-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
            ),
            maxBytes: archiveLimitMiB * 1024 * 1024,
            onWritten: (bytes) =>
                this._chartHistory?.archiveProgress({
                    dataPath: this._samplingArchive.dataPath,
                    bytes,
                    limited: this._samplingArchive.limitReached || !!this._samplingArchive.failed
                }),
            onBackpressure: (paused) => this._sampling.setArchiveBackpressure(paused),
            onError: (error) => {
                this._chartHistory?.archiveProgress(
                    {
                        dataPath: this._samplingArchive.dataPath,
                        bytes: this._samplingArchive.indexedBytes,
                        limited: true
                    },
                    true
                );
                this._sampling.stop();
                this._postLive({ type: "liveError", ...toUiError(error) });
            }
        });
        this._chartHistory = new ChartHistoryService({
            workerPath: path.join(__dirname, "chartHistoryWorker.js"),
            maxBytes:
                validation.clampInteger(
                    vscode.workspace.getConfiguration("emberprobe").get("chartHistoryMaxMiB", 512),
                    512,
                    64,
                    4096
                ) *
                1024 *
                1024,
            onUpdated: (message) => {
                if (message.limited) this._warnChartHistoryLimited();
                for (const entry of this._livePanels.values())
                    if (this._debugSamplingScope(entry.watchKey) === message.scope && entry.ready)
                        entry.post({
                            ...message,
                            type: "chartHistoryStatus",
                            historyRevision: entry.historyRevision || 0
                        });
            },
            onError: (error) => this._handleChartHistoryError(error)
        });
        this._writeAuthorization = new WriteAuthorization(context.workspaceState);
        this._peripheralWriteAuthorization = new PeripheralWriteAuthorization();
        this._flashAuthorization = new FlashAuthorization({ storage: context.workspaceState });
        this._firmwareRecord = new FirmwareRecord(context.workspaceState);
        this._configurationStore = new ConfigurationStore({
            vscode,
            context,
            cacheKeys: CACHE_KEYS,
            cleanPath: cleanWindowsPath,
            isSafeCfg: openocdRunner.isSafeCfg,
            beforeChange: (values) => this._assertConnectionEditable(values),
            onChanged: async () => {
                await this._refreshElfBindings();
                this.updateView();
                for (const entry of this._livePanels.values()) this._syncGraphTarget(entry);
            }
        });
        this._probeDriverService = new ProbeDriverService({
            extensionPath: context.extensionPath,
            verifyReady: async (connection) => {
                const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
                const executable = await this._resolveOpenOcdPath(configured);
                if (!executable)
                    throw Object.assign(new Error("OpenOCD is required to verify that J-Link is ready"), {
                        i18nKey: "notice.openocdRequired"
                    });
                await waitForJlinkReady(executable, connection.probeSerial);
            },
            onStatus: (status) => {
                this._webviewView?.webview.postMessage({ type: "probeDriverStatus", ...status });
                this._notifyProbeDriverStatus(status);
            },
            log: (message) => {
                console.log(message);
                if (this._chipOutput) this._chipOutput.appendLine(message);
            }
        });
        this._probeConnectionService = new ProbeConnectionService({
            getConfig: () => this._configurationStore.snapshot(),
            getSuccessfulConnection: () => this._probeSelectionStore().get(),
            saveSuccessfulConnection: (value) =>
                value === undefined ? this._probeSelectionStore().clear() : this._probeSelectionStore().set(value),
            onResolved: (connection) => {
                this._resolvedProbeConnection = connection;
                this.updateView();
            },
            driverService: this._probeDriverService,
            identifyTarget: (request) => this._probeConnectionService.readTargetIdentity(request),
            onTargetStateChanged: () =>
                this._refreshConnectedProbes().catch((error) =>
                    console.error("Probe list refresh failed:", error.message)
                ),
            onDriverUnsupported: (error) => this._showJlinkDriverWarning(error.details || {}),
            beforePrepare: () => this._assertProbeDriverIdle(),
            onSelectionRequired: () => this._revealConnectedProbes()
        });
        this._cubemxFirmware = new CubeMxFirmware({
            vscode,
            context,
            changed: () => this.updateView(),
            t: (key) => this._t(key),
            notify: (notice) =>
                this._notices.notify(
                    "config",
                    "mcu-vscode.installCubeMxFirmware",
                    notice.message ? { ...notice, key: undefined, titleKey: notice.key, text: notice.message } : notice
                )
        });
        this._cubemxConfiguration = new CubeMxConfiguration({
            vscode,
            context,
            changed: () => this.updateView(),
            t: (key) => this._t(key)
        });
        this._cubemxService = new CubeMxService({
            storage: context.workspaceState,
            storageDir: context.globalStorageUri?.fsPath,
            config: () => this._configurationStore.snapshot(),
            roots: () => (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath)
        });
        this._flashService = new FlashService(openocdRunner);
        this._faultService = new FaultService(faultInfo, elfSymbols);
        this._elfService = new ElfService({
            context,
            cacheKey: CACHE_KEYS.elfPath,
            fs,
            crypto,
            elfSymbols,
            dwarf,
            workerPath: path.join(__dirname, "elfWorker.js"),
            onChange: (phase, result, entries) => {
                this._liveWatchService.setElfResult(result, true);
                return this._onElfChange(phase, result, entries);
            },
            cleanPath: cleanWindowsPath,
            t: (key, params) => this._t(key, params)
        });
        this._openOcdStatusService = new OpenOcdStatusService({
            vscode,
            context,
            checker: openocdChecker,
            getLang: () => this._lang,
            onStatus: (status) => this._webviewView?.webview.postMessage({ type: "openocdStatus", ...status })
        });
        this._skillStatusService = new SkillStatusService({
            vscode,
            context,
            installer: skillInstaller,
            getLang: () => this._lang,
            t: (key, params) => this._t(key, params),
            notify: (notice) => this._notices.notify("global", "mcu-vscode.manageAgentSkills", notice),
            onStatus: (status) => this._webviewView?.webview.postMessage({ type: "skillStatus", ...status })
        });
        this._chipInfoService = new ChipInfoService({
            vscode,
            context,
            cacheKeys: CACHE_KEYS,
            chipInfo,
            coordinator: this._probeCoordinator,
            t: (key, params) => this._t(key, params),
            resolveExecutable: (executable) => this._resolveOpenOcdPath(executable),
            prepareConnection: (options, interactive) => this._probeConnectionService.prepare(options, interactive),
            resolveProbe: () => this._probeConnectionService.resolveProbe(),
            recordSuccess: (connection) => this._probeConnectionService.recordSuccess(connection),
            commandContext: () => this._commandContext(),
            onPost: (message) => this._webviewView?.webview.postMessage(message),
            onDiagnostics: (diag, info) => this._writeChipDiagnostics(diag, info),
            isDebugActive: () => !!this._liveDebugSession()
        });
        this._svdManager = new SvdManager({
            workerPath: path.join(__dirname, "svdWorker.js"),
            vscode,
            context,
            cacheKeys: CACHE_KEYS,
            t: (key, params) => this._t(key, params),
            getChipInfo: () => this._chipInfoService.info,
            notify: (notice) =>
                this._notices.notify(
                    "config",
                    "svd",
                    notice.error ? { level: "error", titleKey: "notice.svdFailed", error: notice.error } : notice
                ),
            onStatus: (status) => {
                this._sampling.peripheralsChanged();
                this._webviewView?.webview.postMessage({ type: "svdStatus", ...status });
            }
        });
        this._svdPeripheralService = new SvdPeripheralService({
            workerPath: path.join(__dirname, "svdWorker.js"),
            loadBoundSvd: () => this._svdManager.peekBound(this._commandContext().folder),
            debugBridge: this._debugBridge,
            authorization: this._peripheralWriteAuthorization
        });
        this._peripheralViewService = new PeripheralViewService({
            peripherals: this._svdPeripheralService,
            debugBridge: this._debugBridge
        });
        this._debugControlService = new DebugControlService({
            vscode,
            debugBridge: this._debugBridge,
            workspaceProvider: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            startDebug: () => this.commandHandlers["mcu-vscode.debug"](undefined, undefined, false),
            waitForRelease: (session) => this._debugSessionReleased(session)
        });
        this._agentFlashService = new AgentFlashService({
            getConfig: () => this._configurationStore.snapshot(),
            coordinator: this._probeCoordinator,
            authorization: this._flashAuthorization,
            prepare: (options, settings) => this._probeConnectionService.prepare(options, settings),
            recordSuccess: (connection) => this._probeConnectionService.recordSuccess(connection),
            recordFlashed: (entry) => this._firmwareRecord.record(entry),
            isDebugActive: () => this._debugBridge.hasAnySession || !!this._liveDebugSession()
        });
        // VS Code started the EmberProbe MCP server in this window (the user accepted the MCP trust prompt).
        this._mcpBridgeRequested = false;
        this._bridgeRegistry = null;
        const storageDir = context.globalStorageUri?.fsPath;
        if (storageDir) {
            // One instance entry per window; startup also removes entries whose host process has exited.
            this._bridgeRegistry = new BridgeRegistry({
                storageDir,
                hostApp: vscode.env?.appName || "",
                extensionVersion: context.extension?.packageJSON?.version || ""
            });
            cleanupStaleEntries(storageDir).catch(() => {});
        }
        this._agentService = new AgentService({
            Bridge: AgentBridge,
            isTrusted: () => vscode.workspace.isTrusted,
            workspaceProvider: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            workspaceFoldersProvider: () =>
                (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath),
            // The Bridge descriptor (with token) goes to globalStorage and the workspace keeps only a pointer, so the
            // token cannot leak through git or cloud sync
            storageDirProvider: () => this._context.globalStorageUri.fsPath,
            registry: this._bridgeRegistry,
            onCall: (_method, _params, meta) => this._warnIfSkillsModified(meta),
            onAudit: (entry) => this._auditAgentCall(entry),
            handlers: createAgentRoutes(this)
        });
        this._mcpRegistration = new McpRegistration({
            vscode,
            context,
            t: (key, params) => this._t(key, params),
            isAvailable: () => this._mcpAvailable(),
            isEnabled: () =>
                this._mcpAvailable() && this._agentAccessDecision(this._skillStatusService.lastStatus).enabled,
            instanceId: () => this._agentService.instanceId(),
            toolsets: () => this._mcpToolsets(),
            onResolve: () => this._requestMcpBridge(),
            onConfigured: () => this._markMcpConfigured()
        });
        this.registerCommandHandlers();
    }
    get _downloadRunning() {
        return this._probeCoordinator?.isActive("download") ?? false;
    }
    get _chipInfoRunning() {
        return this._probeCoordinator?.isActive("chipInfo") ?? false;
    }
    get _agentReadRunning() {
        return this._probeCoordinator?.isActive("agentRead") ?? false;
    }
    get _debugStarting() {
        return this._probeCoordinator?.isActive("debugStart") ?? false;
    }
    // Current UI language (Simplified Chinese/English), switched from the sidebar or live panel title button and
    // persisted in global state
    _t(key, params) {
        return i18n.t(this._lang, key, params);
    }
    // Created on first use, so providers assembled without the constructor still report notices.
    get _notices() {
        this._noticeService ||= new NoticeService({
            vscode,
            t: (key, params) => this._t(key, params),
            view: () => this._webviewView
        });
        return this._noticeService;
    }
    async _copyToClipboard(text) {
        const value = text ? String(text) : "";
        if (!value) return;
        try {
            await vscode.env.clipboard.writeText(value);
        } catch (error) {
            vscode.window.showErrorMessage(this._t("common.copyFailed", { message: error.message }));
        }
    }
    _setLang(lang) {
        this._lang = i18n.normalizeLang(lang);
        this._context.globalState.update("emberprobe.lang", this._lang);
        for (const entry of this._livePanels.values())
            entry.panel.title = this._t("lw.panelTitle", { n: entry.panelId });
        // Running built-in debug sessions switch the language of their error messages too.
        for (const session of this._debugBridge?.allSessions.values() || [])
            if (session.type === "emberprobe")
                Promise.resolve(session.customRequest?.("emberprobe.setLanguage", { lang: this._lang })).catch(() => {
                    // A session that is ending keeps its language.
                });
        return this._lang;
    }
    _commandContext(resource) {
        if (resource?.fsPath) {
            const folder = vscode.workspace.getWorkspaceFolder(resource) || vscode.workspace.workspaceFolders?.[0];
            return { folder, cwd: resource.fsPath };
        }
        const elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        if (elfPath) {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(elfPath));
            if (folder) return { folder, cwd: folder.uri.fsPath };
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        return { folder, cwd: folder?.uri.fsPath };
    }
    _postPeripheralDebugStatus(post = (message) => this._webviewView?.webview.postMessage(message)) {
        this._postProbeOperationStatus();
        if (!this._debugBridge) return;
        this._rtosViewService ||= new RtosViewService(this._debugBridge);
        post(this._rtosViewService.status());
        const status = this._debugBridge.agentStatus();
        post({
            type: "peripheralDebugStatus",
            state: status.state,
            epoch: status.epoch,
            canRead: status.paused && !this._debugBridge.replBusy && status.capabilities.read === true,
            canWrite: status.paused && !this._debugBridge.replBusy && status.capabilities.write === true
        });
    }
    _postOpenOcdStatus(status) {
        this._openOcdStatusService.post(status);
    }
    async refreshOpenOcdStatus(showChecking = true) {
        return this._openOcdStatusService.refresh(showChecking);
    }
    async _handleOpenOcdAction(action) {
        if (action === "select") this._assertConnectionEditable({ openocdPath: true });
        return this._openOcdStatusService.handleAction(action);
    }
    // Resolves a usable OpenOCD path before programming, debugging or live watch; a missing OpenOCD is only reported to
    // the sidebar.
    async _resolveOpenOcdPath(executable) {
        return this._openOcdStatusService.resolve(executable);
    }
    registerCommandHandlers() {
        this.commandHandlers["mcu-vscode.autoDetect"] = async () => this.runAutoDetect(true);
        this.commandHandlers["mcu-vscode.selectCubeMx"] = () => this._cubemxConfiguration.select("cubemx");
        this.commandHandlers["mcu-vscode.selectIoc"] = () => this._cubemxConfiguration.select("ioc");
        this.commandHandlers["mcu-vscode.installCubeMxFirmware"] = () => this._cubemxFirmware.install();
        this.commandHandlers["mcu-vscode.manageAgentSkills"] = async () => this.manageAgentSkills();
        this.commandHandlers["mcu-vscode.enableAgentAccess"] = async () => this.setAgentAccess("enabled");
        this.commandHandlers["mcu-vscode.disableAgentAccess"] = async () => this.setAgentAccess("disabled");
        this.commandHandlers["mcu-vscode.cleanupGlobalSkills"] = async () => this.cleanupGlobalSkills();
        this.commandHandlers["mcu-vscode.installMcpServer"] = async () => this._mcpRegistration.installClient();
        this.commandHandlers["mcu-vscode.openLiveWatch"] = async () => this.openLiveWatchPanel();
        // Select ELF
        this.commandHandlers["mcu-vscode.selectElf"] = async () => {
            const cmd = "mcu-vscode.selectElf";
            try {
                const elfFiles = await vscode.workspace.findFiles(
                    ELF_FILE_GLOB,
                    "{**/node_modules/**,**/.git/**,**/CMakeFiles/**}",
                    100
                );
                if (elfFiles.length === 0) {
                    this._notices.notify("config", cmd, { level: "warning", key: "msg.noElfFound" });
                    return false;
                }
                const items = elfFiles.map((file) => {
                    const cleanPath = cleanWindowsPath(file.fsPath);
                    return {
                        label: path.basename(cleanPath),
                        description: cleanPath
                    };
                });
                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: this._t("msg.searchElf"),
                    matchOnDescription: true
                });
                if (!selected) return null;
                const finalPath = cleanWindowsPath(selected.description);
                await this._context.workspaceState.update(CACHE_KEYS.elfPath, finalPath);
                this.scheduleGdbWarmup(0);
                await this._refreshElfBindings();
                await this.updateView();
                return true;
            } catch (err) {
                console.error("Selecting ELF failed:", err.message);
                this._notices.notify("config", cmd, {
                    level: "error",
                    titleKey: COMMAND_FAILURE_TITLES[cmd],
                    error: err
                });
                throw err; // Reported above; callers outside the sidebar still see the failure.
            }
        };
        // Select debug probe
        this.commandHandlers["mcu-vscode.selectDebugger"] = async () => {
            this._assertConnectionEditable({ debugger: true });
            const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = await this._resolveOpenOcdPath(configured);
            // Offer the interface scripts the current OpenOCD actually ships, including vendor forks such as WCH.
            // Before OpenOCD is ready manual configuration still works with the built-in list.
            const discovered = executable ? openocdScripts.discoverInterfaceConfigs(executable) : [];
            const debuggers = discovered.length ? discovered : DEBUGGER_LIST;
            const selected = await vscode.window.showQuickPick(
                debuggers.map((cfg) => ({ label: cfg })),
                {
                    placeHolder: this._t("msg.searchDebugger")
                }
            );
            if (!selected) return null;
            const debuggerCfg = selected.label;
            this._assertConnectionEditable({ debugger: debuggerCfg });
            await this._context.workspaceState.update(CACHE_KEYS.debugger, debuggerCfg);
            await this._showDebuggerConfig();
            await this._refreshConnectedProbes();
            return true;
        };
        // Select MCU target
        this.commandHandlers["mcu-vscode.selectMcuCore"] = async () => {
            this._assertConnectionEditable({ mcu: true });
            const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = await this._resolveOpenOcdPath(configured);
            // Offer the targets the current OpenOCD actually ships, including vendor subdirectories such as geehy/*.
            // Before OpenOCD is ready manual configuration still works with the built-in list.
            const discovered = executable ? openocdScripts.discoverTargetConfigs(executable) : [];
            const targets = discovered.length ? discovered : MCU_CORE_LIST;
            const selected = await vscode.window.showQuickPick(
                targets.map((cfg) => ({ label: cfg })),
                {
                    placeHolder: this._t("msg.searchMcu")
                }
            );
            if (!selected) return null;
            const mcuCore = selected.label;
            this._assertConnectionEditable({ mcu: mcuCore });
            await this._context.workspaceState.update(CACHE_KEYS.mcuCore, mcuCore);
            await this.updateView();
            return true;
        };
        this.commandHandlers["mcu-vscode.attachDebug"] = (resource) =>
            this.commandHandlers["mcu-vscode.debug"](resource, undefined, true, { attach: true });
        this.commandHandlers["mcu-vscode.downloadOfficialSvd"] = () => this._svdManager.downloadOfficial();
        this.commandHandlers["mcu-vscode.selectExistingSvd"] = () => this._svdManager.selectExisting();
        this.commandHandlers["mcu-vscode.switchWorkspaceSvd"] = () => this._svdManager.switchBinding();
        // Start debugging. startOptions.attach keeps a managed OpenOCD but sends an attach request that only halts,
        // without reset or download, to preserve the current state.
        this.commandHandlers["mcu-vscode.debug"] = async (
            resource,
            configuration,
            interactive = true,
            startOptions
        ) => {
            let probePrepared = false;
            let startAccepted = false;
            let ownsPending = false;
            const cmd = startOptions?.attach ? "mcu-vscode.attachDebug" : "mcu-vscode.debug";
            const warn = (key) => {
                this._notices.notify("flash", cmd, { level: "warning", key });
                return false;
            };
            try {
                if (configuration?.servertype === "external")
                    throw new Error("Use an explicit F5 external attach configuration");
                this._externalDebug?.assertPhysicalAvailable();
                if (this._agentReadRunning) return warn("msg.agentReadBusy");
                if (this._debugCommandPending || this._debugStarting) return warn("msg.debugBusy");
                this._debugCommandPending = true;
                this._postProbeOperationStatus();
                ownsPending = true;
                this._debugStartupCmd = cmd;
                this._debugStartupErrorReported = false;
                this._debugStartupFailureCleanedUp = false;
                const startup = configuration?.performanceTrace ? startupTrace() : null;
                const serverOptions = normalizeDebugServerOptions(configuration || {});
                let elfPath = configuration?.executable || this._context.workspaceState.get(CACHE_KEYS.elfPath);
                const debuggerCfg =
                    this._context.workspaceState.get(CACHE_KEYS.debugger) ||
                    (await this._probeConnectionService.resolveProbe());
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!elfPath || !debuggerCfg || !mcuCore) return warn("msg.configIncomplete");
                // Parsed before taking the probe lease, so an invalid value fails without any startup cleanup. Parsed
                // once, because the OpenOCD arguments and the adapter launch config must see the same value.
                const rtos = resolveRtos(
                    configuration,
                    vscode.workspace.getConfiguration("emberprobe").get("rtos", "")
                );
                elfPath = cleanWindowsPath(elfPath);
                const { folder: workspaceFolder } = this._commandContext(resource);
                if (!workspaceFolder) return warn("msg.openWorkspaceForDebug");
                let cortexTools = await ensureDebugTools(
                    vscode,
                    workspaceFolder,
                    this._context.workspaceState,
                    (key) => this._t(key),
                    undefined,
                    configuration || {}
                );
                // The user dismissed the toolchain prompt: a cancellation, not a failure.
                if (!cortexTools) return null;
                startup?.phase("tools");
                // Finish a cold start before holding the probe. Background preparation normally already
                // completed; overlap any remainder with OpenOCD/SVD resolution, never a second cold GDB.
                const warming = this._gdbWarmup?.warm(cortexTools.gdbPath);
                const ownDebug = vscode.workspace.getConfiguration("emberprobe", workspaceFolder.uri);
                const images = normalizeDebugImages(
                    configuration || {},
                    configuration?.cwd || workspaceFolder.uri.fsPath
                );
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
                    vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
                const [resolvedSvdPath, openocdPath] = await Promise.all([
                    this._svdManager.currentPath(workspaceFolder),
                    this._resolveOpenOcdPath(configuredOpenOcdPath)
                ]);
                if (!openocdPath) return false;
                startup?.phase("openocd");
                await warming;
                startup?.phase("warmup");
                if (this._shutdownPromise || vscode.workspace.isTrusted === false) return false;
                const svdPath = cleanWindowsPath(resolvedSvdPath);
                openocdScripts.resolveOpenOcdLaunch(openocdPath, debuggerCfg, mcuCore);
                if (serverOptions.serverGroup) {
                    const grouped = await this._prepareGroupedDebugConfiguration({
                        folder: workspaceFolder,
                        executable: openocdPath,
                        probe: debuggerCfg,
                        target: mcuCore,
                        cfg: vscode.workspace.getConfiguration("emberprobe"),
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
                await this.prepareProbeForDebug(workspaceFolder);
                startup?.phase("prepare");
                probePrepared = true;
                this._debugStartLease = this._probeCoordinator.acquire("debugStart");
                const managed = await this._startManagedDebugServer(
                    openocdPath,
                    debuggerCfg,
                    mcuCore,
                    vscode.workspace.getConfiguration("emberprobe"),
                    interactive,
                    rtos,
                    {
                        ...serverOptions,
                        request: configuration?.request || (startOptions?.attach ? "attach" : "launch")
                    },
                    startup?.phase
                );
                this._debugServerLease = this._debugStartLease.transition("debugServer");
                this._managedDebugToken = crypto.randomUUID();
                const debugConfig = addPeripheralViewerSvd(
                    {
                        ...configuration,
                        ...serverOptions,
                        type: "emberprobe",
                        name: configuration?.name || this._t("msg.debugConfigName"),
                        request: configuration?.request || (startOptions?.attach ? "attach" : "launch"),
                        cwd: configuration?.cwd || workspaceFolder.uri.fsPath,
                        executable: elfPath,
                        gdbTarget: managed.gdbTarget,
                        runToEntryPoint: configuration?.runToEntryPoint ?? "main",
                        __emberprobeManagedToken: this._managedDebugToken
                    },
                    svdPath
                );
                if (svdPath) debugConfig.svdFile = svdPath;
                // The adapter uses this to decide whether it runs RTOS-aware; an explicit empty value must override an
                // old value in launch.json.
                if (rtos) debugConfig.rtos = rtos;
                else delete debugConfig.rtos;
                Object.assign(debugConfig, cortexTools);
                Object.assign(debugConfig, pretty);
                Object.assign(debugConfig, images);
                // A changed image downloads at the sidebar's programming clock (see docs/FLASH-PERFORMANCE.md).
                if (debugConfig.request === "launch" && this._managedDebugServer?.options)
                    debugConfig.__emberprobeDownloadSpeedKhz = flashSpeedKhz(this._managedDebugServer.options);
                if (startup)
                    debugConfig.__emberprobeStartupTrace = startup.finish(
                        this._gdbWarmup?.snapshot?.(cortexTools.gdbPath)
                    );
                const startupGate = this._armDebugStartupWatchdog();
                if (configuration) {
                    startAccepted = true;
                    return debugConfig;
                }
                const startRequest = Promise.resolve(
                    vscode.debug.startDebugging(workspaceFolder, debugConfig, { suppressDebugView: true })
                ).then(
                    (started) => ({ kind: "result", started }),
                    (error) => ({ kind: "error", error })
                );
                const outcome = await Promise.race([startRequest, startupGate]);
                if (outcome.kind === "error") throw outcome.error;
                if (outcome.kind === "timeout" || outcome.kind === "terminated" || outcome.kind === "failed") {
                    await this._handleDebugStartupFailure(
                        this._debugLifecycle.session,
                        this._t("msg.debugStartFailed")
                    );
                    return false;
                }
                const started = outcome.kind === "ready" ? true : outcome.started;
                startAccepted = started === true;
                if (!started) {
                    await this._handleDebugStartupFailure(
                        this._debugLifecycle.session,
                        this._t("msg.debugStartFailed")
                    );
                    return false;
                }
                // VS Code may accept the request before GDB has attached. Keep the sidebar pending
                // until both initialized and launch have arrived, terminates, or the bounded watchdog fires.
                if (outcome.kind === "result") {
                    const initialized = await startupGate;
                    if (initialized.kind !== "ready") {
                        await this._handleDebugStartupFailure(
                            this._debugLifecycle.session,
                            this._t("msg.debugStartFailed")
                        );
                        return false;
                    }
                }
                return true;
            } catch (err) {
                this._clearDebugStartupWatchdog();
                console.error("Debug start failed:", err.stack || err.message);
                this._notices.notify("flash", cmd, {
                    level: "error",
                    titleKey: COMMAND_FAILURE_TITLES[cmd],
                    error: err
                });
                if (probePrepared) {
                    await this._stopManagedDebugServer();
                    await this.restoreSamplingAfterDebug();
                }
                throw err; // Reported above; callers outside the sidebar still see the failure.
            } finally {
                if (ownsPending) {
                    if (this._debugStarting && !this._managedDebugServer) this._debugStartLease?.release();
                    if (!startAccepted) this._clearDebugStartupWatchdog();
                    this._debugCommandPending = false;
                    this._postProbeOperationStatus();
                }
            }
        };
        // Program firmware
        this.commandHandlers["mcu-vscode.download"] = async (resource) => {
            const cmd = "mcu-vscode.download";
            const notify = (notice) => this._notices.notify("flash", cmd, notice);
            const warn = (key, params) => {
                notify({ level: "warning", key, params });
                return false;
            };
            // A second click while flashing must not replace the running download's progress.
            if (this._downloadRunning) {
                this._notices.notify("flash", "download-busy", { level: "warning", key: "msg.downloadBusy" });
                return false;
            }
            if (
                this._debugStarting ||
                this._debugBridge.hasAnySession ||
                isSupportedDebugSession(this._liveDebugSession())
            )
                return warn("msg.debugBusyForDownload");
            if (this._agentReadRunning) return warn("msg.agentReadBusy");
            if (this._chipInfoRunning) return warn("msg.chipBusyForDownload");
            if (this._sampling.starting) return warn("msg.liveBusyForDownload");
            this._notices.clear("flash", "download-busy");
            this._notices.clear("flash", "download-refresh");
            // Keep the live lease until process exit, then synchronously reserve download.
            const resumeSampling = !!this._sampling.intent && !!(this._sampling.running || this._sampling.session);
            const liveStopped = this._sampling.running || this._sampling.session ? this._sampling.stop() : null;
            if (liveStopped) await liveStopped;
            const downloadLease = this._probeCoordinator.acquire("download");
            this._downloadLease = downloadLease;
            let downloaded = false;
            // OpenOCD progress lines, kept for the failure's diagnostic panel.
            const progressLog = [];
            try {
                const configuredExecutable = vscode.workspace
                    .getConfiguration("emberprobe")
                    .get("openocdPath", "openocd");
                const executable = await this._resolveOpenOcdPath(configuredExecutable);
                if (!executable) return warn("notice.openocdRequired");
                let elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
                const debuggerCfg =
                    this._context.workspaceState.get(CACHE_KEYS.debugger) ||
                    (await this._probeConnectionService.resolveProbe());
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!elfPath || !debuggerCfg || !mcuCore) return warn("msg.configIncomplete");
                const cleanElfPath = cleanWindowsPath(elfPath);
                const { cwd } = this._commandContext(resource);
                let connection;
                await this._flashService.download(
                    vscode,
                    {
                        executable,
                        elf: cleanElfPath,
                        transport: vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                        probe: debuggerCfg,
                        target: mcuCore,
                        prepare: async () => {
                            connection = await this._probeConnectionService.prepare(
                                { executable, probe: debuggerCfg, target: mcuCore },
                                true
                            );
                            return connection;
                        },
                        onDownloaded: (image) =>
                            this._firmwareRecord.record({
                                ...image,
                                connection: { ...connection, probe: debuggerCfg, target: mcuCore }
                            }),
                        cwd
                    },
                    (event) => {
                        const text = event.key ? this._t(event.key, event.params) : event.message || "";
                        if (text) progressLog.push(text);
                        if (progressLog.length > 12) progressLog.shift();
                        // Errors along the way end in the failure notice; the box shows the current step.
                        if (event.level !== "error" && text)
                            notify({ level: "info", busy: true, key: event.key, params: event.params, message: text });
                    }
                );
                if (connection && !this._downloadLease?.released)
                    await this._probeConnectionService.recordSuccess(connection);
                downloaded = true;
                notify({ level: "success", key: "msg.downloadSuccess" });
                return true;
            } catch (err) {
                console.error("Programming failed:", err.message);
                notify({
                    level: "error",
                    titleKey: COMMAND_FAILURE_TITLES[cmd],
                    error: err,
                    detail: progressLog.join("\n")
                });
                throw err; // Reported above; callers outside the sidebar still see the failure.
            } finally {
                let refreshed = false;
                try {
                    if (downloaded) {
                        await this._refreshElfBindings();
                        refreshed = true;
                    }
                } catch (error) {
                    this._postLive({ type: "liveError", ...toUiError(error) });
                    this._notices.notify("flash", "download-refresh", {
                        level: "warning",
                        key: "msg.downloadRefreshFailed",
                        params: { error: error.message }
                    });
                } finally {
                    downloadLease.release();
                }
                if (resumeSampling && refreshed) {
                    try {
                        await this._sampling.start(undefined, this._sampling.intervalMs, "refresh");
                    } catch (error) {
                        this._notices.notify("flash", "download-refresh", {
                            level: "warning",
                            key: "msg.downloadSamplingFailed",
                            params: { error: error.message }
                        });
                    }
                }
            }
        };
    }
    async _configurationSnapshot() {
        const snapshot = this._configurationStore.snapshot();
        snapshot.svd = (await this._svdManager.peekBound())?.path || "";
        const selectedProbe = this._context ? this._probeSelectionStore().get() : null;
        if (selectedProbe) {
            snapshot.selectedProbe = selectedProbe;
            // Previously installed skills read only the v1/v2 record.
            snapshot.successfulConnection = this._probeSelectionStore().legacy();
        }
        return snapshot;
    }
    _probeInventoryService() {
        // Created on first use; recently switched J-Link drivers are reconciled into every scan.
        if (!this._probeInventory)
            this._probeInventory = new ProbeInventoryService({
                listProbes,
                reconcile: (inventory) => this._probeDriverService.reconcileInventory(inventory)
            });
        return this._probeInventory;
    }
    _probeSelectionStore() {
        if (this._selectionStore?.state !== this._context.workspaceState)
            this._selectionStore = new ProbeSelectionStore(this._context.workspaceState);
        return this._selectionStore;
    }
    _assertConnectionEditable(values) {
        const keys = ["debugger", "mcu", "openocdPath", "transport", "probeSerial", "adapterSpeedKhz"];
        if (keys.some((key) => Object.hasOwn(values, key))) {
            this._assertProbeDriverIdle();
        }
        if (
            keys.some((key) => Object.hasOwn(values, key)) &&
            (this._sampling.session ||
                this._managedDebugServer ||
                this._agentReadSession ||
                this._debugBridge.hasAnySession)
        )
            throw Object.assign(new Error("Stop the active probe session before changing connection settings"), {
                code: "PROBE_CONFIGURATION_BUSY"
            });
    }
    _assertProbeDriverIdle() {
        this._externalDebug?.assertPhysicalAvailable();
        if (this._probeDriverSwitching)
            throw Object.assign(new Error("J-Link USB driver change is still in progress"), {
                code: "PROBE_DRIVER_BUSY"
            });
    }
    connectionConfigurationChanged(samplingSpeedChanged = false, samplingSpeedOnly = false) {
        this._probeConnectionService.markConfigurationChanged(
            samplingSpeedOnly
                ? [this._sampling.session, this._agentReadSession].filter(Boolean)
                : [
                      this._sampling.session,
                      this._managedDebugServer,
                      this._agentReadSession,
                      this._debugBridge.activeSession
                  ]
        );
        if (this._sampling.session || this._managedDebugServer) this._postConsumerStatuses({});
        // Only a visible sidebar shows the list; a hidden one rescans when it is shown again.
        if (this._probeInventoryMonitor)
            this._refreshConnectedProbes().catch((error) =>
                console.error("Probe inventory check failed:", error.message)
            );
        if (samplingSpeedChanged && this._sampling.session)
            void this._sampling.restart().catch((error) => this._postLive({ type: "liveError", ...toUiError(error) }));
    }
    _assertWriteSessionCurrent(session) {
        if (session === this._debugBridge && this._debugBridge.replBusy)
            throw Object.assign(new Error("Wait for the GDB console command before writing"), {
                code: "DEBUG_CONTROL_BUSY"
            });
        const physical =
            session === this._debugBridge ? this._managedDebugServer || this._debugBridge.activeSession : session;
        if (!physical) throw Object.assign(new Error("No active write session"), { code: "PROBE_SESSION_MISSING" });
        this._probeConnectionService.assertCurrent(physical);
        assertWriteIdentity(physical.options);
    }
    _sessionWriteConnection(session) {
        this._assertWriteSessionCurrent(session);
        if (session === this._debugBridge) {
            if (this._managedDebugServer?.options && !this._managedDebugGroup && !this._externalDebug?.active)
                return writeConnectionIdentity(this._managedDebugServer.options);
            const active = this._debugBridge.activeSession;
            if (!active) this._debugBridge.assertUniqueSession();
            return writeConnectionIdentity({
                kind: "dap",
                selectionIdentity: this._managedDebugServer?.options?.selectionIdentity,
                sessionId: active.id,
                workspace: active.workspaceFolder?.uri?.fsPath || "",
                ...(active.configuration?.servertype === "external" ? { stopEpoch: this._debugBridge.stopEpoch } : {})
            });
        }
        return writeConnectionIdentity(session.options);
    }
    async _prepareWriteConnection() {
        this._assertGroupedReadElf();
        if (this._sampling.running && this._sampling.session)
            return this._sessionWriteConnection(this._sampling.session);
        if (this._debugBridge.activeSession && this._debugBridge.agentStatus().state === "paused")
            return this._sessionWriteConnection(this._debugBridge);
        // A managed debug server remains the connection that will execute an
        // Agent write even while the DAP bridge is between stop events and reports
        // canWrite=false. Bind the confirmation to that server instead of preparing
        // a second standalone OpenOCD identity, which would be rejected at execution.
        if (this._managedDebugServer) return this._sessionWriteConnection(this._debugBridge);
        if (this._debugBridge.canWrite) return this._sessionWriteConnection(this._debugBridge);
        const config = this._configurationStore.snapshot();
        const executable = await this._resolveOpenOcdPath(config.openocdPath);
        return writeConnectionIdentity(
            await this._probeConnectionService.prepare({
                executable,
                probe: config.debugger,
                target: config.mcu,
                sampling: true
            })
        );
    }
    _executeAgentCubeMx(params) {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: this._t("cubemx.generating"),
                cancellable: true
            },
            async (progress, token) => {
                const controller = new AbortController();
                const subscription = token.onCancellationRequested(() => controller.abort());
                progress.report({ message: this._t("cubemx.generating") });
                try {
                    return await this._cubemxService.execute(params || {}, controller.signal, (stage) =>
                        progress.report({ message: this._t("cubemx." + stage) })
                    );
                } finally {
                    subscription.dispose();
                }
            }
        );
    }
    async _setAgentConfiguration(values) {
        // openocdPath could point probe calls at any executable, so the Agent Bridge may not change it; the user
        // changes it in settings or the sidebar
        assertAgentSettable(values);
        const updated = await this._configurationStore.update(values);
        if (Object.hasOwn(values || {}, "svd")) {
            const folder = this._svdManager.workspaceForElf();
            if (folder) {
                if (updated.svd)
                    await this._svdManager.importAndBind(updated.svd, folder, this._svdManager.identityFor(folder), {
                        source: "agent-workspace",
                        originalPath: updated.svd
                    });
                else await this._svdManager.library.bind(folder.uri, "");
            }
        }
        return this._configurationSnapshot();
    }
    _focusedLivePanel() {
        return selectFocusedPanel(this._livePanels);
    }
    async _exportAgentCsv(params) {
        const requestedPanelId = params.panelId === undefined ? null : Number(params.panelId);
        const entry = requestedPanelId === null ? this._focusedLivePanel() : this._livePanels.get(requestedPanelId);
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
        const scope = this._debugSamplingScope(entry.watchKey);
        const available = this._samplingArchive.status(scope).variables;
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
        const result = await this._samplingArchive.readCsv({
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
    async _addAgentWatch(params) {
        const names = Array.isArray(params.variables) ? params.variables.map(String) : [];
        if (!names.length) throw Object.assign(new Error("No variables supplied"), { code: "NO_VARIABLES" });
        const destination = params.destination || "sidebar";
        if (!["sidebar", "chart", "both"].includes(destination))
            throw Object.assign(new Error("destination must be sidebar, chart, or both"), {
                code: "INVALID_DESTINATION"
            });
        await this._prepareRequestedLayouts(names);
        const resolveSymbol = elfSymbols.createSymbolResolver(this.readElfSymbols().symbols);
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
            const runtime = require("./services/runtimeWatch").runtimeWatchEntry(
                rawPath,
                symbol,
                parsed?.segments || []
            );
            if (runtime) {
                appendResolved(runtime);
                continue;
            }
            if (require("./webview/runtime").requiresRuntimePath(symbol, parsed?.segments || []))
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
            const current = this._scalarWatchList(key);
            const existing = new Set(current.map((item) => item.name));
            const added = resolved.filter((item) => !existing.has(item.name));
            await this._saveWatchList(key, current.concat(added));
            results[target] = {
                added: added.map((item) => item.name),
                alreadyPresent: resolved.filter((item) => existing.has(item.name)).map((item) => item.name)
            };
        };
        const focusedPanel = this._focusedLivePanel();
        const chartKey = focusedPanel?.watchKey || CACHE_KEYS.watchList;
        if (destination === "sidebar" || destination === "both") await addTo(CACHE_KEYS.sidebarWatchList, "sidebar");
        if (destination === "chart" || destination === "both") await addTo(chartKey, "chart");
        return results;
    }
    // Plans each item separately: a resolution or layout failure of one variable goes to variableErrors without
    // affecting the rest of the batch. If all fail, the first error is thrown (keeping the error code of a
    // single-variable request), with details.variableErrors when several failed.
    _postAgentSampling(running, key, params) {
        this._agentSamplingStatus = running ? { running, key, params, agentOwned: true } : null;
        this._postLive({ type: "liveStatus", running, key, params, agentOwned: running });
    }
    // Each wait owns its timer: reads sharing a live or debug connection run concurrently, and a
    // shared timer let one wait clear another's, leaving that sample loop pending forever.
    // `run` is the sample loop's entry in _agentSampleRuns; cancelling the run ends its wait early.
    _waitAgentInterval(intervalMs, run = null) {
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
    _wakeAgentReadDelays() {
        for (const run of [...(this._agentSampleRuns || [])]) if (run.temporary) run.wake?.();
    }
    // sampling.stop must also end samples on a connection the Agent read borrows (live sampling or a
    // running/paused debug server), not only its own temporary probe session.
    _cancelSharedAgentSamples() {
        for (const run of [...(this._agentSampleRuns || [])]) {
            if (run.temporary) continue;
            run.cancelled = true;
            run.wake?.();
        }
    }
    async _runAgentSamples(params, count, intervalMs, syncStatus) {
        const layoutErrors = new Map();
        await this._prepareRequestedLayouts(params.variables, { layoutErrors });
        const { elfResult, plan, compositePlan, variableErrors } = agentPlans.readPlan(
            params,
            () => this.readElfSymbols(),
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

        return this._withAgentProbe(
            async ({ session, source, temporary }) => {
                if (temporary && syncStatus)
                    this._postAgentSampling(true, "live.agentSampling", { current: 0, total: count });
                const result = [];
                const effectiveIntervalMs = intervalMs;
                const run = { temporary, cancelled: false, wake: null };
                (this._agentSampleRuns ??= new Set()).add(run);
                try {
                    for (let index = 0; index < count; index++) {
                        if ((temporary && !this._agentReadRunning) || run.cancelled)
                            throw Object.assign(new Error("Agent sampling was cancelled by the user"), {
                                code: "AGENT_READ_CANCELLED"
                            });
                        result.push(
                            agentPlans.decodeSample(
                                plan,
                                await session.readOnce(this._sampling.runtimeReadRanges(readItems, elfResult)),
                                compositePlan
                            )
                        );
                        if (temporary && syncStatus)
                            this._postAgentSampling(true, "live.agentSampling", { current: index + 1, total: count });
                        if (index + 1 < count) await this._waitAgentInterval(effectiveIntervalMs, run);
                    }
                } finally {
                    this._agentSampleRuns.delete(run);
                }
                return {
                    source,
                    elf: elfResult.elf,
                    ...this._firmwareConsistency(elfResult),
                    samples: result,
                    ...(variableErrors.length ? { partial: true, variableErrors } : {})
                };
            },
            { syncStatus, total: count, allowPausedDebugRead: true }
        );
    }
    // Acquires an agent probe session: reuses the active sampling connection or creates a temporary session;
    // handler({session, source, temporary}) performs the reads/writes, and a temporary session is always released in
    // finally. Tcl port: the configured emberprobe.tclPort if the user set one, otherwise a random ephemeral port,
    // because OpenOCD's unauthenticated Tcl port on a fixed default would let any local process issue halt/write_memory
    // during sampling.
    async _resolveTclPort(cfg) {
        const inspect = typeof cfg.inspect === "function" ? cfg.inspect("tclPort") : null;
        if (inspect && (inspect.workspaceValue !== undefined || inspect.globalValue !== undefined)) {
            return validation.clampInteger(cfg.get("tclPort", 6666), 6666, 1, 65535);
        }
        const port = await liveWatch.findFreePort();
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw Object.assign(new Error("Unable to allocate a local OpenOCD Tcl port"), {
                code: "TCL_PORT_UNAVAILABLE"
            });
        return port;
    }
    async _startManagedDebugServer(
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
        const connection = await this._probeConnectionService.prepare({ executable, probe, target }, interactive);
        phase?.("preflight");
        // Launch downloads firmware through GDB; attach can still inspect an unverified USB attachment.
        if (serverOptions.request !== "attach") assertWriteIdentity(connection);
        let lastError = null;
        const inspect = typeof cfg.inspect === "function" ? cfg.inspect("tclPort") : null;
        const fixedTcl = !!(inspect && (inspect.workspaceValue !== undefined || inspect.globalValue !== undefined));
        for (let attempt = 0; attempt < (fixedTcl ? 1 : 3); attempt++) {
            const fixedPort = fixedTcl ? await this._resolveTclPort(cfg) : null;
            const coreCount = selection.numberOfProcessors || 1;
            const allocated = await allocateDebugPorts(coreCount + (fixedTcl ? 0 : 1), fixedTcl ? [fixedPort] : []);
            const tclPort = fixedTcl ? fixedPort : allocated.shift();
            const gdbPort = allocated[selection.targetProcessor || 0];
            const server = new OpenOcdDebugController(
                vscode,
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
                    intervalMs: this._sampling.intervalMs
                },
                {
                    onConnectionConfirmed: () => {
                        if (this._managedDebugServer === server)
                            void this._probeConnectionService.recordSuccess(server.options);
                    },
                    onSample: (samples, t, consumers) => this._sampling.handleRawSamples(samples, t, consumers),
                    onSampleGap: () => {
                        if (this._managedDebugServer === server) this._sampling.handleSampleGap();
                    },
                    onStatus: (status) => {
                        if (this._managedDebugServer !== server) return;
                        if (status?.key === "live.debugRuntimeSampling") {
                            // Recovery notifications can arrive after GDB paused or sampling was disabled.
                            this._postConsumerStatuses(this._sampling.status());
                        } else if (status?.key === "live.debugTclDegraded") {
                            this._postConsumerStatuses({
                                mode: "debug-running-degraded",
                                key: status.key,
                                source: "openocd",
                                canRead: false,
                                canWrite: false,
                                snapshotReady: false,
                                intentEnabled: this._sampling.intent,
                                running: this._sampling.intent
                            });
                        }
                    },
                    onError: (message) =>
                        this._postLive({
                            type: "liveError",
                            ...toUiError(message)
                        }),
                    onDegraded: (error) =>
                        this._postConsumerStatuses(
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
                        if (this._managedDebugGroup && this._managedDebugServer === server)
                            void this._handleSharedServerExit(error).catch((failure) =>
                                this._postLive({ type: "liveError", ...toUiError(failure) })
                            );
                        if (this._debugLifecycle.pending) this._reportDebugStartupFailure(error.message);
                        this._postConsumerStatuses(
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
            this._managedDebugServer = server;
            try {
                const info = await server.start();
                phase?.("server");
                return info;
            } catch (error) {
                lastError = error;
                await server.stop();
                if (this._managedDebugServer === server) this._managedDebugServer = null;
                if (fixedTcl || !/address already in use|couldn't bind|bind failed|in use/i.test(error.message || ""))
                    break;
            }
        }
        throw lastError || new Error("Unable to start managed OpenOCD");
    }
    async _stopManagedDebugServer() {
        if (this._runtimeResumeTimer) clearTimeout(this._runtimeResumeTimer);
        this._runtimeResumeTimer = null;
        const server = this._managedDebugServer;
        const lease = this._debugServerLease || this._debugStartLease;
        const group = this._managedDebugGroup;
        if (group) {
            await group.stop();
            this._managedDebugGroup = null;
        }
        if (server && !group) {
            server.setSamplingEnabled?.(false);
            // Keep the process and lease reachable if exit cannot be confirmed.
            await server.stop?.();
        }
        if (this._managedDebugServer === server) {
            this._managedDebugServer = null;
            this._debugServerLease = null;
            this._managedDebugToken = "";
            this._managedDebugSessionId = "";
            this._sampling.resetRuntimeNotices();
        }
        if (!group) lease?.release();
    }
    _armDebugStartupWatchdog() {
        return this._debugLifecycle.arm(DEBUG_STARTUP_TIMEOUT_MS, () => this._recoverDebugStartupTimeout());
    }
    _matchesManagedDebugSession(session) {
        if (this._externalDebug?.matches(session)) return true;
        if (this._managedDebugGroup) return !!this._managedDebugGroup.match(session);
        return !!(
            session &&
            this._managedDebugToken &&
            session.configuration?.__emberprobeManagedToken === this._managedDebugToken
        );
    }
    async _prepareGroupedDebugConfiguration({
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
        let group = this._managedDebugGroup;
        const created = !group;
        if (!group) {
            await this.prepareProbeForDebug(folder);
            this._debugStartLease = this._probeCoordinator.acquire("debugStart");
            try {
                const connection = await this._startManagedDebugServer(
                    executable,
                    probe,
                    target,
                    cfg,
                    interactive,
                    rtos,
                    { ...serverOptions, request: debugConfig.request || "launch" }
                );
                this._debugServerLease = this._debugStartLease.transition("debugServer");
                group = new SharedDebugGroup({
                    id: serverOptions.serverGroup,
                    workspace,
                    controller: this._managedDebugServer,
                    lease: this._debugServerLease,
                    connection,
                    onFailure: (token, message) =>
                        this._failGroupedCore(token, message).catch((error) =>
                            this._postLive({
                                type: "liveError",
                                ...toUiError(error)
                            })
                        )
                });
                this._managedDebugGroup = group;
            } catch (error) {
                await this._stopManagedDebugServer();
                await this.restoreSamplingAfterDebug();
                throw error;
            }
        }
        try {
            if (debugConfig.request !== "attach") assertWriteIdentity(group.controller.options);
            this._probeConnectionService.assertCurrent(group.controller);
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
                await this._stopManagedDebugServer();
                await this.restoreSamplingAfterDebug();
            }
            throw error;
        }
    }
    async _failGroupedCore(token, message) {
        const group = this._managedDebugGroup;
        const member = group?.members.get(token);
        if (!member || member.failing) return;
        member.failing = true;
        member.lifecycle.clear({ kind: "failed", message });
        this._postLive({ type: "liveError", message });
        try {
            if (member.session) {
                let stopTimer;
                try {
                    await Promise.race([
                        vscode.debug.stopDebugging(member.session),
                        new Promise((resolve) => {
                            stopTimer = setTimeout(resolve, 2000);
                        })
                    ]);
                } finally {
                    clearTimeout(stopTimer);
                }
                await this._debugBridge.waitForState(
                    () => this._terminatedDebugSessionIds.has(member.session.id),
                    2000
                );
            }
        } finally {
            // A wedged adapter can hang stopDebugging or time out the terminate wait, and
            // member.failing already blocks any retry. Dropping the member regardless is what
            // frees the group's probe lease; skipping it wedges the probe until window reload.
            await group.release(token);
        }
        await this._closeStoppedDebugGroup(group);
    }
    // A failing core and its session's terminate event can both observe the group stop; they share one teardown
    // so OpenOCD is stopped and sampling restored exactly once, and both resolve only after it finishes.
    _closeStoppedDebugGroup(group) {
        if (this._debugGroupClosing?.group === group) return this._debugGroupClosing.promise;
        if (!group.stopped || this._managedDebugGroup !== group) return Promise.resolve();
        const promise = (async () => {
            await this._stopManagedDebugServer();
            await this.restoreSamplingAfterDebug();
        })().finally(() => {
            if (this._debugGroupClosing?.promise === promise) this._debugGroupClosing = null;
        });
        this._debugGroupClosing = { group, promise };
        return promise;
    }
    async _handleSharedServerExit(error) {
        const group = this._managedDebugGroup;
        if (!group) return;
        await Promise.all([...group.members.keys()].map((token) => this._failGroupedCore(token, error.message)));
    }
    _selectDebugSession(selector) {
        if (this._debugControlService?.controlInFlight)
            throw Object.assign(new Error("Wait for the current debug control action before selecting a session"), {
                code: "DEBUG_CONTROL_BUSY"
            });
        const status = this._debugBridge.selectSession(selector);
        this._syncDebugSampleContext();
        return status;
    }
    _debugSamplingScope(watchKey = "") {
        return this._managedDebugGroup
            ? JSON.stringify([watchKey, this._managedDebugGroup.id, this._debugBridge.activeSession?.id || ""])
            : watchKey;
    }
    _syncDebugSampleContext() {
        if (!this._managedDebugGroup && !this._debugSampleGroup) return;
        const group = this._managedDebugGroup?.id || "";
        const sessionId = this._debugBridge.activeSession?.id || "";
        if (group === this._debugSampleGroup && sessionId === this._debugSampleSessionId) return;
        this._debugSampleGroup = group;
        this._debugSampleSessionId = sessionId;
        this._debugReadPlanKey = "";
        this._runtimeSampleHold?.reset();
        this._latestSidebarSamples?.clear();
        if (this._sidebarBatchTimer) clearTimeout(this._sidebarBatchTimer);
        this._sidebarBatchTimer = null;
        this._pendingSidebarScalars = [];
        this._pendingSidebarComposites = [];
        this._webviewView?.webview.postMessage({ type: "debugSessionChanged", sessionId });
        for (const entry of this._livePanels?.values() || []) {
            entry.latestSamples?.clear();
            if (entry._batchTimer) clearTimeout(entry._batchTimer);
            entry._batchTimer = null;
            entry._pendingScalars = [];
            entry._pendingComposites = [];
            this._discardChartHistoryAppend(entry);
            entry.historyRevision = (entry.historyRevision || 0) + 1;
            entry.post({ type: "debugSessionChanged", sessionId });
            this._configureChartHistory(entry);
        }
    }
    _clearDebugStartupWatchdog(outcome) {
        this._debugLifecycle.clear(outcome);
    }
    _markDebugStartupReady(session) {
        this._debugLifecycle?.markInitialized(session, this._matchesManagedDebugSession(session));
    }
    _findManagedDebugSession(session) {
        const managedId = this._managedDebugSessionId;
        const candidates = [
            session,
            this._debugLifecycle?.session,
            managedId ? this._debugBridge?.allSessions?.get(managedId) : null
        ];
        return (
            candidates.find(
                (candidate) =>
                    typeof candidate?.id === "string" &&
                    isSupportedDebugSession(candidate) &&
                    this._matchesManagedDebugSession(candidate) &&
                    (!managedId || candidate.id === managedId)
            ) || null
        );
    }
    async _handleDebugStartupFailure(session, message) {
        if (this._externalDebug?.active) {
            this._reportDebugStartupFailure(message);
            const externalSession = this._findManagedDebugSession(session);
            if (externalSession) {
                await Promise.race([
                    Promise.resolve(vscode.debug.stopDebugging(externalSession)).catch(() => {}),
                    new Promise((resolve) => setTimeout(resolve, 2000))
                ]);
                this._debugBridge.detach(externalSession);
            }
            this._clearDebugStartupWatchdog({ kind: "failed" });
            await this._externalDebug.finish(externalSession);
            return;
        }
        if (this._debugStartupFailureCleanedUp) return;
        this._debugStartupFailureCleanedUp = true;
        const targetSession = this._findManagedDebugSession(session);
        this._reportDebugStartupFailure(message);
        try {
            if (targetSession) {
                if (targetSession.id) this._terminatedDebugSessionIds?.add(targetSession.id);
                try {
                    await Promise.race([
                        Promise.resolve(vscode.debug?.stopDebugging?.(targetSession)).catch(() => false),
                        new Promise((resolve) => setTimeout(() => resolve(false), 2000))
                    ]);
                } catch {
                    /* The adapter may already have exited. */
                }
                this._debugBridge?.detach(targetSession);
                this._debugReadPlanKey = "";
                this._runtimeSampleHold?.reset();
            }
            if (typeof this._stopManagedDebugServer === "function") await this._stopManagedDebugServer();
            if (typeof this.restoreSamplingAfterDebug === "function") await this.restoreSamplingAfterDebug();
        } finally {
            if (!this._managedDebugServer) {
                if (this._debugStarting) this._debugStartLease?.release();
                this._debugServerLease?.release();
            }
            this._debugCommandPending = false;
            this._postProbeOperationStatus();
        }
    }
    _reportDebugStartupFailure(message) {
        if (this._debugStartupErrorReported) return;
        this._debugStartupErrorReported = true;
        const cmd = this._debugStartupCmd || "mcu-vscode.debug";
        this._notices.notify("flash", cmd, {
            level: "error",
            titleKey: COMMAND_FAILURE_TITLES[cmd],
            message: message || this._t("msg.debugStartFailed")
        });
        this._clearDebugStartupWatchdog({ kind: "failed" });
    }
    async _recoverDebugStartupTimeout() {
        const session = this._findManagedDebugSession();
        const timeoutMs = this._debugLifecycle?.timeoutMs || DEBUG_STARTUP_TIMEOUT_MS;
        this._postConsumerStatuses(
            {
                mode: "debug-start-failed",
                key: "live.debugStartTimeout",
                source: "none",
                canRead: false,
                canWrite: false
            },
            true
        );
        const timeoutMessage = this._t("msg.debugStartTimeout", { seconds: timeoutMs / 1000 });
        await this._handleDebugStartupFailure(session, timeoutMessage);
    }
    _assertGroupedReadElf() {
        if (!this._managedDebugGroup && this._debugBridge.activeSession?.configuration?.servertype !== "external")
            return;
        const session = this._debugBridge.assertUniqueSession();
        const selectedElf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
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
    async _quiesceManagedRuntimeRead() {
        this._assertGroupedReadElf();
        const server = this._managedDebugServer;
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
    _handleManagedTargetState(event) {
        if (!event?.session || !this._managedDebugSessionId || event.session.id !== this._managedDebugSessionId) return;
        if (this._runtimeResumeTimer) clearTimeout(this._runtimeResumeTimer);
        this._runtimeResumeTimer = null;
        const server = this._managedDebugServer;
        if (!server || server.capabilities?.runtimeRead === false) return;
        server.invalidateTarget?.();
        server.setSamplingEnabled(false);
        if (event.state !== "continued") return;
        if (event.transition && !["continue", "repl"].includes(event.transition)) return;
        const epoch = event.epoch;
        this._runtimeResumeTimer = setTimeout(() => {
            this._runtimeResumeTimer = null;
            if (
                !this._managedDebugServer ||
                this._managedDebugServer !== server ||
                this._debugBridge.paused ||
                this._debugBridge.replBusy ||
                this._debugBridge.stopEpoch !== epoch ||
                !this._sampling.intent
            )
                return;
            try {
                const allowed = this._sampling.configureManagedRuntimeWatch();
                if (!allowed.length) {
                    this._postConsumerStatuses({
                        mode: "debug-running-waiting",
                        key: "live.needVar",
                        source: "openocd",
                        canRead: false,
                        canWrite: false,
                        snapshotReady: false
                    });
                    return;
                }
                const enabled = this._samplingCoordinator.setRuntimeEnabled(
                    server,
                    this._sampling.intent,
                    this._debugBridge
                );
                this._postConsumerStatuses({
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
                this._postConsumerStatuses(
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
    async _withAgentProbe(handler, options = {}) {
        if (this._debugBridge.replBusy)
            throw Object.assign(new Error("Wait for the GDB console command before inspecting memory"), {
                code: "DEBUG_CONTROL_BUSY"
            });
        if (this._sampling.closing || this._sampling.exitUnconfirmed)
            throw Object.assign(new Error("The previous probe connection has not closed"), {
                code: "PROBE_EXIT_UNCONFIRMED"
            });
        const syncStatus = !!options.syncStatus;
        const total = options.total || 0;
        // If the UI is starting sampling, wait briefly for it to connect and then reuse the same Tcl session.
        const liveDeadline = Date.now() + 7000;
        while (this._sampling.starting && Date.now() < liveDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        let operationLease = null;
        let session = this._sampling.running ? this._sampling.session : null;
        let temporary = false;
        let source = "active-sampling";
        if (!session && options.allowPausedDebugRead) {
            session = selectPausedDebugReadSession(this._debugBridge);
            if (session) {
                this._assertGroupedReadElf();
                source = "debug-session";
            } else if (
                this._managedDebugServer &&
                this._managedDebugSessionId &&
                this._debugBridge.agentStatus().state === "running"
            ) {
                const managed = this._managedDebugServer;
                if (managed.capabilities?.runtimeRead === false)
                    throw Object.assign(new Error("Pause the selected core before reading multicore memory"), {
                        code: "DEBUG_RUNTIME_READ_UNSUPPORTED"
                    });
                session = {
                    readOnce: async (items) => {
                        const plan = this._sampling.runtimeRamPlan(items, true);
                        const epoch = this._debugBridge.stopEpoch;
                        const samples = await managed.readOnce(plan.allowed);
                        if (
                            this._debugBridge.stopEpoch !== epoch ||
                            this._debugBridge.agentStatus().state !== "running"
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
        if (!session) {
            if (this._agentReadRunning)
                throw Object.assign(new Error("Another Agent variable read is in progress"), {
                    code: "AGENT_READ_BUSY"
                });
            if (this._downloadRunning || this._chipInfoRunning || this._debugStarting || this._liveDebugSession()) {
                throw Object.assign(new Error("The debug probe is busy with another operation"), {
                    code: "PROBE_BUSY",
                    details: {
                        activeOperation: this._debugStarting || this._liveDebugSession() ? "debug" : "probe",
                        debugState: this._debugBridge.agentStatus().state
                    }
                });
            }
            operationLease = this._probeCoordinator.acquire("agentRead");
            this._agentReadLease = operationLease;
            this._agentReadCancelled = false;
            let prepared;
            const preparation = new Promise((resolve) => {
                prepared = resolve;
            });
            this._agentReadPreparationPromise = preparation;
            const assertActive = () => {
                if (operationLease.released || this._agentReadCancelled || this._agentReadLease !== operationLease)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
            };
            try {
                const debuggerCfg =
                    this._context.workspaceState.get(CACHE_KEYS.debugger) ||
                    (await this._probeConnectionService.resolveProbe());
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                assertActive();
                if (!debuggerCfg || !mcuCore) {
                    throw Object.assign(new Error(this._t("live.needConfig")), {
                        code: "CONFIG_INCOMPLETE",
                        i18nKey: "live.needConfig"
                    });
                }
                const cfg = vscode.workspace.getConfiguration("emberprobe");
                const executable = await this._resolveOpenOcdPath(cfg.get("openocdPath", "openocd"));
                assertActive();
                if (!executable) {
                    throw Object.assign(new Error(this._t("live.notReady")), {
                        code: "OPENOCD_NOT_READY",
                        i18nKey: "live.notReady"
                    });
                }
                if (operationLease.released || this._agentReadCancelled)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
                const { cwd } = this._commandContext();
                const connection = await this._probeConnectionService.prepare({
                    executable,
                    probe: debuggerCfg,
                    target: mcuCore,
                    sampling: true
                });
                assertActive();
                const port = await this._resolveTclPort(cfg);
                assertActive();
                session = new liveWatch.LiveWatchSession(
                    vscode,
                    {
                        executable,
                        isolated: true,
                        transport: vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                        probe: debuggerCfg,
                        target: mcuCore,
                        ...connection,
                        cwd,
                        port,
                        intervalMs: 10000
                    },
                    {
                        onConnectionConfirmed: () => {
                            if (!operationLease.released && this._agentReadSession === session)
                                void this._probeConnectionService.recordSuccess(session.options);
                        }
                    }
                );
                if (operationLease.released)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
                this._agentReadSession = session;
                temporary = true;
                source = "temporary-probe";
            } catch (error) {
                operationLease?.release();
                throw error;
            } finally {
                prepared();
                if (this._agentReadPreparationPromise === preparation) this._agentReadPreparationPromise = null;
            }
        }

        let completed = false;
        try {
            if (temporary) {
                if (syncStatus) this._postAgentSampling(true, "live.agentStarting", { total });
                if (this._agentReadCancelled || operationLease.released || this._agentReadSession !== session)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
                await session.start();
                if (operationLease.released || this._agentReadCancelled || this._agentReadSession !== session)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
            }
            const result = await handler({ session, source, temporary });
            completed = true;
            return result;
        } finally {
            if (temporary) {
                await this._confirmAgentExit(session);
                if (this._agentReadSession === session) this._agentReadSession = null;
                operationLease?.release();
                if (this._agentReadLease === operationLease) this._wakeAgentReadDelays();
                if (syncStatus && this._agentReadLease === operationLease) {
                    const key = this._agentReadCancelled
                        ? "live.agentStopped"
                        : completed
                          ? "live.agentDone"
                          : "live.agentFailed";
                    this._postAgentSampling(false, key, { total });
                }
                if (this._agentReadLease === operationLease) this._agentReadCancelled = false;
            }
        }
    }
    async _confirmAgentExit(session) {
        if ((await session.stop()) === false)
            throw Object.assign(new Error("OpenOCD exit has not been confirmed"), { code: "PROBE_EXIT_UNCONFIRMED" });
    }
    async _readAgentVariables(params) {
        const result = await this._runAgentSamples(params, 1, 0, false);
        return {
            source: result.source,
            elf: result.elf,
            firmwareConsistency: result.firmwareConsistency,
            ...(result.warnings ? { warnings: result.warnings } : {}),
            ...result.samples[0],
            ...(result.variableErrors ? { partial: true, variableErrors: result.variableErrors } : {})
        };
    }
    async _sampleAgentVariables(params) {
        const count = validation.clampInteger(params.count, 10, 2, 1000);
        const intervalMs = validation.clampInteger(params.intervalMs, 200, 5, 60000);
        return this._runAgentSamples(params, count, intervalMs, true);
    }
    // Parses a write request: only scalar symbols and single scalar leaf paths of composites are allowed, and the
    // target address must lie in a writable ELF section (SHF_ALLOC|SHF_WRITE, i.e. .data/.bss), so flash and peripheral
    // registers are never written by mistake.
    // Core of a write inside a session: read before, write, read back and verify. Shared by agent and sidebar UI
    // writes.
    async _executeWritePlan(session, source, plan) {
        const connection = this._sessionWriteConnection(session);
        if (!plan.connection || JSON.stringify(connection) !== JSON.stringify(writeConnectionIdentity(plan.connection)))
            throw Object.assign(new Error("The active connection changed after write confirmation"), {
                code: "WRITE_CONNECTION_CHANGED",
                details: { expected: plan.connection, actual: connection }
            });
        const { elfResult, items } = plan;
        const runtimeWrite = session === this._managedDebugServer;
        const debugSession = runtimeWrite ? this._debugBridge.activeSession : null;
        const stopEpoch = runtimeWrite ? this._debugBridge.stopEpoch : null;
        if (runtimeWrite) {
            if (!items.every(isNonHaltingWordWrite)) throw runtimeWriteDisabledError();
            const status = this._sampling.status();
            if (status.mode !== "debug-running-sampling" || !status.canWrite)
                throw Object.assign(new Error("Runtime writes require an active managed OpenOCD sampling session"), {
                    code: "RUNTIME_WRITE_DISABLED"
                });
            this._assertGroupedReadElf();
            this._sampling.runtimeRamPlan(
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
            (session !== this._managedDebugServer ||
                debugSession !== this._debugBridge.activeSession ||
                stopEpoch !== this._debugBridge.stopEpoch ||
                this._debugBridge.agentStatus().state !== "running");
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
                        `${this._variableDisplayName({ name: r.resolvedName || r.name }, elfResult.symbols)}: ${r.readBackError}`
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
    // type and value. The user may authorize just this write or remember the authorization for this workspace after the
    // first successful write.
    async _writeAgentVariables(params) {
        // "false" or 0 must never be read as a request to remember write permission.
        if (params.remember !== undefined && typeof params.remember !== "boolean")
            throw Object.assign(new Error("remember must be a boolean"), { code: "INVALID_PARAMS" });
        await this._prepareRequestedLayouts(params.values);
        const plan = agentPlans.writePlan(params.values, () => this.readElfSymbols());
        plan.connection = await this._prepareWriteConnection();
        const consistency = this._firmwareConsistency(plan.elfResult);
        // A remembered write permission never applies while the ELF differs from the last
        // EmberProbe-programmed image: the addresses may target different data on the device.
        const authorization = this._writeAuthorization.authorize(plan, {
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
        if (this._debugBridge.agentStatus().state === "paused") {
            if (!this._debugBridge.canWritePaused) await this._debugBridge.prepareWriteSnapshot(plan.items);
            const result = await this._executeWritePlan(this._debugBridge, "debug-dap", plan);
            return { ...result, ...consistency, permission: await this._writePermissionGrant(authorization, plan) };
        }
        if (this._managedDebugServer && this._debugBridge.agentStatus().state === "running") {
            const result = await this._executeWritePlan(this._managedDebugServer, "debug-running-openocd", plan);
            return { ...result, ...consistency, permission: await this._writePermissionGrant(authorization, plan) };
        }
        const result = await this._withAgentProbe(
            ({ session, source }) => this._executeWritePlan(session, source, plan),
            {
                allowPausedDebugRead: true
            }
        );
        return { ...result, ...consistency, permission: await this._writePermissionGrant(authorization, plan) };
    }
    _firmwareConsistency(elfResult) {
        const record = this._firmwareRecord || new FirmwareRecord(null);
        const firmwareConsistency = record.check(elfResult?.elf);
        const warning = record.warning(elfResult?.elf);
        return { firmwareConsistency, ...(warning ? { warnings: [warning] } : {}) };
    }
    async _writePermissionGrant(authorization, plan) {
        if (!authorization.remember)
            return { mode: authorization.mode, trusted: this._writeAuthorization.isTrusted(plan) };
        try {
            return { mode: "workspace", ...(await this._writeAuthorization.trustWorkspace(plan)), remembered: true };
        } catch (error) {
            return { mode: "once", trusted: false, remembered: false, warning: error.message };
        }
    }
    // Sidebar write list: the user acts directly in the UI, without WriteAuthorization confirmation, but every safety
    // check of agentPlans.writePlan still applies (known DWARF type, target address inside writable .data/.bss). Writes are
    // only allowed while live sampling runs and reuse its Tcl session. A rebuilt but unflashed ELF moves RAM addresses,
    // and read-back verification reads the same wrong address, so one explicit choice per ELF digest is required before
    // UI writes proceed.
    async _confirmUiWriteFirmware(requestedAt) {
        let elf;
        try {
            elf = this.readElfSymbols().elf;
        } catch {
            return; // The write plan reports the ELF error itself.
        }
        const { firmwareConsistency } = this._firmwareConsistency({ elf });
        if (firmwareConsistency.status !== "mismatch" || this._uiFirmwareMismatchAck === elf.sha256) return;
        const declined = () =>
            Object.assign(new Error(this._t("sb.writeFirmwareMismatchDeclined")), {
                code: "ELF_TARGET_MISMATCH",
                i18nKey: "sb.writeFirmwareMismatchDeclined",
                details: firmwareConsistency
            });
        // Writes queued (e.g. by a slider drag) while the user was declining are not re-prompted.
        const last = this._uiFirmwareMismatchDeclined;
        if (last?.sha256 === elf.sha256 && requestedAt <= last.at) throw declined();
        const anyway = this._t("sb.writeFirmwareMismatchAnyway");
        const choice = await vscode.window.showWarningMessage(
            this._t("sb.writeFirmwareMismatch"),
            { modal: true },
            anyway
        );
        if (choice === anyway) {
            this._uiFirmwareMismatchAck = elf.sha256;
            return;
        }
        this._uiFirmwareMismatchDeclined = { sha256: elf.sha256, at: Date.now() };
        throw declined();
    }
    async _writeUiVariable(name, value, options = {}) {
        if (this._sampling.closing || this._sampling.exitUnconfirmed)
            throw Object.assign(new Error("The previous probe connection has not closed"), {
                code: "PROBE_EXIT_UNCONFIRMED"
            });
        await this._confirmUiWriteFirmware(options.requestedAt ?? Date.now());
        const status = this._sampling.status();
        const dapSession = status.canWrite && this._debugBridge.canWrite ? this._debugBridge : null;
        const runtimeSession =
            status.canWrite && status.mode === "debug-running-sampling" ? this._managedDebugServer : null;
        const session =
            dapSession || runtimeSession || (status.canWrite && this._sampling.running ? this._sampling.session : null);
        if (!session) {
            const key = writeUnavailableKey(status) || "sb.writeUnavailable";
            throw Object.assign(new Error(this._t(key)), { i18nKey: key });
        }
        await this._prepareRequestedLayouts([{ name }]);
        const plan = agentPlans.writePlan([{ name, value }], () => this.readElfSymbols());
        // The ELF may have been replaced while the mismatch prompt was open.
        if (
            this._firmwareConsistency(plan.elfResult).firmwareConsistency.status === "mismatch" &&
            this._uiFirmwareMismatchAck !== plan.elfResult.elf.sha256
        )
            throw Object.assign(new Error(this._t("sb.writeFirmwareMismatchDeclined")), {
                code: "ELF_TARGET_MISMATCH",
                i18nKey: "sb.writeFirmwareMismatchDeclined"
            });
        if (!status.haltWrite && !plan.items.every(isNonHaltingWordWrite)) throw runtimeWriteDisabledError();
        plan.connection = this._sessionWriteConnection(session);
        // UI writes are already serialized and the bridge rejects concurrent DAP operations itself;
        // posting a "writing" status here would disable the write controls mid-drag.
        return await this._executeWritePlan(
            session,
            dapSession ? "debug-dap" : runtimeSession ? "debug-running-openocd" : "active-sampling",
            plan
        );
    }
    async _agentWritePermission(params) {
        const action = String(params?.action || "status");
        if (action === "status") {
            try {
                await this._elfService.ready();
                return this._writeAuthorization.status({
                    elfResult: this.readElfSymbols(),
                    connection: await this._prepareWriteConnection()
                });
            } catch {
                return this._writeAuthorization.status();
            }
        }
        if (action === "reset") {
            return this._writeAuthorization.reset();
        }
        throw Object.assign(new Error(`Unsupported write permission action: ${action}`), {
            code: "INVALID_PERMISSION_ACTION"
        });
    }
    // Reads and decodes the Cortex-M fault registers; shares the _chipInfoRunning lock with chip.read (only one
    // one-shot OpenOCD process at a time)
    async _readAgentFault() {
        const busy = (key, code) => {
            throw Object.assign(new Error(this._t(key)), { i18nKey: key, code });
        };
        if (this._chipInfoRunning) busy("chip.reading", "CHIP_READ_RUNNING");
        if (this._downloadRunning) busy("chip.busyDownload", "PROBE_BUSY");
        if (this._sampling.running) busy("chip.busyLive", "PROBE_BUSY");
        if (this._agentReadRunning) busy("chip.busyAgent", "PROBE_BUSY");
        if (this._debugStarting || this._liveDebugSession()) busy("chip.busyDebug", "PROBE_BUSY");
        const elfLoad = this._elfService.load().catch(() => null);
        const debuggerCfg =
            this._context.workspaceState.get(CACHE_KEYS.debugger) ||
            (await this._probeConnectionService.resolveProbe());
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore) busy("chip.needConfig", "CONFIG_INCOMPLETE");
        this._chipInfoLease = this._probeCoordinator.acquire("chipInfo");
        try {
            const executable = await this._resolveOpenOcdPath(
                vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd")
            );
            if (!executable) busy("chip.notReady", "OPENOCD_NOT_READY");
            const { cwd } = this._commandContext();
            await elfLoad;
            return await this._faultService.read(
                {
                    executable,
                    transport: vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                    probe: debuggerCfg,
                    target: mcuCore,
                    ...(await this._probeConnectionService.prepare({
                        executable,
                        probe: debuggerCfg,
                        target: mcuCore
                    })),
                    cwd
                },
                () => this.readElfSymbols().functions || []
            );
        } finally {
            this._chipInfoLease?.release();
        }
    }
    // Agent and sidebar share one memory analysis backend.
    _getMemoryAnalysisController() {
        if (!this._memoryAnalysisController) {
            this._memoryAnalysisController = new MemoryAnalysisController({
                vscode,
                elfService: this._elfService,
                fs,
                context: this._context || { workspaceState: { get: (_key, fallback) => fallback } },
                post: (message) => this._webviewView?.webview.postMessage(message)
            });
        }
        return this._memoryAnalysisController;
    }
    async _analyzeElf(params = {}) {
        return this._getMemoryAnalysisController().service.analyze(params);
    }
    async _handleAgentCall(method, params) {
        return this._agentService.call(method, params);
    }
    async stopAgentBridge() {
        return this._agentService.stop();
    }
    // Per-workspace Agent access switch: enabled | disabled | unset (undefined). Stored only in workspaceState.
    _agentAccess() {
        const value = this._context?.workspaceState?.get(AGENT_ACCESS_STATE_KEY);
        return value === "enabled" || value === "disabled" ? value : undefined;
    }
    _agentAccessDecision(status) {
        if (!vscode.workspace.isTrusted) return { enabled: false, state: "untrusted" };
        const access = this._agentAccess();
        if (access === "disabled") return { enabled: false, state: "disabled" };
        if (access === "enabled") return { enabled: true, reason: "access" };
        // Compatibility: with workspace skills installed and no explicit setting, access counts as enabled.
        if (hasWorkspaceSkills(status)) return { enabled: true, reason: "skills" };
        if (this._mcpBridgeRequested) return { enabled: true, reason: "mcp" };
        return { enabled: false, state: "disabled" };
    }
    async _syncAgentBridge(status = this._skillStatusService.lastStatus) {
        const decision = this._agentAccessDecision(status);
        try {
            if (!decision.enabled) {
                this._agentService.accessState = decision.state;
                return await this.stopAgentBridge();
            }
            return await this._agentService.start({ legacyPointer: hasWorkspaceSkills(status) });
        } finally {
            this._postAgentAccess(status, decision);
            this._mcpRegistration?.syncCursor();
        }
    }
    _agentAccessView(status = this._skillStatusService.lastStatus, decision = this._agentAccessDecision(status)) {
        const access = this._agentAccess();
        const legacyGlobal = legacyGlobalSkills(status);
        // Suggest enabling access when global copies exist or the user copied an external MCP configuration but this
        // workspace has it off.
        const external =
            this._skillStatusService.scopeHasContent(status?.scopes?.global) ||
            this._context?.globalState?.get(MCP_CONFIGURED_STATE_KEY) === true;
        let card = "";
        if (decision.enabled && access === "enabled") card = "enabled";
        else if (!decision.enabled && decision.state === "disabled" && (access === "disabled" || external))
            card = "disabled";
        return { access: access || "unset", enabled: decision.enabled, card, legacyGlobal };
    }
    _postAgentAccess(status, decision) {
        this._lastAgentAccess = this._agentAccessView(status, decision);
        this._webviewView?.webview.postMessage({ type: "agentAccess", ...this._lastAgentAccess });
    }
    async setAgentAccess(value) {
        await this._context.workspaceState.update(AGENT_ACCESS_STATE_KEY, value);
        await this._syncAgentBridge();
        this._mcpRegistration?.changed();
        return true;
    }
    // VS Code MCP provider: only trusted windows with an open folder and Agent access not explicitly disabled provide
    // server definitions. Cursor registration additionally requires access to be enabled (isEnabled), because Cursor
    // has no trust prompt.
    _mcpAvailable() {
        return (
            !!vscode.workspace.isTrusted &&
            !!vscode.workspace.workspaceFolders?.length &&
            this._agentAccess() !== "disabled" &&
            !!this._bridgeRegistry
        );
    }
    // emberprobe.mcp.toolsets -> EMBERPROBE_MCP_TOOLSETS; the default toolset yields an empty string and injects no
    // variable.
    _mcpToolsets() {
        const configured = vscode.workspace.getConfiguration?.("emberprobe").get("mcp.toolsets");
        const selected = TOOLSETS.filter((name) => Array.isArray(configured) && configured.includes(name));
        if (!selected.length || selected.join(",") === DEFAULT_TOOLSETS.join(",")) return "";
        return selected.join(",");
    }
    // VS Code resolves the definition after the user accepts the MCP trust prompt; start the Bridge for this window
    // then (no workspace files are written).
    async _requestMcpBridge() {
        this._mcpBridgeRequested = true;
        await this._syncAgentBridge();
    }
    async _markMcpConfigured() {
        await this._context.globalState.update(MCP_CONFIGURED_STATE_KEY, true);
        this._postAgentAccess(this._skillStatusService.lastStatus);
    }
    activateMcp() {
        const registered = this._mcpRegistration.register();
        if (this._context.globalStorageUri)
            this._mcpRegistration.writeLauncher().catch((error) => console.warn("MCP launcher:", error.message));
        return registered;
    }
    mcpConfigurationChanged() {
        this._mcpRegistration.changed();
    }
    // Cleans up unmaintained global skill copies, deleting only entries in the EmberProbe manifest.
    async cleanupGlobalSkills() {
        const confirm = this._t("agent.cleanup");
        const choice = await vscode.window.showWarningMessage(
            this._t("agent.cleanupConfirm"),
            { modal: true },
            confirm
        );
        if (choice !== confirm) return null;
        const status = await skillInstaller.uninstallSkill(vscode, this._context, this._lang, "global");
        this._skillStatusService.lastStatus = status;
        this._skillStatusService.post(status);
        await this._syncAgentBridge(status);
        return true;
    }
    async refreshSkillStatus(autoUpdate = false) {
        const status = await this._skillStatusService.refresh(autoUpdate);
        await this._syncAgentBridge(status);
        return status;
    }
    // Logs who made which call in the output panel: channel, client, method and result code, without parameter values.
    _auditAgentCall(entry) {
        if (!vscode.window.createOutputChannel) return;
        if (!this._agentAudit) {
            this._agentAudit = vscode.window.createOutputChannel(this._t("agent.auditChannel"));
            this._context.subscriptions?.push(this._agentAudit);
        }
        const caller = [entry.channel || "legacy", entry.client].filter(Boolean).join(" ");
        this._agentAudit.appendLine(`${new Date().toISOString()} ${caller} ${entry.method} ${entry.code}`);
    }
    // Checks the skill copy that actually issued the call before running it; custom content needs a separate UI
    // approval, which expires when the content changes again.
    async _warnIfSkillsModified(meta) {
        await this._skillStatusService.checkForCall(meta);
    }
    // Background generation has no withProgress window of its own (the Bridge call returns an operationId immediately),
    // so a cancellable notification is attached to the running operation, reusing the existing progress and cancel
    // handling
    _startAgentCubeMxOperation(params) {
        return this._cubemxService.start(params).then((started) => {
            if (started?.operationId) this._showAgentCubeMxProgress(started.operationId);
            return started;
        });
    }
    _showAgentCubeMxProgress(operationId) {
        const execution = this._cubemxService.activeExecutions.get(operationId);
        if (!execution) return;
        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: this._t("cubemx.generating"),
                cancellable: true
            },
            async (progress, token) => {
                progress.report({ message: this._t("cubemx.generating") });
                const subscription = token.onCancellationRequested(() => this._cubemxService.cancel({ operationId }));
                try {
                    await execution;
                } finally {
                    subscription.dispose();
                }
            }
        );
    }
    // Agent Skills workspace install switch
    async manageAgentSkills() {
        const result = await this._skillStatusService.manage();
        // Reinstalling skills in a workspace that disabled access explicitly resets the switch to unset, so the skills
        // switch turns the Bridge on as before.
        if (result && hasWorkspaceSkills(result) && this._agentAccess() === "disabled")
            await this._context.workspaceState.update(AGENT_ACCESS_STATE_KEY, undefined);
        if (result) await this._syncAgentBridge(result);
        return result;
    }
    // Hidden tabs restore lazily; the stable watch key survives any display-number conflict.
    restoreLiveWatchPanel(panel, state) {
        panel.webview.options = { enableScripts: true, localResourceRoots: [this._webviewAssetRootUri] };
        return this.openLiveWatchPanel(panel, state).initialized;
    }
    _curveVisibility(watchKey) {
        const stored = this._context.workspaceState.get(CURVE_VISIBILITY_STATE_KEY);
        const hidden = stored && typeof stored === "object" ? stored[watchKey] : null;
        return hidden && typeof hidden === "object" && !Array.isArray(hidden) ? hidden : null;
    }
    async _saveCurveVisibility(watchKey, hidden) {
        if (!hidden || typeof hidden !== "object" || Array.isArray(hidden))
            throw Object.assign(new Error("Invalid curve visibility"), { code: "INVALID_ARGUMENT" });
        const entries = Object.entries(hidden).filter(
            ([name, value]) => typeof name === "string" && name.length <= 1024 && typeof value === "boolean"
        );
        if (entries.length > MAX_CURVE_VISIBILITY_ENTRIES)
            throw Object.assign(new Error("Too many curve visibility entries"), { code: "INVALID_ARGUMENT" });
        const stored = this._context.workspaceState.get(CURVE_VISIBILITY_STATE_KEY);
        await this._context.workspaceState.update(CURVE_VISIBILITY_STATE_KEY, {
            ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}),
            [watchKey]: Object.fromEntries(entries)
        });
    }
    _runtimeExpansions(watchKey) {
        const stored = this._context.workspaceState.get(RUNTIME_EXPANSIONS_STATE_KEY);
        const value = stored && typeof stored === "object" ? stored[watchKey] : null;
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    async _saveRuntimeExpansions(watchKey, expansions) {
        const normalized = normalizeRuntimeExpansions(expansions);
        if (JSON.stringify(normalized) === JSON.stringify(this._runtimeExpansions(watchKey))) return;
        const stored = this._context.workspaceState.get(RUNTIME_EXPANSIONS_STATE_KEY);
        await this._context.workspaceState.update(RUNTIME_EXPANSIONS_STATE_KEY, {
            ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}),
            [watchKey]: normalized
        });
        if (this._sampling.pointerExpandedOnly) await this._sampling.refreshSamplingPlan();
    }
    chartBackground() {
        if (!this._chartBackground) {
            const { ChartBackgroundController } = require("./services/chartBackgroundController");
            this._chartBackground = new ChartBackgroundController({
                vscode,
                state: this._context.globalState,
                entries: () => this._livePanels.values(),
                open: () => this.openLiveWatchPanel(),
                t: (key) => this._t(key)
            });
        }
        return this._chartBackground;
    }

    _chartBackgroundState() {
        return this.chartBackground().state();
    }

    // Opens or focuses the live watch panel (a separate WebviewPanel, wide enough for charts in the editor area)
    openLiveWatchPanel(restoredPanel = null, restoredState = null) {
        if (!this._seriesStyleStore) {
            const { SeriesStyleStore } = require("./services/seriesStyleStore");
            this._seriesStyleStore = new SeriesStyleStore(this._context.workspaceState);
        }
        this._livePanelRegistry ||= new LivePanelRegistry(this._context.workspaceState, this._livePanels, () =>
            (vscode.window.tabGroups?.all || []).flatMap((group) => group.tabs)
        );
        const identity = this._livePanelRegistry.claim(
            restoredPanel ? { state: restoredState, title: restoredPanel.title } : null
        );
        const { panelId, watchKey } = identity;
        const panel =
            restoredPanel ||
            vscode.window.createWebviewPanel(
                "emberprobe.liveWatch",
                this._t("lw.panelTitle", { n: panelId }),
                vscode.ViewColumn.Active,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [this._webviewAssetRootUri]
                }
            );
        panel.title = this._t("lw.panelTitle", { n: panelId });
        const panelWebview = panel.webview;
        const post = (m) => panelWebview.postMessage(m);
        const entry = {
            panelId,
            panel,
            post,
            watchKey,
            latestSamples: new Map(),
            ready: false,
            focusOrder: ++this._livePanelFocusOrder
        };
        this._livePanels.set(panelId, entry);
        entry.initialized = identity.initialized
            .then(() => {
                this._watchLists?.invalidate(watchKey);
                entry.initializing = false;
            })
            .catch((error) => {
                entry.initializationError = error;
                console.error("Chart identity persistence failed:", error);
            });
        entry.initializing = true;
        this._sampling.invalidateConsumerTypes();
        this._renderWebview(
            panel.webview,
            liveWatchView.getLiveWatchContent(
                {
                    frequencyHz: this._sampling.frequencyHz,
                    panelId,
                    watchKey
                },
                this._lang
            ),
            `live-watch-${panelId}`
        );
        panel.onDidChangeViewState((event) => {
            if (event.webviewPanel.active) {
                entry.focusOrder = ++this._livePanelFocusOrder;
                post(this._chartBackgroundState());
            }
        });
        const backgroundFocus = vscode.window.onDidChangeWindowState?.((state) => {
            if (state.focused) post(this._chartBackgroundState());
        });
        panel.onDidDispose(() => {
            entry.disposed = true;
            backgroundFocus?.dispose();
            this._chartBackground?.cancel(entry);
            this._flushChartHistoryAppend(entry);
            if (entry._batchTimer) clearTimeout(entry._batchTimer);
            this._chartHistory?.request("remove", [this._debugSamplingScope(watchKey)]).catch(() => {});
            this._webviewRenders?.delete(panelWebview);
            this._livePanels.delete(panelId);
            this._livePanelRegistry.release(panelId).catch(console.error);
            pruneWebviewAssets(this._webviewAssetRootUri.fsPath, `live-watch-${panelId}`, new Set());
            this._sampling.invalidateConsumerTypes();
            this._sampling.refreshSamplingPlan().catch(() => {});
        });
        panel.webview.onDidReceiveMessage(createLivePanelHandler(this, entry, vscode));
        return entry;
    }
    // Reads the global variable symbols of the current ELF, attaching DWARF type information where possible
    _invalidateElfState() {
        this._elfService.invalidate();
        this._watchLists.invalidate();
        this._sampling.invalidateRuntimeRam();
        this._runtimeSampleHold?.reset();
        this._latestSidebarSamples.clear();
        for (const entry of this._livePanels.values()) entry.latestSamples.clear();
    }
    async _refreshElfBindings() {
        this._invalidateElfState();
        const memoryRefresh = this._memoryAnalysisController?.refresh();
        try {
            if (this._context.workspaceState.get(CACHE_KEYS.elfPath)) {
                const result = await this._elfService.ready();
                await this._hydrateSelectedLayouts(result);
                await this._rebindWatchLists(result.symbols);
            }
        } finally {
            await this._sampling.refreshSamplingPlan();
        }
        await memoryRefresh;
        this._syncSidebarTarget((message) => this._webviewView?.webview.postMessage(message));
        for (const entry of this._livePanels.values()) {
            this._syncGraphTarget(entry);
            entry.post({ type: "watchList", items: this._scalarWatchList(entry.watchKey), resetValues: true });
        }
        this._webviewView?.webview.postMessage({
            type: "sidebarWatchList",
            items: this._watchListWithDisplayNames(CACHE_KEYS.sidebarWatchList),
            resetValues: true
        });
    }
    _watchIdentities(items) {
        return items.map((item) => ({
            name: item.name,
            type: item.type,
            ...(Number.isInteger(item.bitSize) ? { bitSize: item.bitSize, bitOffset: item.bitOffset } : {}),
            ...(item.layoutExpanded ? { layoutExpanded: true } : {}),
            ...(item.min !== undefined ? { min: item.min } : {}),
            ...(item.max !== undefined ? { max: item.max } : {}),
            ...(item.value !== undefined ? { value: item.value } : {})
        }));
    }
    async _saveWatchList(key, items, { syncSidebar = true } = {}) {
        // Persist identities only. Layouts, handles and expansions are derived from
        // the current ELF; normalization must verify them again after a reload.
        const selected = Array.isArray(items) ? items : [];
        const normalized = this._watchLists.normalize
            ? this._watchLists.normalize(selected, this.readElfSymbols().symbols, key)
            : selected;
        const persisted = this._watchIdentities(normalized);
        await this._watchLists.save(key, persisted);
        this._sampling.pruneSampleMap(this._latestSidebarSamples, [
            CACHE_KEYS.sidebarWatchList,
            CACHE_KEYS.sidebarWriteList
        ]);
        for (const entry of this._livePanels.values())
            this._sampling.pruneSampleMap(entry.latestSamples, entry.watchKey);
        await this._sampling.refreshSamplingPlan();
        // Selection/value changes do not change ELF metadata. Echoing a local sidebar edit
        // also replaces the active write input and interrupts wheel/slider gestures.
        if (syncSidebar) this._syncSidebarTarget((message) => this._webviewView?.webview.postMessage(message), true);
        for (const entry of this._livePanels.values()) this._syncGraphTarget(entry, true);
    }
    readElfSymbols() {
        const result = this._elfService.read();
        this._liveWatchService?.setElfResult?.(result);
        return result;
    }
    _symbolNameIndex(symbols) {
        if (!Array.isArray(symbols)) return new Map();
        this._symbolNameIndexes ||= new WeakMap();
        const cached = this._symbolNameIndexes.get(symbols);
        if (cached?.length === symbols.length) return cached.index;
        const index = buildSymbolNameIndex(symbols);
        this._symbolNameIndexes.set(symbols, { length: symbols.length, index });
        return index;
    }
    // Return structured choices to the combobox; never select a default for an ambiguous name.
    async _resolveLiveVariable(message, post) {
        const result = await this._elfService.ready();
        const version = this._elfVersion(result);
        if (message.version && message.version !== version) return;
        const generation = this._elfService.generation;
        const reply = { version, requestId: message.requestId, requestedName: message.name };
        let found;
        try {
            found = elfSymbols.createSymbolResolver(result.symbols)(message.name);
        } catch (error) {
            if (error.code === "VARIABLE_AMBIGUOUS") {
                const candidates = error.details.candidates;
                if (candidates.length > 1) post({ type: "variableChoices", ...reply, candidates });
                else
                    post({
                        type: "liveError",
                        ...reply,
                        key: "live.varIdentityAmbiguous",
                        params: { name: candidates[0]?.displayName || message.name }
                    });
            } else {
                post({ type: "liveError", ...reply, key: "live.varNotFound", params: { name: message.name } });
            }
            return;
        }
        if (found.isComposite) {
            try {
                await this._elfService.layout(found.name);
            } catch (error) {
                if (generation === this._elfService.generation)
                    post({ type: "liveError", ...reply, ...toUiError(error) });
                return;
            }
        }
        if (generation !== this._elfService.generation || version !== this._elfVersion(this._elfService.cache)) return;
        post({ type: "addResolved", ...reply, symbol: found });
    }
    // Prefetches DWARF layouts of the composites in a request. With options.layoutErrors, layout errors are collected
    // per item (keyed by original symbol name) without aborting the batch; without it the first layout error throws.
    // Name resolution failures are left to the later planning step.
    async _prepareRequestedLayouts(requests, options = {}) {
        const result = await this._elfService.ready();
        const resolveSymbol = elfSymbols.createSymbolResolver(result.symbols);
        for (const request of Array.isArray(requests) ? requests : []) {
            const name = typeof request === "string" ? request : request?.name;
            const parsed = elfSymbols.parseMemberPath(name);
            const base = parsed ? parsed.base : name;
            let symbol;
            try {
                symbol = resolveSymbol(base);
            } catch {
                continue;
            }
            if ((!symbol.isComposite && !symbol.hasRuntimeLayout) || symbol.compositeLayout) continue;
            try {
                await this._elfService.layout(symbol.name);
            } catch (error) {
                if (!options.layoutErrors) throw error;
                options.layoutErrors.set(symbol.name, error);
            }
        }
        return result;
    }
    _elfVersion(result) {
        const sha256 = result?.elf?.sha256 || "";
        return result?.companions?.length
            ? sha256 + ":" + result.companions.map((entry) => entry.sha256 || "missing").join(":")
            : sha256;
    }
    _sendElfSnapshot(post, listType) {
        const result = this._elfService?.cache;
        if (!result?.elf) return;
        const version = this._elfVersion(result);
        post({
            type: `${listType}Reset`,
            version,
            generation: this._elfService.generation,
            warnings: displayWarnings(result)
        });
        for (let i = 0; i < result.symbols.length; i += 1000)
            post({ type: `${listType}Chunk`, version, symbols: result.symbols.slice(i, i + 1000) });
        post({ type: `${listType}Done`, version, total: result.symbols.length, warnings: displayWarnings(result) });
        if (result.dwarfReady)
            post({
                type: listType === "availableVariables" ? "availableTypesDone" : "variableTypesDone",
                version,
                warnings: displayWarnings(result)
            });
    }
    _onElfChange(phase, result, entries) {
        // Worker chunks and DWARF display-name enrichment mutate the same symbols array.
        this._symbolNameIndexes?.delete(result.symbols);
        const version = this._elfVersion(result);
        const sidebarPost = (message) => this._webviewView?.webview.postMessage(message);
        const graphPosts = Array.from(this._livePanels.values())
            .filter((entry) => entry.ready)
            .map((entry) => entry.post);
        if (phase === "metadata") {
            this._watchLists.invalidate();
            sidebarPost({
                type: "availableVariablesReset",
                version,
                generation: this._elfService.generation,
                warnings: displayWarnings(result)
            });
            for (const post of graphPosts)
                post({
                    type: "variablesListReset",
                    version,
                    generation: this._elfService.generation,
                    warnings: displayWarnings(result)
                });
        } else if (phase === "symbols") {
            sidebarPost({ type: "availableVariablesChunk", version, symbols: entries });
            for (const post of graphPosts) post({ type: "variablesListChunk", version, symbols: entries });
        } else if (phase === "symbolsDone") {
            sidebarPost({
                type: "availableVariablesDone",
                version,
                total: result.symbols.length,
                warnings: displayWarnings(result)
            });
            for (const post of graphPosts)
                post({
                    type: "variablesListDone",
                    version,
                    total: result.symbols.length,
                    warnings: displayWarnings(result)
                });
        } else if (phase === "identities") {
            // DWARF refined the CU identities of same-named statics: resend the renamed symbol list.
            this._watchLists.invalidate();
            this._sendElfSnapshot(sidebarPost, "availableVariables");
            for (const post of graphPosts) this._sendElfSnapshot(post, "variablesList");
        } else if (phase === "types") {
            const symbols = entries.map((symbol) => ({
                name: symbol.name,
                displayName: symbol.displayName || symbol.name,
                typeName: symbol.typeName,
                watchType: symbol.watchType,
                isComposite: symbol.isComposite,
                hasRuntimeLayout: symbol.hasRuntimeLayout,
                unsupportedReason: symbol.unsupportedReason || "",
                hasDwarfWriteType: symbol.hasDwarfWriteType,
                sourceFile: symbol.sourceFile || "",
                origin: symbol.origin || "user",
                ...(symbol.enumInfo ? { enumInfo: symbol.enumInfo } : {}),
                ...(symbol.isEnum ? { isEnum: true } : {}),
                ...(symbol.isBoolean ? { isBoolean: true } : {}),
                ...(symbol.isConst ? { isConst: true } : {}),
                ...(symbol.isReference ? { isReference: true } : {}),
                ...(symbol.isMemberPointer ? { isMemberPointer: true } : {}),
                ...(symbol.isPointer ? { isPointer: true, pointerTarget: symbol.pointerTarget } : {})
            }));
            sidebarPost({ type: "availableVariableTypes", version, symbols });
            for (const post of graphPosts) post({ type: "variableTypes", version, symbols });
        } else if (phase === "dwarfReady") {
            sidebarPost({ type: "availableTypesDone", version, warnings: displayWarnings(result) });
            for (const post of graphPosts)
                post({ type: "variableTypesDone", version, warnings: displayWarnings(result) });
            this._elfRebindPromise = this._hydrateSelectedLayouts(result)
                .then(() => this._rebindWatchLists(result.symbols))
                .then(() => {
                    this._syncSidebarTarget(sidebarPost, true);
                    for (const entry of this._livePanels.values()) this._syncGraphTarget(entry, true);
                })
                .catch((error) => console.error("ELF watch list rebind failed:", error));
            this._elfRebindPromise.then(() => this._sampling.refreshSamplingPlan()).catch(() => {});
        } else if (phase === "failed") {
            sidebarPost({
                type: "availableVariablesDone",
                version,
                warnings: displayWarnings(result),
                error: result.symbols.length ? "" : result.warnings[result.warnings.length - 1]
            });
            for (const post of graphPosts)
                post({
                    type: "variablesListDone",
                    version,
                    warnings: displayWarnings(result),
                    error: result.symbols.length ? "" : result.warnings[result.warnings.length - 1]
                });
        }
    }
    async _hydrateSelectedLayouts(result) {
        const names = new Set();
        const keys = [CACHE_KEYS.sidebarWatchList, CACHE_KEYS.sidebarWriteList, CACHE_KEYS.watchList];
        for (const entry of this._livePanels.values()) keys.push(entry.watchKey);
        for (const key of keys) {
            for (const item of this._context.workspaceState.get(key) || []) {
                const parsed = elfSymbols.parseMemberPath(item?.name);
                if (parsed) names.add(parsed.base);
                else if (item?.name) names.add(item.name);
            }
        }
        const byName = new Map(result.symbols.map((symbol) => [symbol.name, symbol]));
        for (const name of names) {
            const symbol = byName.get(name);
            if (!symbol?.isComposite && !symbol?.hasRuntimeLayout) continue;
            try {
                await this._elfService.layout(name);
            } catch (error) {
                result.warnings.push(`${symbol.displayName || name}: ${error.message}`);
            }
        }
    }
    async _resolveElfLayout(name, version) {
        const result = await this._elfService.ready();
        if (version !== this._elfVersion(result))
            throw Object.assign(new Error("ELF changed while resolving layout"), { code: "ELF_CHANGED" });
        return this._elfService.layout(name);
    }
    _layoutExpansionSnapshot(name) {
        const symbol = this._elfService.symbolByName.get(name);
        return symbol?.layoutExpansions
            ? {
                  layoutExpansions: symbol.layoutExpansions,
                  layoutExpansionGeneration: symbol.layoutExpansionGeneration
              }
            : {};
    }
    async _expandElfLayout(message) {
        validation.validateLayoutExpansionRequest(message.handle, message.generation);
        validation.validateLayoutExpansionTarget(message.name, message.path);
        const result = await this._elfService.ready();
        if (message.generation !== this._elfService.generation || message.version !== this._elfVersion(result))
            throw Object.assign(new Error("ELF changed while expanding layout"), { code: "STALE_LAYOUT_HANDLE" });
        const layout = await this._elfService.expandSymbolLayout(
            message.name,
            message.path,
            message.handle,
            message.generation
        );
        if (message.generation !== this._elfService.generation)
            throw Object.assign(new Error("ELF changed while expanding layout"), { code: "STALE_LAYOUT_HANDLE" });
        return layout;
    }
    async _handleLayoutExpansion(message, post) {
        const identity = {
            type: "layoutExpansionResult",
            name: message.name,
            path: message.path,
            handle: message.handle,
            generation: message.generation,
            version: message.version
        };
        let layout;
        try {
            layout = await this._expandElfLayout(message);
        } catch (error) {
            post({ ...identity, code: error.code || "LAYOUT_EXPANSION_FAILED" });
            return;
        }
        const reply = { ...identity, layout };
        post(reply);
        this._webviewView?.webview.postMessage(reply);
        for (const entry of this._livePanels.values()) entry.post(reply);
        this._watchLists.invalidate();
        this._syncSidebarTarget((message) => this._webviewView?.webview.postMessage(message), true);
        for (const entry of this._livePanels.values()) this._syncGraphTarget(entry, true);
        await this._sampling.refreshSamplingPlan();
    }
    // Chart and sidebar keep separate selections; one probe connection samples the union of both enabled lists.
    _postLive(message) {
        if (message.type === "liveStatus") message = withWriteAccessStatus({ ...this._sampling.status(), ...message });
        if (message.type === "liveError" && message.message && typeof message.message === "object")
            message = {
                ...toUiError(message.message),
                ...message,
                message: message.message.message || String(message.message)
            };
        for (const entry of this._livePanels.values()) entry.post(message);
        this._webviewView?.webview.postMessage(message);
    }
    _postConsumerStatuses(payload, error = false) {
        const p = typeof payload === "string" ? { message: payload } : payload || {};
        const status = this._sampling.status();
        let message = { type: "liveStatus", ...status, ...p, error };
        message.canWrite = message.canWrite === true && status.canWrite;
        if (this._samplingCoordinator.backpressured) {
            message.canRead = false;
            message.canWrite = false;
            message.snapshotReady = false;
        }
        message = withWriteAccessStatus(message);
        for (const entry of this._livePanels.values()) entry.post(message);
        this._webviewView?.webview.postMessage({
            ...message,
            frequencyHz: 20,
            actualHz: message.consumers?.sidebarHz ?? message.actualHz
        });
    }
    // Watch lists resolve against DWARF types; before they load, the empty list means "not known yet".
    _watchListsReady() {
        return !(this._elfService?.workerPath && !this._elfService.cache?.dwarfReady);
    }
    _scalarWatchList(key) {
        if (!this._watchListsReady()) return [];
        if (this._watchGeneration !== this._elfService?.generation) {
            this._watchGeneration = this._elfService?.generation;
            this._watchLists.invalidate();
        }
        return this._watchLists.read(key);
    }
    _variableDisplayName(item, symbols = null) {
        let byName;
        try {
            byName = this._symbolNameIndex(symbols || this.readElfSymbols().symbols);
        } catch {
            // Saved labels remain usable while ELF metadata is unavailable.
        }
        return variableDisplayName(item, byName);
    }
    _displayNamesForSeries(watchKey, names) {
        const watched = new Map((this._scalarWatchList(watchKey) || []).map((item) => [item.name, item]));
        let symbols = new Map();
        try {
            symbols = this._symbolNameIndex(this.readElfSymbols().symbols);
        } catch {
            // Cached watch labels are still available if ELF metadata is loading or unavailable.
        }
        const lookup = {
            get: (name) => {
                const symbol = symbols.get(name);
                return symbol?.displayName && symbol.displayName !== symbol.name ? symbol : watched.get(name) || symbol;
            }
        };
        return new Map(
            (Array.isArray(names) ? names : []).map((value) => {
                const name = String(value);
                return [name, variableDisplayName(watched.get(name) || { name }, lookup)];
            })
        );
    }
    // Sidebar watch items carry displayName (C++ qualified name) for display; data is still indexed by the original
    // item.name.
    _watchListWithDisplayNames(key) {
        const items = this._scalarWatchList(key);
        if (!Array.isArray(items) || !items.length) return items;
        let byName = null;
        try {
            byName = this._symbolNameIndex(this.readElfSymbols().symbols);
        } catch {
            byName = null;
        }
        if (!byName) return items;
        return items.map((item) => {
            if (!item || !item.name) return item;
            const displayName = variableDisplayName(item, byName);
            return displayName !== item.name && displayName !== item.displayName ? { ...item, displayName } : item;
        });
    }
    async _rebindWatchLists(symbols) {
        const entries = Array.from(this._livePanels.values());
        const keys = [
            CACHE_KEYS.sidebarWatchList,
            CACHE_KEYS.sidebarWriteList,
            CACHE_KEYS.watchList,
            ...entries.map((entry) => entry.watchKey)
        ];
        const expanded = keys.flatMap((key) =>
            (this._context.workspaceState.get(key) || []).filter((item) => item.layoutExpanded)
        );
        const expandedByName = new Map(expanded.map((item) => [item.name, item]));
        const changes = { renamed: new Map(), ambiguous: new Map() };
        this._watchNameChanges = changes;
        let rebound;
        try {
            rebound = await this._watchLists.rebind(
                [
                    CACHE_KEYS.sidebarWatchList,
                    CACHE_KEYS.sidebarWriteList,
                    CACHE_KEYS.watchList,
                    ...entries.map((entry) => entry.watchKey)
                ],
                symbols
            );
        } finally {
            this._watchNameChanges = null;
        }
        const valid = new Set([...rebound.values()].flat().map((item) => item.name));
        const invalid = [
            ...new Set(
                expanded
                    .filter((item) => !valid.has(changes.renamed.get(item.name) || item.name))
                    .map((item) => item.name)
            )
        ].filter((name) => !changes.ambiguous.has(name));
        if (invalid.length)
            this._postLive({
                type: "liveError",
                key: "lw.layoutWatchInvalid",
                params: {
                    names: invalid
                        .map((name) => this._variableDisplayName(expandedByName.get(name) || { name }, symbols))
                        .join(", ")
                }
            });
        // A saved name that now matches same-named variables of several CUs is removed, never bound to one of them.
        if (changes.ambiguous.size)
            this._postLive({
                type: "liveError",
                key: "lw.watchAmbiguous",
                params: {
                    names: [...changes.ambiguous]
                        .map(([name, candidates]) => {
                            const displayName = symbols.find((symbol) => symbol.name === candidates[0])?.displayName;
                            return this._variableDisplayName(
                                { name, displayName: displayName && (variableScope(displayName)?.name || displayName) },
                                symbols
                            );
                        })
                        .join(", "),
                    candidates: [...new Set([...changes.ambiguous.values()].flat())]
                        .slice(0, 8)
                        .map((name) => symbols.find((symbol) => symbol.name === name)?.displayName || name)
                        .join(", ")
                }
            });
        this._latestSidebarSamples.clear();
        for (const entry of entries) entry.latestSamples.clear();
        return { entries, rebound };
    }
    _syncGraphTarget(entry, skipElf = false) {
        if (!entry || !entry.ready) return;
        const post = entry.post;
        if (!skipElf && this._elfService) {
            this._sendElfSnapshot(post, "variablesList");
            this._elfService
                .load()
                .catch((error) => post({ type: "variablesListDone", warnings: [error.message], error: error.message }));
        } else if (!skipElf && this.readElfSymbols) {
            try {
                const result = this.readElfSymbols();
                post({ type: "variablesList", symbols: result.symbols, warnings: displayWarnings(result) });
            } catch (error) {
                post({ type: "variablesList", symbols: [], warnings: [error.message], error: error.message });
            }
        }
        // A chart keeps its current watches until the real list can be resolved; the rebind after
        // DWARF loading sends it.
        if (this._watchListsReady()) post({ type: "watchList", items: this._scalarWatchList(entry.watchKey) });
        this._configureChartHistory(entry);
        post({
            type: "liveStatus",
            ...this._sampling.status()
        });
        if (entry.latestSamples.size) {
            const now = Date.now();
            const scalarSamples = [],
                compositeSamples = [];
            for (const sample of entry.latestSamples.values()) {
                if (sample.tree) compositeSamples.push({ ...sample, t: now });
                else scalarSamples.push({ ...sample, t: now });
            }
            if (scalarSamples.length) post({ type: "chartValues", samples: scalarSamples });
            if (compositeSamples.length) post({ type: "liveCompositeSample", samples: compositeSamples });
        }
    }
    _syncSidebarTarget(post, skipElf = false) {
        post({ type: "sidebarWatchList", items: this._watchListWithDisplayNames(CACHE_KEYS.sidebarWatchList) });
        post({ type: "sidebarWriteList", items: this._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || [] });
        if (!skipElf) {
            this._sendElfSnapshot(post, "availableVariables");
            this._elfService?.load().catch((error) =>
                post({
                    type: "availableVariablesDone",
                    errorKey: error.i18nKey,
                    params: error.i18nParams,
                    error: error.message
                })
            );
        }
        post({
            type: "liveStatus",
            ...this._sampling.status()
        });
        if (this._latestSidebarSamples.size) {
            const now = Date.now();
            const scalarSamples = [];
            const compositeSamples = [];
            for (const s of this._latestSidebarSamples.values()) {
                if (s.tree) compositeSamples.push({ ...s, t: now });
                else scalarSamples.push({ ...s, t: now });
            }
            if (scalarSamples.length) post({ type: "liveSample", samples: scalarSamples });
            if (compositeSamples.length) post({ type: "liveCompositeSample", samples: compositeSamples });
        }
    }
    _resetChartHistoryWarnings() {
        this._chartHistoryLimitedWarned = false;
        this._chartHistoryRecoveryErrorWarned = false;
        this._chartHistoryRecoveryAttempts = 0;
    }
    _handleChartHistoryError(error) {
        if (["CHART_HISTORY_FULL", "CHART_HISTORY_BACKPRESSURE"].includes(error.code)) {
            this._warnChartHistoryLimited();
            return;
        }
        // Sampling and the archive of record continue while the cache is unavailable.
        for (const entry of this._livePanels.values()) {
            entry._historyRecoveryReady = false;
            this._discardChartHistoryAppend(entry);
        }
        void this._recoverChartHistory();
    }
    _warnChartHistoryLimited() {
        if (this._chartHistoryLimitedWarned) return;
        this._chartHistoryLimitedWarned = true;
        // Shown once as a Live Watch notice where the chart is, not as a popup.
        this._postLive({ type: "chartHistoryLimited" });
    }
    _limitChartHistory(entry, scope, tick) {
        this._discardChartHistoryAppend(entry);
        const revision = entry.historyRevision || 0;
        const marker = entry._historyLimit;
        if (marker?.scope === scope && marker.revision === revision) return marker.task;
        const task = this._chartHistory.limit
            ? this._chartHistory.limit(scope, tick)
            : this._chartHistory.request("markLimited", [scope, tick]);
        const pending = (this._pendingChartHistoryAppends ||= new Set());
        const tracked = task
            .then((status) => {
                if (status?.limited) this._warnChartHistoryLimited();
            })
            .catch((error) => this._chartHistory.fail(error))
            .finally(() => {
                pending.delete(tracked);
                if (entry._historyLimit?.task === tracked) entry._historyLimit = null;
            });
        entry._historyLimit = { scope, revision, task: tracked };
        pending.add(tracked);
        return tracked;
    }
    _discardChartHistoryAppend(entry) {
        if (entry._historyBatchTimer) clearTimeout(entry._historyBatchTimer);
        entry._historyBatchTimer = null;
        this._queuedChartHistoryBytes = Math.max(
            0,
            (this._queuedChartHistoryBytes || 0) - (entry._historyBatch?.bytes || 0)
        );
        entry._historyBatch = null;
    }
    _queueChartHistoryAppend(entry, samples, tick) {
        if (!this._chartHistory || !samples.length) return;
        if (entry._historyRestoreTask || (this._chartHistoryRecovery && !entry._historyRecoveryReady)) {
            entry._historyRestoreGapTick = tick;
            return;
        }
        if (this._chartHistory.failed) return;
        const scope = this._debugSamplingScope(entry.watchKey);
        const revision = entry.historyRevision || 0;
        if (entry._historyBatch && (entry._historyBatch.scope !== scope || entry._historyBatch.revision !== revision))
            this._discardChartHistoryAppend(entry);
        const bytes = estimateHistoryBytes([scope, samples, tick]);
        const queuedBytes = (this._queuedChartHistoryBytes || 0) + bytes;
        // Host batching and worker IPC share the existing backlog budget.
        if (queuedBytes + (this._chartHistory.queuedBytes || 0) > MAX_BACKLOG_BYTES) {
            this._limitChartHistory(entry, scope, tick);
            return;
        }
        const batch = (entry._historyBatch ||= { scope, revision, samples: [], tick, bytes: 0 });
        batch.tick = Math.max(batch.tick, tick);
        batch.bytes += bytes;
        this._queuedChartHistoryBytes = queuedBytes;
        for (const sample of samples) batch.samples.push(sample.t == null ? { ...sample, t: tick } : sample);
        if (batch.bytes >= 256 * 1024) this._flushChartHistoryAppend(entry);
        else if (!entry._historyBatchTimer)
            entry._historyBatchTimer = setTimeout(() => this._flushChartHistoryAppend(entry), 50);
    }
    _flushChartHistoryAppend(entry) {
        const batch = entry._historyBatch;
        this._discardChartHistoryAppend(entry);
        if (
            !batch ||
            !this._chartHistory ||
            this._chartHistory.failed ||
            entry._historyRestoreTask ||
            (this._chartHistoryRecovery && !entry._historyRecoveryReady) ||
            batch.scope !== this._debugSamplingScope(entry.watchKey) ||
            batch.revision !== (entry.historyRevision || 0)
        )
            return;
        batch.samples.sort((a, b) => a.t - b.t);
        const pending = (this._pendingChartHistoryAppends ||= new Set());
        const task = this._chartHistory
            .request("append", [batch.scope, batch.samples, batch.tick])
            .then((status) => {
                if (status?.limited) this._warnChartHistoryLimited();
            })
            .catch((error) => {
                if (["CHART_HISTORY_FULL", "CHART_HISTORY_BACKPRESSURE"].includes(error.code))
                    return this._limitChartHistory(entry, batch.scope, batch.tick);
                this._chartHistory.fail(error);
            })
            .finally(() => pending.delete(task));
        pending.add(task);
        return task;
    }
    _flushPendingChartHistorySamples() {
        for (const entry of this._livePanels?.values() || []) this._flushChartHistoryAppend(entry);
        return Promise.all([...(this._pendingChartHistoryAppends || [])]);
    }
    _configureChartHistory(entry, acquisitionTime = Date.now()) {
        if (!this._chartHistory) return;
        const scope = this._debugSamplingScope(entry.watchKey);
        const watched = this._scalarWatchList(entry.watchKey);
        const owners = new Set(watched.map((item) => item.name));
        for (const [name, leaf] of entry.runtimeHistoryLeaves || [])
            if (!owners.has(leaf.runtimeOwner)) entry.runtimeHistoryLeaves.delete(name);
        const items = buildChartHistoryItems(watched, elfSymbols, [...(entry.runtimeHistoryLeaves?.values() || [])]);
        const identity = (item) => JSON.stringify([item.type, item.address, item.bitOffset, item.bitSize]);
        const previous = new Map(
            (entry.historyScope === scope ? entry.historyItems || [] : []).map((item) => [item.name, item])
        );
        if (entry.historyScope && entry.historyScope !== scope) {
            this._discardChartHistoryAppend(entry);
            this._chartHistory.request("remove", [entry.historyScope]).catch((error) => this._chartHistory.fail(error));
        }
        entry.historyScope = scope;
        const signature = JSON.stringify([scope, items]);
        if (entry.historySignature === signature) return;
        this._flushChartHistoryAppend(entry);
        entry.historySignature = signature;
        entry.historyItems = items.map((item) => ({
            ...item,
            historyIdentity: identity(item),
            historyFromMs:
                previous.has(item.name) && previous.get(item.name).historyIdentity === identity(item)
                    ? previous.get(item.name).historyFromMs
                    : acquisitionTime
        }));
        entry.historyIdentities = new Map(entry.historyItems.map((item) => [item.name, item.historyIdentity]));
        this._chartHistory
            .request("configure", [scope, entry.historyItems, this._samplingArchive.generations?.get(scope) || 0])
            .then((status) => {
                if (entry.historySignature === signature && entry.ready)
                    entry.post({ type: "chartHistoryStatus", ...status, historyRevision: entry.historyRevision || 0 });
            })
            .catch((error) => this._chartHistory.fail(error));
    }
    _restoreChartHistory(entry, names, recoveryToken) {
        if (entry._historyRestoreTask) return entry._historyRestoreTask;
        this._flushChartHistoryAppend(entry);
        const scope = this._debugSamplingScope(entry.watchKey);
        const revision = entry.historyRevision || 0;
        const signature = entry.historySignature;
        const current = () =>
            (!recoveryToken || recoveryToken.active) &&
            !this._chartHistory.disposed &&
            !this._shutdownPromise &&
            [...this._livePanels.values()].includes(entry) &&
            scope === this._debugSamplingScope(entry.watchKey) &&
            revision === (entry.historyRevision || 0) &&
            signature === entry.historySignature;
        let restoredThrough = -Infinity;
        const task = (async () => {
            await this._flushPendingChartHistorySamples();
            if (!current()) return;
            const source = await this._samplingArchive.historySource(scope);
            if (!current()) return;
            await this._chartHistory.request("restore", [{ ...source, names }]);
            if (!current()) return;
            // One bounded catch-up pass includes samples archived during the first scan.
            const catchup = await this._samplingArchive.historySource(scope);
            if (!current()) return;
            if (catchup.generation !== source.generation) return;
            if (catchup.cutoff > source.cutoff)
                await this._chartHistory.request("restore", [{ ...catchup, names, fromOffset: source.cutoff }]);
            if (!current()) return;
            restoredThrough = catchup.lastTimestampMs;
            const status = await this._chartHistory.request("status", [scope]);
            if (current()) {
                if (status.limited) this._warnChartHistoryLimited();
                entry.post({ type: "chartHistoryStatus", ...status, historyRevision: revision });
            }
        })()
            .catch((error) => {
                if (error.code !== "CHART_HISTORY_RESTORE_CANCELLED") throw error;
            })
            .finally(async () => {
                if (entry._historyRestoreTask !== task) return;
                entry._historyRestoreTask = null;
                if (!current()) return;
                entry._historyRecoveryReady = true;
                const gapTick = entry._historyRestoreGapTick;
                entry._historyRestoreGapTick = null;
                // Partial restores also leave other channels' skipped samples missing.
                if (Number.isFinite(gapTick) && (names || gapTick > restoredThrough)) {
                    const status = await this._chartHistory.request("markLimited", [scope, gapTick]);
                    if (current()) {
                        if (status.limited) this._warnChartHistoryLimited();
                        entry.post({ type: "chartHistoryStatus", ...status, historyRevision: revision });
                    }
                }
            });
        entry._historyRestoreTask = task;
        entry._historyRestoreToken = recoveryToken;
        return task;
    }
    _recoverChartHistory() {
        if (this._chartHistoryRecovery) return this._chartHistoryRecovery;
        if (!this._chartHistory?.failed || this._chartHistory.disposed || this._shutdownPromise)
            return Promise.resolve();
        const task = (async () => {
            let error = this._chartHistory.failed;
            // At most three restarts per run/clear, including recurring failures after a successful recovery.
            while ((this._chartHistoryRecoveryAttempts || 0) < 3) {
                const attempt = (this._chartHistoryRecoveryAttempts = (this._chartHistoryRecoveryAttempts || 0) + 1);
                const delays = this._chartHistoryRecoveryDelaysMs || CHART_HISTORY_RECOVERY_DELAYS_MS;
                await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
                if (this._chartHistory.disposed || this._shutdownPromise) return;
                let timer;
                const token = { active: true };
                try {
                    await Promise.race([
                        (async () => {
                            for (const entry of this._livePanels.values()) entry._historyRecoveryReady = false;
                            await this._flushPendingChartHistorySamples();
                            await this._chartHistory.restart();
                            if (!token.active) return;
                            for (const entry of this._livePanels.values()) {
                                if (!token.active) return;
                                entry.historyRevision = (entry.historyRevision || 0) + 1;
                                entry.post({ type: "debugSessionChanged" });
                                const scope = this._debugSamplingScope(entry.watchKey);
                                await this._chartHistory.request("configure", [
                                    scope,
                                    entry.historyItems || this._scalarWatchList(entry.watchKey),
                                    this._samplingArchive.generations?.get(scope) || 0
                                ]);
                                if (!token.active) return;
                                if (entry.historyViewportNames?.length)
                                    await this._chartHistory.request("touchViewport", [
                                        scope,
                                        entry.historyViewportNames
                                    ]);
                                if (!token.active) return;
                                await this._restoreChartHistory(entry, undefined, token);
                            }
                            if (this._chartHistory.failed) throw this._chartHistory.failed;
                        })(),
                        new Promise((resolve, reject) => {
                            timer = setTimeout(() => {
                                token.active = false;
                                reject(new Error("History recovery timed out"));
                            }, 30000);
                        })
                    ]);
                    return;
                } catch (failure) {
                    error = failure;
                    token.active = false;
                    for (const entry of this._livePanels.values())
                        if (entry._historyRestoreToken === token) entry._historyRestoreTask = null;
                    this._chartHistory.fail(failure);
                } finally {
                    clearTimeout(timer);
                }
            }
            if (!this._chartHistoryRecoveryErrorWarned) {
                this._chartHistoryRecoveryErrorWarned = true;
                this._postLive({
                    type: "liveError",
                    ...toUiError(
                        Object.assign(new Error(this._t("lw.historyRecoveryFailed")), {
                            i18nKey: "lw.historyRecoveryFailed",
                            details: { cause: serializeError(error) }
                        })
                    )
                });
            }
        })().finally(() => {
            if (this._chartHistoryRecovery === task) this._chartHistoryRecovery = null;
        });
        this._chartHistoryRecovery = task;
        return task;
    }
    samplingFrequencyConfigurationChanged() {
        if (this._savingFrequency) return;
        const value = configuredFrequencyHz(vscode.workspace.getConfiguration("emberprobe"));
        if (value !== this._sampling.frequencyHz) this._sampling.setIntervalMs(intervalMsFromHz(value), value);
    }
    // The archive lives only for this extension session, so the limit applies immediately instead of on reload.
    samplingArchiveConfigurationChanged() {
        const mib = validation.clampInteger(
            vscode.workspace.getConfiguration("emberprobe").get("samplingArchiveMaxMiB", 1024),
            1024,
            64,
            102400
        );
        this._samplingArchive?.setMaxBytes(mib * 1024 * 1024);
    }
    // Long archive exports report progress in a cancellable notification and in the waveform panel's status line.
    _exportArchiveCsvWithProgress(post, request) {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: this._t("msg.csvExporting", { file: path.basename(request.outputPath) }),
                cancellable: true
            },
            async (progress, token) => {
                let percent = 0,
                    postedAt = 0;
                post({ type: "exportCsvProgress", percent: 0 });
                return this._samplingArchive.exportCsv({
                    ...request,
                    isCancelled: () => token.isCancellationRequested,
                    onProgress: (fraction) => {
                        const next = Math.min(99, Math.floor(fraction * 100));
                        if (next <= percent) return;
                        progress.report({ increment: next - percent, message: next + "%" });
                        percent = next;
                        const now = Date.now();
                        if (now - postedAt >= 200) {
                            postedAt = now;
                            post({ type: "exportCsvProgress", percent: next });
                        }
                    }
                });
            }
        );
    }
    // Disk budget for the chart: bytes used, the write rate over the last ~10 s and the time left at that rate.
    _samplingArchiveBudget(now = Date.now()) {
        const archive = this._samplingArchive;
        if (!archive) return null;
        const used = archive.writtenBytes + archive.queuedBytes,
            samples = (this._archiveRateSamples ||= []);
        if (!samples.length || now - samples.at(-1).t >= 250) samples.push({ t: now, bytes: used });
        while (samples.length > 2 && now - samples[1].t >= 10000) samples.shift();
        const first = samples[0],
            span = now - first.t,
            bytesPerSecond = span >= 1000 && used >= first.bytes ? ((used - first.bytes) * 1000) / span : null,
            free = Math.max(0, archive.maxBytes - used);
        return {
            usedBytes: used,
            maxBytes: archive.maxBytes,
            bytesPerSecond,
            remainingSeconds: archive.limitReached ? 0 : bytesPerSecond > 0 ? free / bytesPerSecond : null
        };
    }

    /** @param {{ intervalMs?: number }} params */
    async _controlAgentSampling(action, params = {}) {
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
            await this._sampling.start(undefined, params.intervalMs ?? this._sampling.intervalMs, "sidebar", false);
        } else if (action === "stop") {
            // Cancel Agent samples (temporary or on a borrowed connection) as well as persistent sampling;
            // leave debugging active.
            this._cancelSharedAgentSamples();
            const agentStopped = this.stopAgentReadIfRunning();
            const liveStopped = this._sampling.stop({ variablesOnly: true });
            await Promise.all([agentStopped, liveStopped]);
        }
        return {
            ...this._sampling.status(),
            starting: this._sampling.starting,
            intervalMs: this._sampling.intervalMs
        };
    }

    _postProbeOperationStatus() {
        this._webviewView?.webview.postMessage({
            type: "probeOperationStatus",
            operations: this._probeCoordinator?.snapshot(),
            debugPending: !!this._debugCommandPending
        });
    }
    async externalDebugSettingsChanged() {
        await this._externalDebug.releaseIfDisabled();
    }
    async prepareExternalDebug(folder, config) {
        if (!vscode.workspace.isTrusted) throw new Error("Debugging requires a trusted workspace");
        const connection = resolveExternalSettings(vscode.workspace.getConfiguration("emberprobe", folder.uri));
        if (
            this._debugCommandPending ||
            this._debugStarting ||
            this._managedDebugServer ||
            this._debugBridge.hasAnySession
        )
            throw Object.assign(new Error("Stop the active debug session before external attach"), {
                code: "PROBE_BUSY"
            });
        if (this._probeDriverSwitching)
            throw Object.assign(new Error("Wait for the driver operation before external attach"), {
                code: "PROBE_DRIVER_BUSY"
            });
        this._debugCommandPending = true;
        this._postProbeOperationStatus();
        let reserved = false;
        try {
            const { validateDebugConfiguration } = require("./services/debugConfiguration");
            const validated = validateDebugConfiguration(
                {
                    ...config,
                    executable: config.executable || this._context.workspaceState.get(CACHE_KEYS.elfPath)
                },
                folder
            );
            if (!validated.executable) throw new Error("A valid ELF executable is required");
            const tools = await ensureDebugTools(
                vscode,
                folder,
                this._context.workspaceState,
                (key) => this._t(key),
                undefined,
                validated
            );
            if (!tools) return undefined;
            const own = vscode.workspace.getConfiguration("emberprobe", folder.uri);
            const pretty = resolvePrettyPrinting(
                validated,
                {
                    enablePrettyPrinting: own.get("enablePrettyPrinting", true),
                    prettyPrintingMode: configuredPrettyPrintingMode(own),
                    prettyPrinterFiles: own.get("prettyPrinterFiles", [])
                },
                validated.cwd || folder.uri.fsPath
            );
            const svd = await this._svdManager.currentPath(folder);
            const rtos = resolveRtos(validated, own.get("rtos", ""));
            if (!own.get("experimental.externalGdb.enabled", false))
                throw new Error("External GDB was disabled during startup");
            const stoppedAgent = this.stopAgentReadIfRunning();
            if (stoppedAgent) await stoppedAgent;
            if (this._sampling.inUse) await this._sampling.stop({ preserveIntent: true });
            this._debugBridge.setWorkspace(folder);
            // Freeze settings read at entry. No probe detection or extra TCP readiness connection.
            const reservation = await this._externalDebug.reserve(folder.uri.fsPath, connection);
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
            this._armDebugStartupWatchdog();
            return result;
        } catch (error) {
            if (reserved) await this._externalDebug.finish();
            throw error;
        } finally {
            this._debugCommandPending = false;
            this._postProbeOperationStatus();
        }
    }
    async prepareProbeForDebug(folder) {
        this._assertProbeDriverIdle();
        this._debugBridge.setWorkspace(folder || this._commandContext().folder);
        // A session that ended with an unconfirmed OpenOCD exit leaves its server reachable; retry
        // the stop here so that one slow exit does not block every later debug start.
        if (this._managedDebugServer?.state === "stop-failed" && !this._managedDebugGroup)
            await this._stopManagedDebugServer();
        if (this._managedDebugServer) {
            throw Object.assign(new Error("The debug probe is owned by an EmberProbe managed debug session"), {
                code: "PROBE_BUSY"
            });
        }
        const agentStopped = this.stopAgentReadIfRunning();
        if (agentStopped) await agentStopped;
        if (this._sampling.inUse) {
            const stopped = this._sampling.stop({ preserveIntent: true });
            if (stopped) await stopped;
            this._postConsumerStatuses({
                mode: "debug-running-waiting",
                key: "live.debugWaiting",
                source: "dap",
                canRead: false,
                canWrite: false,
                snapshotReady: false
            });
        } else if (this._sampling.intent) {
            this._postConsumerStatuses({
                mode: "debug-running-waiting",
                key: "live.debugWaiting",
                source: "dap",
                snapshotReady: false
            });
        }
    }
    handleDebugSessionStart(session) {
        if (!session || !isSupportedDebugSession(session)) return;
        if (this._terminatedDebugSessionIds.has(session.id)) return;
        this._externalDebug?.bind(session);
        const grouped = this._managedDebugGroup?.bind(session);
        if (this._debugLifecycle.pending && this._matchesManagedDebugSession(session))
            this._debugLifecycle.session = session;
        this._debugReadPlanKey = debugReadPlanKey(this._sampling.activeReadPlan());
        // In multi-root workspaces the session belongs to VS Code's actual debug folder, not the folder of the cached
        // ELF.
        this._debugBridge.setWorkspace(session.workspaceFolder || this._commandContext().folder);
        if (
            session.configuration?.__emberprobeManagedToken &&
            session.configuration.__emberprobeManagedToken === this._managedDebugToken &&
            this._managedDebugServer
        ) {
            this._managedDebugSessionId = session.id;
            this._managedDebugServer.invalidateTarget?.();
            this._managedDebugServer.setSamplingEnabled(false);
        }
        this._debugBridge.attach(session);
        if (grouped) {
            this._managedDebugServer.invalidateTarget?.();
            this._managedDebugServer.setSamplingEnabled(false);
        }
        this._samplingCoordinator?.setDebugIntent(this._debugBridge, this._sampling.intent);
    }
    handleDebugAdapterMessage(session, message) {
        void this._externalDebug?.message(session, message).catch(console.error);
        if (
            message?.type === "event" &&
            message.event === "emberprobe.firmwareLoaded" &&
            !this._externalDebug?.matches(session) &&
            this._matchesManagedDebugSession(session)
        ) {
            const { cwd, executable } = session.configuration || {};
            void this._firmwareRecord
                ?.recordDebugLaunch(
                    executable && path.resolve(cwd || "", executable),
                    message.body,
                    this._managedDebugServer?.options
                )
                .catch((error) => console.error("Unable to record debug firmware:", error));
        }
        if (this._managedDebugGroup?.match(session)) {
            this._managedDebugGroup.message(session, message);
            this._debugBridge.handleMessage(session, message);
            return;
        }
        const matches = this._matchesManagedDebugSession(session);
        if (message?.type === "response" && ["launch", "attach"].includes(message.command) && matches) {
            if (!message.success) {
                const errorMsg = message.message || message.body?.error?.format;
                if (session.configuration?.servertype === "external")
                    this._clearDebugStartupWatchdog({ kind: "failed" });
                else this._reportDebugStartupFailure(errorMsg);
            } else {
                this._debugLifecycle?.markLaunchResponse(session, matches, true);
                if (
                    !this._terminatedDebugSessionIds.has(session.id) &&
                    session.configuration?.servertype !== "external"
                ) {
                    void this._probeConnectionService.recordSuccess(this._managedDebugServer?.options);
                }
            }
        }
        if (message?.type === "event" && message.event === "initialized") this._markDebugStartupReady(session);
        this._debugBridge.handleMessage(session, message);
    }
    handleDebugAdapterRequest(session, message) {
        void this._externalDebug?.request(session, message).catch(console.error);
        this._debugBridge.handleRequest(session, message);
    }
    // VS Code clears activeDebugSession only after the terminate event, so a session already torn down here
    // must not keep reporting the probe as busy.
    _liveDebugSession() {
        const session = vscode.debug.activeDebugSession;
        return session && !this._terminatedDebugSessionIds?.has(session.id) ? session : null;
    }
    // Detaching a session settles the Agent's debug.stop wait before OpenOCD has exited; this resolves once the
    // session's probe lease is released, or rejects when the server exit cannot be confirmed.
    _debugSessionReleased(session) {
        return this._debugSessionReleases?.get(session?.id);
    }
    async handleDebugSessionTerminate(session) {
        if (!session || !isSupportedDebugSession(session)) return;
        if (this._terminatedDebugSessionIds.has(session.id)) return;
        this._terminatedDebugSessionIds.add(session.id);
        const released = this._releaseTerminatedDebugSession(session);
        // A failed release stays recorded so a concurrent debug.stop still reports it.
        this._debugSessionReleases?.set(session.id, released);
        const restore = await released;
        this._debugSessionReleases?.delete(session.id);
        if (restore) await this.restoreSamplingAfterDebug();
    }
    // Returns whether sampling should be restored after the probe has been released.
    async _releaseTerminatedDebugSession(session) {
        if (this._externalDebug?.matches(session)) {
            this._clearDebugStartupWatchdog({ kind: "terminated" });
            this._debugBridge.detach(session);
            await this._externalDebug.finish(session);
            this._sampling.intent = false;
            this._debugBridge.setIntent(false);
            return false;
        }
        const group = this._managedDebugGroup;
        const member = group?.match(session);
        if (member) {
            this._debugBridge.detach(session);
            await group.release(member.token);
            await this._closeStoppedDebugGroup(group);
            return false;
        }
        if (
            this._debugLifecycle.pending &&
            (this._debugLifecycle.session?.id === session.id || this._matchesManagedDebugSession(session))
        ) {
            this._clearDebugStartupWatchdog({ kind: "terminated" });
        }
        const managed = !!this._managedDebugSessionId && session.id === this._managedDebugSessionId;
        this._debugBridge.detach(session);
        if (this._debugBridge.hasSession) return false;
        this._debugReadPlanKey = "";
        this._runtimeSampleHold?.reset();
        if (managed) await this._stopManagedDebugServer();
        return true;
    }
    handleDebugAdapterExit(session) {
        if (!session || !isSupportedDebugSession(session)) return;
        const managedStartup =
            this._debugLifecycle.pending &&
            (this._debugLifecycle.session?.id === session.id || this._matchesManagedDebugSession(session));
        if (!managedStartup && !this._debugBridge.hasAnySession && !this._managedDebugGroup?.match(session)) return;
        return this.handleDebugSessionTerminate(session);
    }
    async restoreSamplingAfterDebug() {
        if (this._shutdownPromise) return;
        if (this._externalDebug?.held) return;
        if (this._managedDebugGroup?.members.size) return;
        if (this._debugBridge.hasAnySession) {
            this._postConsumerStatuses(this._debugBridge.status());
            return;
        }
        if (this._managedDebugServer) await this._stopManagedDebugServer();
        if (!this._sampling.intent) {
            this._postConsumerStatuses({ mode: "stopped", key: "sb.stopped", source: "none" });
            return;
        }
        this._postConsumerStatuses({
            mode: "restoring",
            key: "live.restoring",
            source: "openocd",
            canRead: false,
            canWrite: false
        });
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (!this._sampling.intent || this._debugBridge.hasAnySession) return;
        try {
            await this._sampling.start(undefined, this._sampling.intervalMs, "restore");
        } catch (error) {
            this._postConsumerStatuses({ mode: "restore-failed", ...toUiError(error), source: "none" }, true);
        }
    }
    disposeDebugBridge() {
        this._svdPeripheralService?.dispose();
        this._svdManager?.library?.dispose();
        this._debugBridge.dispose();
    }
    // Background GDB start for a workspace that has already chosen firmware; see services/gdbWarmup.js.
    scheduleGdbWarmup(delayMs = 0) {
        if (this._gdbWarmupTimer) clearTimeout(this._gdbWarmupTimer);
        this._gdbWarmupTimer = setTimeout(async () => {
            this._gdbWarmupTimer = null;
            // Workspace settings choose the executable, so an untrusted workspace never runs it.
            if (this._shutdownPromise || !vscode.workspace.isTrusted) return;
            if (!this._context.workspaceState.get(CACHE_KEYS.elfPath)) return;
            const { folder } = this._commandContext();
            if (!folder) return;
            try {
                const tools = await findWarmupDebugTools(vscode, folder, this._context.workspaceState);
                if (tools && !this._shutdownPromise && vscode.workspace.isTrusted)
                    void this._gdbWarmup.warm(tools.gdbPath);
            } catch (error) {
                console.error("GDB warm-up skipped:", error);
            }
        }, delayMs);
        this._gdbWarmupTimer.unref?.();
    }
    shutdown() {
        this._chartBackground?.cancel();
        if (this._gdbWarmupTimer) clearTimeout(this._gdbWarmupTimer);
        this._gdbWarmupTimer = null;
        this._gdbWarmup?.dispose();
        this._stopProbeInventoryMonitor();
        this._memoryAnalysisController?.dispose();
        this._cubemxService.cancel();
        this._elfService.invalidate();
        if (this._shutdownPromise) return this._shutdownPromise;
        this._shutdownPromise = (async () => {
            // Close probe access and the Agent Bridge first: a call arriving mid-shutdown must not start a
            // new OpenOCD process after sampling and debugging have already been stopped.
            this._probeCoordinator?.close();
            this._agentService?.close();
            await this._agentService?.stop().catch(() => {});
            this._cancelSharedAgentSamples();
            const agentStopped = this.stopAgentReadIfRunning();
            // An unconfirmed OpenOCD exit is logged; the rest of the cleanup must still run.
            if (agentStopped) await agentStopped.catch((error) => console.error("Agent read cleanup failed:", error));
            this._clearDebugStartupWatchdog();
            if (this._managedDebugGroup) {
                for (const token of [...this._managedDebugGroup.members.keys()])
                    await this._failGroupedCore(token, "Extension is shutting down");
            }
            const managedSession = this._debugBridge.activeSession;
            if (
                managedSession &&
                (managedSession.id === this._managedDebugSessionId || this._externalDebug?.matches(managedSession))
            ) {
                try {
                    await vscode.debug.stopDebugging(managedSession);
                } catch {
                    /* ignore */
                }
                try {
                    await this._debugBridge.waitForState((status) => status.state === "none", 1500);
                } catch {
                    /* bounded shutdown */
                }
            }
            await this._stopManagedDebugServer();
            const stopped = this._sampling.stop();
            if (stopped) await stopped;
            await this._flushPendingChartHistorySamples();
            await this._livePanelRegistry?.pending.catch(console.error);
            await this._samplingArchive.dispose();
            await this._chartHistory?.dispose();
            this._hostLoopDelay?.dispose();
            this.disposeDebugBridge();
            await this._agentService.dispose().catch(() => {});
        })();
        return this._shutdownPromise;
    }
    stopAgentReadIfRunning() {
        if (!this._agentReadRunning && !this._agentReadSession) return null;
        this._agentReadCancelled = true;
        this._wakeAgentReadDelays();
        this._postAgentSampling(false, "live.agentStopped");
        const session = this._agentReadSession;
        const lease = this._agentReadLease;
        if (!session) return this._agentReadPreparationPromise || null;
        return Promise.resolve(session.stop()).then((closed) => {
            if (closed === false)
                throw Object.assign(new Error("OpenOCD exit has not been confirmed"), {
                    code: "PROBE_EXIT_UNCONFIRMED"
                });
            if (this._agentReadSession === session) this._agentReadSession = null;
            lease?.release();
        });
    }
    // Pushes chip info state and the optional result to the sidebar
    _postChipInfo(status, info) {
        this._chipInfoService.post(status, info);
    }
    // Syncs the sidebar: replays cached chip info and the current state after the view is rebuilt
    _syncChipInfo(post) {
        this._chipInfoService.sync(post);
    }
    // Reads basic chip information with a one-shot OpenOCD run; exclusive with programming, live watch and debugging
    // (one process owns the probe at a time)
    async readChipInfoAction(forAgent = false) {
        return this._chipInfoService.read(forAgent);
    }
    // Writes the raw OpenOCD commands and output of a chip read to the output panel for diagnosis (ID/UID/flash read
    // problems, for example)
    _writeChipDiagnostics(diag, info) {
        if (!diag) return;
        if (!this._chipOutput) {
            this._chipOutput = vscode.window.createOutputChannel(this._t("diag.channelName"));
            this._context.subscriptions.push(this._chipOutput);
        }
        const ch = this._chipOutput;
        ch.clear();
        ch.appendLine(this._t("diag.title"));
        ch.appendLine(this._t("diag.time", { time: new Date().toLocaleString() }));
        if (diag.target) ch.appendLine(this._t("diag.target", { target: diag.target }));
        if (diag.timings) {
            const time = (value) => (value == null ? "-" : String(value));
            ch.appendLine(
                this._t("diag.timings", {
                    config: time(diag.timings.configMs),
                    preflight: time(diag.timings.preflightMs),
                    read: time(diag.timings.openOcdMs),
                    save: time(diag.timings.saveMs),
                    total: time(diag.timings.totalMs)
                })
            );
        }
        if (info) {
            const kv = [
                [this._t("diag.kvCore"), info.core],
                [this._t("diag.kvCoreRev"), info.coreRevision],
                ["Device ID", info.deviceId],
                ["Revision ID", info.revId],
                [this._t("diag.kvFlash"), info.flashSize],
                ["UID", info.uid],
                [this._t("diag.kvState"), info.targetState]
            ];
            ch.appendLine(
                this._t("diag.parsed", {
                    content:
                        kv
                            .filter((x) => x[1])
                            .map((x) => x[0] + "=" + x[1])
                            .join("，") || this._t("diag.none")
                })
            );
        }
        ch.appendLine("");
        ch.appendLine(this._t("diag.commands"));
        (diag.commands || []).forEach((c) => ch.appendLine("  -c " + c));
        ch.appendLine("");
        ch.appendLine(this._t("diag.rawOutput"));
        (diag.lines || []).forEach((l) => ch.appendLine("  " + l));
        // Shown automatically when the device ID or UID is missing, so it can be copied into a report
        if (!info || !info.deviceId || (chipInfo.uidBaseForTarget(diag.target) && !info.uid)) ch.show(true);
    }
    resolveWebviewView(webviewView) {
        this._stopProbeInventoryMonitor();
        this._sidebarReady = false;
        this._webviewView = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri, this._webviewAssetRootUri]
        };
        // Webview messages run commands in the extension host; dispose the previous view's listener first so listeners
        // do not accumulate
        this._messageListener?.dispose();
        const handleMessage = createSidebarHandler(this, webviewView, vscode);
        this._messageListener = webviewView.webview.onDidReceiveMessage((message) =>
            handleMessage(message).catch((error) => console.error("Sidebar message failed:", error))
        );
        const sidebarWebview = webviewView.webview;
        const visibilityListener = webviewView.onDidChangeVisibility?.(() => {
            if (this._webviewView !== webviewView) return;
            if (!webviewView.visible) {
                this._stopProbeInventoryMonitor();
                return;
            }
            this._startProbeInventoryMonitor();
            // Retained documents do not initialize again. Replay environment changes missed while hidden.
            sidebarWebview.postMessage({ type: "openocdStatus", ...this._openOcdStatusService.status });
            if (this._skillStatusService.lastStatus)
                sidebarWebview.postMessage({
                    type: "skillStatus",
                    ...this._skillStatusService.lastStatus,
                    busy: !!this._skillStatusService.busy
                });
            if (this._lastAgentAccess) sidebarWebview.postMessage({ type: "agentAccess", ...this._lastAgentAccess });
            this.refreshOpenOcdStatus(false);
            this.refreshSkillStatus().catch((error) =>
                console.error("Agent Skills status check failed:", error.message)
            );
        });
        webviewView.onDidDispose(() => {
            visibilityListener?.dispose();
            this._webviewRenders?.delete(sidebarWebview);
            if (this._webviewView === webviewView) {
                this._stopProbeInventoryMonitor();
                this._webviewView = null;
                this._sidebarReady = false;
            }
        });
        this._renderWebview(webviewView.webview, this.getModernWebviewContent(), "sidebar");
        this.updateView().catch(console.error);
        // Auto-detect only when the configuration is incomplete, so expanding the view does not rescan the whole
        // workspace every time
        const configured =
            this._context.workspaceState.get(CACHE_KEYS.elfPath) &&
            this._context.workspaceState.get(CACHE_KEYS.debugger) &&
            this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!configured)
            setTimeout(
                () =>
                    this.runAutoDetect(false).catch((error) => {
                        console.error("Auto-detection failed:", error.message);
                        this._notices.notify("config", "mcu-vscode.autoDetect", {
                            level: "error",
                            titleKey: COMMAND_FAILURE_TITLES["mcu-vscode.autoDetect"],
                            error
                        });
                    }),
                0
            );
    }
    async runAutoDetect(force) {
        if (force) this._assertConnectionEditable({ debugger: true, mcu: true });
        const detectedIoc = force ? await this._cubemxConfiguration.detectIoc() : "";
        const currentElf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        const currentDebugger = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const currentMcu = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        // Only use scripts the current OpenOCD actually provides; a user-selected .ioc alone decides the MCU.
        const scripts = await this._availableOpenOcdScripts();
        const result = await autoDetect.detectWorkspace(vscode, {
            ioc: detectedIoc,
            mcu: currentMcu || "",
            targets: scripts.targets,
            interfaces: scripts.interfaces
        });
        // Several probe types connected: picking one in the connected probe list also sets its interface script.
        const pickProbe = !currentDebugger && result.probeCandidates?.length > 1;
        if (!result.mcu && result.mcuCandidates?.length > 1 && force) {
            result.mcu =
                (await vscode.window.showQuickPick(result.mcuCandidates, {
                    placeHolder: this._t("msg.selectDetectedMcu")
                })) || "";
        }
        const writeElf = !!result.elf && (force || !currentElf);
        let writeDebugger = !!result.debugger && (force || !currentDebugger);
        let writeMcu = !!result.mcu && (force || !currentMcu);
        // Confirm the configuration is editable before storing any field, so it is never half written. When
        // auto-detection meets a busy session it silently skips the connection settings instead of reporting a failure
        // of an operation the user did not start.
        if (writeDebugger || writeMcu) {
            try {
                this._assertConnectionEditable({ debugger: true, mcu: true });
            } catch (error) {
                if (force) throw error;
                writeDebugger = writeMcu = false;
            }
        }
        if (writeElf) await this._context.workspaceState.update(CACHE_KEYS.elfPath, cleanWindowsPath(result.elf));
        if (writeDebugger) await this._context.workspaceState.update(CACHE_KEYS.debugger, result.debugger);
        if (writeMcu) await this._context.workspaceState.update(CACHE_KEYS.mcuCore, result.mcu);
        if (writeElf) await this._refreshElfBindings();
        await this.updateView();
        if (writeDebugger) await this._refreshConnectedProbes();
        if (pickProbe && force) this._revealConnectedProbes();
        const found = [
            detectedIoc && ".ioc: " + path.basename(detectedIoc),
            result.elf && this._t("msg.foundElf", { name: path.basename(result.elf) }),
            result.mcu && this._t("msg.foundMcu", { name: result.mcu }),
            result.debugger && this._t("msg.foundDebugger", { name: result.debugger })
        ].filter(Boolean);
        if (force) {
            // One box for the whole result: what was found, plus anything the user still has to sort out.
            const problems = [
                result.mcuUnavailable && { key: "msg.autoMcuUnavailable", params: { name: result.mcuUnavailable } },
                !result.elf &&
                    result.elfRejected?.length && {
                        key: "msg.autoElfArchMismatch",
                        params: { count: result.elfRejected.length }
                    }
            ].filter(Boolean);
            this._notices.notify("config", "mcu-vscode.autoDetect", {
                level: !found.length || problems.length ? "warning" : "success",
                ...(found.length
                    ? { key: "msg.autoDoneWith", params: { found: found.join(", ") } }
                    : { key: "msg.autoNone" }),
                items: problems
            });
        }
        return result;
    }
    // Target/interface scripts available in the current OpenOCD; an empty list (no filtering) when OpenOCD is not
    // ready.
    async _availableOpenOcdScripts() {
        try {
            const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = this._openOcdStatusService ? await this._resolveOpenOcdPath(configured) : "";
            if (!executable) return { targets: [], interfaces: [] };
            return {
                targets: openocdScripts.discoverTargetConfigs(executable),
                interfaces: openocdScripts.discoverInterfaceConfigs(executable)
            };
        } catch {
            return { targets: [], interfaces: [] };
        }
    }
    _stopProbeInventoryMonitor() {
        if (this._probeInventoryMonitor) clearTimeout(this._probeInventoryMonitor.timer);
        this._probeInventoryMonitor = null;
        this._connectedProbesRevision = (this._connectedProbesRevision || 0) + 1;
    }
    // Lists every connected probe while the sidebar is visible, whatever interface script is selected.
    _startProbeInventoryMonitor() {
        if (
            !this._sidebarReady ||
            !this._webviewView ||
            this._webviewView.visible === false ||
            this._shutdownPromise ||
            this._probeInventoryMonitor
        )
            return;
        const monitor = { timer: null };
        this._probeInventoryMonitor = monitor;
        this._probeInventoryService().resetBackoff();
        const poll = async () => {
            if (this._probeInventoryMonitor !== monitor) return;
            try {
                await this._refreshConnectedProbes();
            } catch (error) {
                console.error("Probe inventory check failed:", error.message);
            } finally {
                // Wait after each completed read-only scan; slow enumeration must not pile up requests.
                if (this._probeInventoryMonitor === monitor) {
                    monitor.timer = setTimeout(poll, this._probeInventoryService().pollDelay());
                    monitor.timer.unref();
                }
            }
        };
        void poll();
    }
    _connectedProbesView(inventory) {
        const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger) || "";
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore) || "";
        const probeSerial = vscode.workspace.getConfiguration("emberprobe").get("probeSerial", "");
        const successfulConnection = this._probeSelectionStore().get();
        const service = this._probeConnectionService;
        const view = {
            debugger: debuggerCfg,
            override: !!probeSerial,
            ...this._probeInventoryService().describe(
                { probe: debuggerCfg, probeSerial, successfulConnection },
                inventory
            )
        };
        // Target chips come from operations; without the connection service there are none to show.
        if (!service) return view;
        Object.assign(view, service.describeTargetState(mcuCore));
        const automatic = service.isAutomatic({ probeSerial, debugger: debuggerCfg }, successfulConnection);
        const expected = automatic ? service.expectedTarget(mcuCore, successfulConnection) : null;
        const readings = new Map(
            (inventory?.devices || []).map((device) => [device.id, service.targetReading(device)])
        );
        view.devices = view.devices.map((device) =>
            readings.get(device.id)
                ? {
                      ...device,
                      targetLabel: describeTargetIdentity(readings.get(device.id)),
                      targetCore: describeTargetCore(readings.get(device.id))
                  }
                : device
        );
        // Several probes of one family: show the one the next operation would pick, as pickByTarget does: the probe
        // automatic mode last found the recorded chip on, or without a record the only one with the configured model.
        if (automatic && view.state === "ambiguous") {
            const candidates = view.devices.filter((device) => device.matchesDebugger && device.selectable);
            const matches = candidates.filter((device) => {
                const reading = readings.get(device.id);
                if (!reading) return false;
                return expected ? sameTarget(reading, expected) : targetMatchesModel(reading, mcuCore) === true;
            });
            // Chip readings live only in memory: after a restart the list reads them itself (see
            // _identifyConnectedTargets) rather than asking the user to pick a probe automatic mode can find.
            const readKey = this._probeTargetReadKey(view, mcuCore);
            if (
                matches.length !== 1 &&
                service.identifyTarget &&
                mcuCore &&
                candidates.length > 1 &&
                candidates.some((device) => !readings.get(device.id)) &&
                this._probeTargetsReadFor !== readKey
            )
                Object.assign(view, { state: "identifying", error: null });
            if (matches.length === 1)
                Object.assign(view, {
                    state: "selected",
                    source: "target-chip",
                    deviceId: matches[0].id,
                    probeSerial: matches[0].trustedSerial,
                    error: null,
                    devices: view.devices.map((device) => ({ ...device, selected: device.id === matches[0].id }))
                });
        }
        // The probe an operation holds is in use; its chip is shown again once the operation ends.
        if (view.state === "selected" && this._probeCoordinator?.anyActive(PROBE_OPERATIONS_IN_USE))
            view.devices = view.devices.map((device) =>
                device.id === view.deviceId && device.targetLabel
                    ? { ...device, targetLabel: "", targetCore: "" }
                    : device
            );
        return view;
    }
    _probeTargetReadKey(view, target) {
        return JSON.stringify([view.debugger, target, ...view.devices.map((device) => device.id)]);
    }
    // Reads the chips once for this set of probes, so automatic mode's choice shows without a manual refresh. A
    // probe that cannot be read leaves the list asking the user to pick, as before.
    _identifyConnectedTargets(view) {
        if (this._probeTargetsReading) return;
        const key = this._probeTargetReadKey(view, this._context.workspaceState.get(CACHE_KEYS.mcuCore) || "");
        this._probeTargetsReading = true;
        void this._readConnectedProbeTargets()
            .catch((error) => console.error("Probe chip read failed:", error.message))
            .finally(() => {
                this._probeTargetsReading = false;
                this._probeTargetsReadFor = key;
                return this._refreshConnectedProbes();
            })
            .catch((error) => console.error("Probe list refresh failed:", error.message));
    }
    // Refresh reads the chip on each listed probe the extension can open on its own. Nothing is read while a probe
    // operation runs; a probe another program holds cannot be opened and keeps no reading, so neither shows a chip.
    async _readConnectedProbeTargets() {
        const service = this._probeConnectionService;
        const target = this._context.workspaceState.get(CACHE_KEYS.mcuCore) || "";
        if (!service?.identifyTarget || !target || this._probeDriverSwitching) return false;
        const { inventory } = await this._probeInventoryService().scan();
        const view = this._connectedProbesView(inventory);
        // A custom interface script opens its own device; a setting or that script shows only the selected one.
        const scriptChooses = view.state === "script";
        const listed = view.override || scriptChooses ? view.devices.filter((device) => device.selected) : view.devices;
        const devices = new Map((inventory?.devices || []).map((device) => [device.id, device]));
        const probes = listed.flatMap((device) => {
            const probe = scriptChooses || device.matchesDebugger ? view.debugger : device.defaultConfig;
            if (!probe || !devices.has(device.id) || !(scriptChooses || device.selectable)) return [];
            const probeSerial = scriptChooses ? "" : device.trustedSerial || "";
            return [{ device: devices.get(device.id), probe, probeSerial }];
        });
        if (!probes.length || this._probeCoordinator.anyActive()) return false;
        const executable = await this._resolveOpenOcdPath(
            vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd")
        );
        if (!executable) return false;
        let lease;
        try {
            lease = this._probeCoordinator.acquire("targetScan");
        } catch {
            return false;
        }
        try {
            await service.readListedTargets(probes, { executable, target, cwd: this._commandContext().cwd });
        } finally {
            lease.release();
        }
        return true;
    }
    // The connected device the workspace's next operation would use, or "" when none is selected.
    async _selectedProbeDeviceId() {
        const view = this._connectedProbesView((await this._probeInventoryService().scan()).inventory);
        return view.state === "selected" ? view.deviceId : "";
    }
    // The list's card shows each J-Link's driver and switches it; only an operation the driver blocks notifies.
    async _refreshConnectedProbes() {
        if (this._probeDriverSwitching) return null;
        const revision = (this._connectedProbesRevision = (this._connectedProbesRevision || 0) + 1);
        const { inventory } = await this._probeInventoryService().scan();
        if (this._probeDriverSwitching || revision !== this._connectedProbesRevision) return null;
        const view = this._connectedProbesView(inventory);
        const message = JSON.stringify({ type: "connectedProbes", ...view });
        // Rebuilding the list would close a dropdown the user has open; only post changes.
        if (message !== this._lastConnectedProbesMessage) {
            this._lastConnectedProbesMessage = message;
            this._webviewView?.webview.postMessage(JSON.parse(message));
        }
        if (view.state === "identifying") this._identifyConnectedTargets(view);
        return view;
    }
    // Opens the sidebar's connected probe list where the user picks the probe an operation could not choose.
    _revealConnectedProbes() {
        this._webviewView?.show?.(true);
        this._webviewView?.webview.postMessage({ type: "revealConnectedProbes" });
        this._refreshConnectedProbes().catch((error) => console.error("Probe list refresh failed:", error.message));
    }
    // Makes a connected device the workspace's probe. A device of another family also switches the interface
    // script to that family's default, so the list and the next operation never disagree.
    async _selectConnectedProbe(deviceId) {
        if (deviceId !== "" && !validation.connectedProbeId(deviceId))
            throw Object.assign(new Error("Invalid connected probe"), { code: "PROBE_SELECTION_INVALID" });
        this._assertConnectionEditable({ probeSerial: true });
        if (vscode.workspace.getConfiguration("emberprobe").get("probeSerial", ""))
            throw Object.assign(new Error("emberprobe.probeSerial selects the probe; clear it to choose another"), {
                code: "PROBE_SELECTION_LOCKED",
                i18nKey: "probe.selectionLocked"
            });
        const store = this._probeSelectionStore();
        this._probeInventoryService().resetBackoff();
        if (!deviceId) {
            await store.clear();
            this._probeConnectionService.clearTargetMismatch();
            this._resolvedProbeConnection = null;
            return this._refreshConnectedProbes();
        }
        const view = this._connectedProbesView((await this._probeInventoryService().scan()).inventory);
        const device = view.devices.find((item) => item.id === deviceId);
        if (!device)
            throw Object.assign(new Error("The selected probe is no longer connected"), {
                code: "PROBE_SELECTED_NOT_FOUND",
                i18nKey: "probe.selectionGone"
            });
        if (view.state === "script")
            throw Object.assign(new Error("The interface script selects its own device"), {
                code: "PROBE_SELECTION_LOCKED",
                i18nKey: "probe.scriptDecides"
            });
        if (!device.selectable || !device.defaultConfig)
            throw Object.assign(new Error("This probe cannot be selected"), {
                code: "PROBE_SELECTION_REQUIRED",
                i18nKey: device.reasonKey || "probe.noDefaultConfig"
            });
        const current = view.debugger;
        const probe = probeFamily({ probe: current }) === device.family ? current : device.defaultConfig;
        if (probe !== current) this._assertConnectionEditable({ debugger: probe });
        if (probe !== current) await this._context.workspaceState.update(CACHE_KEYS.debugger, probe);
        try {
            // Without a trusted serial the device is the only one of its family and is chosen as the unique device,
            // so only an earlier pick is forgotten; a chip recorded in automatic mode stays for that script.
            if (device.trustedSerial)
                await store.set({
                    probe,
                    probeSerial: device.trustedSerial,
                    family: device.family,
                    deviceId: device.id,
                    source: "user"
                });
            else if (store.get()?.source === "user") await store.clear();
        } catch (error) {
            if (probe !== current) await this._context.workspaceState.update(CACHE_KEYS.debugger, current || undefined);
            throw error;
        }
        this._resolvedProbeConnection = null;
        // The card's tooltip announced the script it switches to; the configuration row shows it.
        if (probe !== current) await this._showDebuggerConfig();
        return this._refreshConnectedProbes();
    }
    _logJlinkDriverDiagnostics(target) {
        if (!target.interfaces?.length) return;
        if (!this._chipOutput) {
            this._chipOutput = vscode.window.createOutputChannel(this._t("diag.channelName"));
            this._context.subscriptions?.push(this._chipOutput);
        }
        this._chipOutput.appendLine(
            `[EmberProbe] J-Link USB driver not switchable (${target.driverReason || target.driverKind}): ` +
                `device=${target.deviceId || ""}, serial=${target.probeSerial || ""}`
        );
        for (const item of target.interfaces)
            this._chipOutput.appendLine(
                `  ${item.instanceId} | ${item.name} | service=${item.service} | ` +
                    `provider=${item.driverProvider} | inf=${item.driverInf}`
            );
    }
    // `target` identifies the exact J-Link the warning is about: instanceId, deviceId, probeSerial and driverKind.
    _showJlinkDriverWarning(target = {}) {
        if (
            process.platform !== "win32" ||
            this._context.workspaceState.get(JLINK_DRIVER_WARNING_IGNORED_KEY) === true ||
            this._jlinkDriverWarningPending
        )
            return;
        // Only a verified SEGGER binding of a uniquely identified interface can be switched by the helper.
        const switchable = !target.driverKind || target.driverKind === "repair";
        const switchDriver = this._t("probe.switchToWinUsb");
        const ignore = this._t("probe.ignoreDriverWarning");
        const probe = target.probeSerial ? `J-Link ${target.probeSerial}` : "J-Link";
        if (!switchable) this._logJlinkDriverDiagnostics(target);
        const message = switchable
            ? this._t("probe.winusbRequired", { probe })
            : this._t("probe.driverNotSwitchableWarning", {
                  probe,
                  reason: this._t(target.driverReasonKey || "probe.driverReasonInterface")
              });
        // Do not hold the failed operation's probe lease while waiting for a notification response.
        this._jlinkDriverWarningPending = Promise.resolve(
            switchable
                ? vscode.window.showWarningMessage(message, switchDriver, ignore)
                : vscode.window.showWarningMessage(message, ignore)
        )
            .then(async (selected) => {
                if (selected === ignore)
                    await this._context.workspaceState.update(JLINK_DRIVER_WARNING_IGNORED_KEY, true);
                else if (switchable && selected === switchDriver) {
                    await new Promise((resolve) => setImmediate(resolve));
                    await this._changeJlinkDriver("winusb", target);
                }
            })
            .catch((error) => {
                if (this._notices.get("config", "probe-driver")?.level !== "error")
                    this._notices.notify("config", "probe-driver", {
                        level: "error",
                        titleKey: "notice.driverSwitchFailed",
                        error
                    });
            })
            .finally(() => {
                this._jlinkDriverWarningPending = null;
            });
        return this._jlinkDriverWarningPending;
    }
    // Driver install/restore progress shows next to the J-Link driver choice instead of the footer.
    _notifyProbeDriverStatus(status) {
        const busy = status.state === "installing" || status.state === "restoring";
        const done = status.state === "ready" || status.state === "restored";
        if (!busy && !done && status.state !== "error") return;
        const keys = {
            installing: "probe.driverInstalling",
            ready: "probe.driverReady",
            restoring: "probe.driverRestoring",
            restored: "probe.driverRestored"
        };
        this._notices.notify(
            "config",
            "probe-driver",
            status.state === "error"
                ? { level: "error", titleKey: "notice.driverSwitchFailed", message: status.message || "" }
                : { level: done ? "success" : "info", busy, key: keys[status.state] }
        );
    }
    // `target.deviceId` pins the J-Link: the sidebar passes the device its driver control belongs to and a
    // notification the device its blocked operation resolved, so a newly attached probe is never switched instead.
    // Without a target the J-Link is resolved from the workspace selection.
    async _changeJlinkDriver(driver, target = null) {
        if (driver !== "winusb" && driver !== "segger")
            throw Object.assign(new Error("Invalid J-Link USB driver choice"), { code: "PROBE_DRIVER_INVALID_CHOICE" });
        // Each attempt reports its own outcome in the driver notice.
        this._notices.clear("config", "probe-driver");
        this._assertProbeDriverIdle();
        this._assertConnectionEditable({ probeSerial: true });
        if (this._probeCoordinator?.anyActive())
            throw Object.assign(new Error("Wait for the current probe operation to finish before changing drivers"), {
                code: "PROBE_BUSY"
            });
        this._probeDriverSwitching = true;
        this._connectedProbesRevision = (this._connectedProbesRevision || 0) + 1;
        this._webviewView?.webview.postMessage({ type: "probeDriverSwitch", busy: true });
        const resolveTarget = (inventory) => {
            const resolved = resolveJlinkDriverTarget(
                inventory,
                vscode.workspace.getConfiguration("emberprobe").get("probeSerial", ""),
                this._probeSelectionStore().get(),
                target?.deviceId ? target : null
            );
            if (resolved.error) throw resolved.error;
            return resolved.choice;
        };
        try {
            const choice = resolveTarget((await this._probeInventoryService().scan()).inventory);
            if (target?.instanceId && choice.instanceId !== target.instanceId)
                throw Object.assign(new Error("The selected J-Link changed; select its USB driver in the sidebar"), {
                    code: "PROBE_DRIVER_SELECTION_CHANGED",
                    i18nKey: "probe.driverSelectionChanged"
                });
            if (choice.driver === driver) return;
            const result =
                driver === "winusb"
                    ? await this._probeDriverService.ensure(choice.connection)
                    : await this._probeDriverService.restore(choice.connection);
            let verified;
            try {
                verified = resolveTarget(driver === "winusb" ? result.inventory : result);
            } catch {
                verified = null;
            }
            if (verified?.driver !== driver || verified.instanceId !== choice.instanceId)
                throw Object.assign(new Error("The selected J-Link driver could not be verified after switching"), {
                    code: "PROBE_DRIVER_VERIFY_FAILED"
                });
            // The user chose SEGGER in the card, which shows it; an operation it blocks still notifies.
            this._resolvedProbeConnection = null;
        } finally {
            this._probeDriverSwitching = false;
            this._webviewView?.webview.postMessage({ type: "probeDriverSwitch", busy: false });
            this._refreshConnectedProbes().catch((error) =>
                console.error("Probe inventory check failed:", error.message)
            );
        }
    }
    getModernWebviewContent() {
        const elf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        return modernView.getModernWebviewContent(
            {
                versionLabel: versionLabel(this._context.extension?.packageJSON?.version),
                elf: elf ? path.basename(elf) : "",
                cubemxPath: vscode.workspace.getConfiguration("emberprobe").get("cubemxPath", ""),
                iocPath: this._context.workspaceState.get(CACHE_KEYS.iocPath) || "",
                cubemxStatus: this._cubemxConfiguration.status,
                cubemxFirmware: this._cubemxFirmware?.result,
                cubemxFirmwareError: this._cubemxFirmware?.error,
                debugger: this._context.workspaceState.get(CACHE_KEYS.debugger) || "",
                mcu: this._context.workspaceState.get(CACHE_KEYS.mcuCore) || ""
            },
            this._lang
        );
    }
    _renderWebview(webview, html, scope) {
        // Focus refreshes must not reset the DOM and briefly show default status widgets.
        if (this._webviewRenders.get(webview)?.html === html) return Promise.resolve();
        const revision = { html };
        this._webviewRenders.set(webview, revision);
        return externalizeWebviewHtml({
            html,
            webview,
            vscode,
            assetRootUri: this._webviewAssetRootUri,
            scope
        })
            .then((result) => {
                if (this._webviewRenders.get(webview) !== revision) return;
                webview.html = result.html;
                revision.done = true;
            })
            .catch((error) => {
                if (this._webviewRenders.get(webview) === revision) {
                    this._webviewRenders.delete(webview);
                    console.error("Unable to render EmberProbe webview:", error);
                }
            });
    }
    // Shows a changed interface script in the configuration row in place: rendering the sidebar again reloads
    // the page, which flashes it. The page then holds what a render would produce, so it is recorded as rendered.
    async _showDebuggerConfig() {
        const webview = this._webviewView?.webview;
        if (!webview || !this._webviewRenders?.get(webview)?.done) return this.updateView();
        this._webviewRenders.set(webview, { html: this.getModernWebviewContent(), done: true });
        await webview.postMessage({
            type: "debuggerConfig",
            debugger: this._context.workspaceState.get(CACHE_KEYS.debugger) || ""
        });
    }
    updateView() {
        const render = () => {
            if (this._webviewView)
                return this._renderWebview(this._webviewView.webview, this.getModernWebviewContent(), "sidebar");
        };
        return this._cubemxFirmware ? this._cubemxFirmware.refresh().then(render) : render();
    }
}
exports.MainViewProvider = MainViewProvider;
//# sourceMappingURL=extension.js.map
