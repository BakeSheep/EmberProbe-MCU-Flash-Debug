"use strict";

class OpenOcdStatusService {
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.checker = options.checker;
        this.getLang = options.getLang;
        this.onStatus = options.onStatus;
        this.status = { state: "checking", key: "oc.checking", canInstall: false };
        this.operation = 0;
        this.probes = new Map();
    }

    post(status) {
        this.status = { ...this.status, ...status };
        this.onStatus(this.status);
    }

    reporter(operation) {
        return (status) => {
            if (operation === this.operation) this.post(status);
        };
    }

    probe(target) {
        const key = String(target || "openocd");
        const existing = this.probes.get(key);
        if (existing) return existing;
        const pending = Promise.resolve(this.checker.probeOpenOcd(target)).finally(() => {
            if (this.probes.get(key) === pending) this.probes.delete(key);
        });
        this.probes.set(key, pending);
        return pending;
    }

    async refresh(showChecking = true) {
        const operation = ++this.operation;
        const report = this.reporter(operation);
        const target = this.vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd");
        if (showChecking) report({ state: "checking", key: "oc.checking" });
        const result = await this.probe(target);
        if (operation !== this.operation) return null;
        this.checker.setCache(result);
        return this.checker.resolveOpenOcdStatus(target, this.context, result, report);
    }

    async handleAction(action) {
        if (action !== "install" && action !== "select") return this.refresh(true);
        const operation = ++this.operation;
        const report = this.reporter(operation);
        if (action === "install") {
            const resolved = await this.checker.installBundledAndConfigure(
                this.vscode,
                this.context,
                report,
                this.getLang()
            );
            if (!resolved && this.status.state === "installing") await this.refresh(false);
            return resolved;
        }
        const resolved = await this.checker.pickOpenOcdPath(this.vscode, this.context, report, this.getLang());
        return resolved;
    }

    async resolve(executable) {
        const operation = ++this.operation;
        const report = this.reporter(operation);
        const target = executable && String(executable).trim();
        const cached = this.checker.getCachedResult();
        if (this.checker.isCompatibleResult(cached) && (cached.requested || cached.path) === target) {
            report({
                state: "ready",
                key: cached.version ? "oc.readyVer" : "oc.ready",
                params: { version: cached.version },
                result: cached
            });
            return cached.path;
        }
        const result = await this.probe(target);
        this.checker.setCache(result);
        const resolved = await this.checker.resolveOpenOcdStatus(target, this.context, result, report);
        if (!resolved && operation === this.operation)
            this.vscode.commands.executeCommand("workbench.view.extension.mcu-vscode-container");
        return resolved;
    }
}

module.exports = { OpenOcdStatusService };
