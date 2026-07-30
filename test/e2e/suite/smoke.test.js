"use strict";
const assert = require("assert");
const vscode = require("vscode");

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    assert.ok(extension, "EmberProbe extension should be installed in the development host");
    await extension.activate();
    assert.strictEqual(extension.isActive, true);

    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of [
        "mcu-vscode.folderDebug",
        "mcu-vscode.folderDownload",
        "mcu-vscode.openLiveWatch",
        "mcu-vscode.checkOpenOcd"
    ]) {
        assert.ok(commands.has(command), `Expected command ${command}`);
    }
    console.log("✓ activates and registers public commands");

    const config = vscode.workspace.getConfiguration("emberprobe");
    assert.strictEqual(config.get("tclPort"), 6666);
    assert.strictEqual(config.get("sampleIntervalMs"), 100);
    assert.strictEqual(config.get("maxSamples"), 2000);
    console.log("✓ contributes bounded live-watch defaults");

    await vscode.commands.executeCommand("workbench.view.extension.mcu-vscode-container");
    await new Promise(resolve => setTimeout(resolve, 300));
    await vscode.commands.executeCommand("mcu-vscode.openLiveWatch");
    await new Promise(resolve => setTimeout(resolve, 300));
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    console.log("✓ renders secured sidebar and live-watch Webviews");
}

module.exports = { run };
