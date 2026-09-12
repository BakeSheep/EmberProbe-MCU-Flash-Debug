"use strict";
const path = require("path");
const { discover, installation, workspaceIoc } = require("./cubemxEnvironment");

class CubeMxConfiguration {
    constructor(options) {
        Object.assign(this, options);
        this.vscode = options.vscode;
        this.context = options.context;
        this.changed = options.changed;
        this.t = options.t;
        this.status = "";
    }
    async detect() {
        if (process.platform !== "win32") {
            this.status = this.t("cubemx.windowsOnly");
            return null;
        }
        const cfg = this.vscode.workspace.getConfiguration("emberprobe");
        const configured = cfg.get("cubemxPath", "");
        let tool;
        try {
            const official = this.vscode.workspace.getConfiguration(
                "stm32cube-ide-core.configuration.productSTM32CubeMX"
            );
            const hint = official.inspect?.("executablePath")?.globalValue;
            tool = configured ? await installation(configured) : await discover({ hints: [hint] });
        } catch {
            this.status = this.t("cubemx.invalid");
            this.changed();
            return null;
        }
        // Do not overwrite a user selection made while discovery was running.
        if (!configured && tool && !cfg.get("cubemxPath", ""))
            await cfg.update("cubemxPath", tool.executable, this.vscode.ConfigurationTarget.Global);
        this.status = this.t(tool ? "cubemx.ready" : "cubemx.missing");
        this.changed();
        return tool;
    }
    async select(kind) {
        const v = this.vscode;
        if (kind === "ioc") {
            const files = await this.iocCandidates();
            const selected = await v.window.showQuickPick(
                [
                    ...files.map((value) => ({ label: path.basename(value), description: path.dirname(value), value })),
                    { label: this.t("cubemx.clear"), value: "" }
                ],
                { placeHolder: this.t("cubemx.chooseIoc"), matchOnDescription: true }
            );
            if (selected) {
                await this.context.workspaceState.update("mcu.iocPath", selected.value);
                this.changed();
            }
            return;
        }
        const action = await v.window.showQuickPick([
            { label: this.t("cubemx.select"), action: "select" },
            { label: this.t("cubemx.clear"), action: "clear" }
        ]);
        if (!action) return;
        let value = "";
        if (action.action === "select") {
            const files = await v.window.showOpenDialog({
                canSelectMany: false,
                filters: { "CubeMX executable": ["exe"] }
            });
            if (!files?.[0]) return;
            value = (await installation(files[0].fsPath)).executable;
        }
        await v.workspace.getConfiguration("emberprobe").update("cubemxPath", value, v.ConfigurationTarget.Global);
        this.changed();
    }
    async iocCandidates() {
        const files = await this.vscode.workspace.findFiles(
            "**/*.{ioc,IOC}",
            "{**/node_modules/**,**/.git/**,**/.agents/**,**/build/**,**/dist/**,**/Debug/**,**/Release/**,**/.emberprobe-cubemx-*/**}"
        );
        return (await Promise.all(files.map((file) => workspaceIoc(this.vscode, file.fsPath).catch(() => ""))))
            .filter(Boolean)
            .sort();
    }
    async detectIoc() {
        const candidates = await this.iocCandidates();
        let value = candidates[0];
        if (candidates.length > 1)
            value = (
                await this.vscode.window.showQuickPick(
                    candidates.map((file) => ({
                        label: path.basename(file),
                        description: path.dirname(file),
                        value: file
                    })),
                    { placeHolder: this.t("cubemx.chooseIoc") }
                )
            )?.value;
        if (value) {
            await this.context.workspaceState.update("mcu.iocPath", value);
            this.changed();
        }
        return value || "";
    }
}
module.exports = { CubeMxConfiguration };
