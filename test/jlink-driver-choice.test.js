"use strict";

const assert = require("assert");
const { resolveJlinkDriverTarget } = require("../src/services/jlinkDriverChoice");
const jlinkDriverChoice = (inventory, probeSerial, selection, platform, arch) =>
    resolveJlinkDriverTarget(inventory, probeSerial, selection, null, platform, arch).choice || null;
const { requireJlinkWinUsb } = require("../skills/_emberprobe/jlink-driver");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeInventoryService } = require("../src/services/probeInventoryService");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const probeLists = (messages) => messages.filter((message) => message.type === "connectedProbes");
const lastProbes = (messages) => probeLists(messages).at(-1);
// USB driver state of the probe the sidebar shows as selected ("" when none is selected).
const lastNotice = (messages) => messages.filter((message) => message.type === "notice").at(-1)?.notice;
const selectedDriver = (messages) => lastProbes(messages)?.devices.find((item) => item.selected)?.driver?.kind || "";
// Driver states and notifications are computed as on Windows x64 whatever platform runs the tests.
function windowsInventory(provider, listProbes) {
    provider._probeInventory = new ProbeInventoryService({
        listProbes,
        reconcile: (value) => provider._probeDriverService.reconcileInventory(value),
        platform: "win32",
        arch: "x64"
    });
}

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

// A missing choice explains itself, and a warning's device is switched without re-resolving settings.
const resolveTarget = (value, serial = "", remembered = null, target = null) =>
    resolveJlinkDriverTarget(value, serial, remembered, target, "win32", "x64");
assert.strictEqual(resolveTarget(inventory).error.i18nKey, "probe.driverSelectionMultiple");
assert.strictEqual(resolveTarget(inventory).error.code, "PROBE_DRIVER_SELECTION_REQUIRED");
const rememberedMissing = resolveTarget({ available: true, devices: [first] }, "", {
    version: 2,
    probe: "jlink.cfg",
    probeSerial: "9999"
}).error;
assert.strictEqual(rememberedMissing.i18nKey, "probe.driverSelectionRememberedMissing");
assert.strictEqual(rememberedMissing.i18nParams.serial, "9999");
assert.strictEqual(
    resolveTarget({ available: true, devices: [first] }, "9999").error.i18nKey,
    "probe.driverSelectionConfiguredMissing"
);
assert.strictEqual(resolveTarget({ available: true, devices: [] }).error.i18nKey, "probe.driverSelectionNone");
assert.strictEqual(resolveTarget({ available: false, devices: [] }).error.i18nKey, "probe.driverSelectionInventory");
assert.strictEqual(
    resolveJlinkDriverTarget(inventory, "1234", null, null, "linux", "x64").error.i18nKey,
    "probe.driverSelectionNone"
);
const pinned = resolveTarget(inventory, "", null, { deviceId: first.id.toLowerCase(), probeSerial: "1234" }).choice;
assert.deepStrictEqual(
    [pinned.driver, pinned.instanceId, pinned.connection.deviceId, pinned.connection.probeSerial],
    ["segger", first.id, first.id, "1234"],
    "two J-Links: the warning's device is chosen even though settings select none"
);
assert.strictEqual(resolveTarget(inventory, "5678", null, { deviceId: first.id }).choice.driver, "segger");
assert.strictEqual(
    resolveTarget({ available: true, devices: [second] }, "", null, { deviceId: first.id }).error.i18nKey,
    "probe.driverTargetMissing"
);
const unlisted = device("4321");
unlisted.pid = "9999";
const notSwitchable = resolveTarget({ available: true, devices: [unlisted] }).error;
assert.strictEqual(notSwitchable.code, "PROBE_DRIVER_NOT_SWITCHABLE");
assert.strictEqual(notSwitchable.i18nKey, "probe.driverNotSwitchable");
assert.strictEqual(notSwitchable.reasonKey, "probe.driverReasonProduct");

