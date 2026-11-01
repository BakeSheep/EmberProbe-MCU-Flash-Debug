"use strict";
const { CACHE_KEYS } = require("../cacheKeys");
const { connectedProbeId } = require("../validation");
const { commandArea, COMMAND_FAILURE_TITLES } = require("../services/noticeService");
const { serializeError, toUiError } = require("../services/errorEnvelope");
const { RtosViewService } = require("../services/rtosViewService");
const { SHARED_ROUTES, routeFor } = require("./webviewRoutes");

const REPOSITORY_URL = "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug";

// Runs a sidebar button's command and tells the view how it ended.
async function executeCommand({ host, post }, message) {
    const cmd = message.cmd;
    const area = commandArea(cmd);
    // A new run replaces what this command last reported, but not the progress of a run
    // still in flight (a second click is refused by the handler instead).
    if (!host._notices.get(area, cmd)?.busy) host._notices.clear(area, cmd);
    const revision = host._notices.revision;
    let result;
    try {
        if (Object.hasOwn(host.commandHandlers, cmd) && typeof host.commandHandlers[cmd] === "function") {
            result = await host.commandHandlers[cmd]();
        } else {
            throw Object.assign(new Error(host._t("msg.commandNotRegistered", { cmd })), {
                i18nKey: "msg.commandNotRegistered",
                i18nParams: { cmd }
            });
        }
        // A handler that reported its own failure leaves a notice; otherwise say it failed.
        if (result === false && host._notices.revision === revision)
            host._notices.notify(area, cmd, { level: "error", key: "sb.commandFailed" });
    } catch (error) {
        result = false;
        console.error("Command failed:", error.message);
        if (!error.reported)
            host._notices.notify(area, cmd, { level: "error", titleKey: COMMAND_FAILURE_TITLES[cmd], error });
    }
    // The footer only tracks that the command finished; messages live in the notices.
    post({ type: result === null ? "commandCancelled" : result === false ? "commandError" : "commandSuccess", cmd });
    // Progress that ended without a result notice (e.g. a debug session that started) goes away.
    if (result !== false && host._notices.get(area, cmd)?.busy) host._notices.clear(area, cmd);
}

function initCheck({ host, post }) {
    host._getMemoryAnalysisController().refresh();
    host._sidebarReady = true;
    // Acknowledge the webview's init check directly
    post({ type: "initSuccess" });
    if (host._connectedProbes.driverSwitching) post({ type: "probeDriverSwitch", busy: true });
    host._connectedProbes.lastMessage = "";
    host._connectedProbes.startMonitor();
    // A rebuilt sidebar gets back the notices that are still current.
    host._notices.replay(post);
    host._syncSidebarTarget(post);
    host._syncChipInfo(post);
    host._svdManager.syncStatus().catch((error) => console.error("SVD status check failed:", error.message));
    host._postPeripheralDebugStatus(post);
    post({ type: "openocdStatus", ...host._openOcdStatusService.status });
    host.refreshOpenOcdStatus(false);
    host.refreshSkillStatus().catch((error) => console.error("Agent Skills status check failed:", error.message));
}

// Requests of the peripheral view, each answered with its result message.
const PERIPHERAL_REQUESTS = {
    peripheralCatalogRequest: async (host) => ({
        type: "peripheralCatalog",
        ...(await host._peripheralViewService.catalog())
    }),
    peripheralRegistersRequest: async (host, message) => ({
        type: "peripheralRegisters",
        ...(await host._peripheralViewService.registers(message.name))
    }),
    peripheralReadRequest: async (host, message) => ({
        type: "peripheralReadResult",
        ...(await host._peripheralViewService.read(message.targets))
    }),
    peripheralWriteRequest: async (host, message) => {
        if (typeof message.target !== "string" || !message.target.trim() || message.target.length > 256)
            throw new Error("Invalid peripheral target");
        if (typeof message.value !== "string" || !message.value.trim() || message.value.length > 128)
            throw new Error("Invalid peripheral value");
        host._writes.assertSessionCurrent(host._debugBridge);
        const result = await host._svdPeripheralService.writeFromUi({
            writes: [{ target: message.target, value: message.value.trim() }]
        });
        return { type: "peripheralWriteResult", target: message.target, result };
    }
};

