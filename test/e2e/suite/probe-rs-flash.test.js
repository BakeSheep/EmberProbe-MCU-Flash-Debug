"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const vscode = require("vscode");

async function waitFor(predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, "probe-rs flash Extension Host event timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    await extension.activate();
    const provider = extension.exports.debugTestProvider;
    const folder = vscode.workspace.workspaceFolders[0];
    const settings = vscode.workspace.getConfiguration("emberprobe");
    const keys = ["backend", "probeRsPath", "probeRsChip"];
    const previous = keys.map((key) => settings.inspect(key).globalValue);
    const previousElf = provider._context.workspaceState.get("mcu.elfPath");
    const previousList = provider._context.workspaceState.get("mcu.sidebarWatchList");
    const previousCheck = provider._probeRsStatusService.check;
    provider._probeRsStatusService.check = async (executable) =>
        executable === process.env.EMBERPROBE_E2E_NODE_PATH
            ? { state: "ready", key: "pr.ready", path: executable, params: { version: "0.32.0" } }
            : previousCheck(executable);
    const elf = path.join(extension.extensionPath, "test/fixtures/rust-globals.elf");
    const refresh = provider._refreshElfBindings;
    const report = provider._reportDownloadProgress;
    let refreshes = 0;
    const progress = [];
    try {
        await settings.update("backend", "probe-rs", vscode.ConfigurationTarget.Global);
        await settings.update("probeRsPath", process.env.EMBERPROBE_E2E_NODE_PATH, vscode.ConfigurationTarget.Global);
        await settings.update("probeRsChip", "STM32H723VG", vscode.ConfigurationTarget.Global);
        await provider._context.workspaceState.update("mcu.elfPath", elf);
        await provider._refreshElfBindings();
        const parsed = await provider._elfService.ready();
        const gain = parsed.symbols.find((symbol) => symbol.displayName === "rust_globals::GAIN");
        assert.ok(gain);
        await provider._saveWatchList("mcu.sidebarWatchList", [{ ...gain, type: "u32", size: 4 }]);
        await provider.startLiveWatch(undefined, 100, "sidebar", false);
        await waitFor(() => provider._debugBridge.runtimeProbeRs);
        const oldSession = provider._debugBridge.activeSession;
        const oldAdapter = provider._probeRsAdapters.get(oldSession.id);
        assert.equal(oldSession.configuration.__emberprobeWatchOnly, true);
        provider._refreshElfBindings = async function () {
            assert.equal(oldAdapter.exited, true);
            assert.equal(this._probeCoordinator.isActive("download"), true);
            await refresh.call(this);
            assert.equal(this._latestSidebarSamples.size, 0);
            refreshes++;
        };
        provider._reportDownloadProgress = function (event) {
            assert.equal(oldAdapter.exited, true, "the real adapter process exits before starting the CLI");
            assert.equal(this._probeCoordinator.isActive("download"), true);
            progress.push(event);
            return report.call(this, event);
        };
        assert.equal(await provider.commandHandlers["mcu-vscode.download"](folder.uri), true);
        assert.equal(refreshes, 1);
        assert.equal(provider._downloadRunning, false);
        assert.equal(provider._samplingIntent, true);
        await waitFor(
            () => provider._debugBridge.runtimeProbeRs && provider._debugBridge.activeSession.id !== oldSession.id
        );
        assert.equal(provider._debugBridge.activeSession.configuration.__emberprobeWatchOnly, true);
        assert.equal(provider._probeCoordinator.isActive("debugServer"), true);
        assert.ok(progress.some((event) => event.stage === "complete" && event.level === "success"));
        const snapshotEvent = progress.find((event) => event.message?.startsWith("EP_FLASH_SNAPSHOT="));
        assert.ok(snapshotEvent, "the real CLI process reports its private snapshot");
        const snapshot = JSON.parse(snapshotEvent.message.slice("EP_FLASH_SNAPSHOT=".length));
        assert.notEqual(snapshot.snapshot, elf);
        assert.equal(snapshot.sha256, createHash("sha256").update(fs.readFileSync(elf)).digest("hex"));
        assert.equal(fs.existsSync(snapshot.snapshot), false);
        console.log("✓ probe-rs flash: real watch exit, verified snapshot CLI, ELF refresh and automatic reattach");
    } finally {
        provider._refreshElfBindings = refresh;
        provider._probeRsStatusService.check = previousCheck;
        provider._reportDownloadProgress = report;
        await provider.stopLiveWatch();
        await waitFor(() => !provider._probeRsAdapters.size && !provider._debugBridge.hasAnySession);
        for (let index = 0; index < keys.length; index++)
            await settings.update(keys[index], previous[index], vscode.ConfigurationTarget.Global);
        await provider._context.workspaceState.update("mcu.elfPath", previousElf);
        await provider._context.workspaceState.update("mcu.sidebarWatchList", previousList);
        await provider._refreshElfBindings();
    }
}

module.exports = { run };
