"use strict";
const fs = require("fs/promises");
const { execFile } = require("child_process");
const { resolveOpenOcdLaunch } = require("./openocd-launch");
const { listProbes } = require("./probe-inventory");
const { resolveProbeConnection, connectionError } = require("./probe-connection");
const { requireJlinkWinUsb } = require("./jlink-driver");
const { connectionFingerprint } = require("./connection-fingerprint");

const capabilitiesCache = new Map();
function query(executable, args, cwd = undefined) {
    return new Promise((resolve, reject) =>
        execFile(
            executable,
            args,
            { timeout: 5000, maxBuffer: 256 * 1024, windowsHide: true, cwd },
            (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}\n${stderr}`))
        )
    );
}

function parseAdapterList(output) {
    const marker = String(output).match(/^EP_ADAPTERS_BEGIN\s*([\s\S]*?)^EP_ADAPTERS_END\s*$/m);
    if (!marker) return null;
    const body = marker[1].trim();
    if (!body) return [];
    if (body.includes("{")) return [...body.matchAll(/([\w-]+)\s*\{[^}]*\}/g)].map((match) => match[1]);
    return /^[\w\s-]+$/.test(body) ? body.split(/\s+/) : null;
}

async function checkAdapterCapability(launch, options = {}) {
    const readFile = options.readFile || fs.readFile;
    const run = options.run || query;
    const stat = await (options.stat || fs.stat)(launch.executable);
    const key = `${launch.executable}:${stat.mtimeMs}:${stat.size}`;
    let drivers = capabilitiesCache.get(key);
    if (!drivers) {
        let output;
        try {
            output = await run(launch.executable, [
                "-c",
                "noinit",
                "-c",
                "echo EP_ADAPTERS_BEGIN",
                "-c",
                "adapter list",
                "-c",
                "echo EP_ADAPTERS_END",
                "-c",
                "shutdown"
            ]);
        } catch (cause) {
            throw connectionError(
                "PROBE_CAPABILITY_UNKNOWN",
                "Unable to inspect OpenOCD adapter capabilities without initialization",
                { cause: cause.message }
            );
        }
        drivers = parseAdapterList(output);
        if (!drivers)
            throw connectionError("PROBE_CAPABILITY_UNKNOWN", "OpenOCD returned an unrecognized adapter list");
        if (!options.run) {
            if (capabilitiesCache.size >= 8) capabilitiesCache.clear();
            capabilitiesCache.set(key, drivers);
        }
    }
    const script = await readFile(launch.probePath, "utf8");
    const direct = String(script).match(/^\s*adapter\s+driver\s+([\w-]+)\s*(?:#.*)?$/m);
    let adapterFamily = direct?.[1];
    if (adapterFamily && !drivers.includes(adapterFamily))
        throw connectionError(
            "PROBE_DRIVER_MISSING",
            `This OpenOCD build does not include the ${adapterFamily} adapter`,
            { adapterFamily, drivers }
        );
    try {
        // Custom trusted interface scripts can source another script. Do not load a target or call init.
        const output = await run(
            launch.executable,
            [
                "-s",
                launch.scriptsRoot,
                "-c",
                "noinit",
                "-f",
                launch.probePath,
                "-c",
                "echo EP_ADAPTER_NAME=[adapter name]",
                "-c",
                "shutdown"
            ],
            launch.scriptsRoot
        );
        adapterFamily = String(output).match(/^EP_ADAPTER_NAME=([\w-]+)\s*$/m)?.[1];
    } catch (cause) {
        throw connectionError(
            "PROBE_CAPABILITY_UNKNOWN",
            "Unable to resolve the interface adapter without initialization",
            { cause: cause.message }
        );
    }
    if (!adapterFamily)
        throw connectionError("PROBE_CAPABILITY_UNKNOWN", "Cannot determine the selected interface adapter");
    if (!drivers.includes(adapterFamily))
        throw connectionError(
            "PROBE_DRIVER_MISSING",
            `This OpenOCD build does not include the ${adapterFamily} adapter`,
            { adapterFamily, drivers }
        );
    return { adapterFamily, drivers };
}

async function prepareProbeConnection(options, dependencies = {}) {
    const launch = (dependencies.resolveLaunch || resolveOpenOcdLaunch)(
        options.executable || options.openocd,
        options.probe,
        options.target,
        options.transport
    );
    const capability = await (dependencies.checkCapability || checkAdapterCapability)(launch);
    const inventory =
        capability.adapterFamily === "jlink"
            ? await (dependencies.listProbes || listProbes)()
            : { available: false, devices: [], notes: [] };
    let fingerprint = "";
    if (capability.adapterFamily === "jlink") {
        try {
            fingerprint = await (dependencies.fingerprint || connectionFingerprint)(launch);
        } catch {
            inventory.notes.push("Connection fingerprint unavailable; protocol history will not be reused.");
        }
    }
    const connection = resolveProbeConnection(
        { ...options, fingerprint, adapterFamily: capability.adapterFamily },
        inventory
    );
    if (capability.adapterFamily === "jlink")
        requireJlinkWinUsb(
            { ...connection, adapterFamily: capability.adapterFamily, inventory },
            dependencies.platform || process.platform,
            dependencies.arch || process.arch
        );
    if (capability.adapterFamily === "jlink")
        connection.transport = await (dependencies.resolveTransport || resolveInterfaceTransport)(
            launch,
            connection.transport
        );
    if (capability.adapterFamily !== "jlink") connection.probeSerial = "";
    return {
        ...connection,
        fingerprint,
        openocd: launch.executable,
        adapterFamily: capability.adapterFamily,
        launch,
        inventory
    };
}

async function resolveInterfaceTransport(launch, transport, run = query) {
    if (!["auto", "swd", "jtag"].includes(transport))
        throw connectionError("OPENOCD_TRANSPORT_INVALID", "J-Link requires an SWD or JTAG transport");
    let output;
    try {
        output = await run(
            launch.executable,
            [
                "-s",
                launch.scriptsRoot,
                "-c",
                "noinit",
                "-f",
                launch.probePath,
                ...(transport === "auto" ? [] : ["-c", `transport select ${transport}`]),
                "-c",
                "echo EP_TRANSPORT=[transport select]",
                "-c",
                "shutdown"
            ],
            launch.scriptsRoot
        );
    } catch (cause) {
        throw connectionError(
            "OPENOCD_TRANSPORT_INVALID",
            "The interface script cannot select the requested transport",
            { transport, cause: cause.message }
        );
    }
    const selected = String(output).match(/^EP_TRANSPORT=(swd|jtag)\s*$/m)?.[1];
    if (!selected || (transport !== "auto" && selected !== transport))
        throw connectionError(
            "PROBE_CAPABILITY_UNKNOWN",
            "Cannot confirm the interface transport without initialization"
        );
    return selected;
}

module.exports = { prepareProbeConnection, checkAdapterCapability, parseAdapterList, resolveInterfaceTransport };
