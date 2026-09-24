"use strict";

const { connectionError } = require("./probe-connection");

// Keep this list aligned with OpenOCD's SEGGER J-Link entries in contrib/60-openocd.rules.
const JLINK_PIDS = new Set([
    "0101",
    "0102",
    "0103",
    "0104",
    "0105",
    "0107",
    "0108",
    "1010",
    "1011",
    "1012",
    "1013",
    "1014",
    "1015",
    "1016",
    "1017",
    "1018",
    "1020",
    "1051",
    "1055",
    "1061"
]);

function classifyJlinkDriver(connection, platform = process.platform, arch = process.arch) {
    if (connection.adapterFamily !== "jlink" || platform !== "win32") return { kind: "not-applicable" };
    if (arch !== "x64") return { kind: "unsupported", reason: "Windows architecture is not supported" };
    const inventory = connection.inventory;
    if (!inventory?.available || !connection.deviceId)
        return { kind: "unknown", reason: "Probe identity is unavailable" };
    const device = inventory.devices.filter((item) => item.id === connection.deviceId && item.family === "jlink");
    if (device.length !== 1) return { kind: "unknown", reason: "Probe identity is ambiguous" };
    const selected = device[0];
    if (selected.vid?.toLowerCase() !== "1366" || !JLINK_PIDS.has(selected.pid?.toLowerCase()))
        return { kind: "unsupported", reason: "J-Link USB product is not on the verified allowlist" };
    if (!/^USB\\VID_1366&PID_[0-9A-F]{4}\\[^\\]+$/i.test(selected.id))
        return { kind: "unknown", reason: "Physical USB parent cannot be verified" };
    if (/flasher|j[- ]?trace/i.test(selected.name)) return { kind: "unsupported", reason: "Device is not a J-Link" };
    const interfaces = selected.interfaces || [];
    const root = interfaces.filter((item) => item.instanceId.toUpperCase() === selected.id.toUpperCase());
    const children = interfaces.filter((item) => /&MI_[0-9A-F]{2}/i.test(item.instanceId));
    const composite = children.length > 0;
    if (
        children.some(
            (item) => !new RegExp(`^USB\\\\VID_1366&PID_${selected.pid}&MI_[0-9A-F]{2}\\\\`, "i").test(item.instanceId)
        )
    )
        return { kind: "unknown", reason: "Composite interface does not match the selected parent" };
    if (composite && (root.length !== 1 || !/^usbccgp$/i.test(root[0].service || "")))
        return { kind: "unknown", reason: "Composite USB parent is not recognized" };
    const candidates = composite ? children : root;
    const debug = candidates.filter((item) => /^(?:winusb|jlink)$/i.test(item.service || ""));
    if (debug.length !== 1 || /flasher|j[- ]?trace|vcom|serial/i.test(debug[0].name))
        return { kind: "unknown", reason: "Debug interface cannot be identified uniquely" };
    const target = debug[0];
    if (/^winusb$/i.test(target.service)) return { kind: "ready", instanceId: target.instanceId };
    if (
        /^jlink$/i.test(target.service) &&
        /^segger\b/i.test(target.driverProvider || "") &&
        /^oem\d+\.inf$/i.test(target.driverInf || "")
    )
        return { kind: "repair", instanceId: target.instanceId, driverInf: target.driverInf };
    return { kind: "unknown", reason: "Driver provider or original INF cannot be verified" };
}

function requireJlinkWinUsb(connection, platform = process.platform, arch = process.arch) {
    const state = classifyJlinkDriver(connection, platform, arch);
    const selected = connection.inventory?.devices?.filter(
        (device) => device.id === connection.deviceId && device.family === "jlink"
    );
    const seggerBound =
        platform === "win32" &&
        connection.adapterFamily === "jlink" &&
        selected?.length === 1 &&
        selected[0].interfaces?.some((item) => /^jlink$/i.test(item.service || ""));
    if (state.kind === "repair" || seggerBound)
        throw Object.assign(
            connectionError(
                "PROBE_DRIVER_UNSUPPORTED",
                "The selected J-Link uses the SEGGER USB driver. EmberProbe requires WinUSB; change the driver before starting.",
                {
                    instanceId: state.instanceId || connection.deviceId,
                    currentDriver: "SEGGER",
                    requiredDriver: "WinUSB"
                }
            ),
            { i18nKey: "probe.driverUnsupported" }
        );
    return connection;
}

module.exports = { JLINK_PIDS, classifyJlinkDriver, requireJlinkWinUsb };
