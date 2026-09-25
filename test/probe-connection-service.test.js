"use strict";
const assert = require("assert");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");

async function main() {
    let config = { transport: "auto", probeSerial: "", adapterSpeedKhz: 0 };
    let devices = [{ family: "jlink", serial: "1234", id: "usb-1" }];
    let saved = null,
        writes = 0,
        prompts = 0,
        selected = { value: "5678" };
    const service = new ProbeConnectionService({
        getConfig: () => config,
        getSuccessfulConnection: () => saved,
        saveSuccessfulConnection: async (value) => {
            writes++;
            saved = value;
        },
        window: {
            showQuickPick: async () => {
                prompts++;
                return selected;
            }
        },
        prepareConnection: async (options) => ({
            ...resolveProbeConnection(options, { available: true, devices }),
            adapterFamily: "jlink"
        })
    });
    const options = { probe: "jlink.cfg", target: "stm32f1x.cfg", executable: "openocd" };
    const result = await service.prepare(options, true);
    assert.strictEqual(prompts, 0);
    assert.strictEqual(result.probeSerial, "1234");
    assert.strictEqual(result.transport, "swd");
    assert.strictEqual(saved, null, "preflight must not record success");
    assert.strictEqual(config.probeSerial, "", "automatic choices must not overwrite settings");
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.selection));

    // recordSuccess only writes probe and probeSerial
    await service.recordSuccess(result);
    await service.recordSuccess(result);
    assert.strictEqual(writes, 1);
    assert.deepStrictEqual(saved, {
        version: 1,
        probe: "jlink.cfg",
        probeSerial: "1234"
    });

    // Test reading legacy record containing deviceId, target, transport, fingerprint
    saved = {
        version: 1,
        probe: "jlink.cfg",
        probeSerial: "1234",
        deviceId: "usb-1",
        target: "stm32f1x.cfg",
        transport: "jtag",
        fingerprint: "legacy-v1"
    };
    const remembered = await service.prepare(options);
    assert.strictEqual(remembered.selection.probe, "remembered");
    assert.strictEqual(remembered.probeSerial, "1234");
    assert.strictEqual(remembered.transport, "swd", "known Cortex-M uses SWD; old recorded transport is not reused");
    assert.strictEqual(remembered.selection.transport, "cortex-m");
    assert.strictEqual((await service.prepare({ ...options, target: "other.cfg" })).transport, "auto");

    // After connecting successfully with legacy record in workspace, recordSuccess migrates it
    writes = 0;
    const freshResult = await service.prepare(options);
    await service.recordSuccess(freshResult);
    assert.strictEqual(writes, 1);
    assert.deepStrictEqual(saved, {
        version: 1,
        probe: "jlink.cfg",
        probeSerial: "1234"
    });

    devices = [{ family: "jlink", serial: "5678", id: "usb-2" }];
    await assert.rejects(service.prepare(options), { code: "PROBE_SELECTED_NOT_FOUND" });
    config = { ...config, probeSerial: "5678", transport: "jtag" };
    const explicit = await service.prepare(options);
    assert.strictEqual(explicit.transport, "jtag");
    assert.strictEqual(explicit.probeSerial, "5678");
    const session = { options: explicit };
    config = { ...config, transport: "swd" };
    assert.throws(() => service.assertCurrent(session), { code: "PROBE_SESSION_STALE" });
    await service.recordSuccess(explicit);
    assert.strictEqual(writes, 1, "recordSuccess does not write if settings changed");
    config = { ...config, transport: "jtag" };
    assert.throws(() => service.assertCurrent(session), { code: "PROBE_SESSION_STALE" });
    const externalDap = {};
    service.markConfigurationChanged([externalDap]);
    assert.throws(() => service.assertCurrent(externalDap), { code: "PROBE_SESSION_STALE" });
    saved = null;
    config = { ...config, transport: "auto", probeSerial: "" };
    devices.push({ family: "jlink", serial: "1234", id: "usb-1" });
    await assert.rejects(service.prepare(options), { code: "PROBE_SELECTION_REQUIRED" });
    assert.strictEqual(prompts, 0);
    const chosen = await service.prepare(options, true);
    assert.strictEqual(prompts, 1);
    assert.strictEqual(chosen.probeSerial, "5678");
    assert.strictEqual(config.probeSerial, "");
    assert.strictEqual(saved, null);
    selected = undefined;
    await assert.rejects(service.prepare(options, true), { code: "PROBE_SELECTION_CANCELLED" });
    devices = [];
    await assert.rejects(service.prepare(options, true), { code: "PROBE_SELECTION_REQUIRED" });
    assert.strictEqual(prompts, 2);
    await service.forgetSuccess();
    assert.strictEqual(saved, undefined);
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

    // Single preflight entry: driverService.requireWinUsb is not redundantly called after prepareConnection
    let redundantChecks = 0;
    automatic.driverService = {
        requireWinUsb: () => {
            redundantChecks++;
        }
    };
    await automatic.prepare({});
    assert.strictEqual(redundantChecks, 0, "prepareConnection is the single preflight entry point");

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
    console.log("Automatic connection, streamlined history, single preflight and stale session tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
