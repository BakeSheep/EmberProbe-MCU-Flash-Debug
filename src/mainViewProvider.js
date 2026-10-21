"use strict";
const { isSupportedDebugSession, resolveRtos, normalizeDebugServerOptions } = require("./services/debugConfiguration");
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
const {
    configuredFrequencyHz,
    frequencyHzFromInterval,
    intervalMsFromHz,
    normalizeFrequencyHz
} = require("./samplingFrequency");
const elfSymbols = require("./elfSymbols");
const dwarf = require("./dwarf");
const chipInfo = require("./chipInfo");
const faultInfo = require("./faultInfo");
const validation = require("./validation");
const { variableDisplayName, writeUnavailableKey } = require("./webview/runtime");
const { displayWarnings } = require("./webview/elfDiagnostics");
const openocdScripts = require("./openocdScripts");
const { AgentBridge } = require("./agentBridge");
const { WriteAuthorization, writeConnectionIdentity } = require("./writeAuthorization");
const { CubeMxService } = require("./services/cubemxService");
const { CubeMxConfiguration } = require("./services/cubemxConfiguration");
const { CubeMxFirmware } = require("./services/cubemxFirmware");
const { PeripheralWriteAuthorization } = require("./peripheralWriteAuthorization");
const { FlashAuthorization } = require("./flashAuthorization");
const { ProbeCoordinator } = require("./probeCoordinator");
const { ConfigurationStore, assertAgentSettable } = require("./services/configurationStore");
const { FlashService } = require("./services/flashService");
const { FirmwareRecord } = require("./services/firmwareRecord");
const { AgentFlashService } = require("./services/agentFlashService");
const { FaultService } = require("./services/faultService");
const { AgentService } = require("./services/agentService");
const { createAgentRoutes } = require("./services/agentRoutes");
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
const { jlinkDriverChoice } = require("./services/jlinkDriverChoice");
const { waitForJlinkReady } = require("./services/jlinkProbeReady");
const { listProbes } = require("../skills/_emberprobe/probe-inventory");
const { assertWriteIdentity } = require("../skills/_emberprobe/probe-connection");
const { serializeError, toUiError } = require("./services/errorEnvelope");
const {
    LiveWatchService,
    buildActiveReadPlan,
    buildChartHistoryItems,
    nextLivePanelId,
    selectFocusedPanel,
    selectPausedDebugReadSession,
    filterRuntimeRamPlan
} = require("./services/liveWatchService");
const { PointerSymbolizer } = require("./services/pointerSymbolizer");
const { WatchListStore, appendMissingWatchItems } = require("./services/watchListStore");
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
const { ensureDebugTools } = require("./services/cortexDebugPreflight");
const { externalizeWebviewHtml, pruneWebviewAssets } = require("./webviewAssets");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const i18n = require("./i18n");
const { DebugLifecycle, debugStartupPolicy } = require("./services/debugLifecycle");
const { DEBUGGER_LIST, MCU_CORE_LIST } = require("./services/targetCatalog");
const CACHE_KEYS = {
    elfPath: "mcu.elfPath",
    debugger: "mcu.debugger",
    mcuCore: "mcu.mcuCore",
    svdPath: "mcu.svdPath",
    iocPath: "mcu.iocPath",
    watchList: "mcu.watchList",
    sidebarWatchList: "mcu.sidebarWatchList",
    sidebarWriteList: "mcu.sidebarWriteList"
};
const JLINK_DRIVER_WARNING_IGNORED_KEY = "mcu.jlinkDriverWarningIgnored";
// Experimental waveform sampling without a rate cap; gated by a setting, toggled per workspace.
const UNLIMITED_SAMPLING_STATE_KEY = "liveWatch.unlimitedSampling";
const AGENT_ACCESS_STATE_KEY = "emberprobe.agentAccess";
const MCP_CONFIGURED_STATE_KEY = "emberprobe.mcpConfigured";
// Curve visibility per chart watch list, so a chart reopened after a restart shows the same curves.
const CURVE_VISIBILITY_STATE_KEY = "liveWatch.curveVisibility";
const MAX_CURVE_VISIBILITY_ENTRIES = 4096;
// One Agent write batch is shown for confirmation and, off word boundaries, runs while halted.
const MAX_WRITE_VARIABLES = 64;
const UNLIMITED_SAMPLING_SETTING = "experimental.unlimitedSampling.enabled";
// Backoff before each chart-history worker restart attempt (at most three per run/clear).
const CHART_HISTORY_RECOVERY_DELAYS_MS = Object.freeze([250, 1000, 3000]);
// 核心修改1：添加路径清洗工具函数（处理Windows路径问题）
function cleanWindowsPath(rawPath) {
    return validation.cleanWindowsPath(rawPath);
}
// 构建符号名索引：原始名（稳定身份）优先，追加唯一 displayName 别名以支持 C++ 限定名解析。
// 解析出的观察项/写入项身份仍写原始 symbol.name，displayName 仅用于查表命中。
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
// Agent 批量读取中单个变量的失败项：保留错误码/消息/细节，供 Skill 映射为结构化诊断。
function variableErrorEntry({ requestedName, error }) {
    return {
        requestedName,
        error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {})
        }
    };
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

