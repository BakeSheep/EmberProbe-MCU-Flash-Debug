"use strict";
const { minimalElf } = require("./helpers/elf-fixture");
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
const { canonicalFileSync } = require("../skills/_emberprobe/file-identity");
const flashCommon = require("../skills/_emberprobe/flash-common");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { prepareProbeConnection } = require("../skills/_emberprobe/probe-preflight");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
const { loadProvider } = require("./helpers/load-provider");
const { createAgentRoutes } = require("../src/services/agentRoutes");

function loadFlashModule(file, overrides, processImpl = process) {
    const filename = path.resolve(__dirname, "..", file);
    const localRequire = createRequire(filename);
    const mod = { exports: {} };
    const main = vm.runInThisContext(
        "(function(require,module,exports,process){" +
            fs.readFileSync(filename, "utf8") +
            "\nreturn typeof main === 'function' ? main : undefined;})",
        { filename }
    )((name) => overrides[name] || localRequire(name), mod, mod.exports, processImpl);
    return { exports: mod.exports, main };
}

async function testProbeBinding(root, elf) {
    const devices = ["probe-A", "probe-B"].map((serial) => ({ family: "cmsis-dap", serial, id: serial }));
    const config = {
        elf,
        debugger: "cmsis-dap.cfg",
        mcu: "geehy/apm32f4x.cfg",
        openocdPath: "fixture-openocd",
        probeSerial: "",
        successfulConnection: { version: 1, probe: "cmsis-dap.cfg", probeSerial: "probe-A" }
    };
    const inventory = { available: true, devices, notes: [] };
    const requests = [];
    const Provider = loadProvider();
    const host = Object.create(Provider.prototype);
    Object.assign(host, {
        _configurationStore: {
            snapshot: () => {
                const { successfulConnection, ...settings } = config;
                return settings;
            }
        },
        _svdManager: { peekBound: async () => null },
        _context: {
            workspaceState: {
                // A workspace from an older release has only the legacy success record.
                get: (key) => {
                    assert(["mcu.selectedProbe", "mcu.successfulProbeConnection"].includes(key));
                    return key === "mcu.successfulProbeConnection" ? config.successfulConnection : undefined;
                }
            }
        }
    });
    const routes = createAgentRoutes(host);
    const bridgeCall = async (_workspace, method, params) => {
        if (method === "config.get") return routes[method]();
        if (method === "probe.list") return inventory;
        requests.push({ method, params: JSON.parse(JSON.stringify(params)) });
        const connection = resolveProbeConnection(
            { ...config, ...params, probeSerial: params.probeSerial ?? config.probeSerial },
            inventory
        );
        if (method === "flash.authorize") return { confirmationRequired: true, confirmationId: "fixture-plan" };
        assert(["flash.execute", "flash.verify"].includes(method));
        return { code: 0, verified: true, probeSerial: connection.probeSerial };
    };
    const launch = { executable: config.openocdPath };
    const common = loadFlashModule("skills/_emberprobe/flash-common.js", {
        "./agent-client": { ...require("../skills/_emberprobe/agent-client"), call: bridgeCall },
        "./openocd-launch": {
            ...require("../skills/_emberprobe/openocd-launch"),
            resolveExecutablePath: (value) => value,
            resolveOpenOcdLaunch: () => launch
        },
        "./probe-preflight": {
            prepareProbeConnection: (request, dependencies) =>
                prepareProbeConnection(request, {
                    ...dependencies,
                    resolveLaunch: () => launch,
                    checkCapability: async () => ({ adapterFamily: "cmsis-dap" })
                })
        },
        child_process: {
            spawn: () => {
                const child = new EventEmitter();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.kill = () => {};
                process.nextTick(() => {
                    child.stdout.write("Open On-Chip Debugger 0.12.0\n");
                    child.emit("close", 0);
                });
                return child;
            }
        }
    }).exports;
    const execute = (script, result) => {
        const processImpl = {
            argv: ["node", script, "--workspace", root, "--execute", "--confirmation-id", "fixture-plan"],
            platform: process.platform,
            stdout: { write() {} },
            stderr: { write() {} },
            exit: (code) => {
                throw new Error("Unexpected CLI exit: " + code);
            }
        };
        return loadFlashModule(
            "skills/mcu-flash/scripts/" + script + ".js",
            {
                "../../_emberprobe/flash-common": { ...common, preflight: async () => result, emit() {} },
                "../../_emberprobe/agent-client": { call: bridgeCall }
            },
            processImpl
        ).main();
    };

    const bound = await common.preflight({ workspace: root });
    assert.strictEqual(bound.ready, true, "the remembered probe resolves an inventory with A and B online");
    assert.strictEqual(bound.probeSerial, "probe-A");
    assert.strictEqual(bound.sources.probeSerial, "inventory");
    inventory.devices = [devices[1]];
    const missing = await common.preflight({ workspace: root });
    assert.strictEqual(missing.ready, false, "an unplugged binding never falls back to probe B");
    assert(missing.diagnostics.some((diagnostic) => diagnostic.error.code === "PROBE_SELECTED_NOT_FOUND"));
    assert.strictEqual(requests.length, 0, "failed preflight cannot request flash authorization or execution");

    inventory.devices = devices;
    for (const source of ["inventory", "config", "explicit"]) {
        config.probeSerial = source === "config" ? "probe-B" : "";
        const result = await common.preflight({
            workspace: root,
            ...(source === "explicit" ? { "probe-serial": "probe-B" } : {})
        });
        assert.strictEqual(result.ready, true);
        assert.strictEqual(result.sources.probeSerial, source);
        const authorization = await common.authorizeFlash(result);
        assert.strictEqual(authorization.confirmationRequired, true, "preflight still requires human approval");
        assert.strictEqual(authorization.authorized, undefined);
        for (const script of ["verify", "program"]) await execute(script, result);
        for (const request of requests.slice(-3)) {
            assert.strictEqual(request.params.probeSerial, source === "inventory" ? undefined : "probe-B");
            if (source === "inventory") assert.strictEqual(Object.hasOwn(request.params, "probeSerial"), false);
        }
        assert.strictEqual(requests.at(-1).params.confirmationId, "fixture-plan");
    }

    // Detection reports the preflight even when no verification plan can be issued.
    {
        const result = await common.preflight({ workspace: root, "probe-serial": "probe-B" });
        assert.strictEqual(result.ready, true);
        const detect = (preflightResult, authorizeFlash) => {
            const written = [];
            const processImpl = {
                argv: ["node", "verify.js", "--workspace", root],
                platform: process.platform,
                stdout: { write() {} },
                stderr: { write() {} },
                exit: (code) => {
                    throw Object.assign(new Error("CLI exit " + code), { written });
                }
            };
            const main = loadFlashModule(
                "skills/mcu-flash/scripts/verify.js",
                {
                    "../../_emberprobe/flash-common": {
                        ...common,
                        preflight: async () => preflightResult,
                        emit: (value) => written.push(value),
                        authorizeFlash
                    },
                    "../../_emberprobe/agent-client": { call: bridgeCall }
                },
                processImpl
            ).main;
            return main().then(() => written);
        };
        const busy = Object.assign(new Error("The debug probe is busy"), { code: "PROBE_BUSY" });
        await assert.rejects(
            detect(result, async () => {
                throw busy;
            }),
            (error) => {
                assert.match(error.message, /CLI exit 1/);
                assert.strictEqual(error.written.length, 1);
                assert.strictEqual(error.written[0].elf, result.elf);
                assert.deepStrictEqual(error.written[0].verificationAuthorizationError, {
                    code: "PROBE_BUSY",
                    message: busy.message
                });
                return true;
            }
        );
        const incompatible = await detect({ ...result, openocdCompatible: false }, async () =>
            assert.fail("an incompatible OpenOCD must not request a verification plan")
        );
        assert.strictEqual(incompatible.length, 1);
        assert.strictEqual(incompatible[0].verificationAuthorization, undefined);
    }

    config.probeSerial = "";
    config.successfulConnection = undefined;
    inventory.devices = [devices[1]];
    const detected = await common.preflight({ workspace: root });
    assert.strictEqual(detected.ready, true);
    assert.strictEqual(detected.probeSerial, "probe-B");
    config.successfulConnection = { version: 1, probe: "cmsis-dap.cfg", probeSerial: "probe-A" };
    await assert.rejects(common.authorizeFlash(detected), { code: "PROBE_SELECTED_NOT_FOUND" });
    for (const script of ["verify", "program"]) {
        await assert.rejects(execute(script, detected), { code: "PROBE_SELECTED_NOT_FOUND" });
        assert.strictEqual(Object.hasOwn(requests.at(-1).params, "probeSerial"), false);
    }
}

