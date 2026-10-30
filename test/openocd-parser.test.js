"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { parseLine, quoteTclWord, diagnoseOpenOcdFailure, isSafeCfg } = require("../src/openocdRunner");

assert.strictEqual(isSafeCfg("geehy/apm32f4x.cfg"), true);
assert.strictEqual(isSafeCfg("../apm32f4x.cfg"), false);

const cases = [
    ["Info : CMSIS-DAP: SWD supported", "probe"],
    ["target halted due to debug-request", "target"],
    ["wrote 524288 bytes from file app.elf in 2.1s", "program"],
    ["verified 524288 bytes in 0.8s", "verify"],
    ["Error: unable to find a matching CMSIS-DAP device", "error"]
];

for (const [line, stage] of cases) assert.strictEqual(parseLine(line)?.stage, stage, line);

// OpenOCD prints "shutdown command invoked" in failed runs too, so completion is decided by the exit code, not that
// line
assert.strictEqual(parseLine("shutdown command invoked"), null);
// When stripping the "Error:" prefix leaves nothing, fall back to the whole line instead of an empty message
const errEvent = parseLine("embedded:startup.tcl:1789: Error:");
assert.strictEqual(errEvent?.stage, "error");
assert.ok(errEvent.message.length > 0, "error message should not be empty");

// wrote/verified events carry structured fields (with an optional rate)
const wrote = parseLine("wrote 524288 bytes from file app.elf in 2.1s (249.9 KiB/s)");
assert.strictEqual(wrote?.stage, "program");
assert.strictEqual(wrote.bytes, 524288);
assert.strictEqual(wrote.seconds, 2.1);
assert.strictEqual(wrote.speed, "249.9 KiB/s");
const verified = parseLine("verified 524288 bytes in 0.8s");
assert.strictEqual(verified?.stage, "verify");
assert.strictEqual(verified.bytes, 524288);
assert.strictEqual(verified.speed, "");

// Info lines: chip, flash size, adapter clock and target voltage
const chipId = parseLine("Info : device id = 0x10076413");
assert.strictEqual(chipId?.stage, "chip");
assert.strictEqual(chipId.deviceId, "0x10076413");
const chipName = parseLine("Info : Device: STM32F40x/STM32F41x");
assert.strictEqual(chipName?.stage, "chip");
assert.ok(chipName.chip.includes("STM32F40x"));
const flashInfo = parseLine("Info : flash size = 1024 kbytes");
assert.strictEqual(flashInfo?.stage, "flash");
assert.ok(flashInfo.flashSize.includes("1024"));
assert.strictEqual(parseLine("Info : clock speed 1800 kHz")?.stage, "adapter");
assert.strictEqual(parseLine("Info : Target voltage: 3.239000")?.level, "info");
assert.strictEqual(parseLine("Info : Target voltage: 0.000000")?.level, "error");
// A missing configuration script is classified as an error
assert.strictEqual(parseLine("Error: Can't find interface/stlink.cfg")?.stage, "error");
// Normal Info hints (even with words like "unable to"/"failed") are not misread as errors
assert.strictEqual(parseLine("Info : Unable to match requested speed 5000 kHz, using 1800 kHz"), null);
assert.strictEqual(parseLine("Info : clock speed 1800 kHz")?.stage, "adapter");
assert.strictEqual(parseLine("libusb_open() failed with LIBUSB_ERROR_ACCESS")?.stage, "error");

// Variable and command substitution inside Tcl double quotes is disabled while paths with spaces keep working.
assert.strictEqual(
    quoteTclWord('C:/work/$board/[danger]/app "debug".elf'),
    '"C:/work/\\$board/\\[danger\\]/app \\"debug\\".elf"'
);

const noProbe = diagnoseOpenOcdFailure(["Error: unable to find a matching CMSIS-DAP device"], { exitCode: 1 });
assert.strictEqual(noProbe.code, "PROBE_NOT_FOUND");
assert.strictEqual(noProbe.category, "probe_connection");
assert.deepStrictEqual(noProbe.details.openocdTail, ["Error: unable to find a matching CMSIS-DAP device"]);

