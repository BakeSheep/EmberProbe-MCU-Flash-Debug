"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { AgentBridge } = require("../src/agentBridge");

const execFileAsync = promisify(execFile);

if (process.platform !== "win32") {
    console.log("PowerShell skill tests skipped (Windows only)");
} else (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-powershell-skills-"));
    const elf = path.join(root, "firmware.elf");
    const fakeOpenOcd = path.join(root, "fake-openocd.cmd");
    fs.writeFileSync(elf, "test firmware");
    fs.writeFileSync(fakeOpenOcd, "@echo off\r\necho EP_VERIFY OK\r\nexit /b 0\r\n");

    const bridge = new AgentBridge(root, async method => {
        if (method !== "config.get") throw Object.assign(new Error(`Unexpected method: ${method}`), { code: "METHOD_NOT_FOUND" });
        return {
            elf,
            debugger: "cmsis-dap.cfg",
            mcu: "geehy/apm32f4x.cfg",
            openocdPath: fakeOpenOcd
        };
    });

    const run = script => execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
        "-Workspace", root
    ], { windowsHide: true });

    try {
        await bridge.start();
        const download = await run(path.resolve(__dirname, "../skills/mcu-download/scripts/download.ps1"));
        const downloadPreflight = JSON.parse(download.stdout.trim().split(/\r?\n/)[0]);
        assert.strictEqual(downloadPreflight.elf, elf);
        assert.strictEqual(downloadPreflight.target, "geehy/apm32f4x.cfg");
        assert.strictEqual(downloadPreflight.probe, "cmsis-dap.cfg");
        assert.strictEqual(downloadPreflight.openocd, fakeOpenOcd);
        assert.strictEqual(downloadPreflight.ready, true);

        const verifyScript = path.resolve(__dirname, "../skills/mcu-flash-verify/scripts/verify.ps1");
        const verifyPreflight = await run(verifyScript);
        const verifyConfig = JSON.parse(verifyPreflight.stdout.trim().split(/\r?\n/)[0]);
        assert.strictEqual(verifyConfig.target, "geehy/apm32f4x.cfg");
        assert.strictEqual(verifyConfig.probe, "cmsis-dap.cfg");
        assert.strictEqual(verifyConfig.openocd, fakeOpenOcd);

        const executed = await execFileAsync("powershell.exe", [
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", verifyScript,
            "-Workspace", root, "-Execute"
        ], { windowsHide: true });
        const jsonLines = executed.stdout.trim().split(/\r?\n/).filter(line => line.trim().startsWith("{"));
        const result = JSON.parse(jsonLines[jsonLines.length - 1]);
        assert.strictEqual(result.verified, true, "verify_image command should be built without a .NET format exception");

        console.log("PowerShell skill tests passed");
    } finally {
        await bridge.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
