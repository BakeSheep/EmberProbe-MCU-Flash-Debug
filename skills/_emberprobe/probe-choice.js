"use strict";
const { resolveProbeConnection, probeFamily, trustedSerial } = require("./probe-connection");
const { classifyJlinkDriver } = require("./jlink-driver");

const DEFAULT_CONFIGS = Object.freeze({
    jlink: "jlink.cfg",
    "cmsis-dap": "cmsis-dap.cfg",
    stlink: "stlink.cfg",
    xds110: "xds110.cfg",
    nulink: "nulink.cfg"
});

function errorSummary(error) {
    return {
        code: error.code || "",
        message: error.message,
        ...(error.i18nKey ? { i18nKey: error.i18nKey, i18nParams: error.i18nParams || {} } : {})
    };
}

// Describes which connected probe the configured interface would use and why, using the same resolver as
// preflight, so the sidebar, driver switching and Agent never disagree with the operation that follows.
// `config`: { probe, probeSerial (settings override), successfulConnection (workspace selection), profile? }.
function describeProbeSelection(config, inventory, platform = process.platform, arch = process.arch) {
    const family = probeFamily(config);
    const available = !!inventory?.available;
    const devices = available ? inventory.devices || [] : [];
    const familyCounts = new Map();
    for (const device of devices) familyCounts.set(device.family, (familyCounts.get(device.family) || 0) + 1);
    const result = {
        family,
        state: "none",
        source: "",
        probeSerial: "",
        deviceId: "",
        error: null,
        devices: []
    };
    if (!available) result.state = "unavailable";
    // No interface script yet: picking a device chooses the script for its family.
    else if (!config.probe && !config.debugger) result.state = "unconfigured";
    else if (!family) result.state = "script";
    else {
        try {
            const resolved = resolveProbeConnection({ ...config, probe: config.probe || config.debugger }, inventory);
            result.probeSerial = resolved.probeSerial || "";
            result.deviceId = resolved.deviceId || "";
            result.source = config.probeSerial ? "setting" : resolved.selection?.probe || "";
            if (resolved.deviceId) result.state = "selected";
            else if (resolved.selection?.probe === "script") result.state = "script";
            else if (resolved.probeSerial) result.state = "absent";
        } catch (error) {
            result.error = errorSummary(error);
            if (error.code === "PROBE_SELECTED_NOT_FOUND") {
                result.state = "absent";
                result.probeSerial = error.details?.probeSerial || "";
                result.source = error.details?.remembered ? "remembered" : "setting";
            } else if (["PROBE_SELECTION_REQUIRED", "PROBE_IDENTITY_AMBIGUOUS"].includes(error.code))
                result.state = "ambiguous";
            else result.state = "unavailable";
        }
    }
    result.devices = devices.map((device) => {
        const serial = trustedSerial(device, device.family);
        // OpenOCD can only be pointed at one of several same-family probes by an exact USB serial.
        const selectable = familyCounts.get(device.family) === 1 || !!serial;
        const driver =
            device.family === "jlink" && platform === "win32"
                ? classifyJlinkDriver({ adapterFamily: "jlink", deviceId: device.id, inventory }, platform, arch)
                : null;
        return {
            id: device.id,
            family: device.family,
            name: device.name || device.product || "",
            serial: device.serial || "",
            trustedSerial: serial,
            defaultConfig: DEFAULT_CONFIGS[device.family] || "",
            matchesDebugger: !!family && device.family === family,
            selected: !!result.deviceId && device.id === result.deviceId,
            selectable,
            ...(selectable ? {} : { reasonKey: "probe.noTrustedSerial" }),
            ...(driver
                ? {
                      driver: {
                          kind: driver.kind,
                          ...(driver.instanceId ? { instanceId: driver.instanceId } : {}),
                          ...(driver.reasonKey ? { reasonKey: driver.reasonKey } : {})
                      }
                  }
                : {})
        };
    });
    return result;
}

module.exports = { describeProbeSelection, DEFAULT_CONFIGS };
