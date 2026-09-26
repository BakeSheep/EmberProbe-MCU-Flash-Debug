"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

async function waitFor(ready, label) {
    const deadline = Date.now() + 10000;
    while (!ready()) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function run() {
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    assert.ok(extension, "EmberProbe extension should be installed in the development host");
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspace, "E2E workspace should be available");
    assert.ok(
        !fs.existsSync(path.join(workspace, ".emberprobe")),
        "activation alone must not create a workspace .emberprobe directory"
    );

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

    const { Worker } = require("worker_threads");
    const worker = new Worker(path.join(extension.extensionPath, "dist", "samplingWorker.js"), { workerData: {} });
    try {
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Packaged sampling worker did not respond")), 5000);
            worker.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            worker.once("message", (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            worker.postMessage({ id: 1, method: "waitForIdle", args: [100] });
        });
        assert.equal(result.id, 1);
        assert.equal(result.result, true);
        console.log("✓ packaged sampling worker starts independently without hardware");
    } finally {
        await worker.terminate();
    }

    const elfWorker = new Worker(path.join(extension.extensionPath, "dist", "elfWorker.js"), {
        workerData: { path: path.join(workspace, "missing-firmware.elf") }
    });
    try {
        const response = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Packaged ELF worker did not respond")), 5000);
            elfWorker.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            elfWorker.once("message", (message) => {
                clearTimeout(timer);
                resolve(message);
            });
        });
        assert.strictEqual(response.type, "failed");
        assert.strictEqual(response.error.code, "ELF_READ_FAILED");
        console.log("✓ packaged ELF worker starts independently without hardware");
    } finally {
        await elfWorker.terminate();
    }

    await vscode.commands.executeCommand("workbench.view.extension.mcu-vscode-container");
    await waitFor(() => extension.exports.viewState().sidebar, "sidebar renderer");
    assert.ok(
        !fs.existsSync(path.join(workspace, ".emberprobe")),
        "opening the EmberProbe view without workspace Skills must not create .emberprobe"
    );
    await vscode.commands.executeCommand("mcu-vscode.openLiveWatch");
    await waitFor(() => extension.exports.viewState().graph, "graph renderer");
    assert.ok(
        !fs.existsSync(path.join(workspace, ".emberprobe")),
        "ordinary EmberProbe commands without workspace Skills must not create .emberprobe"
    );
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    console.log("✓ renders secured sidebar and live-watch Webviews");
}

module.exports = { run };