// The blocked operation's driver error carries the exact device and whether the helper may switch it.
function driverError(connection) {
    try {
        requireJlinkWinUsb({ adapterFamily: "jlink", ...connection }, "win32", "x64");
    } catch (error) {
        return error;
    }
    assert.fail("SEGGER-bound J-Links are rejected");
}
const repairable = driverError({ deviceId: first.id, probeSerial: "1234", inventory });
assert.strictEqual(repairable.code, "PROBE_DRIVER_UNSUPPORTED");
assert.deepStrictEqual(
    [repairable.details.instanceId, repairable.details.deviceId, repairable.details.probeSerial],
    [first.id, first.id, "1234"]
);
assert.strictEqual(repairable.details.driverKind, "repair");
assert.strictEqual(repairable.details.interfaces[0].service, "jlink");
const compositeId = "USB\\VID_1366&PID_1051\\000801012345";
const composite = {
    id: compositeId,
    family: "jlink",
    name: "J-Link",
    serial: "801012345",
    vid: "1366",
    pid: "1051",
    interfaces: [
        { instanceId: compositeId, name: "USB Composite Device", service: "usbccgp" },
        ...["00", "04"].map((number) => ({
            instanceId: compositeId.replace("PID_1051", `PID_1051&MI_${number}`),
            name: number === "00" ? "J-Link driver" : "BULK interface",
            service: number === "00" ? "jlink" : "WinUSB",
            driverProvider: "SEGGER",
            driverInf: "oem12.inf"
        }))
    ]
};
const ambiguous = driverError({
    deviceId: compositeId,
    probeSerial: "801012345",
    inventory: { available: true, devices: [composite] }
});
assert.strictEqual(ambiguous.details.driverKind, "unknown", "an ambiguous interface is blocked but not switchable");
assert.strictEqual(ambiguous.details.driverReasonKey, "probe.driverReasonInterface");
assert.strictEqual(ambiguous.details.interfaces.length, 3);

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
                listProbes: async () => assert.fail("the Windows inventory service is injected")
            }
        }
    );
    const provider = Object.create(Provider.prototype);
    windowsInventory(provider, async () => {
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
    });
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
    const tick = async () => {
        assert.strictEqual(timers.size, 1, "there is exactly one scheduled monitor check");
        const timer = timers.values().next().value;
        timers.delete(timer);
        await timer.callback();
        await flush();
    };
    try {
        global.setTimeout = (callback, delay) => {
            assert([3000, 10000].includes(delay), "inventory checks wait after completing, slower once stable");
            const timer = { callback, unref() {} };
            timers.add(timer);
            return timer;
        };
        global.clearTimeout = (timer) => timers.delete(timer);
        console.error = (...args) => scanErrors.push(args);
        provider.resolveWebviewView(view);
        await dispatch({ type: "initCheck" });
        await flush();
        assert.deepStrictEqual(
            [lastProbes(messages).state, lastProbes(messages).devices],
            ["none", []],
            "the sidebar lists probes before any is attached"
        );
        assert.strictEqual(selectedDriver(messages), "", "configuration before attachment hides the selector");
        assert.strictEqual(warnings.length, 0);
        const initialScans = scans;
        await dispatch({ type: "initCheck" });
        assert.strictEqual(scans, initialScans, "repeated initialization does not duplicate the monitor");
        currentInventory = { available: true, devices: [device("1234")] };
        await tick();
        assert.strictEqual(selectedDriver(messages), "repair", "late USB attachment reveals the selector");
        assert.strictEqual(warnings.length, 0, "the card shows the driver; a newly attached J-Link does not notify");
        const listsBeforeUnchanged = probeLists(messages).length;
        await tick();
        assert.strictEqual(warnings.length, 0);
        assert.strictEqual(
            probeLists(messages).length,
            listsBeforeUnchanged,
            "an unchanged list is not posted again, so an open dropdown stays open"
        );
        currentInventory = { available: true, devices: [] };
        await tick();
        assert.strictEqual(selectedDriver(messages), "", "removing a probe hides its selector");
        currentInventory = { available: true, devices: [device("1234", "WinUSB")] };
        view.visible = false;
        onVisibility();
        assert.strictEqual(timers.size, 0, "hidden retained views stop polling");
        view.visible = true;
        onVisibility();
        await flush();
        assert.strictEqual(selectedDriver(messages), "ready", "a retained view rechecks immediately when shown");

        const beforeSwitchScans = scans;
        provider._probeDriverSwitching = true;
        await tick();
        assert.strictEqual(scans, beforeSwitchScans, "polling does not enumerate during a driver switch");
        provider._probeDriverSwitching = false;
        scanError = new Error("device list changed during enumeration");
        await tick();
        assert.strictEqual(scanErrors.length, 1);
        await tick();
        assert.strictEqual(selectedDriver(messages), "ready", "a failed scan does not stop future checks");
        state.set("mcu.debugger", "stlink.cfg");
        const otherProbeScans = scans;
        await tick();
        assert.strictEqual(scans, otherProbeScans + 1, "every probe is listed whatever adapter is configured");
        assert.deepStrictEqual(
            lastProbes(messages).devices.map((item) => [item.family, item.matchesDebugger, item.selected]),
            [["jlink", false, false]]
        );
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
        assert.strictEqual(warnings.length, 0, "listing probes never notifies");

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
        provider._startProbeInventoryMonitor();
        assert.strictEqual(timers.size, 0, "shutdown cannot restart monitoring");
    } finally {
        provider._stopProbeInventoryMonitor();
        global.setTimeout = realSetTimeout;
        global.clearTimeout = realClearTimeout;
        console.error = realConsoleError;
    }
}

