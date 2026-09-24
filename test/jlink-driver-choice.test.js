"use strict";

const assert = require("assert");
const { jlinkDriverChoice } = require("../src/services/jlinkDriverChoice");
const { loadProvider } = require("./helpers/load-provider");

function device(serial, service = "jlink") {
    const id = `USB\\VID_1366&PID_0101\\${serial}`;
    return {
        id,
        family: "jlink",
        name: "J-Link",
        serial,
        vid: "1366",
        pid: "0101",
        interfaces: [
            {
                instanceId: id,
                name: "J-Link",
                service,
                driverProvider: "SEGGER Microcontroller GmbH",
                driverInf: "oem59.inf"
            }
        ]
    };
}

const first = device("1234");
const second = device("5678", "WinUSB");
const inventory = { available: true, devices: [first, second] };
assert.strictEqual(jlinkDriverChoice(inventory, "", null, "win32", "x64"), null);
assert.deepStrictEqual(jlinkDriverChoice(inventory, "1234", null, "win32", "x64"), {
    connection: { adapterFamily: "jlink", deviceId: first.id, probeSerial: "1234", inventory },
    driver: "segger",
    instanceId: first.id
});
assert.strictEqual(jlinkDriverChoice(inventory, "5678", null, "win32", "x64").driver, "winusb");
assert.strictEqual(jlinkDriverChoice(inventory, "9999", null, "win32", "x64"), null);
assert.strictEqual(
    jlinkDriverChoice(inventory, "", { version: 1, probe: "jlink.cfg", probeSerial: "5678" }, "win32", "x64").driver,
    "winusb"
);
assert.strictEqual(jlinkDriverChoice({ available: true, devices: [first] }, "", null, "win32", "x64").driver, "segger");
assert.strictEqual(jlinkDriverChoice(inventory, "1234", null, "linux", "x64"), null);
assert.strictEqual(jlinkDriverChoice({ available: false, devices: [first] }, "1234", null, "win32", "x64"), null);

async function main() {
    const messages = [];
    const warnings = [];
    let currentInventory = { available: true, devices: [device("1234")] };
    let delayedInventory;
    const Provider = loadProvider(
        {
            workspace: { getConfiguration: () => ({ get: () => "" }) },
            window: { showWarningMessage: (message) => warnings.push(message) }
        },
        {
            "../skills/_emberprobe/probe-inventory": {
                listProbes: async () => {
                    if (delayedInventory) {
                        const pending = delayedInventory;
                        delayedInventory = null;
                        return pending;
                    }
                    return currentInventory;
                }
            }
        }
    );
    const provider = Object.create(Provider.prototype);
    provider._context = { workspaceState: { get: (key) => (key === "mcu.debugger" ? "jlink.cfg" : undefined) } };
    provider._webviewView = { webview: { postMessage: (message) => messages.push(message) } };
    provider._t = (key) => key;
    provider._assertConnectionEditable = () => {};
    provider._probeDriverService = {
        reconcileInventory: async (value) => value,
        ensure: async (connection) => {
            assert.strictEqual(connection.deviceId, first.id);
            currentInventory = { available: true, devices: [device("1234", "WinUSB")] };
            return { ...connection, inventory: currentInventory };
        },
        restore: async (connection) => {
            assert.strictEqual(connection.deviceId, first.id);
            currentInventory = { available: true, devices: [device("1234")] };
            return currentInventory;
        }
    };
    if (process.platform === "win32") {
        await provider._refreshJlinkDriverChoice(true);
        await provider._refreshJlinkDriverChoice(true);
        assert.strictEqual(warnings.length, 1, "the SEGGER warning appears once per detected driver state");
        assert.strictEqual(messages.at(-1).driver, "segger");
        await provider._changeJlinkDriver("winusb");
        assert.deepStrictEqual(messages.at(-1), { type: "probeDriverSwitch", busy: false });
        assert.deepStrictEqual(messages.at(-2), { type: "probeDriverChoice", driver: "winusb" });
        await provider._changeJlinkDriver("segger");
        assert.deepStrictEqual(messages.at(-2), { type: "probeDriverChoice", driver: "segger" });
        assert.strictEqual(warnings.length, 2, "restoring SEGGER warns again that WinUSB is required");
        let releaseOldScan;
        delayedInventory = new Promise((resolve) => (releaseOldScan = resolve));
        const staleRefresh = provider._refreshJlinkDriverChoice(false);
        await provider._changeJlinkDriver("winusb");
        const messageCount = messages.length;
        releaseOldScan({ available: true, devices: [device("1234")] });
        await staleRefresh;
        assert.strictEqual(messages.length, messageCount, "a scan begun before switching cannot overwrite its result");
        await provider._changeJlinkDriver("segger");
        let completeInstall;
        const installPending = new Promise((resolve) => (completeInstall = resolve));
        provider._probeDriverService.ensure = async (connection) => {
            await installPending;
            currentInventory = { available: true, devices: [device("1234", "WinUSB")] };
            return { ...connection, inventory: currentInventory };
        };
        const changing = provider._changeJlinkDriver("winusb");
        assert.throws(() => provider._assertProbeDriverIdle(), { code: "PROBE_DRIVER_BUSY" });
        await assert.rejects(provider._changeJlinkDriver("segger"), { code: "PROBE_DRIVER_BUSY" });
        completeInstall();
        await changing;
        await assert.rejects(provider._changeJlinkDriver("invalid"), { code: "PROBE_DRIVER_INVALID_CHOICE" });
    }
    console.log("J-Link USB driver choice tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
