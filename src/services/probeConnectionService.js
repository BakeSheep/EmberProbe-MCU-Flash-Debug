"use strict";
const { prepareProbeConnection } = require("../../skills/_emberprobe/probe-preflight");
const {
    normalizeProbeSerial,
    connectionIdentity,
    connectionError
} = require("../../skills/_emberprobe/probe-connection");

// UI prompts live here; automated callers receive the same structured configuration errors.
class ProbeConnectionService {
    constructor(options) {
        this.getConfig = options.getConfig;
        this.save = options.save;
        this.window = options.window;
        this.prepareConnection = options.prepareConnection || prepareProbeConnection;
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
        const configured = this.getConfig();
        let expectedSettings = JSON.stringify(connectionIdentity(configured));
        let request = { ...configured, ...options };
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const result = await this.prepareConnection(request);
                const current = connectionIdentity(this.getConfig());
                if (JSON.stringify(current) !== expectedSettings)
                    throw connectionError(
                        "PROBE_CONFIGURATION_CHANGED",
                        "Connection settings changed during preflight; retry the operation"
                    );
                return Object.freeze({ ...result, settingsIdentity: Object.freeze(current) });
            } catch (error) {
                if (!interactive) throw error;
                let values;
                if (error.code === "PROBE_TRANSPORT_REQUIRED") {
                    const selected = await this.window.showQuickPick(
                        [
                            {
                                label: "SWD",
                                description: "Recommended for Cortex-M boards wired for SWD",
                                value: "swd"
                            },
                            { label: "JTAG", description: "Requires JTAG wiring on the target board", value: "jtag" }
                        ],
                        { title: "J-Link transport", placeHolder: "Select the transport wired on your board" }
                    );
                    if (selected) values = { transport: selected.value };
                } else if (error.code === "PROBE_SELECTION_REQUIRED") {
                    const choices = (error.details?.devices || [])
                        .filter((device) => device.serial)
                        .map((device) => ({
                            label: device.serial,
                            description: device.name,
                            value: device.serial
                        }));
                    choices.push({
                        label: "Enter serial number",
                        description: "Use the serial printed on the probe or reported by SEGGER",
                        value: ""
                    });
                    const selected = await this.window.showQuickPick(choices, { title: "Select physical J-Link" });
                    if (selected) {
                        const serial =
                            selected.value ||
                            (await this.window.showInputBox({
                                title: "J-Link serial number",
                                prompt: "Decimal serial number of the physical probe",
                                validateInput: (value) => {
                                    try {
                                        return normalizeProbeSerial(value) ? undefined : "Enter a serial number";
                                    } catch (cause) {
                                        return cause.message;
                                    }
                                }
                            }));
                        if (serial) values = { probeSerial: normalizeProbeSerial(serial) };
                    }
                } else throw error;
                if (!values)
                    throw connectionError("PROBE_SELECTION_CANCELLED", "J-Link connection selection was cancelled");
                await this.save(values);
                expectedSettings = JSON.stringify(connectionIdentity(this.getConfig()));
                request = { ...request, ...values };
            }
        }
        throw connectionError("PROBE_CONFIGURATION_CHANGED", "Probe configuration could not be resolved");
    }
}

module.exports = { ProbeConnectionService };
