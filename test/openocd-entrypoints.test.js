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
        child.kill = () => {};
        child.exitCode = null;
        process.nextTick(() => {
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
    assert.strictEqual(captured.length, 5, "Each failed operation starts exactly once");
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
