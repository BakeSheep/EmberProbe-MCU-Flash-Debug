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

async function monitorLifecycle() {
    const messages = [],
        warnings = [],
        scanErrors = [],
        timers = new Set();
    let currentInventory = { available: true, devices: [] };
    let delayedInventory,
        scanError,
        dispatch,
        onVisibility,
        onDispose,
        scans = 0;
    const state = new Map([
        ["mcu.debugger", "jlink.cfg"],
        ["mcu.elfPath", "firmware.elf"],
        ["mcu.mcuCore", "stm32f4x.cfg"]
    ]);
    const Provider = loadProvider(
        {
            workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
            window: { showWarningMessage: async (...args) => warnings.push(args) }
        },
        {
            "../skills/_emberprobe/probe-inventory": {
                listProbes: async () => {
                    scans++;
                    if (scanError) {
                        const error = scanError;
                        scanError = null;
                        throw error;
                    }
                    if (delayedInventory) {
                        const result = delayedInventory;
                        delayedInventory = null;
                        return result;
                    }
                    return currentInventory;
                }
            }
        }
    );
    const provider = Object.create(Provider.prototype);
    const view = {
        visible: true,
        webview: {
            postMessage: (message) => messages.push(message),
            onDidReceiveMessage: (callback) => {
                dispatch = callback;
                return { dispose() {} };
            }
        },
        onDidChangeVisibility: (callback) => {
            onVisibility = callback;
            return { dispose() {} };
        },
        onDidDispose: (callback) => {
            onDispose = callback;
        }
    };
    Object.assign(provider, {
        _context: { workspaceState: { get: (key) => state.get(key) } },
        _probeDriverService: { reconcileInventory: async (value) => value },
        _recentProgress: [],
        _openOcdStatusService: { status: {} },
        _skillStatusService: {},
        _svdManager: { syncStatus: async () => {} },
        _getMemoryAnalysisController: () => ({ refresh() {} }),
        _syncSidebarTarget() {},
        _syncChipInfo() {},
        _postPeripheralDebugStatus() {},
        _renderWebview: async () => {},
        getModernWebviewContent: () => "",
        updateView: async () => {},
        refreshOpenOcdStatus() {},
        refreshSkillStatus: async () => {},
        _t: (key) => key
    });
    const realSetTimeout = global.setTimeout,
        realClearTimeout = global.clearTimeout,
        realConsoleError = console.error;
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const tick = async () => {
        assert.strictEqual(timers.size, 1, "there is exactly one scheduled monitor check");
        const timer = timers.values().next().value;
        timers.delete(timer);
        await timer.callback();
        await flush();
    };
    try {
        global.setTimeout = (callback, delay) => {
            assert.strictEqual(delay, 3000, "inventory checks wait three seconds after completing");
            const timer = { callback, unref() {} };
            timers.add(timer);
            return timer;
        };
        global.clearTimeout = (timer) => timers.delete(timer);
        console.error = (...args) => scanErrors.push(args);
        provider.resolveWebviewView(view);
        await dispatch({ type: "initCheck" });
        await flush();
        if (process.platform !== "win32" || process.arch !== "x64") {
            assert.strictEqual(scans, 0, "other platforms do not start Windows USB polling");
            assert.strictEqual(timers.size, 0);
            return;
        }
        assert.strictEqual(messages.at(-1).driver, "", "configuration before attachment hides the selector");
        assert.strictEqual(warnings.length, 0);
        const initialScans = scans;
        await dispatch({ type: "initCheck" });
        assert.strictEqual(scans, initialScans, "repeated initialization does not duplicate the monitor");
        currentInventory = { available: true, devices: [device("1234")] };
        await tick();
        assert.strictEqual(messages.at(-1).driver, "segger", "late USB attachment reveals the selector");
        assert.strictEqual(warnings.length, 1);
        await tick();
        assert.strictEqual(warnings.length, 1, "unchanged driver state does not repeat warnings");
        currentInventory = { available: true, devices: [] };
        await tick();
        assert.strictEqual(messages.at(-1).driver, "", "removing a probe hides its selector");
        currentInventory = { available: true, devices: [device("1234", "WinUSB")] };
        view.visible = false;
        onVisibility();
        assert.strictEqual(timers.size, 0, "hidden retained views stop polling");
        view.visible = true;
        onVisibility();
        await flush();
        assert.strictEqual(messages.at(-1).driver, "winusb", "a retained view rechecks immediately when shown");

        const beforeSwitchScans = scans;
        provider._probeDriverSwitching = true;
        await tick();
        assert.strictEqual(scans, beforeSwitchScans, "polling does not enumerate during a driver switch");
        provider._probeDriverSwitching = false;
        scanError = new Error("device list changed during enumeration");
        await tick();
        assert.strictEqual(scanErrors.length, 1);
        await tick();
        assert.strictEqual(messages.at(-1).driver, "winusb", "a failed scan does not stop future checks");
        state.set("mcu.debugger", "stlink.cfg");
        const otherProbeScans = scans;
        await tick();
        assert.strictEqual(scans, otherProbeScans, "other configured adapters do not trigger J-Link inventory");
        state.set("mcu.debugger", "jlink.cfg");

        let finishHiddenScan;
        delayedInventory = new Promise((resolve) => (finishHiddenScan = resolve));
        const slowCheck = tick();
        assert.strictEqual(timers.size, 0, "slow inventory does not schedule overlapping periodic requests");
        view.visible = false;
        onVisibility();
        view.visible = true;
        onVisibility();
        await flush();
        const visibleMessageCount = messages.length;
        finishHiddenScan({ available: true, devices: [device("1234")] });
        await slowCheck;
        assert.strictEqual(messages.length, visibleMessageCount, "a hidden view's old scan cannot overwrite recheck");
        assert.strictEqual(warnings.length, 1, "a stale scan cannot show an obsolete warning");

        let finishDisposedScan;
        delayedInventory = new Promise((resolve) => (finishDisposedScan = resolve));
        const disposedCheck = tick();
        onDispose();
        const disposedMessageCount = messages.length;
        finishDisposedScan(currentInventory);
        await disposedCheck;
        assert.strictEqual(messages.length, disposedMessageCount, "disposed views cannot receive pending results");
        assert.strictEqual(timers.size, 0, "disposal prevents in-flight polling from restarting");

        provider.resolveWebviewView(view);
        await dispatch({ type: "initCheck" });
        await flush();
        assert.strictEqual(timers.size, 1);
        provider._shutdownPromise = Promise.resolve();
        provider.finishForeignDebug = () => {};
        provider._cubemxService = { cancel() {} };
        provider._elfService = { invalidate() {} };
        await provider.shutdown();
        assert.strictEqual(timers.size, 0, "shutdown releases the polling timer");
        provider._startJlinkDriverMonitor();
        assert.strictEqual(timers.size, 0, "shutdown cannot restart monitoring");
    } finally {
        provider._stopJlinkDriverMonitor();
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
        console.error = realConsoleError;
    }
}

async function main() {
    await monitorLifecycle();
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
        let finishOlderScan;
        delayedInventory = new Promise((resolve) => (finishOlderScan = resolve));
        const olderRefresh = provider._refreshJlinkDriverChoice(false);
        await provider._refreshJlinkDriverChoice(false);
        const latestMessageCount = messages.length;
        finishOlderScan({ available: true, devices: [] });
        await olderRefresh;
        assert.strictEqual(messages.length, latestMessageCount, "an older empty scan cannot hide a newer selection");

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
