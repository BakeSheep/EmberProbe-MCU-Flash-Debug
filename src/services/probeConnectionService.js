"use strict";
const { randomUUID } = require("crypto");
const { prepareProbeConnection } = require("../../skills/_emberprobe/probe-preflight");
const { detectProbe } = require("../../skills/_emberprobe/probe-detection");
const { listProbes } = require("../../skills/_emberprobe/probe-inventory");
const {
    normalizeProbeSerial,
    normalizeAdapterSpeed,
    connectionIdentity,
    connectionError,
    trustedSerial,
    probeFamily
} = require("../../skills/_emberprobe/probe-connection");
const { runOpenOcdOnce } = require("./openocdExec");
const {
    normalizeTargetIdentity,
    targetCheckCommand,
    targetCheckMonitor,
    observedTargetIdentity,
    onTargetMismatch,
    sameTarget,
    targetMatchesModel,
    describeTargetIdentity
} = require("../chip/targetIdentity");

// Target readings of connected probes, by device and USB attachment; replugging a probe starts a new entry.
const MAX_TARGET_READINGS = 16;
const MAX_ISSUED_CHECKS = 32;

function targetKey(device) {
    return `${device.id}|${device.attachmentId || ""}`;
}

function mergedIdentity(previous, identity) {
    if (!previous || !sameTarget(previous, identity)) return identity;
    return {
        cpuid: identity.cpuid || previous.cpuid,
        idcode: identity.idcode || previous.idcode,
        uid: identity.uid || previous.uid
    };
}

// UI and automated callers receive the same structured configuration errors; an interactive caller also has the
// sidebar's connected probe list revealed when the user has to pick a probe there.
class ProbeConnectionService {
    constructor(options) {
        this.getConfig = options.getConfig;
        this.onSelectionRequired = options.onSelectionRequired || (() => {});
        this.prepareConnection =
            options.prepareConnection ||
            ((request) =>
                prepareProbeConnection(request, {
                    listProbes: async (inventoryOptions) =>
                        options.driverService && inventoryOptions.family === "jlink"
                            ? options.driverService.reconcileInventory(await listProbes(inventoryOptions))
                            : listProbes(inventoryOptions)
                }));
        this.getSuccessfulConnection = options.getSuccessfulConnection || (() => null);
        this.saveSuccessfulConnection = options.saveSuccessfulConnection || (async () => {});
        this.onResolved = options.onResolved || (() => {});
        this.recorded = new WeakSet();
        this.recordQueue = Promise.resolve();
        this.detectProbe = options.detectProbe || detectProbe;
        this.driverService = options.driverService || null;
        this.beforePrepare = options.beforePrepare || (() => {});
        this.onDriverUnsupported = options.onDriverUnsupported || (() => {});
        this.staleSessions = new WeakSet();
        this.runOpenOcd = options.runOpenOcd || runOpenOcdOnce;
        // Reading other probes' targets starts OpenOCD; only the extension host enables it (readTargetIdentity).
        this.identifyTarget = options.identifyTarget || null;
        this.onTargetStateChanged = options.onTargetStateChanged || (() => {});
        this.targetReadings = new Map();
        this.issuedChecks = new Map();
        this.targetMismatch = null;
        this.stopMismatchListener = onTargetMismatch((error) => this.noteTargetMismatch(error));
    }

    dispose() {
        this.stopMismatchListener();
    }

    // Automatic mode: neither the probeSerial setting, the request nor a workspace pick for the interface script
    // names the probe. A pick made under another interface script is not used, as preflight ignores it.
    isAutomatic(request, selection = this.getSuccessfulConnection()) {
        const probe = request.probe || request.debugger;
        return (
            !normalizeProbeSerial(request.probeSerial) &&
            !(selection?.probeSerial && (!probe || selection.probe === probe))
        );
    }

    // The chip automatic mode verified last for this target configuration.
    expectedTarget(target, selection = this.getSuccessfulConnection()) {
        return selection?.source === "auto" && selection.target === target
            ? normalizeTargetIdentity(selection.chip)
            : null;
    }

