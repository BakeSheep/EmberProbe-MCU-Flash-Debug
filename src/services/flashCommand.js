"use strict";
const { isSupportedDebugSession } = require("./debugConfiguration");
const { cleanWindowsPath } = require("../validation");
const { CACHE_KEYS } = require("../cacheKeys");
const { COMMAND_FAILURE_TITLES } = require("./noticeService");
const { toUiError } = require("./errorEnvelope");

// The sidebar's program command: stops sampling, programs the selected ELF through FlashService while holding the
// download lease, then refreshes the ELF bindings and resumes sampling that was running. host is the
// MainViewProvider.
async function runDownload(host, vscode, resource) {
    const cmd = "mcu-vscode.download";
    const notify = (notice) => host._notices.notify("flash", cmd, notice);
    const warn = (key, params) => {
        notify({ level: "warning", key, params });
        return false;
    };
    // A second click while flashing must not replace the running download's progress.
    if (host._downloadRunning) {
        host._notices.notify("flash", "download-busy", { level: "warning", key: "msg.downloadBusy" });
        return false;
    }
    if (
        host.debugLaunch.starting ||
        host._debugBridge.hasAnySession ||
        isSupportedDebugSession(host.debugLaunch.liveSession())
    )
        return warn("msg.debugBusyForDownload");
    if (host._agentOps.readRunning) return warn("msg.agentReadBusy");
    if (host._chipInfoRunning) return warn("msg.chipBusyForDownload");
    if (host._sampling.starting) return warn("msg.liveBusyForDownload");
    // Refuse before RTT and live watch are interrupted: a download that cannot reserve the probe changes nothing.
    try {
        host._probeCoordinator.assertAvailable("download", ["rtt", "liveWatch"]);
    } catch (error) {
        if (error?.code !== "PROBE_BUSY") throw error;
        return warn("msg.probeBusyForDownload");
    }
    host._notices.clear("flash", "download-busy");
    host._notices.clear("flash", "download-refresh");
    // Keep the live lease until process exit, then synchronously reserve download.
    const resumeSampling = !!host._sampling.intent && !!(host._sampling.running || host._sampling.session);
    // RTT detaches first so flashing can take the probe; it re-attaches with a freshly resolved control block once
    // this command finishes and a session is available again.
    const rttYielded = host._rtt?.yieldForRestart("download");
    if (rttYielded) await rttYielded;
    const liveStopped = host._sampling.running || host._sampling.session ? host._sampling.stop() : null;
    if (liveStopped) await liveStopped;
    const downloadLease = host._probeCoordinator.acquire("download");
    host._downloadLease = downloadLease;
    let downloaded = false;
    // OpenOCD progress lines, kept for the failure's diagnostic panel.
    const progressLog = [];
    try {
        const configuredExecutable = vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
        const executable = await host._resolveOpenOcdPath(configuredExecutable);
        if (!executable) return warn("notice.openocdRequired");
        let elfPath = host._context.workspaceState.get(CACHE_KEYS.elfPath);
        const debuggerCfg =
            host._context.workspaceState.get(CACHE_KEYS.debugger) ||
            (await host._probeConnectionService.resolveProbe());
        const mcuCore = host._context.workspaceState.get(CACHE_KEYS.mcuCore);
        if (!elfPath || !debuggerCfg || !mcuCore) return warn("msg.configIncomplete");
        const cleanElfPath = cleanWindowsPath(elfPath);
        const { cwd } = host._commandContext(resource);
        let connection;
        await host._flashService.download(
            vscode,
            {
                executable,
                elf: cleanElfPath,
                transport: vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                probe: debuggerCfg,
                target: mcuCore,
                prepare: async () => {
                    connection = await host._probeConnectionService.prepare(
                        { executable, probe: debuggerCfg, target: mcuCore },
                        true
                    );
                    return connection;
                },
                onDownloaded: (image) =>
                    host._firmwareRecord.record({
                        ...image,
                        connection: { ...connection, probe: debuggerCfg, target: mcuCore }
                    }),
                cwd
            },
            (event) => {
                const text = event.key ? host._t(event.key, event.params) : event.message || "";
                if (text) progressLog.push(text);
                if (progressLog.length > 12) progressLog.shift();
                // Errors along the way end in the failure notice; the box shows the current step.
                if (event.level !== "error" && text)
                    notify({ level: "info", busy: true, key: event.key, params: event.params, message: text });
            }
        );
        if (connection && !host._downloadLease?.released) await host._probeConnectionService.recordSuccess(connection);
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
                await host._elfView.refreshBindings();
                refreshed = true;
            }
        } catch (error) {
            host._postLive({ type: "liveError", ...toUiError(error) });
            host._notices.notify("flash", "download-refresh", {
                level: "warning",
                key: "msg.downloadRefreshFailed",
                params: { error: error.message }
            });
        } finally {
            downloadLease.release();
        }
        if (resumeSampling && refreshed) {
            try {
                await host._sampling.start(undefined, host._sampling.intervalMs, "refresh");
            } catch (error) {
                host._notices.notify("flash", "download-refresh", {
                    level: "warning",
                    key: "msg.downloadSamplingFailed",
                    params: { error: error.message }
                });
            }
        }
        host._rtt?.onSessionsChanged();
    }
}

module.exports = { runDownload };
