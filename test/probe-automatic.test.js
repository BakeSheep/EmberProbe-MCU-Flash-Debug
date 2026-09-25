"use strict";
const assert = require("assert");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
const { resolveInterfaceTransport, prepareProbeConnection } = require("../skills/_emberprobe/probe-preflight");
const { detectProbe } = require("../skills/_emberprobe/probe-detection");
const { ManagedOpenOcdSession } = require("../src/liveWatch");

async function main() {
    const inventory = { available: true, notes: [], devices: [{ family: "jlink", serial: "1234", id: "usb-1" }] };
    const config = { probe: "jlink.cfg", target: "stm32f4x.cfg", transport: "auto" };
    assert.strictEqual(
        resolveProbeConnection(config, { ...inventory, devices: [{ family: "jlink", serial: "1234" }] }).transport,
        "swd"
    );
    for (const target of ["stm32f4x.cfg", "stm32l0.cfg", "geehy/apm32f1x.cfg", "nordic/nrf52.cfg", "rp2040.cfg"])
        assert.strictEqual(resolveProbeConnection({ ...config, target }, inventory).transport, "swd");
    for (const target of ["gd32vf103.cfg", "esp32.cfg", "custom.cfg"])
        assert.strictEqual(resolveProbeConnection({ ...config, target }, inventory).transport, "auto");

    // Legacy record with extra fields (deviceId, fingerprint, transport: "jtag")
    const legacyConnection = {
        version: 1,
        probe: "jlink.cfg",
        probeSerial: "1234",
        deviceId: "usb-1",
        target: "stm32f4x.cfg",
        transport: "jtag",
        fingerprint: "legacy-v1"
    };
    // Reading legacy record must only use probe and probeSerial; legacy transport must NOT be reused
    const resolvedLegacy = resolveProbeConnection({ ...config, successfulConnection: legacyConnection }, inventory);
    assert.strictEqual(resolvedLegacy.probeSerial, "1234");
    assert.strictEqual(resolvedLegacy.selection.probe, "remembered");
    assert.strictEqual(
        resolvedLegacy.transport,
        "swd",
        "known Cortex-M uses SWD; old recorded transport is not reused"
    );
    assert.strictEqual(resolvedLegacy.selection.transport, "cortex-m");

    // User explicit transport takes highest priority over remembered and target defaults
    const explicitUser = resolveProbeConnection(
        { ...config, transport: "jtag", successfulConnection: legacyConnection },
        inventory
    );
    assert.strictEqual(explicitUser.transport, "jtag");
    assert.strictEqual(explicitUser.selection.transport, "explicit");

    // Non-Cortex-M target uses script default
    const nonCortex = resolveProbeConnection(
        { ...config, target: "gd32vf103.cfg", successfulConnection: legacyConnection },
        inventory
    );
    assert.strictEqual(nonCortex.transport, "auto");
    assert.strictEqual(nonCortex.selection.transport, "script-default");

    // Streamlined record with only probe and probeSerial
    const streamlinedConnection = {
        version: 1,
        probe: "jlink.cfg",
        probeSerial: "1234"
    };
    const resolvedStreamlined = resolveProbeConnection(
        { ...config, successfulConnection: streamlinedConnection },
        inventory
    );
    assert.strictEqual(resolvedStreamlined.probeSerial, "1234");
    assert.strictEqual(resolvedStreamlined.selection.probe, "remembered");
    assert.strictEqual(resolvedStreamlined.transport, "swd");

    // Device missing or ambiguous handling: never switches to other probes
    const cached = { ...config, successfulConnection: legacyConnection };
    assert.throws(() => resolveProbeConnection(cached, { available: false, devices: [] }), {
        code: "PROBE_IDENTITY_AMBIGUOUS"
    });
    assert.throws(() => resolveProbeConnection(cached, { ...inventory, devices: [] }), {
        code: "PROBE_SELECTED_NOT_FOUND"
    });
    assert.throws(
        () =>
            resolveProbeConnection(cached, {
                ...inventory,
                devices: [...inventory.devices, ...inventory.devices]
            }),
        { code: "PROBE_IDENTITY_AMBIGUOUS" }
    );
    assert.throws(
        () =>
            resolveProbeConnection(cached, {
                ...inventory,
                devices: [...inventory.devices, { family: "jlink", serial: "" }]
            }),
        { code: "PROBE_IDENTITY_AMBIGUOUS" }
    );

    const launch = {
        executable: "fake",
        scriptsRoot: "scripts",
        probePath: "interface/jlink.cfg",
        targetPath: "target/stm32f4x.cfg"
    };
    let calls = 0;
    const query = async (_exe, args) => {
        calls++;
        assert(args.includes("noinit"));
        assert(!args.includes("init") && !args.includes(launch.targetPath));
        return "EP_TRANSPORT=swd\n";
    };
    assert.strictEqual(await resolveInterfaceTransport(launch, "swd", query), "swd");
    assert.strictEqual(await resolveInterfaceTransport(launch, "auto", async () => "EP_TRANSPORT=jtag\n"), "jtag");
    await assert.rejects(resolveInterfaceTransport(launch, "hla_swd", query), { code: "OPENOCD_TRANSPORT_INVALID" });
    await assert.rejects(
        resolveInterfaceTransport(launch, "swd", async () => {
            throw new Error("JTAG-only script");
        }),
        { code: "OPENOCD_TRANSPORT_INVALID" }
    );
    await assert.rejects(
        resolveInterfaceTransport(launch, "swd", async () => "EP_TRANSPORT=jtag"),
        { code: "PROBE_CAPABILITY_UNKNOWN" }
    );
    await assert.rejects(
        resolveInterfaceTransport(launch, "auto", async () => "unknown output"),
        { code: "PROBE_CAPABILITY_UNKNOWN" }
    );
    const dependencies = {
        resolveLaunch: () => launch,
        checkCapability: async () => ({ adapterFamily: "jlink" }),
        listProbes: async () => inventory,
        resolveTransport: (l, t) => resolveInterfaceTransport(l, t, query)
    };
    const prepared = await prepareProbeConnection(config, dependencies);
    assert.strictEqual(prepared.transport, "swd");
    assert.strictEqual(calls, 2, "one validation per preparation; no fallback attempts");
    assert.strictEqual(prepared.fingerprint, undefined, "fingerprint is removed from preflight output");

    const discovered = await detectProbe({ usbInventory: async () => "", listProbes: async () => inventory });
    assert.strictEqual(discovered.probe, "jlink.cfg");
    assert.strictEqual(
        (await detectProbe({ usbInventory: async () => "ST-Link", listProbes: async () => inventory })).probe,
        ""
    );

    let confirmations = 0;
    const session = new ManagedOpenOcdSession(null, {}, { onConnectionConfirmed: () => confirmations++ });
    session.stopped = false;
    session._readMemoryBytes = async () => null;
    const items = [{ name: "x", address: 0x20000000, size: 4 }];
    await session._readItems(items, 0);
    assert.strictEqual(confirmations, 0);
    session._readMemoryBytes = async () => [1, 2, 3, 4];
    await session._readItems(items, 0);
    await session._readItems(items, 1);
    assert.strictEqual(confirmations, 1);
    const cancelled = new ManagedOpenOcdSession(null, {}, { onConnectionConfirmed: () => confirmations++ });
    cancelled._readMemoryBytes = async () => {
        cancelled.sampleEpoch++;
        return [1, 2, 3, 4];
    };
    await assert.rejects(cancelled._readItems(items, 0, { epoch: cancelled.sampleEpoch }), {
        code: "LIVE_READ_CANCELLED"
    });
    assert.strictEqual(confirmations, 1);
    console.log("Automatic transport, streamlined history, discovery and read confirmation tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
