"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const vscode = require("vscode");

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    const provider = extension.exports.debugTestProvider;
    const folder = vscode.workspace.workspaceFolders[0];
    const cfg = vscode.workspace.getConfiguration("emberprobe", folder.uri);
    const keys = [
        "experimental.externalGdb.enabled",
        "experimental.externalGdb.target",
        "experimental.externalGdb.connectionMode"
    ];
    const previous = keys.map((key) => cfg.inspect(key).workspaceFolderValue);
    const settingsFile = path.join(folder.uri.fsPath, ".vscode", "settings.json");
    const settingsBefore = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-external-e2e-"));
    const suffix = process.platform === "win32" ? ".exe" : "";
    const objdump = path.join(temp, "arm-none-eabi-objdump" + suffix);
    fs.writeFileSync(objdump, "fixture");
    fs.chmodSync(objdump, 0o755);
    const originals = new Map();
    for (const name of ["_resolveOpenOcdPath", "_startManagedDebugServer"]) {
        originals.set(name, provider[name]);
        provider[name] = () => {
            throw new Error("External attach entered the OpenOCD path");
        };
    }
    const descriptor = vscode.debug.registerDebugAdapterDescriptorFactory("emberprobe", {
        createDebugAdapterDescriptor() {
            return new vscode.DebugAdapterExecutable(
                process.execPath,
                [path.join(extension.extensionPath, "test/fixtures/fake-debug-adapter.js")],
                { env: { ELECTRON_RUN_AS_NODE: "1" } }
            );
        }
    });
    const wait = async (predicate) => {
        const deadline = Date.now() + 15000;
        while (!predicate()) {
            assert(Date.now() < deadline, "External E2E event timed out");
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    };
    let session;
    try {
        await cfg.update(keys[0], true, vscode.ConfigurationTarget.WorkspaceFolder);
        await cfg.update(keys[1], "localhost:3333", vscode.ConfigurationTarget.WorkspaceFolder);
        await cfg.update(keys[2], "remote", vscode.ConfigurationTarget.WorkspaceFolder);
        assert(
            await vscode.debug.startDebugging(folder, {
                type: "emberprobe",
                name: "External hardware-free attach",
                request: "attach",
                servertype: "external",
                executable: __filename,
                cwd: temp,
                gdbPath: process.execPath,
                objdumpPath: objdump
            })
        );
        await wait(() => provider._externalDebug.active && provider._debugBridge.paused);
        session = provider._debugBridge.activeSession;
        assert.strictEqual(session.configuration.gdbTarget, "localhost:3333");
        assert.strictEqual(session.configuration.__emberprobeExternalMode, "remote");
        assert.strictEqual(provider._debugBridge.capabilities.restart, false);
        assert.strictEqual(provider._managedDebugServer, null);
        assert.strictEqual((await session.customRequest("threads", {})).threads[0].id, 1);
        await vscode.debug.stopDebugging(session);
        await wait(() => !provider._externalDebug.active);
        assert(provider._externalDebug.held);
        assert(provider._externalDebug.marker.cleanupConfirmed);
        await cfg.update(keys[0], false, vscode.ConfigurationTarget.WorkspaceFolder);
        await wait(() => !provider._externalDebug.held);
        assert.strictEqual(provider._liveSession, null);
        console.log(
            "✓ external F5 attach resolves native settings, disables restart and retains ownership until disabled"
        );
    } finally {
        if (provider._externalDebug.active && session) await vscode.debug.stopDebugging(session);
        await cfg.update(keys[0], false, vscode.ConfigurationTarget.WorkspaceFolder);
        await provider.externalDebugSettingsChanged();
        for (let i = 0; i < keys.length; i++)
            await cfg.update(keys[i], previous[i], vscode.ConfigurationTarget.WorkspaceFolder);
        if (settingsBefore) fs.writeFileSync(settingsFile, settingsBefore);
        else {
            if (fs.existsSync(settingsFile)) fs.unlinkSync(settingsFile);
            const settingsDir = path.dirname(settingsFile);
            if (fs.existsSync(settingsDir) && !fs.readdirSync(settingsDir).length) fs.rmdirSync(settingsDir);
        }
        descriptor.dispose();
        for (const [name, value] of originals) provider[name] = value;
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
module.exports = { run };
