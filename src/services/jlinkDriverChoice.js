"use strict";

const { resolveProbeConnection } = require("../../skills/_emberprobe/probe-connection");
const { classifyJlinkDriver } = require("./probeDriverService");

function jlinkDriverChoice(
    inventory,
    probeSerial,
    successfulConnection,
    platform = process.platform,
    arch = process.arch
) {
    if (platform !== "win32" || !inventory?.available) return null;
    let selected;
    try {
        selected = resolveProbeConnection({ probe: "jlink.cfg", probeSerial, successfulConnection }, inventory);
    } catch {
        return null;
    }
    const connection = {
        adapterFamily: "jlink",
        deviceId: selected.deviceId,
        probeSerial: selected.probeSerial,
        inventory
    };
    const state = classifyJlinkDriver(connection, platform, arch);
    if (state.kind === "repair") return { connection, driver: "segger", instanceId: state.instanceId };
    if (state.kind === "ready") return { connection, driver: "winusb", instanceId: state.instanceId };
    return null;
}

module.exports = { jlinkDriverChoice };
