"use strict";

class SamplingConfiguration {
    constructor({ host, vscode }) {
        this.host = host;
        this.vscode = vscode;
    }
    async selectBackend() {
        this.host._assertConnectionEditable({ mcu: true });
        const config = this.vscode.workspace.getConfiguration("emberprobe");
        const current = config.get("samplingBackend", "openocd");
        const options = [
            { label: "OpenOCD", value: "openocd", description: this.host._t("native.openocdFeatures") },
            { label: "probe-rs", value: "probe-rs", description: this.host._t("native.readOnlyFeatures") }
        ];
        for (const option of options) option.picked = option.value === current;
        const selected = await this.vscode.window.showQuickPick(options, {
            placeHolder: this.host._t("native.chooseBackend")
        });
        if (!selected) return null;
        this.host._assertConnectionEditable({ mcu: true });
        if (this.vscode.workspace.getConfiguration("emberprobe").get("samplingBackend", "openocd") !== current)
            return null;
        await config.update("samplingBackend", selected.value, this.vscode.ConfigurationTarget.Workspace);
        await this.host.updateView();
        return true;
    }
    async selectChip() {
        this.host._assertConnectionEditable({ mcu: true });
        const config = this.vscode.workspace.getConfiguration("emberprobe");
        const current = config.get("probeRsChip", "");
        const description = config.get("probeRsTargetDescription", "");
        const helper = config.get("probeRsNativePath", "");
        const chips = await this.host._nativeSamplingService.listChips(this.host._commandContext().cwd);
        this.host._assertConnectionEditable({ mcu: true });
        const options = chips.map((chip) => ({
            label: chip.name,
            description: chip.family,
            detail: chip.core,
            picked: chip.name === current
        }));
        // Keep the current target at the top without guessing a model from an OpenOCD family script.
        options.sort((a, b) => Number(b.picked) - Number(a.picked) || a.label.localeCompare(b.label));
        const selected = await this.vscode.window.showQuickPick(options, {
            placeHolder: this.host._t("native.chooseChip"),
            matchOnDescription: true,
            matchOnDetail: true
        });
        if (!selected) return null;
        this.host._assertConnectionEditable({ mcu: true });
        const latest = this.vscode.workspace.getConfiguration("emberprobe");
        if (
            latest.get("probeRsChip", "") !== current ||
            latest.get("probeRsTargetDescription", "") !== description ||
            latest.get("probeRsNativePath", "") !== helper
        )
            return null;
        await config.update("probeRsChip", selected.label, this.vscode.ConfigurationTarget.Workspace);
        await this.host.updateView();
        return true;
    }
}
module.exports = { SamplingConfiguration };