    targetReading(device) {
        return this.targetReadings.get(targetKey(device)) || null;
    }

    rememberTargetReading(device, identity) {
        const key = targetKey(device);
        this.targetReadings.delete(key);
        if (!identity) return;
        this.targetReadings.set(key, identity);
        if (this.targetReadings.size > MAX_TARGET_READINGS)
            this.targetReadings.delete(this.targetReadings.keys().next().value);
    }

    forgetTargetReadings(deviceId) {
        for (const key of [...this.targetReadings.keys()])
            if (key.startsWith(`${deviceId}|`)) this.targetReadings.delete(key);
    }

    // A simplified chip read on one probe: init, three identity reads and shutdown, without halting the target.
    async readTargetIdentity(request) {
        const connection = await this.prepareConnection(request);
        const monitor = targetCheckMonitor(null);
        await this.runOpenOcd({
            executable: request.executable || connection.openocd,
            probe: request.probe,
            target: request.target,
            transport: connection.transport,
            probeSerial: connection.probeSerial,
            adapterSerial: connection.adapterSerial,
            adapterBackend: connection.adapterBackend,
            adapterSpeedKhz: connection.adapterSpeedKhz,
            inventory: connection.inventory,
            cwd: request.cwd,
            timeoutMs: 5000,
            waitForCloseOnTimeout: true,
            buildCommands: () => ["init", targetCheckCommand(request.target), "shutdown"],
            onLine: (line) => monitor.line(line)
        });
        return monitor.observed;
    }

    // Among several probes of one family, automatic mode uses the one connected to the recorded chip, or without a
    // record the only one whose chip is of the configured model. Earlier readings are tried first; the operation's
    // own check catches a reading that went stale. Unsettled probes are read again, all at once. A probe whose USB
    // driver blocked its reading is reported (`driverError`): switching that driver is what settles the choice.
    async pickByTarget(devices, request, expected) {
        const candidates = devices.filter((device) => trustedSerial(device, device.family));
        if (candidates.length < 2 || !this.identifyTarget) return { device: null, readings: [], driverError: null };
        let driverError = null;
        const choose = (readings) => {
            const matches = candidates.filter((_device, index) =>
                expected
                    ? sameTarget(readings[index], expected)
                    : targetMatchesModel(readings[index], request.target) === true
            );
            return matches.length === 1 ? matches[0] : null;
        };
        let readings = candidates.map((device) => this.targetReading(device));
        let device = readings.every(Boolean) ? choose(readings) : null;
        if (!device) {
            readings = await Promise.all(
                candidates.map(async (candidate) => {
                    let identity = null;
                    try {
                        identity = normalizeTargetIdentity(
                            await this.identifyTarget({
                                ...request,
                                probeSerial: normalizeProbeSerial(trustedSerial(candidate, candidate.family)),
                                successfulConnection: null
                            })
                        );
                    } catch (error) {
                        // An unreachable target (no power, another chip family, probe in use) is not this one.
                        if (error?.code === "PROBE_DRIVER_UNSUPPORTED") driverError ||= error;
                    }
                    this.rememberTargetReading(candidate, identity);
                    return identity;
                })
            );
            device = choose(readings);
        }
        return {
            device,
            readings: candidates.map((candidate, index) => [candidate.id, readings[index]]),
            driverError: device ? null : driverError
        };
    }

    // The sidebar's refresh: the same short read on each listed probe at once, with that probe's interface script.
    // A probe that cannot be read (held by another program, unpowered target, blocked driver) keeps no reading.
    async readListedTargets(probes, request) {
        if (!this.identifyTarget) return [];
        const configured = this.getConfig();
        return Promise.all(
            probes.map(async ({ device, probe, probeSerial }) => {
                let identity = null;
                try {
                    identity = normalizeTargetIdentity(
                        await this.identifyTarget({
                            ...configured,
                            ...request,
                            probe,
                            debugger: probe,
                            mcu: request.target,
                            probeSerial: normalizeProbeSerial(probeSerial),
                            successfulConnection: null
                        })
                    );
                } catch {
                    // Not readable now: the card shows no chip.
                }
                this.rememberTargetReading(device, identity);
                return [device.id, identity];
            })
        );
    }

