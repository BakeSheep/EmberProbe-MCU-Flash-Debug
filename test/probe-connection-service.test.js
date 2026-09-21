"use strict";
const assert = require("assert");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");

async function main() {
    let config = { transport: "auto", probeSerial: "", adapterSpeedKhz: 0 };
    const selections = [{ value: "swd" }, { value: "" }];
    const prompts = [];
    const service = new ProbeConnectionService({
        getConfig: () => config,
        save: async (values) => {
            config = { ...config, ...values };
        },
        window: {
            showQuickPick: async (_items, options) => {
                prompts.push(options.title);
                return selections.shift();
            },
            showInputBox: async (options) => {
                assert(options.validateInput("1; exit"));
                assert(options.validateInput(""));
                assert.strictEqual(options.validateInput("1234"), undefined);
                return "001234";
            }
        },
        prepareConnection: async (options) => resolveProbeConnection(options)
    });
    const options = { probe: "jlink.cfg", target: "stm32f1x.cfg", executable: "openocd" };
    await assert.rejects(service.prepare(options), (error) => error.code === "PROBE_TRANSPORT_REQUIRED");
    assert.deepStrictEqual(prompts, [], "Agent callers must never receive UI prompts");
    const result = await service.prepare(options, true);
    assert.deepStrictEqual(prompts, ["J-Link transport", "Select physical J-Link"]);
    assert.strictEqual(result.probeSerial, "1234");
    assert.strictEqual(result.transport, "swd");
    assert.strictEqual(config.probeSerial, "1234");
    assert(Object.isFrozen(result));
    config = { ...config, probeSerial: "5678" };
    assert.strictEqual(result.settingsIdentity.probeSerial, "1234", "running identity is a snapshot");
    const session = { options: result };
    assert.throws(() => service.assertCurrent(session), { code: "PROBE_SESSION_STALE" });
    config = { ...config, probeSerial: "1234" };
    assert.throws(() => service.assertCurrent(session), { code: "PROBE_SESSION_STALE" });
    const restarted = { options: await service.prepare(options) };
    service.assertCurrent(restarted);
    const externalDap = {};
    service.markConfigurationChanged([externalDap]);
    assert.throws(() => service.assertCurrent(externalDap), { code: "PROBE_SESSION_STALE" });
    config = { ...config, transport: "auto" };
    await assert.rejects(service.prepare(options, true), (error) => error.code === "PROBE_SELECTION_CANCELLED");
    console.log("Probe connection UI and Agent policy tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
