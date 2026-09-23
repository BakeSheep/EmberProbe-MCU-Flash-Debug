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
        fingerprint = "v1",
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
            ...resolveProbeConnection({ ...options, fingerprint }, { available: true, devices }),
            adapterFamily: "jlink",
            fingerprint
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
    await service.recordSuccess(result);
    await service.recordSuccess(result);
    assert.strictEqual(writes, 1);
    assert.strictEqual(saved.probeSerial, "1234");
    const remembered = await service.prepare(options);
    assert.strictEqual(remembered.selection.transport, "remembered");
    assert.strictEqual(remembered.selection.probe, "remembered");
    fingerprint = "v2";
    assert.strictEqual((await service.prepare(options)).selection.transport, "cortex-m");
    assert.strictEqual((await service.prepare({ ...options, target: "other.cfg" })).transport, "auto");
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
    assert.strictEqual(writes, 1);
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
    console.log("Automatic connection, history and stale session tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
