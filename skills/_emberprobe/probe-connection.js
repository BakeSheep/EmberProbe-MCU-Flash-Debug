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
    const result = {
        ...connectionIdentity(config),
        deviceId: "",
        selection: {
            probe: "explicit",
            transport: config.transport && config.transport !== "auto" ? "explicit" : "script-default"
        }
    };
    if (!isJlink(config)) return result;
    const remembered = config.successfulConnection?.version === 1 ? config.successfulConnection : null;
    result.selection = { probe: "explicit", transport: "explicit" };
    if (!result.probeSerial && remembered?.probe === result.probe && remembered.probeSerial) {
        result.probeSerial = normalizeProbeSerial(remembered.probeSerial);
        result.selection.probe = "remembered";
    }
    const devices = inventory.devices.filter((device) => device.family === "jlink");
    if (!result.probeSerial && devices.length === 1 && devices[0].serial) {
        result.probeSerial = devices[0].serial;
        result.selection.probe = "unique-device";
    }
    if (!result.probeSerial)
        throw connectionError("PROBE_SELECTION_REQUIRED", "Cannot select a unique J-Link from current USB inventory", {
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
    if (result.selection.probe === "remembered" && (!inventory.available || matches.length !== 1))
        throw connectionError("PROBE_IDENTITY_AMBIGUOUS", "Cannot verify the remembered probe in current inventory");
    if (result.transport === "auto") {
        const sameDevice = !!remembered?.deviceId && matches.length === 1 && remembered.deviceId === matches[0].id;
        if (
            sameDevice &&
            remembered.probeSerial === result.probeSerial &&
            remembered.target === result.target &&
            config.fingerprint &&
            remembered.fingerprint === config.fingerprint &&
            ["swd", "jtag"].includes(remembered.transport)
        ) {
            result.transport = remembered.transport;
            result.selection.transport = "remembered";
        } else if (isKnownCortexM(result.target)) {
            result.transport = "swd";
            result.selection.transport = "cortex-m";
        } else {
            result.selection.transport = "script-default";
        }
    }
    result.deviceId = matches.length === 1 ? matches[0].id || "" : "";
    return result;
}

// Only targets already recognized by autoDetect; do not infer architecture from a probe's name.
function isKnownCortexM(target) {
    return /^(?:stm32(?:f[012347]|g[04]|h7|l[0145]|u5|wb|wl)x?|geehy\/apm32f[014]x|gd32e23x|nordic\/nrf5[12]|rp2040)\.cfg$/.test(
        target
    );
}

module.exports = {
    connectionError,
    normalizeProbeSerial,
    normalizeAdapterSpeed,
    isJlink,
    connectionIdentity,
    resolveProbeConnection
};
