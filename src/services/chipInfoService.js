"use strict";

class ChipInfoService {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.cacheKeys = options.cacheKeys;
        this.chipInfo = options.chipInfo;
        this.coordinator = options.coordinator;
        this.t = options.t;
        this.resolveExecutable = options.resolveExecutable;
        this.commandContext = options.commandContext;
        this.onPost = options.onPost;
        this.onDiagnostics = options.onDiagnostics;
        this.isDebugActive = options.isDebugActive;
        this.info = null;
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
        if (this.running) return this.rejectBusy("chip.reading", "CHIP_READ_RUNNING", forAgent);
        if (this.coordinator.isActive("download")) return this.rejectBusy("chip.busyDownload", "PROBE_BUSY", forAgent);
        if (this.coordinator.isActive("liveWatch")) return this.rejectBusy("chip.busyLive", "PROBE_BUSY", forAgent);
        if (this.coordinator.isActive("agentRead")) return this.rejectBusy("chip.busyAgent", "PROBE_BUSY", forAgent);
        if (this.coordinator.isActive("debugStart") || this.isDebugActive()) {
            return this.rejectBusy("chip.busyDebug", "PROBE_BUSY", forAgent);
        }
        const probe = this.context.workspaceState.get(this.cacheKeys.debugger);
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
                message: error.message || String(error)
            });
            return null;
        }
        if (!executable) {
            lease.release();
            return this.rejectBusy("chip.notReady", "OPENOCD_NOT_READY", forAgent);
        }

        this.post({ state: "reading", key: "chip.reading" });
        let diagnostics = null;
        try {
            const { cwd } = this.commandContext();
            const info = await this.chipInfo.readChipInfo(this.vscode, { executable, probe, target, cwd }, (event) => {
                if (event?.stage === "raw") diagnostics = event;
            });
            this.info = info;
            this.post({ state: "ready", key: "chip.done" }, info);
            this.onDiagnostics(diagnostics, info);
            return info;
        } catch (error) {
            this.post({
                state: "error",
                key: error.i18nKey,
                params: error.i18nParams,
                message: error.message || String(error)
            });
            this.onDiagnostics(diagnostics, null);
            if (forAgent) throw error;
            return null;
        } finally {
            lease.release();
        }
    }
}

module.exports = { ChipInfoService };
