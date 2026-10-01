"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const shared = require("../src/openocdScripts");

// Execute the production modules with only process creation and path lookup replaced.
function load(file, overrides) {
    const filename = path.resolve(__dirname, "..", file);
    const localRequire = createRequire(filename);
    const mod = { exports: {} };
    vm.runInThisContext("(function(require,module,exports){" + fs.readFileSync(filename, "utf8") + "\n})", {
        filename
    })((name) => overrides[name] || localRequire(name), mod, mod.exports);
    return mod.exports;
}

(async () => {
    const captured = [];
    let successfulSpawn = false;
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
        process.nextTick(() => {
            if (successfulSpawn) return;
            child.stderr.write("Error: LIBUSB_ERROR_NOT_");
            child.stderr.write("FOUND\n" + "Info: trailing output\n".repeat(30) + "Error: init failed");
            child.exitCode = 1;
            child.emit("close", 1);
        });
        return child;
    };
    const exec = load("src/services/openocdExec.js", { child_process: { spawn }, "../openocdScripts": scripts });
    const chip = load("src/chipInfo.js", { "./services/openocdExec": exec });
    const fault = load("src/faultInfo.js", { "./services/openocdExec": exec });
    const runner = load("src/openocdRunner.js", { child_process: { spawn }, "./openocdScripts": scripts });
    const live = load("src/liveWatch.js", { child_process: { spawn }, "./openocdScripts": scripts });
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
        const session = new live.ManagedOpenOcdSession(null, { ...options, mode, gdbPort: 13333 }, {});
        await assert.rejects(session.start(), { code: "PROBE_NOT_FOUND" });
    }
    for (const mode of ["debug", "standalone"]) {
        const session = new live.ManagedOpenOcdSession(
            null,
            { ...options, mode, rtos: "FreeRTOS", gdbPort: 13334 },
            {}
        );
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
        new live.ManagedOpenOcdSession(
            null,
            { ...options, mode: "debug", rtos: "FreeRTOs", gdbPort: 13335 },
            {}
        ).start(),
        { code: "OPENOCD_RTOS_INVALID" }
    );
    assert.strictEqual(captured.length, 7, "An invalid RTOS name never reaches OpenOCD");
    const multi = new live.ManagedOpenOcdSession(
        null,
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
        await assert.rejects(new live.ManagedOpenOcdSession(null, { ...multi.options, ...invalid }, {}).start());
    }
    assert.strictEqual(captured.length, 8, "Invalid core selection never spawns OpenOCD");
    successfulSpawn = true;
    for (const names of ["stm32h7x.cpu0 stm32h7x.cpu1", "stm32h7x.cpu0", "bad;shutdown stm32h7x.cpu1"]) {
        const grouped = new live.ManagedOpenOcdSession(null, { ...multi.options, serverGroup: "dual" }, {});
        grouped._waitForTclListening = async () => {};
        grouped._connectWithRetry = async () => {
            const socket = new EventEmitter();
            socket.destroy = () => {
                socket.destroyed = true;
            };
            socket.setTimeout = () => {};
            socket.setNoDelay = () => {};
            return socket;
        };
        grouped._sendCheckedCommand = async (command) => {
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
    console.log("OpenOCD entrypoint transport and diagnostic tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
