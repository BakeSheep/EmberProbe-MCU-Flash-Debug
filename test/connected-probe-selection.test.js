"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeInventoryService } = require("../src/services/probeInventoryService");
const { SELECTED_PROBE_KEY, LEGACY_SUCCESS_KEY } = require("../src/services/probeSelectionStore");

function jlink(serial, service = "jlink") {
    const id = `USB\\VID_1366&PID_0101\\${serial.padStart(12, "0")}`;
    return {
        id,
        family: "jlink",
        name: "J-Link",
        serial,
        vid: "1366",
        pid: "0101",
        interfaces: [{ instanceId: id, name: "J-Link", service, driverProvider: "SEGGER", driverInf: "oem12.inf" }]
    };
}
const dap = (id, serial = "") => ({ id, family: "cmsis-dap", name: "CMSIS-DAP", serial, serialSource: "usb" });

async function main() {
    const first = jlink("1234");
    const second = jlink("5678", "WinUSB");
    const anonymous = dap("USB\\VID_C251&PID_F001\\1&A");
    let inventory = { available: true, devices: [first, second, anonymous] };
    const settings = { probeSerial: "" };
    const messages = [];
    const notices = [];
    const state = new Map([["mcu.debugger", "jlink.cfg"]]);
    let failWrite = false;
    const Provider = loadProvider({
        workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
        window: { showInformationMessage: (message) => notices.push(message), showWarningMessage: async () => {} }
    });
    const provider = Object.create(Provider.prototype);
    provider._context = {
        workspaceState: {
            get: (key) => state.get(key),
            update: async (key, value) => {
                if (failWrite && key === SELECTED_PROBE_KEY) throw new Error("workspace state is read-only");
                if (value === undefined) state.delete(key);
                else state.set(key, value);
            }
        }
    };
    provider._webviewView = { webview: { postMessage: (message) => messages.push(message) } };
    provider._t = (key) => key;
    provider._assertConnectionEditable = () => {};
    provider.updateView = async () => {};
    provider._probeDriverService = { reconcileInventory: async (value) => value };
    provider._probeInventory = new ProbeInventoryService({
        listProbes: async () => inventory,
        reconcile: (value) => provider._probeDriverService.reconcileInventory(value),
        platform: "win32",
        arch: "x64"
    });
    const shown = () => messages.filter((message) => message.type === "connectedProbes").at(-1);
    const selectedId = () => shown().devices.find((device) => device.selected)?.id || "";

    // Several J-Links: nothing is chosen until the user picks one, which is remembered for the workspace.
    await provider._refreshConnectedProbes(false);
    assert.deepStrictEqual([shown().state, shown().debugger, selectedId()], ["ambiguous", "jlink.cfg", ""]);
    await provider._selectConnectedProbe(second.id);
    assert.deepStrictEqual(state.get(SELECTED_PROBE_KEY), {
        version: 3,
        probe: "jlink.cfg",
        probeSerial: "5678",
        family: "jlink",
        deviceId: second.id,
        source: "user"
    });
    assert.deepStrictEqual(state.get(LEGACY_SUCCESS_KEY), { version: 2, probe: "jlink.cfg", probeSerial: "5678" });
    assert.deepStrictEqual([shown().state, shown().source, selectedId()], ["selected", "remembered", second.id]);
    assert.strictEqual(notices.length, 0, "a same-family pick keeps the interface script");

    // A device of another family switches the interface script to that family's default.
    await provider._selectConnectedProbe(anonymous.id);
    assert.strictEqual(state.get("mcu.debugger"), "cmsis-dap.cfg");
    assert.strictEqual(state.get(SELECTED_PROBE_KEY), undefined, "a lone serial-less probe is chosen as unique");
    assert.deepStrictEqual(notices, ["probe.debuggerFollowed"]);
    assert.deepStrictEqual([shown().source, selectedId()], ["unique-device", anonymous.id]);
    await provider._selectConnectedProbe(first.id);
    assert.strictEqual(state.get("mcu.debugger"), "jlink.cfg");
    assert.strictEqual(state.get(SELECTED_PROBE_KEY).probeSerial, "1234");
    assert.strictEqual(selectedId(), first.id);

    // Automatic forgets the saved device; with two J-Links the user has to pick again.
    await provider._selectConnectedProbe("");
    assert.strictEqual(state.get(SELECTED_PROBE_KEY), undefined);
    assert.strictEqual(state.get(LEGACY_SUCCESS_KEY), undefined);
    assert.strictEqual(shown().state, "ambiguous");

    // A failed selection write restores the interface script it changed.
    failWrite = true;
    await assert.rejects(provider._selectConnectedProbe(anonymous.id), /read-only/);
    assert.strictEqual(state.get("mcu.debugger"), "jlink.cfg");
    failWrite = false;

    // Devices that cannot be chosen, and a list locked by a setting or a custom script.
    await assert.rejects(provider._selectConnectedProbe(7), { code: "PROBE_SELECTION_INVALID" });
    await assert.rejects(provider._selectConnectedProbe("USB\\VID_1366&PID_0101\\gone"), {
        code: "PROBE_SELECTED_NOT_FOUND",
        i18nKey: "probe.selectionGone"
    });
    inventory = { available: true, devices: [first, anonymous, dap("USB\\VID_C251&PID_F001\\1&B")] };
    await assert.rejects(provider._selectConnectedProbe(anonymous.id), {
        code: "PROBE_SELECTION_REQUIRED",
        i18nKey: "probe.noTrustedSerial"
    });
    state.set("mcu.debugger", "board.cfg");
    await assert.rejects(provider._selectConnectedProbe(first.id), {
        code: "PROBE_SELECTION_LOCKED",
        i18nKey: "probe.scriptDecides"
    });
    assert.strictEqual(state.get("mcu.debugger"), "board.cfg", "a custom script is never replaced");
    state.set("mcu.debugger", "jlink.cfg");
    settings.probeSerial = "1234";
    await assert.rejects(provider._selectConnectedProbe(first.id), {
        code: "PROBE_SELECTION_LOCKED",
        i18nKey: "probe.selectionLocked"
    });
    await provider._refreshConnectedProbes(false);
    assert.deepStrictEqual([shown().override, shown().source, selectedId()], [true, "setting", first.id]);
    settings.probeSerial = "";

    // No interface script yet: picking a device chooses its family's script.
    state.delete("mcu.debugger");
    await provider._refreshConnectedProbes(false);
    assert.strictEqual(shown().state, "unconfigured");
    await provider._selectConnectedProbe(first.id);
    assert.strictEqual(state.get("mcu.debugger"), "jlink.cfg");
    assert.strictEqual(selectedId(), first.id);
    assert.strictEqual(await provider._selectedProbeDeviceId(), first.id, "probe.list marks this device");

    // The sidebar's list of probes is part of the webview message protocol.
    const posted = [];
    let dispatch;
    const view = {
        visible: true,
        webview: {
            postMessage: (message) => posted.push(message),
            onDidReceiveMessage: (callback) => {
                dispatch = callback;
                return { dispose() {} };
            }
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        onDidDispose() {}
    };
    Object.assign(provider, {
        _renderWebview: async () => {},
        getModernWebviewContent: () => "",
        _openOcdStatusService: { status: {} },
        _skillStatusService: {}
    });
    // A complete configuration skips workspace auto-detection.
    state.set("mcu.elfPath", "firmware.elf");
    state.set("mcu.mcuCore", "stm32f4x.cfg");
    provider._shutdownPromise = Promise.resolve();
    provider.resolveWebviewView(view);
    await dispatch({ type: "selectConnectedProbe", deviceId: "" });
    assert.strictEqual(state.get(SELECTED_PROBE_KEY), undefined);
    await dispatch({ type: "selectConnectedProbe", deviceId: "USB\\missing" });
    assert.strictEqual(posted.find((message) => message.type === "commandError").error, "probe.selectionGone");
    const scans = provider._probeInventory.started;
    await dispatch({ type: "refreshConnectedProbes" });
    assert.strictEqual(provider._probeInventory.started, scans + 1);
    console.log("Connected probe selection tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
