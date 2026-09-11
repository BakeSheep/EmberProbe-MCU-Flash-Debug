"use strict";
// mcu-flash Agent Skill 中编程/校验两个入口的跨平台测试：
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
const { FlashAuthorization } = require("../src/flashAuthorization");
const flashCommon = require("../skills/_emberprobe/flash-common");

const execFileAsync = promisify(execFile);
const canRunFakeOpenOcd = process.platform !== "win32";

function makeFakeOpenOcd(dir) {
    const bin = path.join(dir, "bin");
    const scripts = path.join(dir, "openocd", "scripts");
    fs.mkdirSync(path.join(scripts, "interface"), { recursive: true });
    fs.mkdirSync(path.join(scripts, "target", "geehy"), { recursive: true });
    fs.writeFileSync(path.join(scripts, "interface", "cmsis-dap.cfg"), "");
    fs.writeFileSync(path.join(scripts, "target", "geehy", "apm32f4x.cfg"), "");
    fs.mkdirSync(bin, { recursive: true });
    if (process.platform === "win32") {
        const file = path.join(bin, "fake-openocd.cmd");
        fs.writeFileSync(
            file,
            "@echo off\r\necho Open On-Chip Debugger 0.12.0\r\necho ARGS:%*\r\necho EP_VERIFY OK\r\nexit /b 0\r\n"
        );
        return file;
    }
    const file = path.join(bin, "fake-openocd.sh");
    fs.writeFileSync(
        file,
        '#!/bin/sh\necho "Open On-Chip Debugger 0.12.0"\necho "ARGS:$@"\necho "EP_VERIFY OK"\nexit 0\n'
    );
    fs.chmodSync(file, 0o755);
    return file;
}

function firstJsonLine(stdout) {
    return JSON.parse(stdout.trim().split(/\r?\n/)[0]);
}

function lastJsonLine(stdout) {
    const lines = stdout
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith("{"));
    return JSON.parse(lines[lines.length - 1]);
}

