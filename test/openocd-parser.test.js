"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { parseLine, quoteTclWord, diagnoseOpenOcdFailure, isSafeCfg } = require("../src/openocdRunner");

scenario("CMSIS-DAP USB timeouts and FIFO mismatches retain their transport diagnosis", () => {
    for (const message of [
        "Debug: 3790 16782 cmsis_dap_usb_bulk.c:523 cmsis_dap_usb_read(): USB timeout @ 0\nDebug: 3791 16782 cmsis_dap.c:922 cmsis_dap_swd_read_process(): error reading adapter response",
        "Debug: command write USB timeout @ 0",
        "Debug: USB write timeout @ 0, late detect",
        "Error: error reading USB data",
        "Error: error writing USB data, late detect",
        "Error: error submitting USB read: Input/Output Error",
        "Error: error handling USB events: Interrupted system call",
        "Error: CMSIS-DAP command mismatch. Expected 0x5 received 0x0",
        "Error: CMSIS-DAP transfer count mismatch: expected 22, got 0"
    ]) {
        const diagnostic = diagnoseOpenOcdFailure([message, "Error: init failed"], { probe: "cmsis-dap.cfg" });
        assert.strictEqual(diagnostic.code, "PROBE_COMMUNICATION_FAILED");
        assert.strictEqual(diagnostic.retryable, false);
    }
});

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

scenario("Probe command failures outrank Flash, init and timeout symptoms", () => {
    const reported = [
        "Error: error writing data: hid_write/WaitForSingleObject: (0x000003E5)",
        "Error: CMSIS-DAP command CMD_INFO failed."
    ];
    const details = { platform: "win32", probe: "cmsis-dap.cfg", target: "stm32c5x.cfg", transport: "auto" };
    for (const lines of [
        reported,
        [...reported, "Error: init failed", "Error: timeout", "Error: flash write failed"],
        [reported[1]],
        ["Error: hid_write failed"],
        ["Error: hid_read_timeout: ReadFile failed"],
        ["Error: error reading data"],
        ["Error: LIBUSB_ERROR_IO"],
        ["Error: LIBUSB_ERROR_PIPE"]
    ]) {
        const result = diagnoseOpenOcdFailure(lines, details);
        assert.strictEqual(result.code, "PROBE_COMMUNICATION_FAILED");
        assert.strictEqual(result.category, "probe_connection");
        assert.strictEqual(result.stage, "openocd_start");
        assert.strictEqual(result.retryable, false, "recovery requires a changed precondition");
        assert.deepStrictEqual(result.details.openocdTail, lines);
        assert.strictEqual(result.details.target, "stm32c5x.cfg");
        assert(result.suggestedActions.some((action) => action.includes("进程已退出")));
        assert(result.suggestedActions.some((action) => action.includes("重新插拔")));
        assert(!result.suggestedActions.join(" ").includes("写保护"));
    }
    for (const [line, code] of [
        ["LIBUSB_ERROR_BUSY", "PROBE_BUSY"],
        ["LIBUSB_ERROR_ACCESS", "PROBE_PERMISSION_DENIED"],
        ["LIBUSB_ERROR_NO_DEVICE", "PROBE_DISCONNECTED"],
        ["*** buffer overflow detected ***", "OPENOCD_NATIVE_CRASH"]
    ])
        assert.strictEqual(diagnoseOpenOcdFailure([...reported, line], details).code, code);
    const duringFlash = diagnoseOpenOcdFailure(["EP_FLASH_STAGE=program", ...reported], details);
    assert.strictEqual(duringFlash.code, "PROBE_COMMUNICATION_FAILED");
    assert.strictEqual(duringFlash.stage, "program", "a link failure preserves the operation phase");
});

scenario("Flash write diagnostics require Flash context for generic write failures", () => {
    for (const line of [
        "Error: flash write failed",
        "Error: failed erasing sectors",
        "Error: error erasing flash",
        "Error: write discontinued",
        "Error: failed to write flash",
        "Error: error writing to flash at address 0x08000000"
    ])
        assert.strictEqual(diagnoseOpenOcdFailure([line]).code, "FLASH_WRITE_FAILED", line);
    for (const line of ["Error: failed to write file", "Error: error writing socket", "Info: CMSIS-DAP: SWD supported"])
        assert.strictEqual(diagnoseOpenOcdFailure([line]).code, "OPENOCD_START_FAILED", line);
});

