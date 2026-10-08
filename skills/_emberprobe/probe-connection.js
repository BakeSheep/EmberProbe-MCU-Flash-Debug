"use strict";

function connectionError(code, message, details = {}) {
    return Object.assign(new Error(message), { code, category: "configuration", retryable: false, details });
}

function normalizeProbeSerial(value = "", family = "") {
    const text = String(value).trim();
    if (!text) return "";
    if (family !== "jlink") {
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(text))
            throw connectionError(
                "PROBE_SERIAL_INVALID",
                "Probe serial must contain 1..128 ASCII letters, digits or _.:-"
            );
        return text;
    }
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

function probeFamily(config) {
    const probe = config.probe || config.debugger || "";
    if (config.adapterFamily === "jlink") return "jlink";
    if (["cmsis-dap", "cmsis_dap"].includes(config.adapterFamily)) return "cmsis-dap";
    if (config.adapterFamily === "st-link" || (config.adapterFamily === "hla" && /(?:^|\/)stlink/i.test(probe)))
        return "stlink";
    if (config.adapterFamily) return "";
    if (isJlink(config)) return "jlink";
    if (/(?:^|\/)cmsis-dap\.cfg$/i.test(probe)) return "cmsis-dap";
    if (/(?:^|\/)stlink(?:-v[123])?\.cfg$/i.test(probe)) return "stlink";
    return "";
}

function connectionIdentity(config = {}) {
    return {
        probe: String(config.probe || config.debugger || ""),
        target: String(config.target || config.mcu || ""),
        transport: config.transport || "auto",
        probeSerial: normalizeProbeSerial(config.probeSerial, probeFamily(config)),
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
    const family = probeFamily(config);
    if (!family) return result;
    const label = { jlink: "J-Link", "cmsis-dap": "CMSIS-DAP", stlink: "ST-Link" }[family];
    const remembered = config.successfulConnection?.version === 1 ? config.successfulConnection : null;
    result.selection = { probe: "explicit", transport: result.selection.transport };
    if (!result.probeSerial && remembered?.probe === result.probe && remembered.probeSerial) {
        result.probeSerial = normalizeProbeSerial(remembered.probeSerial, family);
        result.selection.probe = "remembered";
    }
    const devices = inventory.devices.filter((device) => device.family === family);
    if (!result.probeSerial && devices.length === 1 && devices[0].serial) {
        result.probeSerial = normalizeProbeSerial(devices[0].serial, family);
        result.selection.probe = "unique-device";
    }
    if (!result.probeSerial)
        throw connectionError(
            "PROBE_SELECTION_REQUIRED",
            `Cannot select a unique ${label} from current USB inventory`,
            {
                devices,
                inventoryAvailable: inventory.available,
                notes: inventory.notes || []
            }
        );
    const matches = devices.filter((device) => device.serial === result.probeSerial);
    if (matches.length > 1)
        throw connectionError(
            "PROBE_IDENTITY_AMBIGUOUS",
            `Multiple physical ${label} probes have the selected serial number`,
            {
                devices: matches
            }
        );
    if (inventory.available && !matches.length && devices.every((device) => device.serial))
        throw connectionError(
            "PROBE_SELECTED_NOT_FOUND",
            `The selected ${label} is not present; no other device will be selected`,
            { probeSerial: result.probeSerial }
        );
    if (devices.length > 1 && devices.some((device) => !device.serial))
        throw connectionError(
            "PROBE_IDENTITY_AMBIGUOUS",
            `Cannot establish unique identity while another ${label} has no readable serial`,
            { devices }
        );
    if (result.selection.probe === "remembered" && (!inventory.available || matches.length !== 1))
        throw connectionError("PROBE_IDENTITY_AMBIGUOUS", "Cannot verify the remembered probe in current inventory");
    if (family === "jlink" && result.transport === "auto") {
        if (isKnownCortexM(result.target)) {
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
    probeFamily,
    connectionIdentity,
    resolveProbeConnection
};