(async () => {
    assert.strictEqual(flashCommon.parseOpenOcdVersion("Open On-Chip Debugger 0.11.0-rc2"), "0.11.0-rc2");
    assert.strictEqual(flashCommon.parseOpenOcdVersion("xPack OpenOCD 0.12.0-7"), "0.12.0-7");
    assert.strictEqual(flashCommon.checkOpenOcdVersion("0.11.0").compatible, false);
    assert.strictEqual(flashCommon.checkOpenOcdVersion("0.12.0-7").compatible, true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-flash-skills-"));
    const elf = path.join(root, "firmware.elf");
    fs.writeFileSync(elf, "test firmware");
    const fakeOpenOcd = makeFakeOpenOcd(root);

    const flashAuthorization = new FlashAuthorization();
    const { AgentFlashService } = require("../src/services/agentFlashService");
    const { ProbeCoordinator } = require("../src/probeCoordinator");
    const executor = new AgentFlashService({
        coordinator: new ProbeCoordinator(),
        authorization: flashAuthorization,
        isDebugActive: () => false
    });
    const bridge = new AgentBridge(
        root,
        async (method, params) => {
            if (method === "config.get") {
                return {
                    elf,
                    debugger: "cmsis-dap.cfg",
                    mcu: "geehy/apm32f4x.cfg",
                    openocdPath: fakeOpenOcd
                };
            }
            if (method === "flash.execute") return executor.execute(params);
            if (method === "flash.verify") return executor.execute(params, true);
            if (method === "flash.authorize") {
                return flashAuthorization.authorize(
                    {
                        elf: { path: params.elf, sha256: params.elfSha256 },
                        target: params.target,
                        probe: params.probe,
                        openocd: params.openocd
                    },
                    params.confirmationId
                );
            }
            throw Object.assign(new Error(`Unexpected method: ${method}`), { code: "METHOD_NOT_FOUND" });
        },
        path.join(root, ".global-storage")
    );

    const run = (script, extra = []) =>
        execFileAsync(process.execPath, [path.resolve(__dirname, "../skills", script), "--workspace", root, ...extra]);

    try {
        await bridge.start();

        const downloadPreflight = firstJsonLine((await run("mcu-flash/scripts/program.js")).stdout);
        assert.strictEqual(downloadPreflight.elf, elf);
        assert.strictEqual(downloadPreflight.target, "geehy/apm32f4x.cfg");
        assert.strictEqual(downloadPreflight.probe, "cmsis-dap.cfg");
        assert.strictEqual(downloadPreflight.openocd, fakeOpenOcd);
        if (canRunFakeOpenOcd) {
            assert.strictEqual(downloadPreflight.openocdVersion, "0.12.0");
            assert.strictEqual(downloadPreflight.openocdCompatible, true);
        }
        assert.strictEqual(downloadPreflight.ready, true);
        assert.ok(/^[0-9a-f]{64}$/.test(downloadPreflight.elfSha256));
        assert.strictEqual(downloadPreflight.flashAuthorization.confirmationRequired, true);
        // 任务2：配置成功时来源标记为 config，且没有降级诊断
        assert.deepStrictEqual(downloadPreflight.diagnostics, []);
        assert.deepStrictEqual(downloadPreflight.sources, {
            elf: "config",
            target: "config",
            probe: "config",
            openocd: "config"
        });

        const verifyPreflight = firstJsonLine((await run("mcu-flash/scripts/verify.js")).stdout);
        assert.strictEqual(verifyPreflight.target, "geehy/apm32f4x.cfg");
        assert.strictEqual(verifyPreflight.probe, "cmsis-dap.cfg");
        assert.strictEqual(verifyPreflight.openocd, fakeOpenOcd);

        if (canRunFakeOpenOcd) {
            const verifyRun = await run("mcu-flash/scripts/verify.js", ["--execute"]);
            const verified = lastJsonLine(verifyRun.stdout);
            assert.strictEqual(verified.verified, true);
            assert.strictEqual(verified.elf, elf);
            assert.strictEqual(verified.elfSha256, downloadPreflight.elfSha256);
            assert.ok(
                verifyRun.stdout.includes("-work-area-size 0"),
                "verify should force host-side comparison without target work-area"
            );

            await assert.rejects(
                run("mcu-flash/scripts/program.js", ["--execute"]),
                (error) => /Flash confirmation is required/.test(error.stderr || ""),
                "download execution must not rely on --execute alone"
            );
            const downloaded = await run("mcu-flash/scripts/program.js", [
                "--execute",
                "--confirmation-id",
                downloadPreflight.flashAuthorization.confirmationId
            ]);
            assert.ok(downloaded.stdout.includes("verify reset exit"), "OpenOCD should receive the program command");
            assert.ok(
                downloaded.stdout.includes("-work-area-backup 1"),
                "download should preserve target RAM used as work-area"
            );
            assert.ok(downloaded.stdout.includes("EP_VERIFY OK"));

            const oldOpenOcd = path.join(root, "bin", "old-openocd.sh");
            fs.writeFileSync(oldOpenOcd, '#!/bin/sh\necho "Open On-Chip Debugger 0.11.0"\nexit 0\n');
            fs.chmodSync(oldOpenOcd, 0o755);
            const oldPreflight = firstJsonLine(
                (await run("mcu-flash/scripts/program.js", ["--openocd", oldOpenOcd])).stdout
            );
            await assert.rejects(
                run("mcu-flash/scripts/program.js", [
                    "--execute",
                    "--openocd",
                    oldOpenOcd,
                    "--confirmation-id",
                    oldPreflight.flashAuthorization.confirmationId
                ]),
                (error) => /Incompatible OpenOCD 0\.11\.0/.test(error.stderr || ""),
                "Agent download must refuse OpenOCD 0.11"
            );
        }

        // bridge 不可用时降级为工作区自动检测；大写扩展名的 ELF 也必须被发现（Linux 大小写敏感）
        const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-flash-skills-bare-"));
        try {
            const upperElf = path.join(bareRoot, "APP.ELF");
            fs.writeFileSync(upperElf, "upper case elf");
            const bare = await execFileAsync(process.execPath, [
                path.resolve(__dirname, "../skills/mcu-flash/scripts/program.js"),
                "--workspace",
                bareRoot,
                "--probe",
                "stlink.cfg",
                "--target",
                "stm32f4x.cfg"
            ]);
            const bareJson = firstJsonLine(bare.stdout);
            assert.strictEqual(bareJson.elf, fs.realpathSync(upperElf));
            assert.strictEqual(bareJson.ready, true);
            // 任务2：Bridge 不可用时降级为自动检测，来源与诊断完整，且不得误报硬件故障
            assert.deepStrictEqual(bareJson.sources, {
                elf: "auto",
                target: "explicit",
                probe: "explicit",
                openocd: "default"
            });
            assert.strictEqual(bareJson.diagnostics.length, 1);
            assert.strictEqual(bareJson.diagnostics[0].error.code, "BRIDGE_UNAVAILABLE");
            assert.ok(
                !/硬件未连接|hardware (?:not connected|disconnected)|probe (?:not connected|disconnected)|not attached/i.test(
                    JSON.stringify(bareJson)
                ),
                "配置不可用不得被解释为硬件未连接"
            );
        } finally {
            fs.rmSync(bareRoot, { recursive: true, force: true });
        }

        // 任务2：配置获取超时但显式参数完整时，预检仍可用，来源标记为 explicit，诊断保留原始超时
        const cfgFailRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-flash-cfgfail-"));
        const cfgFailElf = path.join(cfgFailRoot, "fw.elf");
        fs.writeFileSync(cfgFailElf, "firmware");
        const cfgFailBridge = new AgentBridge(
            cfgFailRoot,
            async (method) => {
                if (method === "config.get")
                    throw Object.assign(new Error("config.get timed out"), {
                        code: "BRIDGE_TIMEOUT",
                        details: { method: "config.get", timeoutMs: 20000, elapsedMs: 20001 }
                    });
                throw Object.assign(new Error(`Unexpected method: ${method}`), { code: "METHOD_NOT_FOUND" });
            },
            path.join(cfgFailRoot, ".global-storage")
        );
        try {
            await cfgFailBridge.start();
            const cfgFailPreflight = await flashCommon.preflight({
                workspace: cfgFailRoot,
                elf: cfgFailElf,
                target: "stm32f4x.cfg",
                probe: "stlink.cfg",
                openocd: path.join(cfgFailRoot, "missing-openocd")
            });
            assert.strictEqual(cfgFailPreflight.diagnostics.length, 1);
            assert.strictEqual(cfgFailPreflight.diagnostics[0].error.code, "BRIDGE_TIMEOUT");
            assert.strictEqual(cfgFailPreflight.diagnostics[0].operation, "config.get");
            assert.deepStrictEqual(cfgFailPreflight.sources, {
                elf: "explicit",
                target: "explicit",
                probe: "explicit",
                openocd: "explicit"
            });
            assert.strictEqual(cfgFailPreflight.ready, true, "配置超时但显式参数完整时预检仍应可用");
        } finally {
            await cfgFailBridge.stop();
            fs.rmSync(cfgFailRoot, { recursive: true, force: true });
        }

        console.log("Flash skill tests passed");
    } finally {
        await bridge.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
