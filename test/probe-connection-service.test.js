"use strict";
const assert = require("assert");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
const i18n = require("../src/i18n");
const { reportTargetIdentity } = require("../src/chip/targetIdentity");

async function main() {
    let config = { transport: "auto", probeSerial: "", adapterSpeedKhz: 0 };
    let devices = [{ family: "jlink", serial: "1234", id: "usb-1" }];
    let saved = null,
        writes = 0,
        reveals = 0;
    const service = new ProbeConnectionService({
        getConfig: () => config,
        getSuccessfulConnection: () => saved,
        saveSuccessfulConnection: async (value) => {
            writes++;
            saved = value;
        },
        onSelectionRequired: () => reveals++,
        prepareConnection: async (options) => ({
            ...resolveProbeConnection(options, { available: true, devices }),
            adapterFamily: "jlink"
        })
    });
    const options = { probe: "jlink.cfg", target: "stm32f1x.cfg", executable: "openocd" };
    const result = await service.prepare(options, true);
    assert.strictEqual(reveals, 0);
    assert.strictEqual(result.probeSerial, "1234");
    assert.strictEqual(result.transport, "swd");
    assert.strictEqual(saved, null, "preflight must not record success");
    assert.strictEqual(config.probeSerial, "", "automatic choices must not overwrite settings");
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.selection));
    const originalPrepare = service.prepareConnection;
    const launchOptions = { resolveLaunch: () => "prepared-launch" };
    service.prepareConnection = async (request, forwarded) => {
        assert.strictEqual(forwarded, launchOptions);
        return originalPrepare(request);
    };
    await service.prepare(options, launchOptions);
    service.prepareConnection = originalPrepare;

    // Automatic mode keeps no probe. An operation whose check read no target chip records nothing...
    assert.strictEqual(result.targetCheck.expected, null);
    assert.strictEqual(result.targetCheck.target, "stm32f1x.cfg");
    await service.recordSuccess(result);
    assert.strictEqual(writes, 0);
    // ...and one that read it records the chip for its target configuration.
    const chip = { cpuid: "412FC231", idcode: "20036410", uid: "0001020304050607080A0B0C" };
    const verified = await service.prepare(options);
    reportTargetIdentity(verified.targetCheck.checkId, chip);
    await service.recordSuccess(verified);
    await service.recordSuccess(verified);
    assert.strictEqual(writes, 1);
    assert.deepStrictEqual(saved, {
        version: 3,
        probe: "jlink.cfg",
        probeSerial: "",
        family: "jlink",
        deviceId: "",
        source: "auto",
        target: "stm32f1x.cfg",
        chip
    });
    const checked = await service.prepare(options);
    assert.deepStrictEqual(checked.targetCheck.expected, chip, "later operations check the recorded chip");
    assert.strictEqual(checked.selection.probe, "unique-device", "the probe is still chosen automatically");
    assert.strictEqual((await service.prepare({ ...options, target: "stm32f4x.cfg" })).targetCheck.expected, null);
    // The recorded chip belongs to the target configuration, so a probe of another family still checks it.
    assert.deepStrictEqual(service.expectedTarget("stm32f1x.cfg", { ...saved, probe: "cmsis-dap.cfg" }), chip);
    reportTargetIdentity(checked.targetCheck.checkId, chip);
    await service.recordSuccess(checked);
    assert.strictEqual(writes, 1, "an unchanged chip is not written again");
    writes = 0;

    // A probe the user picked is used as named, without a target check.
    const picked = (serial, deviceId) => ({
        version: 3,
        probe: "jlink.cfg",
        probeSerial: serial,
        family: "jlink",
        deviceId,
        source: "user"
    });
    saved = picked("1234", "usb-1");
    const remembered = await service.prepare(options);
    assert.strictEqual(remembered.selection.probe, "remembered");
    assert.strictEqual(remembered.probeSerial, "1234");
    assert.strictEqual(remembered.targetCheck, undefined, "a picked probe is not checked");
    assert.strictEqual(remembered.transport, "swd", "known Cortex-M uses SWD");
    assert.strictEqual(remembered.selection.transport, "cortex-m");
    assert.strictEqual((await service.prepare({ ...options, target: "other.cfg" })).transport, "auto");

    // A success on the picked probe keeps it the user's pick instead of turning it into a success record.
    writes = 0;
    await service.recordSuccess(await service.prepare(options));
    assert.strictEqual(writes, 1);
    assert.deepStrictEqual(saved, picked("1234", "usb-1"));
    // A probeSerial setting naming another device of the same script leaves the pick for when it is cleared.
    devices = [
        { family: "jlink", serial: "1234", id: "usb-1" },
        { family: "jlink", serial: "5678", id: "usb-2" }
    ];
    config = { ...config, probeSerial: "5678" };
    await service.recordSuccess(await service.prepare(options));
    assert.strictEqual(writes, 1, "a success through the setting does not replace the pick");
    config = { ...config, probeSerial: "" };
    // A pick made under another interface script is not used, so that script runs in automatic mode, and a
    // success there remembers only the script.
    assert.strictEqual(service.isAutomatic(options), false);
    assert.strictEqual(service.isAutomatic({ probe: "cmsis-dap.cfg" }), true);
    await service.recordSuccess({ probe: "cmsis-dap.cfg", probeSerial: "ABC", deviceId: "usb-9" });
    assert.deepStrictEqual(saved, {
        version: 3,
        probe: "cmsis-dap.cfg",
        probeSerial: "",
        family: "cmsis-dap",
        deviceId: "",
        source: "success"
    });
    // A success outside automatic mode's checks keeps the chip it recorded for the same script.
    const autoRecord = { ...saved, probe: "jlink.cfg", family: "jlink", source: "auto", target: "stm32f1x.cfg", chip };
    saved = autoRecord;
    writes = 0;
    await service.recordSuccess({ probe: "jlink.cfg", probeSerial: "1234", deviceId: "usb-1" });
    assert.strictEqual(writes, 0);
    assert.strictEqual(saved, autoRecord);

    // A picked probe that is missing is never replaced and nothing prompts; an interactive caller has the sidebar
    // list revealed, which shows the probe as not connected.
    saved = picked("1234", "usb-1");
    devices = [{ family: "jlink", serial: "5678", id: "usb-2" }];
    await assert.rejects(service.prepare(options), {
        code: "PROBE_SELECTED_NOT_FOUND",
        details: { probeSerial: "1234", remembered: true, devices },
        i18nKey: "probe.rememberedNotFound",
        i18nParams: { label: "J-Link", serial: "1234" }
    });
    assert.strictEqual(reveals, 0, "Agent and background callers do not reveal the list");
    await assert.rejects(service.prepare(options, true), { code: "PROBE_SELECTED_NOT_FOUND" });
    assert.strictEqual(reveals, 1);
    assert.deepStrictEqual(saved, picked("1234", "usb-1"), "the missing pick is kept");
    assert.strictEqual(
        i18n.t("zh", "probe.rememberedNotFound", { label: "J-Link", serial: "1234" }),
        "已选择的 J-Link（1234）未连接，不会自动改用其他设备。请重新连接它，或在“已连接调试器”中改选其他设备或点击“自动”"
    );
    // An explicitly configured serial stays strict and is changed in settings, not in the list.
    config = { ...config, probeSerial: "9999" };
    await assert.rejects(service.prepare(options, true), {
        code: "PROBE_SELECTED_NOT_FOUND",
        details: { probeSerial: "9999", remembered: false, devices },
        i18nKey: "probe.selectedNotFound"
    });
    assert.strictEqual(reveals, 1);
    config = { ...config, probeSerial: "5678", transport: "jtag" };
    const explicit = await service.prepare(options);
    assert.strictEqual(explicit.transport, "jtag");
    assert.strictEqual(explicit.probeSerial, "5678");
    const session = { options: explicit };
    config = { ...config, transport: "swd" };
    assert.throws(() => service.assertCurrent(session), { code: "PROBE_SESSION_STALE" });
    const writesBeforeStale = writes;
    await service.recordSuccess(explicit);
    assert.strictEqual(writes, writesBeforeStale, "recordSuccess does not write if settings changed");
    config = { ...config, transport: "jtag" };
    assert.throws(() => service.assertCurrent(session), { code: "PROBE_SESSION_STALE" });
    const externalDap = {};
    service.markConfigurationChanged([externalDap]);
    assert.throws(() => service.assertCurrent(externalDap), { code: "PROBE_SESSION_STALE" });

    // Several probes of one family that automatic mode cannot choose between are picked in the sidebar list.
    saved = null;
    config = { ...config, transport: "auto", probeSerial: "" };
    devices.push({ family: "jlink", serial: "1234", id: "usb-1" });
    await assert.rejects(service.prepare(options), {
        code: "PROBE_SELECTION_REQUIRED",
        i18nKey: "probe.chooseInSidebar"
    });
    assert.strictEqual(reveals, 1);
    await assert.rejects(service.prepare(options, true), {
        code: "PROBE_SELECTION_REQUIRED",
        i18nKey: "probe.chooseInSidebar"
    });
    assert.strictEqual(reveals, 2);
    assert.strictEqual(saved, null, "failing to choose remembers nothing");
    assert.strictEqual(config.probeSerial, "");
    // Probes the list cannot save by serial keep the guidance to disconnect or configure one.
    devices = [
        { family: "jlink", serial: "", id: "usb-a" },
        { family: "jlink", serial: "", id: "usb-b" }
    ];
    await assert.rejects(service.prepare(options, true), {
        code: "PROBE_SELECTION_REQUIRED",
        i18nKey: "probe.selectionRequired"
    });
    assert.strictEqual(reveals, 2);
    devices = [];
    // An empty inventory keeps the interface default instead of prompting.
    assert.strictEqual((await service.prepare(options, true)).selection.probe, "script-default");
    assert.strictEqual(reveals, 2);
    const automatic = new ProbeConnectionService({
        getConfig: () => ({ mcu: "stm32f4x.cfg" }),
        detectProbe: async () => ({ probe: "jlink.cfg", candidates: ["jlink.cfg"] }),
        prepareConnection: async (options) => ({ ...options, transport: "swd" })
    });
    assert.strictEqual((await automatic.prepare({})).probe, "jlink.cfg");
    automatic.detectProbe = async () => ({ probe: "", candidates: ["jlink.cfg", "stlink.cfg"] });
    await assert.rejects(automatic.prepare({}), { code: "PROBE_SELECTION_REQUIRED" });
    automatic.getSuccessfulConnection = () => ({ version: 1, probe: "jlink.cfg" });
    assert.strictEqual(await automatic.resolveProbe(), "jlink.cfg");

    let preflightCalls = 0;
    const switching = new ProbeConnectionService({
        getConfig: () => ({ debugger: "jlink.cfg" }),
        beforePrepare: () => {
            throw Object.assign(new Error("Driver switch in progress"), { code: "PROBE_DRIVER_BUSY" });
        },
        prepareConnection: async () => {
            preflightCalls++;
        }
    });
    await assert.rejects(switching.prepare(options), { code: "PROBE_DRIVER_BUSY" });
    assert.strictEqual(preflightCalls, 0, "driver switching blocks hardware operations before preflight starts");
    let startSwitch = false;
    let finishPreflight;
    const preflightPending = new Promise((resolve) => (finishPreflight = resolve));
    const overlapping = new ProbeConnectionService({
        getConfig: () => ({ debugger: "jlink.cfg" }),
        beforePrepare: () => {
            if (startSwitch) throw Object.assign(new Error("Driver switch in progress"), { code: "PROBE_DRIVER_BUSY" });
        },
        prepareConnection: async () => {
            await preflightPending;
            return { probe: "jlink.cfg", selection: {} };
        }
    });
    const pendingOperation = overlapping.prepare(options);
    await new Promise((resolve) => setImmediate(resolve));
    startSwitch = true;
    finishPreflight();
    await assert.rejects(pendingOperation, { code: "PROBE_DRIVER_BUSY" });

    const driverError = Object.assign(new Error("SEGGER requires WinUSB"), {
        code: "PROBE_DRIVER_UNSUPPORTED",
        details: { instanceId: "usb-1" }
    });
    const notifications = [];
    const unsupportedDriver = new ProbeConnectionService({
        getConfig: () => ({ debugger: "jlink.cfg" }),
        prepareConnection: async () => {
            throw driverError;
        },
        onDriverUnsupported: (error) => {
            notifications.push(error);
            // An unanswered desktop notification must not hold the operation's lease or delay its error.
            return new Promise(() => {});
        }
    });
    await assert.rejects(unsupportedDriver.prepare(options, true), (error) => error === driverError);
    await assert.rejects(unsupportedDriver.prepare(options), (error) => error === driverError);
    assert.deepStrictEqual(notifications, [driverError, driverError], "UI and Agent operations notify and still fail");
    unsupportedDriver.prepareConnection = async () => {
        throw Object.assign(new Error("Probe missing"), { code: "PROBE_SELECTED_NOT_FOUND" });
    };
    await assert.rejects(unsupportedDriver.prepare(options, true), { code: "PROBE_SELECTED_NOT_FOUND" });
    assert.strictEqual(notifications.length, 2, "other connection errors do not trigger driver notifications");
    unsupportedDriver.onDriverUnsupported = () => {};
    unsupportedDriver.prepareConnection = async () => {
        throw driverError;
    };
    await assert.rejects(unsupportedDriver.prepare(options), (error) => error === driverError);
    console.log("Automatic connection, streamlined history, single preflight and stale session tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
