"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const skillInstaller = require("./skillInstaller");
const openocdRunner = require("./openocdRunner");
const openocdChecker = require("./openocdChecker");
const elfSymbols = require("./elfSymbols");
const dwarf = require("./dwarf");
const chipInfo = require("./chipInfo");
const faultInfo = require("./faultInfo");
const validation = require("./validation");
const { AgentBridge } = require("./agentBridge");
const { WriteAuthorization } = require("./writeAuthorization");
const { PeripheralWriteAuthorization } = require("./peripheralWriteAuthorization");
const { FlashAuthorization } = require("./flashAuthorization");
const { ProbeCoordinator } = require("./probeCoordinator");
const { CACHE_KEYS } = require("./cacheKeys");
const { ExternalDebugService } = require("./services/externalDebugService");
const { CubeMxService } = require("./services/cubemxService");
const { CubeMxConfiguration } = require("./services/cubemxConfiguration");
const { CubeMxFirmware } = require("./services/cubemxFirmware");
const { ConfigurationStore } = require("./services/configurationStore");
const { FlashService } = require("./services/flashService");
const { FirmwareRecord } = require("./services/firmwareRecord");
const { AgentFlashService } = require("./services/agentFlashService");
const { FaultService } = require("./services/faultService");
const { AgentService } = require("./services/agentService");
const { createAgentRoutes } = require("./services/agentRoutes");
const { ElfService } = require("./services/elfService");
const { OpenOcdStatusService } = require("./services/openocdStatusService");
const { SkillStatusService } = require("./services/skillStatusService");
const { BridgeRegistry, cleanupStaleEntries } = require("./services/bridgeRegistry");
const { McpRegistration } = require("./services/mcpRegistration");
const { ChipInfoService } = require("./services/chipInfoService");
const { ProbeConnectionService } = require("./services/probeConnectionService");
const { ProbeDriverService } = require("./services/probeDriverService");
const { waitForJlinkReady } = require("./services/jlinkProbeReady");
const { toUiError } = require("./services/errorEnvelope");
const { LiveWatchService, writableRamSectionRanges } = require("./services/liveWatchService");
const { RuntimeSampleHold } = require("./services/runtimeSampleHold");
const { PointerSymbolizer } = require("./services/pointerSymbolizer");
const { WatchListStore } = require("./services/watchListStore");
const { SamplingCoordinator } = require("./services/samplingCoordinator");
const { DebugSessionBridge, MIN_DAP_INTERVAL_MS } = require("./services/debugSessionBridge");
const { SvdManager } = require("./services/svdManager");
const { SvdPeripheralService } = require("./services/svdPeripheralService");
const { PeripheralViewService } = require("./services/peripheralViewService");
const { RtosViewService } = require("./services/rtosViewService");
const { DebugControlService } = require("./services/debugControlService");
const { SamplingArchive, cleanupStaleSamplingArchives } = require("./services/samplingArchive");
const { ChartHistoryService } = require("./services/chartHistoryService");

