"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MainViewProvider = void 0;
const vscode = require("vscode");
const path = require("path");
const modernView = require("./modernView");
const autoDetect = require("./autoDetect");
const skillInstaller = require("./skillInstaller");
const openocdRunner = require("./openocdRunner");
const openocdChecker = require("./openocdChecker");
const liveWatch = require("./liveWatch");
const liveWatchView = require("./liveWatchView");
const elfSymbols = require("./elfSymbols");
const dwarf = require("./dwarf");
const chipInfo = require("./chipInfo");
const faultInfo = require("./faultInfo");
const validation = require("./validation");
const openocdScripts = require("./openocdScripts");
const { AgentBridge } = require("./agentBridge");
const { WriteAuthorization } = require("./writeAuthorization");
const { CubeMxService } = require("./services/cubemxService");
const { CubeMxConfiguration } = require("./services/cubemxConfiguration");
const { CubeMxFirmware } = require("./services/cubemxFirmware");
const { PeripheralWriteAuthorization } = require("./peripheralWriteAuthorization");
const { FlashAuthorization } = require("./flashAuthorization");
const { ProbeCoordinator } = require("./probeCoordinator");
const { ConfigurationStore, assertAgentSettable } = require("./services/configurationStore");
const { FlashService } = require("./services/flashService");
const { AgentFlashService } = require("./services/agentFlashService");
const { FaultService } = require("./services/faultService");
const { AgentService } = require("./services/agentService");
const { ElfService } = require("./services/elfService");
const { OpenOcdStatusService } = require("./services/openocdStatusService");
const { SkillStatusService, hasWorkspaceSkills } = require("./services/skillStatusService");
const { FeedbackPromptService } = require("./services/feedbackPromptService");
const { ChipInfoService } = require("./services/chipInfoService");
const {
    LiveWatchService,
    buildActiveReadPlan,
    nextLivePanelId,
    selectFocusedPanel,
    selectPausedDebugReadSession,
    filterRuntimeRamPlan
} = require("./services/liveWatchService");
const { WatchListStore } = require("./services/watchListStore");
const { SamplingCoordinator } = require("./services/samplingCoordinator");
const { DebugSessionBridge, MIN_DAP_INTERVAL_MS } = require("./services/debugSessionBridge");
const { SvdManager } = require("./services/svdManager");
const { SvdPeripheralService } = require("./services/svdPeripheralService");
const { DebugControlService } = require("./services/debugControlService");
const { SamplingArchive, cleanupStaleSamplingArchives } = require("./services/samplingArchive");
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
// 核心修改1：添加路径清洗工具函数（处理Windows路径问题）
function cleanWindowsPath(rawPath) {
    return validation.cleanWindowsPath(rawPath);
}
// 实现WebviewViewProvider接口的类
class MainViewProvider {
    constructor(context) {
        // 存储命令执行函数（主进程）
        this.commandHandlers = {};
        this._context = context;
        this._webviewAssetRootUri = vscode.Uri.joinPath(context.globalStorageUri, "webview-assets");
        // 语言优先级：用户显式切换过的选择（globalState）> VS Code 显示语言自动匹配（zh-* → 中文，其余 → 英文）
        const savedLang = context.globalState.get("emberprobe.lang");
        this._lang = i18n.SUPPORTED_LANGS.includes(savedLang) ? savedLang : i18n.matchVscodeLang(vscode.env.language);
        this._probeCoordinator = new ProbeCoordinator();
        this._recentProgress = [];
        this._liveSession = null;
        this._managedDebugServer = null;
        this._managedDebugToken = "";
        this._managedDebugSessionId = "";
        this._runtimeResumeTimer = null;
        this._runtimeDeniedKey = "";
        this._runtimeRamCache = null;
        this._livePanels = new Map();
        this._webviewRenders = new WeakMap();
        this._livePanelFocusOrder = 0;
        this._pendingCsvExports = new Map();
        this._csvExportSeq = 0;
        this._liveWatchService = new LiveWatchService(elfSymbols);
        this._latestSidebarSamples = this._liveWatchService.latestSidebarSamples;
        this._samplingIntent = false;
        this._samplingCoordinator = new SamplingCoordinator();
        this._debugCommandPending = false;
        this._debugLifecycle = new DebugLifecycle();
        this._terminatedDebugSessionIds = new Set();
        this._debugReadPlanKey = "";
        this._shutdownPromise = null;
        this._liveIntervalMs = 100;
        this._liveConsumers = new Set();
        this._consumerTypesCache = null;
        this._watchLists = new WatchListStore({
            state: context.workspaceState,
            normalize: (items, symbols, key) => {
                const normalized = validation.normalizeWatchList(items, symbols);
                if (key !== CACHE_KEYS.sidebarWriteList) return normalized;
                const previous = new Map(items.map((item) => [item.name, item]));
                return normalized.map((item) => {
                    const { min, max, value } = previous.get(item.name) || {};
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
        this._debugBridge = new DebugSessionBridge({
            getReadPlan: () => this._activeReadPlan(),
            getIntervalMs: () => Math.max(MIN_DAP_INTERVAL_MS, this._liveIntervalMs),
            onSamples: (samples, t) => this._handleRawSamples(samples, t),
            onStatus: (status) => this._postConsumerStatuses(status, !!status.error),
            onError: (error) =>
                this._postLive({ type: "liveError", key: error.i18nKey, message: error.message || String(error) }),
            onTargetState: (event) => this._handleManagedTargetState(event),
            beforePausedRead: () => this._quiesceManagedRuntimeRead()
        });
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
            onError: (error) => this._postLive({ type: "liveError", message: error.message })
        });
        this._writeAuthorization = new WriteAuthorization(context.workspaceState);
        this._peripheralWriteAuthorization = new PeripheralWriteAuthorization();
        this._flashAuthorization = new FlashAuthorization();
        this._configurationStore = new ConfigurationStore({
            vscode,
            context,
            cacheKeys: CACHE_KEYS,
            cleanPath: cleanWindowsPath,
            isSafeCfg: openocdRunner.isSafeCfg,
            onChanged: async () => {
                await this._refreshElfBindings();
                this.updateView();
                for (const entry of this._livePanels.values()) this._syncGraphTarget(entry);
            }
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
            onStatus: (status) => this._webviewView?.webview.postMessage({ type: "skillStatus", ...status })
        });
        this._feedbackPromptService = new FeedbackPromptService({ vscode, context });
        this._chipInfoService = new ChipInfoService({
            vscode,
            context,
            cacheKeys: CACHE_KEYS,
            chipInfo,
            coordinator: this._probeCoordinator,
            t: (key, params) => this._t(key, params),
            resolveExecutable: (executable) => this._resolveOpenOcdPath(executable),
            commandContext: () => this._commandContext(),
            onPost: (message) => this._webviewView?.webview.postMessage(message),
            onDiagnostics: (diag, info) => this._writeChipDiagnostics(diag, info),
            isDebugActive: () => !!vscode.debug.activeDebugSession
        });
        this._svdManager = new SvdManager({
            vscode,
            context,
            cacheKeys: CACHE_KEYS,
            t: (key, params) => this._t(key, params),
            getChipInfo: () => this._chipInfoService.info,
            onStatus: (status) => this._webviewView?.webview.postMessage({ type: "svdStatus", ...status })
        });
        this._svdPeripheralService = new SvdPeripheralService({
            loadBoundSvd: () => this._svdManager.peekBound(this._commandContext().folder),
            debugBridge: this._debugBridge,
            authorization: this._peripheralWriteAuthorization
        });
        this._debugControlService = new DebugControlService({
            vscode,
            debugBridge: this._debugBridge,
            workspaceProvider: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            startDebug: () => this.commandHandlers["mcu-vscode.debug"]()
        });
        this._agentFlashService = new AgentFlashService({
            coordinator: this._probeCoordinator,
            authorization: this._flashAuthorization,
            isDebugActive: () => this._debugBridge.hasAnySession || !!vscode.debug.activeDebugSession
        });
        this._agentService = new AgentService({
            Bridge: AgentBridge,
            workspaceProvider: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            // Bridge 描述文件（含 token）写入 globalStorage，工作区只留指针，避免令牌随 git/云同步泄露
            storageDirProvider: () => this._context.globalStorageUri.fsPath,
            onCall: () => this._warnIfSkillsModified(),
            handlers: {
                "config.get": () => this._configurationSnapshot(),
                "config.set": (params) => this._setAgentConfiguration(params.values || {}),
                "cubemx.detect": () => this._cubemxConfiguration.detect(),
                "cubemx.inspect": () => this._cubemxService.inspect(),
                "cubemx.prepare": (params) => this._cubemxService.prepare(params || {}),
                "cubemx.candidate": (params) => this._cubemxService.generateCandidate(params || {}),
                "cubemx.execute": (params) =>
                    vscode.window.withProgress(
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
                    ),
                "cubemx.permission": (params) => this._cubemxService.permission(params || {}),
                "cubemx.cancel": () => this._cubemxService.cancel(),
                "flash.authorize": (params) => this._authorizeAgentFlash(params || {}),
                "flash.execute": (params) => this._agentFlashService.execute(params || {}),
                "flash.verify": (params) => this._agentFlashService.execute(params || {}, true),
                "watch.add": (params) => this._addAgentWatch(params),
                "variables.exportCsv": (params) => this._exportAgentCsv(params || {}),
                "variables.read": (params) => this._readAgentVariables(params),
                "variables.sample": (params) => this._sampleAgentVariables(params),
                "variables.write": (params) => this._writeAgentVariables(params),
                "variables.write.permission": (params) => this._agentWritePermission(params),
                "chip.read": () => this.readChipInfoAction(true),
                "fault.read": () => this._readAgentFault(),
                "elf.analyze": (params) => this._analyzeElf(params || {}),
                "peripherals.list": (params) => this._svdPeripheralService.list(params || {}),
                "peripherals.read": (params) => this._svdPeripheralService.read(params || {}),
                "peripherals.write": (params) => this._svdPeripheralService.write(params || {}),
                "debug.status": () => this._debugControlService.status(),
                "debug.start": () => this._debugControlService.start(),
                "debug.control": (params) => this._debugControlService.control(params || {}),
                "debug.breakpoints.list": () => this._debugControlService.listBreakpoints(),
                "debug.breakpoints.update": (params) => this._debugControlService.updateBreakpoints(params || {})
            }
        });
        this.registerCommandHandlers();
    }
    get _downloadRunning() {
        return this._probeCoordinator.isActive("download");
    }
    get _liveWatchRunning() {
        return this._probeCoordinator.isActive("liveWatch");
    }
    get _liveStarting() {
        return this._probeCoordinator.isActive("liveStart");
    }
    get _chipInfoRunning() {
        return this._probeCoordinator.isActive("chipInfo");
    }
    get _agentReadRunning() {
        return this._probeCoordinator.isActive("agentRead");
    }
    get _debugStarting() {
        return this._probeCoordinator.isActive("debugStart");
    }
    get _debugServerRunning() {
        return this._probeCoordinator.isActive("debugServer");
    }
    // 当前界面语言（简体中文/English），由侧边栏或实时面板右上角按钮切换并持久化到全局状态
    _t(key, params) {
        return i18n.t(this._lang, key, params);
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
    _postOpenOcdStatus(status) {
        this._openOcdStatusService.post(status);
    }
    async refreshOpenOcdStatus(showChecking = true) {
        return this._openOcdStatusService.refresh(showChecking);
    }
    async _handleOpenOcdAction(action) {
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
        this.commandHandlers["mcu-vscode.openLiveWatch"] = async () => this.openLiveWatchPanel();
        // 1. 选择 ELF 文件（核心修改2：使用fsPath+路径清洗）
        this.commandHandlers["mcu-vscode.selectElf"] = async () => {
            try {
                console.log("主进程执行选择 ELF 文件命令");
                const elfFiles = await vscode.workspace.findFiles("**/*.elf", "{**/node_modules/**,**/.git/**}", 100);
                if (elfFiles.length === 0) {
                    vscode.window.showWarningMessage(this._t("msg.noElfFound"));
                    return;
                }
                const quickPick = vscode.window.createQuickPick();
                quickPick.items = elfFiles.map((file) => {
                    const cleanPath = cleanWindowsPath(file.fsPath); // 替换file.path为file.fsPath，再清洗
                    return {
                        label: path.basename(cleanPath),
                        description: cleanPath
                    };
                });
                quickPick.placeholder = this._t("msg.searchElf");
                quickPick.canSelectMany = false;
                quickPick.onDidChangeSelection(async (selection) => {
                    if (selection[0]) {
                        const elfPath = selection[0].description;
                        if (elfPath) {
                            const finalPath = cleanWindowsPath(elfPath); // 二次清洗，双重保障
                            await this._context.workspaceState.update(CACHE_KEYS.elfPath, finalPath);
                            await this._refreshElfBindings();
                            vscode.window.showInformationMessage(
                                this._t("msg.elfSelected", { name: path.basename(finalPath) })
                            );
                            this.updateView();
                        }
                        quickPick.dispose();
                    }
                });
                quickPick.onDidHide(() => quickPick.dispose());
                quickPick.show();
            } catch (err) {
                const errorMsg = err.message;
                console.error("选择 ELF 文件失败：", errorMsg);
                vscode.window.showErrorMessage(this._t("msg.selectElfFailed", { error: errorMsg }));
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            }
        };
        // 2. 选择调试器
        this.commandHandlers["mcu-vscode.selectDebugger"] = async () => {
            console.log("主进程执行选择调试器命令");
            const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = await this._resolveOpenOcdPath(configured);
            // 以当前 OpenOCD 实际包含的 interface 脚本为准，支持 WCH 等厂商分支。
            // OpenOCD 尚未就绪时仍允许先完成手动配置，继续使用内置列表。
            const discovered = executable ? openocdScripts.discoverInterfaceConfigs(executable) : [];
            const debuggers = discovered.length ? discovered : DEBUGGER_LIST;
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = debuggers.map((cfg) => ({ label: cfg }));
            quickPick.placeholder = this._t("msg.searchDebugger");
            quickPick.canSelectMany = false;
            quickPick.onDidChangeSelection(async (selection) => {
                if (selection[0]) {
                    const debuggerCfg = selection[0].label;
                    await this._context.workspaceState.update(CACHE_KEYS.debugger, debuggerCfg);
                    vscode.window.showInformationMessage(this._t("msg.debuggerSelected", { name: debuggerCfg }));
                    this.updateView();
                    quickPick.dispose();
                }
            });
            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        };
        // 3. 选择 MCU 核心（无修改）
        this.commandHandlers["mcu-vscode.selectMcuCore"] = async () => {
            console.log("主进程执行选择 MCU 核心命令");
            const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = await this._resolveOpenOcdPath(configured);
            // 展示当前 OpenOCD 实际包含的 target，包括 geehy/* 等厂商子目录。
            // OpenOCD 尚未就绪时仍允许先完成手动配置，继续使用内置列表。
            const discovered = executable ? openocdScripts.discoverTargetConfigs(executable) : [];
            const targets = discovered.length ? discovered : MCU_CORE_LIST;
            const quickPick = vscode.window.createQuickPick();
            quickPick.items = targets.map((cfg) => ({ label: cfg }));
            quickPick.placeholder = this._t("msg.searchMcu");
            quickPick.canSelectMany = false;
            quickPick.onDidChangeSelection(async (selection) => {
                if (selection[0]) {
                    const mcuCore = selection[0].label;
                    await this._context.workspaceState.update(CACHE_KEYS.mcuCore, mcuCore);
                    vscode.window.showInformationMessage(this._t("msg.mcuSelected", { name: mcuCore }));
                    this.updateView();
                    quickPick.dispose();
                }
            });
            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        };
        this.commandHandlers["mcu-vscode.downloadOfficialSvd"] = () => this._svdManager.downloadOfficial();
        this.commandHandlers["mcu-vscode.selectExistingSvd"] = () => this._svdManager.selectExisting();
        this.commandHandlers["mcu-vscode.switchWorkspaceSvd"] = () => this._svdManager.switchBinding();
        // 4. 启动调试（核心修改4：处理TypeScript类型匹配+路径清洗）
        this.commandHandlers["mcu-vscode.debug"] = async (resource) => {
            let probePrepared = false;
            let startAccepted = false;
            try {
                if (this._agentReadRunning) {
                    vscode.window.showWarningMessage(this._t("msg.agentReadBusy"));
                    return false;
                }
                if (this._debugCommandPending || this._debugStarting) {
                    vscode.window.showWarningMessage(this._t("msg.debugBusy"));
                    return false;
                }
                this._debugCommandPending = true;
                console.log("主进程执行启动调试命令");
                let elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
                const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!elfPath || !debuggerCfg || !mcuCore) {
                    vscode.window.showErrorMessage(this._t("msg.configIncomplete"));
                    return false;
                }
                if (!vscode.extensions.getExtension("marus25.cortex-debug")) {
                    vscode.window.showErrorMessage(this._t("msg.needCortexDebug"));
                    return false;
                }
                // 修复类型错误：处理 undefined 情况，用空字符串兜底
                elfPath = cleanWindowsPath(elfPath);
                const { folder: workspaceFolder } = this._commandContext(resource);
                if (!workspaceFolder) {
                    vscode.window.showErrorMessage(this._t("msg.openWorkspaceForDebug"));
                    return false;
                }
                const cortexTools = await ensureDebugTools(
                    vscode,
                    workspaceFolder,
                    this._context.workspaceState,
                    (key) => this._t(key)
                );
                if (!cortexTools) return false;
                // 与下载共用同一个 OpenOCD 路径配置，避免 OpenOCD 不在 PATH 时调试失败
                const configuredOpenOcdPath = vscode.workspace
                    .getConfiguration("emberprobe")
                    .get("openocdPath", "openocd");
                const [resolvedSvdPath, openocdPath] = await Promise.all([
                    this._svdManager.currentPath(workspaceFolder),
                    this._resolveOpenOcdPath(configuredOpenOcdPath)
                ]);
                if (!openocdPath) return false;
                const svdPath = cleanWindowsPath(resolvedSvdPath);
                const launch = openocdScripts.resolveOpenOcdLaunch(openocdPath, debuggerCfg, mcuCore);
                await this.prepareForCortexDebug(workspaceFolder);
                probePrepared = true;
                this._debugStartLease = this._probeCoordinator.acquire("debugStart");
                const managed = await this._startManagedDebugServer(
                    openocdPath,
                    debuggerCfg,
                    mcuCore,
                    vscode.workspace.getConfiguration("emberprobe")
                );
                this._debugServerLease = this._debugStartLease.transition("debugServer");
                this._managedDebugToken = crypto.randomUUID();
                const debugConfig = {
                    type: "cortex-debug",
                    name: this._t("msg.debugConfigName"),
                    request: "launch",
                    cwd: launch.cwd,
                    executable: elfPath,
                    servertype: "external",
                    gdbTarget: managed.gdbTarget,
                    showDevDebugOutput: "none",
                    __emberprobeManagedToken: this._managedDebugToken
                };
                if (svdPath) debugConfig.svdFile = svdPath;
                Object.assign(debugConfig, cortexTools);
                const startupGate = this._armDebugStartupWatchdog();
                const startRequest = Promise.resolve(
                    vscode.debug.startDebugging(workspaceFolder, debugConfig, { suppressDebugView: true })
                ).then(
                    (started) => ({ kind: "result", started }),
                    (error) => ({ kind: "error", error })
                );
                const outcome = await Promise.race([startRequest, startupGate]);
                if (outcome.kind === "error") throw outcome.error;
                if (outcome.kind === "timeout" || outcome.kind === "terminated") return false;
                const started = outcome.kind === "ready" ? true : outcome.started;
                startAccepted = started === true;
                if (!started) {
                    this._clearDebugStartupWatchdog();
                    vscode.window.showErrorMessage(this._t("msg.debugStartFailed"));
                    if (this._debugStarting) this._debugStartLease?.release();
                    await this._stopManagedDebugServer();
                    await this.restoreSamplingAfterDebug();
                    return false;
                }
                return true;
            } catch (err) {
                this._clearDebugStartupWatchdog();
                const errorMsg = err.message;
                console.error("调试启动失败：", errorMsg);
                vscode.window.showErrorMessage(this._t("msg.debugFailed", { error: errorMsg }));
                if (probePrepared) {
                    if (this._debugStarting) this._debugStartLease?.release();
                    await this._stopManagedDebugServer();
                    await this.restoreSamplingAfterDebug();
                }
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            } finally {
                if (this._debugStarting) this._debugStartLease?.release();
                if (!startAccepted) this._clearDebugStartupWatchdog();
                this._debugCommandPending = false;
            }
        };
        // 6. 下载程序（核心修改5：生成命令时清洗路径）
        this.commandHandlers["mcu-vscode.download"] = async (resource) => {
            if (this._downloadRunning) {
                vscode.window.showWarningMessage(this._t("msg.downloadBusy"));
                return false;
            }
            if (
                this._debugStarting ||
                this._debugBridge.hasAnySession ||
                vscode.debug.activeDebugSession?.type === "cortex-debug"
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
            // 先同步释放 liveWatch lease，再立即占用 download lease；真正的进程退出
            // Promise 在占用 lease 后等待，避免快速双击同时越过 _downloadRunning 检查。
            const liveStopped = this._liveWatchRunning || this._liveSession ? this.stopLiveWatch() : null;
            this._downloadLease = this._probeCoordinator.acquire("download");
            this._recentProgress = [];
            try {
                if (liveStopped) await liveStopped;
                const configuredExecutable = vscode.workspace
                    .getConfiguration("emberprobe")
                    .get("openocdPath", "openocd");
                const executable = await this._resolveOpenOcdPath(configuredExecutable);
                if (!executable) return false;
                console.log("主进程执行下载程序命令");
                let elfPath = this._context.workspaceState.get(CACHE_KEYS.elfPath);
                const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!elfPath || !debuggerCfg || !mcuCore) {
                    vscode.window.showErrorMessage(this._t("msg.configIncomplete"));
                    return false;
                }
                const cleanElfPath = cleanWindowsPath(elfPath);
                const { cwd } = this._commandContext(resource);
                await this._flashService.download(
                    vscode,
                    { executable, elf: cleanElfPath, probe: debuggerCfg, target: mcuCore, cwd },
                    (event) => {
                        // 缓冲最近几条进度，视图未打开或刷新时可回放，避免进度静默丢失
                        const message = { type: "openocdProgress", ...event };
                        this._recentProgress.push(message);
                        if (this._recentProgress.length > 6) this._recentProgress.shift();
                        this._webviewView?.webview.postMessage(message);
                    }
                );
                vscode.window.showInformationMessage(this._t("msg.downloadSuccess"));
                return true;
            } catch (err) {
                const errorMsg = err.message;
                console.error("固件下载失败：", errorMsg);
                vscode.window.showErrorMessage(this._t("msg.downloadFailed", { error: errorMsg }));
                throw err; // 上抛给消息分发器，向 Webview 反馈 commandError 而非 commandSuccess
            } finally {
                this._downloadLease?.release();
            }
        };
    }
    async _configurationSnapshot() {
        const snapshot = this._configurationStore.snapshot();
        snapshot.svd = (await this._svdManager.peekBound())?.path || "";
        return snapshot;
    }
    _authorizeAgentFlash(params) {
        const elfPath = fs.realpathSync(path.resolve(String(params.elf || "")));
        const sha256 = crypto.createHash("sha256").update(fs.readFileSync(elfPath)).digest("hex");
        if (sha256 !== String(params.elfSha256 || "")) {
            throw Object.assign(new Error("The ELF changed before flash confirmation"), {
                code: "ELF_CHANGED_DURING_FLASH_CONFIRMATION"
            });
        }
        if (!openocdRunner.isSafeCfg(params.target) || !openocdRunner.isSafeCfg(params.probe)) {
            throw Object.assign(new Error("Invalid OpenOCD target or probe configuration"), {
                code: "OPENOCD_CONFIGURATION_ERROR"
            });
        }
        return this._flashAuthorization.authorize(
            {
                elf: { path: elfPath, sha256 },
                target: params.target,
                probe: params.probe,
                openocd: params.openocd
            },
            params.confirmationId
        );
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
    _exportAgentCsv(params) {
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
        const requestId = `agent-csv-${Date.now()}-${++this._csvExportSeq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingCsvExports.delete(requestId);
                reject(
                    Object.assign(new Error("Timed out while reading chart history"), { code: "CSV_EXPORT_TIMEOUT" })
                );
            }, 10000);
            this._pendingCsvExports.set(requestId, { panelId: entry.panelId, resolve, reject, timer });
            entry.post({ type: "agentExportCsv", requestId, names, from, to });
        });
    }
    _rejectPanelCsvExports(panelId) {
        for (const [requestId, pending] of this._pendingCsvExports) {
            if (pending.panelId !== panelId) continue;
            clearTimeout(pending.timer);
            this._pendingCsvExports.delete(requestId);
            pending.reject(
                Object.assign(new Error("The selected Live Watch panel was closed"), { code: "LIVE_PANEL_NOT_OPEN" })
            );
        }
    }
    async _addAgentWatch(params) {
        const names = Array.isArray(params.variables) ? params.variables.map(String) : [];
        if (!names.length) throw Object.assign(new Error("No variables supplied"), { code: "NO_VARIABLES" });
        const destination = params.destination || "sidebar";
        if (!["sidebar", "chart", "both"].includes(destination))
            throw Object.assign(new Error("destination must be sidebar, chart, or both"), {
                code: "INVALID_DESTINATION"
            });
        this._elfService.invalidate();
        const symbols = this.readElfSymbols().symbols;
        const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]));
        const resolved = [];
        const resolvedNames = new Set();
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
            const symbol = byName.get(baseName);
            if (!symbol)
                throw Object.assign(new Error(`Variable not found in current ELF: ${rawName}`), {
                    code: "VARIABLE_NOT_FOUND"
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
                        name: baseName,
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
                    name: baseName,
                    address: symbol.address,
                    size: symbol.size,
                    type: params.types?.[baseName] || symbol.watchType
                });
            }
        }
        const results = {};
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
    _agentVariablePlan(params) {
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
        this._elfService.invalidate();
        const elfResult = this.readElfSymbols();
        const byName = new Map(elfResult.symbols.map((s) => [s.name, s]));
        const folded = new Map();
        for (const s of elfResult.symbols) {
            const key = String(s.name || "").toLowerCase();
            if (!folded.has(key)) folded.set(key, []);
            folded.get(key).push(s);
        }
        const scalarRequests = [];
        const compositePlan = [];
        for (const req of requests) {
            const parsed = elfSymbols.parseMemberPath(req.name);
            const baseName = parsed ? parsed.base : req.name;
            let symbol = byName.get(baseName);
            if (!symbol) {
                // 与标量解析一致的大小写不敏感回退：唯一匹配时接受，多匹配交由歧义错误
                const matches = folded.get(String(baseName).toLowerCase()) || [];
                if (matches.length === 1) symbol = matches[0];
                else if (matches.length > 1)
                    throw Object.assign(new Error(`Variable name is ambiguous: ${req.name}`), {
                        code: "AMBIGUOUS_VARIABLE"
                    });
            }
            if (!symbol)
                throw Object.assign(new Error(`Variable not found in current ELF: ${req.name}`), {
                    code: "VARIABLE_NOT_FOUND"
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
                    pathSpec: parsed
                });
            } else if (parsed && parsed.segments.length) {
                throw Object.assign(
                    new Error(`${req.name} is not a composite variable; member paths are not applicable`),
                    { code: "INVALID_VARIABLE_PATH" }
                );
            } else {
                scalarRequests.push(req);
            }
        }
        const plan = scalarRequests.length ? elfSymbols.resolveVariableRequests(elfResult.symbols, scalarRequests) : [];
        return { elfResult, plan, compositePlan };
    }
    _decodeAgentSample(plan, samples, compositePlan) {
        const byName = new Map(samples.map((sample) => [sample.name, sample]));
        const timestamp = samples.reduce((latest, sample) => Math.max(latest, sample.t || 0), 0) || Date.now();
        const values = {};
        for (const item of plan) {
            const sample = byName.get(item.name);
            values[item.name] = {
                requestedName: item.requestedName,
                value: sample?.bytes ? elfSymbols.decodeValue(sample.bytes, item.type) : null,
                valueText: sample?.bytes ? elfSymbols.decodeValueText(sample.bytes, item.type) : null,
                type: item.type,
                address: `0x${item.address.toString(16).toUpperCase()}`
            };
        }
        if (compositePlan) {
            for (const comp of compositePlan) {
                const sample = byName.get(comp.name);
                const fullTree = sample?.bytes ? elfSymbols.decodeComposite(sample.bytes, comp.compositeLayout) : null;
                const node = fullTree ? elfSymbols.navigateCompositeTree(fullTree, comp.pathSpec) : null;
                const baseAddr = comp.address >>> 0;
                const addrHex = (off) => `0x${((baseAddr + (off || 0)) >>> 0).toString(16).toUpperCase()}`;
                if (elfSymbols.isScalarLeafNode(node)) {
                    // 路径定位到单个标量成员/元素：以标量形式返回，便于趋势分析与阅读
                    values[comp.requestedName] = {
                        requestedName: comp.requestedName,
                        value: node.value,
                        valueText: node.valueText ?? null,
                        type: node.type,
                        address: addrHex(node.offset)
                    };
                } else {
                    values[comp.requestedName] = {
                        requestedName: comp.requestedName,
                        tree: node,
                        type: "composite",
                        address: addrHex(node && node.offset)
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
        const { elfResult, plan, compositePlan } = this._agentVariablePlan(params);
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
                readItems.push({ name: comp.name, address: comp.address, size: comp.size });
            }
        }

        return this._withAgentProbe(
            async ({ session, source, temporary }) => {
                if (temporary && syncStatus)
                    this._postAgentSampling(true, "live.agentSampling", { current: 0, total: count });
                const result = [];
                const effectiveIntervalMs = source === "debug-running-openocd" ? Math.max(100, intervalMs) : intervalMs;
                for (let index = 0; index < count; index++) {
                    if (temporary && !this._agentReadRunning)
                        throw Object.assign(new Error("Agent sampling was cancelled by the user"), {
                            code: "AGENT_READ_CANCELLED"
                        });
                    result.push(this._decodeAgentSample(plan, await session.readOnce(readItems), compositePlan));
                    if (temporary && syncStatus)
                        this._postAgentSampling(true, "live.agentSampling", { current: index + 1, total: count });
                    if (index + 1 < count) await this._waitAgentInterval(effectiveIntervalMs);
                }
                return { source, elf: elfResult.elf, samples: result };
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
        return port || 6666;
    }
    _runtimeRamPlan(items, strict = false) {
        const elfResult = this.readElfSymbols();
        if (!this._runtimeRamCache || this._runtimeRamCache.sha256 !== elfResult.elf.sha256) {
            const parsed = elfSymbols.parseElfSections(fs.readFileSync(elfResult.elf.path));
            this._runtimeRamCache = { sha256: elfResult.elf.sha256, sections: parsed.sections };
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
        if (!server) return [];
        const plan = this._runtimeRamPlan(this._activeReadPlan());
        server.setWatch(plan.allowed);
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
    async _startManagedDebugServer(executable, probe, target, cfg) {
        let lastError = null;
        const inspect = typeof cfg.inspect === "function" ? cfg.inspect("tclPort") : null;
        const fixedTcl = !!(inspect && (inspect.workspaceValue !== undefined || inspect.globalValue !== undefined));
        for (let attempt = 0; attempt < (fixedTcl ? 1 : 3); attempt++) {
            const tclPort = fixedTcl ? await this._resolveTclPort(cfg) : (await liveWatch.findFreePort()) || 6666;
            let gdbPort = (await liveWatch.findFreePort()) || 3333;
            if (gdbPort === tclPort) gdbPort = (await liveWatch.findFreePort()) || 3334;
            const server = new liveWatch.ManagedOpenOcdSession(
                vscode,
                {
                    executable,
                    probe,
                    target,
                    port: tclPort,
                    gdbPort,
                    mode: "debug",
                    intervalMs: Math.max(100, this._liveIntervalMs)
                },
                {
                    onSample: (samples, t) => this._handleRawSamples(samples, t),
                    onStatus: (status) => {
                        if (status?.key === "live.debugRuntimeSampling" || status?.key === "live.debugTclDegraded") {
                            this._postConsumerStatuses({
                                mode:
                                    status.key === "live.debugRuntimeSampling"
                                        ? "debug-running-sampling"
                                        : "debug-running-degraded",
                                key: status.key,
                                source: "openocd",
                                canRead: status.key === "live.debugRuntimeSampling",
                                canWrite: false,
                                snapshotReady: status.key === "live.debugRuntimeSampling",
                                intentEnabled: this._samplingIntent,
                                running: this._samplingIntent
                            });
                        }
                    },
                    onError: (message) =>
                        this._postLive({ type: "liveError", message: message?.message || String(message) }),
                    onDegraded: (error) =>
                        this._postConsumerStatuses(
                            {
                                mode: "debug-running-degraded",
                                key: "live.debugTclDegraded",
                                source: "openocd",
                                canRead: false,
                                canWrite: false,
                                snapshotReady: false,
                                message: error?.message
                            },
                            true
                        ),
                    onDisconnect: (error) =>
                        this._postConsumerStatuses(
                            {
                                mode: "debug-server-exited",
                                key: error?.i18nKey || "live.serviceExited",
                                source: "none",
                                canRead: false,
                                canWrite: false,
                                snapshotReady: false,
                                message: error?.message
                            },
                            true
                        )
                }
            );
            this._managedDebugServer = server;
            try {
                const info = await server.start();
                return info;
            } catch (error) {
                lastError = error;
                try {
                    await server.stop();
                } catch {
                    /* ignore */
                }
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
        const lease = this._debugServerLease;
        this._managedDebugServer = null;
        this._managedDebugToken = "";
        this._managedDebugSessionId = "";
        this._runtimeDeniedKey = "";
        if (server) {
            server.setSamplingEnabled(false);
            try {
                await server.stop();
            } catch {
                /* ignore */
            }
        }
        lease?.release();
    }
    _armDebugStartupWatchdog() {
        const version = vscode.extensions.getExtension("marus25.cortex-debug")?.packageJSON?.version || "";
        return this._debugLifecycle.arm(debugStartupPolicy(process.platform, version).timeoutMs, () =>
            this._recoverDebugStartupTimeout()
        );
    }
    _matchesManagedDebugSession(session) {
        return !!(
            session &&
            this._managedDebugToken &&
            session.configuration?.__emberprobeManagedToken === this._managedDebugToken
        );
    }
    _clearDebugStartupWatchdog(outcome) {
        this._debugLifecycle.clear(outcome);
    }
    _markDebugStartupReady(session) {
        this._debugLifecycle.ready(session, this._matchesManagedDebugSession(session));
    }
    async _recoverDebugStartupTimeout() {
        if (!this._debugLifecycle.pending) return;
        const session = this._debugLifecycle.session;
        const timeoutMs = this._debugLifecycle.timeoutMs || debugStartupPolicy(process.platform, "").timeoutMs;
        this._clearDebugStartupWatchdog();
        this._debugStartLease?.release();
        this._debugCommandPending = false;
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
        if (session) {
            const managed = !!this._managedDebugSessionId && session.id === this._managedDebugSessionId;
            this._terminatedDebugSessionIds.add(session.id);
            try {
                await Promise.race([
                    Promise.resolve(vscode.debug.stopDebugging(session)).catch(() => false),
                    new Promise((resolve) => setTimeout(() => resolve(false), 2000))
                ]);
            } catch {
                /* The adapter may already have exited. */
            }
            this._debugBridge.detach(session);
            this._debugReadPlanKey = "";
            if (managed || this._managedDebugServer) await this._stopManagedDebugServer();
            await this.restoreSamplingAfterDebug();
        } else {
            await this._stopManagedDebugServer();
            await this.restoreSamplingAfterDebug();
        }
        const version = vscode.extensions.getExtension("marus25.cortex-debug")?.packageJSON?.version || "";
        const key = debugStartupPolicy(process.platform, version).messageKey;
        vscode.window.showErrorMessage(this._t(key, { seconds: timeoutMs / 1000, version }));
    }
    async _quiesceManagedRuntimeRead() {
        const server = this._managedDebugServer;
        if (!server) return;
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
        if (!server) return;
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
                    canWrite: false,
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
            if (session) source = "debug-session";
            else if (
                this._managedDebugServer &&
                this._managedDebugSessionId &&
                this._debugBridge.agentStatus().state === "running"
            ) {
                const managed = this._managedDebugServer;
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
            if (
                this._downloadRunning ||
                this._chipInfoRunning ||
                this._debugStarting ||
                vscode.debug.activeDebugSession
            ) {
                throw Object.assign(new Error("The debug probe is busy with another operation"), {
                    code: "PROBE_BUSY",
                    details: {
                        activeOperation: this._debugStarting || vscode.debug.activeDebugSession ? "debug" : "probe",
                        debugState: this._debugBridge.agentStatus().state
                    }
                });
            }
            operationLease = this._probeCoordinator.acquire("agentRead");
            this._agentReadLease = operationLease;
            this._agentReadCancelled = false;
            try {
                const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
                const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
                if (!debuggerCfg || !mcuCore) {
                    throw Object.assign(new Error(this._t("live.needConfig")), {
                        code: "CONFIG_INCOMPLETE",
                        i18nKey: "live.needConfig"
                    });
                }
                const cfg = vscode.workspace.getConfiguration("emberprobe");
                const executable = await this._resolveOpenOcdPath(cfg.get("openocdPath", "openocd"));
                if (!executable) {
                    throw Object.assign(new Error(this._t("live.notReady")), {
                        code: "OPENOCD_NOT_READY",
                        i18nKey: "live.notReady"
                    });
                }
                if (operationLease.released)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
                const { cwd } = this._commandContext();
                session = new liveWatch.LiveWatchSession(
                    vscode,
                    {
                        executable,
                        probe: debuggerCfg,
                        target: mcuCore,
                        cwd,
                        port: await this._resolveTclPort(cfg),
                        intervalMs: 10000
                    },
                    {}
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
            }
        }

        let completed = false;
        try {
            if (temporary) {
                if (syncStatus) this._postAgentSampling(true, "live.agentStarting", { total });
                await session.start();
                if (operationLease.released || this._agentReadSession !== session)
                    throw Object.assign(new Error("Agent variable read was cancelled"), {
                        code: "AGENT_READ_CANCELLED"
                    });
            }
            const result = await handler({ session, source, temporary });
            completed = true;
            return result;
        } finally {
            if (temporary) {
                try {
                    await session.stop();
                } catch {
                    /* ignore */
                }
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
    async _readAgentVariables(params) {
        const result = await this._runAgentSamples(params, 1, 0, false);
        return { source: result.source, elf: result.elf, ...result.samples[0] };
    }
    async _sampleAgentVariables(params) {
        const count = validation.clampInteger(params.count, 10, 2, 1000);
        const intervalMs = validation.clampInteger(params.intervalMs, 200, 20, 60000);
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
        if (options.refreshSymbols !== false) this._elfService.invalidate();
        const elfResult = this.readElfSymbols();
        const byName = new Map(elfResult.symbols.map((s) => [s.name, s]));
        const SHF_WRITE = 1,
            SHF_ALLOC = 2;
        let writable = [];
        try {
            const parsed = elfSymbols.parseElfSections(fs.readFileSync(elfResult.elf.path));
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
        for (const req of requests) {
            if (!req.name)
                throw Object.assign(new Error("Variable name is required"), { code: "INVALID_VARIABLE_NAME" });
            const parsed = elfSymbols.parseMemberPath(req.name);
            const baseName = parsed ? parsed.base : req.name;
            const symbol = byName.get(baseName);
            let target;
            if (symbol && symbol.isComposite) {
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
                    size: leaves[0].size
                };
            } else {
                const [plan] = elfSymbols.resolveVariableRequests(elfResult.symbols, [{ name: req.name }]);
                const resolvedSymbol = byName.get(plan.name);
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
                target = { name: plan.name, address: plan.address, type: plan.type, size: plan.size };
            }
            if (seen.has(target.name))
                throw Object.assign(new Error(`Variable requested more than once: ${target.name}`), {
                    code: "DUPLICATE_VARIABLE"
                });
            seen.add(target.name);
            const bytes = elfSymbols.encodeValue(req.value, target.type);
            if (!inWritable(target.address, target.size)) {
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
        const { elfResult, items } = plan;
        const transaction = await session.writeAndVerify(
            items.map((i) => ({ name: i.name, address: i.address, bytes: i.bytes }))
        );
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
                verified
            };
        });
        if (results.some((r) => !r.verified)) {
            throw Object.assign(
                new Error(
                    "Write verification failed while the target was halted: the value read back does not match (check RAM accessibility, MPU/cache configuration, and debug transport)"
                ),
                {
                    code: "WRITE_VERIFY_FAILED",
                    retryable: true,
                    details: { results, targetHaltedDuringWrite: true, alignedWordWrites: true }
                }
            );
        }
        return { source, elf: elfResult.elf, results };
    }
    // 高危操作：首次先返回聊天确认请求；一次性确认 ID 与 ELF/地址/类型/值绑定。
    // 用户可选择仅本次授权，或在首次成功写入后记住当前工作区授权。
    async _writeAgentVariables(params) {
        const plan = this._agentWritePlan(params.values);
        const authorization = this._writeAuthorization.authorize(plan, {
            confirmationId: params.confirmationId,
            remember: params.remember
        });
        if (!authorization.authorized) return authorization.response;
        const result = await this._withAgentProbe(({ session, source }) =>
            this._executeWritePlan(session, source, plan)
        );
        let permission = { mode: authorization.mode, trusted: this._writeAuthorization.isTrusted(plan) };
        if (authorization.remember) {
            try {
                permission = {
                    mode: "workspace",
                    ...(await this._writeAuthorization.trustWorkspace(plan)),
                    remembered: true
                };
            } catch (error) {
                permission = { mode: "once", trusted: false, remembered: false, warning: error.message };
            }
        }
        return { ...result, permission };
    }
    // 侧边栏写入列表：用户在 UI 中直接操作，不经过 WriteAuthorization 确认；
    // 保留 _agentWritePlan 的全部安全校验（DWARF 类型已知、目标地址在 .data/.bss 可写段内）。
    // 仅在实时采样运行时允许写入，直接复用采样的 Tcl 会话。
    async _writeUiVariable(name, value) {
        const dapSession = this._debugBridge.canWrite ? this._debugBridge : null;
        const session = dapSession || (this._liveWatchRunning ? this._liveSession : null);
        if (!session) {
            throw Object.assign(new Error(this._t("sb.writeNeedSampling")), { i18nKey: "sb.writeNeedSampling" });
        }
        const plan = this._agentWritePlan([{ name, value }], { refreshSymbols: false });
        if (dapSession)
            this._postConsumerStatuses(
                dapSession.status({ mode: "debug-paused-writing", key: "live.dapWriting", canWrite: false })
            );
        try {
            return await this._executeWritePlan(session, dapSession ? "cortex-debug-dap" : "active-sampling", plan);
        } finally {
            if (dapSession) this._postConsumerStatuses(dapSession.status());
        }
    }
    async _agentWritePermission(params) {
        const action = String(params?.action || "status");
        if (action === "status") {
            try {
                return this._writeAuthorization.status({ elfResult: this.readElfSymbols() });
            } catch {
                return this._writeAuthorization.status();
            }
        }
        if (action === "reset") return this._writeAuthorization.reset();
        throw Object.assign(new Error(`Unsupported write permission action: ${action}`), {
            code: "INVALID_PERMISSION_ACTION"
        });
    }
    // 读取并解码 Cortex-M 故障寄存器；与 chip.read 共用 _chipInfoRunning 互斥（一次性 OpenOCD 进程同一时刻只能有一个）
    async _readAgentFault() {
        const busy = (key, code) => {
            throw Object.assign(new Error(this._t(key)), { i18nKey: key, code });
        };
        if (this._chipInfoRunning) busy("chip.reading", "CHIP_READ_RUNNING");
        if (this._downloadRunning) busy("chip.busyDownload", "PROBE_BUSY");
        if (this._liveWatchRunning) busy("chip.busyLive", "PROBE_BUSY");
        if (this._agentReadRunning) busy("chip.busyAgent", "PROBE_BUSY");
        if (this._debugStarting || vscode.debug.activeDebugSession) busy("chip.busyDebug", "PROBE_BUSY");
        const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore) busy("chip.needConfig", "CONFIG_INCOMPLETE");
        this._chipInfoLease = this._probeCoordinator.acquire("chipInfo");
        try {
            const executable = await this._resolveOpenOcdPath(
                vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd")
            );
            if (!executable) busy("chip.notReady", "OPENOCD_NOT_READY");
            const { cwd } = this._commandContext();
            return await this._faultService.read(
                { executable, probe: debuggerCfg, target: mcuCore, cwd },
                () => this.readElfSymbols().functions || []
            );
        } finally {
            this._chipInfoLease?.release();
        }
    }
    // 纯静态分析当前 ELF 的 Flash/RAM 占用与最大符号，不占探针
    _analyzeElf(params) {
        const elfResult = this.readElfSymbols();
        let buffer;
        try {
            buffer = fs.readFileSync(elfResult.elf.path);
        } catch (e) {
            throw Object.assign(new Error(`Cannot read ELF: ${elfResult.elf.path}`), {
                code: "ELF_READ_FAILED",
                details: { cause: e.message }
            });
        }
        const { sections, programHeaders } = elfSymbols.parseElfSections(buffer);
        const SHF_WRITE = 1,
            SHF_ALLOC = 2,
            SHT_NOBITS = 8,
            PT_LOAD = 1;
        const hex = (v) => `0x${(v >>> 0).toString(16).toUpperCase()}`;
        // 用 PT_LOAD 段把 VMA 映射到 LMA（.data 在 Flash 中的装载副本）
        const lmaFor = (s) => {
            for (const ph of programHeaders) {
                if (ph.type !== PT_LOAD) continue;
                if (s.addr >= ph.vaddr && s.addr + s.size <= ph.vaddr + Math.max(ph.filesz, ph.memsz)) {
                    return (ph.paddr + (s.addr - ph.vaddr)) >>> 0;
                }
            }
            return s.addr;
        };
        const flashSections = [],
            ramSections = [];
        let flashTotal = 0,
            ramTotal = 0;
        for (const s of sections) {
            if (!(s.flags & SHF_ALLOC) || !s.size) continue;
            if (s.type !== SHT_NOBITS) {
                // 有文件内容的装载节占 Flash（按 LMA）：.isr_vector/.text/.rodata/.data 等
                flashSections.push({ name: s.name, address: hex(lmaFor(s)), size: s.size });
                flashTotal += s.size;
            }
            if (s.flags & SHF_WRITE) {
                // 运行期占 RAM 的可写节（按 VMA）：.data/.bss/.noinit 等
                ramSections.push({ name: s.name, address: hex(s.addr), size: s.size });
                ramTotal += s.size;
            }
        }
        const sectionOf = (address) => {
            const hit = sections.find(
                (s) => s.flags & SHF_ALLOC && s.size && address >= s.addr && address < s.addr + s.size
            );
            return hit ? hit.name : "";
        };
        const top = validation.clampInteger(params.top, 20, 1, 100);
        const topSymbols = [
            ...(elfResult.functions || []).map((f) => ({
                name: f.name,
                kind: "function",
                size: f.size,
                address: f.address
            })),
            ...elfResult.symbols.map((s) => ({ name: s.name, kind: "object", size: s.size, address: s.address }))
        ]
            .filter((s) => s.size > 0)
            .sort((a, b) => b.size - a.size)
            .slice(0, top)
            .map((s) => ({
                name: s.name,
                kind: s.kind,
                section: sectionOf(s.address),
                size: s.size,
                address: hex(s.address)
            }));
        return {
            elf: elfResult.elf,
            flash: { total: flashTotal, sections: flashSections },
            ram: { total: ramTotal, sections: ramSections },
            topSymbols,
            warnings: elfResult.warnings || []
        };
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
    async _syncAgentBridgeWithSkills(status) {
        if (hasWorkspaceSkills(status)) {
            return this.startAgentBridge();
        }
        return this.stopAgentBridge();
    }
    _postSkillStatus(status) {
        this._skillStatusService.post(status);
    }
    async refreshSkillStatus(autoUpdate = false) {
        const status = await this._skillStatusService.refresh(autoUpdate);
        await this._syncAgentBridgeWithSkills(status);
        return status;
    }
    // Agent Bridge 收到请求时若发现已安装技能被本地篡改，提示一次：技能脚本以当前用户身份执行，
    // 被篡改的脚本等于借 Agent 之名运行任意代码（不阻断，用户可能是有意自定义）
    _warnIfSkillsModified() {
        this._skillStatusService.warnIfModified();
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
        if (result) await this._syncAgentBridgeWithSkills(result);
        return result;
    }
    // 打开/聚焦实时变量查看面板（独立 WebviewPanel，编辑区宽度足够绘图）
    openLiveWatchPanel() {
        const panelId = nextLivePanelId(this._livePanels);
        const watchKey = panelId === 1 ? CACHE_KEYS.watchList : `${CACHE_KEYS.watchList}.${panelId}`;
        const cfg = vscode.workspace.getConfiguration("emberprobe");
        const panel = vscode.window.createWebviewPanel(
            "emberprobe.liveWatch",
            this._t("lw.panelTitle", { n: panelId }),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._webviewAssetRootUri]
            }
        );
        const post = (m) => panel.webview.postMessage(m);
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
                    maxSamples: cfg.get("maxSamples", 2000),
                    intervalMs: cfg.get("sampleIntervalMs", 100),
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
            this._webviewRenders?.delete(panel.webview);
            this._livePanels.delete(panelId);
            pruneWebviewAssets(this._webviewAssetRootUri.fsPath, `live-watch-${panelId}`, new Set());
            this._rejectPanelCsvExports(panelId);
            this._invalidateConsumerTypes();
            this._refreshSamplingPlan().catch(() => {});
        });
        panel.webview.onDidReceiveMessage(async (message) => {
            try {
                if (message.panelId !== undefined && Number(message.panelId) !== panelId) {
                    throw Object.assign(new Error("Live panel identity mismatch"), { code: "INVALID_PANEL_ID" });
                }
                switch (message.type) {
                    case "ready":
                        entry.ready = true;
                        this._syncGraphTarget(entry);
                        if (this._liveSession) {
                            const active = this._activeReadPlan();
                            if (active.length) this._liveSession.setWatch(active);
                        }
                        break;
                    case "importVariables": {
                        const result = this.readElfSymbols();
                        post({ type: "variablesList", symbols: result.symbols, warnings: result.warnings });
                        break;
                    }
                    case "resolveVariable": {
                        const { symbols } = this.readElfSymbols();
                        const found = symbols.find((s) => s.name === message.name);
                        if (found) post({ type: "addResolved", symbol: found });
                        else post({ type: "liveError", key: "live.varNotFound", params: { name: message.name } });
                        break;
                    }
                    case "saveWatch":
                        await this._saveWatchList(watchKey, message.items || []);
                        break;
                    case "start":
                        await this._saveWatchList(watchKey, message.items || []);
                        await this.startLiveWatch(message.items || [], message.intervalMs, "graph");
                        break;
                    case "stop":
                        if (this._agentReadRunning) this.stopAgentReadIfRunning();
                        else this.stopLiveWatch();
                        break;
                    case "setInterval":
                        this._setLiveInterval(message.intervalMs);
                        break;
                    case "samplingArchiveInfo":
                        post({
                            type: "samplingArchiveInfo",
                            openExport: message.openExport === true,
                            ...this._samplingArchive.status(watchKey)
                        });
                        break;
                    case "exportCsv": {
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
                            const result = await this._samplingArchive.exportCsv({
                                scope: watchKey,
                                outputPath: target.fsPath,
                                names: message.names,
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
                    case "agentExportCsvResult": {
                        const requestId = String(message.requestId || "");
                        const pending = this._pendingCsvExports.get(requestId);
                        if (!pending || pending.panelId !== panelId) {
                            throw Object.assign(new Error("Unknown CSV export request"), {
                                code: "INVALID_CSV_EXPORT_RESPONSE"
                            });
                        }
                        clearTimeout(pending.timer);
                        this._pendingCsvExports.delete(requestId);
                        if (!message.ok) {
                            pending.reject(
                                Object.assign(new Error(message.message || "Unable to export chart history"), {
                                    code: message.code || "CSV_EXPORT_FAILED",
                                    details: message.details
                                })
                            );
                        } else {
                            pending.resolve({
                                panelId,
                                names: Array.isArray(message.names) ? message.names : [],
                                from: message.from,
                                to: message.to,
                                seriesCount: Number(message.seriesCount) || 0,
                                rowCount: Number(message.rowCount) || 0,
                                csv: String(message.csv || "")
                            });
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
                post({ type: "liveError", key: error.i18nKey, params: error.i18nParams, message: error.message });
            }
        });
    }
    // 读取当前 ELF 的全局变量符号，并尽力附带 DWARF 类型信息
    _invalidateElfState() {
        this._elfService.invalidate();
        this._watchLists.invalidate();
        this._runtimeRamCache = null;
        this._latestSidebarSamples.clear();
        for (const entry of this._livePanels.values()) entry.latestSamples.clear();
    }
    async _refreshElfBindings() {
        this._invalidateElfState();
        try {
            if (this._context.workspaceState.get(CACHE_KEYS.elfPath)) {
                const result = this.readElfSymbols();
                await this._rebindWatchLists(result.symbols);
            }
        } finally {
            await this._refreshSamplingPlan();
        }
        this._syncSidebarTarget((message) => this._webviewView?.webview.postMessage(message));
        for (const entry of this._livePanels.values()) {
            this._syncGraphTarget(entry);
            entry.post({ type: "watchList", items: this._scalarWatchList(entry.watchKey), resetValues: true });
        }
        this._webviewView?.webview.postMessage({
            type: "sidebarWatchList",
            items: this._scalarWatchList(CACHE_KEYS.sidebarWatchList),
            resetValues: true
        });
    }
    async _saveWatchList(key, items) {
        await this._watchLists.save(key, items);
        this._pruneSampleMap(this._latestSidebarSamples, [CACHE_KEYS.sidebarWatchList, CACHE_KEYS.sidebarWriteList]);
        for (const entry of this._livePanels.values()) this._pruneSampleMap(entry.latestSamples, entry.watchKey);
        await this._refreshSamplingPlan();
        this._syncSidebarTarget((message) => this._webviewView?.webview.postMessage(message));
        for (const entry of this._livePanels.values()) this._syncGraphTarget(entry);
    }
    readElfSymbols() {
        return this._elfService.read();
    }
    // 图表和侧边栏各自维护选择；同一探针连接采样两边当前启用列表的并集。
    _postLive(message) {
        for (const entry of this._livePanels.values()) entry.post(message);
        this._webviewView?.webview.postMessage(message);
    }
    _postConsumerStatuses(payload, error = false) {
        const p = typeof payload === "string" ? { message: payload } : payload || {};
        const message = { type: "liveStatus", ...this._samplingStatus(), ...p, error };
        if (this._samplingCoordinator.backpressured) {
            message.canRead = false;
            message.canWrite = false;
            message.snapshotReady = false;
        }
        for (const entry of this._livePanels.values()) entry.post(message);
        this._webviewView?.webview.postMessage(message);
    }
    _scalarWatchList(key) {
        return this._watchLists.read(key);
    }
    async _rebindWatchLists(symbols) {
        const entries = Array.from(this._livePanels.values());
        const rebound = await this._watchLists.rebind(
            [
                CACHE_KEYS.sidebarWatchList,
                CACHE_KEYS.sidebarWriteList,
                CACHE_KEYS.watchList,
                ...entries.map((entry) => entry.watchKey)
            ],
            symbols
        );
        this._latestSidebarSamples.clear();
        for (const entry of entries) entry.latestSamples.clear();
        return { entries, rebound };
    }
    _syncGraphTarget(entry) {
        if (!entry || !entry.ready) return;
        const post = entry.post;
        try {
            const result = this.readElfSymbols();
            post({ type: "variablesList", symbols: result.symbols, warnings: result.warnings });
        } catch (error) {
            post({ type: "variablesList", symbols: [], warnings: [error.message] });
        }
        post({ type: "watchList", items: this._scalarWatchList(entry.watchKey) });
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
            if (scalarSamples.length) post({ type: "liveSample", samples: scalarSamples });
            if (compositeSamples.length) post({ type: "liveCompositeSample", samples: compositeSamples });
        }
    }
    _syncSidebarTarget(post) {
        post({ type: "sidebarWatchList", items: this._scalarWatchList(CACHE_KEYS.sidebarWatchList) });
        post({ type: "sidebarWriteList", items: this._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || [] });
        try {
            const result = this.readElfSymbols();
            post({ type: "availableVariables", symbols: result.symbols, warnings: result.warnings });
        } catch (error) {
            post({
                type: "availableVariables",
                symbols: [],
                errorKey: error.i18nKey,
                params: error.i18nParams,
                error: error.message
            });
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
        return buildActiveReadPlan(lists, elfSymbols);
    }
    // 各消费者对每个变量的观察类型，用于把同一份原始字节按各自类型解码后分别推送。
    _consumerTypes() {
        const build = (key) => {
            const m = new Map();
            for (const item of this._scalarWatchList(key)) {
                if (item?.name) m.set(item.name, Number.isInteger(item.bitSize) ? item : item.type);
            }
            return m;
        };
        const sidebar = build(CACHE_KEYS.sidebarWatchList);
        // 写入列表变量按自身观察类型解码后推送到侧栏；同名变量以查看列表类型优先
        for (const item of this._context.workspaceState.get(CACHE_KEYS.sidebarWriteList) || []) {
            if (item?.name && item.type && !sidebar.has(item.name)) {
                sidebar.set(item.name, Number.isInteger(item.bitSize) ? item : item.type);
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
    _compositeMap(key) {
        const map = new Map();
        for (const item of this._scalarWatchList(key)) {
            if (item.isComposite && item.compositeLayout)
                map.set(item.name, { layout: item.compositeLayout, address: item.address });
        }
        return map;
    }
    _setLiveInterval(intervalMs) {
        const value = validation.clampInteger(intervalMs, 100, 20, 10000);
        this._liveIntervalMs = value;
        if (this._liveSession) this._liveSession.setIntervalMs(value);
        this._postLive({ type: "liveInterval", intervalMs: value });
        return value;
    }

    _handleRawSamples(samples, t) {
        const types = this._getCachedConsumerTypes();
        for (const entry of this._livePanels.values()) {
            const decoded = this._liveWatchService.decodeConsumerSamples(
                samples,
                t,
                types.graphs.get(entry.watchKey),
                this._compositeMap(entry.watchKey),
                entry.latestSamples
            );
            if (!entry.ready) continue;
            if (decoded.scalarSamples.length) entry.post({ type: "liveSample", samples: decoded.scalarSamples, t });
            if (decoded.compositeSamples.length)
                entry.post({ type: "liveCompositeSample", samples: decoded.compositeSamples, t });
            // Keep every panel's decoding and type changes separate in exported history.
            const graphTypes = types.graphs.get(entry.watchKey);
            this._samplingArchive.append(
                decoded.scalarSamples.map((sample) => {
                    const spec = graphTypes.get(sample.name);
                    const type = typeof spec === "string" ? spec : spec.type;
                    return { ...sample, name: `${sample.name} [${type}]` };
                }),
                t,
                entry.watchKey
            );
        }
        const sidebar = this._liveWatchService.decodeConsumerSamples(
            samples,
            t,
            types.sidebar,
            this._compositeMap(CACHE_KEYS.sidebarWatchList),
            this._latestSidebarSamples
        );
        if (sidebar.scalarSamples.length)
            this._webviewView?.webview.postMessage({ type: "liveSample", samples: sidebar.scalarSamples, t });
        if (sidebar.compositeSamples.length)
            this._webviewView?.webview.postMessage({
                type: "liveCompositeSample",
                samples: sidebar.compositeSamples,
                t
            });
        this._samplingArchive.append(sidebar.scalarSamples, t);
    }

    _setSamplingArchiveBackpressure(paused) {
        this._samplingCoordinator.setBackpressure(paused);
        if (this._liveSession)
            this._liveSession.setSamplingEnabled(this._samplingCoordinator.allowed(this._samplingIntent));
        if (this._managedDebugServer)
            this._samplingCoordinator.setRuntimeEnabled(
                this._managedDebugServer,
                this._samplingIntent,
                this._debugBridge
            );
        this._samplingCoordinator.setDebugIntent(this._debugBridge, this._samplingIntent);
        this._postConsumerStatuses(this._samplingStatus());
    }

    _samplingStatus() {
        return this._samplingCoordinator.status({
            intent: this._samplingIntent,
            bridge: this._debugBridge,
            standaloneRunning: this._liveWatchRunning,
            managedServer: this._managedDebugServer,
            agentStatus: this._agentSamplingStatus
        });
    }

    async _refreshSamplingPlan() {
        const active = this._activeReadPlan();
        if (this._debugBridge.hasSession) {
            const planKey = active.map((item) => `${item.name}:${item.address}:${item.size}`).join("|");
            this._samplingCoordinator.setDebugIntent(this._debugBridge, this._samplingIntent);
            if (this._managedDebugServer && this._managedDebugSessionId && !this._debugBridge.paused) {
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
                        canWrite: false,
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
            if (active.length) this._liveSession.setWatch(active);
            else {
                this.stopLiveWatch({ preserveIntent: true });
                this._postConsumerStatuses({ key: "live.needVar" });
            }
            return;
        }
        if (this._samplingIntent && active.length && !this._debugStarting && !this._debugCommandPending)
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
    async startLiveWatch(items, intervalMs, consumer = "graph") {
        if (this._downloadRunning)
            throw Object.assign(new Error(this._t("live.downloadRunning")), { i18nKey: "live.downloadRunning" });
        if (this._chipInfoRunning)
            throw Object.assign(new Error(this._t("live.chipReading")), { i18nKey: "live.chipReading" });
        if (this._agentReadRunning)
            throw Object.assign(new Error(this._t("live.agentReading")), { i18nKey: "live.agentReading" });
        if (this._liveStarting) throw Object.assign(new Error(this._t("live.starting")), { i18nKey: "live.starting" });
        const debuggerCfg = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const mcuCore = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!debuggerCfg || !mcuCore)
            throw Object.assign(new Error(this._t("live.needConfig")), { i18nKey: "live.needConfig" });
        this._samplingIntent = true;
        this._samplingCoordinator.setDebugIntent(this._debugBridge, true);
        if (intervalMs !== undefined) this._setLiveInterval(intervalMs);
        const activeItems = this._activeReadPlan();
        if (
            this._debugBridge.hasSession ||
            vscode.debug.activeDebugSession?.type === "cortex-debug" ||
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
        this._liveConsumers.add("graph");
        this._liveConsumers.add("sidebar");
        if (this._liveWatchRunning && this._liveSession) {
            this._liveSession.setWatch(this._activeReadPlan());
            if (intervalMs !== undefined) this._setLiveInterval(intervalMs);
            this._postConsumerStatuses({ key: "sb.sampling" });
            return;
        }
        const cfg = vscode.workspace.getConfiguration("emberprobe");
        const configuredExecutable = cfg.get("openocdPath", "openocd");
        const startingLease = this._probeCoordinator.acquire("liveStart");
        this._liveStartLease = startingLease;
        let session = null;
        try {
            const executable = await this._resolveOpenOcdPath(configuredExecutable);
            if (startingLease.released) return;
            if (!executable) throw Object.assign(new Error(this._t("live.notReady")), { i18nKey: "live.notReady" });
            const { cwd } = this._commandContext();
            session = new liveWatch.LiveWatchSession(
                vscode,
                {
                    executable,
                    probe: debuggerCfg,
                    target: mcuCore,
                    cwd,
                    port: await this._resolveTclPort(cfg),
                    intervalMs: validation.clampInteger(intervalMs || cfg.get("sampleIntervalMs", 100), 100, 20, 10000)
                },
                {
                    onSample: (samples, t) => {
                        if (this._liveSession === session) this._handleRawSamples(samples, t);
                    },
                    onStatus: (msg) => {
                        if (this._liveSession === session) this._postConsumerStatuses(msg);
                    },
                    onError: (msg) => {
                        if (this._liveSession === session) this._postLive({ type: "liveError", message: msg });
                    },
                    onDisconnect: (err) => {
                        if (this._liveSession !== session) return;
                        this._liveSession = null;
                        this._liveWatchLease?.release();
                        this._liveConsumers.clear();
                        this._postConsumerStatuses(
                            {
                                key: err && err.i18nKey,
                                params: err && err.i18nParams,
                                message: (err && err.message) || String(err)
                            },
                            true
                        );
                    }
                }
            );
            if (startingLease.released) return;
            session.setWatch(this._activeReadPlan());
            this._liveSession = session;
            await session.start();
            if (this._liveSession !== session || startingLease.released) {
                await session.stop();
                return;
            }
            session.setSamplingEnabled(this._samplingCoordinator.allowed(this._samplingIntent));
            this._liveWatchLease = startingLease.transition("liveWatch");
            this._setLiveInterval(intervalMs || cfg.get("sampleIntervalMs", 100));
            this._postConsumerStatuses({ key: "sb.sampling" });
        } catch (error) {
            if (session && this._liveSession === session) {
                try {
                    await session.stop();
                } catch (e) {
                    /* ignore */
                }
                this._liveSession = null;
                if (this._liveWatchRunning) this._liveWatchLease?.release();
            }
            this._liveConsumers.clear();
            this._postConsumerStatuses({ key: error.i18nKey, params: error.i18nParams, message: error.message }, true);
            throw error;
        } finally {
            startingLease.release();
        }
    }
    stopLiveWatch(options = {}) {
        const preserveIntent = !!options.preserveIntent;
        let stopped = null;
        this._liveConsumers.clear();
        this._liveStartLease?.release();
        if (this._liveSession) {
            try {
                stopped = this._liveSession.stop();
            } catch (e) {
                /* ignore */
            }
            this._liveSession = null;
        }
        this._liveWatchLease?.release();
        if (!preserveIntent) {
            this._samplingIntent = false;
            this._debugBridge.setIntent(false);
            if (this._managedDebugServer) this._managedDebugServer.setSamplingEnabled(false);
        }
        this._postConsumerStatuses(
            preserveIntent && this._debugBridge.hasSession
                ? this._debugBridge.status()
                : { key: preserveIntent ? "live.restoring" : "sb.stopped" }
        );
        return stopped;
    }
    // 仅在采样进行中时停止；用于调试会话起止等外部事件触发的自动清理
    stopLiveWatchIfRunning() {
        if (this._liveWatchRunning) this.stopLiveWatch({ preserveIntent: true });
    }
    async prepareForCortexDebug(folder, config) {
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
        if (this._liveWatchRunning || this._liveSession) {
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
        if (!session || session.type !== "cortex-debug") return;
        if (this._terminatedDebugSessionIds.has(session.id)) return;
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
            this._managedDebugServer.setSamplingEnabled(false);
        }
        this._debugBridge.attach(session);
        this._samplingCoordinator.setDebugIntent(this._debugBridge, this._samplingIntent);
    }
    handleDebugAdapterMessage(session, message) {
        if (message?.type === "event" && message.event === "initialized") this._markDebugStartupReady(session);
        this._debugBridge.handleMessage(session, message);
    }
    handleDebugAdapterRequest(session, message) {
        this._debugBridge.handleRequest(session, message);
    }
    async handleDebugSessionTerminate(session) {
        if (!session || session.type !== "cortex-debug") return;
        if (this._terminatedDebugSessionIds.has(session.id)) return;
        this._terminatedDebugSessionIds.add(session.id);
        if (
            this._debugLifecycle.pending &&
            (this._debugLifecycle.session?.id === session.id || this._matchesManagedDebugSession(session))
        ) {
            this._clearDebugStartupWatchdog({ kind: "terminated" });
        }
        const managed = !!this._managedDebugSessionId && session.id === this._managedDebugSessionId;
        this._debugBridge.detach(session);
        if (this._debugBridge.hasSession) return;
        this._debugReadPlanKey = "";
        if (managed) await this._stopManagedDebugServer();
        await this.restoreSamplingAfterDebug();
    }
    handleDebugAdapterExit(session) {
        if (!session || session.type !== "cortex-debug") return;
        const managedStartup =
            this._debugLifecycle.pending &&
            (this._debugLifecycle.session?.id === session.id || this._matchesManagedDebugSession(session));
        if (!managedStartup && !this._debugBridge.hasAnySession) return;
        return this.handleDebugSessionTerminate(session);
    }
    async restoreSamplingAfterDebug() {
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
            this._postConsumerStatuses(
                { mode: "restore-failed", key: error.i18nKey, message: error.message, source: "none" },
                true
            );
        }
    }
    disposeDebugBridge() {
        this._debugBridge.dispose();
    }
    shutdown() {
        this._cubemxService.cancel();
        if (this._shutdownPromise) return this._shutdownPromise;
        this._shutdownPromise = (async () => {
            this._clearDebugStartupWatchdog();
            const managedSession = this._debugBridge.activeSession;
            if (managedSession && managedSession.id === this._managedDebugSessionId) {
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
            await this._samplingArchive.dispose();
            this.disposeDebugBridge();
            const agentStopped = this.stopAgentReadIfRunning();
            if (agentStopped) await agentStopped;
            await this.stopAgentBridge().catch(() => {});
        })();
        return this._shutdownPromise;
    }
    stopAgentReadIfRunning() {
        if (!this._agentReadRunning && !this._agentReadSession) return null;
        this._agentReadCancelled = true;
        this._agentReadLease?.release();
        if (this._agentReadDelayResolve) this._agentReadDelayResolve();
        let stopped = null;
        if (this._agentReadSession) {
            try {
                stopped = this._agentReadSession.stop();
            } catch {
                /* ignore */
            }
            this._agentReadSession = null;
        }
        this._postAgentSampling(false, "live.agentStopped");
        return stopped;
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
        if (!info || !info.deviceId || !info.uid) ch.show(true);
    }
    // 实现接口要求的resolveWebviewView方法（无修改）
    resolveWebviewView(webviewView) {
        this._sidebarReady = false;
        this._webviewView = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri, this._webviewAssetRootUri]
        };
        // 监听Webview消息，主进程执行命令（先释放上一次视图的监听器，避免累积）
        this._messageListener?.dispose();
        this._messageListener = webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case "executeCommand": {
                    const cmd = message.cmd;
                    try {
                        console.log("主进程接收命令：", cmd);
                        if (this.commandHandlers[cmd]) {
                            const result = await this.commandHandlers[cmd]();
                            if (result === false) break;
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
                            error: errorMsg
                        });
                    }
                    break;
                }
                case "initCheck": {
                    this._sidebarReady = true;
                    // Webview初始化检查，直接返回成功（无需依赖commands接口）
                    webviewView.webview.postMessage({ type: "initSuccess" });
                    // 回放最近的下载进度，避免视图重建后日志丢失
                    for (const progressMessage of this._recentProgress)
                        webviewView.webview.postMessage(progressMessage);
                    this._syncSidebarTarget((message) => webviewView.webview.postMessage(message));
                    this._syncChipInfo((message) => webviewView.webview.postMessage(message));
                    this._svdManager.syncStatus().catch((error) => console.error("SVD 状态检查失败：", error.message));
                    webviewView.webview.postMessage({ type: "openocdStatus", ...this._openOcdStatusService.status });
                    this.refreshOpenOcdStatus(false);
                    this.refreshSkillStatus().catch((error) =>
                        console.error("Agent Skills 状态检查失败：", error.message)
                    );
                    // 反馈提示（star/issue）由 host 统一决策：同一时刻最多推送一条
                    const feedbackPrompt = this._feedbackPromptService.resolve();
                    if (feedbackPrompt.kind) {
                        webviewView.webview.postMessage({ type: "feedbackPrompt", kind: feedbackPrompt.kind });
                        this._feedbackPromptService
                            .markShown(feedbackPrompt.kind)
                            .catch((error) => console.error("反馈提示状态保存失败：", error.message || error));
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
                        this._postLive({ type: "liveError", key: error.i18nKey, message: error.message });
                    }
                    break;
                }
                case "saveSidebarWatch": {
                    const items = Array.isArray(message.items) ? message.items : [];
                    await this._saveWatchList(CACHE_KEYS.sidebarWatchList, items);
                    break;
                }
                case "saveSidebarWrite": {
                    const items = Array.isArray(message.items) ? message.items : [];
                    await this._saveWatchList(CACHE_KEYS.sidebarWriteList, items);
                    break;
                }
                case "writeVariable": {
                    const name = String(message.name || "").trim();
                    const seq = message.seq;
                    // 串行化：同一时刻只有一次写入在途，后续请求排队；失败只回发 writeResult，不弹全局错误
                    this._uiWritePromise = this._uiWritePromise
                        .catch(() => {})
                        .then(async () => {
                            try {
                                const result = await this._writeUiVariable(name, message.value);
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
                            }
                        });
                    await this._uiWritePromise;
                    break;
                }
                case "liveToggle": {
                    try {
                        if (this._agentReadRunning) this.stopAgentReadIfRunning();
                        else if (this._samplingIntent) this.stopLiveWatch();
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
                    await this.readChipInfoAction();
                    await this._svdManager.syncStatus();
                    break;
                }
                case "cancelSvdDownload": {
                    this._svdManager.cancel();
                    break;
                }
                case "copyText": {
                    const value = message.text ? String(message.text) : "";
                    if (value) {
                        try {
                            await vscode.env.clipboard.writeText(value);
                            vscode.window.showInformationMessage(this._t("common.copied"));
                        } catch (e) {
                            /* ignore clipboard errors */
                        }
                    }
                    break;
                }
                case "setLang": {
                    this._setLang(message.lang);
                    this._postLive({ type: "setLang", lang: this._lang });
                    break;
                }
                case "feedbackPromptAction": {
                    // kind/action 白名单校验在服务内完成，非法值静默忽略；URL 只取服务内常量
                    if (message.action === "open")
                        this._feedbackPromptService
                            .open(message.kind)
                            .catch((error) => console.error("打开 GitHub 失败：", error.message || error));
                    else if (message.action === "dismiss")
                        this._feedbackPromptService
                            .snooze(message.kind)
                            .catch((error) => console.error("反馈提示状态保存失败：", error.message || error));
                    break;
                }
            }
        });
        webviewView.onDidDispose(() => this._webviewRenders?.delete(webviewView.webview));
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
        const detectedIoc = force ? await this._cubemxConfiguration.detectIoc() : "";
        const result = await autoDetect.detectWorkspace(vscode);
        const currentElf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        const currentDebugger = this._context.workspaceState.get(CACHE_KEYS.debugger);
        const currentMcu = this._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (result.elf && (force || !currentElf))
            await this._context.workspaceState.update(CACHE_KEYS.elfPath, cleanWindowsPath(result.elf));
        if (result.debugger && (force || !currentDebugger))
            await this._context.workspaceState.update(CACHE_KEYS.debugger, result.debugger);
        if (result.mcu && (force || !currentMcu))
            await this._context.workspaceState.update(CACHE_KEYS.mcuCore, result.mcu);
        if (result.elf && (force || !currentElf)) {
            await this._refreshElfBindings();
        }
        this.updateView();
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
        }
        return result;
    }
    getModernWebviewContent() {
        const elf = this._context.workspaceState.get(CACHE_KEYS.elfPath);
        return modernView.getModernWebviewContent(
            {
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
        const revision = {};
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
                if (this._webviewRenders.get(webview) === revision)
                    console.error("Unable to render EmberProbe webview:", error);
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
