"use strict";
const validation = require("../validation");
const { resolveJlinkDriverTarget } = require("./jlinkDriverChoice");
const { ProbeSelectionStore } = require("./probeSelectionStore");
const { ProbeInventoryService } = require("./probeInventoryService");
const { probeFamily } = require("../../skills/_emberprobe/probe-connection");
const {
    describeTargetIdentity,
    describeTargetCore,
    sameTarget,
    targetMatchesModel
} = require("../chip/targetIdentity");
const { CACHE_KEYS } = require("../cacheKeys");
const { PROBE_OPERATIONS } = require("../probeCoordinator");
// Operations that hold the workspace's probe; the refresh's own chip reads do not.
const PROBE_OPERATIONS_IN_USE = PROBE_OPERATIONS.filter((name) => name !== "targetScan");
const JLINK_DRIVER_WARNING_IGNORED_KEY = "mcu.jlinkDriverWarningIgnored";

// The sidebar's connected probe list: the inventory monitor, the chip each listed probe reads, the workspace's probe
// selection, and the J-Link USB driver warning and switch. host is the MainViewProvider.
class ConnectedProbes {
    /**
     * @param {any} host
     * @param {{ vscode: any, listProbes: Function }} modules Taken from the provider module, so tests can replace
     *     them through loadProvider.
     */
    constructor(host, { vscode, listProbes }) {
        this.host = host;
        this._vscode = vscode;
        this._listProbes = listProbes;
        this.inventoryService = null;
        this.monitor = null;
        this.driverSwitching = false;
        this.lastMessage = "";
        // The list's automatic chip read (identifyTargets).
        this.targetsReading = false;
        this.targetsReadFor = "";
    }
    inventory() {
        // Created on first use; recently switched J-Link drivers are reconciled into every scan.
        if (!this.inventoryService)
            this.inventoryService = new ProbeInventoryService({
                listProbes: this._listProbes,
                reconcile: (inventory) => this.host._probeDriverService.reconcileInventory(inventory)
            });
        return this.inventoryService;
    }
    selection() {
        if (this._selection?.state !== this.host._context.workspaceState)
            this._selection = new ProbeSelectionStore(this.host._context.workspaceState);
        return this._selection;
    }
    assertDriverIdle() {
        this.host._externalDebug?.assertPhysicalAvailable();
        if (this.driverSwitching)
            throw Object.assign(new Error("J-Link USB driver change is still in progress"), {
                code: "PROBE_DRIVER_BUSY"
            });
    }
    stopMonitor() {
        if (this.monitor) clearTimeout(this.monitor.timer);
        this.monitor = null;
        this._revision = (this._revision || 0) + 1;
    }
    // Lists every connected probe while the sidebar is visible, whatever interface script is selected.
    startMonitor() {
        if (
            !this.host._sidebarReady ||
            !this.host._webviewView ||
            this.host._webviewView.visible === false ||
            this.host._shutdownPromise ||
            this.monitor
        )
            return;
        const monitor = { timer: null };
        this.monitor = monitor;
        this.inventory().resetBackoff();
        const poll = async () => {
            if (this.monitor !== monitor) return;
            try {
                await this.refresh();
            } catch (error) {
                console.error("Probe inventory check failed:", error.message);
            } finally {
                // Wait after each completed read-only scan; slow enumeration must not pile up requests.
                if (this.monitor === monitor) {
                    monitor.timer = setTimeout(poll, this.inventory().pollDelay());
                    monitor.timer.unref();
                }
            }
        };
        void poll();
    }
    view(inventory) {
        const debuggerCfg = this.host._context.workspaceState.get(CACHE_KEYS.debugger) || "";
        const mcuCore = this.host._context.workspaceState.get(CACHE_KEYS.mcuCore) || "";
        const probeSerial = "";
        const successfulConnection = this.selection().get();
        const service = this.host._probeConnectionService;
        const view = {
            debugger: debuggerCfg,
            ...this.inventory().describe({ probe: debuggerCfg, probeSerial, successfulConnection }, inventory)
        };
        // Target chips come from operations; without the connection service there are none to show.
        if (!service) return view;
        Object.assign(view, service.describeTargetState(mcuCore));
        const automatic = service.isAutomatic({ probeSerial, debugger: debuggerCfg }, successfulConnection);
        const expected = automatic ? service.expectedTarget(mcuCore, successfulConnection) : null;
        const readings = new Map(
            (inventory?.devices || []).map((device) => [device.id, service.targetReading(device)])
        );
        view.devices = view.devices.map((device) =>
            readings.get(device.id)
                ? {
                      ...device,
                      targetLabel: describeTargetIdentity(readings.get(device.id)),
                      targetCore: describeTargetCore(readings.get(device.id))
                  }
                : device
        );
        // Several probes of one family: show the one the next operation would pick, as pickByTarget does: the probe
        // automatic mode last found the recorded chip on, or without a record the only one with the configured model.
        if (automatic && view.state === "ambiguous") {
            const candidates = view.devices.filter((device) => device.matchesDebugger && device.selectable);
            const matches = candidates.filter((device) => {
                const reading = readings.get(device.id);
                if (!reading) return false;
                return expected ? sameTarget(reading, expected) : targetMatchesModel(reading, mcuCore) === true;
            });
            // Chip readings live only in memory: after a restart the list reads them itself (see
            // identifyTargets) rather than asking the user to pick a probe automatic mode can find.
            const readKey = this._readKey(view, mcuCore);
            if (
                matches.length !== 1 &&
                service.identifyTarget &&
                mcuCore &&
                candidates.length > 1 &&
                candidates.some((device) => !readings.get(device.id)) &&
                this.targetsReadFor !== readKey
            )
                Object.assign(view, { state: "identifying", error: null });
            if (matches.length === 1)
                Object.assign(view, {
                    state: "selected",
                    source: "target-chip",
                    deviceId: matches[0].id,
                    probeSerial: matches[0].trustedSerial,
                    error: null,
                    devices: view.devices.map((device) => ({ ...device, selected: device.id === matches[0].id }))
                });
        }
        // The probe an operation holds is in use; its chip is shown again once the operation ends.
        if (view.state === "selected" && this.host._probeCoordinator?.anyActive(PROBE_OPERATIONS_IN_USE))
            view.devices = view.devices.map((device) =>
                device.id === view.deviceId && device.targetLabel
                    ? { ...device, targetLabel: "", targetCore: "" }
                    : device
            );
        return view;
    }
    _readKey(view, target) {
        return JSON.stringify([view.debugger, target, ...view.devices.map((device) => device.id)]);
    }
    // Reads the chips once for this.host set of probes, so automatic mode's choice shows without a manual refresh. A
    // probe that cannot be read leaves the list asking the user to pick, as before.
    identifyTargets(view) {
        if (this.targetsReading) return;
        const key = this._readKey(view, this.host._context.workspaceState.get(CACHE_KEYS.mcuCore) || "");
        this.targetsReading = true;
        void this.readTargets()
            .catch((error) => console.error("Probe chip read failed:", error.message))
            .finally(() => {
                this.targetsReading = false;
                this.targetsReadFor = key;
                return this.refresh();
            })
            .catch((error) => console.error("Probe list refresh failed:", error.message));
    }
    // Refresh reads the chip on each listed probe the extension can open on its own. Nothing is read while a probe
    // operation runs; a probe another program holds cannot be opened and keeps no reading, so neither shows a chip.
    async readTargets() {
        const service = this.host._probeConnectionService;
        const target = this.host._context.workspaceState.get(CACHE_KEYS.mcuCore) || "";
        if (!service?.identifyTarget || !target || this.driverSwitching) return false;
        const { inventory } = await this.inventory().scan();
        const view = this.view(inventory);
        // A custom interface script opens its own device; that script shows only the selected one.
        const scriptChooses = view.state === "script";
        const listed = scriptChooses ? view.devices.filter((device) => device.selected) : view.devices;
        const devices = new Map((inventory?.devices || []).map((device) => [device.id, device]));
        const probes = listed.flatMap((device) => {
            const probe = scriptChooses || device.matchesDebugger ? view.debugger : device.defaultConfig;
            if (!probe || !devices.has(device.id) || !(scriptChooses || device.selectable)) return [];
            const probeSerial = scriptChooses ? "" : device.trustedSerial || "";
            return [{ device: devices.get(device.id), probe, probeSerial }];
        });
        if (!probes.length || this.host._probeCoordinator.anyActive()) return false;
        const executable = await this.host._resolveOpenOcdPath(
            this._vscode.workspace.getConfiguration("emberprobe").get("openocdPath", "openocd")
        );
        if (!executable) return false;
        let lease;
        try {
            lease = this.host._probeCoordinator.acquire("targetScan");
        } catch {
            return false;
        }
        try {
            await service.readListedTargets(probes, { executable, target, cwd: this.host._commandContext().cwd });
        } finally {
            lease.release();
        }
        return true;
    }
    // The connected device the workspace's next operation would use, or "" when none is selected.
    async selectedDeviceId() {
        const view = this.view((await this.inventory().scan()).inventory);
        return view.state === "selected" ? view.deviceId : "";
    }
    // The list's card shows each J-Link's driver and switches it; only an operation the driver blocks notifies.
    async refresh() {
        if (this.driverSwitching) return null;
        const revision = (this._revision = (this._revision || 0) + 1);
        const { inventory } = await this.inventory().scan();
        if (this.driverSwitching || revision !== this._revision) return null;
        const view = this.view(inventory);
        const message = JSON.stringify({ type: "connectedProbes", ...view });
        // Rebuilding the list would close a dropdown the user has open; only post changes.
        if (message !== this.lastMessage) {
            this.lastMessage = message;
            this.host._webviewView?.webview.postMessage(JSON.parse(message));
        }
        if (view.state === "identifying") this.identifyTargets(view);
        return view;
    }
    // Opens the sidebar's connected probe list where the user picks the probe an operation could not choose.
    reveal() {
        this.host._webviewView?.show?.(true);
        this.host._webviewView?.webview.postMessage({ type: "revealConnectedProbes" });
        this.refresh().catch((error) => console.error("Probe list refresh failed:", error.message));
    }
    // Makes a connected device the workspace's probe. A device of another family also switches the interface
    // script to that family's default, so the list and the next operation never disagree.
    async select(deviceId) {
        if (deviceId !== "" && !validation.connectedProbeId(deviceId))
            throw Object.assign(new Error("Invalid connected probe"), { code: "PROBE_SELECTION_INVALID" });
        this.host._assertConnectionEditable({ probeSerial: true });
        const store = this.selection();
        this.inventory().resetBackoff();
        if (!deviceId) {
            await store.clear();
            this.host._probeConnectionService.clearTargetMismatch();
            this.host._resolvedProbeConnection = null;
            return this.refresh();
        }
        const view = this.view((await this.inventory().scan()).inventory);
        const device = view.devices.find((item) => item.id === deviceId);
        if (!device)
            throw Object.assign(new Error("The selected probe is no longer connected"), {
                code: "PROBE_SELECTED_NOT_FOUND",
                i18nKey: "probe.selectionGone"
            });
        if (view.state === "script")
            throw Object.assign(new Error("The interface script selects its own device"), {
                code: "PROBE_SELECTION_LOCKED",
                i18nKey: "probe.scriptDecides"
            });
        if (!device.selectable || !device.defaultConfig)
            throw Object.assign(new Error("This probe cannot be selected"), {
                code: "PROBE_SELECTION_REQUIRED",
                i18nKey: device.reasonKey || "probe.noDefaultConfig"
            });
        const current = view.debugger;
        const probe = probeFamily({ probe: current }) === device.family ? current : device.defaultConfig;
        if (probe !== current) this.host._assertConnectionEditable({ debugger: probe });
        if (probe !== current) await this.host._context.workspaceState.update(CACHE_KEYS.debugger, probe);
        try {
            // Without a trusted serial the device is the only one of its family and is chosen as the unique device,
            // so only an earlier pick is forgotten; a chip recorded in automatic mode stays for that script.
            if (device.trustedSerial)
                await store.set({
                    probe,
                    probeSerial: device.trustedSerial,
                    family: device.family,
                    deviceId: device.id,
                    source: "user"
                });
            else if (store.get()?.source === "user") await store.clear();
        } catch (error) {
            if (probe !== current)
                await this.host._context.workspaceState.update(CACHE_KEYS.debugger, current || undefined);
            throw error;
        }
        this.host._resolvedProbeConnection = null;
        // The card's tooltip announced the script it switches to; the configuration row shows it.
        if (probe !== current) await this.host._showDebuggerConfig();
        return this.refresh();
    }
    _logDriverDiagnostics(target) {
        if (!target.interfaces?.length) return;
        if (!this.host._chipOutput) {
            this.host._chipOutput = this._vscode.window.createOutputChannel(this.host._t("diag.channelName"));
            this.host._context.subscriptions?.push(this.host._chipOutput);
        }
        this.host._chipOutput.appendLine(
            `[EmberProbe] J-Link USB driver not switchable (${target.driverReason || target.driverKind}): ` +
                `device=${target.deviceId || ""}, serial=${target.probeSerial || ""}`
        );
        for (const item of target.interfaces)
            this.host._chipOutput.appendLine(
                `  ${item.instanceId} | ${item.name} | service=${item.service} | ` +
                    `provider=${item.driverProvider} | inf=${item.driverInf}`
            );
    }
    // `target` identifies the exact J-Link the warning is about: instanceId, deviceId, probeSerial and driverKind.
    showDriverWarning(target = {}) {
        if (
            process.platform !== "win32" ||
            this.host._context.workspaceState.get(JLINK_DRIVER_WARNING_IGNORED_KEY) === true ||
            this._driverWarningPending
        )
            return;
        // Only a verified SEGGER binding of a uniquely identified interface can be switched by the helper.
        const switchable = !target.driverKind || target.driverKind === "repair";
        const switchDriver = this.host._t("probe.switchToWinUsb");
        const ignore = this.host._t("probe.ignoreDriverWarning");
        const probe = target.probeSerial ? `J-Link ${target.probeSerial}` : "J-Link";
        if (!switchable) this._logDriverDiagnostics(target);
        const message = switchable
            ? this.host._t("probe.winusbRequired", { probe })
            : this.host._t("probe.driverNotSwitchableWarning", {
                  probe,
                  reason: this.host._t(target.driverReasonKey || "probe.driverReasonInterface")
              });
        // Do not hold the failed operation's probe lease while waiting for a notification response.
        this._driverWarningPending = Promise.resolve(
            switchable
                ? this._vscode.window.showWarningMessage(message, switchDriver, ignore)
                : this._vscode.window.showWarningMessage(message, ignore)
        )
            .then(async (selected) => {
                if (selected === ignore)
                    await this.host._context.workspaceState.update(JLINK_DRIVER_WARNING_IGNORED_KEY, true);
                else if (switchable && selected === switchDriver) {
                    await new Promise((resolve) => setImmediate(resolve));
                    await this.changeDriver("winusb", target);
                }
            })
            .catch((error) => {
                if (this.host._notices.get("config", "probe-driver")?.level !== "error")
                    this.host._notices.notify("config", "probe-driver", {
                        level: "error",
                        titleKey: "notice.driverSwitchFailed",
                        error
                    });
            })
            .finally(() => {
                this._driverWarningPending = null;
            });
        return this._driverWarningPending;
    }
    // Driver install/restore progress shows next to the J-Link driver choice instead of the footer.
    notifyDriverStatus(status) {
        const busy = status.state === "installing" || status.state === "restoring";
        const done = status.state === "ready" || status.state === "restored";
        if (!busy && !done && status.state !== "error") return;
        const keys = {
            installing: "probe.driverInstalling",
            ready: "probe.driverReady",
            restoring: "probe.driverRestoring",
            restored: "probe.driverRestored"
        };
        this.host._notices.notify(
            "config",
            "probe-driver",
            status.state === "error"
                ? { level: "error", titleKey: "notice.driverSwitchFailed", message: status.message || "" }
                : { level: done ? "success" : "info", busy, key: keys[status.state] }
        );
    }
    // `target.deviceId` pins the J-Link: the sidebar passes the device its driver control belongs to and a
    // notification the device its blocked operation resolved, so a newly attached probe is never switched instead.
    // Without a target the J-Link is resolved from the workspace selection.
    async changeDriver(driver, target = null) {
        if (driver !== "winusb" && driver !== "segger")
            throw Object.assign(new Error("Invalid J-Link USB driver choice"), { code: "PROBE_DRIVER_INVALID_CHOICE" });
        // Each attempt reports its own outcome in the driver notice.
        this.host._notices.clear("config", "probe-driver");
        this.assertDriverIdle();
        this.host._assertConnectionEditable({ probeSerial: true });
        if (this.host._probeCoordinator?.anyActive())
            throw Object.assign(new Error("Wait for the current probe operation to finish before changing drivers"), {
                code: "PROBE_BUSY"
            });
        this.driverSwitching = true;
        this._revision = (this._revision || 0) + 1;
        this.host._webviewView?.webview.postMessage({ type: "probeDriverSwitch", busy: true });
        const resolveTarget = (inventory) => {
            const resolved = resolveJlinkDriverTarget(
                inventory,
                "",
                this.selection().get(),
                target?.deviceId ? target : null
            );
            if (resolved.error) throw resolved.error;
            return resolved.choice;
        };
        try {
            const choice = resolveTarget((await this.inventory().scan()).inventory);
            if (target?.instanceId && choice.instanceId !== target.instanceId)
                throw Object.assign(new Error("The selected J-Link changed; select its USB driver in the sidebar"), {
                    code: "PROBE_DRIVER_SELECTION_CHANGED",
                    i18nKey: "probe.driverSelectionChanged"
                });
            if (choice.driver === driver) return;
            const result =
                driver === "winusb"
                    ? await this.host._probeDriverService.ensure(choice.connection)
                    : await this.host._probeDriverService.restore(choice.connection);
            let verified;
            try {
                verified = resolveTarget(driver === "winusb" ? result.inventory : result);
            } catch {
                verified = null;
            }
            if (verified?.driver !== driver || verified.instanceId !== choice.instanceId)
                throw Object.assign(new Error("The selected J-Link driver could not be verified after switching"), {
                    code: "PROBE_DRIVER_VERIFY_FAILED"
                });
            // The user chose SEGGER in the card, which shows it; an operation it blocks still notifies.
            this.host._resolvedProbeConnection = null;
        } finally {
            this.driverSwitching = false;
            this.host._webviewView?.webview.postMessage({ type: "probeDriverSwitch", busy: false });
            this.refresh().catch((error) => console.error("Probe inventory check failed:", error.message));
        }
    }
}

module.exports = { ConnectedProbes };
