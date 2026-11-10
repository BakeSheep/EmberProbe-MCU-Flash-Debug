"use strict";
const { OpenOcdDebugController, allocateDebugPorts } = require("./services/debugServerController");
Object.defineProperty(exports, "__esModule", { value: true });
exports.MainViewProvider = void 0;
const vscode = require("vscode");
const path = require("path");
const modernView = require("./modernView");
const { versionLabel } = require("./buildInfo");
const autoDetect = require("./autoDetect");
const { ELF_FILE_GLOB } = require("../skills/_emberprobe/target-detection");
const skillInstaller = require("./skillInstaller");
const liveWatch = require("./liveWatch");
const { withWriteAccessStatus } = require("./writeAccess");
const liveWatchView = require("./liveWatchView");
const { configuredFrequencyHz, intervalMsFromHz } = require("./samplingFrequency");
const elfSymbols = require("./elfSymbols");
const chipInfo = require("./chipInfo");
const validation = require("./validation");
const { variableDisplayName } = require("./webview/runtime");
const { displayWarnings } = require("./webview/elfDiagnostics");
const openocdScripts = require("./openocdScripts");
const { runDownload } = require("./services/flashCommand");
const { agentAccessDecision } = require("./services/agentService");
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
const { ConnectedProbes } = require("./services/connectedProbes");
const { RttPanelHost } = require("./services/rttPanelHost");
const { ChartHistoryFeed } = require("./services/chartHistoryFeed");
const { createServices, createRttController, createRttTerminals } = require("./composition");
const { MemoryAnalysisController } = require("./services/memoryAnalysisController");
const { hasWorkspaceSkills, legacyGlobalSkills } = require("./services/skillStatusService");
const { listProbes } = require("../skills/_emberprobe/probe-inventory");
const { toUiError } = require("./services/errorEnvelope");
const { NoticeService, COMMAND_FAILURE_TITLES } = require("./services/noticeService");
const { selectFocusedPanel } = require("./services/liveWatchService");
const { normalizeRuntimeExpansions } = require("./services/runtimeExpansion");
const { LivePanelRegistry } = require("./services/livePanelRegistry");
const { RtosViewService } = require("./services/rtosViewService");
const { ensureDebugTools, findWarmupDebugTools } = require("./services/debugToolPreflight");
const { externalizeWebviewHtml, pruneWebviewAssets } = require("./webviewAssets");
const fs = require("fs");
const i18n = require("./i18n");
const { DEBUGGER_LIST, MCU_CORE_LIST } = require("./services/targetCatalog");
const { CACHE_KEYS } = require("./cacheKeys");
// Opened runtime paths per chart watch list, so a restarted chart samples the same parts.
const RUNTIME_EXPANSIONS_STATE_KEY = "liveWatch.runtimeExpansions";
const AGENT_ACCESS_STATE_KEY = "emberprobe.agentAccess";
const MCP_CONFIGURED_STATE_KEY = "emberprobe.mcpConfigured";
// Curve visibility per chart watch list, so a chart reopened after a restart shows the same curves.
const CURVE_VISIBILITY_STATE_KEY = "liveWatch.curveVisibility";
const MAX_CURVE_VISIBILITY_ENTRIES = 4096;
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

