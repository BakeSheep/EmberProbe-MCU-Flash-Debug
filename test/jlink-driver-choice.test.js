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
    const errors = [];
    const state = new Map([["mcu.debugger", "jlink.cfg"]]);
    let warningResponse;
    let currentInventory = { available: true, devices: [device("1234")] };
    let delayedInventory;
    const Provider = loadProvider(
        {
            workspace: { getConfiguration: () => ({ get: () => "" }) },
            window: {
                showWarningMessage: async (...args) => {
                    warnings.push(args);
                    return warningResponse;
                },
                showErrorMessage: (message) => errors.push(message)
            }
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
    provider._context = {
        workspaceState: {
            get: (key) => state.get(key),
            update: async (key, value) => state.set(key, value)
        }
    };
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
        await provider._jlinkDriverWarningPending;
        await provider._refreshJlinkDriverChoice(true);
        assert.strictEqual(warnings.length, 1, "the SEGGER warning appears once per detected driver state");
        assert.deepStrictEqual(warnings[0], [
            "probe.winusbRequired",
            "probe.switchToWinUsb",
            "probe.ignoreDriverWarning"
        ]);
        assert.strictEqual(messages.at(-1).driver, "segger");
        await provider._changeJlinkDriver("winusb");
        assert.deepStrictEqual(messages.at(-1), { type: "probeDriverSwitch", busy: false });
        assert.deepStrictEqual(messages.at(-2), { type: "probeDriverChoice", driver: "winusb" });
        await provider._changeJlinkDriver("segger");
        await provider._jlinkDriverWarningPending;
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

        let answerWarning;
        warningResponse = new Promise((resolve) => (answerWarning = resolve));
        const warningCount = warnings.length;
        const notification = provider._showJlinkDriverWarning(first.id);
        provider._showJlinkDriverWarning(first.id);
        assert.strictEqual(warnings.length, warningCount + 1, "concurrent attempts share one notification");
        answerWarning(undefined);
        await notification;
        assert.strictEqual(state.get("mcu.jlinkDriverWarningIgnored"), undefined, "closing does not persist ignore");

        warningResponse = "probe.switchToWinUsb";
        currentInventory = { available: true, devices: [device("1234")] };
        await provider._showJlinkDriverWarning(first.id);
        assert.strictEqual(currentInventory.devices[0].interfaces[0].service, "WinUSB");
        assert.strictEqual(errors.length, 0);

        currentInventory = { available: true, devices: [device("5678")] };
        await provider._showJlinkDriverWarning(first.id);
        assert.strictEqual(errors.at(-1), "probe.driverSelectionChanged");
        assert.strictEqual(messages.at(-1).diagnostic.code, "PROBE_DRIVER_SELECTION_CHANGED");
        assert.strictEqual(currentInventory.devices[0].interfaces[0].service, "jlink", "never switch another probe");

        currentInventory = { available: true, devices: [device("1234")] };
        provider._probeCoordinator = { anyActive: () => true, isActive: () => false };
        await provider._showJlinkDriverWarning(first.id);
        assert.strictEqual(messages.at(-1).diagnostic.code, "PROBE_BUSY", "notification preserves probe ownership");
        provider._probeCoordinator = null;

        provider._probeDriverService.ensure = async () => {
            throw new Error("UAC cancelled");
        };
        await provider._showJlinkDriverWarning(first.id);
        assert.strictEqual(errors.at(-1), "UAC cancelled");
        assert.strictEqual(provider._probeDriverSwitching, false, "a failed switch releases the switching guard");

        warningResponse = "probe.ignoreDriverWarning";
        await provider._showJlinkDriverWarning(first.id);
        assert.strictEqual(state.get("mcu.jlinkDriverWarningIgnored"), true);
        const ignoredCount = warnings.length;
        await provider._showJlinkDriverWarning(first.id);
        provider._lastJlinkDriverWarning = "";
        await provider._refreshJlinkDriverChoice(true);
        assert.strictEqual(warnings.length, ignoredCount, "ignored warnings stay suppressed on selection and attempts");
        assert.strictEqual(
            messages.at(-1).driver,
            "segger",
            "the sidebar still receives the incompatible driver state"
        );

        const reopened = Object.create(Provider.prototype);
        reopened._context = provider._context;
        reopened._t = provider._t;
        await reopened._showJlinkDriverWarning(first.id);
        assert.strictEqual(warnings.length, ignoredCount, "ignore survives reopening the workspace");
        reopened._context = { workspaceState: { get: () => undefined } };
        warningResponse = undefined;
        await reopened._showJlinkDriverWarning(first.id);
        assert.strictEqual(warnings.length, ignoredCount + 1, "other workspaces are unaffected");
    } else {
        await provider._showJlinkDriverWarning(first.id);
        assert.strictEqual(warnings.length, 0, "other platforms do not receive Windows driver notifications");
    }
    console.log("J-Link USB driver choice tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
