"use strict";
const { USB_PROFILES, matchesUsbIds } = require("./probe-profile");

function connectionError(code, message, details = {}) {
    const key = {
        PROBE_SELECTION_REQUIRED: "probe.selectionRequired",
        PROBE_SELECTION_UNSUPPORTED: "probe.selectionUnsupported",
        PROBE_IDENTITY_AMBIGUOUS: "probe.identityAmbiguous",
        PROBE_IDENTITY_UNVERIFIED: "probe.identityUnverified",
        PROBE_CAPABILITY_UNKNOWN: "probe.capabilityUnknown",
        PROBE_DRIVER_MISSING: "probe.driverMissing",
        PROBE_CONFIGURATION_CHANGED: "probe.configurationChanged",
        PROBE_SESSION_STALE: "probe.staleConnection",
        PROBE_SELECTION_CANCELLED: "probe.selectionCancelled",
        PROBE_SERIAL_INVALID: "probe.serialInvalid"
    }[code];
    return Object.assign(new Error(message), {
        code,
        category: "configuration",
        retryable: false,
        details,
        ...(key ? { i18nKey: key, i18nParams: details } : {})
    });
}

function normalizeProbeSerial(value = "", family = "") {
    const text = String(value).trim();
    if (!text) return "";
    if (family !== "jlink") {
        if (!/^[A-Za-z0-9_.: -]{1,128}$/.test(text))
            throw connectionError(
                "PROBE_SERIAL_INVALID",
                "Probe serial must contain 1..128 ASCII letters, digits, spaces or _.:-"
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
    if (config.profile) return config.profile.family;
    if (config.adapterFamily === "jlink") return "jlink";
    if (["cmsis-dap", "cmsis_dap"].includes(config.adapterFamily)) return "cmsis-dap";
    if (config.adapterFamily === "st-link" || (config.adapterFamily === "hla" && /(?:^|\/)stlink/i.test(probe)))
        return "stlink";
    if (config.adapterFamily) return USB_PROFILES[config.adapterFamily]?.family || "";
    if (isJlink(config)) return "jlink";
    if (/(?:^|\/)cmsis-dap\.cfg$/i.test(probe)) return "cmsis-dap";
    if (/(?:^|\/)stlink(?:-v[123])?\.cfg$/i.test(probe)) return "stlink";
    const driver = probe.replace(/^.*\//, "").replace(/\.cfg$/i, "");
    if (["xds110", "nulink", "ft232r", "kitprog", "vsllink", "ti-icdi"].includes(driver)) return driver;
    return "";
}

// Settings and resolved hardware identities have separate purposes. Never compare device metadata to settings.
function resolvedConnectionIdentity(connection = {}) {
    return {
        ...connectionIdentity(connection),
        ...(connection.selectionIdentity ? { selectionIdentity: connection.selectionIdentity } : {})
    };
}

function assertWriteIdentity(connection = {}) {
    const identity = connection?.selectionIdentity;
    if (identity?.kind === "usb" && identity.anonymous && !identity.attachmentId)
        throw connectionError(
            "PROBE_IDENTITY_UNVERIFIED",
            "Cannot verify this probe attachment before writing; configure an exact serial number",
            {}
        );
}

function canRememberWrite(connection = {}) {
    return !connection?.selectionIdentity?.anonymous;
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

// Windows instance IDs turn spaces in USB serials into "_"; other accepted serial characters are kept.
function trustedSerial(device, family = "") {
    const serial = device?.serial || "";
    return family === "jlink" || device?.serialSource !== "os-instance" || !serial.includes("_") ? serial : "";
}

function serialMatches(device, serial) {
    if (!device.serial || !serial) return false;
    if (device.serial === serial) return true;
    return (
        device.serialSource === "os-instance" && device.serial.toUpperCase() === serial.replace(/ /g, "_").toUpperCase()
    );
}

function resolveProbeConnection(config, inventory = { devices: [], available: false }) {
    const profile = config.profile;
    /** @type {ReturnType<typeof connectionIdentity> & {deviceId: string, selection: any, adapterSerial?: string, selectionIdentity?: any}} */
    const result = {
        ...connectionIdentity(config),
        deviceId: "",
        selection: {
            probe: "explicit",
            transport: config.transport && config.transport !== "auto" ? "explicit" : "script-default"
        }
    };
    // Network, local and unverified adapters keep OpenOCD's own selection; an explicit serial is still passed.
    if (profile && ["tcp", "local", "unknown"].includes(profile.kind)) {
        const serial =
            profile.supportsSerial || profile.kind === "unknown"
                ? normalizeProbeSerial(result.probeSerial || profile.scriptSerial, profile.family)
                : "";
        return {
            ...result,
            probeSerial: serial,
            adapterSerial: serial,
            selectionIdentity: {
                kind: profile.kind,
                profile: profile.fingerprint,
                endpoint: profile.endpoint,
                serial,
                anonymous: profile.kind === "unknown" && !serial
            }
        };
    }
    const family = probeFamily(config);
    if (!family) return result;
    const label = profile?.label || { jlink: "J-Link", "cmsis-dap": "CMSIS-DAP", stlink: "ST-Link" }[family] || family;
    const enforceable = profile?.supportsSerial !== false;
    // A changed interface profile makes the remembered device a stale hint, not a selection.
    const remembered =
        [1, 2].includes(config.successfulConnection?.version) &&
        (!config.successfulConnection.profile ||
            !profile ||
            config.successfulConnection.profile === profile.fingerprint)
            ? config.successfulConnection
            : null;
    // The previously used probe would have been selected had the interface configuration not changed.
    const profileChanged =
        !remembered &&
        [1, 2].includes(config.successfulConnection?.version) &&
        !!config.successfulConnection.probeSerial &&
        config.successfulConnection.probe === result.probe;
    result.selection = { probe: "explicit", transport: result.selection.transport };
    if (!enforceable) result.probeSerial = "";
    if (enforceable && !result.probeSerial && profile?.scriptSerial) {
        result.probeSerial = normalizeProbeSerial(profile.scriptSerial, family);
        result.selection.probe = "script";
    }
    if (
        enforceable &&
        !result.probeSerial &&
        !config.selectedDeviceId &&
        remembered?.probe === result.probe &&
        remembered.probeSerial
    ) {
        result.probeSerial = normalizeProbeSerial(remembered.probeSerial, family);
        result.selection.probe = "remembered";
    }
    const devices = inventory.available
        ? inventory.devices.filter(
              (device) =>
                  device.family === family &&
                  matchesUsbIds(device, profile?.vidPid) &&
                  (!profile?.product || (device.product || device.name) === profile.product)
          )
        : [];
    if (!result.probeSerial && devices.length > 1)
        throw Object.assign(
            connectionError(
                "PROBE_SELECTION_REQUIRED",
                profileChanged
                    ? `The ${label} interface configuration changed since the last connection; select the probe again`
                    : `Cannot select a unique ${label} from current USB inventory`,
                {
                    devices,
                    inventoryAvailable: inventory.available,
                    notes: inventory.notes || [],
                    ...(profileChanged ? { rememberedProfileChanged: true } : {})
                }
            ),
            profileChanged ? { i18nKey: "probe.rememberedProfileChanged" } : {}
        );
    if (!result.probeSerial && devices.length === 1) {
        if (config.selectedDeviceId && config.selectedDeviceId !== devices[0].id)
            throw connectionError("PROBE_IDENTITY_AMBIGUOUS", "The selected physical probe changed during selection", {
                devices
            });
        result.probeSerial = devices[0].serial || "";
        result.selection.probe = "unique-device";
    }
    // Nothing visible to the OS query: OpenOCD applies the interface script's own device selection.
    if (!result.probeSerial && !devices.length) result.selection.probe = "script-default";
    const matches =
        result.selection.probe === "unique-device"
            ? devices
            : devices.filter((device) => serialMatches(device, result.probeSerial));
    if (matches.length > 1)
        throw connectionError(
            "PROBE_IDENTITY_AMBIGUOUS",
            `Multiple physical ${label} probes have the selected serial number`,
            {
                devices: matches
            }
        );
    const remembering = result.selection.probe === "remembered";
    // A remembered probe is never replaced. Other serials are reported absent only when USB descriptors (or
    // the reserved J-Link/ST-Link IDs) prove it; Windows aliases leave enforcement to OpenOCD. An inventory
    // that skipped unreadable devices proves nothing absent, so the serial is passed for OpenOCD to enforce.
    const complete = inventory.available && !inventory.partial;
    const provesAbsence = devices.length
        ? devices.every((device) => device.serial && (family === "jlink" || device.serialSource !== "os-instance"))
        : ["jlink", "stlink"].includes(family);
    if (result.probeSerial && complete && !matches.length && (remembering || provesAbsence))
        throw Object.assign(
            connectionError(
                "PROBE_SELECTED_NOT_FOUND",
                remembering
                    ? `The previously used ${label} (${result.probeSerial}) is not present; no other device will be selected automatically`
                    : `The selected ${label} is not present; no other device will be selected`,
                { probeSerial: result.probeSerial, remembered: remembering, devices }
            ),
            {
                i18nKey: remembering ? "probe.rememberedNotFound" : "probe.selectedNotFound",
                i18nParams: { label, serial: result.probeSerial }
            }
        );
    if (result.probeSerial && !matches.length) result.selection.inventory = "unconfirmed";
    if (family === "jlink" && result.transport === "auto") {
        if (isKnownCortexM(result.target)) {
            result.transport = "swd";
            result.selection.transport = "cortex-m";
        } else {
            result.selection.transport = "script-default";
        }
    }
    const selected = matches.length === 1 ? matches[0] : null;
    // Automatic selections only trust serials that are exact USB descriptor strings. Without inventory, a
    // remembered serial is still passed so OpenOCD cannot open another probe.
    const automatic = result.selection.probe === "unique-device" || (remembering && !!selected);
    const exactSerial = !enforceable ? "" : automatic ? trustedSerial(selected, family) : result.probeSerial;
    // A unique Windows device needs no serial filter; its OS alias is only a selection hint.
    const windowsAlias = selected?.serialSource === "os-instance" && family !== "jlink";
    result.adapterSerial = result.selection.probe === "unique-device" && windowsAlias ? "" : exactSerial;
    if (devices.length > 1 && !result.adapterSerial)
        throw connectionError(
            "PROBE_SELECTION_REQUIRED",
            `Cannot select one of several ${label} probes without an exact USB serial`,
            { devices, inventoryAvailable: inventory.available, notes: inventory.notes || [] }
        );
    const anonymous = !exactSerial;
    result.deviceId = selected?.id || "";
    // Without a serial filter OpenOCD may open a probe the partial inventory skipped, so the visible
    // attachment cannot authorize writes.
    result.selectionIdentity = {
        kind: "usb",
        family,
        deviceId: result.deviceId,
        attachmentId: anonymous && complete ? String(selected?.attachmentId || "") : "",
        serial: exactSerial,
        anonymous,
        profile: profile?.fingerprint || ""
    };
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
    resolvedConnectionIdentity,
    assertWriteIdentity,
    canRememberWrite,
    trustedSerial,
    resolveProbeConnection
};
