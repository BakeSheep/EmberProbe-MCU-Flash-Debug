"use strict";
const { prepareProbeConnection } = require("../../skills/_emberprobe/probe-preflight");
const { detectProbe } = require("../../skills/_emberprobe/probe-detection");
const { listProbes } = require("../../skills/_emberprobe/probe-inventory");
const {
    normalizeProbeSerial,
    connectionIdentity,
    connectionError
} = require("../../skills/_emberprobe/probe-connection");

// UI prompts live here; automated callers receive the same structured configuration errors.
class ProbeConnectionService {
    constructor(options) {
        this.getConfig = options.getConfig;
        this.window = options.window;
        this.prepareConnection =
            options.prepareConnection ||
            ((request) =>
                prepareProbeConnection(request, {
                    listProbes: async () =>
                        options.driverService
                            ? options.driverService.reconcileInventory(await listProbes())
                            : listProbes()
                }));
        this.getSuccessfulConnection = options.getSuccessfulConnection || (() => null);
        this.saveSuccessfulConnection = options.saveSuccessfulConnection || (async () => {});
        this.onResolved = options.onResolved || (() => {});
        this.recorded = new WeakSet();
        this.recordQueue = Promise.resolve();
        this.detectProbe = options.detectProbe || detectProbe;
        this.driverService = options.driverService || null;
        this.beforePrepare = options.beforePrepare || (() => {});
        this.staleSessions = new WeakSet();
    }

    markConfigurationChanged(sessions) {
        for (const session of sessions.filter(Boolean)) {
            if (!session.options?.settingsIdentity || this.settingsChanged(session)) this.staleSessions.add(session);
        }
    }

    settingsChanged(session) {
        const previous = session.options?.settingsIdentity;
        return !!previous && JSON.stringify(previous) !== JSON.stringify(connectionIdentity(this.getConfig()));
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
        this.beforePrepare();
        const configured = this.getConfig();
        const expectedSettings = JSON.stringify(connectionIdentity(configured));
        let request = { ...configured, ...options, successfulConnection: this.getSuccessfulConnection() };
        request.probe = request.probe || request.debugger || (await this.resolveProbe());
        request.target = request.target || request.mcu;
        for (let attempt = 0; attempt < 3; attempt++) {
            this.beforePrepare();
            try {
                const prepared = await this.prepareConnection(request);
                this.beforePrepare();
                const result = this.driverService ? this.driverService.requireWinUsb(prepared) : prepared;
                const current = connectionIdentity(this.getConfig());
                if (JSON.stringify(current) !== expectedSettings)
                    throw connectionError(
                        "PROBE_CONFIGURATION_CHANGED",
                        "Connection settings changed during preflight; retry the operation"
                    );
                const connection = Object.freeze({
                    ...result,
                    selection: Object.freeze({ ...result.selection }),
                    settingsIdentity: Object.freeze(current)
                });
                this.onResolved(connection);
                return connection;
            } catch (error) {
                if (!interactive) throw error;
                let values;
                if (error.code === "PROBE_SELECTION_REQUIRED") {
                    const choices = (error.details?.devices || [])
                        .filter((device) => device.serial)
                        .map((device) => ({
                            label: device.serial,
                            description: device.name,
                            value: device.serial
                        }));
                    if (!choices.length) throw error;
                    const selected = await this.window.showQuickPick(choices, { title: "Select physical J-Link" });
                    if (selected) {
                        const serial = selected.value;
                        if (serial) values = { probeSerial: normalizeProbeSerial(serial) };
                    }
                } else throw error;
                if (!values)
                    throw connectionError("PROBE_SELECTION_CANCELLED", "J-Link connection selection was cancelled");
                request = { ...request, ...values };
            }
        }
        throw connectionError("PROBE_CONFIGURATION_CHANGED", "Probe configuration could not be resolved");
    }

    async resolveProbe() {
        const configured = this.getConfig();
        if (configured.debugger || configured.probe) return configured.debugger || configured.probe;
        const remembered = this.getSuccessfulConnection();
        if (remembered?.version === 1 && remembered.probe) return remembered.probe;
        const detected = await this.detectProbe();
        if (!detected.probe)
            throw connectionError("PROBE_SELECTION_REQUIRED", "Cannot determine a unique probe type", {
                candidates: detected.candidates,
                notes: detected.notes
            });
        return detected.probe;
    }

    async recordSuccess(connection) {
        if (
            !connection ||
            this.recorded.has(connection) ||
            connection.adapterFamily !== "jlink" ||
            !connection.deviceId ||
            !connection.fingerprint ||
            !["swd", "jtag"].includes(connection.transport) ||
            !connection.settingsIdentity ||
            this.settingsChanged({ options: connection })
        )
            return;
        this.recorded.add(connection);
        this.recordQueue = this.recordQueue
            .then(async () => {
                if (this.settingsChanged({ options: connection })) return;
                await this.saveSuccessfulConnection({
                    version: 1,
                    probe: connection.probe,
                    probeSerial: connection.probeSerial,
                    deviceId: connection.deviceId,
                    target: connection.target,
                    transport: connection.transport,
                    fingerprint: connection.fingerprint
                });
            })
            .catch(() => {
                this.recorded.delete(connection);
            });
        await this.recordQueue;
    }

    async forgetSuccess() {
        await this.recordQueue;
        await this.saveSuccessfulConnection(undefined);
    }
}

module.exports = { ProbeConnectionService };