// 实现WebviewViewProvider接口的类
class MainViewProvider {
    constructor(context) {
        // 存储命令执行函数（主进程）
        this.commandHandlers = {};
        this._context = context;
        /** @type {readonly number[]} */
        this._chartHistoryRecoveryDelaysMs = CHART_HISTORY_RECOVERY_DELAYS_MS;
        this._webviewAssetRootUri = vscode.Uri.joinPath(context.globalStorageUri, "webview-assets");
        // 语言优先级：用户显式切换过的选择（globalState）> VS Code 显示语言自动匹配（zh-* → 中文，其余 → 英文）
        const savedLang = context.globalState.get("emberprobe.lang");
        this._lang = i18n.SUPPORTED_LANGS.includes(savedLang) ? savedLang : i18n.matchVscodeLang(vscode.env.language);
        this._probeCoordinator = new ProbeCoordinator(() => this._postProbeOperationStatus());
        this._externalDebug = new ExternalDebugService({
            state: context.workspaceState,
            coordinator: this._probeCoordinator,
            settings: (folder) => vscode.workspace.getConfiguration("emberprobe", vscode.Uri.file(folder))
        });
        void this._externalDebug.releaseIfDisabled().catch(console.error);
        this._recentProgress = [];
        this._liveSession = null;
        this._managedDebugServer = null;
        this._managedDebugGroup = null;
        this._managedDebugToken = "";
        this._managedDebugSessionId = "";
        this._runtimeResumeTimer = null;
        this._runtimeDeniedKey = "";
        this._runtimeRamCache = null;
        this._livePanels = new Map();
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
        this._samplingIntent = false;
        this._samplingCoordinator = new SamplingCoordinator();
        this._debugCommandPending = false;
        this._debugLifecycle = new DebugLifecycle();
        this._terminatedDebugSessionIds = new Set();
        this._debugSessionReleases = new Map();
        this._debugReadPlanKey = "";
        this._shutdownPromise = null;
        this._liveFrequencyHz = configuredFrequencyHz(vscode.workspace.getConfiguration("emberprobe"));
        this._liveIntervalMs = intervalMsFromHz(this._liveFrequencyHz);
        this._unlimitedSamplingRequested = context.workspaceState.get(UNLIMITED_SAMPLING_STATE_KEY) === true;
        this._liveConsumers = new Set();
        this._consumerTypesCache = null;
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
            onChanged: () => this._invalidateConsumerTypes(),
            onError: (error) => console.error("Watch list unavailable:", error.message)
        });
        this._agentReadSession = null;
        this._agentReadCancelled = false;
        this._agentReadDelayTimer = null;
        this._agentReadDelayResolve = null;
        this._agentSamplingStatus = null;
        this._uiWritePromise = Promise.resolve();
        this._uiWriteTicket = 0;
        this._uiWriteLatest = new Map();
        this._debugBridge = new DebugSessionBridge({
            getReadPlan: () => this._activeReadPlan(),
            getIntervalMs: () => Math.max(MIN_DAP_INTERVAL_MS, this._liveIntervalMs),
            onSamples: (samples, t) => this._handleRawSamples(samples, t),
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
            onBackpressure: (paused) => this._setSamplingArchiveBackpressure(paused),
            onError: (error) => {
                this.stopLiveWatch();
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
                if (!executable) throw new Error("OpenOCD is required to verify that J-Link is ready");
                await waitForJlinkReady(executable, connection.probeSerial);
            },
            onStatus: (status) => this._webviewView?.webview.postMessage({ type: "probeDriverStatus", ...status }),
            log: (message) => {
                console.log(message);
                if (this._chipOutput) this._chipOutput.appendLine(message);
            }
        });
        this._probeConnectionService = new ProbeConnectionService({
            getConfig: () => this._configurationStore.snapshot(),
            getSuccessfulConnection: () => this._context.workspaceState.get("mcu.successfulProbeConnection"),
            saveSuccessfulConnection: (value) =>
                this._context.workspaceState.update("mcu.successfulProbeConnection", value),
            onResolved: (connection) => {
                this._resolvedProbeConnection = connection;
                this.updateView();
            },
            driverService: this._probeDriverService,
            onDriverUnsupported: (error) => this._showJlinkDriverWarning(error.details?.instanceId),
            beforePrepare: () => this._assertProbeDriverIdle(),
            window: vscode.window,
            t: (key, params) => this._t(key, params)
        });
        this._cubemxFirmware = new CubeMxFirmware({
            vscode,
            context,
            changed: () => this.updateView(),
            t: (key) => this._t(key)
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
        this._cpuLoadService = new (require("./services/cpuLoadService").CpuLoadService)({
            elf: this._elfService,
            coordinator: this._probeCoordinator,
            assertAvailable: () => this._assertCpuAvailable(),
            blocked: () => this._cpuLoadBlocked(),
            create: (accept, disconnect, current) => this._createCpuRuntime(accept, disconnect, current),
            post: (message) => this._webviewView?.webview.postMessage(message)
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
            onStatus: (status) => {
                // A changed SVD binding renames peripheral pointer targets on the next plan refresh.
                this._pointerPeripheralsRequested = false;
                if (this._samplingIntent) this._refreshPointerPeripherals();
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
        // VS Code 在本窗口启动了 EmberProbe MCP 服务器（用户已在 MCP 信任提示中同意）。
        this._mcpBridgeRequested = false;
        this._bridgeRegistry = null;
        const storageDir = context.globalStorageUri?.fsPath;
        if (storageDir) {
            // 每个窗口一条实例登记；启动时顺带清理宿主进程已退出的旧条目。
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
            // Bridge 描述文件（含 token）写入 globalStorage，工作区只留指针，避免令牌随 git/云同步泄露
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
    get _liveWatchRunning() {
        return this._probeCoordinator?.isActive("liveWatch") ?? false;
    }
    get _liveStarting() {
        return this._probeCoordinator?.isActive("liveStart") ?? false;
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
    get _debugServerRunning() {
        return this._probeCoordinator?.isActive("debugServer") ?? false;
    }
    // 当前界面语言（简体中文/English），由侧边栏或实时面板右上角按钮切换并持久化到全局状态
    _t(key, params) {
        return i18n.t(this._lang, key, params);
    }
    async _copyToClipboard(text) {
        const value = text ? String(text) : "";
        if (!value) return;
        try {
            await vscode.env.clipboard.writeText(value);
            vscode.window.showInformationMessage(this._t("common.copied"));
        } catch (error) {
            vscode.window.showErrorMessage(this._t("common.copyFailed", { message: error.message }));
        }
    }
    _setLang(lang) {
        this._lang = i18n.normalizeLang(lang);
        this._context.globalState.update("emberprobe.lang", this._lang);
        for (const entry of this._livePanels.values())
            entry.panel.title = this._t("lw.panelTitle", { n: entry.panelId });
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
        if (this._cpuLoadService) {
            post(this._cpuLoadService.status());
            void this._cpuLoadService.refreshSupport();
        }
        this._postProbeOperationStatus();
        if (!this._debugBridge) return;
        this._rtosViewService ||= new RtosViewService(this._debugBridge);
        post(this._rtosViewService.status());
        const status = this._debugBridge.agentStatus();
        post({
            type: "peripheralDebugStatus",
            state: status.state,
            epoch: status.epoch,
            canRead: status.paused && status.capabilities.read === true,
            canWrite: status.paused && status.capabilities.write === true
        });
    }
    async _handlePeripheralViewRequest(webview, message) {
        const post = (payload) => webview.postMessage(payload);
        const operation = message.type;
        try {
            if (!(await this._svdManager.currentPath())) throw new Error(this._t("peripheral.configureSvdFirst"));
            if (operation === "peripheralCatalogRequest") {
                post({ type: "peripheralCatalog", ...(await this._peripheralViewService.catalog()) });
            } else if (operation === "peripheralRegistersRequest") {
                post({ type: "peripheralRegisters", ...(await this._peripheralViewService.registers(message.name)) });
            } else if (operation === "peripheralReadRequest") {
                post({ type: "peripheralReadResult", ...(await this._peripheralViewService.read(message.targets)) });
            } else if (operation === "peripheralWriteRequest") {
                if (typeof message.target !== "string" || !message.target.trim() || message.target.length > 256)
                    throw new Error("Invalid peripheral target");
                if (typeof message.value !== "string" || !message.value.trim() || message.value.length > 128)
                    throw new Error("Invalid peripheral value");
                this._assertWriteSessionCurrent(this._debugBridge);
                const result = await this._svdPeripheralService.writeFromUi({
                    writes: [{ target: message.target, value: message.value.trim() }]
                });
                post({ type: "peripheralWriteResult", target: message.target, result });
            }
        } catch (error) {
            post({
                type: "peripheralError",
                operation,
                target: operation === "peripheralWriteRequest" ? message.target : undefined,
                code: error.code,
                message: error.message || String(error)
            });
        }
    }
    _postOpenOcdStatus(status) {
        this._openOcdStatusService.post(status);
    }
    async refreshOpenOcdStatus(showChecking = true) {
        return this._openOcdStatusService.refresh(showChecking);
    }
    async _handleOpenOcdAction(action) {
        if (["select", "install"].includes(action)) this._assertConnectionEditable({ openocdPath: true });
        return this._openOcdStatusService.handleAction(action);
    }
    // 烧录/调试/实时查看前解析可用的 OpenOCD 路径；缺失状态只发送到侧边栏。
    async _resolveOpenOcdPath(executable) {
        return this._openOcdStatusService.resolve(executable);
    }
    // 注册命令处理函数（主进程执行）
    registerCommandHandlers() {
        this.commandHandlers["mcu-vscode.autoDetect"] = async () => this.runAutoDetect(true);
        this.commandHandlers["mcu-vscode.selectCubeMx"] = () => this._cubemxConfiguration.select("cubemx");
        this.commandHandlers["mcu-vscode.selectIoc"] = () => this._cubemxConfiguration.select("ioc");
        this.commandHandlers["mcu-vscode.installCubeMxFirmware"] = () => this._cubemxFirmware.install();
        this.commandHandlers["mcu-vscode.manageAgentSkills"] = async () => this.manageAgentSkills();
        this.commandHandlers["mcu-vscode.enableAgentAccess"] = async () => this.setAgentAccess("enabled");
        this.commandHandlers["mcu-vscode.disableAgentAccess"] = async () => this.setAgentAccess("disabled");
        this.commandHandlers["mcu-vscode.cleanupGlobalSkills"] = async () => this.cleanupGlobalSkills();
        this.commandHandlers["mcu-vscode.copyMcpConfig"] = async () => this._mcpRegistration.copyConfig();
        this.commandHandlers["mcu-vscode.openLiveWatch"] = async () => this.openLiveWatchPanel();
        // 1. 选择 ELF 文件（核心修改2：使用fsPath+路径清洗）
        this.commandHandlers["mcu-vscode.selectElf"] = async () => {
            try {
                console.log("主进程执行选择 ELF 文件命令");
                const elfFiles = await vscode.workspace.findFiles(
                    ELF_FILE_GLOB,
                    "{**/node_modules/**,**/.git/**,**/CMakeFiles/**}",
                    100
                );
                if (elfFiles.length === 0) {
                    vscode.window.showWarningMessage(this._t("msg.noElfFound"));
                    return false;
                }
                const items = elfFiles.map((file) => {
                    const cleanPath = cleanWindowsPath(file.fsPath); // 替换file.path为file.fsPath，再清洗
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
                await this._refreshElfBindings();
                await this.updateView();
                vscode.window.showInformationMessage(this._t("msg.elfSelected", { name: path.basename(finalPath) }));
                return true;
            } catch (err) {
                const errorMsg = err.message;
                console.error("选择 ELF 文件失败：", errorMsg);
                vscode.window.showErrorMessage(this._t("msg.selectElfFailed", { error: errorMsg }));
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            }
        };
        // 2. 选择调试器
        this.commandHandlers["mcu-vscode.selectDebugger"] = async () => {
            this._assertConnectionEditable({ debugger: true });
            console.log("主进程执行选择调试器命令");
            const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = await this._resolveOpenOcdPath(configured);
            // 以当前 OpenOCD 实际包含的 interface 脚本为准，支持 WCH 等厂商分支。
            // OpenOCD 尚未就绪时仍允许先完成手动配置，继续使用内置列表。
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
            await this.updateView();
            await this._refreshJlinkDriverChoice(true);
            vscode.window.showInformationMessage(this._t("msg.debuggerSelected", { name: debuggerCfg }));
            return true;
        };
        // 3. 选择 MCU 核心（无修改）
        this.commandHandlers["mcu-vscode.selectMcuCore"] = async () => {
            this._assertConnectionEditable({ mcu: true });
            console.log("主进程执行选择 MCU 核心命令");
            const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = await this._resolveOpenOcdPath(configured);
            // 展示当前 OpenOCD 实际包含的 target，包括 geehy/* 等厂商子目录。
            // OpenOCD 尚未就绪时仍允许先完成手动配置，继续使用内置列表。
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
            vscode.window.showInformationMessage(this._t("msg.mcuSelected", { name: mcuCore }));
            return true;
        };
        this.commandHandlers["mcu-vscode.attachDebug"] = (resource) =>
            this.commandHandlers["mcu-vscode.debug"](resource, undefined, true, { attach: true });
        this.commandHandlers["mcu-vscode.downloadOfficialSvd"] = () => this._svdManager.downloadOfficial();
        this.commandHandlers["mcu-vscode.selectExistingSvd"] = () => this._svdManager.selectExisting();
        this.commandHandlers["mcu-vscode.switchWorkspaceSvd"] = () => this._svdManager.switchBinding();
        // 4. 启动调试（核心修改4：处理TypeScript类型匹配+路径清洗）
        // startOptions.attach：托管 OpenOCD 但走 attach 请求，只 halt 不复位不下载，用于保留现场。
        this.commandHandlers["mcu-vscode.debug"] = async (
            resource,
            configuration,
            interactive = true,
            startOptions
        ) => {
            this._assertCpuIdle();
            let probePrepared = false;
            let startAccepted = false;
            let ownsPending = false;
            try {
                if (configuration?.servertype === "external")
                    throw new Error("Use an explicit F5 external attach configuration");
                this._externalDebug?.assertPhysicalAvailable();
                if (this._agentReadRunning) {
                    vscode.window.showWarningMessage(this._t("msg.agentReadBusy"));
                    return false;
                }
                if (this._debugCommandPending || this._debugStarting) {
                    vscode.window.showWarningMessage(this._t("msg.debugBusy"));
                    return false;
                }
                this._debugCommandPending = true;
                this._postProbeOperationStatus();
                ownsPending = true;
                this._debugStartupErrorReported = false;
                this._debugStartupFailureCleanedUp = false;
                console.log("主进程执行启动调试命令");
                const serverOptions = normalizeDebugServerOptions(configuration || {});
                let elfPath = configuration?.executable || this._context.workspaceState.get(CACHE_KEYS.elfPath);
                const debuggerCfg =
                    this._context.workspaceState.get(CACHE_KEYS.debugger) ||
                    (await this._probeConnectionService.resolveProbe());
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!elfPath || !debuggerCfg || !mcuCore) {
                    vscode.window.showErrorMessage(this._t("msg.configIncomplete"));
                    return false;
                }
                // 在取得探针租约之前解析，非法取值直接失败，不需要任何启动清理。
                // 解析只做一次，OpenOCD 参数与适配器 launch config 必须看到同一个值。
                const rtos = resolveRtos(
                    configuration,
                    vscode.workspace.getConfiguration("emberprobe").get("rtos", "")
                );
                // 修复类型错误：处理 undefined 情况，用空字符串兜底
                elfPath = cleanWindowsPath(elfPath);
                const { folder: workspaceFolder } = this._commandContext(resource);
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage(this._t("msg.openWorkspaceForDebug"));
                    return false;
                }
                let cortexTools = await ensureDebugTools(
                    vscode,
                    workspaceFolder,
                    this._context.workspaceState,
                    (key) => this._t(key),
                    undefined,
                    configuration || {}
                );
                if (!cortexTools) return false;
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
                // 与下载共用同一个 OpenOCD 路径配置，避免 OpenOCD 不在 PATH 时调试失败
                const configuredOpenOcdPath =
                    serverOptions.serverpath ||
                    vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
                const [resolvedSvdPath, openocdPath] = await Promise.all([
                    this._svdManager.currentPath(workspaceFolder),
                    this._resolveOpenOcdPath(configuredOpenOcdPath)
                ]);
                if (!openocdPath) return false;
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
                await this.prepareForCortexDebug(workspaceFolder);
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
                    }
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
                // 适配器据此判断自己是否处于 RTOS 感知模式；显式空值必须能覆盖 launch.json 里的旧值。
                if (rtos) debugConfig.rtos = rtos;
                else delete debugConfig.rtos;
                Object.assign(debugConfig, cortexTools);
                Object.assign(debugConfig, pretty);
                Object.assign(debugConfig, images);
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
                const errorMsg = err.i18nKey ? this._t(err.i18nKey, err.i18nParams) : err.message;
                console.error("调试启动失败：", err.stack || errorMsg);
                vscode.window.showErrorMessage(this._t("msg.debugFailed", { error: errorMsg }));
                if (probePrepared) {
                    await this._stopManagedDebugServer();
                    await this.restoreSamplingAfterDebug();
                }
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            } finally {
                if (ownsPending) {
                    if (this._debugStarting && !this._managedDebugServer) this._debugStartLease?.release();
                    if (!startAccepted) this._clearDebugStartupWatchdog();
                    this._debugCommandPending = false;
                    this._postProbeOperationStatus();
                }
            }
        };
        // 6. 下载程序（核心修改5：生成命令时清洗路径）
        this.commandHandlers["mcu-vscode.download"] = async (resource) => {
            this._assertCpuIdle();
            if (this._downloadRunning) {
                vscode.window.showWarningMessage(this._t("msg.downloadBusy"));
                return false;
            }
            if (
                this._debugStarting ||
                this._debugBridge.hasAnySession ||
                isSupportedDebugSession(this._liveDebugSession())
            ) {
                vscode.window.showWarningMessage(this._t("msg.debugBusyForDownload"));
                return false;
            }
            if (this._agentReadRunning) {
                vscode.window.showWarningMessage(this._t("msg.agentReadBusy"));
                return false;
            }
            if (this._chipInfoRunning) {
                vscode.window.showWarningMessage(this._t("msg.chipBusyForDownload"));
                return false;
            }
            if (this._liveStarting) {
                vscode.window.showWarningMessage(this._t("msg.liveBusyForDownload"));
                return false;
            }
            // Keep the live lease until process exit, then synchronously reserve download.
            const resumeSampling = !!this._samplingIntent && !!(this._liveWatchRunning || this._liveSession);
            const liveStopped = this._liveWatchRunning || this._liveSession ? this.stopLiveWatch() : null;
            if (liveStopped) await liveStopped;
            this._assertCpuIdle();
            const downloadLease = this._probeCoordinator.acquire("download");
            this._downloadLease = downloadLease;
            let downloaded = false;
            this._recentProgress = [];
            try {
                const configuredExecutable = vscode.workspace
                    .getConfiguration("emberprobe")
                    .get("openocdPath", "openocd");
                const executable = await this._resolveOpenOcdPath(configuredExecutable);
                if (!executable) return false;
                console.log("主进程执行下载程序命令");
                let elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
                const debuggerCfg =
                    this._context.workspaceState.get(CACHE_KEYS.debugger) ||
                    (await this._probeConnectionService.resolveProbe());
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!elfPath || !debuggerCfg || !mcuCore) {
                    vscode.window.showErrorMessage(this._t("msg.configIncomplete"));
                    return false;
                }
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
                        // 缓冲最近几条进度，视图未打开或刷新时可回放，避免进度静默丢失
                        const message = { type: "openocdProgress", cmd: "mcu-vscode.download", ...event };
                        this._recentProgress.push(message);
                        if (this._recentProgress.length > 6) this._recentProgress.shift();
                        this._webviewView?.webview.postMessage(message);
                    }
                );
                if (connection && !this._downloadLease?.released)
                    await this._probeConnectionService.recordSuccess(connection);
                downloaded = true;
                vscode.window.showInformationMessage(this._t("msg.downloadSuccess"));
                return true;
            } catch (err) {
                const errorMsg = err.i18nKey ? this._t(err.i18nKey, err.i18nParams) : err.message;
                console.error("固件下载失败：", errorMsg);
                vscode.window.showErrorMessage(this._t("msg.downloadFailed", { error: errorMsg }));
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            } finally {
                let refreshed = false;
                try {
                    if (downloaded) {
                        await this._refreshElfBindings();
                        refreshed = true;
                    }
                } catch (error) {
                    this._postLive({ type: "liveError", ...toUiError(error) });
                    vscode.window.showWarningMessage(this._t("msg.downloadRefreshFailed", { error: error.message }));
                } finally {
                    downloadLease.release();
                }
                if (resumeSampling && refreshed) {
                    try {
                        await this.startLiveWatch(undefined, this._liveIntervalMs, "refresh");
                    } catch (error) {
                        vscode.window.showWarningMessage(
                            this._t("msg.downloadSamplingFailed", { error: error.message })
                        );
                    }
                }
            }
        };
    }
    async _configurationSnapshot() {
        const snapshot = this._configurationStore.snapshot();
        snapshot.svd = (await this._svdManager.peekBound())?.path || "";
        const successfulConnection = this._context?.workspaceState.get("mcu.successfulProbeConnection");
        if ([1, 2].includes(successfulConnection?.version)) snapshot.successfulConnection = successfulConnection;
        return snapshot;
    }
    _assertConnectionEditable(values) {
        const keys = ["debugger", "mcu", "openocdPath", "transport", "probeSerial", "adapterSpeedKhz"];
        if (keys.some((key) => Object.hasOwn(values, key))) {
            this._assertCpuIdle();
            this._assertProbeDriverIdle();
        }
        if (
            keys.some((key) => Object.hasOwn(values, key)) &&
            (this._liveSession || this._managedDebugServer || this._agentReadSession || this._debugBridge.hasAnySession)
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
    connectionConfigurationChanged() {
        if (this._cpuLoadService?.run) void this._cpuLoadService.stop("configuration-changed").catch(() => {});
        this._probeConnectionService.markConfigurationChanged([
            this._liveSession,
            this._managedDebugServer,
            this._agentReadSession,
            this._debugBridge.activeSession
        ]);
        if (this._liveSession || this._managedDebugServer) this._postConsumerStatuses({});
        this._refreshJlinkDriverChoice(false).catch((error) =>
            console.error("J-Link USB driver check failed:", error.message)
        );
    }
    _assertWriteSessionCurrent(session) {
        this._assertCpuIdle();
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
        this._assertCpuIdle();
        this._assertGroupedReadElf();
        if (this._liveWatchRunning && this._liveSession) return this._sessionWriteConnection(this._liveSession);
        if (this._debugBridge.activeSession && this._debugBridge.agentStatus().state === "paused")
            return this._sessionWriteConnection(this._debugBridge);
        // A managed Cortex-Debug server remains the connection that will execute an
        // Agent write even while the DAP bridge is between stop events and reports
        // canWrite=false. Bind the confirmation to that server instead of preparing
        // a second standalone OpenOCD identity, which would be rejected at execution.
        if (this._managedDebugServer) return this._sessionWriteConnection(this._debugBridge);
        if (this._debugBridge.canWrite) return this._sessionWriteConnection(this._debugBridge);
        const config = this._configurationStore.snapshot();
        const executable = await this._resolveOpenOcdPath(config.openocdPath);
        return writeConnectionIdentity(
            await this._probeConnectionService.prepare({ executable, probe: config.debugger, target: config.mcu })
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
    async _authorizeAgentFlash(params) {
        return this._agentFlashService.authorize(params);
    }
    _workspacePath(value, extension) {
        return this._configurationStore.workspacePath(value, extension);
    }
    async _setAgentConfiguration(values) {
        // openocdPath 可把探针调用引向任意可执行文件，禁止经 Agent Bridge 修改；由用户在设置或侧边栏更改
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
        const resolveSymbol = this._agentSymbolResolver(this.readElfSymbols().symbols);
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
            // 支持路径语法：sensor.x, buf[0], buf[1:5]
            const parsed = elfSymbols.parseMemberPath(rawName);
            const baseName = parsed ? parsed.base : rawName;
            // 同名多编译单元的裸名会抛 VARIABLE_AMBIGUOUS，绝不把第一项写进观察列表。
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
    // 逐项规划：单个变量的解析/布局失败记入 variableErrors，不影响同批其余变量；
    // 全部失败时抛出首个错误（保持单变量请求原有的错误码），多项失败附带 details.variableErrors。
    _agentVariablePlan(params, layoutErrors = null) {
        const raw = Array.isArray(params.variables) ? params.variables : [];
        const requests = raw.map((item) =>
            typeof item === "string"
                ? { name: item }
                : {
                      name: item?.name,
                      type: item?.type
                  }
        );
        if (!requests.length) throw Object.assign(new Error("No variables supplied"), { code: "NO_VARIABLES" });
        const elfResult = this.readElfSymbols();
        const resolveSymbol = this._agentSymbolResolver(elfResult.symbols);
        const scalarRequests = [];
        const expandedScalars = [];
        const compositePlan = [];
        const failures = [];
        const planRequest = (req, index) => {
            const parsed = elfSymbols.parseMemberPath(req.name);
            const baseName = parsed ? parsed.base : req.name;
            const symbol = resolveSymbol(baseName, req.name);
            // 预取布局失败（预算/解析错误等）时报告原始错误，而不是笼统的 COMPOSITE_LAYOUT_MISSING
            const layoutError = !symbol.compositeLayout && layoutErrors?.get(symbol.name);
            if (layoutError) throw layoutError;
            const expanded = elfSymbols.expandedStaticLeaves(symbol, parsed);
            if (
                expanded.length === 1 &&
                elfSymbols.resolveLayoutPath(symbol, symbol.compositeLayout, parsed)?.node.watchType
            ) {
                expandedScalars.push({ ...expanded[0], name: expanded[0].path, requestedName: req.name });
                return;
            }
            const runtime =
                !expanded.length &&
                require("./services/runtimeWatch").runtimeWatchEntry(req.name, symbol, parsed?.segments || []);
            if (runtime) {
                compositePlan.push({ ...runtime, requestedName: req.name });
                return;
            }
            if (!expanded.length && require("./webview/runtime").requiresRuntimePath(symbol, parsed?.segments || []))
                throw Object.assign(new Error(`Invalid runtime member path: ${req.name}`), {
                    code: "INVALID_VARIABLE_PATH"
                });
            if (symbol.isComposite) {
                if (!symbol.compositeLayout) {
                    // 缺布局时不能把完整路径丢进标量解析器，否则会得到误导性的 VARIABLE_NOT_FOUND
                    throw Object.assign(new Error(`Composite variable has no DWARF layout: ${req.name}`), {
                        code: "COMPOSITE_LAYOUT_MISSING",
                        details: { base: symbol.name, reason: symbol.unsupportedReason }
                    });
                }
                if (
                    parsed &&
                    parsed.segments.length &&
                    !elfSymbols.expandCompositeLeaves(symbol, symbol.compositeLayout, parsed).length
                ) {
                    throw Object.assign(new Error(`Invalid composite member path: ${req.name}`), {
                        code: "INVALID_VARIABLE_PATH"
                    });
                }
                const totalSize = Number(symbol.size) || 0;
                compositePlan.push({
                    requestedName: req.name,
                    name: symbol.name,
                    address: Number(symbol.address) >>> 0,
                    size: totalSize,
                    type: "",
                    isComposite: true,
                    compositeLayout: symbol.compositeLayout,
                    layoutExpansions: symbol.layoutExpansions,
                    layoutExpansionGeneration: symbol.layoutExpansionGeneration,
                    pathSpec: parsed
                });
            } else if (parsed && parsed.segments.length) {
                throw Object.assign(
                    new Error(`${req.name} is not a composite variable; member paths are not applicable`),
                    { code: "INVALID_VARIABLE_PATH" }
                );
            } else {
                // 标量按已解析的身份名重解析，限定名（'main.c'::x、路径后缀）不必再与身份名逐字一致。
                scalarRequests.push({ req: { ...req, name: symbol.name }, requestedName: req.name, index });
            }
        };
        // 只有带错误码的预期失败按项隔离；无错误码的异常属于程序缺陷，继续整体抛出
        const isolate = (index, fn) => {
            try {
                fn();
            } catch (error) {
                if (!error?.code) throw error;
                failures.push({ index, requestedName: requests[index].name, error });
            }
        };
        requests.forEach((req, index) => isolate(index, () => planRequest(req, index)));
        let scalarPlan = [];
        try {
            scalarPlan = scalarRequests.length
                ? elfSymbols
                      .resolveVariableRequests(
                          elfResult.symbols,
                          scalarRequests.map((entry) => entry.req)
                      )
                      .map((item, position) => ({ ...item, requestedName: scalarRequests[position].requestedName }))
                : [];
        } catch {
            // 批量解析遇到首个错误即中止；逐项重解析以隔离失败项，并在项间保持重复请求检查。
            scalarPlan = [];
            const seen = new Set();
            for (const { req, requestedName, index } of scalarRequests) {
                isolate(index, () => {
                    const [resolvedItem] = elfSymbols.resolveVariableRequests(elfResult.symbols, [req]);
                    const item = { ...resolvedItem, requestedName };
                    if (seen.has(item.name))
                        throw Object.assign(new Error(`Variable requested more than once: ${item.name}`), {
                            code: "DUPLICATE_VARIABLE"
                        });
                    seen.add(item.name);
                    scalarPlan.push(item);
                });
            }
        }
        const plan = expandedScalars.concat(scalarPlan);
        failures.sort((a, b) => a.index - b.index);
        if (failures.length && !plan.length && !compositePlan.length) {
            const first = failures[0].error;
            if (failures.length > 1)
                first.details = { ...(first.details || {}), variableErrors: failures.map(variableErrorEntry) };
            throw first;
        }
        return { elfResult, plan, compositePlan, variableErrors: failures.map(variableErrorEntry) };
    }
    _decodeAgentSample(plan, samples, compositePlan) {
        const byName = new Map(samples.map((sample) => [sample.name, sample]));
        const timestamp = samples.reduce((latest, sample) => Math.max(latest, sample.t || 0), 0) || Date.now();
        const values = {};
        for (const item of plan) {
            const sample = byName.get(item.name);
            const decoded =
                Number.isInteger(item.bitSize) && sample?.bytes
                    ? elfSymbols.decodeBitfieldValue(sample.bytes, item.type, item.bitOffset, item.bitSize)
                    : {
                          value: sample?.bytes ? elfSymbols.decodeValue(sample.bytes, item.type) : null,
                          valueText: sample?.bytes ? elfSymbols.decodeValueText(sample.bytes, item.type) : null
                      };
            values[item.name] = {
                requestedName: item.requestedName,
                ...decoded,
                type: item.type,
                address: `0x${item.address.toString(16).toUpperCase()}`
            };
        }
        if (compositePlan) {
            for (const comp of compositePlan) {
                const sample = byName.get(comp.name);
                const fullTree = comp.runtimeLayout
                    ? sample?.runtimeTree
                    : sample?.bytes
                      ? elfSymbols.decodeComposite(sample.bytes, comp.compositeLayout, comp)
                      : null;
                const node = comp.runtimeLayout
                    ? fullTree
                    : fullTree
                      ? elfSymbols.navigateCompositeTree(fullTree, comp.pathSpec)
                      : null;
                const baseAddr = comp.address >>> 0;
                const addrHex = (off) => `0x${((baseAddr + (off || 0)) >>> 0).toString(16).toUpperCase()}`;
                if (elfSymbols.isScalarLeafNode(node)) {
                    // 路径定位到单个标量成员/元素：以标量形式返回，便于趋势分析与阅读
                    values[comp.requestedName] = {
                        requestedName: comp.requestedName,
                        value: node.value,
                        valueText: node.valueText ?? null,
                        type: node.type,
                        address: comp.runtimeLayout ? addrHex(node.address - baseAddr) : addrHex(node.offset)
                    };
                } else {
                    values[comp.requestedName] = {
                        requestedName: comp.requestedName,
                        tree: node,
                        type: "composite",
                        address: addrHex(node && node.offset),
                        ...(sample?.diagnostic ? { diagnostic: sample.diagnostic } : {})
                    };
                }
            }
        }
        return { timestamp, values };
    }
    _postAgentSampling(running, key, params) {
        this._agentSamplingStatus = running ? { running, key, params, agentOwned: true } : null;
        this._postLive({ type: "liveStatus", running, key, params, agentOwned: running });
    }
    _waitAgentInterval(intervalMs) {
        return new Promise((resolve) => {
            const finish = () => {
                if (this._agentReadDelayTimer) clearTimeout(this._agentReadDelayTimer);
                this._agentReadDelayTimer = null;
                this._agentReadDelayResolve = null;
                resolve(undefined);
            };
            this._agentReadDelayResolve = finish;
            this._agentReadDelayTimer = setTimeout(finish, intervalMs);
        });
    }
    async _runAgentSamples(params, count, intervalMs, syncStatus) {
        const layoutErrors = new Map();
        await this._prepareRequestedLayouts(params.variables, { layoutErrors });
        const { elfResult, plan, compositePlan, variableErrors } = this._agentVariablePlan(params, layoutErrors);
        // 合并标量与复合变量的实际读取项：复合变量按基址整体读一次（同名去重），
        // 解码时再按各路径导航；避免同一结构体多次重复读取。
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
                for (let index = 0; index < count; index++) {
                    if (temporary && !this._agentReadRunning)
                        throw Object.assign(new Error("Agent sampling was cancelled by the user"), {
                            code: "AGENT_READ_CANCELLED"
                        });
                    result.push(
                        this._decodeAgentSample(
                            plan,
                            await session.readOnce(this._runtimeReadRanges(readItems, elfResult)),
                            compositePlan
                        )
                    );
                    if (temporary && syncStatus)
                        this._postAgentSampling(true, "live.agentSampling", { current: index + 1, total: count });
                    if (index + 1 < count) await this._waitAgentInterval(effectiveIntervalMs);
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
    // 获取 Agent 探针会话：复用活动采样连接或创建临时会话，handler({session, source, temporary}) 完成实际读写，
    // finally 中临时会话必释放。互斥与状态同步语义与原 _runAgentSamples 一致。
    // Tcl 端口：用户显式配置过 emberprobe.tclPort 时使用配置值，否则随机选用临时端口。
    // OpenOCD 的 Tcl 端口无认证，固定默认端口会让采样期间的任意本机进程都能下发 halt/write_memory。
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
    _runtimeRamPlan(items, strict = false) {
        const elfResult = this.readElfSymbols();
        if (!this._runtimeRamCache || this._runtimeRamCache.sha256 !== elfResult.elf.sha256) {
            this._runtimeRamCache = {
                sha256: elfResult.elf.sha256,
                sections: Array.isArray(elfResult.memory?.sections) ? elfResult.memory.sections : []
            };
        }
        const result = filterRuntimeRamPlan(items, this._runtimeRamCache.sections);
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
        liveWatch.validateManagedReadPlan(result.allowed);
        return result;
    }
    _configureManagedRuntimeWatch() {
        const server = this._managedDebugServer;
        if (!server || server.capabilities?.runtimeRead === false) return [];
        const plan = this._runtimeRamPlan(this._activeReadPlan());
        this._applySamplingPlan(server, plan.allowed);
        const deniedKey = plan.denied.map((item) => `${item.name}:${item.address}:${item.size}`).join("|");
        if (deniedKey && deniedKey !== this._runtimeDeniedKey) {
            this._runtimeDeniedKey = deniedKey;
            const t = Date.now();
            this._handleRawSamples(
                plan.denied.map((item) => ({ name: item.name, bytes: null, t })),
                t
            );
            this._postLive({
                type: "liveError",
                key: "live.runtimeAddressRejectedNames",
                params: { names: plan.denied.map((item) => item.name).join(", ") }
            });
        } else if (!deniedKey) this._runtimeDeniedKey = "";
        return plan.allowed;
    }
    async _startManagedDebugServer(executable, probe, target, cfg, interactive = true, rtos = "", serverOptions = {}) {
        const selection = normalizeDebugServerOptions(serverOptions);
        const connection = await this._probeConnectionService.prepare({ executable, probe, target }, interactive);
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
                    intervalMs: this._liveIntervalMs
                },
                {
                    onConnectionConfirmed: () => {
                        if (this._managedDebugServer === server)
                            void this._probeConnectionService.recordSuccess(server.options);
                    },
                    onSample: (samples, t, consumers) => this._handleRawSamples(samples, t, consumers),
                    onStatus: (status) => {
                        if (this._managedDebugServer !== server) return;
                        if (status?.key === "live.debugRuntimeSampling") {
                            // Recovery notifications can arrive after GDB paused or sampling was disabled.
                            this._postConsumerStatuses(this._samplingStatus());
                        } else if (status?.key === "live.debugTclDegraded") {
                            this._postConsumerStatuses({
                                mode: "debug-running-degraded",
                                key: status.key,
                                source: "openocd",
                                canRead: false,
                                canWrite: false,
                                snapshotReady: false,
                                intentEnabled: this._samplingIntent,
                                running: this._samplingIntent
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
            this._runtimeDeniedKey = "";
        }
        if (!group) lease?.release();
    }
    _armDebugStartupWatchdog() {
        const version =
            this._managedDebugToken || this._externalDebug?.active
                ? ""
                : vscode.extensions?.getExtension?.("marus25.cortex-debug")?.packageJSON?.version || "";
        return this._debugLifecycle.arm(debugStartupPolicy(process.platform, version).timeoutMs, () =>
            this._recoverDebugStartupTimeout()
        );
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
            await this.prepareForCortexDebug(folder);
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
        this._webviewView?.webview.postMessage({
            type: "commandError",
            cmd: "mcu-vscode.debug",
            error: message || this._t("msg.debugStartFailed")
        });
        this._clearDebugStartupWatchdog({ kind: "failed" });
    }
    async _recoverDebugStartupTimeout() {
        const ownDebug = !!this._managedDebugToken || !!this._externalDebug?.active;
        const session = this._findManagedDebugSession();
        const timeoutMs = this._debugLifecycle?.timeoutMs || debugStartupPolicy(process.platform, "").timeoutMs;
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
        const version = ownDebug
            ? ""
            : vscode.extensions?.getExtension?.("marus25.cortex-debug")?.packageJSON?.version || "";
        const key = debugStartupPolicy(process.platform, version).messageKey;
        const timeoutMessage = this._t(key, { seconds: timeoutMs / 1000, version });
        vscode.window?.showErrorMessage?.(timeoutMessage);
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
        if (event.transition && event.transition !== "continue") return;
        const epoch = event.epoch;
        this._runtimeResumeTimer = setTimeout(() => {
            this._runtimeResumeTimer = null;
            if (
                !this._managedDebugServer ||
                this._managedDebugServer !== server ||
                this._debugBridge.paused ||
                this._debugBridge.stopEpoch !== epoch ||
                !this._samplingIntent
            )
                return;
            try {
                const allowed = this._configureManagedRuntimeWatch();
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
                    this._samplingIntent,
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
        this._assertCpuIdle();
        if (this._liveConnectionClosing || this._liveExitUnconfirmed)
            throw Object.assign(new Error("The previous probe connection has not closed"), {
                code: "PROBE_EXIT_UNCONFIRMED"
            });
        const syncStatus = !!options.syncStatus;
        const total = options.total || 0;
        // 若 UI 正在启动采样，短暂等待其完成连接，随后直接复用同一个 Tcl 会话。
        const liveDeadline = Date.now() + 7000;
        while (this._liveStarting && Date.now() < liveDeadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        let operationLease = null;
        let session = this._liveWatchRunning ? this._liveSession : null;
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
                        const plan = this._runtimeRamPlan(items, true);
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
                    target: mcuCore
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
                if (this._agentReadLease === operationLease && this._agentReadDelayResolve)
                    this._agentReadDelayResolve();
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
    // 解析写入请求：只允许标量符号与复合类型的单个标量叶子路径，且目标地址必须落在
    // ELF 的可写段（SHF_ALLOC|SHF_WRITE，即 .data/.bss）内，防止误写 Flash/外设寄存器。
    _agentWritePlan(values, options = {}) {
        const requests = (Array.isArray(values) ? values : []).map((item) => ({
            name: String(item?.name || "").trim(),
            value: item?.value
        }));
        if (!requests.length) throw Object.assign(new Error("No variables supplied"), { code: "NO_VARIABLES" });
        if (requests.length > MAX_WRITE_VARIABLES)
            throw Object.assign(new Error(`At most ${MAX_WRITE_VARIABLES} variables can be written at once`), {
                code: "INVALID_PARAMS"
            });
        if (options.refreshSymbols !== false) this._elfService.invalidate();
        const elfResult = this.readElfSymbols();
        // A write target must be named exactly; a case-folded match could be a different variable.
        const resolveSymbol = this._agentSymbolResolver(elfResult.symbols, { foldCase: false });
        const SHF_WRITE = 1,
            SHF_ALLOC = 2;
        let writable = [];
        try {
            // ElfService.read() identity-checks the result, including these cached sections.
            const parsed = elfResult.memory;
            writable = parsed.sections.filter(
                (s) => (s.flags & (SHF_WRITE | SHF_ALLOC)) === (SHF_WRITE | SHF_ALLOC) && s.size > 0
            );
        } catch (e) {
            writable = [];
        }
        const inWritable = (address, size) =>
            writable.some((s) => address >= s.addr && address + size <= s.addr + s.size);
        const items = [];
        const seen = new Set();
        const ranges = [];
        for (const req of requests) {
            if (!req.name)
                throw Object.assign(new Error("Variable name is required"), { code: "INVALID_VARIABLE_NAME" });
            const parsed = elfSymbols.parseMemberPath(req.name);
            const baseName = parsed ? parsed.base : req.name;
            // 写入目标必须唯一：同名多编译单元的裸名抛 VARIABLE_AMBIGUOUS，绝不默认写第一项。
            const symbol = resolveSymbol(baseName, req.name);
            let target;
            if (symbol && symbol.isComposite) {
                // A pointer/STL anywhere in the type graph adds a runtime layout; plain
                // fixed-offset user members of such objects stay writable.
                if (
                    (symbol.runtimeLayout || symbol.compositeLayout?.runtimeLayout) &&
                    !elfSymbols.staticRuntimeWriteLeaf(symbol, symbol.compositeLayout, parsed)
                )
                    throw Object.assign(
                        new Error(`Writing C++ runtime container or dynamic member is not supported: ${req.name}`),
                        {
                            code: "WRITE_NOT_ALLOWED"
                        }
                    );
                if (!symbol.compositeLayout)
                    throw Object.assign(new Error(`Composite variable has no DWARF layout: ${req.name}`), {
                        code: "UNSUPPORTED_VARIABLE"
                    });
                if (!parsed || !parsed.segments.length)
                    throw Object.assign(new Error(`Writing a whole composite variable is not supported: ${req.name}`), {
                        code: "UNSUPPORTED_VARIABLE"
                    });
                const leaves = elfSymbols.expandCompositeLeaves(symbol, symbol.compositeLayout, parsed);
                if (leaves.length !== 1)
                    throw Object.assign(
                        new Error(`Write target must resolve to exactly one scalar member: ${req.name}`),
                        { code: leaves.length ? "UNSUPPORTED_VARIABLE" : "INVALID_VARIABLE_PATH" }
                    );
                if (Number.isInteger(leaves[0].bitSize))
                    throw Object.assign(new Error(`Bitfield writes are not supported: ${req.name}`), {
                        code: "UNSUPPORTED_VARIABLE"
                    });
                target = {
                    name: leaves[0].path,
                    address: leaves[0].address >>> 0,
                    type: leaves[0].type,
                    size: leaves[0].size,
                    isBoolean: !!leaves[0].isBoolean,
                    isConst: !!leaves[0].isConst,
                    isReference: !!leaves[0].isReference,
                    isMemberPointer: !!leaves[0].isMemberPointer,
                    isPointer: !!leaves[0].isPointer
                };
                if (leaves[0].enumEncodingInferred)
                    throw Object.assign(new Error(`Enum write encoding is unavailable: ${req.name}`), {
                        code: "WRITE_TYPE_UNKNOWN"
                    });
            } else {
                if (parsed?.segments.length)
                    throw Object.assign(
                        new Error(`${req.name} is not a composite variable; member paths are not applicable`),
                        { code: "INVALID_VARIABLE_PATH" }
                    );
                const [plan] = elfSymbols.resolveVariableRequests(elfResult.symbols, [{ name: symbol.name }]);
                const resolvedSymbol = symbol;
                if (resolvedSymbol?.isConst || resolvedSymbol?.isReference || resolvedSymbol?.isMemberPointer)
                    throw Object.assign(new Error(`Writing to const / read-only storage is not allowed: ${req.name}`), {
                        code: "WRITE_NOT_ALLOWED"
                    });
                if (resolvedSymbol?.isPointer)
                    throw Object.assign(new Error(`Writing pointer storage is not supported: ${req.name}`), {
                        code: "WRITE_NOT_ALLOWED"
                    });
                if (!resolvedSymbol?.hasDwarfWriteType) {
                    throw Object.assign(
                        new Error(
                            `Variable type is not available from DWARF; refusing to guess a write encoding: ${req.name}`
                        ),
                        {
                            code: "WRITE_TYPE_UNKNOWN",
                            details: { name: plan.name, guessedType: plan.type }
                        }
                    );
                }
                target = {
                    name: plan.name,
                    address: plan.address,
                    type: plan.type,
                    size: plan.size,
                    isBoolean: !!resolvedSymbol.isBoolean,
                    isConst: !!resolvedSymbol.isConst
                };
            }
            // Pointer storage is read-only for top-level variables and members alike.
            if (target.isReference || target.isMemberPointer || target.isPointer)
                throw Object.assign(
                    new Error(`Writing pointer, C++ reference or member pointer storage is not supported: ${req.name}`),
                    {
                        code: "WRITE_NOT_ALLOWED"
                    }
                );
            if (target.isConst) {
                throw Object.assign(new Error(`Writing to const / read-only variable is not allowed: ${req.name}`), {
                    code: "WRITE_NOT_ALLOWED",
                    details: { name: target.name }
                });
            }
            if (seen.has(target.name))
                throw Object.assign(new Error(`Variable requested more than once: ${target.name}`), {
                    code: "DUPLICATE_VARIABLE"
                });
            seen.add(target.name);
            if (target.isBoolean && ![0, 1, "0", "1", false, true].includes(req.value))
                throw Object.assign(new Error(`Boolean variables accept only 0 or 1: ${req.name}`), {
                    code: "INVALID_WRITE_VALUE"
                });
            const bytes = elfSymbols.encodeValue(
                target.isBoolean && typeof req.value === "boolean" ? Number(req.value) : req.value,
                target.type
            );
            const end = target.address + Math.max(target.size, bytes.length);
            const overlap = ranges.find((range) => target.address < range.end && range.start < end);
            if (overlap)
                throw Object.assign(new Error(`Write targets overlap in memory: ${overlap.name} and ${target.name}`), {
                    code: "DUPLICATE_VARIABLE",
                    details: { names: [overlap.name, target.name] }
                });
            ranges.push({ start: target.address, end, name: target.name });
            if (!inWritable(target.address, Math.max(target.size, bytes.length))) {
                throw Object.assign(
                    new Error(`Target address is outside writable RAM sections (.data/.bss): ${req.name}`),
                    {
                        code: "WRITE_NOT_ALLOWED",
                        details: { name: target.name, address: `0x${target.address.toString(16).toUpperCase()}` }
                    }
                );
            }
            items.push({
                requestedName: req.name,
                name: target.name,
                address: target.address,
                type: target.type,
                size: target.size,
                bytes,
                value: elfSymbols.decodeValue(bytes, target.type),
                valueText: elfSymbols.decodeValueText(bytes, target.type)
            });
        }
        return { elfResult, items };
    }
    // 会话内写入执行核心：写前读取 → 写入 → 回读校验，Agent 与侧边栏 UI 写入共用。
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
            const status = this._samplingStatus();
            if (status.mode !== "debug-running-sampling" || !status.canWrite)
                throw Object.assign(new Error("Runtime writes require an active managed OpenOCD sampling session"), {
                    code: "RUNTIME_WRITE_DISABLED"
                });
            this._assertGroupedReadElf();
            this._runtimeRamPlan(
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
            const msg = unreadable.map((r) => `${r.name}: ${r.readBackError}`).join("; ");
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
    // 高危操作：首次先返回聊天确认请求；一次性确认 ID 与 ELF/地址/类型/值绑定。
    // 用户可选择仅本次授权，或在首次成功写入后记住当前工作区授权。
    async _writeAgentVariables(params) {
        this._assertCpuIdle();
        // "false" or 0 must never be read as a request to remember write permission.
        if (params.remember !== undefined && typeof params.remember !== "boolean")
            throw Object.assign(new Error("remember must be a boolean"), { code: "INVALID_PARAMS" });
        await this._prepareRequestedLayouts(params.values);
        const plan = this._agentWritePlan(params.values, { refreshSymbols: false });
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
            const result = await this._executeWritePlan(this._debugBridge, "cortex-debug-dap", plan);
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
    // 侧边栏写入列表：用户在 UI 中直接操作，不经过 WriteAuthorization 确认；
    // 保留 _agentWritePlan 的全部安全校验（DWARF 类型已知、目标地址在 .data/.bss 可写段内）。
    // 仅在实时采样运行时允许写入，直接复用采样的 Tcl 会话。
    // A rebuilt but unflashed ELF moves RAM addresses, and read-back verification reads the
    // same wrong address. Require one explicit choice per ELF digest before UI writes proceed.
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
        this._assertCpuIdle();
        if (this._liveConnectionClosing || this._liveExitUnconfirmed)
            throw Object.assign(new Error("The previous probe connection has not closed"), {
                code: "PROBE_EXIT_UNCONFIRMED"
            });
        await this._confirmUiWriteFirmware(options.requestedAt ?? Date.now());
        const status = this._samplingStatus();
        const dapSession = status.canWrite && this._debugBridge.canWrite ? this._debugBridge : null;
        const runtimeSession =
            status.canWrite && status.mode === "debug-running-sampling" ? this._managedDebugServer : null;
        const session =
            dapSession || runtimeSession || (status.canWrite && this._liveWatchRunning ? this._liveSession : null);
        if (!session) {
            const key = writeUnavailableKey(status) || "sb.writeUnavailable";
            throw Object.assign(new Error(this._t(key)), { i18nKey: key });
        }
        await this._prepareRequestedLayouts([{ name }]);
        const plan = this._agentWritePlan([{ name, value }], { refreshSymbols: false });
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
            dapSession ? "cortex-debug-dap" : runtimeSession ? "debug-running-openocd" : "active-sampling",
            plan
        );
    }
    async _agentWritePermission(params) {
        this._assertCpuIdle();
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
    // 读取并解码 Cortex-M 故障寄存器；与 chip.read 共用 _chipInfoRunning 互斥（一次性 OpenOCD 进程同一时刻只能有一个）
    async _readAgentFault() {
        this._assertCpuIdle();
        const busy = (key, code) => {
            throw Object.assign(new Error(this._t(key)), { i18nKey: key, code });
        };
        if (this._chipInfoRunning) busy("chip.reading", "CHIP_READ_RUNNING");
        if (this._downloadRunning) busy("chip.busyDownload", "PROBE_BUSY");
        if (this._liveWatchRunning) busy("chip.busyLive", "PROBE_BUSY");
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
    async startAgentBridge() {
        return this._agentService.start();
    }
    isAgentBridgeStarted() {
        return this._agentService.isStarted();
    }
    async stopAgentBridge() {
        return this._agentService.stop();
    }
    // 按工作区生效的 Agent 访问开关：enabled | disabled | 未设置（undefined）。只写 workspaceState。
    _agentAccess() {
        const value = this._context?.workspaceState?.get(AGENT_ACCESS_STATE_KEY);
        return value === "enabled" || value === "disabled" ? value : undefined;
    }
    _agentAccessDecision(status) {
        if (!vscode.workspace.isTrusted) return { enabled: false, state: "untrusted" };
        const access = this._agentAccess();
        if (access === "disabled") return { enabled: false, state: "disabled" };
        if (access === "enabled") return { enabled: true, reason: "access" };
        // 兼容：已装工作区 skills 且未显式设置时视为启用。
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
        }
    }
    _agentAccessView(status = this._skillStatusService.lastStatus, decision = this._agentAccessDecision(status)) {
        const access = this._agentAccess();
        const legacyGlobal = legacyGlobalSkills(status);
        // 检测到全局副本或用户复制过外部 MCP 配置、但本工作区未启用时，提示启用。
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
    // VS Code MCP provider：受信任、打开了文件夹且未显式停用 Agent 访问的窗口才提供服务器定义。
    _mcpAvailable() {
        return (
            !!vscode.workspace.isTrusted &&
            !!vscode.workspace.workspaceFolders?.length &&
            this._agentAccess() !== "disabled" &&
            !!this._bridgeRegistry
        );
    }
    // emberprobe.mcp.toolsets → EMBERPROBE_MCP_TOOLSETS；默认工具集返回空串，不注入环境变量。
    _mcpToolsets() {
        const configured = vscode.workspace.getConfiguration?.("emberprobe").get("mcp.toolsets");
        const selected = TOOLSETS.filter((name) => Array.isArray(configured) && configured.includes(name));
        if (!selected.length || selected.join(",") === DEFAULT_TOOLSETS.join(",")) return "";
        return selected.join(",");
    }
    // VS Code 在用户同意 MCP 信任提示后解析定义：此时为本窗口启动 Bridge（不写工作区文件）。
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
    // 清理已停止维护的全局 skills 副本：只删除 EmberProbe 清单内的条目。
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
    _postSkillStatus(status) {
        this._skillStatusService.post(status);
    }
    async refreshSkillStatus(autoUpdate = false) {
        const status = await this._skillStatusService.refresh(autoUpdate);
        await this._syncAgentBridge(status);
        return status;
    }
    // 在输出面板记录“谁执行了哪次调用”：通道、客户端、方法与结果码，不含参数值。
    _auditAgentCall(entry) {
        if (!vscode.window.createOutputChannel) return;
        if (!this._agentAudit) {
            this._agentAudit = vscode.window.createOutputChannel(this._t("agent.auditChannel"));
            this._context.subscriptions?.push(this._agentAudit);
        }
        const caller = [entry.channel || "legacy", entry.client].filter(Boolean).join(" ");
        this._agentAudit.appendLine(`${new Date().toISOString()} ${caller} ${entry.method} ${entry.code}`);
    }
    // 调用前检查实际发起调用的 skill 副本；自定义内容需独立 UI 批准，内容再次变化会失效。
    async _warnIfSkillsModified(meta) {
        await this._skillStatusService.checkForCall(meta);
    }
    // 后台生成没有自己的 withProgress 窗口（Bridge 调用立即返回 operationId），
    // 因此为运行中的操作挂一个可取消的通知，复用既有进度与取消交互
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
    // 已安装 Skills 与插件内置版本存在差异（可更新/被修改/不完整）时提示升级；
    // 每个会话最多提示一次，避免侧边栏刷新与工作区切换反复打扰
    _promptSkillUpgrade(status) {
        this._skillStatusService.promptUpgrade(status);
    }
    _scopeStateText(scope) {
        return this._skillStatusService.scopeStateText(scope);
    }
    _scopeHasContent(scope) {
        return this._skillStatusService.scopeHasContent(scope);
    }
    // Agent Skills 工作区安装开关
    async manageAgentSkills() {
        const result = await this._skillStatusService.manage();
        // 显式停用过的工作区重新安装 skills 时恢复为未设置，使 skills 开关与过去一样开启 Bridge。
        if (result && hasWorkspaceSkills(result) && this._agentAccess() === "disabled")
            await this._context.workspaceState.update(AGENT_ACCESS_STATE_KEY, undefined);
        if (result) await this._syncAgentBridge(result);
        return result;
    }
    // VS Code restores chart tabs left open at shutdown; each keeps its panel number and so its watch list.
    restoreLiveWatchPanel(panel, state) {
        const saved = Number(state?.panelId);
        const panelId =
            Number.isSafeInteger(saved) && saved >= 1 && !this._livePanels.has(saved)
                ? saved
                : nextLivePanelId(this._livePanels);
        panel.title = this._t("lw.panelTitle", { n: panelId });
        panel.webview.options = { enableScripts: true, localResourceRoots: [this._webviewAssetRootUri] };
        this.openLiveWatchPanel(panel, panelId);
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
    // 打开/聚焦实时变量查看面板（独立 WebviewPanel，编辑区宽度足够绘图）
    openLiveWatchPanel(restoredPanel = null, restoredId = null) {
        if (!this._seriesStyleStore) {
            const { SeriesStyleStore } = require("./services/seriesStyleStore");
            this._seriesStyleStore = new SeriesStyleStore(this._context.workspaceState);
        }
        const panelId = restoredId || nextLivePanelId(this._livePanels);
        const watchKey = panelId === 1 ? CACHE_KEYS.watchList : `${CACHE_KEYS.watchList}.${panelId}`;
        const cfg = vscode.workspace.getConfiguration("emberprobe");
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
        this._invalidateConsumerTypes();
        this._renderWebview(
            panel.webview,
            liveWatchView.getLiveWatchContent(
                {
                    backendHistory: true,
                    frequencyHz: this._liveFrequencyHz,
                    panelId
                },
                this._lang
            ),
            `live-watch-${panelId}`
        );
        panel.onDidChangeViewState((event) => {
            if (event.webviewPanel.active) entry.focusOrder = ++this._livePanelFocusOrder;
        });
        panel.onDidDispose(() => {
            this._flushChartHistoryAppend(entry);
            if (entry._batchTimer) clearTimeout(entry._batchTimer);
            this._chartHistory?.request("remove", [this._debugSamplingScope(watchKey)]).catch(() => {});
            this._webviewRenders?.delete(panelWebview);
            this._livePanels.delete(panelId);
            pruneWebviewAssets(this._webviewAssetRootUri.fsPath, `live-watch-${panelId}`, new Set());
            this._invalidateConsumerTypes();
            this._refreshSamplingPlan().catch(() => {});
        });
        panel.webview.onDidReceiveMessage(async (message) => {
            if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string")
                return;
            try {
                if (message.panelId !== undefined && Number(message.panelId) !== panelId) {
                    throw Object.assign(new Error("Live panel identity mismatch"), { code: "INVALID_PANEL_ID" });
                }
                switch (message.type) {
                    case "copyText":
                        await this._copyToClipboard(message.text);
                        break;
                    case "ready":
                        entry.ready = true;
                        await this._seriesStyleStore.initialize(
                            this._context.workspaceState
                                .keys()
                                .filter(
                                    (key) => key === CACHE_KEYS.watchList || key.startsWith(CACHE_KEYS.watchList + ".")
                                )
                                .sort(
                                    (a, b) =>
                                        (Number(a.slice(CACHE_KEYS.watchList.length + 1)) || 1) -
                                        (Number(b.slice(CACHE_KEYS.watchList.length + 1)) || 1)
                                )
                                .map((key) => this._context.workspaceState.get(key) || [])
                        );
                        post({ type: "seriesStyles", styles: this._seriesStyleStore.styles });
                        post(this._unlimitedSamplingState());
                        post({ type: "chartHistoryReady", historyRevision: entry.historyRevision || 0 });
                        post({ type: "curveVisibility", hidden: this._curveVisibility(watchKey) });
                        this._syncGraphTarget(entry);
                        if (this._liveSession) {
                            const active = this._activeReadPlan();
                            if (active.length) this._applySamplingPlan(this._liveSession, active);
                        }
                        if (this._chartHistory) {
                            const scope = this._debugSamplingScope(watchKey);
                            const revision = entry.historyRevision || 0;
                            this._flushChartHistoryAppend(entry);
                            const status = await this._chartHistory.request("status", [scope]);
                            if (
                                scope === this._debugSamplingScope(watchKey) &&
                                revision === (entry.historyRevision || 0)
                            )
                                post({ type: "chartHistoryStatus", ...status, historyRevision: revision });
                        }
                        break;
                    case "saveCurveVisibility":
                        await this._saveCurveVisibility(watchKey, message.hidden);
                        break;
                    case "setSeriesStyle": {
                        const styles = await this._seriesStyleStore.update(message.name, message.style);
                        for (const target of this._livePanels.values()) target.post({ type: "seriesStyles", styles });
                        break;
                    }
                    case "importVariables": {
                        const wasLoading =
                            !!this._elfService.resolveSymbols || !this._elfVersion(this._elfService.cache);
                        const result = await this._elfService.load();
                        if (wasLoading || message.version === this._elfVersion(result))
                            post({
                                type: "variablesListDone",
                                version: this._elfVersion(result),
                                warnings: displayWarnings(result)
                            });
                        else this._sendElfSnapshot(post, "variablesList");
                        break;
                    }
                    case "resolveVariable":
                        await this._resolveLiveVariable(message, post);
                        break;
                    case "expandLayout":
                        await this._handleLayoutExpansion(message, post);
                        break;
                    case "resolveCompositeLayout": {
                        try {
                            const layout = await this._resolveElfLayout(message.name, message.version);
                            post({
                                type: "compositeLayoutResult",
                                name: message.name,
                                version: message.version,
                                layout,
                                ...this._layoutExpansionSnapshot(message.name)
                            });
                        } catch (error) {
                            post({
                                type: "compositeLayoutResult",
                                name: message.name,
                                version: message.version,
                                error: error.message
                            });
                        }
                        break;
                    }
                    case "saveWatch":
                        await this._saveWatchList(watchKey, message.items || []);
                        break;
                    case "importSidebarWatch": {
                        const saved = this._scalarWatchList(watchKey);
                        const current = appendMissingWatchItems(message.items, saved);
                        const sidebarItems = this._scalarWatchList(CACHE_KEYS.sidebarWatchList);
                        const merged = appendMissingWatchItems(current, sidebarItems);
                        if (JSON.stringify(merged) !== JSON.stringify(saved))
                            await this._saveWatchList(watchKey, merged);
                        post({
                            type: "sidebarImportResult",
                            added: merged.length - current.length,
                            sourceCount: sidebarItems.length
                        });
                        break;
                    }
                    case "start":
                        await this._saveWatchList(watchKey, message.items || []);
                        if (message.frequencyHz !== undefined) await this._saveLiveFrequency(message.frequencyHz);
                        await this.startLiveWatch(message.items || [], this._liveIntervalMs, "graph");
                        break;
                    case "stop":
                        if (this._agentReadRunning) this.stopAgentReadIfRunning();
                        else this.stopLiveWatch({ variablesOnly: true });
                        break;
                    case "setInterval":
                        this._setLiveInterval(message.intervalMs);
                        break;
                    case "setFrequency":
                        await this._saveLiveFrequency(message.frequencyHz);
                        break;
                    case "setUnlimitedSampling":
                        try {
                            await this._setUnlimitedSampling(message.enabled);
                        } finally {
                            // Resynchronise the toggle even when the request was rejected.
                            post(this._unlimitedSamplingState());
                        }
                        break;
                    case "samplingArchiveInfo": {
                        const history = this._samplingArchive.status(this._debugSamplingScope(watchKey));
                        post({
                            type: "samplingArchiveInfo",
                            historyRevision: message.historyRevision,
                            openExport: message.openExport === true,
                            ...history,
                            displayNames: Object.fromEntries(this._displayNamesForSeries(watchKey, history.variables))
                        });
                        break;
                    }
                    case "clearSamplingHistory": {
                        this._resetChartHistoryWarnings();
                        this._discardChartHistoryAppend(entry);
                        entry.historyClearedAt = Date.now();
                        entry.historyRevision = message.historyRevision;
                        this._samplingArchive.clear(this._debugSamplingScope(watchKey));
                        entry.latestSamples.clear();
                        if (entry._batchTimer) clearTimeout(entry._batchTimer);
                        entry._batchTimer = null;
                        entry._pendingScalars = [];
                        entry._pendingComposites = [];
                        if (this._chartHistory && !this._chartHistory.failed)
                            await this._chartHistory.request("clear", [this._debugSamplingScope(watchKey)]);
                        post({ type: "samplingHistoryCleared", historyRevision: message.historyRevision });
                        break;
                    }
                    case "chartViewport":
                    case "chartFreeze":
                    case "chartResume":
                    case "chartExportInfo": {
                        if (!this._chartHistory) break;
                        if ((message.historyRevision || 0) !== (entry.historyRevision || 0)) break;
                        const scope = this._debugSamplingScope(watchKey);
                        const revision = entry.historyRevision || 0;
                        this._flushChartHistoryAppend(entry);
                        let result;
                        if (message.type === "chartViewport") {
                            const watched = new Set(
                                (entry.historyItems || this._scalarWatchList(watchKey)).map((item) => item.name)
                            );
                            const names = Array.isArray(message.names)
                                ? message.names.filter((name) => watched.has(name))
                                : [];
                            const previousNames = new Set(entry.historyViewportNames || []);
                            if (!message.snapshotId) entry.historyViewportNames = names;
                            result = await this._chartHistory.request("viewport", [
                                scope,
                                names,
                                message.range,
                                message.width,
                                message.snapshotId
                            ]);
                            const restoreNames = (result.evictedNames || []).filter((name) => !previousNames.has(name));
                            if (!message.snapshotId && restoreNames.length && !this._chartHistoryRecovery) {
                                await this._restoreChartHistory(entry, restoreNames);
                                result = await this._chartHistory.request("viewport", [
                                    scope,
                                    names,
                                    message.range,
                                    message.width
                                ]);
                            }
                        } else if (message.type === "chartFreeze")
                            result = await this._chartHistory.request("freeze", [scope]);
                        else if (message.type === "chartResume")
                            result = await this._chartHistory.request("resume", [scope]);
                        else result = await this._chartHistory.request("status", [scope, message.snapshotId]);
                        if (scope === this._debugSamplingScope(watchKey) && revision === (entry.historyRevision || 0))
                            post({
                                type: message.type + "Result",
                                ...result,
                                requestId: message.requestId,
                                historyRevision: revision,
                                snapshotId: result?.snapshotId || message.snapshotId
                            });
                        break;
                    }
                    case "exportCsv": {
                        const archiveScope = this._debugSamplingScope(watchKey);
                        const historyRevision = entry.historyRevision || 0;
                        const displayNames = this._displayNamesForSeries(
                            watchKey,
                            Array.isArray(message.names) && message.names.length
                                ? message.names
                                : this._samplingArchive.status(archiveScope).variables
                        );
                        const stamp = new Date(),
                            pad = (n) => String(n).padStart(2, "0");
                        const name = `emberprobe-live-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.csv`;
                        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
                        const target = await vscode.window.showSaveDialog({
                            defaultUri: folder
                                ? vscode.Uri.joinPath(folder, name)
                                : vscode.Uri.joinPath(vscode.Uri.file(os.homedir()), name),
                            filters: { CSV: ["csv"] }
                        });
                        if (!target) {
                            post({ type: "exportCsvResult", ok: false, cancelled: true });
                            break;
                        }
                        try {
                            if (
                                archiveScope !== this._debugSamplingScope(watchKey) ||
                                historyRevision !== (entry.historyRevision || 0) ||
                                (message.historyRevision !== undefined && message.historyRevision !== historyRevision)
                            )
                                throw new Error("History changed before export");
                            let result;
                            if (
                                this._chartHistory &&
                                message.backendHistory &&
                                ["snapshot", "retained"].includes(message.source)
                            ) {
                                if (
                                    message.historyRevision !== (entry.historyRevision || 0) ||
                                    archiveScope !== this._debugSamplingScope(watchKey)
                                )
                                    throw new Error("History changed before export");
                                this._flushChartHistoryAppend(entry);
                                result = await this._chartHistory.request("export", [
                                    {
                                        scope: archiveScope,
                                        outputPath: target.fsPath,
                                        names: message.names,
                                        displayNames: [...displayNames],
                                        fromMs: message.fromMs,
                                        toMs: message.toMs,
                                        snapshotId: message.source === "snapshot" ? message.snapshotId : undefined
                                    }
                                ]);
                            } else if (message.source === "snapshot" || message.source === "retained") {
                                if (typeof message.csv !== "string" || message.csv.length > 64 * 1024 * 1024)
                                    throw new Error("Invalid chart CSV");
                                await vscode.workspace.fs.writeFile(target, Buffer.from(message.csv, "utf8"));
                                result = {
                                    seriesCount: Array.isArray(message.names) ? message.names.length : 0,
                                    rows: liveWatchView.csvDataRowCount(message.csv)
                                };
                            } else
                                result = await this._samplingArchive.exportCsv({
                                    scope: archiveScope,
                                    outputPath: target.fsPath,
                                    names: message.names,
                                    displayNames,
                                    fromMs: message.fromMs,
                                    toMs: message.toMs
                                });
                            vscode.window.showInformationMessage(
                                this._t("msg.csvExported", { file: path.basename(target.fsPath) })
                            );
                            post({
                                type: "exportCsvResult",
                                ok: true,
                                seriesCount: result.seriesCount,
                                rowCount: result.rows
                            });
                        } catch (error) {
                            vscode.window.showErrorMessage(this._t("msg.csvExportFailed", { msg: error.message }));
                            post({ type: "exportCsvResult", ok: false, message: error.message });
                        }
                        break;
                    }
                    case "setLang": {
                        this._setLang(message.lang);
                        this._postLive({ type: "setLang", lang: this._lang });
                        break;
                    }
                }
            } catch (error) {
                if (
                    ["chartViewport", "chartFreeze", "chartResume", "chartExportInfo"].includes(message.type) &&
                    (this._chartHistory?.failed || this._chartHistoryRecovery)
                )
                    return;
                if (["chartViewport", "chartFreeze", "chartResume", "chartExportInfo"].includes(message.type))
                    post({
                        type: message.type + "Result",
                        requestId: message.requestId,
                        historyRevision: message.historyRevision,
                        error: error.message
                    });
                post({ type: "liveError", ...toUiError(error) });
            }
        });
    }
    // 读取当前 ELF 的全局变量符号，并尽力附带 DWARF 类型信息
    _invalidateElfState() {
        void this._cpuLoadService?.stop("image-changed").catch(() => {});
        this._elfService.invalidate();
        this._watchLists.invalidate();
        this._runtimeRamCache = null;
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
            await this._refreshSamplingPlan();
            await this._cpuLoadService?.refreshSupport();
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
        this._pruneSampleMap(this._latestSidebarSamples, [CACHE_KEYS.sidebarWatchList, CACHE_KEYS.sidebarWriteList]);
        for (const entry of this._livePanels.values()) this._pruneSampleMap(entry.latestSamples, entry.watchKey);
        await this._refreshSamplingPlan();
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
    // Agent 读写、观察列表与界面手动添加共用的名称解析（elfSymbols.createSymbolResolver）：身份名 →
    // 编译单元限定名（main.c::cfg）→ 唯一 displayName → 大小写不敏感的唯一匹配。同名变量分布在多个编译单元时
    // 裸名以 VARIABLE_AMBIGUOUS 拒绝。布局预取与读写规划必须共用它，否则按显示名请求的复合变量会缺布局。
    _agentSymbolResolver(symbols, options) {
        return elfSymbols.createSymbolResolver(symbols, options);
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
            found = this._agentSymbolResolver(result.symbols)(message.name);
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
    // 预取请求中复合变量的 DWARF 布局。传入 options.layoutErrors 时逐项收集布局错误（键为原始符号名）
    // 而不中止整批；未传入时保持原语义，首个布局错误直接抛出。名称解析失败留给后续规划报告。
    async _prepareRequestedLayouts(requests, options = {}) {
        const result = await this._elfService.ready();
        const resolveSymbol = this._agentSymbolResolver(result.symbols);
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
            void this._cpuLoadService?.refreshSupport();
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
            this._elfRebindPromise.then(() => this._refreshSamplingPlan()).catch(() => {});
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
                result.warnings.push(`${name}: ${error.message}`);
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
        await this._refreshSamplingPlan();
    }
    // 图表和侧边栏各自维护选择；同一探针连接采样两边当前启用列表的并集。
    _postLive(message) {
        if (message.type === "liveStatus") message = withWriteAccessStatus({ ...this._samplingStatus(), ...message });
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
        const status = this._samplingStatus();
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
    // 侧边栏观察项附带 displayName（C++ 限定名）供展示；数据索引仍按原始 item.name。
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
            this._postLive({ type: "liveError", key: "lw.layoutWatchInvalid", params: { names: invalid.join(", ") } });
        // A saved name that now matches same-named variables of several CUs is removed, never bound to one of them.
        if (changes.ambiguous.size)
            this._postLive({
                type: "liveError",
                key: "lw.watchAmbiguous",
                params: {
                    names: [...changes.ambiguous.keys()].join(", "),
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
            ...this._samplingStatus()
        });
        if (entry.latestSamples.size) {
            const now = Date.now();
            const scalarSamples = [],
                compositeSamples = [];
            for (const sample of entry.latestSamples.values()) {
                if (sample.tree) compositeSamples.push({ ...sample, t: now });
                else scalarSamples.push({ ...sample, t: now });
            }
            if (scalarSamples.length)
                post({ type: this._chartHistory ? "chartValues" : "liveSample", samples: scalarSamples });
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
            ...this._samplingStatus()
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
    // 图表与侧栏各自维护观察列表；同一变量在两侧可能选择不同观察类型。
    // 读取计划按变量名去重，宽度取两侧的最大值，一次读取覆盖所有消费者。
    // 复合变量（结构体/数组）展开为叶子成员读取项，按变量整体地址范围合并读取。
    _activeReadPlan() {
        const lists = [];
        for (const entry of this._livePanels.values()) lists.push(this._scalarWatchList(entry.watchKey));
        lists.push(this._scalarWatchList(CACHE_KEYS.sidebarWatchList));
        // 写入列表变量也纳入采样读取，使写入卡片能实时同步当前值；不回写存储，避免丢失 min/max 等 UI 字段
        try {
            const writeItems = this._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || [];
            lists.push(validation.normalizeWatchList(writeItems, this.readElfSymbols().symbols));
        } catch (e) {
            /* ELF 不可用时忽略写入列表 */
        }
        const plan = buildActiveReadPlan(lists, elfSymbols);
        return this._runtimeReadRanges(plan);
    }
    _runtimeReadRanges(plan, result) {
        if (!plan.some((item) => item.runtimeLayout)) return plan;
        result ??= this.readElfSymbols();
        if (!this._runtimeRamCache || this._runtimeRamCache.sha256 !== result.elf.sha256) {
            const sections = Array.isArray(result.memory?.sections) ? result.memory.sections : [];
            this._runtimeRamCache = { sha256: result.elf.sha256, sections };
        }
        const ranges = this._runtimeRamCache.sections
            .filter(
                (section) =>
                    section.flags & 2 &&
                    Number.isSafeInteger(section.addr) &&
                    Number.isSafeInteger(section.size) &&
                    section.addr > 0 &&
                    section.size > 0 &&
                    section.addr + section.size <= 0x100000000
            )
            .map((section) => ({ start: section.addr, end: section.addr + section.size }));
        return plan.map((item) => (item.runtimeLayout ? { ...item, runtimeRanges: ranges } : item));
    }
    _applySamplingPlan(session, active) {
        if (typeof session.setSamplingPlan !== "function") {
            session.setWatch(active);
            return;
        }
        const { graphs, sidebar } = this._consumerTypes();
        const graphNames = new Set([...graphs.values()].flatMap((map) => [...map.keys()]));
        const graphItems = active.filter((item) => graphNames.has(item.name) || graphNames.has(item.parentName));
        const sidebarItems = active.filter((item) => sidebar.has(item.name) || sidebar.has(item.parentName));
        if (typeof session.setSamplingPlan === "function")
            session.setSamplingPlan({
                graphItems,
                sidebarItems,
                graphIntervalMs: this._liveIntervalMs,
                unlimited: this._unlimitedSamplingEnabled()
            });
        else session.setWatch(active);
    }
    _unlimitedSamplingAvailable() {
        return vscode.workspace.getConfiguration("emberprobe").get(UNLIMITED_SAMPLING_SETTING) === true;
    }
    _unlimitedSamplingEnabled() {
        return this._unlimitedSamplingRequested === true && this._unlimitedSamplingAvailable();
    }
    _unlimitedSamplingState() {
        return {
            type: "liveUnlimited",
            available: this._unlimitedSamplingAvailable(),
            enabled: this._unlimitedSamplingEnabled()
        };
    }
    async _setUnlimitedSampling(enabled) {
        if (typeof enabled !== "boolean")
            throw Object.assign(new Error("Unlimited sampling state must be a boolean"), { code: "INVALID_PARAMS" });
        if (enabled && !this._unlimitedSamplingAvailable())
            throw Object.assign(
                new Error(`Unlimited sampling is disabled; enable emberprobe.${UNLIMITED_SAMPLING_SETTING} first`),
                { code: "UNLIMITED_SAMPLING_DISABLED" }
            );
        this._unlimitedSamplingRequested = enabled;
        this._unlimitedSamplingChanged();
        await this._context.workspaceState.update(UNLIMITED_SAMPLING_STATE_KEY, enabled);
        return this._unlimitedSamplingEnabled();
    }
    unlimitedSamplingConfigurationChanged() {
        this._unlimitedSamplingChanged();
    }
    _unlimitedSamplingChanged() {
        // Only the standalone OpenOCD session honours the flag; debug sessions keep their adaptive budget.
        if (this._liveSession && !this._debugBridge.hasSession) {
            const active = this._activeReadPlan();
            if (active.length) this._applySamplingPlan(this._liveSession, active);
        }
        const state = this._unlimitedSamplingState();
        for (const entry of this._livePanels.values()) entry.post(state);
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
        vscode.window.showWarningMessage(this._t("lw.memoryHistoryLimited"));
    }
    _limitChartHistory(entry, scope, tick) {
        this._discardChartHistoryAppend(entry);
        this._warnChartHistoryLimited();
        const revision = entry.historyRevision || 0;
        const marker = entry._historyLimit;
        if (marker?.scope === scope && marker.revision === revision) return marker.task;
        const task = this._chartHistory.limit
            ? this._chartHistory.limit(scope, tick)
            : this._chartHistory.request("markLimited", [scope, tick]);
        const pending = (this._pendingChartHistoryAppends ||= new Set());
        const tracked = task
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
        const items = buildChartHistoryItems(this._scalarWatchList(entry.watchKey), elfSymbols);
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
            .request("configure", [scope, entry.historyItems])
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
                        this._warnChartHistoryLimited();
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
                                    entry.historyItems || this._scalarWatchList(entry.watchKey)
                                ]);
                                if (!token.active) return;
                                if (entry.historyViewportNames?.length)
                                    await this._chartHistory.request("viewport", [
                                        scope,
                                        entry.historyViewportNames,
                                        { min: 0, max: 1 },
                                        1
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
    // 各消费者对每个变量的观察类型，用于把同一份原始字节按各自类型解码后分别推送。
    _consumerTypes() {
        const build = (key) => {
            const m = new Map();
            for (const item of this._scalarWatchList(key)) {
                if (item?.name)
                    m.set(
                        item.name,
                        Number.isInteger(item.bitSize) || item.enumInfo || item.isPointer ? item : item.type
                    );
            }
            return m;
        };
        const sidebar = build(CACHE_KEYS.sidebarWatchList);
        // 写入列表变量按自身观察类型解码后推送到侧栏；同名变量以查看列表类型优先
        for (const item of this._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || []) {
            if (item?.name && item.type && !sidebar.has(item.name)) {
                const symbols = this.readElfSymbols().symbols;
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
        for (const entry of this._livePanels.values()) graphs.set(entry.watchKey, build(entry.watchKey));
        return { graphs, sidebar };
    }
    _getCachedConsumerTypes() {
        if (!this._consumerTypesCache) this._consumerTypesCache = this._consumerTypes();
        return this._consumerTypesCache;
    }
    _invalidateConsumerTypes() {
        this._consumerTypesCache = null;
    }
    // Runtime-only composites (an expanded pointee has a type graph, not a static layout) belong here
    // too, so a failed read reaches their tree as an error rather than becoming a scalar sample.
    _compositeMap(key) {
        const map = new Map();
        for (const item of this._scalarWatchList(key)) {
            if (item.isComposite && (item.compositeLayout || item.runtimeLayout))
                map.set(item.name, { ...item, layout: item.compositeLayout || null });
        }
        return map;
    }
    _setLiveInterval(intervalMs, frequencyHz) {
        const value = validation.clampInteger(intervalMs, intervalMsFromHz(this._liveFrequencyHz), 5, 10000);
        this._liveFrequencyHz =
            frequencyHz === undefined
                ? value === this._liveIntervalMs
                    ? this._liveFrequencyHz
                    : frequencyHzFromInterval(value)
                : normalizeFrequencyHz(frequencyHz);
        this._liveIntervalMs = value;
        if (this._liveSession) this._liveSession.setIntervalMs(value);
        this._managedDebugServer?.setIntervalMs?.(value);
        this._postLive({ type: "liveFrequency", frequencyHz: this._liveFrequencyHz, intervalMs: value });
        return value;
    }
    async _saveLiveFrequency(frequencyHz) {
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
        this._setLiveInterval(intervalMsFromHz(value), value);
        this._savingFrequency = true;
        try {
            await vscode.workspace
                .getConfiguration("emberprobe")
                .update("sampleFrequencyHz", value, vscode.ConfigurationTarget.Workspace);
        } finally {
            this._savingFrequency = false;
        }
        return value;
    }
    samplingFrequencyConfigurationChanged() {
        if (this._savingFrequency) return;
        const value = configuredFrequencyHz(vscode.workspace.getConfiguration("emberprobe"));
        if (value !== this._liveFrequencyHz) this._setLiveInterval(intervalMsFromHz(value), value);
    }

    _postWebviewBatch(entry, scalarSamples, compositeSamples, t) {
        if (!entry.ready) return;
        if (this._chartHistory) {
            const latest = (old, next) => [
                ...new Map([...(old || []), ...next].map((sample) => [sample.name, sample])).values()
            ];
            entry._pendingScalars = latest(entry._pendingScalars, scalarSamples);
            entry._pendingComposites = latest(entry._pendingComposites, compositeSamples);
            if (!entry._batchTimer)
                entry._batchTimer = setTimeout(() => {
                    entry._batchTimer = null;
                    const scalars = entry._pendingScalars,
                        composites = entry._pendingComposites;
                    entry._pendingScalars = [];
                    entry._pendingComposites = [];
                    const status = this._samplingStatus();
                    if (scalars.length)
                        entry.post({
                            type: "chartValues",
                            samples: scalars,
                            t,
                            actualHz: status.actualHz,
                            bytesPerSecond: status.bytesPerSecond,
                            unlimitedActive: status.unlimitedActive,
                            limitedBy: status.limitedBy
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
            return;
        }
        const interval = this._liveIntervalMs;
        if (interval >= 30 || !this._liveWatchRunning) {
            if (scalarSamples?.length) entry.post({ type: "liveSample", samples: scalarSamples, t });
            if (compositeSamples?.length) entry.post({ type: "liveCompositeSample", samples: compositeSamples, t });
            return;
        }
        entry._pendingScalars = (entry._pendingScalars || []).concat(scalarSamples);
        entry._pendingComposites = (entry._pendingComposites || []).concat(compositeSamples);
        if (!entry._batchTimer) {
            entry._batchTimer = setTimeout(() => {
                entry._batchTimer = null;
                const scalars = entry._pendingScalars;
                const composites = entry._pendingComposites;
                entry._pendingScalars = [];
                entry._pendingComposites = [];
                if (scalars?.length) entry.post({ type: "liveSample", samples: scalars, t: Date.now() });
                if (composites?.length) entry.post({ type: "liveCompositeSample", samples: composites, t: Date.now() });
            }, 25);
        }
    }

    _postSidebarBatch(scalarSamples, compositeSamples, t) {
        if (!this._webviewView?.webview) return;
        if (this._chartHistory && Date.now() - (this._sidebarStatsTime || 0) >= 1000) {
            this._sidebarStatsTime = Date.now();
            const status = this._samplingStatus();
            this._webviewView.webview.postMessage({
                type: "liveStatus",
                ...status,
                frequencyHz: 20,
                actualHz: status.consumers?.sidebarHz ?? status.actualHz
            });
        }
        const interval = this._liveIntervalMs ?? 100;
        if (interval >= 30 || !this._liveWatchRunning) {
            if (scalarSamples?.length)
                this._webviewView.webview.postMessage({ type: "liveSample", samples: scalarSamples, t });
            if (compositeSamples?.length)
                this._webviewView.webview.postMessage({
                    type: "liveCompositeSample",
                    samples: compositeSamples,
                    t
                });
            return;
        }
        this._pendingSidebarScalars = (this._pendingSidebarScalars || []).concat(scalarSamples);
        this._pendingSidebarComposites = (this._pendingSidebarComposites || []).concat(compositeSamples);
        if (!this._sidebarBatchTimer) {
            this._sidebarBatchTimer = setTimeout(() => {
                this._sidebarBatchTimer = null;
                const scalars = this._pendingSidebarScalars;
                const composites = this._pendingSidebarComposites;
                this._pendingSidebarScalars = [];
                this._pendingSidebarComposites = [];
                if (scalars?.length)
                    this._webviewView?.webview.postMessage({ type: "liveSample", samples: scalars, t: Date.now() });
                if (composites?.length)
                    this._webviewView?.webview.postMessage({
                        type: "liveCompositeSample",
                        samples: composites,
                        t: Date.now()
                    });
            }, 25);
        }
    }

    _flushPendingWebviewSamples() {
        if (this._livePanels) {
            for (const entry of this._livePanels.values()) {
                if (entry._batchTimer) {
                    clearTimeout(entry._batchTimer);
                    entry._batchTimer = null;
                }
                if (entry._pendingScalars?.length) {
                    const scalars = entry._pendingScalars;
                    entry._pendingScalars = [];
                    entry.post({
                        type: this._chartHistory ? "chartValues" : "liveSample",
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
        if (this._sidebarBatchTimer) {
            clearTimeout(this._sidebarBatchTimer);
            this._sidebarBatchTimer = null;
        }
        if (this._pendingSidebarScalars?.length) {
            const scalars = this._pendingSidebarScalars;
            this._pendingSidebarScalars = [];
            this._webviewView?.webview.postMessage({ type: "liveSample", samples: scalars, t: Date.now() });
        }
        if (this._pendingSidebarComposites?.length) {
            const composites = this._pendingSidebarComposites;
            this._pendingSidebarComposites = [];
            this._webviewView?.webview.postMessage({
                type: "liveCompositeSample",
                samples: composites,
                t: Date.now()
            });
        }
    }

    _handleRawSamples(samples, t, consumers) {
        const types = this._getCachedConsumerTypes();
        const graphNames = consumers && new Set(consumers.graphNames);
        const sidebarNames = consumers && new Set(consumers.sidebarNames);
        const graphSamples = graphNames ? samples.filter((sample) => graphNames.has(sample.name)) : samples;
        for (const entry of this._livePanels.values()) {
            if (!entry.historySignature) this._configureChartHistory(entry, t);
            const currentSamples =
                entry.historyClearedAt === undefined
                    ? graphSamples
                    : graphSamples.filter((sample) => (sample.t ?? t) > entry.historyClearedAt);
            const decoded = this._liveWatchService.decodeConsumerSamples(
                currentSamples,
                t,
                types.graphs.get(entry.watchKey),
                this._compositeMap(entry.watchKey),
                entry.latestSamples
            );
            if (entry.ready && (decoded.scalarSamples.length || decoded.compositeSamples.length)) {
                this._postWebviewBatch(entry, decoded.scalarSamples, decoded.compositeSamples, t);
            }
            // Keep every panel's decoding and type changes separate in exported history.
            const recorded = entry.historyItems
                ? this._liveWatchService.decodeHistorySamples(
                      currentSamples,
                      t,
                      entry.historyItems,
                      decoded.scalarSamples
                  )
                : decoded.scalarSamples;
            const graphTypes = new Map(
                entry.historyItems
                    ? entry.historyItems.map((item) => [item.name, item.type])
                    : types.graphs.get(entry.watchKey)
            );
            if (recorded.length && this._chartHistory) this._queueChartHistoryAppend(entry, recorded, t);
            this._samplingArchive.append(
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
                this._debugSamplingScope(entry.watchKey)
            );
        }
        const sidebar = this._liveWatchService.decodeConsumerSamples(
            sidebarNames ? samples.filter((sample) => sidebarNames.has(sample.name)) : samples,
            t,
            types.sidebar,
            this._compositeMap(CACHE_KEYS.sidebarWatchList),
            this._latestSidebarSamples
        );
        if (sidebar.scalarSamples.length || sidebar.compositeSamples.length) {
            this._postSidebarBatch(sidebar.scalarSamples, sidebar.compositeSamples, t);
        }
    }

    _setSamplingArchiveBackpressure(paused) {
        this._samplingCoordinator.setBackpressure(paused);
        const session = this._managedDebugServer || this._liveSession;
        if (this._liveSession)
            this._liveSession.setSamplingEnabled(this._samplingCoordinator.allowed(this._samplingIntent));
        if (this._managedDebugServer)
            this._samplingCoordinator.setRuntimeEnabled(
                this._managedDebugServer,
                this._samplingIntent,
                this._debugBridge
            );
        session?.setPauseReason?.(paused ? "archive_backpressure" : null);
        this._samplingCoordinator.setDebugIntent(this._debugBridge, this._samplingIntent);
        if (!paused && this._liveWatchService && this._samplingArchive) {
            const active = this._activeReadPlan ? this._activeReadPlan() : [];
            if (active.length) {
                const t = Date.now();
                this._handleRawSamples(
                    active.map((item) => ({ name: item.name, bytes: null, t })),
                    t
                );
            }
        }
        this._postConsumerStatuses(this._samplingStatus());
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
            await this.startLiveWatch(undefined, params.intervalMs ?? this._liveIntervalMs, "sidebar", false);
        } else if (action === "stop") {
            // Cancel temporary Agent reads as well as persistent sampling; leave debugging active.
            const agentStopped = this.stopAgentReadIfRunning();
            const liveStopped = this.stopLiveWatch({ variablesOnly: true });
            await Promise.all([agentStopped, liveStopped]);
        }
        return {
            ...this._samplingStatus(),
            starting: this._liveStarting,
            intervalMs: this._liveIntervalMs
        };
    }

    _samplingStatus() {
        const status = this._samplingCoordinator.status({
            intent: this._samplingIntent,
            bridge: this._debugBridge,
            standaloneRunning: this._liveWatchRunning,
            managedServer: this._managedDebugServer,
            agentStatus: this._agentSamplingStatus
        });
        if (this._liveConnectionClosing || this._liveExitUnconfirmed) {
            Object.assign(status, {
                running: false,
                canRead: false,
                canWrite: false,
                snapshotReady: false,
                mode: this._liveExitUnconfirmed ? "exit-unconfirmed" : "disconnecting",
                connectionState: this._liveExitUnconfirmed ? "exit-unconfirmed" : "closing"
            });
        }
        const session = this._managedDebugServer || this._liveSession;
        if (session?.options?.settingsIdentity) {
            try {
                this._probeConnectionService.assertCurrent(session);
                status.connection = this._managedDebugGroup
                    ? this._debugBridge.activeSession
                        ? this._sessionWriteConnection(this._debugBridge)
                        : undefined
                    : writeConnectionIdentity(session.options);
            } catch (error) {
                status.canWrite = false;
                status.connectionStale = true;
                status.diagnostic = serializeError(error);
            }
        }
        const stats = typeof session?.stats === "function" ? session.stats() : null;
        status.intervalMs = this._liveIntervalMs;
        status.frequencyHz = this._liveFrequencyHz;
        status.effectiveIntervalMs = stats?.effectiveIntervalMs ?? this._liveIntervalMs;
        status.actualHz = stats?.actualHz ?? 0;
        status.bytesPerSecond = stats?.bytesPerSecond ?? 0;
        status.consumers = stats?.consumers;
        status.sidebarTargetHz = 20;
        status.p95DurationMs = stats?.p95DurationMs ?? 0;
        status.missedDeadlines = stats?.missedDeadlines ?? 0;
        status.unlimited = stats?.unlimited ?? this._unlimitedSamplingEnabled();
        status.unlimitedActive = stats?.unlimitedActive === true;
        // DAP-driven debug sessions have no worker statistics but still ignore unlimited sampling.
        status.unlimitedSuppressedReason =
            stats?.unlimitedSuppressedReason ??
            (this._unlimitedSamplingEnabled() && this._debugBridge?.hasSession ? "debug" : null);
        status.limitedBy = stats?.limitedBy ?? null;
        status.hostHoldMs = stats?.hostHoldMs ?? 0;
        status.pauseReason =
            stats?.pauseReason ?? (this._samplingCoordinator.backpressured ? "archive_backpressure" : null);
        return withWriteAccessStatus(status);
    }

    // Pointer cells name peripheral registers from the bound SVD. Loading is read-only,
    // shares the peripheral service cache and runs once per SVD binding.
    _refreshPointerPeripherals() {
        if (this._pointerPeripheralsRequested || !this._svdPeripheralService || !this._liveWatchService) return;
        this._pointerPeripheralsRequested = true;
        const generation = (this._pointerPeripheralGeneration = (this._pointerPeripheralGeneration || 0) + 1);
        const apply = (model) => {
            if (generation === this._pointerPeripheralGeneration) this._liveWatchService.setPeripheralModel(model);
        };
        Promise.resolve()
            .then(() => this._svdPeripheralService.model())
            .then(apply, () => apply(null));
    }

    async _refreshSamplingPlan() {
        this._refreshPointerPeripherals();
        const active = this._activeReadPlan();
        for (const entry of this._livePanels.values()) this._configureChartHistory(entry);
        if (this._debugBridge.hasSession) {
            // Reordering watch cards keeps the same reads; only a changed set refreshes the snapshot.
            const planKey = active
                .map((item) => `${item.name}:${item.address}:${item.size}`)
                .sort()
                .join("|");
            this._samplingCoordinator.setDebugIntent(this._debugBridge, this._samplingIntent);
            if (
                this._managedDebugServer &&
                this._managedDebugServer.capabilities?.runtimeRead !== false &&
                this._managedDebugSessionId &&
                !this._debugBridge.paused
            ) {
                try {
                    const allowed = this._configureManagedRuntimeWatch();
                    const enabled = this._samplingCoordinator.setRuntimeEnabled(
                        this._managedDebugServer,
                        this._samplingIntent && allowed.length > 0,
                        this._debugBridge
                    );
                    this._postConsumerStatuses({
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
                        intentEnabled: this._samplingIntent,
                        running: this._samplingIntent
                    });
                } catch (error) {
                    this._managedDebugServer.setSamplingEnabled(false);
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
                this._debugReadPlanKey = planKey;
                return;
            }
            if (planKey !== this._debugReadPlanKey) {
                this._debugReadPlanKey = planKey;
                this._debugBridge.refreshSnapshot();
            }
            if (!active.length && this._samplingIntent)
                this._postConsumerStatuses(this._debugBridge.status({ key: "live.needVar" }));
            return;
        }
        if (this._liveSession) {
            if (active.length) this._applySamplingPlan(this._liveSession, active);
            else {
                this.stopLiveWatch({ preserveIntent: true });
                this._postConsumerStatuses({ key: "live.needVar" });
            }
            return;
        }
        if (this._externalDebug?.held) return;
        if (
            this._samplingIntent &&
            active.length &&
            !this._downloadRunning &&
            !this._debugStarting &&
            !this._debugCommandPending
        )
            await this.startLiveWatch(undefined, this._liveIntervalMs, "refresh");
        else if (this._samplingIntent && !active.length) this._postConsumerStatuses({ key: "live.needVar" });
    }
    _pruneSampleMap(map, keys) {
        const names = new Set();
        for (const key of Array.isArray(keys) ? keys : [keys]) {
            for (const i of this._context.workspaceState.get(key) || []) if (i && i.name) names.add(i.name);
        }
        for (const n of map.keys()) if (!names.has(n)) map.delete(n);
    }
    _assertCpuIdle() {
        if (this._cpuLoadService?.run || this._probeCoordinator?.isActive("cpuLoad"))
            throw Object.assign(new Error(this._t("cpu.busy")), {
                code: "PROBE_BUSY",
                activeOperation: "cpuLoad",
                i18nKey: "cpu.busy",
                retryable: true
            });
    }
    _cpuLoadBlocked() {
        let operation = this._probeCoordinator?.firstActive();
        if (this._shutdownPromise) operation = "shutdown";
        else if (
            this._foreignDebugPending ||
            this._debugCommandPending ||
            this._debugBridge?.hasAnySession ||
            isSupportedDebugSession(this._liveDebugSession())
        )
            operation = "debug";
        else if (this._probeDriverSwitching) operation = "driver";
        else if (this._externalDebug?.held) operation = "externalDebug";
        else if (this._samplingIntent || this._liveStartPromise || this._liveStopPromise) operation ||= "liveWatch";
        else if (this._liveSession || this._agentReadSession || this._managedDebugServer) operation ||= "probe";
        return operation ? { code: "PROBE_BUSY", activeOperation: operation, i18nKey: "cpu.probeBusy" } : null;
    }
    _assertCpuAvailable() {
        const blocked = this._cpuLoadBlocked();
        if (blocked) throw Object.assign(new Error(this._t(blocked.i18nKey)), blocked);
    }
    beginForeignDebug() {
        this._assertCpuIdle();
        if (this._foreignDebugPending)
            throw Object.assign(new Error("Debug startup is pending"), { code: "PROBE_BUSY" });
        this._foreignDebugPending = true;
        const generation = (this._foreignDebugGeneration = (this._foreignDebugGeneration || 0) + 1);
        this._foreignDebugTimer = setTimeout(() => this.finishForeignDebug(), 30000);
        this._foreignDebugTimer.unref?.();
        this._postProbeOperationStatus();
        return generation;
    }
    isForeignDebugCurrent(generation) {
        return this._foreignDebugPending && this._foreignDebugGeneration === generation;
    }
    finishForeignDebug() {
        clearTimeout(this._foreignDebugTimer);
        this._foreignDebugTimer = null;
        this._foreignDebugPending = false;
        this._postProbeOperationStatus();
    }
    _postProbeOperationStatus() {
        this._webviewView?.webview.postMessage({
            type: "probeOperationStatus",
            operations: this._probeCoordinator?.snapshot(),
            debugPending: !!(this._debugCommandPending || this._foreignDebugPending)
        });
        this._cpuLoadService?.publish?.();
    }
    async _createCpuRuntime(accept, disconnect, current) {
        const debuggerCfg =
            this._context.workspaceState.get(CACHE_KEYS.debugger) ||
            (await this._probeConnectionService.resolveProbe());
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore) throw new Error(this._t("live.needConfig"));
        const cfg = vscode.workspace.getConfiguration("emberprobe");
        const executable = await this._resolveOpenOcdPath(cfg.get("openocdPath", "openocd"));
        if (!current()) return null;
        if (!executable) throw new Error(this._t("live.notReady"));
        const connection = await this._probeConnectionService.prepare(
            { executable, probe: debuggerCfg, target: mcuCore },
            true
        );
        if (!current()) return null;
        const port = await this._resolveTclPort(cfg);
        if (!current()) return null;
        const { cwd } = this._commandContext();
        const session = new liveWatch.LiveWatchSession(
            vscode,
            {
                executable,
                isolated: true,
                transport: cfg.get("transport", "auto"),
                probe: debuggerCfg,
                target: mcuCore,
                ...connection,
                cwd,
                port
            },
            {
                onCpuLoad: accept,
                onDisconnect: disconnect,
                onConnectionConfirmed: () => {
                    if (current()) void this._probeConnectionService.recordSuccess(session.options);
                }
            }
        );
        return session;
    }
    startLiveWatch(items, intervalMs, consumer = "graph", interactive = ["graph", "sidebar"].includes(consumer)) {
        this._assertCpuIdle();
        if (this._liveStopPromise || this._liveStartPromise)
            return Promise.reject(Object.assign(new Error(this._t("live.starting")), { code: "PROBE_BUSY" }));
        this._resetChartHistoryWarnings();
        const generation = (this._liveStartGeneration = (this._liveStartGeneration || 0) + 1);
        this._liveStartPromise = this._startLiveWatch(items, intervalMs, consumer, interactive, generation).finally(
            () => {
                this._liveStartPromise = null;
                this._postProbeOperationStatus();
            }
        );
        this._postProbeOperationStatus();
        return this._liveStartPromise;
    }
    async _startLiveWatch(items, intervalMs, consumer, interactive, generation) {
        this._assertCpuIdle();
        if (this._externalDebug?.active && this._debugBridge.hasSession) {
            this._samplingIntent = true;
            this._samplingCoordinator.setDebugIntent(this._debugBridge, true);
            this._postConsumerStatuses(this._debugBridge.status());
            return;
        }
        this._externalDebug?.assertPhysicalAvailable();
        if (this._chartHistory) {
            const maxBytes =
                validation.clampInteger(
                    vscode.workspace.getConfiguration("emberprobe").get("chartHistoryMaxMiB", 512),
                    512,
                    64,
                    4096
                ) *
                1024 *
                1024;
            if (maxBytes !== this._chartHistory.options.maxBytes) {
                this._chartHistory.options.maxBytes = maxBytes;
                if (!this._chartHistory.failed) {
                    try {
                        const status = await this._chartHistory.request("setBudget", [maxBytes]);
                        if (status?.limited) this._warnChartHistoryLimited();
                    } catch (error) {
                        if (["CHART_HISTORY_FULL", "CHART_HISTORY_BACKPRESSURE"].includes(error.code))
                            this._warnChartHistoryLimited();
                        else throw error;
                    }
                }
            }
        }
        if (this._chartHistory?.failed) await this._recoverChartHistory();
        if (this._downloadRunning)
            throw Object.assign(new Error(this._t("live.downloadRunning")), { i18nKey: "live.downloadRunning" });
        if (this._chipInfoRunning)
            throw Object.assign(new Error(this._t("live.chipReading")), { i18nKey: "live.chipReading" });
        if (this._agentReadRunning)
            throw Object.assign(new Error(this._t("live.agentReading")), { i18nKey: "live.agentReading" });
        if (this._liveStarting) throw Object.assign(new Error(this._t("live.starting")), { i18nKey: "live.starting" });
        const debuggerCfg =
            this._context.workspaceState.get(CACHE_KEYS.debugger) ||
            (await this._probeConnectionService.resolveProbe());
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore)
            throw Object.assign(new Error(this._t("live.needConfig")), { i18nKey: "live.needConfig" });
        if (this._elfService?.workerPath && this._context.workspaceState.get(CACHE_KEYS.elfPath)) {
            await this._elfService.ready();
            await this._elfRebindPromise;
        }
        if (generation !== this._liveStartGeneration) return;
        {
            this._samplingIntent = true;
            this._samplingCoordinator.setDebugIntent(this._debugBridge, true);
        }
        if (intervalMs !== undefined) this._setLiveInterval(intervalMs);
        const activeItems = this._activeReadPlan();
        if (
            this._debugBridge.hasSession ||
            isSupportedDebugSession(this._liveDebugSession()) ||
            this._debugStarting ||
            this._debugCommandPending
        ) {
            const managedRunning =
                !!this._managedDebugServer &&
                !!this._managedDebugSessionId &&
                this._debugBridge.hasSession &&
                !this._debugBridge.paused;
            if (managedRunning && activeItems.length) {
                this._handleManagedTargetState({
                    state: "continued",
                    epoch: this._debugBridge.stopEpoch,
                    session: this._debugBridge.activeSession
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
                : this._debugBridge.hasSession
                  ? this._debugBridge.status(activeItems.length ? {} : { key: "live.needVar" })
                  : {
                        mode:
                            this._debugStarting || this._debugCommandPending
                                ? "debug-running-waiting"
                                : "debug-session-conflict",
                        key:
                            this._debugStarting || this._debugCommandPending
                                ? "live.debugWaiting"
                                : "live.debugConflict",
                        source: "dap",
                        canRead: false,
                        canWrite: false,
                        snapshotReady: false
                    };
            this._postConsumerStatuses(status);
            return;
        }
        if (!activeItems.length) {
            this._postConsumerStatuses({ key: "live.needVar" });
            return;
        }
        {
            this._liveConsumers.add("graph");
            this._liveConsumers.add("sidebar");
        }
        if (this._liveWatchRunning && this._liveSession) {
            this._applySamplingPlan(this._liveSession, this._activeReadPlan());
            if (intervalMs !== undefined) this._setLiveInterval(intervalMs);
            this._postConsumerStatuses({ key: "sb.sampling" });
            return;
        }
        const cfg = vscode.workspace.getConfiguration("emberprobe");
        const configuredExecutable = cfg.get("openocdPath", "openocd");
        if (generation !== this._liveStartGeneration) return;
        this._assertCpuIdle();
        const startingLease = this._probeCoordinator.acquire("liveStart");
        this._liveStartLease = startingLease;
        let session = null;
        try {
            const executable = await this._resolveOpenOcdPath(configuredExecutable);
            if (startingLease.released || generation !== this._liveStartGeneration) return;
            if (!executable) throw Object.assign(new Error(this._t("live.notReady")), { i18nKey: "live.notReady" });
            const { cwd } = this._commandContext();
            const connection = await this._probeConnectionService.prepare(
                { executable, probe: debuggerCfg, target: mcuCore },
                interactive
            );
            if (startingLease.released || generation !== this._liveStartGeneration) return;
            const port = await this._resolveTclPort(cfg);
            if (startingLease.released || generation !== this._liveStartGeneration) return;
            this._liveExitUnconfirmed = false;
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
                    intervalMs: validation.clampInteger(
                        intervalMs ?? this._liveIntervalMs,
                        this._liveIntervalMs,
                        5,
                        10000
                    )
                },
                {
                    onConnectionConfirmed: () => {
                        if (!startingLease.released && this._liveSession === session)
                            void this._probeConnectionService.recordSuccess(session.options);
                        else if (this._liveWatchRunning && this._liveSession === session)
                            void this._probeConnectionService.recordSuccess(session.options);
                    },
                    onSample: (samples, t, consumers) => {
                        if (
                            this._liveSession === session &&
                            !this._liveConnectionClosing &&
                            !this._liveExitUnconfirmed &&
                            !session.stopped &&
                            !session.connectionFailed
                        )
                            this._handleRawSamples(samples, t, consumers);
                    },
                    onStatus: (msg) => {
                        if (this._liveSession === session && !this._liveConnectionClosing && !this._liveExitUnconfirmed)
                            this._postConsumerStatuses(msg);
                    },
                    onError: (msg) => {
                        if (this._liveSession === session) this._postLive({ type: "liveError", message: msg });
                    },
                    onDisconnect: (err) => {
                        if (this._liveSession !== session) return;
                        const stopped = this.stopLiveWatch({ discardPending: true });
                        const stoppedGeneration = this._liveStartGeneration;
                        void Promise.resolve(stopped)
                            .then(() => {
                                if (this._liveSession || stoppedGeneration !== this._liveStartGeneration) return;
                                this._postConsumerStatuses(
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
            this._liveSession = session;
            if (generation !== this._liveStartGeneration) return;
            this._applySamplingPlan(session, this._activeReadPlan());
            this._liveSession = session;
            await session.start();
            if (this._liveSession !== session || startingLease.released || generation !== this._liveStartGeneration)
                return;
            session.setSamplingEnabled(this._samplingCoordinator.allowed(this._samplingIntent));
            this._liveWatchLease = startingLease.transition("liveWatch");
            this._setLiveInterval(intervalMs ?? this._liveIntervalMs);
            this._postConsumerStatuses({ key: this._samplingIntent ? "sb.sampling" : "sb.stopped" });
        } catch (error) {
            if (session && this._liveSession === session) {
                const closed = await session.stop().catch(() => false);
                if (closed !== false) {
                    this._liveSession = null;
                    if (this._liveWatchRunning) this._liveWatchLease?.release();
                }
            }
            this._liveConsumers.clear();
            this._postConsumerStatuses(
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
            if (!session || this._liveSession !== session) startingLease.release();
        }
    }
    stopLiveWatch(options = {}) {
        this._liveStartGeneration = (this._liveStartGeneration || 0) + 1;
        if (options.discardPending) {
            for (const entry of this._livePanels?.values() || []) {
                entry._pendingScalars = [];
                entry._pendingComposites = [];
            }
            this._pendingSidebarScalars = [];
            this._pendingSidebarComposites = [];
        }
        const historyFlushed = this._flushPendingChartHistorySamples();
        this._flushPendingWebviewSamples();
        const preserveIntent = !!options.preserveIntent;
        this._liveConsumers.clear();
        if (!preserveIntent) {
            this._samplingIntent = false;
            this._debugBridge.setIntent(false);
            this._managedDebugServer?.setSamplingEnabled(false);
        }
        this._liveSession?.setSamplingEnabled?.(false);
        this._liveConnectionClosing = !!(this._liveStartPromise || this._liveSession);
        this._liveExitUnconfirmed = false;
        this._postConsumerStatuses(
            preserveIntent && this._debugBridge.hasSession
                ? this._debugBridge.status()
                : {
                      key: this._liveConnectionClosing
                          ? "live.disconnecting"
                          : preserveIntent
                            ? "live.restoring"
                            : "sb.stopped"
                  }
        );
        if (this._liveStopPromise) return this._liveStopPromise;
        const pending = this._liveStartPromise;
        if (!pending && !this._liveSession) {
            this._liveStartLease?.release();
            this._liveWatchLease?.release();
            return null;
        }
        this._liveStopPromise = (async () => {
            if (pending) await pending.catch(() => {});
            const session = this._liveSession;
            if (session && (await session.stop()) === false)
                throw Object.assign(new Error("OpenOCD exit has not been confirmed"), {
                    code: "PROBE_EXIT_UNCONFIRMED",
                    i18nKey: "cpu.exitUnconfirmed"
                });
            await historyFlushed;
            if (this._liveSession === session) this._liveSession = null;
            this._liveStartLease?.release();
            this._liveWatchLease?.release();
            this._liveConnectionClosing = false;
            this._postConsumerStatuses(
                preserveIntent && this._debugBridge.hasSession
                    ? this._debugBridge.status()
                    : {
                          key: preserveIntent ? "live.restoring" : "sb.stopped",
                          source: "none",
                          connectionState: "disconnected"
                      }
            );
            return true;
        })()
            .catch((error) => {
                this._liveExitUnconfirmed = true;
                this._postConsumerStatuses({ key: "cpu.exitUnconfirmed", diagnostic: serializeError(error) }, true);
                throw error;
            })
            .finally(() => {
                this._liveConnectionClosing = false;
                this._liveStopPromise = null;
                this._postProbeOperationStatus();
            });
        this._liveStopPromise.catch((error) => this._postLive?.({ type: "liveError", ...toUiError(error) }));
        return this._liveStopPromise;
    }
    // 仅在采样进行中时停止；用于调试会话起止等外部事件触发的自动清理
    stopLiveWatchIfRunning() {
        if (this._liveWatchRunning) this.stopLiveWatch({ preserveIntent: true });
    }
    async externalDebugSettingsChanged() {
        await this._externalDebug.releaseIfDisabled();
    }
    async prepareExternalDebug(folder, config) {
        this._assertCpuIdle();
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
            if (this._liveWatchRunning || this._liveSession || this._liveStartPromise || this._liveStopPromise)
                await this.stopLiveWatch({ preserveIntent: true });
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
    async prepareForCortexDebug(folder, config) {
        this._assertCpuIdle();
        this._assertProbeDriverIdle();
        this._debugBridge.setWorkspace(folder || this._commandContext().folder);
        const token = config?.__emberprobeManagedToken;
        if (token && token === this._managedDebugToken && this._managedDebugServer) return;
        if (this._managedDebugServer) {
            throw Object.assign(new Error("The debug probe is owned by an EmberProbe managed debug session"), {
                code: "PROBE_BUSY"
            });
        }
        const agentStopped = this.stopAgentReadIfRunning();
        if (agentStopped) await agentStopped;
        if (this._liveWatchRunning || this._liveSession || this._liveStartPromise || this._liveStopPromise) {
            const stopped = this.stopLiveWatch({ preserveIntent: true });
            if (stopped) await stopped;
            this._postConsumerStatuses({
                mode: "debug-running-waiting",
                key: "live.debugWaiting",
                source: "dap",
                canRead: false,
                canWrite: false,
                snapshotReady: false
            });
        } else if (this._samplingIntent) {
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
        this.finishForeignDebug();
        if (this._terminatedDebugSessionIds.has(session.id)) return;
        this._externalDebug?.bind(session);
        const grouped = this._managedDebugGroup?.bind(session);
        if (this._debugLifecycle.pending && this._matchesManagedDebugSession(session))
            this._debugLifecycle.session = session;
        this._debugReadPlanKey = this._activeReadPlan()
            .map((item) => `${item.name}:${item.address}:${item.size}`)
            .join("|");
        // 多根工作区中会话归属以 VS Code 实际调试目录为准，避免被缓存 ELF 所在目录覆盖。
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
        this._samplingCoordinator?.setDebugIntent(this._debugBridge, this._samplingIntent);
    }
    handleDebugAdapterMessage(session, message) {
        void this._externalDebug?.message(session, message).catch(console.error);
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
            this._samplingIntent = false;
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
        if (!this._samplingIntent) {
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
        if (!this._samplingIntent || this._debugBridge.hasAnySession) return;
        try {
            await this.startLiveWatch(undefined, this._liveIntervalMs, "restore");
        } catch (error) {
            this._postConsumerStatuses({ mode: "restore-failed", ...toUiError(error), source: "none" }, true);
        }
    }
    disposeDebugBridge() {
        this._svdPeripheralService?.dispose();
        this._svdManager?.library?.dispose();
        this._debugBridge.dispose();
    }
    shutdown() {
        this._stopJlinkDriverMonitor();
        this.finishForeignDebug();
        this._memoryAnalysisController?.dispose();
        this._cubemxService.cancel();
        this._elfService.invalidate();
        if (this._shutdownPromise) return this._shutdownPromise;
        this._shutdownPromise = (async () => {
            await this._cpuLoadService?.stop();
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
            const stopped = this.stopLiveWatch();
            if (stopped) await stopped;
            await this._flushPendingChartHistorySamples();
            await this._samplingArchive.dispose();
            await this._chartHistory?.dispose();
            this.disposeDebugBridge();
            const agentStopped = this.stopAgentReadIfRunning();
            if (agentStopped) await agentStopped;
            await this._agentService.dispose().catch(() => {});
        })();
        return this._shutdownPromise;
    }
    stopAgentReadIfRunning() {
        if (!this._agentReadRunning && !this._agentReadSession) return null;
        this._agentReadCancelled = true;
        if (this._agentReadDelayResolve) this._agentReadDelayResolve();
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
    // 推送芯片信息状态与（可选的）结果到侧边栏
    _postChipInfo(status, info) {
        this._chipInfoService.post(status, info);
    }
    // 同步侧边栏：视图重建后回放已缓存的芯片信息与当前状态
    _syncChipInfo(post) {
        this._chipInfoService.sync(post);
    }
    // 通过 OpenOCD 一次性读取芯片基本信息；与下载/实时查看/调试互斥（探针同一时刻只能被一个进程占用）
    async readChipInfoAction(forAgent = false) {
        this._assertCpuIdle();
        return this._chipInfoService.read(forAgent);
    }
    // 将芯片信息读取的原始 OpenOCD 命令与输出写入输出面板，便于诊断（如 ID/UID/Flash 读取异常）
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
        // Device ID 或 UID 缺失时自动展示，便于复制反馈
        if (!info || !info.deviceId || (chipInfo.uidBaseForTarget(diag.target) && !info.uid)) ch.show(true);
    }
    // 实现接口要求的resolveWebviewView方法（无修改）
    resolveWebviewView(webviewView) {
        this._stopJlinkDriverMonitor();
        this._sidebarReady = false;
        this._webviewView = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri, this._webviewAssetRootUri]
        };
        // 监听Webview消息，主进程执行命令（先释放上一次视图的监听器，避免累积）
        this._messageListener?.dispose();
        this._messageListener = webviewView.webview.onDidReceiveMessage(async (message) => {
            if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string")
                return;
            switch (message.type) {
                case "executeCommand": {
                    const cmd = message.cmd;
                    try {
                        console.log("主进程接收命令：", cmd);
                        if (
                            Object.hasOwn(this.commandHandlers, cmd) &&
                            typeof this.commandHandlers[cmd] === "function"
                        ) {
                            const result = await this.commandHandlers[cmd]();
                            if (result === null) {
                                webviewView.webview.postMessage({ type: "commandCancelled", cmd });
                                break;
                            }
                            if (result === false) {
                                if (
                                    !["mcu-vscode.debug", "mcu-vscode.attachDebug"].includes(cmd) ||
                                    !this._debugStartupErrorReported
                                )
                                    webviewView.webview.postMessage({
                                        type: "commandError",
                                        cmd,
                                        error: this._t("sb.commandFailed")
                                    });
                                break;
                            }
                            // 向Webview发送成功消息
                            webviewView.webview.postMessage({
                                type: "commandSuccess",
                                cmd: cmd
                            });
                        } else {
                            throw Object.assign(new Error(this._t("msg.commandNotRegistered", { cmd })), {
                                i18nKey: "msg.commandNotRegistered",
                                i18nParams: { cmd }
                            });
                        }
                    } catch (error) {
                        const errorMsg = error.message || this._t("msg.unknownError");
                        console.error("命令执行失败：", errorMsg);
                        // 向Webview发送失败消息
                        webviewView.webview.postMessage({
                            type: "commandError",
                            cmd: cmd,
                            key: error.i18nKey,
                            params: error.i18nParams,
                            diagnostic: serializeError(error),
                            error: errorMsg
                        });
                    }
                    break;
                }
                case "memoryRefresh":
                    await this._getMemoryAnalysisController().refresh();
                    break;
                case "memorySelectSource":
                    try {
                        await this._getMemoryAnalysisController().selectSource();
                    } catch (error) {
                        webviewView.webview.postMessage({
                            type: "memoryAnalysis",
                            state: "error",
                            key: "memory.failed",
                            message: error.message,
                            code: error.code
                        });
                    }
                    break;
                case "initCheck": {
                    this._getMemoryAnalysisController().refresh();
                    this._sidebarReady = true;
                    // Webview初始化检查，直接返回成功（无需依赖commands接口）
                    webviewView.webview.postMessage({ type: "initSuccess" });
                    if (this._probeDriverSwitching)
                        webviewView.webview.postMessage({ type: "probeDriverSwitch", busy: true });
                    this._startJlinkDriverMonitor();
                    // 回放最近的下载进度，避免视图重建后日志丢失
                    for (const progressMessage of this._recentProgress)
                        webviewView.webview.postMessage(progressMessage);
                    this._syncSidebarTarget((message) => webviewView.webview.postMessage(message));
                    this._syncChipInfo((message) => webviewView.webview.postMessage(message));
                    this._svdManager.syncStatus().catch((error) => console.error("SVD 状态检查失败：", error.message));
                    this._postPeripheralDebugStatus((message) => webviewView.webview.postMessage(message));
                    webviewView.webview.postMessage({ type: "openocdStatus", ...this._openOcdStatusService.status });
                    this.refreshOpenOcdStatus(false);
                    this.refreshSkillStatus().catch((error) =>
                        console.error("Agent Skills 状态检查失败：", error.message)
                    );
                    break;
                }
                case "peripheralCatalogRequest":
                case "peripheralRegistersRequest":
                case "peripheralReadRequest":
                case "peripheralWriteRequest": {
                    await this._handlePeripheralViewRequest(webviewView.webview, message);
                    break;
                }
                case "cpuLoadStart":
                case "cpuLoadStop":
                case "cpuLoadIdle": {
                    try {
                        if (message.type === "cpuLoadStart") await this._cpuLoadService.start();
                        else if (message.type === "cpuLoadStop") await this._cpuLoadService.stop();
                        else await this._cpuLoadService.selectIdle(message.key);
                    } catch (error) {
                        webviewView.webview.postMessage({ ...this._cpuLoadService.status(), error: error.message });
                    }
                    break;
                }
                case "rtosRefresh": {
                    this._rtosViewService ||= new RtosViewService(this._debugBridge);
                    const identity = this._rtosViewService.status();
                    try {
                        webviewView.webview.postMessage(
                            await this._rtosViewService.refresh(message.includeStackUsage !== false)
                        );
                    } catch (error) {
                        webviewView.webview.postMessage({ ...identity, type: "rtosError", message: error.message });
                    }
                    break;
                }
                case "debugSelectSession": {
                    try {
                        this._selectDebugSession({ sessionId: message.sessionId });
                        this._postPeripheralDebugStatus((value) => webviewView.webview.postMessage(value));
                    } catch (error) {
                        webviewView.webview.postMessage({
                            ...this._rtosViewService.status(),
                            type: "rtosError",
                            message: error.message
                        });
                    }
                    break;
                }
                case "selectProbeDriver": {
                    try {
                        await this._changeJlinkDriver(message.driver);
                    } catch (error) {
                        webviewView.webview.postMessage({
                            type: "commandError",
                            diagnostic: serializeError(error),
                            error: error.message || String(error)
                        });
                        this._refreshJlinkDriverChoice(false).catch((refreshError) =>
                            console.error("J-Link USB driver check failed:", refreshError.message)
                        );
                    }
                    break;
                }
                case "openocdAction": {
                    try {
                        await this._handleOpenOcdAction(message.action);
                    } catch (error) {
                        this._postOpenOcdStatus({
                            state: "error",
                            key: error.i18nKey,
                            params: error.i18nParams,
                            message: error.message || String(error)
                        });
                    }
                    break;
                }
                case "refreshVariables": {
                    try {
                        await this._refreshElfBindings();
                    } catch (error) {
                        this._postLive({ type: "liveError", ...toUiError(error) });
                    }
                    break;
                }
                case "expandLayout":
                    await this._handleLayoutExpansion(message, (reply) => webviewView.webview.postMessage(reply));
                    break;
                case "resolveCompositeLayout": {
                    try {
                        const layout = await this._resolveElfLayout(message.name, message.version);
                        webviewView.webview.postMessage({
                            type: "compositeLayoutResult",
                            name: message.name,
                            version: message.version,
                            layout,
                            ...this._layoutExpansionSnapshot(message.name)
                        });
                    } catch (error) {
                        webviewView.webview.postMessage({
                            type: "compositeLayoutResult",
                            name: message.name,
                            version: message.version,
                            error: error.message
                        });
                    }
                    break;
                }
                case "saveSidebarWatch": {
                    const items = Array.isArray(message.items) ? message.items : [];
                    await this._saveWatchList(CACHE_KEYS.sidebarWatchList, items, { syncSidebar: false });
                    break;
                }
                case "saveSidebarWrite": {
                    const items = Array.isArray(message.items) ? message.items : [];
                    await this._saveWatchList(CACHE_KEYS.sidebarWriteList, items, { syncSidebar: false });
                    break;
                }
                case "writeVariable": {
                    const name = String(message.name || "").trim();
                    const seq = message.seq;
                    const requestedAt = Date.now();
                    const ticket = ++this._uiWriteTicket;
                    this._uiWriteLatest.set(name, ticket);
                    // 串行化：同一时刻只有一次写入在途，后续请求排队；失败只回发 writeResult，不弹全局错误。
                    // 拖动滑条时排队中的旧值已被同一变量的新请求取代，直接跳过，避免松手后逐个回放积压的写入。
                    this._uiWritePromise = this._uiWritePromise
                        .catch(() => {})
                        .then(async () => {
                            if (this._uiWriteLatest.get(name) !== ticket) return;
                            try {
                                const result = await this._writeUiVariable(name, message.value, { requestedAt });
                                const r = result.results && result.results[0];
                                webviewView.webview.postMessage({
                                    type: "writeResult",
                                    ok: true,
                                    name,
                                    value: r ? r.readBack : message.value,
                                    valueText: r ? r.readBackText : null,
                                    seq
                                });
                            } catch (error) {
                                webviewView.webview.postMessage({
                                    type: "writeResult",
                                    ok: false,
                                    name,
                                    seq,
                                    key: error.i18nKey,
                                    params: error.i18nParams,
                                    message: error.message || String(error)
                                });
                            } finally {
                                if (this._uiWriteLatest.get(name) === ticket) this._uiWriteLatest.delete(name);
                            }
                        });
                    await this._uiWritePromise;
                    break;
                }
                case "liveToggle": {
                    try {
                        if (this._agentReadRunning) this.stopAgentReadIfRunning();
                        else if (this._samplingIntent) this.stopLiveWatch({ variablesOnly: true });
                        else {
                            const items = this._context.workspaceState.get(CACHE_KEYS.sidebarWatchList) || [];
                            await this.startLiveWatch(items, message.intervalMs, "sidebar");
                        }
                    } catch (error) {
                        this._postConsumerStatuses(
                            { key: error.i18nKey, params: error.i18nParams, message: error.message },
                            true
                        );
                    }
                    break;
                }
                case "readChipInfo": {
                    try {
                        await this.readChipInfoAction();
                    } catch (error) {
                        this._postChipInfo({ state: "error", ...toUiError(error) });
                    }
                    try {
                        await this._svdManager.syncStatus();
                    } catch (error) {
                        webviewView.webview.postMessage({ type: "svdStatus", state: "error", ...toUiError(error) });
                    }
                    break;
                }
                case "chipControl": {
                    try {
                        await this._chipInfoService.control(message.action);
                    } catch (error) {
                        this._postChipInfo({ state: "error", ...toUiError(error) });
                    }
                    break;
                }
                case "cancelSvdDownload": {
                    this._svdManager.cancel();
                    break;
                }
                case "copyText":
                    await this._copyToClipboard(message.text);
                    break;
                case "setLang": {
                    this._setLang(message.lang);
                    this._postLive({ type: "setLang", lang: this._lang });
                    break;
                }
                case "openGitHub": {
                    await vscode.env.openExternal(
                        vscode.Uri.parse("https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug")
                    );
                    break;
                }
            }
        });
        const sidebarWebview = webviewView.webview;
        const visibilityListener = webviewView.onDidChangeVisibility?.(() => {
            if (this._webviewView !== webviewView) return;
            if (!webviewView.visible) {
                this._stopJlinkDriverMonitor();
                return;
            }
            this._startJlinkDriverMonitor();
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
            this.refreshSkillStatus().catch((error) => console.error("Agent Skills 状态检查失败：", error.message));
        });
        webviewView.onDidDispose(() => {
            visibilityListener?.dispose();
            this._webviewRenders?.delete(sidebarWebview);
            if (this._webviewView === webviewView) {
                this._stopJlinkDriverMonitor();
                this._webviewView = null;
                this._sidebarReady = false;
            }
        });
        // 设置初始内容
        this._renderWebview(webviewView.webview, this.getModernWebviewContent(), "sidebar");
        this.updateView().catch(console.error);
        // 仅在配置不完整时执行自动检测，避免每次展开视图都全量扫描工作区
        const configured =
            this._context.workspaceState.get(CACHE_KEYS.elfPath) &&
            this._context.workspaceState.get(CACHE_KEYS.debugger) &&
            this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!configured)
            setTimeout(
                () =>
                    this.runAutoDetect(false).catch((error) => {
                        console.error("自动检测失败：", error.message);
                        this._webviewView?.webview.postMessage({
                            type: "commandError",
                            cmd: "mcu-vscode.autoDetect",
                            key: error.i18nKey,
                            params: error.i18nParams,
                            error: error.message
                        });
                    }),
                0
            );
    }
    // 更新Webview内容（无修改）
    async runAutoDetect(force) {
        if (force) this._assertConnectionEditable({ debugger: true, mcu: true });
        const detectedIoc = force ? await this._cubemxConfiguration.detectIoc() : "";
        const currentElf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        const currentDebugger = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const currentMcu = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        // 只采用当前 OpenOCD 实际提供的脚本；用户选定的 .ioc 单独决定 MCU。
        const scripts = await this._availableOpenOcdScripts();
        const result = await autoDetect.detectWorkspace(vscode, {
            ioc: detectedIoc,
            mcu: currentMcu || "",
            targets: scripts.targets,
            interfaces: scripts.interfaces
        });
        if (!currentDebugger && result.probeCandidates?.length > 1 && force) {
            result.debugger =
                (await vscode.window.showQuickPick(result.probeCandidates, {
                    placeHolder: this._t("msg.selectDetectedProbe")
                })) || "";
        }
        if (!result.mcu && result.mcuCandidates?.length > 1 && force) {
            result.mcu =
                (await vscode.window.showQuickPick(result.mcuCandidates, {
                    placeHolder: this._t("msg.selectDetectedMcu")
                })) || "";
        }
        const writeElf = !!result.elf && (force || !currentElf);
        let writeDebugger = !!result.debugger && (force || !currentDebugger);
        let writeMcu = !!result.mcu && (force || !currentMcu);
        // 先确认可写再落盘任何字段，避免只写入一半配置。自动检测遇到忙碌会话时
        // 静默跳过连接配置，不向用户报告其未发起的操作失败。
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
        if (writeDebugger) await this._refreshJlinkDriverChoice(true);
        const found = [
            detectedIoc && ".ioc: " + path.basename(detectedIoc),
            result.elf && this._t("msg.foundElf", { name: path.basename(result.elf) }),
            result.mcu && this._t("msg.foundMcu", { name: result.mcu }),
            result.debugger && this._t("msg.foundDebugger", { name: result.debugger })
        ].filter(Boolean);
        if (force) {
            const message = found.length
                ? this._t("msg.autoDoneWith", { found: found.join(", ") })
                : this._t("msg.autoNone");
            found.length ? vscode.window.showInformationMessage(message) : vscode.window.showWarningMessage(message);
            if (result.mcuUnavailable)
                vscode.window.showWarningMessage(this._t("msg.autoMcuUnavailable", { name: result.mcuUnavailable }));
            if (!result.elf && result.elfRejected?.length)
                vscode.window.showWarningMessage(
                    this._t("msg.autoElfArchMismatch", { count: result.elfRejected.length })
                );
        }
        return result;
    }
    // 当前 OpenOCD 可用的 target/interface 脚本；OpenOCD 未就绪时返回空列表，不做过滤。
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
    _stopJlinkDriverMonitor() {
        if (this._jlinkDriverMonitor) clearTimeout(this._jlinkDriverMonitor.timer);
        this._jlinkDriverMonitor = null;
        this._jlinkDriverChoiceRevision = (this._jlinkDriverChoiceRevision || 0) + 1;
    }
    _startJlinkDriverMonitor() {
        if (
            process.platform !== "win32" ||
            process.arch !== "x64" ||
            !this._sidebarReady ||
            !this._webviewView ||
            this._webviewView.visible === false ||
            this._shutdownPromise ||
            this._jlinkDriverMonitor
        )
            return;
        const monitor = { timer: null };
        this._jlinkDriverMonitor = monitor;
        const poll = async () => {
            if (this._jlinkDriverMonitor !== monitor) return;
            try {
                if (this._context.workspaceState.get(CACHE_KEYS.debugger) === "jlink.cfg")
                    await this._refreshJlinkDriverChoice(true);
            } catch (error) {
                console.error("J-Link USB driver check failed:", error.message);
            } finally {
                // Wait after each completed read-only scan; slow enumeration must not pile up requests.
                if (this._jlinkDriverMonitor === monitor) {
                    monitor.timer = setTimeout(poll, 3000);
                    monitor.timer.unref();
                }
            }
        };
        void poll();
    }
    async _refreshJlinkDriverChoice(notify = false) {
        if (this._probeDriverSwitching) return null;
        const revision = (this._jlinkDriverChoiceRevision = (this._jlinkDriverChoiceRevision || 0) + 1);
        const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
        if (process.platform !== "win32" || debuggerCfg !== "jlink.cfg") {
            this._webviewView?.webview.postMessage({ type: "probeDriverChoice", driver: "" });
            return null;
        }
        const inventory = await this._probeDriverService.reconcileInventory(await listProbes());
        if (this._probeDriverSwitching || revision !== (this._jlinkDriverChoiceRevision || 0)) return null;
        if (this._context.workspaceState.get(CACHE_KEYS.debugger) !== "jlink.cfg") return null;
        const choice = jlinkDriverChoice(
            inventory,
            vscode.workspace.getConfiguration("emberprobe").get("probeSerial", ""),
            this._context.workspaceState.get("mcu.successfulProbeConnection")
        );
        this._webviewView?.webview.postMessage({ type: "probeDriverChoice", driver: choice?.driver || "" });
        if (choice?.driver !== "segger") this._lastJlinkDriverWarning = "";
        if (notify && choice?.driver === "segger" && this._lastJlinkDriverWarning !== choice.instanceId) {
            this._lastJlinkDriverWarning = choice.instanceId;
            this._showJlinkDriverWarning(choice.instanceId);
        }
        return choice;
    }
    _showJlinkDriverWarning(instanceId) {
        if (
            process.platform !== "win32" ||
            this._context.workspaceState.get(JLINK_DRIVER_WARNING_IGNORED_KEY) === true ||
            this._jlinkDriverWarningPending
        )
            return;
        const switchDriver = this._t("probe.switchToWinUsb");
        const ignore = this._t("probe.ignoreDriverWarning");
        // Do not hold the failed operation's probe lease while waiting for a notification response.
        this._jlinkDriverWarningPending = Promise.resolve(
            vscode.window.showWarningMessage(this._t("probe.winusbRequired"), switchDriver, ignore)
        )
            .then(async (selected) => {
                if (selected === ignore)
                    await this._context.workspaceState.update(JLINK_DRIVER_WARNING_IGNORED_KEY, true);
                else if (selected === switchDriver) {
                    await new Promise((resolve) => setImmediate(resolve));
                    await this._changeJlinkDriver("winusb", instanceId);
                }
            })
            .catch((error) => {
                const message = error.i18nKey ? this._t(error.i18nKey, error.i18nParams) : error.message;
                this._webviewView?.webview.postMessage({
                    type: "commandError",
                    diagnostic: serializeError(error),
                    error: message
                });
                vscode.window.showErrorMessage(message);
            })
            .finally(() => {
                this._jlinkDriverWarningPending = null;
            });
        return this._jlinkDriverWarningPending;
    }
    async _changeJlinkDriver(driver, expectedInstanceId) {
        if (driver !== "winusb" && driver !== "segger")
            throw Object.assign(new Error("Invalid J-Link USB driver choice"), { code: "PROBE_DRIVER_INVALID_CHOICE" });
        this._assertCpuIdle();
        this._assertProbeDriverIdle();
        this._assertConnectionEditable({ probeSerial: true });
        if (this._probeCoordinator?.anyActive())
            throw Object.assign(new Error("Wait for the current probe operation to finish before changing drivers"), {
                code: "PROBE_BUSY"
            });
        this._probeDriverSwitching = true;
        this._jlinkDriverChoiceRevision = (this._jlinkDriverChoiceRevision || 0) + 1;
        this._webviewView?.webview.postMessage({ type: "probeDriverSwitch", busy: true });
        try {
            const inventory = await this._probeDriverService.reconcileInventory(await listProbes());
            const choice = jlinkDriverChoice(
                inventory,
                vscode.workspace.getConfiguration("emberprobe").get("probeSerial", ""),
                this._context.workspaceState.get("mcu.successfulProbeConnection")
            );
            if (!choice)
                throw Object.assign(new Error("No uniquely selected supported J-Link is connected"), {
                    code: "PROBE_DRIVER_SELECTION_REQUIRED"
                });
            if (expectedInstanceId && choice.instanceId !== expectedInstanceId)
                throw Object.assign(new Error("The selected J-Link changed; select its USB driver in the sidebar"), {
                    code: "PROBE_DRIVER_SELECTION_CHANGED",
                    i18nKey: "probe.driverSelectionChanged"
                });
            if (choice.driver === driver) {
                this._webviewView?.webview.postMessage({ type: "probeDriverChoice", driver });
                return;
            }
            const result =
                driver === "winusb"
                    ? await this._probeDriverService.ensure(choice.connection)
                    : await this._probeDriverService.restore(choice.connection);
            const verified = jlinkDriverChoice(
                driver === "winusb" ? result.inventory : result,
                vscode.workspace.getConfiguration("emberprobe").get("probeSerial", ""),
                this._context.workspaceState.get("mcu.successfulProbeConnection")
            );
            if (verified?.driver !== driver || verified.instanceId !== choice.instanceId)
                throw Object.assign(new Error("The selected J-Link driver could not be verified after switching"), {
                    code: "PROBE_DRIVER_VERIFY_FAILED"
                });
            this._resolvedProbeConnection = null;
            this._webviewView?.webview.postMessage({ type: "probeDriverChoice", driver });
            if (driver === "segger") {
                this._lastJlinkDriverWarning = choice.instanceId;
                this._showJlinkDriverWarning(choice.instanceId);
            } else this._lastJlinkDriverWarning = "";
        } finally {
            this._probeDriverSwitching = false;
            this._webviewView?.webview.postMessage({ type: "probeDriverSwitch", busy: false });
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
                showJlinkDriverChoice:
                    process.platform === "win32" &&
                    this._context.workspaceState.get(CACHE_KEYS.debugger) === "jlink.cfg",
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
                if (this._webviewRenders.get(webview) === revision) webview.html = result.html;
            })
            .catch((error) => {
                if (this._webviewRenders.get(webview) === revision) {
                    this._webviewRenders.delete(webview);
                    console.error("Unable to render EmberProbe webview:", error);
                }
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
