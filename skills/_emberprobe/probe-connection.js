"use strict";

function connectionError(code, message, details = {}) {
    return Object.assign(new Error(message), { code, category: "configuration", retryable: false, details });
}

function normalizeProbeSerial(value = "") {
    const text = String(value).trim();
    if (!text) return "";
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1 || Number(text) > 0xffffffff)
        throw connectionError("PROBE_SERIAL_INVALID", "J-Link serial must be a decimal integer from 1 to 4294967295");
    return String(Number(text));
}

/** @param {number|string} value */
function normalizeAdapterSpeed(value = 0) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 0x7fffffff)
        throw connectionError(
            "ADAPTER_SPEED_INVALID",
            "Adapter speed must be an integer kHz value; 0 uses the script default"
        );
    return number;
}

function isJlink(config) {
    return config.adapterFamily === "jlink" || /(?:^|\/)jlink\.cfg$/i.test(config.probe || config.debugger || "");
}

function connectionIdentity(config = {}) {
    return {
        probe: String(config.probe || config.debugger || ""),
        target: String(config.target || config.mcu || ""),
        transport: config.transport || "auto",
        probeSerial: normalizeProbeSerial(config.probeSerial),
        adapterSpeedKhz: normalizeAdapterSpeed(config.adapterSpeedKhz),
        openocd: String(config.openocd || config.executable || config.openocdPath || "")
    };
}

function resolveProbeConnection(config, inventory = { devices: [], available: false }) {
    const result = connectionIdentity(config);
    if (!isJlink(config)) return result;
    if (!["swd", "jtag"].includes(result.transport))
        throw connectionError("PROBE_TRANSPORT_REQUIRED", "Select SWD or JTAG explicitly for J-Link", {
            choices: ["swd", "jtag"]
        });
    const devices = inventory.devices.filter((device) => device.family === "jlink");
    if (!result.probeSerial && devices.length === 1 && devices[0].serial) result.probeSerial = devices[0].serial;
    if (!result.probeSerial)
        throw connectionError("PROBE_SELECTION_REQUIRED", "Select a J-Link serial number before connecting", {
            devices
        });
    const matches = devices.filter((device) => device.serial === result.probeSerial);
    if (matches.length > 1)
        throw connectionError("PROBE_IDENTITY_AMBIGUOUS", "Multiple physical J-Links have the selected serial number", {
            devices: matches
        });
    if (inventory.available && !matches.length && devices.every((device) => device.serial))
        throw connectionError(
            "PROBE_SELECTED_NOT_FOUND",
            "The selected J-Link is not present; no other device will be selected",
            { probeSerial: result.probeSerial }
        );
    if (devices.length > 1 && devices.some((device) => !device.serial))
        throw connectionError(
            "PROBE_IDENTITY_AMBIGUOUS",
            "Cannot establish unique identity while another J-Link has no readable serial",
            { devices }
        );
    return result;
}

module.exports = {
    connectionError,
    normalizeProbeSerial,
    normalizeAdapterSpeed,
    isJlink,
    connectionIdentity,
    resolveProbeConnection
};
