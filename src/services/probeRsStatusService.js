"use strict";

const { execFile } = require("child_process");

function checkProbeRs(executable) {
    if (!String(executable || "").trim()) return Promise.resolve({ state: "missing", key: "pr.missing" });
    return new Promise((resolve) => {
        execFile(executable, ["--version"], { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
            const output = String(stdout || stderr || "").trim();
            const version = /^probe-rs\s+(\d+\.\d+\.\d+)/i.exec(output)?.[1];
            if (!error && version) resolve({ state: "ready", key: "pr.ready", params: { version } });
            else if (error?.code === "ENOENT") resolve({ state: "missing", key: "pr.missing" });
            else resolve({ state: "error", key: "pr.invalid", params: { path: executable }, message: output });
        });
    });
}

class ProbeRsStatusService {
    constructor(options) {
        this.vscode = options.vscode;
        this.onStatus = options.onStatus;
        this.check = options.check || checkProbeRs;
        this.status = { state: "checking", key: "pr.checking", canInstall: false };
        this.operation = 0;
    }

    post(status) {
        this.status = { ...status, canInstall: false };
        this.onStatus(this.status);
    }

    async refresh(showChecking = true) {
        const operation = ++this.operation;
        if (showChecking) this.post({ state: "checking", key: "pr.checking" });
        const executable = this.vscode.workspace.getConfiguration("emberprobe").get("probeRsPath", "probe-rs");
        let status;
        try {
            status = await this.check(executable);
        } catch (error) {
            status = { state: "error", key: "pr.invalid", params: { path: executable }, message: error.message };
        }
        if (operation !== this.operation) return null;
        this.post(status);
        return status.state === "ready" ? executable : null;
    }

    async handleAction(action) {
        if (action !== "select") return this.refresh(true);
        const operation = ++this.operation;
        const selected = await this.vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: "probe-rs"
        });
        const executable = selected?.[0]?.fsPath;
        if (!executable) return null;
        let status;
        try {
            status = await this.check(executable);
        } catch (error) {
            status = { state: "error", key: "pr.invalid", params: { path: executable }, message: error.message };
        }
        if (operation !== this.operation) return null;
        if (status.state !== "ready") {
            this.post(status);
            return null;
        }
        await this.vscode.workspace
            .getConfiguration("emberprobe")
            .update("probeRsPath", executable, this.vscode.ConfigurationTarget.Workspace);
        this.post(status);
        return executable;
    }
}

module.exports = { checkProbeRs, ProbeRsStatusService };
