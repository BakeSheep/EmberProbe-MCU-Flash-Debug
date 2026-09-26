"use strict";
const { serializeError } = require("./errorEnvelope");

class ChipInfoService {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.cacheKeys = options.cacheKeys;
        this.chipInfo = options.chipInfo;
        this.coordinator = options.coordinator;
        this.t = options.t;
        this.resolveExecutable = options.resolveExecutable;
        this.prepareConnection = options.prepareConnection;
        this.resolveProbe = options.resolveProbe;
        this.recordSuccess = options.recordSuccess || (async () => {});
        this.commandContext = options.commandContext;
        this.onPost = options.onPost;
        this.onDiagnostics = options.onDiagnostics;
        this.isDebugActive = options.isDebugActive;
        this.info = null;
        this.infoConnection = null;
    }

    get running() {
        return this.coordinator.isActive("chipInfo");
    }

    post(status, info) {
        if (info) this.onPost({ type: "chipInfo", info });
        if (status) this.onPost({ type: "chipInfoStatus", ...status });
    }

    sync(post) {
        if (this.info) post({ type: "chipInfo", info: this.info });
        const state = this.running ? "reading" : this.info ? "ready" : "idle";
        const key = this.running ? "chip.reading" : this.info ? "chip.done" : "chip.notRead";
        post({ type: "chipInfoStatus", state, key });
    }

    rejectBusy(key, code, forAgent) {
        const error = Object.assign(new Error(this.t(key)), { i18nKey: key, code });
        this.post({ state: "error", key });
        if (forAgent) throw error;
        return null;
    }

    async read(forAgent = false) {
        const startedAt = Date.now();
        if (this.running) return this.rejectBusy("chip.reading", "CHIP_READ_RUNNING", forAgent);
        if (this.coordinator.isActive("download")) return this.rejectBusy("chip.busyDownload", "PROBE_BUSY", forAgent);
        if (this.coordinator.isActive("liveWatch")) return this.rejectBusy("chip.busyLive", "PROBE_BUSY", forAgent);
        if (this.coordinator.isActive("agentRead")) return this.rejectBusy("chip.busyAgent", "PROBE_BUSY", forAgent);
        if (this.coordinator.isActive("debugStart") || this.isDebugActive()) {
            return this.rejectBusy("chip.busyDebug", "PROBE_BUSY", forAgent);
        }
        const probe = this.context.workspaceState.get(this.cacheKeys.debugger) || (await this.resolveProbe?.());
        const target = this.context.workspaceState.get(this.cacheKeys.mcuCore);
        if (!probe || !target) return this.rejectBusy("chip.needConfig", "CONFIG_INCOMPLETE", forAgent);

        const lease = this.coordinator.acquire("chipInfo");
        const configured = this.vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
        let executable;
        try {
            executable = await this.resolveExecutable(configured);
        } catch (error) {
            lease.release();
            if (forAgent) throw error;
            this.post({
                state: "error",
                key: error.i18nKey,
                params: error.i18nParams,
                message: error.message || String(error),
                diagnostic: serializeError(error)
            });
            return null;
        }
        if (!executable) {
            lease.release();
            return this.rejectBusy("chip.notReady", "OPENOCD_NOT_READY", forAgent);
        }

        const configMs = Date.now() - startedAt;
        let preflightMs = null;
        let openOcdMs = null;
        let saveMs = null;
        const diagnosticReport = () => ({
            ...(diagnostics || {}),
            target,
            timings: { configMs, preflightMs, openOcdMs, saveMs, totalMs: Date.now() - startedAt }
        });
        this.post({ state: "reading", key: "chip.reading" });
        let diagnostics = null;
        try {
            const { cwd } = this.commandContext();
            const preflightStartedAt = Date.now();
            const connection = this.prepareConnection
                ? await this.prepareConnection({ executable, probe, target }, !forAgent)
                : {};
            preflightMs = Date.now() - preflightStartedAt;
            const openOcdStartedAt = Date.now();
            const info = await this.chipInfo.readChipInfo(
                this.vscode,
                {
                    executable,
                    probe,
                    target,
                    cwd,
                    transport: this.vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                    ...connection
                },
                (event) => {
                    if (event?.stage === "raw") {
                        diagnostics = event;
                        openOcdMs = Date.now() - openOcdStartedAt;
                    }
                }
            );
            openOcdMs = Date.now() - openOcdStartedAt;
            const saveStartedAt = Date.now();
            if (!lease.released && (info.cpuid || info.core || info.idcode || info.uid))
                await this.recordSuccess(connection);
            saveMs = Date.now() - saveStartedAt;
            info.readAt = new Date().toISOString();
            this.info = info;
            this.infoConnection = { probe, target };
            this.post({ state: "ready", key: "chip.done" }, info);
            this.onDiagnostics(diagnosticReport(), info);
            return info;
        } catch (error) {
            this.post({
                state: "error",
                key: error.i18nKey,
                params: error.i18nParams,
                message: error.message || String(error),
                diagnostic: serializeError(error)
            });
            this.onDiagnostics(diagnosticReport(), null);
            if (forAgent) throw error;
            return null;
        } finally {
            lease.release();
        }
    }

    async control(action) {
        if (!["pause", "continue", "reset"].includes(action))
            throw Object.assign(new Error(`Unsupported target action: ${action}`), { code: "CHIP_ACTION_INVALID" });
        if (!this.info) return this.rejectBusy("chip.notRead", "CHIP_NOT_READ", false);
        if (this.running) return this.rejectBusy("chip.reading", "CHIP_READ_RUNNING", false);
        if (this.coordinator.isActive("download")) return this.rejectBusy("chip.busyDownload", "PROBE_BUSY", false);
        if (this.coordinator.isActive("liveWatch")) return this.rejectBusy("chip.busyLive", "PROBE_BUSY", false);
        if (this.coordinator.isActive("agentRead")) return this.rejectBusy("chip.busyAgent", "PROBE_BUSY", false);
        if (this.coordinator.isActive("debugStart") || this.isDebugActive())
            return this.rejectBusy("chip.busyDebug", "PROBE_BUSY", false);
        const probe = this.context.workspaceState.get(this.cacheKeys.debugger) || this.infoConnection?.probe;
        const target = this.context.workspaceState.get(this.cacheKeys.mcuCore);
        if (!probe || !target) return this.rejectBusy("chip.needConfig", "CONFIG_INCOMPLETE", false);
        if (probe !== this.infoConnection?.probe || target !== this.infoConnection?.target)
            return this.rejectBusy("chip.readAgain", "CHIP_INFO_STALE", false);
        let lease;
        try {
            lease = this.coordinator.acquire("chipInfo");
            this.post({ state: "reading", key: "chip.controlling" });
            const configured = this.vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
            const executable = await this.resolveExecutable(configured);
            if (!executable) throw Object.assign(new Error(this.t("chip.notReady")), { i18nKey: "chip.notReady" });
            const { cwd } = this.commandContext();
            const connection = this.prepareConnection
                ? await this.prepareConnection({ executable, probe, target }, true)
                : {};
            if (lease.released || this.isDebugActive())
                throw Object.assign(new Error(this.t("chip.busyDebug")), { i18nKey: "chip.busyDebug" });
            const options = {
                executable,
                probe,
                target,
                cwd,
                transport: this.vscode.workspace.getConfiguration("emberprobe").get("transport", "auto"),
                ...connection
            };
            const result = await this.chipInfo.controlTarget(options, action);
            // Show the verified transition even if the subsequent full information read fails.
            this.info = {
                ...this.info,
                targetState: result.state,
                haltReason: "",
                pc: "",
                sp: "",
                lr: "",
                stateError: "",
                readAt: new Date().toISOString()
            };
            this.post(null, this.info);
            const info = await this.chipInfo.readChipInfo(this.vscode, options);
            info.readAt = new Date().toISOString();
            this.info = info;
            this.post({ state: "ready", key: "chip.done" }, info);
            return info;
        } catch (error) {
            this.post({
                state: "error",
                key: error.i18nKey,
                params: error.i18nParams,
                message: error.message || String(error),
                diagnostic: serializeError(error)
            });
            return null;
        } finally {
            lease?.release();
        }
    }
}

module.exports = { ChipInfoService };