scenario("Tcl scope errors retain their first exception before the programming shutdown traceback", () => {
    const first = 'can\'t read "_CHIPNAME": no such variable';
    const lines = [
        "EP_FLASH_STAGE=init",
        "[stm32c5x.cpu] Execution of event examine-end failed:",
        first,
        ...Array(30).fill("Info : more output"),
        "EP_FLASH_STAGE=program",
        "Please check if you have set correctly the loader file",
        "auto_probe failed",
        "** Programming Failed **",
        "embedded:startup.tcl:1893: Error:",
        "Traceback (most recent call last):",
        ", in _ep_flash_program",
        "program firmware.elf verify reset exit",
        'File "embedded:startup.tcl", line 1961, in program',
        "program_error {** Programming Failed **} 1",
        'File "embedded:startup.tcl", line 1893, in program_error',
        "shutdown error"
    ];
    const details = { target: "stm32c5x.cfg", probeSerial: "D861FE88D88E", exitCode: 1 };
    const result = diagnoseOpenOcdFailure(lines, details);
    assert.strictEqual(result.code, "OPENOCD_SCRIPT_ERROR");
    assert.strictEqual(result.category, "configuration");
    assert.strictEqual(result.stage, "program");
    assert.strictEqual(result.retryable, false);
    assert.ok(result.message.includes(first));
    assert.strictEqual(result.details.scriptError.message, first);
    assert.ok(result.details.scriptError.context.includes(lines[1]));
    assert.deepStrictEqual(result.details.openocdTail, lines.slice(-8));
    assert.strictEqual(result.details.probeSerial, details.probeSerial);
    assert.ok(result.suggestedActions.some((action) => action.includes("变量作用域")));
    const next = diagnoseOpenOcdFailure([...lines, 'can\'t read "other": no such variable']);
    assert.strictEqual(next.details.scriptError.message, first, "a later error must not replace the first exception");
    const bounded = diagnoseOpenOcdFailure(['invalid command name "' + "x".repeat(2000) + '"']);
    assert.strictEqual(bounded.code, "OPENOCD_SCRIPT_ERROR");
    assert.strictEqual(bounded.details.scriptError.message.length, 500);
    assert.ok(bounded.details.scriptError.context.every((line) => line.length <= 500));
    for (const [line, code] of [
        ["LIBUSB_ERROR_BUSY", "PROBE_BUSY"],
        ["LIBUSB_ERROR_ACCESS", "PROBE_PERMISSION_DENIED"],
        ["LIBUSB_ERROR_NO_DEVICE", "PROBE_DISCONNECTED"],
        ["CMSIS-DAP command CMD_INFO failed.", "PROBE_COMMUNICATION_FAILED"],
        ["*** buffer overflow detected ***", "OPENOCD_NATIVE_CRASH"]
    ])
        assert.strictEqual(diagnoseOpenOcdFailure([...lines, line]).code, code);
    const { isProbeCommunicationFailure } = require("../skills/_emberprobe/openocd-diagnostics");
    assert.strictEqual(isProbeCommunicationFailure("Error: CMSIS-DAP command CMD_DAP_SWJ_CLOCK failed."), false);
    assert.strictEqual(
        isProbeCommunicationFailure(
            "Error: error writing data: hid_write\nError: CMSIS-DAP command CMD_DAP_SWJ_CLOCK failed."
        ),
        true
    );
    assert.strictEqual(diagnoseOpenOcdFailure(["shutdown error"]).code, "OPENOCD_START_FAILED");
    assert.strictEqual(diagnoseOpenOcdFailure(["Error: failed to read memory"]).code, "OPENOCD_START_FAILED");
    assert.strictEqual(
        diagnoseOpenOcdFailure(['wrong # args: should be "proc name args body"']).code,
        "OPENOCD_SCRIPT_ERROR"
    );
});

scenario("CMSIS-DAP mismatch diagnostics surface quirk and clock tips plus connection metadata", () => {
    const { connectionDetails, diagnoseOpenOcdFailure } = require("../skills/_emberprobe/openocd-diagnostics");
    for (const line of [
        "Error: CMSIS-DAP command mismatch. Expected 0x6 received 0x5",
        "Error: CMSIS-DAP transfer count mismatch: expected 22, got 0"
    ]) {
        const result = diagnoseOpenOcdFailure([line], {
            probe: "cmsis-dap.cfg",
            target: "stm32h7x.cfg",
            adapterBackend: "hid",
            cmsisDapQuirk: "enable"
        });
        assert.strictEqual(result.code, "PROBE_COMMUNICATION_FAILED");
        assert(
            result.suggestedActions.some(
                (action) => action.includes("emberprobe.cmsisDapQuirk") && action.includes("emberprobe.adapterSpeedKhz")
            ),
            line
        );
        assert.strictEqual(result.details.adapterBackend, "hid");
        assert.strictEqual(result.details.cmsisDapQuirk, "enable");
    }
    const plainHid = diagnoseOpenOcdFailure(["Error: hid_write failed"], {
        probe: "cmsis-dap.cfg",
        cmsisDapQuirk: "auto"
    });
    assert(!plainHid.suggestedActions.some((action) => action.includes("emberprobe.cmsisDapQuirk")));
    const autoDetails = connectionDetails({ probe: "cmsis-dap.cfg", cmsisDapQuirk: "auto" });
    assert(!("cmsisDapQuirk" in autoDetails));
});

console.log("OpenOCD parser tests passed");
