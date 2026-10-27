"use strict";
const assert = require("assert");
const { describeProbeSelection } = require("../skills/_emberprobe/probe-choice");
const { ProbeInventoryService, POLL_DELAYS, STABLE_SCANS } = require("../src/services/probeInventoryService");

function jlink(serial, service = "jlink", pid = "0101") {
    const id = `USB\\VID_1366&PID_${pid}\\${serial.padStart(12, "0")}`;
    return {
        id,
        family: "jlink",
        name: "J-Link",
        serial,
        vid: "1366",
        pid,
        serialSource: "os-instance",
        interfaces: [{ instanceId: id, name: "J-Link", service, driverProvider: "SEGGER", driverInf: "oem12.inf" }]
    };
}
const dap = (id, serial = "") => ({ id, family: "cmsis-dap", name: "CMSIS-DAP", serial, serialSource: "usb" });
const describe = (config, inventory) => describeProbeSelection(config, inventory, "win32", "x64");
const byId = (view) => Object.fromEntries(view.devices.map((device) => [device.id, device]));

async function main() {
    const first = jlink("1234");
    const second = jlink("5678", "WinUSB");
    const anonymousA = dap("USB\\VID_C251&PID_F001\\1&A");
    const anonymousB = dap("USB\\VID_C251&PID_F001\\1&B");
    const inventory = { available: true, devices: [first, second, anonymousA, anonymousB] };

    // Every connected probe is listed whatever the interface script, with the reason it cannot be chosen.
    const ambiguous = describe({ probe: "jlink.cfg" }, inventory);
    assert.strictEqual(ambiguous.state, "ambiguous");
    assert.strictEqual(ambiguous.error.code, "PROBE_SELECTION_REQUIRED");
    assert.strictEqual(ambiguous.devices.length, 4);
    let devices = byId(ambiguous);
    assert.deepStrictEqual(
        [devices[first.id].selectable, devices[first.id].matchesDebugger, devices[first.id].defaultConfig],
        [true, true, "jlink.cfg"]
    );
    assert.strictEqual(devices[anonymousA.id].matchesDebugger, false);
    assert.strictEqual(devices[anonymousA.id].selectable, false, "several serial-less probes cannot be told apart");
    assert.strictEqual(devices[anonymousA.id].reasonKey, "probe.noTrustedSerial");
    assert.deepStrictEqual(devices[first.id].driver, { kind: "repair", instanceId: first.id });
    assert.deepStrictEqual(devices[second.id].driver, { kind: "ready", instanceId: second.id });
    assert.strictEqual(devices[anonymousA.id].driver, undefined, "only J-Links carry a USB driver state");

    // Settings override, then the workspace selection, then a unique device.
    const configured = describe({ probe: "jlink.cfg", probeSerial: "5678" }, inventory);
    assert.deepStrictEqual(
        [configured.state, configured.source, configured.deviceId],
        ["selected", "setting", second.id]
    );
    assert(byId(configured)[second.id].selected && !byId(configured)[first.id].selected);
    const remembered = describe(
        { probe: "jlink.cfg", successfulConnection: { version: 3, probe: "jlink.cfg", probeSerial: "1234" } },
        inventory
    );
    assert.deepStrictEqual(
        [remembered.state, remembered.source, remembered.deviceId],
        ["selected", "remembered", first.id]
    );
    const unique = describe({ probe: "cmsis-dap.cfg" }, { available: true, devices: [first, anonymousA] });
    assert.deepStrictEqual(
        [unique.state, unique.source, unique.deviceId],
        ["selected", "unique-device", anonymousA.id]
    );
    assert.strictEqual(byId(unique)[anonymousA.id].selectable, true, "a lone serial-less probe is selectable");

    // A Windows serial containing "_" is told apart once the hub has returned its exact descriptor.
    const aliased = (serial, descriptorSerial) => ({
        ...dap(`USB\\VID_C251&PID_F001\\${serial}`, serial),
        serialSource: "os-instance",
        ...(descriptorSerial ? { descriptorSerial } : {})
    });
    const read = aliased("LU_2022_8888", "LU 2022 8888");
    const unread = aliased("LU_2022_9999");
    const plain = aliased("0001A0000000");
    devices = byId(describe({ probe: "cmsis-dap.cfg" }, { available: true, devices: [read, unread, plain] }));
    assert.deepStrictEqual([devices[read.id].selectable, devices[read.id].trustedSerial], [true, "LU 2022 8888"]);
    assert.deepStrictEqual(
        [devices[unread.id].selectable, devices[unread.id].reasonKey],
        [false, "probe.noTrustedSerial"]
    );
    assert.deepStrictEqual([devices[plain.id].selectable, devices[plain.id].trustedSerial], [true, "0001A0000000"]);

    // A remembered or configured probe that is gone stays the selection; another device is never chosen.
    const gone = describe(
        { probe: "jlink.cfg", successfulConnection: { version: 2, probe: "jlink.cfg", probeSerial: "9999" } },
        { available: true, devices: [first] }
    );
    assert.deepStrictEqual(
        [gone.state, gone.source, gone.probeSerial, gone.deviceId],
        ["absent", "remembered", "9999", ""]
    );
    assert.strictEqual(gone.error.i18nKey, "probe.rememberedNotFound");
    assert(!byId(gone)[first.id].selected);
    const missingSetting = describe({ probe: "jlink.cfg", probeSerial: "9999" }, { available: true, devices: [first] });
    assert.deepStrictEqual([missingSetting.state, missingSetting.source], ["absent", "setting"]);

    // Custom scripts, an empty bus and an unreadable inventory are reported as such.
    assert.strictEqual(describe({ probe: "my-board.cfg" }, inventory).state, "script");
    const unconfigured = describe({ probe: "" }, inventory);
    assert.deepStrictEqual([unconfigured.state, unconfigured.devices.length], ["unconfigured", 4]);
    assert.strictEqual(describe({ probe: "jlink.cfg" }, { available: true, devices: [] }).state, "none");
    const unavailable = describe({ probe: "jlink.cfg" }, { available: false, devices: [] });
    assert.deepStrictEqual([unavailable.state, unavailable.devices], ["unavailable", []]);
    assert.strictEqual(
        describeProbeSelection({ probe: "jlink.cfg" }, { available: true, devices: [first] }, "linux", "x64").devices[0]
            .driver,
        undefined,
        "USB driver switching is Windows-only"
    );
    const unlisted = jlink("4321", "jlink", "9999");
    assert.deepStrictEqual(
        describe({ probe: "jlink.cfg" }, { available: true, devices: [unlisted] }).devices[0].driver,
        {
            kind: "unsupported",
            reasonKey: "probe.driverReasonProduct"
        }
    );

    // The service scans every family, reconciles driver changes and keeps the newest started scan.
    const requests = [];
    const pending = [];
    const service = new ProbeInventoryService({
        listProbes: (options) => {
            requests.push(options);
            return new Promise((resolve) => pending.push(resolve));
        },
        reconcile: async (value) => ({ ...value, reconciled: true }),
        now: () => 42,
        platform: "win32",
        arch: "x64"
    });
    assert.strictEqual(service.describe({ probe: "jlink.cfg" }).state, "unavailable", "no scan yet");
    const older = service.scan();
    const newer = service.scan();
    pending[1]({ available: true, devices: [second] });
    const newerResult = await newer;
    assert.deepStrictEqual(requests, [{ family: "all" }, { family: "all" }]);
    assert.deepStrictEqual(
        [newerResult.revision, newerResult.current, newerResult.inventory.reconciled],
        [2, true, true]
    );
    pending[0]({ available: true, devices: [] });
    const olderResult = await older;
    assert.deepStrictEqual([olderResult.revision, olderResult.current], [1, false]);
    assert.strictEqual(service.latest.revision, 2, "a slow older scan never replaces newer inventory");
    assert.strictEqual(service.latest.scannedAt, 42);
    assert.strictEqual(service.describe({ probe: "jlink.cfg" }).deviceId, second.id);
    assert.strictEqual(service.describe({ probe: "jlink.cfg" }, { available: true, devices: [] }).state, "none");

    // Polling slows down after several unchanged scans and speeds up on a change or a reset.
    const steady = { available: true, devices: [first] };
    const polled = new ProbeInventoryService({ listProbes: async () => steady, platform: "win32" });
    await polled.scan();
    assert.strictEqual(polled.pollDelay(), POLL_DELAYS.fast);
    for (let index = 0; index < STABLE_SCANS; index++) await polled.scan();
    assert.strictEqual(polled.pollDelay(), POLL_DELAYS.slow);
    polled.resetBackoff();
    assert.strictEqual(polled.pollDelay(), POLL_DELAYS.fast);
    for (let index = 0; index < STABLE_SCANS; index++) await polled.scan();
    steady.devices = [first, second];
    await polled.scan();
    assert.strictEqual(polled.pollDelay(), POLL_DELAYS.fast, "a changed inventory polls quickly again");
    const mac = new ProbeInventoryService({ listProbes: async () => steady, platform: "darwin" });
    await mac.scan();
    assert.strictEqual(mac.pollDelay(), POLL_DELAYS.macFast, "system_profiler scans are polled less often");
    for (let index = 0; index < STABLE_SCANS; index++) await mac.scan();
    assert.strictEqual(mac.pollDelay(), POLL_DELAYS.macSlow);

    console.log("Probe selection view and inventory service tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
