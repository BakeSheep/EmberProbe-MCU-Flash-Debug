"use strict";
const { OpenOcdDebugController, allocateDebugPorts } = require("./services/debugServerController");
const { ExternalDebugService } = require("./services/externalDebugService");
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
const { withWriteAccessStatus } = require("./writeAccess");
const liveWatchView = require("./liveWatchView");
const { configuredFrequencyHz, intervalMsFromHz } = require("./samplingFrequency");
const elfSymbols = require("./elfSymbols");
const dwarf = require("./dwarf");
const chipInfo = require("./chipInfo");
const faultInfo = require("./faultInfo");
const validation = require("./validation");
const { variableDisplayName } = require("./webview/runtime");
const { displayWarnings } = require("./webview/elfDiagnostics");
const openocdScripts = require("./openocdScripts");
const { AgentBridge } = require("./agentBridge");
const { WriteAuthorization } = require("./writeAuthorization");
const { CubeMxService } = require("./services/cubemxService");
const { CubeMxConfiguration } = require("./services/cubemxConfiguration");
const { CubeMxFirmware } = require("./services/cubemxFirmware");
const { PeripheralWriteAuthorization } = require("./peripheralWriteAuthorization");
const { FlashAuthorization } = require("./flashAuthorization");
const { ProbeCoordinator, PROBE_OPERATIONS } = require("./probeCoordinator");
// Operations that hold the workspace's probe; the refresh's own chip reads do not.
const PROBE_OPERATIONS_IN_USE = PROBE_OPERATIONS.filter((name) => name !== "targetScan");
const { ConfigurationStore } = require("./services/configurationStore");
const { FlashService } = require("./services/flashService");
const { runDownload } = require("./services/flashCommand");
const { FirmwareRecord } = require("./services/firmwareRecord");
const { AgentFlashService } = require("./services/agentFlashService");
const { FaultService } = require("./services/faultService");
const { AgentService, agentAccessDecision } = require("./services/agentService");
const { createAgentRoutes } = require("./services/agentRoutes");
const { createSidebarHandler } = require("./controllers/sidebarRoutes");
const { createLivePanelHandler } = require("./controllers/livePanelRoutes");
const {
    LiveWatchController,
    POINTER_EXPANDED_ONLY_STATE_KEY,
    UNLIMITED_SAMPLING_STATE_KEY
} = require("./services/liveWatchController");
const { ElfViewController } = require("./services/elfViewController");
const { DebugLaunch } = require("./services/debugLaunch");
const { WriteExecution } = require("./services/writeExecution");
const { AgentOperations } = require("./services/agentOperations");
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
const { probeFamily } = require("../skills/_emberprobe/probe-connection");
const { serializeError, toUiError } = require("./services/errorEnvelope");
const { describeTargetIdentity, describeTargetCore, sameTarget, targetMatchesModel } = require("./chip/targetIdentity");
const { NoticeService, COMMAND_FAILURE_TITLES } = require("./services/noticeService");
const {
    LiveWatchService,
    buildChartHistoryItems,
    selectFocusedPanel,
    writableRamSectionRanges
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
const { DebugControlService } = require("./services/debugControlService");
const { SamplingArchive, cleanupStaleSamplingArchives } = require("./services/samplingArchive");
const { ChartHistoryService, estimateHistoryBytes, MAX_BACKLOG_BYTES } = require("./services/chartHistoryService");
const { ensureDebugTools, findWarmupDebugTools } = require("./services/debugToolPreflight");
const { externalizeWebviewHtml, pruneWebviewAssets } = require("./webviewAssets");
const fs = require("fs");
const crypto = require("crypto");
const i18n = require("./i18n");
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

// The sampling controller uses this module's vscode and LiveWatchSession, which tests replace through loadProvider.
function createSamplingController(host, settings = {}) {
    return new LiveWatchController(host, { vscode, LiveWatchSession: liveWatch.LiveWatchSession, ...settings });
}
// The debug launch controller uses this module's vscode, debug tool lookup, OpenOCD scripts and debug server
// controller, which tests replace through loadProvider.
function createDebugLaunch(host) {
    return new DebugLaunch(host, {
        vscode,
        ensureDebugTools,
        findWarmupDebugTools,
        openocdScripts,
        OpenOcdDebugController,
        allocateDebugPorts
    });
}
class MainViewProvider {
    // Controllers are created on first use, so the provider's construction order does not matter.
    get _sampling() {
        return (this._samplingController ??= createSamplingController(this));
    }
    get _elfView() {
        return (this._elfViewController ??= new ElfViewController(this));
    }
    get debugLaunch() {
        return (this._debugLaunchController ??= createDebugLaunch(this));
    }
    get _writes() {
        return (this._writeExecution ??= new WriteExecution(this, { vscode }));
    }
    get _agentOps() {
        return (this._agentOperations ??= new AgentOperations(this, {
            vscode,
            LiveWatchSession: liveWatch.LiveWatchSession
        }));
    }
    constructor(context) {
        this.commandHandlers = {};
        this._context = context;
        // Created by the `_notices` getter.
        this._noticeService = null;
        // Created by the `_elfView`, `debugLaunch`, `_writes` and `_agentOps` getters.
        this._elfViewController = null;
        this._debugLaunchController = null;
        this._writeExecution = null;
        this._agentOperations = null;
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
                const changes = this._elfView.watchNameChanges;
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
        // Running variables.sample loops, so cancellation can stop them during an interval wait.
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
            onTargetState: (event) => this.debugLaunch.handleTargetState(event),
            beforePausedRead: () => this._writes.quiesceRuntimeRead()
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
                await this._elfView.refreshBindings();
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
                return this._elfView.onElfChange(phase, result, entries);
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
            isDebugActive: () => !!this.debugLaunch.liveSession()
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
            startDebug: () => this.debugLaunch.start(undefined, undefined, false),
            waitForRelease: (session) => this.debugLaunch.sessionReleased(session)
        });
        this._agentFlashService = new AgentFlashService({
            getConfig: () => this._configurationStore.snapshot(),
            coordinator: this._probeCoordinator,
            authorization: this._flashAuthorization,
            prepare: (options, settings) => this._probeConnectionService.prepare(options, settings),
            recordSuccess: (connection) => this._probeConnectionService.recordSuccess(connection),
            recordFlashed: (entry) => this._firmwareRecord.record(entry),
            isDebugActive: () => this._debugBridge.hasAnySession || !!this.debugLaunch.liveSession()
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
                this.debugLaunch.scheduleGdbWarmup(0);
                await this._elfView.refreshBindings();
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
            this.debugLaunch.start(resource, undefined, true, { attach: true });
        this.commandHandlers["mcu-vscode.downloadOfficialSvd"] = () => this._svdManager.downloadOfficial();
        this.commandHandlers["mcu-vscode.selectExistingSvd"] = () => this._svdManager.selectExisting();
        this.commandHandlers["mcu-vscode.switchWorkspaceSvd"] = () => this._svdManager.switchBinding();
        this.commandHandlers["mcu-vscode.debug"] = (...args) => this.debugLaunch.start(...args);
        this.commandHandlers["mcu-vscode.download"] = (resource) => runDownload(this, vscode, resource);
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
                this.debugLaunch.managedServer ||
                this._agentOps.readSession ||
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
                ? [this._sampling.session, this._agentOps.readSession].filter(Boolean)
                : [
                      this._sampling.session,
                      this.debugLaunch.managedServer,
                      this._agentOps.readSession,
                      this._debugBridge.activeSession
                  ]
        );
        if (this._sampling.session || this.debugLaunch.managedServer) this._postConsumerStatuses({});
        // Only a visible sidebar shows the list; a hidden one rescans when it is shown again.
        if (this._probeInventoryMonitor)
            this._refreshConnectedProbes().catch((error) =>
                console.error("Probe inventory check failed:", error.message)
            );
        if (samplingSpeedChanged && this._sampling.session)
            void this._sampling.restart().catch((error) => this._postLive({ type: "liveError", ...toUiError(error) }));
    }
    _focusedLivePanel() {
        return selectFocusedPanel(this._livePanels);
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
        return this.debugLaunch.managedGroup
            ? JSON.stringify([watchKey, this.debugLaunch.managedGroup.id, this._debugBridge.activeSession?.id || ""])
            : watchKey;
    }
    _syncDebugSampleContext() {
        if (!this.debugLaunch.managedGroup && !this._debugSampleGroup) return;
        const group = this.debugLaunch.managedGroup?.id || "";
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
    async stopAgentBridge() {
        return this._agentService.stop();
    }
    // Per-workspace Agent access switch: enabled | disabled | unset (undefined). Stored only in workspaceState.
    _agentAccess() {
        const value = this._context?.workspaceState?.get(AGENT_ACCESS_STATE_KEY);
        return value === "enabled" || value === "disabled" ? value : undefined;
    }
    _agentAccessDecision(status) {
        return agentAccessDecision({
            trusted: !!vscode.workspace.isTrusted,
            access: this._agentAccess(),
            skills: hasWorkspaceSkills(status),
            mcpRequested: !!this._mcpBridgeRequested
        });
    }
    async _syncAgentBridge(status = this._skillStatusService.lastStatus) {
        const decision = this._agentAccessDecision(status);
        try {
            return await this._agentService.sync(decision, { legacyPointer: hasWorkspaceSkills(status) });
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
        const version = this._elfView.version(result);
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
        if (generation !== this._elfService.generation || version !== this._elfView.version(this._elfService.cache))
            return;
        post({ type: "addResolved", ...reply, symbol: found });
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
    _syncGraphTarget(entry, skipElf = false) {
        if (!entry || !entry.ready) return;
        const post = entry.post;
        if (!skipElf && this._elfService) {
            this._elfView.sendSnapshot(post, "variablesList");
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
            this._elfView.sendSnapshot(post, "availableVariables");
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
        if (this._sampling.savingFrequency) return;
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
    _postProbeOperationStatus() {
        this._webviewView?.webview.postMessage({
            type: "probeOperationStatus",
            operations: this._probeCoordinator?.snapshot(),
            debugPending: !!this.debugLaunch.commandPending
        });
    }
    disposeDebugBridge() {
        this._svdPeripheralService?.dispose();
        this._svdManager?.library?.dispose();
        this._debugBridge.dispose();
    }
    shutdown() {
        this._chartBackground?.cancel();
        if (this.debugLaunch.gdbWarmupTimer) clearTimeout(this.debugLaunch.gdbWarmupTimer);
        this.debugLaunch.gdbWarmupTimer = null;
        this.debugLaunch.gdbWarmup?.dispose();
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
            this._agentOps._cancelSharedSamples();
            const agentStopped = this._agentOps.stopReadIfRunning();
            // An unconfirmed OpenOCD exit is logged; the rest of the cleanup must still run.
            if (agentStopped) await agentStopped.catch((error) => console.error("Agent read cleanup failed:", error));
            this.debugLaunch.clearStartupWatchdog();
            if (this.debugLaunch.managedGroup) {
                for (const token of [...this.debugLaunch.managedGroup.members.keys()])
                    await this.debugLaunch.failGroupedCore(token, "Extension is shutting down");
            }
            const managedSession = this._debugBridge.activeSession;
            if (
                managedSession &&
                (managedSession.id === this.debugLaunch.managedSessionId ||
                    this._externalDebug?.matches(managedSession))
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
            await this.debugLaunch.stopManagedServer();
            const stopped = this._sampling.stop();
            if (stopped) await stopped;
            await this._flushPendingChartHistorySamples();
            await this._livePanelRegistry?.pending.catch(console.error);
            await this._samplingArchive.dispose();
            await this._chartHistory?.dispose();
            this._sampling.dispose();
            this.disposeDebugBridge();
            await this._agentService.dispose().catch(() => {});
        })();
        return this._shutdownPromise;
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
        if (writeElf) await this._elfView.refreshBindings();
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
