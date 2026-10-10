"use strict";

const { execFile } = require("child_process");
const i18n = require("../i18n");
const { probeRsInstallCandidates, resolveProbeRsExecutable } = require("./probeRsEnvironment");
const { canInstallProbeRs, installProbeRs } = require("./probeRsInstaller");

function checkProbeRs(executable, options = {}) {
    const target = (options.resolve || resolveProbeRsExecutable)(executable);
    if (!target) return Promise.resolve({ state: "missing", key: "pr.missing" });
    return new Promise((resolve) => {
        (options.run || execFile)(
            target,
            ["--version"],
            { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 },
            (error, stdout, stderr) => {
                const output = [stdout, stderr].filter(Boolean).join("\n").trim();
                const version = /^probe-rs\s+(\d+\.\d+\.\d+)/i.exec(output)?.[1];
                if (!error && version) resolve({ state: "ready", key: "pr.ready", params: { version }, path: target });
                else if (error?.code === "ENOENT") resolve({ state: "missing", key: "pr.missing" });
                else resolve({ state: "error", key: "pr.invalid", params: { path: target }, message: output });
            }
        );
    });
}

class ProbeRsStatusService {
    constructor(options) {
        this.vscode = options.vscode;
        this.onStatus = options.onStatus;
        this.check = options.check || checkProbeRs;
        this.install = options.install || installProbeRs;
        this.candidates = options.candidates || probeRsInstallCandidates;
        this.platform = options.platform || process.platform;
        this.t = options.t || ((key, params) => i18n.t("en", key, params));
        this.assertEditable = options.assertEditable || (() => {});
        this.status = { state: "checking", key: "pr.checking", canInstall: canInstallProbeRs(this.platform) };
        this.operation = 0;
        this.installing = null;
    }

    post(status) {
        this.status = { ...status, canInstall: canInstallProbeRs(this.platform) };
        this.onStatus(this.status);
    }

    async refresh(showChecking = true) {
        if (this.installing) return null;
        const executable = this.vscode.workspace.getConfiguration("emberprobe").get("probeRsPath", "probe-rs");
        return this.resolve(executable, showChecking, false);
    }

    async resolve(executable, showChecking = false, revealMissing = true) {
        if (this.installing) {
            if (revealMissing) await this.reveal();
            return null;
        }
        const operation = ++this.operation;
        if (showChecking) this.post({ state: "checking", key: "pr.checking" });
        let status;
        try {
            status = await this.check(executable);
        } catch (error) {
            status = { state: "error", key: "pr.invalid", params: { path: executable }, message: error.message };
        }
        if (operation !== this.operation) return null;
        this.post(status);
        if (status.state === "ready") return status.path || executable;
        if (revealMissing) await this.reveal();
        return null;
    }

    async reveal() {
        await this.vscode.commands?.executeCommand("workbench.view.extension.mcu-vscode-container");
    }

    async configure(executable) {
        this.assertEditable();
        const target = this.vscode.workspace.workspaceFolders?.length
            ? this.vscode.ConfigurationTarget.Workspace
            : this.vscode.ConfigurationTarget.Global;
        await this.vscode.workspace.getConfiguration("emberprobe").update("probeRsPath", executable, target);
    }

    async installAndConfigure() {
        const operation = ++this.operation;
        const previousPath = this.vscode.workspace.getConfiguration("emberprobe").get("probeRsPath", "probe-rs");
        const report = (status) => {
            if (operation === this.operation) this.post({ state: "installing", ...status });
        };
        report({ key: "pr.installing" });
        try {
            return await this.vscode.window.withProgress(
                {
                    location: this.vscode.ProgressLocation.Notification,
                    title: this.t("pr.installTitle"),
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ message: this.t("pr.installing") });
                    await this.install({
                        platform: this.platform,
                        onLine: (line) => {
                            report({ key: "pr.installOutput", params: { message: line } });
                            progress.report({ message: line });
                        }
                    });
                    report({ key: "pr.verifying" });
                    progress.report({ message: this.t("pr.verifying") });
                    let verified;
                    let executable;
                    for (const candidate of [...this.candidates(), "probe-rs"]) {
                        const status = await this.check(candidate);
                        if (status.state === "ready") {
                            verified = status;
                            executable = status.path || candidate;
                            break;
                        }
                    }
                    if (!verified) throw new Error(this.t("pr.verifyFailed"));
                    if (operation !== this.operation) return null;
                    if (
                        this.vscode.workspace.getConfiguration("emberprobe").get("probeRsPath", "probe-rs") !==
                        previousPath
                    )
                        throw new Error(this.t("pr.pathChanged"));
                    await this.configure(executable);
                    this.post({ ...verified, key: "pr.installedReady" });
                    this.vscode.window.showInformationMessage?.(this.t("pr.installedReady", verified.params));
                    return executable;
                }
            );
        } catch (error) {
            if (operation === this.operation)
                this.post({ state: "error", key: "pr.installFailed", params: { error: error.message } });
            return null;
        }
    }

    async handleAction(action) {
        if (this.installing) return action === "install" ? this.installing : null;
        if (action === "install") {
            this.assertEditable();
            const pending = this.installAndConfigure();
            this.installing = pending;
            try {
                return await pending;
            } finally {
                this.installing = null;
            }
        }
        if (action !== "select") return this.refresh(true);
        this.assertEditable();
        const operation = ++this.operation;
        const previousPath = this.vscode.workspace.getConfiguration("emberprobe").get("probeRsPath", "probe-rs");
        const selected = await this.vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            openLabel: this.t("sb.selectPath"),
            title: this.t("pr.selectPath")
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
        if (this.vscode.workspace.getConfiguration("emberprobe").get("probeRsPath", "probe-rs") !== previousPath)
            return this.refresh(true);
        if (status.state !== "ready") {
            this.post(status);
            return null;
        }
        await this.configure(executable);
        this.post(status);
        return executable;
    }
}

module.exports = { checkProbeRs, ProbeRsStatusService };
