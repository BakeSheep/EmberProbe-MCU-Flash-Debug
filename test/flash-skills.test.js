"use strict";
// mcu-download / mcu-flash-verify 两个 Agent Skill 的跨平台测试：
// 通过 fake Agent Bridge 提供 EmberProbe 配置，用假 OpenOCD 可执行文件验证预检与执行路径。
// Windows 上 Node 以 shell:false spawn .cmd/.sh 脚本会失败（EINVAL），因此 --execute 场景
// 仅在 Unix 上运行；预检部分是纯 Node 逻辑，全平台执行。
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { AgentBridge } = require("../src/agentBridge");

const execFileAsync = promisify(execFile);
const canRunFakeOpenOcd = process.platform !== "win32";

function makeFakeOpenOcd(dir) {
    if (process.platform === "win32") {
        const file = path.join(dir, "fake-openocd.cmd");
        fs.writeFileSync(file, "@echo off\r\necho ARGS:%*\r\necho EP_VERIFY OK\r\nexit /b 0\r\n");
        return file;
    }
    const file = path.join(dir, "fake-openocd.sh");
    fs.writeFileSync(file, "#!/bin/sh\necho \"ARGS:$@\"\necho \"EP_VERIFY OK\"\nexit 0\n");
    fs.chmodSync(file, 0o755);
    return file;
}

function firstJsonLine(stdout) {
    return JSON.parse(stdout.trim().split(/\r?\n/)[0]);
}

function lastJsonLine(stdout) {
    const lines = stdout.trim().split(/\r?\n/).filter(line => line.trim().startsWith("{"));
    return JSON.parse(lines[lines.length - 1]);
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-flash-skills-"));
    const elf = path.join(root, "firmware.elf");
    fs.writeFileSync(elf, "test firmware");
    const fakeOpenOcd = makeFakeOpenOcd(root);

    const bridge = new AgentBridge(root, async method => {
        if (method !== "config.get") throw Object.assign(new Error(`Unexpected method: ${method}`), { code: "METHOD_NOT_FOUND" });
        return {
            elf,
            debugger: "cmsis-dap.cfg",
            mcu: "geehy/apm32f4x.cfg",
            openocdPath: fakeOpenOcd
        };
    });

    const run = (script, extra = []) => execFileAsync(process.execPath, [
        path.resolve(__dirname, "../skills", script), "--workspace", root, ...extra
    ]);

    try {
        await bridge.start();

        const downloadPreflight = firstJsonLine((await run("mcu-download/scripts/download.js")).stdout);
        assert.strictEqual(downloadPreflight.elf, elf);
        assert.strictEqual(downloadPreflight.target, "geehy/apm32f4x.cfg");
        assert.strictEqual(downloadPreflight.probe, "cmsis-dap.cfg");
        assert.strictEqual(downloadPreflight.openocd, fakeOpenOcd);
        assert.strictEqual(downloadPreflight.ready, true);
        assert.ok(/^[0-9a-f]{64}$/.test(downloadPreflight.elfSha256));

        const verifyPreflight = firstJsonLine((await run("mcu-flash-verify/scripts/verify.js")).stdout);
        assert.strictEqual(verifyPreflight.target, "geehy/apm32f4x.cfg");
        assert.strictEqual(verifyPreflight.probe, "cmsis-dap.cfg");
        assert.strictEqual(verifyPreflight.openocd, fakeOpenOcd);

        if (canRunFakeOpenOcd) {
            const verified = lastJsonLine((await run("mcu-flash-verify/scripts/verify.js", ["--execute"])).stdout);
            assert.strictEqual(verified.verified, true);
            assert.strictEqual(verified.elf, elf);
            assert.strictEqual(verified.elfSha256, downloadPreflight.elfSha256);

            const downloaded = await run("mcu-download/scripts/download.js", ["--execute"]);
            assert.ok(downloaded.stdout.includes("verify reset exit"), "OpenOCD should receive the program command");
            assert.ok(downloaded.stdout.includes("EP_VERIFY OK"));
        }

        // bridge 不可用时降级为工作区自动检测；大写扩展名的 ELF 也必须被发现（Linux 大小写敏感）
        const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-flash-skills-bare-"));
        try {
            const upperElf = path.join(bareRoot, "APP.ELF");
            fs.writeFileSync(upperElf, "upper case elf");
            const bare = await execFileAsync(process.execPath, [
                path.resolve(__dirname, "../skills/mcu-download/scripts/download.js"),
                "--workspace", bareRoot, "--probe", "stlink.cfg", "--target", "stm32f4x.cfg"
            ]);
            const bareJson = firstJsonLine(bare.stdout);
            assert.strictEqual(bareJson.elf, upperElf);
            assert.strictEqual(bareJson.ready, true);
        } finally {
            fs.rmSync(bareRoot, { recursive: true, force: true });
        }

        console.log("Flash skill tests passed");
    } finally {
        await bridge.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