// The sampling controller uses this module's vscode and ManagedOpenOcdSession, which tests replace through loadProvider.
function createSamplingController(host, settings = {}) {
    return new LiveWatchController(host, {
        vscode,
        ManagedOpenOcdSession: liveWatch.ManagedOpenOcdSession,
        ...settings
    });
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
    // Created by the `_notices`, `_elfView`, `debugLaunch`, `_writes`, `_agentOps`, `_connectedProbes` and
    // `_historyFeed` getters.
    _noticeService = null;
    _elfViewController = null;
    _debugLaunchController = null;
    _writeExecution = null;
    _agentOperations = null;
    _connectedProbesController = null;
    _historyFeedController = null;
    _rttController = null;
    _rttTerminalController = null;
    _rttPanelHost = null;
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
            ManagedOpenOcdSession: liveWatch.ManagedOpenOcdSession
        }));
    }
    get _connectedProbes() {
        return (this._connectedProbesController ??= new ConnectedProbes(this, { vscode, listProbes }));
    }
    get _historyFeed() {
        return (this._historyFeedController ??= new ChartHistoryFeed(this));
    }
    // The RTT controller attaches to whichever session owns the probe; it is created on first use so construction
    // order and tests without RTT are unaffected.
    get _rtt() {
        return (this._rttController ??= createRttController(this, vscode, liveWatch.ManagedOpenOcdSession));
    }
    // The RTT terminals follow the controller's statuses; created on first use like the controller itself.
    get _rttTerminals() {
        return (this._rttTerminalController ??= createRttTerminals(this, vscode));
    }

    // The bottom panel's RTT terminal view; VS Code resolves it once its tab is shown.
    get rttPanel() {
        return (this._rttPanelHost ??= new RttPanelHost(this, { vscode }));
    }

    rttConfigurationChanged() {
        this._rttTerminalController?.settingsChanged();
    }
    constructor(context) {
        this.commandHandlers = {};
        this._context = context;
        this._webviewAssetRootUri = vscode.Uri.joinPath(context.globalStorageUri, "webview-assets");
        // Language priority: an explicit user choice (globalState) > the VS Code display language (zh-* -> Chinese,
        // anything else -> English)
        const savedLang = context.globalState.get("emberprobe.lang");
        this._lang = i18n.SUPPORTED_LANGS.includes(savedLang) ? savedLang : i18n.matchVscodeLang(vscode.env.language);
        this._livePanels = new Map();
        this._livePanelRegistry = null;
        /** @type {WeakMap<object[], { length: number, index: Map<string, any> }>} */
        this._symbolNameIndexes = new WeakMap();
        this._webviewRenders = new WeakMap();
        this._livePanelFocusOrder = 0;
        this._debugReadPlanKey = "";
        this._shutdownPromise = null;
        /** @type {{ t: number, bytes: number }[]} Recent archive sizes for the remaining-time estimate. */
        this._archiveRateSamples = [];
        // VS Code started the EmberProbe MCP server in this window (the user accepted the MCP trust prompt).
        this._mcpBridgeRequested = false;
        this._samplingController = createSamplingController(this, {
            frequencyHz: configuredFrequencyHz(vscode.workspace.getConfiguration("emberprobe")),
            unlimited: context.workspaceState.get(UNLIMITED_SAMPLING_STATE_KEY) === true,
            pointerExpandedOnly: context.workspaceState.get(POINTER_EXPANDED_ONLY_STATE_KEY) !== false
        });
        const services = createServices(this, context, { vscode });
        this._probeCoordinator = services.probeCoordinator;
        this._externalDebug = services.externalDebug;
        this._runtimeSampleHold = services.runtimeSampleHold;
        this._liveWatchService = services.liveWatchService;
        this._samplingCoordinator = services.samplingCoordinator;
        this._watchLists = services.watchLists;
        this._debugBridge = services.debugBridge;
        this._rtosViewService = services.rtosViewService;
        this._samplingArchive = services.samplingArchive;
        this._chartHistory = services.chartHistory;
        this._writeAuthorization = services.writeAuthorization;
        this._agentPermissions = services.agentPermissions;
        this._peripheralWriteAuthorization = services.peripheralWriteAuthorization;
        this._flashAuthorization = services.flashAuthorization;
        this._firmwareRecord = services.firmwareRecord;
        this._configurationStore = services.configurationStore;
        this._probeDriverService = services.probeDriverService;
        this._probeConnectionService = services.probeConnectionService;
        this._cubemxFirmware = services.cubemxFirmware;
        this._cubemxConfiguration = services.cubemxConfiguration;
        this._cubemxService = services.cubemxService;
        this._flashService = services.flashService;
        this._faultService = services.faultService;
        this._elfService = services.elfService;
        this._openOcdStatusService = services.openOcdStatusService;
        this._skillStatusService = services.skillStatusService;
        this._chipInfoService = services.chipInfoService;
        this._svdManager = services.svdManager;
        this._peripheralAccessService = services.peripheralAccessService;
        this._svdPeripheralService = services.svdPeripheralService;
        this._peripheralViewService = services.peripheralViewService;
        this._debugControlService = services.debugControlService;
        this._agentFlashService = services.agentFlashService;
        this._bridgeRegistry = services.bridgeRegistry;
        this._agentService = services.agentService;
        this._mcpRegistration = services.mcpRegistration;
        this._latestSidebarSamples = this._liveWatchService.latestSidebarSamples;
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
    get language() {
        return this._lang;
    }
    // Whether the sidebar and a chart panel have rendered; the extension-host smoke test waits for both.
    viewState() {
        return { sidebar: !!this._sidebarReady, graph: [...this._livePanels.values()].some((entry) => entry.ready) };
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
        this._rttPanelHost?.languageChanged();
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
            ...(this._peripheralAccessService
                ? this._peripheralAccessService.status()
                : {
                      canRead: status.paused && !this._debugBridge.replBusy && status.capabilities.read === true,
                      canWrite: status.paused && !this._debugBridge.replBusy && status.capabilities.write === true
                  })
        });
    }
    _postOpenOcdStatus(status) {
        this._openOcdStatusService.post(status);
    }
    async refreshOpenOcdStatus(showChecking = true) {
        return this._openOcdStatusService.refresh(showChecking);
    }
    // Refreshes both CubeMX installation paths at startup and when their machine settings change.
    refreshCubeMxStatus() {
        return this._cubemxConfiguration.refresh();
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
        this.commandHandlers["mcu-vscode.selectIoc"] = () => this._cubemxConfiguration.selectIoc();
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
                    const cleanPath = validation.cleanWindowsPath(file.fsPath);
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
                const finalPath = validation.cleanWindowsPath(selected.description);
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
            await this._connectedProbes.refresh();
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
        this.commandHandlers["mcu-vscode.startRtt"] = async () => this._rttTerminals.startCommand();
        this.commandHandlers["mcu-vscode.stopRtt"] = async () => this._rttTerminals.stopCommand();
        this.commandHandlers["mcu-vscode.showRttTerminals"] = async () => this._rttTerminals.showTerminals();
        this.commandHandlers["mcu-vscode.rttSaveLog"] = () => this._rttTerminals.saveLog();
        this.commandHandlers["mcu-vscode.rttToggleTimestamps"] = () => this._rttTerminals.toggleTimestamps();
    }
    async _configurationSnapshot() {
        const snapshot = this._configurationStore.snapshot();
        snapshot.svd = (await this._svdManager.peekBound())?.path || "";
        const selectedProbe = this._context ? this._connectedProbes.selection().get() : null;
        if (selectedProbe) {
            snapshot.selectedProbe = selectedProbe;
            // Previously installed skills read only the v1/v2 record.
            snapshot.successfulConnection = this._connectedProbes.selection().legacy();
        }
        return snapshot;
    }
    _assertConnectionEditable(values) {
        const keys = ["debugger", "mcu", "openocdPath", "transport", "probeSerial", "adapterSpeedKhz"];
        if (keys.some((key) => Object.hasOwn(values, key))) {
            this._connectedProbes.assertDriverIdle();
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
        if (this._connectedProbes.monitor)
            this._connectedProbes
                .refresh()
                .catch((error) => console.error("Probe inventory check failed:", error.message));
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
            this._historyFeed.discardAppend(entry);
            entry.historyRevision = (entry.historyRevision || 0) + 1;
            entry.post({ type: "debugSessionChanged", sessionId });
            this._historyFeed.configure(entry);
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
        this._mcpRegistration.publishClients();
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
        await this._sampling.runtimeExpansionsChanged(watchKey);
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
            this._historyFeed.flushAppend(entry);
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
        if (message.key === "live.needVar" && this._sampling.treesClosed()) message.key = "live.expandToSample";
        for (const entry of this._livePanels.values()) entry.post(message);
        this._webviewView?.webview.postMessage({
            ...message,
            frequencyHz: 20,
            actualHz: message.consumers?.sidebarHz ?? message.actualHz
        });
        if (this._peripheralAccessService) this._postPeripheralDebugStatus();
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
        this._historyFeed.configure(entry);
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
        this._connectedProbes.stopMonitor();
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
            // RTT may own a session and a probe lease; release its terminals and logs before the managed server and
            // sampling stop.
            this._rttTerminalController?.dispose();
            const rttStopped = this._rttController?.stop();
            if (rttStopped) await rttStopped.catch((error) => console.error("RTT cleanup failed:", error));
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
            await this._historyFeed.flushPending();
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
        this._connectedProbes.stopMonitor();
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
                this._connectedProbes.stopMonitor();
                return;
            }
            this._connectedProbes.startMonitor();
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
                this._connectedProbes.stopMonitor();
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
        if (writeElf)
            await this._context.workspaceState.update(CACHE_KEYS.elfPath, validation.cleanWindowsPath(result.elf));
        if (writeDebugger) await this._context.workspaceState.update(CACHE_KEYS.debugger, result.debugger);
        if (writeMcu) await this._context.workspaceState.update(CACHE_KEYS.mcuCore, result.mcu);
        if (writeElf) await this._elfView.refreshBindings();
        await this.updateView();
        if (writeDebugger) await this._connectedProbes.refresh();
        if (pickProbe && force) this._connectedProbes.reveal();
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
    getModernWebviewContent() {
        const elf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        return modernView.getModernWebviewContent(
            {
                versionLabel: versionLabel(this._context.extension?.packageJSON?.version),
                elf: elf ? path.basename(elf) : "",
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
