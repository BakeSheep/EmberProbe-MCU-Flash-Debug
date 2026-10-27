"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeInventoryService } = require("../src/services/probeInventoryService");
const { SELECTED_PROBE_KEY, LEGACY_SUCCESS_KEY } = require("../src/services/probeSelectionStore");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { reportTargetMismatch, targetMismatchError } = require("../src/chip/targetIdentity");
const { ProbeCoordinator } = require("../src/probeCoordinator");

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
    provider._probeConnectionService = new ProbeConnectionService({
        getConfig: () => settings,
        getSuccessfulConnection: () => provider._probeSelectionStore().get(),
        saveSuccessfulConnection: (value) =>
            value === undefined ? provider._probeSelectionStore().clear() : provider._probeSelectionStore().set(value)
    });
    const shown = () => messages.filter((message) => message.type === "connectedProbes").at(-1);
    const selectedId = () => shown().devices.find((device) => device.selected)?.id || "";

    // Several J-Links: nothing is chosen until the user picks one, which is remembered for the workspace.
    await provider._refreshConnectedProbes();
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
    assert.deepStrictEqual(notices, [], "the card announced the script switch, so nothing pops up");
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
    // An operation that cannot choose between them opens this list in the sidebar instead of prompting.
    let shownView = 0;
    provider._webviewView.show = (preserveFocus) => {
        assert.strictEqual(preserveFocus, true, "the editor keeps focus");
        shownView++;
    };
    provider._revealConnectedProbes();
    assert.strictEqual(shownView, 1);
    assert(messages.some((message) => message.type === "revealConnectedProbes"));
    delete provider._webviewView.show;

    // A pick made under another interface script is not used: that script runs in automatic mode.
    await provider._selectConnectedProbe(second.id);
    const service = provider._probeConnectionService;
    assert.strictEqual(service.isAutomatic({ probeSerial: "", debugger: "stlink.cfg" }), true);
    assert.strictEqual(service.isAutomatic({ probeSerial: "", debugger: "jlink.cfg" }), false);
    await provider._selectConnectedProbe("");

    // Automatic mode with a recorded chip shows the J-Link it last found that chip on, and every probe's chip.
    const f407 = { cpuid: "410FC241", idcode: "10076413", uid: "002900124131381253534C32" };
    const h750 = { cpuid: "411FC271", idcode: "20036450", uid: "0050002B3133510232363235" };
    state.set("mcu.mcuCore", "stm32f4x.cfg");
    await provider._probeConnectionService.saveTarget("jlink.cfg", "stm32f4x.cfg", f407);
    provider._probeConnectionService.rememberTargetReading(first, h750);
    provider._probeConnectionService.rememberTargetReading(second, f407);
    await provider._refreshConnectedProbes();
    assert.deepStrictEqual([shown().state, shown().source, selectedId()], ["selected", "target-chip", second.id]);
    assert.strictEqual(shown().autoTarget, "STM32F4x · Cortex-M4 · UID …53534C32");
    assert.strictEqual(
        shown().devices.find((device) => device.id === first.id).targetLabel,
        "STM32H7x · Cortex-M7 · UID …32363235"
    );
    // A check that found another chip is shown until the user accepts it or the recorded chip returns.
    const check = {
        checkId: "check-1",
        probe: "jlink.cfg",
        target: "stm32f4x.cfg",
        deviceId: second.id,
        expected: f407
    };
    provider._probeConnectionService.issuedChecks.set(check.checkId, check);
    reportTargetMismatch(targetMismatchError(check, h750, "uid"));
    await provider._refreshConnectedProbes();
    assert.deepStrictEqual(shown().targetMismatch, {
        expected: "STM32F4x · Cortex-M4 · UID …53534C32",
        actual: "STM32H7x · Cortex-M7 · UID …32363235"
    });
    assert.strictEqual(selectedId(), "", "the stale reading of that probe is dropped");
    assert(await provider._probeConnectionService.acceptTargetMismatch());
    await provider._refreshConnectedProbes();
    assert.deepStrictEqual(state.get(SELECTED_PROBE_KEY).chip, h750);
    assert.strictEqual(shown().targetMismatch, null);
    assert.strictEqual(shown().autoTarget, "STM32H7x · Cortex-M7 · UID …32363235");
    // Picking a serial-less probe has nothing to remember and keeps the chip recorded in automatic mode.
    const recorded = state.get(SELECTED_PROBE_KEY);
    await provider._selectConnectedProbe(anonymous.id);
    assert.strictEqual(state.get("mcu.debugger"), "cmsis-dap.cfg");
    assert.deepStrictEqual(state.get(SELECTED_PROBE_KEY), recorded);
    state.set("mcu.debugger", "jlink.cfg");
    await provider._refreshConnectedProbes();
    assert.strictEqual(shown().autoTarget, "STM32H7x · Cortex-M7 · UID …32363235");
    // Choosing automatic again forgets the recorded chip.
    await provider._selectConnectedProbe("");
    assert.strictEqual(shown().autoTarget, "");

    // A failed selection write restores the interface script it changed.
    await provider._selectConnectedProbe(first.id);
    failWrite = true;
    await assert.rejects(provider._selectConnectedProbe(anonymous.id), /read-only/);
    assert.strictEqual(state.get("mcu.debugger"), "jlink.cfg");
    failWrite = false;
    await provider._selectConnectedProbe("");

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
    await provider._refreshConnectedProbes();
    assert.deepStrictEqual([shown().override, shown().source, selectedId()], [true, "setting", first.id]);
    settings.probeSerial = "";

    // No interface script yet: picking a device chooses its family's script.
    state.delete("mcu.debugger");
    await provider._refreshConnectedProbes();
    assert.strictEqual(shown().state, "unconfigured");
    await provider._selectConnectedProbe(first.id);
    assert.strictEqual(state.get("mcu.debugger"), "jlink.cfg");
    assert.strictEqual(selectedId(), first.id);
    assert.strictEqual(await provider._selectedProbeDeviceId(), first.id, "probe.list marks this device");

    // A probe of another family changes Select debugger in place once the page is rendered: a render would reload
    // and flash the sidebar. The page then counts as rendered with the new script.
    const earlierInventory = inventory;
    inventory = { available: true, devices: [first, second, anonymous] };
    const renders = new WeakMap([[provider._webviewView.webview, { html: "jlink.cfg", done: true }]]);
    let rendered = 0;
    Object.assign(provider, {
        _webviewRenders: renders,
        getModernWebviewContent: () => state.get("mcu.debugger"),
        updateView: async () => rendered++
    });
    await provider._selectConnectedProbe(anonymous.id);
    assert.strictEqual(rendered, 0);
    assert.deepStrictEqual(messages.filter((message) => message.type === "debuggerConfig").at(-1), {
        type: "debuggerConfig",
        debugger: "cmsis-dap.cfg"
    });
    assert.deepStrictEqual(renders.get(provider._webviewView.webview), { html: "cmsis-dap.cfg", done: true });
    // A page still loading is rendered as usual.
    renders.set(provider._webviewView.webview, { html: "cmsis-dap.cfg" });
    await provider._selectConnectedProbe(first.id);
    assert.strictEqual(rendered, 1);
    delete provider._webviewRenders;
    provider.updateView = async () => {};

    // Refresh reads the chip on every probe it can open, each with its own interface script, all at once.
    const requests = [];
    let readers = 0;
    let peak = 0;
    const chips = { 1234: h750, "": f407 };
    provider._probeConnectionService.identifyTarget = async (request) => {
        requests.push([request.probe, request.probeSerial, request.target, request.executable, request.cwd]);
        peak = Math.max(peak, ++readers);
        await new Promise((resolve) => setImmediate(resolve));
        readers--;
        assert.strictEqual(provider._probeCoordinator.isActive("targetScan"), true, "reads hold the probes");
        if (!(request.probeSerial in chips)) throw new Error("unable to open CMSIS-DAP/J-Link device");
        return chips[request.probeSerial];
    };
    Object.assign(provider, {
        _probeCoordinator: new ProbeCoordinator(),
        _resolveOpenOcdPath: async () => "openocd",
        _commandContext: () => ({ cwd: "/work" })
    });
    provider._probeConnectionService.rememberTargetReading(second, f407);
    assert.strictEqual(await provider._readConnectedProbeTargets(), true);
    assert.deepStrictEqual(requests, [
        ["jlink.cfg", "1234", "stm32f4x.cfg", "openocd", "/work"],
        ["jlink.cfg", "5678", "stm32f4x.cfg", "openocd", "/work"],
        ["cmsis-dap.cfg", "", "stm32f4x.cfg", "openocd", "/work"]
    ]);
    assert.strictEqual(peak, 3);
    assert.strictEqual(provider._probeCoordinator.anyActive(), false);
    await provider._refreshConnectedProbes();
    const labels = () => Object.fromEntries(shown().devices.map((device) => [device.id, device.targetLabel || ""]));
    const cores = () => shown().devices.map((device) => device.targetCore || "");
    assert.deepStrictEqual(
        labels(),
        {
            [first.id]: "STM32H7x · Cortex-M7 · UID …32363235",
            [second.id]: "",
            [anonymous.id]: "STM32F4x · Cortex-M4 · UID …53534C32"
        },
        "a probe another program holds keeps no chip"
    );
    // While an operation holds the probe in use, nothing is read and that probe shows no chip.
    const lease = provider._probeCoordinator.acquire("liveWatch");
    requests.length = 0;
    assert.strictEqual(await provider._readConnectedProbeTargets(), false);
    assert.deepStrictEqual(requests, []);
    await provider._refreshConnectedProbes();
    assert.strictEqual(labels()[first.id], "");
    assert.deepStrictEqual(cores(), ["", "", "Cortex-M4"], "the card shows only the core");
    assert.strictEqual(labels()[anonymous.id], "STM32F4x · Cortex-M4 · UID …53534C32");
    lease.release();
    await provider._refreshConnectedProbes();
    assert.strictEqual(labels()[first.id], "STM32H7x · Cortex-M7 · UID …32363235");
    assert.deepStrictEqual(cores(), ["Cortex-M7", "", "Cortex-M4"]);
    // Nothing to read with: no target configuration, or no OpenOCD.
    state.delete("mcu.mcuCore");
    assert.strictEqual(await provider._readConnectedProbeTargets(), false);
    state.set("mcu.mcuCore", "stm32f4x.cfg");
    provider._resolveOpenOcdPath = async () => "";
    assert.strictEqual(await provider._readConnectedProbeTargets(), false);
    assert.deepStrictEqual(requests, []);
    // A setting names the probe: only that one is read.
    provider._resolveOpenOcdPath = async () => "openocd";
    settings.probeSerial = "5678";
    assert.strictEqual(await provider._readConnectedProbeTargets(), true);
    assert.deepStrictEqual(requests, [["jlink.cfg", "5678", "stm32f4x.cfg", "openocd", "/work"]]);
    settings.probeSerial = "";

    // After a restart automatic mode has its recorded chip but no reading of which probe holds it: the list reads
    // the chips itself, once, instead of asking the user to pick a probe the next operation would find.
    const settled = async () => {
        for (let tick = 0; tick < 50 && provider._probeTargetsReading; tick++)
            await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
    };
    await provider._selectConnectedProbe("");
    // Without a record the list reads too, for the one probe with the configured model; this one finds none.
    await settled();
    assert.strictEqual(shown().state, "ambiguous");
    await provider._probeConnectionService.saveTarget("jlink.cfg", "stm32f4x.cfg", f407);
    provider._probeConnectionService.targetReadings.clear();
    provider._probeTargetsReadFor = "";
    chips[5678] = f407;
    requests.length = 0;
    await provider._refreshConnectedProbes();
    assert.deepStrictEqual([shown().state, shown().error], ["identifying", null]);
    await settled();
    assert.deepStrictEqual([shown().state, shown().source, selectedId()], ["selected", "target-chip", second.id]);
    assert.strictEqual(requests.length, 3);
    // A probe that cannot be read leaves the choice to the user, without reading again on every poll.
    provider._probeConnectionService.targetReadings.clear();
    provider._probeTargetsReadFor = "";
    delete chips[5678];
    await provider._refreshConnectedProbes();
    await settled();
    assert.strictEqual(shown().state, "ambiguous");
    requests.length = 0;
    await provider._refreshConnectedProbes();
    await settled();
    assert.deepStrictEqual([shown().state, requests], ["ambiguous", []]);
    await provider._selectConnectedProbe("");
    delete provider._probeConnectionService.identifyTarget;
    assert.strictEqual(await provider._readConnectedProbeTargets(), false, "only the extension host reads chips");
    inventory = earlierInventory;

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