    noteTargetMismatch(error) {
        const issued = this.issuedChecks.get(error.details?.checkId);
        const observed = normalizeTargetIdentity(error.details?.observed);
        if (!issued || !observed) return;
        if (issued.deviceId) this.forgetTargetReadings(issued.deviceId);
        this.targetMismatch = { ...issued, expected: normalizeTargetIdentity(error.details.expected), observed };
        this.onTargetStateChanged();
    }

    clearTargetMismatch() {
        if (!this.targetMismatch) return;
        this.targetMismatch = null;
        this.onTargetStateChanged();
    }

    // The user confirmed the chip on the probe is the intended one: record it as automatic mode's target.
    async acceptTargetMismatch() {
        const mismatch = this.targetMismatch;
        if (!mismatch) return false;
        await this.recordQueue;
        if (!this.isAutomatic(this.getConfig())) return false;
        this.targetMismatch = null;
        await this.saveTarget(mismatch.probe, mismatch.target, mismatch.observed);
        this.onTargetStateChanged();
        return true;
    }

    async saveTarget(probe, target, chip) {
        this.recordQueue = this.recordQueue
            .then(() =>
                this.saveSuccessfulConnection({
                    version: 3,
                    probe,
                    probeSerial: "",
                    family: probeFamily({ probe }),
                    deviceId: "",
                    source: "auto",
                    target,
                    chip
                })
            )
            .catch(() => {
                // A failed workspace-state write only loses the record; the next operation records again.
            });
        await this.recordQueue;
    }

    describeTargetState(target) {
        const selection = this.getSuccessfulConnection();
        const expected = this.isAutomatic(this.getConfig(), selection) ? this.expectedTarget(target, selection) : null;
        return {
            autoTarget: describeTargetIdentity(expected),
            targetMismatch:
                this.targetMismatch && this.targetMismatch.target === target
                    ? {
                          expected: describeTargetIdentity(this.targetMismatch.expected),
                          actual: describeTargetIdentity(this.targetMismatch.observed)
                      }
                    : null
        };
    }

    markConfigurationChanged(sessions) {
        for (const session of sessions.filter(Boolean)) {
            if (!session.options?.settingsIdentity || this.settingsChanged(session)) this.staleSessions.add(session);
        }
    }

    settingsChanged(session) {
        const previous = session.options?.settingsIdentity;
        const configured = this.getConfig();
        return (
            (!!previous && JSON.stringify(previous) !== JSON.stringify(connectionIdentity(configured))) ||
            (session.options?.samplingAdapterSpeedKhz !== undefined &&
                session.options.samplingAdapterSpeedKhz !== normalizeAdapterSpeed(configured.samplingAdapterSpeedKhz))
        );
    }

    assertCurrent(session) {
        if (this.settingsChanged(session)) this.staleSessions.add(session);
        if (this.staleSessions.has(session))
            throw connectionError(
                "PROBE_SESSION_STALE",
                "Connection settings changed; stop and restart the session before writing"
            );
    }

