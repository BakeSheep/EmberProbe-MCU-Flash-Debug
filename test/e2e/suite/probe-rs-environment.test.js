"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    await extension.activate();
    const provider = extension.exports.debugTestProvider;
    const service = provider._probeRsStatusService;
    const settings = vscode.workspace.getConfiguration("emberprobe");
    const keys = ["backend", "probeRsPath", "probeRsChip"];
    const previous = keys.map((key) => settings.inspect(key));
    const check = service.check;
    const install = service.install;
    const candidates = service.candidates;
    const post = provider._postBackendStatus;
    const messages = [];
    const executable = process.env.EMBERPROBE_E2E_NODE_PATH;
    const folder = vscode.workspace.workspaceFolders[0];
    const elf = path.join(extension.extensionPath, "test/fixtures/rust-globals.elf");
    let installations = 0;
    try {
        provider._postBackendStatus = function (backend, status) {
            if (backend === "probe-rs") messages.push(status);
            return post.call(this, backend, status);
        };
        await settings.update("backend", "probe-rs", vscode.ConfigurationTarget.Workspace);
        await settings.update(
            "probeRsPath",
            path.join(folder.uri.fsPath, "missing-probe-rs"),
            vscode.ConfigurationTarget.Workspace
        );
        await vscode.commands.executeCommand("mcu-vscode.checkProbeRs");
        assert.equal(service.status.state, "missing");
        assert.equal(service.status.canInstall, true);
        assert.equal(
            await provider.prepareProbeRsDebug(folder, { request: "attach", chip: "STM32H723VG", executable: elf }),
            undefined
        );
        assert.equal(provider._probeRsAdapters.size, 0);
        assert.equal(provider._probeCoordinator.anyActive(), false);
        // Run the real VS Code progress and configuration flow with a local installer fixture.
        service.install = async ({ onLine }) => {
            installations++;
            onLine("downloading probe-rs-tools fixture");
            await new Promise((resolve) => setTimeout(resolve, 100));
            onLine("installing fixture");
        };
        service.candidates = () => [executable];
        service.check = async (target) =>
            target === executable
                ? { state: "ready", key: "pr.ready", path: target, params: { version: "0.32.0" } }
                : check(target);
        assert.equal(await provider._handleBackendAction("install"), executable);
        assert.equal(installations, 1);
        assert.equal(vscode.workspace.getConfiguration("emberprobe").get("probeRsPath"), executable);
        assert.equal(service.status.state, "ready");
        assert.ok(messages.some((status) => status.key === "pr.installOutput"));
        assert.ok(messages.some((status) => status.key === "pr.verifying"));
        console.log(
            "✓ probe-rs environment: missing F5 guard, official installer flow, VS Code progress and saved path"
        );
    } finally {
        service.check = check;
        service.install = install;
        service.candidates = candidates;
        provider._postBackendStatus = post;
        for (let index = 0; index < keys.length; index++) {
            await settings.update(keys[index], previous[index].workspaceValue, vscode.ConfigurationTarget.Workspace);
            await settings.update(keys[index], previous[index].globalValue, vscode.ConfigurationTarget.Global);
        }
    }
}

module.exports = { run };