const firstTarget = { instanceId: first.id, deviceId: first.id, probeSerial: "1234", driverKind: "repair" };

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
        const olderRefresh = provider._refreshConnectedProbes();
        await provider._refreshConnectedProbes();
        const latestMessageCount = messages.length;
        finishOlderScan({ available: true, devices: [] });
        await olderRefresh;
        assert.strictEqual(messages.length, latestMessageCount, "an older empty scan cannot hide a newer selection");

        await provider._refreshConnectedProbes();
        assert.strictEqual(selectedDriver(messages), "repair");
        assert.strictEqual(warnings.length, 0, "the card shows the SEGGER driver; listing it never notifies");
        await provider._changeJlinkDriver("winusb");
        assert.deepStrictEqual(messages.at(-1), { type: "probeDriverSwitch", busy: false });
        await flush();
        assert.strictEqual(selectedDriver(messages), "ready", "the list is rescanned after switching");
        await provider._changeJlinkDriver("segger");
        await flush();
        assert.strictEqual(selectedDriver(messages), "repair");
        assert.strictEqual(warnings.length, 0, "choosing SEGGER in the card does not warn about it");
        let releaseOldScan;
        delayedInventory = new Promise((resolve) => (releaseOldScan = resolve));
        const staleRefresh = provider._refreshConnectedProbes();
        await provider._changeJlinkDriver("winusb");
        await flush();
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
        const notification = provider._showJlinkDriverWarning(firstTarget);
        provider._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(warnings.length, warningCount + 1, "concurrent attempts share one notification");
        answerWarning(undefined);
        await notification;
        assert.strictEqual(state.get("mcu.jlinkDriverWarningIgnored"), undefined, "closing does not persist ignore");

        warningResponse = "probe.switchToWinUsb";
        currentInventory = { available: true, devices: [device("1234")] };
        await provider._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(currentInventory.devices[0].interfaces[0].service, "WinUSB");
        assert.strictEqual(errors.length, 0);

        currentInventory = { available: true, devices: [device("5678")] };
        await provider._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(lastNotice(messages).error.key, "probe.driverTargetMissing");
        assert.strictEqual(lastNotice(messages).error.diagnostic.code, "PROBE_DRIVER_SELECTION_REQUIRED");
        assert.strictEqual(errors.length, 0, "a visible sidebar shows the failure without a notification");
        assert.strictEqual(currentInventory.devices[0].interfaces[0].service, "jlink", "never switch another probe");
        await provider._showJlinkDriverWarning({ instanceId: first.id });
        assert.strictEqual(
            lastNotice(messages).error.key,
            "probe.driverSelectionChanged",
            "an unpinned target still checks its interface"
        );
        assert.strictEqual(lastNotice(messages).error.diagnostic.code, "PROBE_DRIVER_SELECTION_CHANGED");
        assert.strictEqual(currentInventory.devices[0].interfaces[0].service, "jlink");

        // Two J-Links and no saved selection: the sidebar cannot choose, but the warning's device is switched.
        const otherProbe = device("5678");
        currentInventory = { available: true, devices: [device("1234"), otherProbe] };
        await assert.rejects(provider._changeJlinkDriver("winusb"), {
            code: "PROBE_DRIVER_SELECTION_REQUIRED",
            i18nKey: "probe.driverSelectionMultiple"
        });
        const ensureFirst = provider._probeDriverService.ensure;
        const switched = [];
        provider._probeDriverService.ensure = async (connection) => {
            switched.push(connection.deviceId);
            currentInventory = { available: true, devices: [device("1234"), device("5678", "WinUSB")] };
            return { ...connection, inventory: currentInventory };
        };
        const messagesBeforeTarget = messages.length;
        await provider._showJlinkDriverWarning({
            instanceId: otherProbe.id,
            deviceId: otherProbe.id,
            probeSerial: "5678",
            driverKind: "repair"
        });
        await flush();
        assert.deepStrictEqual(switched, [otherProbe.id], "the second J-Link from the warning is switched");
        assert.strictEqual(currentInventory.devices[0].interfaces[0].service, "jlink", "the first J-Link is untouched");
        const afterTarget = lastProbes(messages.slice(messagesBeforeTarget));
        assert.deepStrictEqual(
            [afterTarget.state, afterTarget.devices.map((item) => item.driver.kind)],
            ["ambiguous", ["repair", "ready"]],
            "the list shows the switched J-Link without claiming either is selected"
        );
        provider._probeDriverService.ensure = ensureFirst;
        // Only a J-Link the user picked is remembered; when it is missing, another one is never switched.
        state.set("mcu.selectedProbe", {
            version: 3,
            probe: "jlink.cfg",
            probeSerial: "9999",
            family: "jlink",
            deviceId: "",
            source: "user"
        });
        currentInventory = { available: true, devices: [device("1234")] };
        await assert.rejects(provider._changeJlinkDriver("winusb"), {
            i18nKey: "probe.driverSelectionRememberedMissing"
        });
        state.delete("mcu.selectedProbe");

        // A blocked J-Link whose interface cannot be verified gets no switch button, only the reason and details.
        const output = [];
        provider._chipOutput = { appendLine: (line) => output.push(line) };
        warningResponse = undefined;
        const beforeUnverified = warnings.length;
        await provider._showJlinkDriverWarning({
            instanceId: first.id,
            deviceId: first.id,
            probeSerial: "1234",
            driverKind: "unknown",
            driverReason: "Debug interface cannot be identified uniquely",
            driverReasonKey: "probe.driverReasonInterface",
            interfaces: [
                { instanceId: first.id, name: "J-Link", service: "jlink", driverProvider: "SEGGER", driverInf: "" }
            ]
        });
        assert.deepStrictEqual(warnings.slice(beforeUnverified), [
            ["probe.driverNotSwitchableWarning", "probe.ignoreDriverWarning"]
        ]);
        assert(
            output.some((line) => line.includes("service=jlink")),
            "interface details reach the output panel"
        );
        provider._chipOutput = undefined;
        warningResponse = "probe.switchToWinUsb";

        currentInventory = { available: true, devices: [device("1234")] };
        provider._probeCoordinator = { anyActive: () => true, isActive: () => false };
        await provider._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(
            lastNotice(messages).error.diagnostic.code,
            "PROBE_BUSY",
            "notification preserves probe ownership"
        );
        provider._probeCoordinator = null;

        provider._probeDriverService.ensure = async () => {
            throw new Error("UAC cancelled");
        };
        await provider._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(lastNotice(messages).error.message, "UAC cancelled");
        assert.strictEqual(provider._probeDriverSwitching, false, "a failed switch releases the switching guard");

        warningResponse = "probe.ignoreDriverWarning";
        await provider._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(state.get("mcu.jlinkDriverWarningIgnored"), true);
        const ignoredCount = warnings.length;
        await provider._showJlinkDriverWarning(firstTarget);
        await provider._refreshConnectedProbes();
        assert.strictEqual(warnings.length, ignoredCount, "ignored warnings stay suppressed");
        assert.strictEqual(
            selectedDriver(messages),
            "repair",
            "the sidebar still receives the incompatible driver state"
        );

        const reopened = Object.create(Provider.prototype);
        reopened._context = provider._context;
        reopened._t = provider._t;
        await reopened._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(warnings.length, ignoredCount, "ignore survives reopening the workspace");
        reopened._context = { workspaceState: { get: () => undefined } };
        warningResponse = undefined;
        await reopened._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(warnings.length, ignoredCount + 1, "other workspaces are unaffected");
    } else {
        await provider._showJlinkDriverWarning(firstTarget);
        assert.strictEqual(warnings.length, 0, "other platforms do not receive Windows driver notifications");
    }
    console.log("J-Link USB driver choice tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