    async prepare(options, interactive = false) {
        const preparationOptions = typeof interactive === "object" && interactive ? interactive : {};
        interactive = interactive === true;
        this.beforePrepare();
        const configured = this.getConfig();
        const samplingSpeed = options.sampling ? normalizeAdapterSpeed(configured.samplingAdapterSpeedKhz) : undefined;
        const expectedSettings = JSON.stringify(connectionIdentity(configured));
        const selection = this.getSuccessfulConnection();
        let request = { ...configured, ...options, successfulConnection: selection };
        request.probe = request.probe || request.debugger || (await this.resolveProbe());
        request.target = request.target || request.mcu;
        const automatic = this.isAutomatic(request, selection);
        const expected = automatic ? this.expectedTarget(request.target, selection) : null;
        let pickedByTarget = "";
        for (let attempt = 0; attempt < 3; attempt++) {
            this.beforePrepare();
            try {
                const prepared = await this.prepareConnection(request, preparationOptions);
                this.beforePrepare();
                const result = prepared;
                const current = connectionIdentity(this.getConfig());
                if (
                    JSON.stringify(current) !== expectedSettings ||
                    (samplingSpeed !== undefined &&
                        samplingSpeed !== normalizeAdapterSpeed(this.getConfig().samplingAdapterSpeedKhz))
                )
                    throw connectionError(
                        "PROBE_CONFIGURATION_CHANGED",
                        "Connection settings changed during preflight; retry the operation"
                    );
                const picked = !!pickedByTarget && result.deviceId === pickedByTarget;
                // Every operation in automatic mode checks its target chip right after init.
                const checked =
                    automatic && (picked || ["unique-device", "script-default"].includes(result.selection?.probe));
                const targetCheck = checked
                    ? Object.freeze({
                          checkId: randomUUID(),
                          probe: request.probe,
                          target: request.target,
                          deviceId: result.deviceId || "",
                          expected: expected ? Object.freeze({ ...expected }) : null
                      })
                    : null;
                if (targetCheck) {
                    this.issuedChecks.set(targetCheck.checkId, targetCheck);
                    if (this.issuedChecks.size > MAX_ISSUED_CHECKS)
                        this.issuedChecks.delete(this.issuedChecks.keys().next().value);
                }
                const connection = Object.freeze({
                    ...result,
                    backendKind: result.profile?.kind || result.selectionIdentity?.kind,
                    ...(samplingSpeed === undefined ? {} : { samplingAdapterSpeedKhz: samplingSpeed }),
                    selection: Object.freeze({ ...result.selection, ...(picked ? { probe: "target-chip" } : {}) }),
                    ...(targetCheck ? { targetCheck } : {}),
                    ...(result.selectionIdentity
                        ? { selectionIdentity: Object.freeze({ ...result.selectionIdentity }) }
                        : {}),
                    settingsIdentity: Object.freeze(current)
                });
                this.onResolved(connection);
                return connection;
            } catch (error) {
                if (error.code === "PROBE_DRIVER_UNSUPPORTED") this.onDriverUnsupported(error);
                if (
                    automatic &&
                    !pickedByTarget &&
                    error.code === "PROBE_SELECTION_REQUIRED" &&
                    !error.details?.rememberedProfileChanged
                ) {
                    const { device, readings, driverError } = await this.pickByTarget(
                        error.details?.devices || [],
                        request,
                        expected
                    );
                    if (device) {
                        pickedByTarget = device.id;
                        request = {
                            ...request,
                            probeSerial: normalizeProbeSerial(trustedSerial(device, device.family))
                        };
                        continue;
                    }
                    // A driver kept a probe's chip unread: report it like the operation's own driver check, whose
                    // notification switches that exact J-Link; the list holds every J-Link's driver control.
                    if (driverError) {
                        this.onDriverUnsupported(driverError);
                        if (interactive) this.onSelectionRequired(driverError);
                        throw driverError;
                    }
                    // Unsettled: the sidebar list shows each probe's chip for the user to pick from.
                    const labels = new Map(readings.map(([id, identity]) => [id, describeTargetIdentity(identity)]));
                    error.details.devices = error.details.devices.map((item) =>
                        labels.get(item.id) ? { ...item, targetLabel: labels.get(item.id) } : item
                    );
                }
                // The sidebar's connected probe list is the only place a probe is picked; nothing here prompts. A
                // picked probe that is missing is never replaced; the list shows it as not connected.
                const pickable = this.pickableInSidebar(error);
                if (pickable && !error.details?.rememberedProfileChanged)
                    Object.assign(error, { i18nKey: "probe.chooseInSidebar", i18nParams: {} });
                const staleRemembered = error.code === "PROBE_SELECTED_NOT_FOUND" && error.details?.remembered === true;
                if (interactive && (pickable || staleRemembered)) this.onSelectionRequired(error);
                throw error;
            }
        }
        throw connectionError("PROBE_CONFIGURATION_CHANGED", "Probe configuration could not be resolved");
    }