// Probe ownership, the external GDB server hold, J-Link driver and connection resolution, and chip reads.
function createProbeServices(host, context, vscode) {
    const probeCoordinator = new ProbeCoordinator(() => host._postProbeOperationStatus());
    const externalDebug = new ExternalDebugService({
        state: context.workspaceState,
        coordinator: probeCoordinator,
        settings: (folder) => vscode.workspace.getConfiguration("emberprobe", vscode.Uri.file(folder))
    });
    void externalDebug.releaseIfDisabled().catch(console.error);
    const probeDriverService = new ProbeDriverService({
        extensionPath: context.extensionPath,
        verifyReady: async (connection) => {
            const configured = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = await host._resolveOpenOcdPath(configured);
            if (!executable)
                throw Object.assign(new Error("OpenOCD is required to verify that J-Link is ready"), {
                    i18nKey: "notice.openocdRequired"
                });
            await waitForJlinkReady(executable, connection.probeSerial);
        },
        onStatus: (status) => {
            host._webviewView?.webview.postMessage({ type: "probeDriverStatus", ...status });
            host._connectedProbes.notifyDriverStatus(status);
        },
        log: (message) => {
            console.log(message);
            if (host._chipOutput) host._chipOutput.appendLine(message);
        }
    });
    const probeConnectionService = new ProbeConnectionService({
        getConfig: () => host._configurationStore.snapshot(),
        getSuccessfulConnection: () => host._connectedProbes.selection().get(),
        saveSuccessfulConnection: (value) =>
            value === undefined
                ? host._connectedProbes.selection().clear()
                : host._connectedProbes.selection().set(value),
        onResolved: (connection) => {
            host._resolvedProbeConnection = connection;
            host.updateView();
        },
        driverService: probeDriverService,
        identifyTarget: (request) => host._probeConnectionService.readTargetIdentity(request),
        onTargetStateChanged: () =>
            host._connectedProbes
                .refresh()
                .catch((error) => console.error("Probe list refresh failed:", error.message)),
        onDriverUnsupported: (error) => host._connectedProbes.showDriverWarning(error.details || {}),
        beforePrepare: () => host._connectedProbes.assertDriverIdle(),
        onSelectionRequired: () => host._connectedProbes.reveal()
    });
    const chipInfoService = new ChipInfoService({
        vscode,
        context,
        cacheKeys: CACHE_KEYS,
        chipInfo,
        coordinator: probeCoordinator,
        t: (key, params) => host._t(key, params),
        resolveExecutable: (executable) => host._resolveOpenOcdPath(executable),
        prepareConnection: (options, interactive) => host._probeConnectionService.prepare(options, interactive),
        resolveProbe: () => host._probeConnectionService.resolveProbe(),
        recordSuccess: (connection) => host._probeConnectionService.recordSuccess(connection),
        commandContext: () => host._commandContext(),
        onPost: (message) => host._webviewView?.webview.postMessage(message),
        onDiagnostics: (diag, info) => host._writeChipDiagnostics(diag, info),
        isDebugActive: () => !!host.debugLaunch.liveSession()
    });
    return { probeCoordinator, externalDebug, probeDriverService, probeConnectionService, chipInfoService };
}

