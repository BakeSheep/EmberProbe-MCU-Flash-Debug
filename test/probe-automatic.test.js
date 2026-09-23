"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
const { resolveInterfaceTransport, prepareProbeConnection } = require("../skills/_emberprobe/probe-preflight");
const { connectionFingerprint } = require("../skills/_emberprobe/connection-fingerprint");
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
    const successfulConnection = {
        version: 1,
        ...config,
        transport: "jtag",
        probeSerial: "1234",
        deviceId: "usb-1",
        fingerprint: "v1"
    };
    const cached = { ...config, successfulConnection, fingerprint: "v1" };
    assert.strictEqual(resolveProbeConnection(cached, inventory).transport, "jtag");
    assert.strictEqual(resolveProbeConnection({ ...cached, fingerprint: "v2" }, inventory).transport, "swd");
    assert.strictEqual(resolveProbeConnection({ ...cached, target: "stm32f1x.cfg" }, inventory).transport, "swd");
    assert.strictEqual(resolveProbeConnection({ ...cached, transport: "swd" }, inventory).transport, "swd");
    assert.strictEqual(
        resolveProbeConnection(cached, { ...inventory, devices: [{ ...inventory.devices[0], id: "usb-2" }] }).transport,
        "swd"
    );
    assert.throws(() => resolveProbeConnection(cached, { available: false, devices: [] }), {
        code: "PROBE_IDENTITY_AMBIGUOUS"
    });
    assert.throws(() => resolveProbeConnection(cached, { ...inventory, devices: [] }), {
        code: "PROBE_SELECTED_NOT_FOUND"
    });
    assert.throws(
        () => resolveProbeConnection(cached, { ...inventory, devices: [...inventory.devices, ...inventory.devices] }),
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
        fingerprint: async () => "v1",
        resolveTransport: (l, t) => resolveInterfaceTransport(l, t, query)
    };
    const prepared = await prepareProbeConnection(config, dependencies);
    assert.strictEqual(prepared.transport, "swd");
    assert.strictEqual(calls, 2, "one validation per preparation; no fallback attempts");
    await prepareProbeConnection(config, {
        ...dependencies,
        fingerprint: async () => {
            throw new Error("unreadable");
        }
    });
    assert(inventory.notes.some((note) => note.includes("fingerprint")));
    const discovered = await detectProbe({ usbInventory: async () => "", listProbes: async () => inventory });
    assert.strictEqual(discovered.probe, "jlink.cfg");
    assert.strictEqual(
        (await detectProbe({ usbInventory: async () => "ST-Link", listProbes: async () => inventory })).probe,
        ""
    );

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "emberprobe-fingerprint-"));
    try {
        const executable = path.join(root, "openocd");
        const scriptsRoot = path.join(root, "scripts");
        await fs.mkdir(path.join(scriptsRoot, "helpers"), { recursive: true });
        await fs.writeFile(executable, "binary1");
        const helper = path.join(scriptsRoot, "helpers", "dep.tcl");
        await fs.writeFile(helper, "first");
        const input = { ...launch, executable, scriptsRoot };
        const first = await connectionFingerprint(input);
        assert.strictEqual(await connectionFingerprint(input), first);
        await fs.writeFile(helper, "other");
        const second = await connectionFingerprint(input);
        assert.notStrictEqual(first, second, "sourced script contents invalidate history");
        await fs.writeFile(executable, "binary2");
        assert.notStrictEqual(await connectionFingerprint(input), second);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }

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
    console.log("Automatic transport, cache fingerprints, discovery and read confirmation tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