const noTarget = diagnoseOpenOcdFailure(["Error: Error connecting DP: cannot read IDR"], { exitCode: 1 });
assert.strictEqual(noTarget.code, "TARGET_NOT_CONNECTED");
const nativeCrash = diagnoseOpenOcdFailure(["Error: init failed", "*** buffer overflow detected ***: terminated"], {
    platform: "linux",
    probe: "cmsis-dap.cfg",
    probeSerial: "0001234",
    exitCode: null,
    signal: "SIGABRT"
});
assert.strictEqual(nativeCrash.code, "OPENOCD_NATIVE_CRASH");
assert.strictEqual(nativeCrash.category, "openocd");
assert.strictEqual(nativeCrash.retryable, false);
assert.strictEqual(nativeCrash.details.signal, "SIGABRT");
assert(nativeCrash.suggestedActions.some((action) => action.includes("e01e180f")));
assert(nativeCrash.suggestedActions.some((action) => action.includes("保留精确探针序列号")));
for (const signal of ["SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL"]) {
    const crash = diagnoseOpenOcdFailure([], { signal, probe: "jlink.cfg" });
    assert.strictEqual(crash.code, "OPENOCD_NATIVE_CRASH");
    assert(!crash.suggestedActions.some((action) => action.includes("CMSIS-DAP HID")));
}
assert.notStrictEqual(diagnoseOpenOcdFailure([], { signal: "SIGTERM" }).code, "OPENOCD_NATIVE_CRASH");
for (const details of [
    { platform: "win32", probe: "cmsis-dap.cfg", probeSerial: "0001234" },
    { platform: "linux", probe: "cmsis-dap.cfg", probeSerial: "" }
]) {
    const crash = diagnoseOpenOcdFailure(["*** stack smashing detected ***: terminated"], details);
    assert.strictEqual(crash.code, "OPENOCD_NATIVE_CRASH");
    assert(!crash.suggestedActions.some((action) => action.includes("e01e180f")));
}
const h7NoTarget = diagnoseOpenOcdFailure(["Error: Error connecting DP: cannot read IDR"], {
    target: "stm32h7x.cfg"
});
assert(h7NoTarget.suggestedActions.some((action) => action.includes("手动复位")));
assert.ok(noTarget.suggestedActions.some((action) => action.includes("SWDIO")));

const noPower = diagnoseOpenOcdFailure(["Error: target voltage 0.000 V is too low"]);
assert.strictEqual(noPower.code, "TARGET_UNPOWERED");

const portBusy = diagnoseOpenOcdFailure(["Error: couldn't bind tcl socket: Address already in use"], { port: 6666 });
assert.strictEqual(portBusy.code, "TCL_PORT_IN_USE");
assert.strictEqual(portBusy.details.port, 6666);

scenario("Diagnose Linux USB permission failures with udev guidance", () => {
    const { diagnoseOpenOcdFailure } = require("../skills/_emberprobe/openocd-diagnostics");
    const denied = diagnoseOpenOcdFailure(["Error: libusb_open() failed with LIBUSB_ERROR_ACCESS"], {
        platform: "linux"
    });
    assert.strictEqual(denied.code, "PROBE_PERMISSION_DENIED");
    assert(denied.suggestedActions.some((action) => action.includes("udev")));
});

scenario("Diagnose STM32C5 HLA refusal and missing stldr loaders", () => {
    const { diagnoseOpenOcdFailure } = require("../skills/_emberprobe/openocd-diagnostics");
    const hla = diagnoseOpenOcdFailure(["Error : The selected adapter does not support debugging this device"]);
    assert.strictEqual(hla.code, "TARGET_ADAPTER_UNSUPPORTED");
    assert.strictEqual(hla.retryable, false);
    assert(hla.suggestedActions.some((action) => action.includes("interface/stlink.cfg")));
    const memAp = diagnoseOpenOcdFailure([
        "openocd/scripts/target/stm32c5x.cfg:42: Error: The selected transport doesn't support this target"
    ]);
    assert.strictEqual(memAp.code, "TARGET_ADAPTER_UNSUPPORTED");
    const loader = diagnoseOpenOcdFailure(["Error : No STLDR loader file found for device ID 0x44E"]);
    assert.strictEqual(loader.code, "FLASH_LOADER_MISSING");
});

console.log("OpenOCD parser tests passed");
