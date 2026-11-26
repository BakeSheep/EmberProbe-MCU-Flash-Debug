"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const shared = require("../src/openocdScripts");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { loadModule } = require("./helpers/load-module");
const { scenario } = require("./helpers/scenario");
const { waitFor } = require("./helpers/wait");
const { ChipInfoService } = require("../src/services/chipInfoService");

(async () => {
    const captured = [];
    const children = [];
    let successfulSpawn = false;
    let holdFailure = false;
    let failureOutput = "Error: LIBUSB_ERROR_NOT_FOUND\n" + "Info: trailing output\n".repeat(30) + "Error: init failed";
    const scripts = {
        ...shared,
        resolveOpenOcdLaunch: () => ({
            executable: "fake",
            scriptsRoot: "/scripts",
            cwd: "/scripts",
            probePath: "/scripts/interface/jlink.cfg",
            targetPath: "/scripts/target/stm32f4x.cfg"
        })
    };
    const spawn = (_executable, args, options) => {
        captured.push(args);
        assert.strictEqual(options.shell, false);
        assert.strictEqual(options.cwd, "/scripts");
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {
            child.exitCode = 0;
            process.nextTick(() => child.emit("close", 0));
        };
        child.exitCode = null;
        children.push(child);
        process.nextTick(() => {
            if (successfulSpawn) return;
            child.stderr.write(failureOutput.slice(0, 25));
            child.stderr.write(failureOutput.slice(25));
            if (holdFailure) return;
            child.exitCode = 1;
            child.emit("close", 1);
        });
        return child;
    };
    const exec = loadModule("src/services/openocdExec.js", { child_process: { spawn }, "../openocdScripts": scripts });
    const chip = loadModule("src/chipInfo.js", { "./services/openocdExec": exec });
    const fault = loadModule("src/faultInfo.js", { "./services/openocdExec": exec });
    const runner = loadModule("src/openocdRunner.js", { child_process: { spawn }, "./openocdScripts": scripts });
    const server = loadModule("src/openocdProcess.js", { child_process: { spawn }, "./openocdScripts": scripts });
    const live = loadModule("src/liveWatch.js", { "./openocdProcess": server });
    const options = {
        executable: "fake",
        elf: "/固件/firmware.elf",
        probe: "jlink.cfg",
        target: "stm32f4x.cfg",
        transport: "swd",
        probeSerial: "1234",
        adapterSpeedKhz: 100,
        port: 16666
    };
    const vscode = {
        EventEmitter: class {
            fire() {}
        },
        window: { createTerminal: () => ({ show() {}, dispose() {} }) }
    };
    await assert.rejects(
        runner.runOpenOcd(vscode, options, () => {}),
        { code: "PROBE_NOT_FOUND" }
    );
    await assert.rejects(chip.readChipInfo(vscode, options), { code: "PROBE_NOT_FOUND" });
    await assert.rejects(fault.readFaultInfo(options), { code: "PROBE_NOT_FOUND" });
    for (const mode of ["standalone", "debug"]) {
        const session = new live.ManagedOpenOcdSession({ ...options, mode, gdbPort: 13333 }, {});
        await assert.rejects(session.start(), { code: "PROBE_NOT_FOUND" });
    }
    for (const mode of ["debug", "standalone"]) {
        const session = new live.ManagedOpenOcdSession({ ...options, mode, rtos: "FreeRTOS", gdbPort: 13334 }, {});
        await assert.rejects(session.start(), { code: "PROBE_NOT_FOUND" });
    }
    assert.strictEqual(captured.length, 7, "Each failed operation starts exactly once");
    const rtosArgs = captured[5];
    const samplingArgs = captured[6];
    const rtosCommand = rtosArgs.find((arg) => arg.includes("configure -rtos FreeRTOS"));
    assert(rtosCommand, "debug mode configures the RTOS");
    assert(rtosCommand.includes("[target current]"), "only the current target is configured for the RTOS");
    assert(rtosArgs.indexOf("/scripts/target/stm32f4x.cfg") < rtosArgs.indexOf(rtosCommand));
    assert(rtosArgs.indexOf("adapter speed 100") < rtosArgs.indexOf(rtosCommand));
    const workArea = "foreach _ep_target [target names] { $_ep_target configure -work-area-backup 1 }";
    assert(rtosArgs.indexOf(rtosCommand) < rtosArgs.indexOf(workArea));
    assert(rtosArgs.indexOf(rtosCommand) < rtosArgs.indexOf("init"), "OpenOCD must see -rtos before init");
    assert(!samplingArgs.some((arg) => arg.includes("-rtos")), "sampling-only sessions never configure an RTOS");
    await assert.rejects(
        new live.ManagedOpenOcdSession({ ...options, mode: "debug", rtos: "FreeRTOs", gdbPort: 13335 }, {}).start(),
        { code: "OPENOCD_RTOS_INVALID" }
    );
    assert.strictEqual(captured.length, 7, "An invalid RTOS name never reaches OpenOCD");
    const multi = new live.ManagedOpenOcdSession(
        {
            ...options,
            mode: "debug",
            rtos: "FreeRTOS",
            numberOfProcessors: 2,
            targetProcessor: 1,
            targetName: "stm32h7x.cpu1",
            gdbPort: 13336,
            gdbPorts: [13335, 13336]
        },
        {}
    );
    await assert.rejects(multi.start(), { code: "PROBE_NOT_FOUND" });
    const multiArgs = captured[7];
    const coreCommand = multiArgs.find((arg) => arg.includes("set _ep_core_targets"));
    assert(coreCommand.includes('ne "stm32h7x.cpu1"'), "The expected target name must match the selected index");
    assert(coreCommand.includes("[llength $_ep_core_targets] != 2"), "A mismatched target count fails startup");
    assert(coreCommand.includes("[lindex $_ep_core_targets 0] configure -gdb-port 13335"));
    assert(coreCommand.includes("[lindex $_ep_core_targets 1] configure -gdb-port 13336"));
    assert(coreCommand.endsWith("targets [lindex $_ep_core_targets 1]"));
    assert(multiArgs.indexOf("telnet_port disabled") < multiArgs.indexOf(coreCommand));
    assert(
        multiArgs.indexOf(coreCommand) < multiArgs.indexOf(rtosCommand),
        "Select the core before configuring its RTOS"
    );
    for (const invalid of [{ targetProcessor: 2 }, { targetName: "cpu; shutdown" }, { gdbPorts: [13335, 13335] }]) {
        await assert.rejects(new live.ManagedOpenOcdSession({ ...multi.options, ...invalid }, {}).start());
    }
    assert.strictEqual(captured.length, 8, "Invalid core selection never spawns OpenOCD");
    successfulSpawn = true;
    for (const names of ["stm32h7x.cpu0 stm32h7x.cpu1", "stm32h7x.cpu0", "bad;shutdown stm32h7x.cpu1"]) {
        const grouped = new live.ManagedOpenOcdSession({ ...multi.options, serverGroup: "dual" }, {});
        grouped._waitForTclListening = async () => {};
        grouped.tcl.detectNoEcho = async () => true;
        grouped._connectWithRetry = async () => {
            const socket = new EventEmitter();
            socket.destroy = () => {
                socket.destroyed = true;
            };
            socket.setTimeout = () => {};
            socket.setNoDelay = () => {};
            return socket;
        };
        grouped.tcl.sendChecked = async (command) => {
            assert.strictEqual(command, "target names");
            return names;
        };
        if (names === "stm32h7x.cpu0 stm32h7x.cpu1") {
            const info = await grouped.start();
            assert.deepStrictEqual(info.targetNames, names.split(" "));
            assert.deepStrictEqual(info.gdbTargets, ["127.0.0.1:13335", "127.0.0.1:13336"]);
            const launchArgs = captured.at(-1);
            const configure = launchArgs.find((arg) => arg.includes("configure -rtos FreeRTOS"));
            assert(
                configure.includes("foreach") && configure.includes("[target names]"),
                "shared RTOS applies to every confirmed target"
            );
            assert(launchArgs.indexOf(coreCommand) < launchArgs.indexOf(configure));
            assert(launchArgs.indexOf(configure) < launchArgs.indexOf("init"));
        } else await assert.rejects(grouped.start(), /shared target names/);
        await grouped.stop();
    }
    for (const args of captured) {
        assert(args.indexOf("/scripts/interface/jlink.cfg") < args.indexOf("adapter serial 1234"));
        assert(args.indexOf("adapter serial 1234") < args.indexOf("transport select swd"));
        assert(args.indexOf("/scripts/interface/jlink.cfg") < args.indexOf("transport select swd"));
        assert(args.indexOf("transport select swd") < args.indexOf("/scripts/target/stm32f4x.cfg"));
        assert(args.indexOf("/scripts/target/stm32f4x.cfg") < args.indexOf("adapter speed 100"));
    }
    successfulSpawn = false;
    for (const mode of ["standalone", "debug"]) {
        for (const backendKind of ["tcp", "usb"]) {
            for (const samplingAdapterSpeedKhz of [0, 4000]) {
                const session = new live.ManagedOpenOcdSession(
                    { ...options, mode, backendKind, samplingAdapterSpeedKhz, gdbPort: 13333 },
                    {}
                );
                await assert.rejects(session.start(), { code: "PROBE_NOT_FOUND" });
                const args = captured.at(-1);
                const speed = mode === "standalone" && samplingAdapterSpeedKhz ? 4000 : 100;
                assert(args.includes(`adapter speed ${speed}`));
                assert(
                    args.some((arg) => arg.includes("_ep_speed_event") && arg.includes(String(speed))),
                    "sampling reuses the reset-event speed cap wrapper"
                );
                const polling = args.find((arg) => arg.includes("poll_interval"));
                assert.strictEqual(!!polling, mode === "standalone" && backendKind === "tcp");
                if (polling) {
                    assert(polling.includes("info commands poll_interval"));
                    assert(polling.includes("poll_interval 500"));
                    assert(args.indexOf(polling) > args.indexOf("init"));
                }
                assert.strictEqual(
                    session.options.adapterSpeedKhz,
                    100,
                    "launch overrides leave settings identity intact"
                );
            }
        }
    }
    await assert.rejects(
        runner.runOpenOcd(vscode, { ...options, samplingAdapterSpeedKhz: 4000 }, () => {}),
        { code: "PROBE_NOT_FOUND" }
    );
    assert(captured.at(-1).includes("adapter speed 100"), "flash retains the general clock");
    for (const operation of ["chip-read", "pause", "continue", "reset", "fault-read"]) {
        const coordinator = new ProbeCoordinator();
        const lease = coordinator.acquire("chipInfo");
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.exitCode = null;
        child.kill = () => {
            child.killed = true;
        };
        const delayedExec = loadModule("src/services/openocdExec.js", {
            child_process: { spawn: () => child },
            "../openocdScripts": scripts
        });
        const timedExec = {
            runOpenOcdOnce: (request) => delayedExec.runOpenOcdOnce({ ...request, timeoutMs: 10 })
        };
        const timedChip = loadModule("src/chipInfo.js", { "./services/openocdExec": timedExec });
        const timedFault = loadModule("src/faultInfo.js", { "./services/openocdExec": timedExec });
        const request =
            operation === "chip-read"
                ? timedChip.readChipInfo(vscode, options)
                : operation === "fault-read"
                  ? timedFault.readFaultInfo(options)
                  : timedChip.controlTarget(options, operation);
        let settled = false;
        const outcome = request
            .finally(() => lease.release())
            .then(
                () => {
                    settled = true;
                    return null;
                },
                (error) => {
                    settled = true;
                    return error;
                }
            );
        try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.strictEqual(child.killed, true, operation + " terminates the timed-out process");
            assert.strictEqual(settled, false, operation + " must wait for process close");
            assert.throws(() => coordinator.acquire("agentRead"), { code: "PROBE_BUSY" });
            child.emit("error", new Error("kill failed"));
            await Promise.resolve();
            assert.strictEqual(settled, false, "a kill error cannot release physical ownership");
        } finally {
            child.exitCode = 1;
            child.emit("close", 1);
        }
        const error = await outcome;
        assert(error, operation + " reports the original timeout after close");
        if (operation.endsWith("read")) assert.strictEqual(error.i18nKey, "chip.timeout");
        else assert.strictEqual(error.code, "OPENOCD_TIMEOUT");
        assert.strictEqual(coordinator.isActive("chipInfo"), false);
        coordinator.acquire("agentRead").release();
    }

    await scenario("CMSIS-DAP HID failures retain their diagnostic across OpenOCD entrypoints", async () => {
        failureOutput =
            "Error: error writing data: hid_write/WaitForSingleObject: (0x000003E5)\n" +
            "Error: CMSIS-DAP command CMD_INFO failed.\n";
        const before = captured.length;
        const expected = { code: "PROBE_COMMUNICATION_FAILED", category: "probe_connection", retryable: false };
        await assert.rejects(
            runner.runOpenOcd(vscode, options, () => {}),
            expected
        );
        await assert.rejects(chip.readChipInfo(vscode, options), expected);
        await assert.rejects(fault.readFaultInfo(options), expected);
        for (const mode of ["standalone", "debug"]) {
            const session = new live.ManagedOpenOcdSession({ ...options, mode, gdbPort: 13337 }, {});
            await assert.rejects(session.start(), expected);
            assert.strictEqual(await session.stop(), true);
            assert.strictEqual(session.server.child, null);
            assert.strictEqual(session.tcl.socket, null);
        }
        assert.strictEqual(captured.length - before, 5, "a communication failure never retries automatically");
    });

    await scenario("Tcl event errors preserve their exception across OpenOCD entrypoints", async () => {
        const exception = 'can\'t read "_CHIPNAME": no such variable';
        failureOutput =
            "[stm32c5x.cpu] Execution of event examine-end failed:\n" +
            exception +
            "\nEP_FLASH_STAGE=program\n" +
            "Info : trailing output\n".repeat(30) +
            "auto_probe failed\n** Programming Failed **\nshutdown error\n";
        const check = (error) => {
            assert.strictEqual(error.code, "OPENOCD_SCRIPT_ERROR");
            assert.strictEqual(error.retryable, false);
            assert.strictEqual(error.details.scriptError.message, exception);
            assert.strictEqual(error.stage, "program");
            return true;
        };
        const before = captured.length;
        await assert.rejects(
            runner.runOpenOcd(vscode, options, () => {}),
            check
        );
        await assert.rejects(chip.readChipInfo(vscode, options), check);
        await assert.rejects(fault.readFaultInfo(options), check);
        for (const mode of ["standalone", "debug"]) {
            const session = new live.ManagedOpenOcdSession({ ...options, mode, gdbPort: 13338 }, {});
            await assert.rejects(session.start(), check);
            assert.strictEqual(await session.stop(), true);
        }
        assert.strictEqual(captured.length - before, 5, "script errors never start an automatic hardware retry");
        failureOutput = "Error: error writing data: hid_write failed\n";
    });

    await scenario("Chip read keeps exclusive ownership through a HID failure until OpenOCD closes", async () => {
        const coordinator = new ProbeCoordinator();
        const posts = [];
        const service = new ChipInfoService({
            vscode: { workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
            context: { workspaceState: { get: (key) => (key === "probe" ? "cmsis-dap.cfg" : "stm32c5x.cfg") } },
            cacheKeys: { debugger: "probe", mcuCore: "target" },
            chipInfo: chip,
            coordinator,
            t: (key) => key,
            resolveExecutable: async () => "fake",
            commandContext: () => ({}),
            onPost: (message) => posts.push(message),
            onDiagnostics() {},
            isDebugActive: () => false
        });
        const before = children.length;
        holdFailure = true;
        let settled = false;
        const reading = service.read(true).finally(() => {
            settled = true;
        });
        const rejected = assert.rejects(reading, { code: "PROBE_COMMUNICATION_FAILED", stage: "openocd_start" });
        try {
            await waitFor(() => children.length > before);
            assert.strictEqual(settled, false);
            for (const operation of ["debugStart", "liveStart", "download", "agentRead", "targetScan"])
                assert.throws(() => coordinator.acquire(operation), { code: "PROBE_BUSY" });
            await assert.rejects(service.read(true), { code: "CHIP_READ_RUNNING" });
            assert.strictEqual(children.length, before + 1, "competing requests cannot spawn another OpenOCD");
        } finally {
            holdFailure = false;
            children.at(-1).exitCode = 1;
            children.at(-1).emit("close", 1);
            await rejected;
        }
        assert.strictEqual(coordinator.anyActive(), false);
        assert.strictEqual(posts.at(-1).diagnostic.code, "PROBE_COMMUNICATION_FAILED");
        coordinator.acquire("debugStart").release();
    });

    // Automatic mode: every entrypoint checks the target chip right after init and stops on a different chip.
    const checkedArgs = [];
    const mismatchSpawn = (_executable, args) => {
        checkedArgs.push(args);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        process.nextTick(() => {
            child.stderr.write("EP_TARGET_ID cpuid=411FC271 idcode=20036450 uid=0050002B3133510232363235\n");
            child.stderr.write("EP_TARGET_MISMATCH uid\nError: shutdown error\n");
            child.exitCode = 1;
            child.emit("close", 1);
        });
        return child;
    };
    const checkedExec = loadModule("src/services/openocdExec.js", {
        child_process: { spawn: mismatchSpawn },
        "../openocdScripts": scripts
    });
    const checkedChip = loadModule("src/chipInfo.js", { "./services/openocdExec": checkedExec });
    const checkedRunner = loadModule("src/openocdRunner.js", {
        child_process: { spawn: mismatchSpawn },
        "./openocdScripts": scripts
    });
    const checkedServer = loadModule("src/openocdProcess.js", {
        child_process: { spawn: mismatchSpawn },
        "./openocdScripts": scripts
    });
    const checkedLive = loadModule("src/liveWatch.js", { "./openocdProcess": checkedServer });
    const targetCheck = {
        checkId: "entrypoints",
        target: "stm32f4x.cfg",
        expected: { cpuid: "410FC241", idcode: "10076413", uid: "002900124131381253534C32" }
    };
    const mismatch = (error) => error.code === "PROBE_TARGET_MISMATCH" && error.details.field === "uid";
    await assert.rejects(
        checkedRunner.runOpenOcd(vscode, { ...options, targetCheck }, () => {}),
        mismatch
    );
    await assert.rejects(checkedChip.readChipInfo(vscode, { ...options, targetCheck }), mismatch);
    for (const mode of ["standalone", "debug"])
        await assert.rejects(
            new checkedLive.ManagedOpenOcdSession({ ...options, targetCheck, mode, gdbPort: 13337 }, {}).start(),
            mismatch
        );
    const commandsOf = (args) => args.filter((_arg, index) => args[index - 1] === "-c");
    for (const args of checkedArgs) {
        const commands = commandsOf(args);
        const init = commands.indexOf("init");
        assert(init >= 0 && commands[init + 1].includes("EP_TARGET_ID"), "the check follows init");
        assert(commands[init + 1].includes("{cpuid 410FC240 idcode 00000413 uid 002900124131381253534C32}"));
    }
    const flashCommands = commandsOf(checkedArgs[0]);
    assert(
        flashCommands.indexOf("init") < flashCommands.findIndex((command) => command.includes("_ep_flash_program")),
        "the check runs before programming starts"
    );
    const debugCommands = commandsOf(checkedArgs[3]);
    assert(
        debugCommands.findIndex((command) => command.includes("-work-area-backup 1")) < debugCommands.indexOf("init"),
        "a debug session's configuration stays before init"
    );

    await scenario(
        "cmsisDapQuirk propagates to spawned OpenOCD arguments across all entrypoints for cmsis-dap only",
        async () => {
            const fs = require("fs");
            const os = require("os");
            const path = require("path");
            const { EventEmitter } = require("events");
            const { loadModule } = require("./helpers/load-module");
            const scripts = require("../src/openocdScripts");

            const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-quirk-"));
            const elf = path.join(temp, "app.elf");
            fs.writeFileSync(elf, "elf");
            try {
                const calls = [];
                const fakeScripts = {
                    ...scripts,
                    resolveOpenOcdLaunch: (executable, probe, target) => ({
                        executable: executable || "openocd",
                        probePath: `/scripts/interface/${probe}`,
                        targetPath: `/scripts/target/${target}`,
                        scriptsRoot: "/scripts",
                        cwd: temp
                    }),
                    openOcdEnvironment: () => ({ ...process.env })
                };
                const fakeChildProcess = {
                    ...require("child_process"),
                    spawn: (exe, args) => {
                        calls.push({ exe, args });
                        const child = new EventEmitter();
                        child.stdout = new EventEmitter();
                        child.stderr = new EventEmitter();
                        child.stdin = { write() {}, end() {} };
                        child.kill = () => {};
                        queueMicrotask(() => {
                            child.emit("error", new Error("spawn-captured"));
                            child.emit("close", 1);
                        });
                        return child;
                    }
                };
                const execMod = loadModule("src/services/openocdExec.js", {
                    child_process: fakeChildProcess,
                    "../openocdScripts": fakeScripts
                });
                const runnerMod = loadModule("src/openocdRunner.js", {
                    child_process: fakeChildProcess,
                    "./openocdScripts": fakeScripts
                });
                const chipMod = loadModule("src/chipInfo.js", {
                    "./openocdRunner": runnerMod,
                    "./services/openocdExec": execMod
                });
                const faultMod = loadModule("src/faultInfo.js", {
                    "./openocdRunner": runnerMod,
                    "./services/openocdExec": execMod,
                    "./chipInfo": chipMod
                });
                const procMod = loadModule("src/openocdProcess.js", {
                    child_process: fakeChildProcess,
                    "./openocdScripts": fakeScripts
                });
                const liveMod = loadModule("src/liveWatch.js", {
                    "./openocdProcess": procMod
                });
                const debugCtrlMod = loadModule("src/services/debugServerController.js", {
                    "../liveWatch": liveMod,
                    "../openocdScripts": fakeScripts
                });

                const fakeVscode = {
                    EventEmitter: class {
                        constructor() {
                            this.event = () => ({ dispose() {} });
                        }
                        fire() {}
                        dispose() {}
                    },
                    window: {
                        createTerminal: () => ({ show() {}, dispose() {} }),
                        onDidCloseTerminal: () => ({ dispose() {} })
                    }
                };

                const runAll = async (probe, cmsisDapQuirk) => {
                    const start = calls.length;
                    await assert.rejects(
                        runnerMod.runOpenOcd(
                            fakeVscode,
                            {
                                executable: "openocd",
                                probe,
                                target: "stm32h7x.cfg",
                                elf,
                                cmsisDapQuirk
                            },
                            () => {}
                        ),
                        /spawn-captured/
                    );
                    await assert.rejects(
                        chipMod.readChipInfo(fakeVscode, {
                            executable: "openocd",
                            probe,
                            target: "stm32h7x.cfg",
                            cmsisDapQuirk
                        }),
                        /spawn-captured/
                    );
                    await assert.rejects(
                        faultMod.readFaultInfo({
                            executable: "openocd",
                            probe,
                            target: "stm32h7x.cfg",
                            cmsisDapQuirk
                        }),
                        /spawn-captured/
                    );
                    await assert.rejects(
                        new liveMod.ManagedOpenOcdSession({
                            executable: "openocd",
                            probe,
                            target: "stm32h7x.cfg",
                            port: 34000,
                            mode: "standalone",
                            cmsisDapQuirk
                        }).start(),
                        /spawn-captured/
                    );
                    await assert.rejects(
                        new debugCtrlMod.OpenOcdDebugController(
                            {
                                executable: "openocd",
                                probe,
                                target: "stm32h7x.cfg",
                                port: 34001,
                                gdbPort: 34002,
                                cmsisDapQuirk
                            },
                            {}
                        ).start(),
                        /spawn-captured/
                    );
                    return calls.slice(start).map((entry) => entry.args);
                };

                const cmsisSets = await runAll("cmsis-dap.cfg", "enable");
                assert.strictEqual(cmsisSets.length, 5);
                for (const args of cmsisSets) {
                    const idx = args.indexOf("cmsis-dap quirk enable");
                    assert(idx > 0 && args[idx - 1] === "-c", JSON.stringify(args));
                }

                const jlinkSets = await runAll("jlink.cfg", "enable");
                assert.strictEqual(jlinkSets.length, 5);
                for (const args of jlinkSets) {
                    assert(!args.join(" ").includes("cmsis-dap quirk"), JSON.stringify(args));
                }
            } finally {
                fs.rmSync(temp, { recursive: true, force: true });
            }
        }
    );

    console.log("OpenOCD entrypoint transport and diagnostic tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