    // Several connected probes of which the sidebar can save at least one by an enforceable serial.
    pickableInSidebar(error) {
        const devices = error.details?.devices || [];
        return (
            error.code === "PROBE_SELECTION_REQUIRED" &&
            devices.length > 1 &&
            devices.some((device) => trustedSerial(device, device.family))
        );
    }

    async resolveProbe() {
        const configured = this.getConfig();
        if (configured.debugger || configured.probe) return configured.debugger || configured.probe;
        const remembered = this.getSuccessfulConnection();
        if ([1, 2, 3].includes(remembered?.version) && remembered.probe) return remembered.probe;
        const detected = await this.detectProbe();
        if (!detected.probe)
            throw connectionError("PROBE_SELECTION_REQUIRED", "Cannot determine a unique probe type", {
                candidates: detected.candidates,
                notes: detected.notes
            });
        return detected.probe;
    }

    async recordSuccess(connection) {
        if (connection?.targetCheck) return this.recordTarget(connection);
        if (
            !connection ||
            this.recorded.has(connection) ||
            !connection.probe ||
            (!connection.probeSerial && !connection.selectionIdentity) ||
            (connection.selectionIdentity?.kind !== "tcp" &&
                connection.selectionIdentity?.kind !== "local" &&
                connection.inventory &&
                (!connection.inventory.available || !connection.deviceId)) ||
            (connection.settingsIdentity && this.settingsChanged({ options: connection }))
        )
            return;
        this.recorded.add(connection);
        this.recordQueue = this.recordQueue
            .then(async () => {
                if (connection.settingsIdentity && this.settingsChanged({ options: connection })) return;
                // Only the user's pick names a probe. A success on that probe refreshes it; one on another device of
                // the same interface script (a probeSerial setting) keeps the pick, as it keeps automatic mode's
                // chip record. Otherwise only the interface script is remembered, so automatic mode stays on.
                const current = this.getSuccessfulConnection();
                const serial = connection.selectionIdentity?.anonymous ? "" : connection.probeSerial;
                const sameScript = current?.probe === connection.probe;
                const kept = sameScript && current.source === "user";
                if ((kept && current.probeSerial !== serial) || (sameScript && current.source === "auto")) return;
                await this.saveSuccessfulConnection({
                    version: 3,
                    probe: connection.probe,
                    probeSerial: kept ? serial : "",
                    family: probeFamily(connection),
                    deviceId: kept ? connection.deviceId || current.deviceId || "" : "",
                    ...(connection.profile ? { profile: connection.profile.fingerprint } : {}),
                    source: kept ? "user" : "success"
                });
            })
            .catch(() => {
                this.recorded.delete(connection);
            });
        await this.recordQueue;
    }

    // Automatic mode keeps no probe; a successful operation records the chip its check observed.
    async recordTarget(connection) {
        const check = connection.targetCheck;
        const identity = observedTargetIdentity(check.checkId);
        if (
            !identity ||
            this.recorded.has(connection) ||
            (connection.settingsIdentity && this.settingsChanged({ options: connection }))
        )
            return;
        this.recorded.add(connection);
        const device = connection.inventory?.devices?.find((item) => item.id === connection.deviceId);
        if (device) this.rememberTargetReading(device, identity);
        // A verified operation on this target settles an earlier mismatch.
        if (this.targetMismatch?.target === check.target) {
            this.targetMismatch = null;
            this.onTargetStateChanged();
        }
        await this.recordQueue;
        const current = this.getSuccessfulConnection();
        // A probe picked while the operation ran ends automatic mode.
        if (!this.isAutomatic(this.getConfig(), current)) return;
        const previous = this.expectedTarget(check.target, current);
        const chip = mergedIdentity(previous, identity);
        if (current?.probe === check.probe && JSON.stringify(previous) === JSON.stringify(chip)) return;
        await this.saveTarget(check.probe, check.target, chip);
        this.onTargetStateChanged();
    }
}

module.exports = { ProbeConnectionService };