const execFileAsync = promisify(execFile);
const canRunFakeOpenOcd = process.platform !== "win32";

function makeFakeOpenOcd(dir) {
    const bin = path.join(dir, "bin");
    const scripts = path.join(dir, "openocd", "scripts");
    fs.mkdirSync(path.join(scripts, "interface"), { recursive: true });
    fs.mkdirSync(path.join(scripts, "target", "geehy"), { recursive: true });
    fs.writeFileSync(path.join(scripts, "interface", "cmsis-dap.cfg"), "adapter driver cmsis-dap");
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
        '#!/bin/sh\necho "Open On-Chip Debugger 0.12.0"\necho "ARGS:$@"\necho "EP_ADAPTERS_BEGIN"\necho "cmsis-dap { swd jtag }"\necho "EP_ADAPTERS_END"\necho "EP_ADAPTER_NAME=cmsis-dap"\necho "EP_PROFILE_BEGIN"\necho "EP_PROFILE_END"\necho "EP_VERIFY OK"\nexit 0\n'
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
    fs.writeFileSync(elf, minimalElf("test firmware"));
    const fakeOpenOcd = makeFakeOpenOcd(root);

    const flashAuthorization = new FlashAuthorization();
    const { AgentFlashService } = require("../src/services/agentFlashService");
    const { ProbeCoordinator } = require("../src/probeCoordinator");
    const inventory = {
        available: true,
        devices: [{ family: "cmsis-dap", serial: "fixture-DAP", id: "usb-fixture" }],
        notes: []
    };
    const executor = new AgentFlashService({
        getConfig: () => ({ openocdPath: fakeOpenOcd }),
        coordinator: new ProbeCoordinator(),
        authorization: flashAuthorization,
        isDebugActive: () => false,
        prepare: (options) => prepareProbeConnection(options, { listProbes: async () => inventory })
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
            if (method === "probe.list") return inventory;
            if (method === "flash.verify") return executor.execute(params, true);
            // Mirror agentRoutes: the Bridge resolves the serial itself before fingerprinting.
            if (method === "flash.authorize") return executor.authorize(params);
            throw Object.assign(new Error(`Unexpected method: ${method}`), { code: "METHOD_NOT_FOUND" });
        },
        path.join(root, ".global-storage")
    );

    const run = (script, extra = []) =>
        execFileAsync(process.execPath, [path.resolve(__dirname, "../skills", script), "--workspace", root, ...extra]);

    try {
        await testProbeBinding(root, elf);
        await bridge.start();

        const downloadPreflight = firstJsonLine((await run("mcu-flash/scripts/program.js")).stdout);
        assert.strictEqual(downloadPreflight.elf, canonicalFileSync(elf));
        assert.strictEqual(downloadPreflight.target, "geehy/apm32f4x.cfg");
        assert.strictEqual(downloadPreflight.probe, "cmsis-dap.cfg");
        assert.strictEqual(downloadPreflight.openocd, fakeOpenOcd);
        if (canRunFakeOpenOcd) {
            assert.strictEqual(downloadPreflight.openocdVersion, "0.12.0");
            assert.strictEqual(downloadPreflight.openocdCompatible, true);
        }
        assert.strictEqual(downloadPreflight.ready, canRunFakeOpenOcd);
        assert.ok(/^[0-9a-f]{64}$/.test(downloadPreflight.elfSha256));
        if (canRunFakeOpenOcd) assert.strictEqual(downloadPreflight.flashAuthorization.confirmationRequired, true);
        else assert.strictEqual(downloadPreflight.flashAuthorization, undefined);
        // 任务2：配置成功时来源标记为 config，且没有降级诊断
        if (canRunFakeOpenOcd) assert.deepStrictEqual(downloadPreflight.diagnostics, []);
        else assert.strictEqual(downloadPreflight.diagnostics[0].error.code, "OPENOCD_EXECUTABLE_UNSUPPORTED");
        assert.deepStrictEqual(downloadPreflight.sources, {
            elf: "config",
            target: "config",
            probe: "config",
            transport: canRunFakeOpenOcd ? "script-default" : "default",
            probeSerial: canRunFakeOpenOcd ? "inventory" : "default",
            adapterSpeedKhz: "default",
            openocd: "config"
        });
        const explicitTransport = firstJsonLine(
            (await run("mcu-flash/scripts/program.js", ["--transport", "swd"])).stdout
        );
        assert.strictEqual(explicitTransport.transport, "swd");
        assert.strictEqual(explicitTransport.sources.transport, "explicit");
        await assert.rejects(
            run("mcu-flash/scripts/program.js", ["--transport", "invalid"]),
            /Unsupported OpenOCD transport/
        );

        const verifyPreflight = firstJsonLine((await run("mcu-flash/scripts/verify.js")).stdout);
        assert.strictEqual(verifyPreflight.target, "geehy/apm32f4x.cfg");
        assert.strictEqual(verifyPreflight.probe, "cmsis-dap.cfg");
        assert.strictEqual(verifyPreflight.openocd, fakeOpenOcd);

        if (canRunFakeOpenOcd) {
            assert.strictEqual(verifyPreflight.verificationAuthorization.operation, "flash.verify");
            await assert.rejects(run("mcu-flash/scripts/verify.js", ["--execute"]), /Verification confirmation/);
            const verifyRun = await run("mcu-flash/scripts/verify.js", [
                "--execute",
                "--confirmation-id",
                verifyPreflight.verificationAuthorization.confirmationId
            ]);
            const verified = lastJsonLine(verifyRun.stdout);
            assert.strictEqual(verified.verified, true);
            assert.strictEqual(verified.elf, canonicalFileSync(elf));
            assert.strictEqual(verified.elfSha256, downloadPreflight.elfSha256);
            // openocdTail 逐行截断到 500 字符，命令断言必须基于返回的 commands 而非 stdout 回显。
            assert.ok(
                verified.commands.join(" ").includes("-work-area-size 0"),
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
            const downloadedResult = lastJsonLine(downloaded.stdout);
            assert.ok(
                downloadedResult.commands.join(" ").includes("verify reset exit"),
                "OpenOCD should receive the program command"
            );
            assert.ok(
                downloadedResult.commands.join(" ").includes("-work-area-backup 1"),
                "download should preserve target RAM used as work-area"
            );
            assert.ok(downloaded.stdout.includes("EP_VERIFY OK"));

            const oldOpenOcd = path.join(root, "bin", "old-openocd.sh");
            fs.writeFileSync(oldOpenOcd, '#!/bin/sh\necho "Open On-Chip Debugger 0.11.0"\nexit 0\n');
            fs.chmodSync(oldOpenOcd, 0o755);
            const oldPreflight = firstJsonLine(
                (await run("mcu-flash/scripts/program.js", ["--openocd", oldOpenOcd])).stdout
            );
            assert.strictEqual(oldPreflight.ready, false);
            assert.strictEqual(oldPreflight.flashAuthorization, undefined);
            await assert.rejects(
                run("mcu-flash/scripts/program.js", [
                    "--execute",
                    "--openocd",
                    oldOpenOcd,
                    "--confirmation-id",
                    "unavailable"
                ]),
                (error) => /OpenOCD preflight failed: OpenOCD 0\.11\.0 is incompatible/.test(error.stderr || ""),
                "Agent download must refuse OpenOCD 0.11"
            );
        }

        // bridge 不可用时降级为工作区自动检测；大写扩展名的 ELF 也必须被发现（Linux 大小写敏感）
        const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-flash-skills-bare-"));
        try {
            const upperElf = path.join(bareRoot, "APP.ELF");
            fs.writeFileSync(upperElf, minimalElf());
            const bare = await execFileAsync(process.execPath, [
                path.resolve(__dirname, "../skills/mcu-flash/scripts/program.js"),
                "--workspace",
                bareRoot,
                "--probe",
                "stlink.cfg",
                "--target",
                "stm32f4x.cfg",
                "--openocd",
                path.join(bareRoot, "missing-openocd")
            ]);
            const bareJson = firstJsonLine(bare.stdout);
            assert.strictEqual(bareJson.elf, canonicalFileSync(upperElf));
            assert.strictEqual(bareJson.ready, false);
            // 任务2：Bridge 不可用时降级为自动检测，来源与诊断完整，且不得误报硬件故障
            assert.deepStrictEqual(bareJson.sources, {
                elf: "auto",
                target: "explicit",
                probe: "explicit",
                transport: "default",
                probeSerial: "default",
                adapterSpeedKhz: "default",
                openocd: "explicit"
            });
            assert.ok(bareJson.diagnostics.length >= 2);
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
        fs.writeFileSync(cfgFailElf, minimalElf());
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
            assert.strictEqual(cfgFailPreflight.diagnostics.length, 2);
            assert.strictEqual(cfgFailPreflight.diagnostics[0].error.code, "BRIDGE_TIMEOUT");
            assert.strictEqual(cfgFailPreflight.diagnostics[0].operation, "config.get");
            assert.deepStrictEqual(cfgFailPreflight.sources, {
                elf: "explicit",
                target: "explicit",
                probe: "explicit",
                transport: "default",
                probeSerial: "default",
                adapterSpeedKhz: "default",
                openocd: "explicit"
            });
            assert.strictEqual(
                cfgFailPreflight.ready,
                false,
                "A missing executable must block execution even with complete configuration"
            );
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
