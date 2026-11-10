"use strict";
const path = require("path");
const { discover, installation, workspaceIoc, supportedPlatform } = require("./cubemxEnvironment");
const cubeMx2 = require("./cubemx2Environment");

const PRODUCTS = {
    cubemx: {
        key: "cubemxPath",
        status: "status",
        messages: {
            unsupported: "cubemx.platformUnsupported",
            invalid: "cubemx.invalid",
            ready: "cubemx.ready",
            missing: "cubemx.missing"
        },
        discover,
        installation
    },
    cubemx2: {
        key: "cubemx2Path",
        status: "status2",
        messages: {
            unsupported: "cubemx2.platformUnsupported",
            invalid: "cubemx2.invalid",
            ready: "cubemx2.ready",
            missing: "cubemx2.missing"
        },
        ...cubeMx2
    }
};

class CubeMxConfiguration {
    constructor(options) {
        Object.assign(this, options);
        this.platform = options.platform || process.platform;
        this.vscode = options.vscode;
        this.context = options.context;
        this.changed = options.changed;
        this.t = options.t;
        this.status = "";
        this.status2 = "";
    }
    async refresh() {
        const [tool] = await Promise.all([this.detect(), this.detect("cubemx2")]);
        return tool;
    }
    async detect(kind = "cubemx") {
        const product = PRODUCTS[kind];
        if (!supportedPlatform(this.platform || process.platform)) {
            this[product.status] = this.t(product.messages.unsupported);
            return null;
        }
        const cfg = this.vscode.workspace.getConfiguration("emberprobe");
        const configured = cfg.get(product.key, "");
        let tool;
        try {
            const hint =
                kind === "cubemx"
                    ? this.vscode.workspace
                          .getConfiguration("stm32cube-ide-core.configuration.productSTM32CubeMX")
                          .inspect?.("executablePath")?.globalValue
                    : "";
            tool = configured
                ? await product.installation(configured, { platform: this.platform || process.platform })
                : await product.discover({
                      hints: [hint],
                      platform: this.platform || process.platform,
                      ...(kind === "cubemx2" ? { cubeCli: this.officialCubeCli() } : {})
                  });
        } catch {
            this[product.status] = this.t(product.messages.invalid);
            this.changed();
            return null;
        }
        // Do not overwrite a user selection made while discovery was running.
        if (!configured && tool && !this.vscode.workspace.getConfiguration("emberprobe").get(product.key, ""))
            await cfg.update(product.key, tool.executable, this.vscode.ConfigurationTarget.Global);
        this[product.status] = this.t(tool ? product.messages.ready : product.messages.missing);
        this.changed();
        return tool;
    }
    officialCubeCli() {
        const core = this.vscode.extensions?.getExtension?.("STMicroelectronics.stm32cube-ide-core");
        if (!core?.extensionPath) return undefined;
        return path.join(
            core.extensionPath,
            "resources",
            "binaries",
            this.platform,
            process.arch.replace("x64", "x86_64").replace("arm64", "aarch64"),
            this.platform === "win32" ? "cube.exe" : "cube"
        );
    }
    async selectIoc() {
        const v = this.vscode;
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
        return selected ? true : null;
    }
    async iocCandidates() {
        const files = await this.vscode.workspace.findFiles(
            "**/*.{ioc,IOC,ioc2,IOC2}",
            "{**/node_modules/**,**/.git/**,**/.agents/**,**/build/**,**/dist/**,**/Debug/**,**/Release/**,**/.emberprobe-cubemx-*/**}"
        );
        return (await Promise.all(files.map((file) => workspaceIoc(this.vscode, file.fsPath).catch(() => ""))))
            .filter(Boolean)
            .sort();
    }
    async detectIoc({ interactive = true } = {}) {
        const previous = this.context.workspaceState.get("mcu.iocPath", "");
        if (!interactive && previous) {
            const valid = await workspaceIoc(this.vscode, previous).catch(() => "");
            if (valid) return valid;
        }
        const candidates = await this.iocCandidates();
        let value = candidates[0];
        if (candidates.length > 1 && !interactive) return "";
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
        // Background discovery must not replace a selection made while scanning.
        if (!interactive && this.context.workspaceState.get("mcu.iocPath", "") !== previous)
            return this.context.workspaceState.get("mcu.iocPath", "");
        if (value) {
            await this.context.workspaceState.update("mcu.iocPath", value);
            this.changed();
        }
        return value || "";
    }
}
module.exports = { CubeMxConfiguration };
