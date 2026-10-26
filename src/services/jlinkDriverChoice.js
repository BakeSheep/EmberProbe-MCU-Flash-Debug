"use strict";

const { resolveProbeConnection } = require("../../skills/_emberprobe/probe-connection");
const { classifyJlinkDriver } = require("./probeDriverService");

function selectionError(i18nKey, message, i18nParams = {}) {
    return Object.assign(new Error(message), { code: "PROBE_DRIVER_SELECTION_REQUIRED", i18nKey, i18nParams });
}

function classified(inventory, selected, platform, arch) {
    const connection = {
        adapterFamily: "jlink",
        deviceId: selected.deviceId,
        probeSerial: selected.probeSerial,
        inventory
    };
    const state = classifyJlinkDriver(connection, platform, arch);
    if (state.kind === "repair") return { choice: { connection, driver: "segger", instanceId: state.instanceId } };
    if (state.kind === "ready") return { choice: { connection, driver: "winusb", instanceId: state.instanceId } };
    return {
        error: Object.assign(
            selectionError(
                "probe.driverNotSwitchable",
                `The selected J-Link USB driver cannot be changed automatically: ${state.reason || state.kind}`,
                { serial: selected.probeSerial || "" }
            ),
            { code: "PROBE_DRIVER_NOT_SWITCHABLE", reasonKey: state.reasonKey || "" }
        )
    };
}

// Resolves the J-Link whose driver the sidebar or a notification would change, explaining a missing choice.
// `target.deviceId` pins the physical device the warning was raised for, independent of saved settings.
function resolveJlinkDriverTarget(
    inventory,
    probeSerial,
    successfulConnection,
    target = null,
    platform = process.platform,
    arch = process.arch
) {
    if (platform !== "win32")
        return { error: selectionError("probe.driverSelectionNone", "J-Link drivers are only changed on Windows") };
    if (!inventory?.available)
        return { error: selectionError("probe.driverSelectionInventory", "USB inventory is unavailable") };
    if (target?.deviceId) {
        const device = inventory.devices.filter(
            (item) => item.family === "jlink" && item.id.toUpperCase() === String(target.deviceId).toUpperCase()
        );
        if (device.length !== 1)
            return {
                error: selectionError(
                    "probe.driverTargetMissing",
                    "The J-Link from the warning is no longer connected",
                    {
                        serial: target.probeSerial || ""
                    }
                )
            };
        return classified(
            inventory,
            { deviceId: device[0].id, probeSerial: target.probeSerial || device[0].serial || "" },
            platform,
            arch
        );
    }
    let selected;
    try {
        selected = resolveProbeConnection({ probe: "jlink.cfg", probeSerial, successfulConnection }, inventory);
    } catch (error) {
        const serial = error.details?.probeSerial || "";
        if (error.code === "PROBE_SELECTION_REQUIRED")
            return {
                error: selectionError(
                    "probe.driverSelectionMultiple",
                    "Several J-Links are connected; select one first"
                )
            };
        if (error.code === "PROBE_SELECTED_NOT_FOUND")
            return {
                error: selectionError(
                    error.details?.remembered
                        ? "probe.driverSelectionRememberedMissing"
                        : "probe.driverSelectionConfiguredMissing",
                    error.message,
                    { serial }
                )
            };
        return { error: selectionError("probe.driverSelectionRequired", error.message) };
    }
    if (!selected.deviceId)
        return { error: selectionError("probe.driverSelectionNone", "No connected J-Link was found") };
    return classified(inventory, selected, platform, arch);
}

function jlinkDriverChoice(
    inventory,
    probeSerial,
    successfulConnection,
    platform = process.platform,
    arch = process.arch
) {
    return resolveJlinkDriverTarget(inventory, probeSerial, successfulConnection, null, platform, arch).choice || null;
}

module.exports = { jlinkDriverChoice, resolveJlinkDriverTarget };