// Any failure, including a missing SVD, goes back to the peripheral view as peripheralError.
async function peripheralRequest({ host, post }, message) {
    const operation = message.type;
    try {
        if (!(await host._svdManager.currentPath())) throw new Error(host._t("peripheral.configureSvdFirst"));
        post(await PERIPHERAL_REQUESTS[operation](host, message));
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

const PROBE_ACTIONS = {
    acceptTargetChip: async (host) => {
        host._assertConnectionEditable({ probeSerial: true });
        await host._probeConnectionService.acceptTargetMismatch();
        await host._connectedProbes.refresh();
    },
    selectProbeDriver: (host, message) =>
        host._connectedProbes.changeDriver(
            message.driver,
            connectedProbeId(message.deviceId) ? { deviceId: message.deviceId } : null
        ),
    selectConnectedProbe: (host, message) => host._connectedProbes.select(message.deviceId),
    refreshConnectedProbes: async (host) => {
        host._connectedProbes.inventory().resetBackoff();
        await host._connectedProbes.refresh();
        if (await host._connectedProbes.readTargets()) await host._connectedProbes.refresh();
    }
};

async function probeAction({ host, post }, message) {
    try {
        await PROBE_ACTIONS[message.type](host, message);
    } catch (error) {
        if (message.type === "selectProbeDriver") {
            // The driver service already reports its own failures through the same notice.
            if (host._notices.get("config", "probe-driver")?.level !== "error")
                host._notices.notify("config", "probe-driver", {
                    level: "error",
                    titleKey: "notice.driverSwitchFailed",
                    error
                });
        } else {
            host._notices.notify("config", "probe-selection", { level: "error", error });
            post({
                type: "commandError",
                diagnostic: serializeError(error),
                error: error.i18nKey ? host._t(error.i18nKey, error.i18nParams) : error.message || String(error)
            });
        }
        host._connectedProbes
            .refresh()
            .catch((refreshError) => console.error("Probe inventory check failed:", refreshError.message));
    }
}

// Writes are serialized by the write controller; a failure only posts writeResult, never a global error, and a value
// superseded while queued posts nothing.
async function writeVariable({ host, post }, message) {
    const name = String(message.name || "").trim();
    const seq = message.seq;
    try {
        const result = await host._writes.queueUiWrite(name, message.value, { requestedAt: Date.now() });
        if (!result) return;
        const r = result.results && result.results[0];
        post({
            type: "writeResult",
            ok: true,
            name,
            value: r ? r.readBack : message.value,
            valueText: r ? r.readBackText : null,
            seq
        });
    } catch (error) {
        post({ type: "writeResult", ok: false, name, seq, ...toUiError(error) });
    }
}

const SIDEBAR_ROUTES = {
    ...SHARED_ROUTES,
    executeCommand,
    initCheck,
    ...Object.fromEntries(Object.keys(PERIPHERAL_REQUESTS).map((type) => [type, peripheralRequest])),
    ...Object.fromEntries(Object.keys(PROBE_ACTIONS).map((type) => [type, probeAction])),
    writeVariable,
    noticeDismiss: ({ host }, message) => host._notices.dismiss(message.area, message.id),
    memoryRefresh: ({ host }) => host._getMemoryAnalysisController().refresh(),
    memorySelectSource: async ({ host, post }) => {
        try {
            await host._getMemoryAnalysisController().selectSource();
        } catch (error) {
            post({
                type: "memoryAnalysis",
                state: "error",
                key: "memory.failed",
                message: error.message,
                code: error.code
            });
        }
    },
    rtosRefresh: async ({ host, post }, message) => {
        host._rtosViewService ||= new RtosViewService(host._debugBridge);
        const identity = host._rtosViewService.status();
        try {
            post(await host._rtosViewService.refresh(message.includeStackUsage !== false));
        } catch (error) {
            post({ ...identity, type: "rtosError", message: error.message });
        }
    },
    debugSelectSession: ({ host, post }, message) => {
        try {
            host._selectDebugSession({ sessionId: message.sessionId });
            host._postPeripheralDebugStatus(post);
        } catch (error) {
            post({ ...host._rtosViewService.status(), type: "rtosError", message: error.message });
        }
    },
    openocdAction: async ({ host }, message) => {
        try {
            await host._handleOpenOcdAction(message.action);
        } catch (error) {
            host._postOpenOcdStatus({
                state: "error",
                key: error.i18nKey,
                params: error.i18nParams,
                message: error.message || String(error)
            });
        }
    },
    refreshVariables: async ({ host }) => {
        try {
            await host._elfView.refreshBindings();
        } catch (error) {
            host._postLive({ type: "liveError", ...toUiError(error) });
        }
    },
    saveSidebarWatch: ({ host }, message) =>
        host._saveWatchList(CACHE_KEYS.sidebarWatchList, Array.isArray(message.items) ? message.items : [], {
            syncSidebar: false
        }),
    saveSidebarWrite: ({ host }, message) =>
        host._saveWatchList(CACHE_KEYS.sidebarWriteList, Array.isArray(message.items) ? message.items : [], {
            syncSidebar: false
        }),
    liveToggle: async ({ host }, message) => {
        try {
            if (host._agentOps.readRunning) host._agentOps.stopReadIfRunning();
            else if (host._sampling.intent) host._sampling.stop({ variablesOnly: true });
            else {
                const items = host._context.workspaceState.get(CACHE_KEYS.sidebarWatchList) || [];
                await host._sampling.start(items, message.intervalMs, "sidebar");
            }
        } catch (error) {
            host._postConsumerStatuses({ key: error.i18nKey, params: error.i18nParams, message: error.message }, true);
        }
    },
    readChipInfo: async ({ host, post }) => {
        try {
            await host.readChipInfoAction();
        } catch (error) {
            host._postChipInfo({ state: "error", ...toUiError(error) });
        }
        try {
            await host._svdManager.syncStatus();
        } catch (error) {
            post({ type: "svdStatus", state: "error", ...toUiError(error) });
        }
    },
    chipControl: async ({ host }, message) => {
        try {
            await host._chipInfoService.control(message.action);
        } catch (error) {
            host._postChipInfo({ state: "error", ...toUiError(error) });
        }
    },
    cancelSvdDownload: ({ host }) => host._svdManager.cancel(),
    openGitHub: ({ vscode }) => vscode.env.openExternal(vscode.Uri.parse(REPOSITORY_URL))
};

// The message handler of one sidebar view. Messages of unknown types are ignored.
function createSidebarHandler(host, view, vscode) {
    const page = {
        host,
        vscode,
        post: (message) => view.webview.postMessage(message),
        watchKey: CACHE_KEYS.sidebarWatchList
    };
    return async (message) => {
        const route = routeFor(SIDEBAR_ROUTES, message);
        if (route) await route(page, message);
    };
}

module.exports = { SIDEBAR_ROUTES, createSidebarHandler };