// Watch lists, sample decoding, the debug-session sampling bridge, the sampling archive and the chart history.
function createSamplingServices(host, context, vscode) {
    const liveWatchService = new LiveWatchService(
        elfSymbols,
        // Pointer offsets into structs resolve to member paths once the target layout is loaded.
        new PointerSymbolizer(null, { requestLayout: (name) => host._elfService?.layout(name) })
    );
    const watchLists = new WatchListStore({
        state: context.workspaceState,
        serialize: (items) => host._watchIdentities(items),
        normalize: (items, symbols, key) => {
            // Current name -> persisted name, for items whose CU-qualified identity changed.
            const renamed = new Map();
            const changes = host._elfView.watchNameChanges;
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
        symbols: () => host.readElfSymbols().symbols,
        onChanged: () => host._sampling.invalidateConsumerTypes(),
        onError: (error) => console.error("Watch list unavailable:", error.message)
    });
    const debugBridge = new DebugSessionBridge({
        getReadPlan: () => host._sampling.activeReadPlan(),
        getRamSectionRanges: () => writableRamSectionRanges(host.readElfSymbols().memory?.sections),
        getIntervalMs: () => Math.max(MIN_DAP_INTERVAL_MS, host._sampling.intervalMs),
        onSamples: (samples, t) => host._sampling.handleRawSamples(samples, t),
        onStatus: (status) => {
            host._syncDebugSampleContext();
            host._postProbeOperationStatus();
            host._postConsumerStatuses(status, !!status.error);
            host._postPeripheralDebugStatus();
        },
        onError: (error) => host._postLive({ type: "liveError", ...toUiError(error) }),
        onTargetState: (event) => host.debugLaunch.handleTargetState(event),
        beforePausedRead: () => host._writes.quiesceRuntimeRead()
    });
    const archiveLimitMiB = validation.clampInteger(
        vscode.workspace.getConfiguration("emberprobe").get("samplingArchiveMaxMiB", 1024),
        1024,
        64,
        102400
    );
    cleanupStaleSamplingArchives(context.globalStorageUri.fsPath);
    const samplingArchive = new SamplingArchive({
        rootDir: path.join(
            context.globalStorageUri.fsPath,
            `sampling-history-${process.pid}-${crypto.randomBytes(6).toString("hex")}`
        ),
        maxBytes: archiveLimitMiB * 1024 * 1024,
        onWritten: (bytes) =>
            host._chartHistory?.archiveProgress({
                dataPath: host._samplingArchive.dataPath,
                bytes,
                limited: host._samplingArchive.limitReached || !!host._samplingArchive.failed
            }),
        onBackpressure: (paused) => host._sampling.setArchiveBackpressure(paused),
        onError: (error) => {
            host._chartHistory?.archiveProgress(
                { dataPath: host._samplingArchive.dataPath, bytes: host._samplingArchive.indexedBytes, limited: true },
                true
            );
            host._sampling.stop();
            host._postLive({ type: "liveError", ...toUiError(error) });
        }
    });
    const chartHistoryMiB = validation.clampInteger(
        vscode.workspace.getConfiguration("emberprobe").get("chartHistoryMaxMiB", 512),
        512,
        64,
        4096
    );
    const chartHistory = new ChartHistoryService({
        workerPath: path.join(__dirname, "chartHistoryWorker.js"),
        maxBytes: chartHistoryMiB * 1024 * 1024,
        onUpdated: (message) => {
            if (message.limited) host._warnChartHistoryLimited();
            for (const entry of host._livePanels.values())
                if (host._debugSamplingScope(entry.watchKey) === message.scope && entry.ready)
                    entry.post({ ...message, type: "chartHistoryStatus", historyRevision: entry.historyRevision || 0 });
        },
        onError: (error) => host._handleChartHistoryError(error)
    });
    return { liveWatchService, watchLists, debugBridge, samplingArchive, chartHistory };
}

// Workspace configuration, CubeMX, ELF, SVD, and the OpenOCD and Agent skill status cards.
function createWorkspaceServices(host, context, vscode) {
    const configurationStore = new ConfigurationStore({
        vscode,
        context,
        cacheKeys: CACHE_KEYS,
        cleanPath: validation.cleanWindowsPath,
        isSafeCfg: openocdRunner.isSafeCfg,
        beforeChange: (values) => host._assertConnectionEditable(values),
        onChanged: async () => {
            await host._elfView.refreshBindings();
            host.updateView();
            for (const entry of host._livePanels.values()) host._syncGraphTarget(entry);
        }
    });
    const cubemxFirmware = new CubeMxFirmware({
        vscode,
        context,
        changed: () => host.updateView(),
        t: (key) => host._t(key),
        notify: (notice) =>
            host._notices.notify(
                "config",
                "mcu-vscode.installCubeMxFirmware",
                notice.message ? { ...notice, key: undefined, titleKey: notice.key, text: notice.message } : notice
            )
    });
    const cubemxConfiguration = new CubeMxConfiguration({
        vscode,
        context,
        changed: () => host.updateView(),
        t: (key) => host._t(key)
    });
    const cubemxService = new CubeMxService({
        storage: context.workspaceState,
        storageDir: context.globalStorageUri?.fsPath,
        config: () => host._configurationStore.snapshot(),
        roots: () => (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath)
    });
    const elfService = new ElfService({
        context,
        cacheKey: CACHE_KEYS.elfPath,
        fs,
        crypto,
        elfSymbols,
        dwarf,
        workerPath: path.join(__dirname, "elfWorker.js"),
        onChange: (phase, result, entries) => {
            host._liveWatchService.setElfResult(result, true);
            return host._elfView.onElfChange(phase, result, entries);
        },
        cleanPath: validation.cleanWindowsPath,
        t: (key, params) => host._t(key, params)
    });
    const openOcdStatusService = new OpenOcdStatusService({
        vscode,
        context,
        checker: openocdChecker,
        getLang: () => host._lang,
        onStatus: (status) => host._webviewView?.webview.postMessage({ type: "openocdStatus", ...status })
    });
    const skillStatusService = new SkillStatusService({
        vscode,
        context,
        installer: skillInstaller,
        getLang: () => host._lang,
        t: (key, params) => host._t(key, params),
        notify: (notice) => host._notices.notify("global", "mcu-vscode.manageAgentSkills", notice),
        onStatus: (status) => host._webviewView?.webview.postMessage({ type: "skillStatus", ...status })
    });
    const svdManager = new SvdManager({
        workerPath: path.join(__dirname, "svdWorker.js"),
        vscode,
        context,
        cacheKeys: CACHE_KEYS,
        t: (key, params) => host._t(key, params),
        getChipInfo: () => host._chipInfoService.info,
        notify: (notice) =>
            host._notices.notify(
                "config",
                "svd",
                notice.error ? { level: "error", titleKey: "notice.svdFailed", error: notice.error } : notice
            ),
        onStatus: (status) => {
            host._sampling.peripheralsChanged();
            host._webviewView?.webview.postMessage({ type: "svdStatus", ...status });
        }
    });
    return {
        configurationStore,
        cubemxFirmware,
        cubemxConfiguration,
        cubemxService,
        elfService,
        openOcdStatusService,
        skillStatusService,
        svdManager
    };
}

// Agent flashing, the Bridge with its instance registry, and the MCP server definition.
function createAgentServices(host, context, vscode, { probeCoordinator, flashAuthorization }) {
    const agentFlashService = new AgentFlashService({
        getConfig: () => host._configurationStore.snapshot(),
        coordinator: probeCoordinator,
        authorization: flashAuthorization,
        prepare: (options, settings) => host._probeConnectionService.prepare(options, settings),
        recordSuccess: (connection) => host._probeConnectionService.recordSuccess(connection),
        recordFlashed: (entry) => host._firmwareRecord.record(entry),
        isDebugActive: () => host._debugBridge.hasAnySession || !!host.debugLaunch.liveSession()
    });
    let bridgeRegistry = null;
    const storageDir = context.globalStorageUri?.fsPath;
    if (storageDir) {
        // One instance entry per window; startup also removes entries whose host process has exited.
        bridgeRegistry = new BridgeRegistry({
            storageDir,
            hostApp: vscode.env?.appName || "",
            extensionVersion: context.extension?.packageJSON?.version || ""
        });
        cleanupStaleEntries(storageDir).catch(() => {});
    }
    const agentService = new AgentService({
        Bridge: AgentBridge,
        isTrusted: () => vscode.workspace.isTrusted,
        workspaceProvider: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        workspaceFoldersProvider: () => (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath),
        // The Bridge descriptor (with token) goes to globalStorage and the workspace keeps only a pointer, so the
        // token cannot leak through git or cloud sync
        storageDirProvider: () => host._context.globalStorageUri.fsPath,
        registry: bridgeRegistry,
        onCall: (_method, _params, meta) => host._warnIfSkillsModified(meta),
        onAudit: (entry) => host._auditAgentCall(entry),
        handlers: createAgentRoutes(host)
    });
    const mcpRegistration = new McpRegistration({
        vscode,
        context,
        t: (key, params) => host._t(key, params),
        isAvailable: () => host._mcpAvailable(),
        isEnabled: () => host._mcpAvailable() && host._agentAccessDecision(host._skillStatusService.lastStatus).enabled,
        instanceId: () => host._agentService.instanceId(),
        toolsets: () => host._mcpToolsets(),
        onResolve: () => host._requestMcpBridge(),
        onConfigured: () => host._markMcpConfigured()
    });
    return { agentFlashService, bridgeRegistry, agentService, mcpRegistration };
}

// The composition root: builds the services the MainViewProvider owns and connects their callbacks to it. host is the
// provider; callbacks read its members when they run, so a member replaced later (by a test) takes effect. vscode comes
// from the provider module, so a provider can be built with a fake VS Code API.
/**
 * @param {any} host
 * @param {any} context The extension context.
 * @param {{ vscode: any }} modules
 */
function createServices(host, context, { vscode }) {
    const probe = createProbeServices(host, context, vscode);
    const sampling = createSamplingServices(host, context, vscode);
    const { debugBridge } = sampling;
    const peripheralWriteAuthorization = new PeripheralWriteAuthorization();
    const flashAuthorization = new FlashAuthorization({ storage: context.workspaceState });
    const svdPeripheralService = new SvdPeripheralService({
        workerPath: path.join(__dirname, "svdWorker.js"),
        loadBoundSvd: () => host._svdManager.peekBound(host._commandContext().folder),
        debugBridge,
        authorization: peripheralWriteAuthorization
    });
    const firmwareRecord = new FirmwareRecord(context.workspaceState);
    return {
        ...probe,
        ...sampling,
        ...createWorkspaceServices(host, context, vscode),
        ...createAgentServices(host, context, vscode, { probeCoordinator: probe.probeCoordinator, flashAuthorization }),
        runtimeSampleHold: new RuntimeSampleHold(),
        samplingCoordinator: new SamplingCoordinator(),
        rtosViewService: new RtosViewService(debugBridge),
        writeAuthorization: new WriteAuthorization(context.workspaceState),
        peripheralWriteAuthorization,
        flashAuthorization,
        firmwareRecord,
        flashService: new FlashService(openocdRunner),
        faultService: new FaultService(faultInfo, elfSymbols),
        svdPeripheralService,
        peripheralViewService: new PeripheralViewService({ peripherals: svdPeripheralService, debugBridge }),
        debugControlService: new DebugControlService({
            vscode,
            debugBridge,
            workspaceProvider: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            startDebug: () => host.debugLaunch.start(undefined, undefined, false),
            waitForRelease: (session) => host.debugLaunch.sessionReleased(session)
        })
    };
}

module.exports = { createServices };
