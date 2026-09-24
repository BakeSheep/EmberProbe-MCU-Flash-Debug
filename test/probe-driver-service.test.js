"use strict";

const assert = require("assert");
const { ProbeDriverService, classifyJlinkDriver, JLINK_PIDS } = require("../src/services/probeDriverService");
const { prepareProbeConnection } = require("../skills/_emberprobe/probe-preflight");

const id = "USB\\VID_1366&PID_0101\\000020781318";
function connection({
    service = "jlink",
    provider = "SEGGER Microcontroller GmbH",
    inf = "oem59.inf",
    extra = []
} = {}) {
    return {
        adapterFamily: "jlink",
        deviceId: id,
        inventory: {
            available: true,
            devices: [
                {
                    id,
                    family: "jlink",
                    name: "SAM-ICE",
                    serial: "20781318",
                    vid: "1366",
                    pid: "0101",
                    interfaces: [
                        { instanceId: id, service, driverProvider: provider, driverInf: inf, name: "SAM-ICE" },
                        ...extra
                    ]
                }
            ]
        }
    };
}

async function main() {
    assert(JLINK_PIDS.has("0101") && JLINK_PIDS.has("1061") && !JLINK_PIDS.has("ffff"));
    const before = connection();
    assert.deepStrictEqual(classifyJlinkDriver(before, "win32", "x64"), {
        kind: "repair",
        instanceId: id,
        driverInf: "oem59.inf"
    });
    assert.strictEqual(classifyJlinkDriver(connection({ service: "WinUSB" }), "win32", "x64").kind, "ready");
    assert.strictEqual(classifyJlinkDriver(before, "linux", "x64").kind, "not-applicable");
    assert.strictEqual(classifyJlinkDriver(before, "win32", "arm64").kind, "unsupported");
    assert.strictEqual(classifyJlinkDriver(connection({ provider: "Unrelated" }), "win32", "x64").kind, "unknown");
    assert.strictEqual(classifyJlinkDriver(connection({ inf: "" }), "win32", "x64").kind, "unknown");
    assert.strictEqual(classifyJlinkDriver({ ...before, deviceId: "" }, "win32", "x64").kind, "unknown");
    const unsupported = connection();
    unsupported.inventory.devices[0].pid = "9999";
    assert.strictEqual(classifyJlinkDriver(unsupported, "win32", "x64").kind, "unsupported");
    const flasher = connection();
    flasher.inventory.devices[0].name = "SEGGER Flasher";
    assert.strictEqual(classifyJlinkDriver(flasher, "win32", "x64").kind, "unsupported");
    const composite = connection();
    const child = `${id.replace("\\000020781318", "&MI_00\\000020781318")}`;
    composite.inventory.devices[0].interfaces = [
        { instanceId: id, service: "usbccgp", name: "USB Composite Device" },
        { instanceId: child, service: "jlink", driverProvider: "SEGGER", driverInf: "oem59.inf", name: "J-Link" },
        { instanceId: child.replace("MI_00", "MI_01"), service: "usbser", name: "VCOM" }
    ];
    assert.strictEqual(classifyJlinkDriver(composite, "win32", "x64").instanceId, child);
    const unknownParent = connection();
    unknownParent.deviceId = "{E28FA1C8-39A1-4A1B-9E18-26BD4691534C}";
    unknownParent.inventory.devices[0].id = unknownParent.deviceId;
    assert.strictEqual(classifyJlinkDriver(unknownParent, "win32", "x64").kind, "unknown");
    const unrelatedChild = connection();
    unrelatedChild.inventory.devices[0].interfaces.push({
        instanceId: "USB\\VID_1366&PID_0102&MI_00\\OTHER",
        service: "usbser",
        name: "VCOM"
    });
    assert.strictEqual(classifyJlinkDriver(unrelatedChild, "win32", "x64").kind, "unknown");
    composite.inventory.devices[0].interfaces.push({
        instanceId: child.replace("MI_00", "MI_02"),
        service: "jlink",
        driverProvider: "SEGGER",
        driverInf: "oem59.inf",
        name: "J-Link"
    });
    assert.strictEqual(classifyJlinkDriver(composite, "win32", "x64").kind, "unknown");
    const multiple = connection();
    multiple.inventory.devices.push({ ...multiple.inventory.devices[0], id: "USB\\VID_1366&PID_0102\\OTHER" });
    assert.strictEqual(classifyJlinkDriver(multiple, "win32", "x64").instanceId, id);
    multiple.inventory.devices.push({ ...multiple.inventory.devices[0] });
    assert.strictEqual(classifyJlinkDriver(multiple, "win32", "x64").kind, "unknown");

    let calls = 0;
    let readinessChecks = 0;
    const ready = connection({ service: "WinUSB", provider: "libwdi", inf: "oem64.inf" });
    const service = new ProbeDriverService({
        platform: "win32",
        arch: "x64",
        extensionPath: __dirname,
        run: async (_file, action, selected) => {
            assert.strictEqual(selected, id);
            if (action === "install") calls++;
            else if (action === "status") return "WinUSB oem64.inf";
            else assert.fail(`unexpected driver action: ${action}`);
        },
        inventory: async () => ready.inventory,
        verifyReady: async () => {
            readinessChecks++;
        },
        wait: async () => {}
    });
    // The native helper is a release artifact; test the service's invocation boundary without a binary.
    service.invoke = async (action, selected) => service.run("helper", action, selected);
    assert.throws(() => service.requireWinUsb(before), {
        code: "PROBE_DRIVER_UNSUPPORTED",
        i18nKey: "probe.driverUnsupported"
    });
    assert.strictEqual(service.requireWinUsb(ready), ready);
    assert.throws(() => service.requireWinUsb(connection({ inf: "" })), { code: "PROBE_DRIVER_UNSUPPORTED" });
    assert.strictEqual(calls, 0, "driver validation must not invoke the installer");
    let transportChecks = 0;
    await assert.rejects(
        prepareProbeConnection(
            { executable: "fake-openocd", probe: "jlink.cfg", target: "stm32f4x.cfg", probeSerial: "20781318" },
            {
                resolveLaunch: () => ({ executable: "fake-openocd" }),
                checkCapability: async () => ({ adapterFamily: "jlink" }),
                listProbes: async () => before.inventory,
                platform: "win32",
                arch: "x64",
                fingerprint: async () => "",
                resolveTransport: async () => {
                    transportChecks++;
                    return "swd";
                }
            }
        ),
        { code: "PROBE_DRIVER_UNSUPPORTED", i18nKey: "probe.driverUnsupported" }
    );
    assert.strictEqual(transportChecks, 0, "SEGGER is rejected before transport selection or target startup");
    const unknownDriver = connection({ provider: "Unknown" });
    assert.strictEqual(await service.ensure(unknownDriver), unknownDriver, "unknown drivers must not be changed");
    const inventoryUnavailable = { ...before, inventory: { available: false, devices: [] } };
    assert.strictEqual(await service.ensure(inventoryUnavailable), inventoryUnavailable);
    const results = await Promise.all([service.ensure(before), service.ensure(before)]);
    assert.strictEqual(calls, 1, "concurrent first connections share one driver installation");
    assert.strictEqual(readinessChecks, 1, "the switch verifies interface readiness before completing");
    assert.strictEqual(results[0].inventory.devices[0].interfaces[0].service, "WinUSB");
    assert.strictEqual(results[1].inventory.devices[0].interfaces[0].service, "WinUSB");
    assert.strictEqual((await service.reconcileInventory(before.inventory)).devices[0].interfaces[0].service, "WinUSB");
    const originalInvoke = service.invoke;
    let transientStatusFailures = 0;
    service.invoke = async () => {
        if (transientStatusFailures++ < 2)
            throw Object.assign(new Error("device is re-enumerating"), { code: "PROBE_DRIVER_INSTALL_FAILED" });
        return "WinUSB oem64.inf";
    };
    assert.strictEqual((await service.reconcileInventory(before.inventory)).devices[0].interfaces[0].service, "WinUSB");
    assert.strictEqual(transientStatusFailures, 3);
    service.invoke = async () => {
        throw Object.assign(new Error("device is re-enumerating"), { code: "PROBE_DRIVER_INSTALL_FAILED" });
    };
    assert.strictEqual((await service.reconcileInventory(before.inventory)).devices[0].interfaces[0].service, "jlink");
    assert.strictEqual(
        service.recentDrivers.get(id),
        "WinUSB",
        "a failed status query must leave reconciliation pending"
    );
    service.invoke = async () => {
        throw Object.assign(new Error("helper missing"), { code: "PROBE_DRIVER_HELPER_MISSING" });
    };
    await assert.rejects(service.reconcileInventory(before.inventory), { code: "PROBE_DRIVER_HELPER_MISSING" });
    service.invoke = originalInvoke;
    assert.strictEqual((await service.ensure(ready)).inventory, ready.inventory);
    let polls = 0;
    service.invoke = async (action) => {
        assert.strictEqual(action, "status");
        return ++polls < 3 ? "jlink oem59.inf" : "WinUSB oem64.inf";
    };
    assert.strictEqual(await service.waitFor(id, /^winusb(?:\s|$)/i), "WinUSB oem64.inf");
    assert.strictEqual(polls, 3, "poll only the selected devnode after USB re-enumeration");
    service.invoke = async () => {
        throw Object.assign(new Error("UAC cancelled"), { code: "PROBE_DRIVER_AUTH_CANCELLED" });
    };
    await assert.rejects(service.ensure(before), { code: "PROBE_DRIVER_AUTH_CANCELLED" });
    assert.strictEqual(service.inFlight.size, 0);
    const actions = [];
    let restored = false;
    service.invoke = async (action) => {
        actions.push(action);
        if (action === "install") throw Object.assign(new Error("install failed"), { details: {} });
        if (action === "restore") restored = true;
        if (action === "status") return restored ? "jlink oem59.inf" : "WinUSB oem64.inf";
    };
    service.inventory = async () => before.inventory;
    await assert.rejects(service.ensure(before), { message: "install failed", details: { rollback: "restored" } });
    assert.deepStrictEqual(actions, ["install", "status", "restore", "status"]);
    assert.strictEqual(service.inFlight.size, 0);
    actions.length = 0;
    service.invoke = async (action) => {
        actions.push(action);
        if (action === "install")
            throw Object.assign(new Error("helper timed out"), { code: "PROBE_DRIVER_RESULT_UNKNOWN", details: {} });
        return "WinUSB oem64.inf";
    };
    await assert.rejects(service.ensure(before), {
        code: "PROBE_DRIVER_RESULT_UNKNOWN",
        details: { currentDriver: "WinUSB oem64.inf" }
    });
    assert.deepStrictEqual(actions, ["install", "status"], "unknown result must never trigger an automatic retry");
    service.invoke = async (action) => {
        if (action === "status") return "WinUSB oem64.inf";
        throw new Error(`${action} rejected`);
    };
    await assert.rejects(service.ensure(before), { code: "PROBE_DRIVER_ROLLBACK_FAILED" });
    assert.strictEqual(service.inFlight.size, 0);
    service.invoke = async (action) => {
        if (action === "status") return "jlink oem59.inf";
        assert.strictEqual(action, "restore");
    };
    const restoredInventory = await service.restore(ready);
    assert.strictEqual(restoredInventory.devices[0].interfaces[0].service, "jlink");
    assert.strictEqual(restoredInventory.devices[0].interfaces[0].driverInf, "oem59.inf");
    assert.strictEqual(
        (await service.reconcileInventory(ready.inventory)).devices[0].interfaces[0].service,
        "jlink",
        "stale WinUSB inventory is reconciled after restoring SEGGER"
    );
    const staleMetadata = connection({ service: "jlink", provider: "libwdi", inf: "oem64.inf" }).inventory;
    assert.strictEqual(
        (await service.reconcileInventory(staleMetadata)).devices[0].interfaces[0].driverProvider,
        "SEGGER",
        "stale provider metadata is reconciled as well as the driver service"
    );
    assert.strictEqual(service.restoring.size, 0);
    console.log("Windows J-Link driver decision and lifecycle tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
