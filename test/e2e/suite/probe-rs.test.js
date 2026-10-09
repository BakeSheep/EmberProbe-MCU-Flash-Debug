"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const vscode = require("vscode");

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    const provider = extension.exports.debugTestProvider;
    const folder = vscode.workspace.workspaceFolders[0];
    const settings = vscode.workspace.getConfiguration("emberprobe");
    const keys = ["backend", "probeRsPath", "probeRsChip"];
    const previous = keys.map((key) => settings.inspect(key).globalValue);
    const previousElf = provider._context.workspaceState.get("mcu.elfPath");
    const previousList = provider._context.workspaceState.get("mcu.sidebarWatchList");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-probe-rs-e2e-"));
    const elf = path.join(extension.extensionPath, "test/fixtures/rust-globals.elf");
    const fixture = path.join(extension.extensionPath, "test/fixtures/fake-probe-rs-adapter.js");
    // The real owned process receives the normal "dap-server" argument. Node
    // interprets this file in cwd, so the production factory needs no test hook.
    fs.writeFileSync(path.join(temp, "dap-server"), `require(${JSON.stringify(fixture)});\n`);
    const waitFor = async (predicate) => {
        const deadline = Date.now() + 15000;
        while (!predicate()) {
            assert.ok(Date.now() < deadline, "probe-rs Extension Host event timed out");
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    };
    let session;
    try {
        await settings.update("backend", "probe-rs", vscode.ConfigurationTarget.Global);
        await settings.update("probeRsPath", process.env.EMBERPROBE_E2E_NODE_PATH, vscode.ConfigurationTarget.Global);
        await settings.update("probeRsChip", "", vscode.ConfigurationTarget.Global);
        await provider._context.workspaceState.update("mcu.elfPath", elf);
        await provider._refreshElfBindings();
        const parsed = await provider._elfService.ready();
        const gain = parsed.symbols.find((symbol) => symbol.displayName === "rust_globals::GAIN");
        assert.ok(gain);
        await provider._saveWatchList("mcu.sidebarWatchList", [{ ...gain, type: "u32", size: 4 }]);
        const config = {
            name: "probe-rs process ownership E2E",
            type: "emberprobe-probe-rs",
            request: "attach",
            cwd: temp,
            chip: "STM32F407ZG",
            executable: elf
        };
        const download = provider._probeCoordinator.acquire("download");
        try {
            await assert.rejects(provider.prepareProbeRsDebug(folder, config), { code: "PROBE_BUSY" });
        } finally {
            download.release();
        }
        assert.equal(await vscode.debug.startDebugging(folder, config), true);
        await waitFor(() => provider._debugBridge.runtimeProbeRs);
        session = provider._debugBridge.activeSession;
        assert.equal(provider._probeCoordinator.isActive("debugServer"), true);
        assert.equal(provider._probeRsAdapters.size, 1);
        const chip = await provider.readChipInfoAction(true);
        assert.equal(chip.core, "Cortex-M4");
        assert.equal(chip.chip, config.chip);
        await provider.startLiveWatch(undefined, 100, "sidebar", false);
        await waitFor(() => provider._debugBridge.canWrite);
        const written = await provider._writeUiVariable(gain.name, 123);
        assert.equal(written.results[0].verified, true);
        await assert.rejects(
            provider._withAgentProbe(({ session: bridge }) =>
                bridge.readOnce([{ name: "MMIO", address: 0x40000000, size: 4 }])
            ),
            { code: "LIVE_ADDRESS_NOT_RAM" }
        );
        await provider._context.workspaceState.update("mcu.elfPath", __filename);
        await assert.rejects(provider._writeUiVariable(gain.name, 1), { code: "DEBUG_ELF_SESSION_MISMATCH" });
        await provider._context.workspaceState.update("mcu.elfPath", elf);
        await provider.stopLiveWatch();
        await vscode.debug.stopDebugging(session);
        await waitFor(() => !provider._probeRsAdapters.size && !provider._debugBridge.hasAnySession);
        assert.equal(provider._probeCoordinator.anyActive(), false);
        await settings.update("probeRsChip", config.chip, vscode.ConfigurationTarget.Global);
        await provider.startLiveWatch(undefined, 100, "sidebar");
        await waitFor(() => provider._debugBridge.runtimeProbeRs);
        assert.equal(provider._debugBridge.activeSession.configuration.__emberprobeWatchOnly, true);
        assert.equal(await provider._startProbeRsDebug("attach", folder.uri, false, config), true);
        await waitFor(
            () =>
                provider._debugBridge.runtimeProbeRs &&
                !provider._debugBridge.activeSession.configuration.__emberprobeWatchOnly
        );
        session = provider._debugBridge.activeSession;
        await provider.stopLiveWatch();
        await vscode.debug.stopDebugging(session);
        await waitFor(() => !provider._probeRsAdapters.size && !provider._debugBridge.hasAnySession);
        assert.equal(provider._probeCoordinator.anyActive(), false);
        console.log(
            "✓ native probe-rs F5: owned process, launch chip, runtime RAM guards, ELF rejection and lease release"
        );
    } finally {
        await provider.stopLiveWatch();
        if (session) await vscode.debug.stopDebugging(session);
        for (let i = 0; i < keys.length; i++)
            await settings.update(keys[i], previous[i], vscode.ConfigurationTarget.Global);
        await provider._context.workspaceState.update("mcu.elfPath", previousElf);
        await provider._context.workspaceState.update("mcu.sidebarWatchList", previousList);
        await provider._refreshElfBindings();
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

module.exports = { run };
