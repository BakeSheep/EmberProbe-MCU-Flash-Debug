"use strict";

function probeCandidates(inventory) {
    const text = String(inventory || "");
    // Windows fallbacks list every present device, so names must start at a word
    // boundary ("Host Link" is not an ST-LINK, "Menu Link" is not a Nu-Link).
    return [
        [/\bst[- ]?link/i, "stlink.cfg"],
        [/\bj[- ]?link/i, "jlink.cfg"],
        [/\bcmsis(?:[- _]?dap)|\bdaplink|\bpico\s?probe|\bmcu[- ]?link/i, "cmsis-dap.cfg"],
        [/\bxds[- ]?110/i, "xds110.cfg"],
        [/\bnu[- ]?link/i, "nulink.cfg"]
    ]
        .filter(([pattern]) => /** @type {RegExp} */ (pattern).test(text))
        .map(([, name]) => String(name));
}

function probeFromText(text) {
    const candidates = probeCandidates(text);
    return candidates.length === 1 ? candidates[0] : "";
}

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { listProbes, listLinuxUsbRows, MAC_USB_DATA_TYPES } = require("./probe-inventory");
const { listWindowsProbeRows } = require("./windows-probe-inventory");

async function usbInventory(options = {}) {
    const platform = options.platform || process.platform;
    const run = options.run || execFileAsync;
    if (platform === "win32") {
        if (!options.run || options.nativeList) {
            try {
                const rows = await (options.nativeList || listWindowsProbeRows)(() => true);
                return rows.flatMap((row) => [row.name, row.reportedName || ""]).join("\n");
            } catch {
                // Standalone skills without the packaged native runtime retain OS-tool fallback.
            }
        }
        try {
            const { stdout } = await run(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Get-PnpDevice -PresentOnly | Select-Object -ExpandProperty FriendlyName"
                ],
                { timeout: 6000, windowsHide: true }
            );
            if (stdout && stdout.trim()) return stdout;
        } catch {
            /* Get-PnpDevice may be unavailable or access-denied for non-admin VS Code. */
        }
        try {
            // pnputil is available on supported Windows releases and can enumerate connected
            // devices without importing the PnpDevice PowerShell module. Include every class:
            // CMSIS-DAP v2 commonly appears as HID/WinUSB rather than the USB device class.
            const { stdout } = await run("pnputil.exe", ["/enum-devices", "/connected"], {
                timeout: 6000,
                windowsHide: true
            });
            return stdout || "";
        } catch {
            return "";
        }
    }
    if (platform === "linux") {
        try {
            const rows = await listLinuxUsbRows(options);
            return rows.flatMap((row) => [row.name, ...row.interfaces.map((child) => child.name)]).join("\n");
        } catch {
            // Keep discovery of other adapters when sysfs is unavailable; preflight checks identity separately.
        }
    }
    if (platform === "darwin") {
        // macOS 26 renamed the USB data type: `SPUSBDataType` exits 0 with empty output.
        for (const dataType of MAC_USB_DATA_TYPES) {
            try {
                const { stdout } = await run("system_profiler", [dataType], {
                    timeout: 6000,
                    maxBuffer: 2 * 1024 * 1024
                });
                if (String(stdout || "").trim()) return stdout;
            } catch {
                // The renamed data type does not exist before macOS 26; try the next one.
            }
        }
        return "";
    }
    try {
        return (await run("lsusb", [], { timeout: 6000, maxBuffer: 2 * 1024 * 1024 })).stdout;
    } catch {
        return "";
    }
}

async function detectProbe(dependencies = {}) {
    const inventoryPromise = Promise.resolve((dependencies.listProbes || listProbes)({ family: "all" }));
    const names = () => (dependencies.usbInventory || usbInventory)();
    // Linux and macOS inventories carry USB names; other platforms enumerate names concurrently.
    const namesPromise = ["linux", "darwin"].includes(dependencies.platform || process.platform) ? null : names();
    const inventory = await inventoryPromise;
    const text =
        typeof inventory.discoveryText === "string" ? inventory.discoveryText : await (namesPromise || names());
    const candidates = probeCandidates(text);
    if (inventory.available)
        for (const device of inventory.devices) {
            const probe = {
                jlink: "jlink.cfg",
                "cmsis-dap": "cmsis-dap.cfg",
                stlink: "stlink.cfg",
                xds110: "xds110.cfg",
                nulink: "nulink.cfg"
            }[device.family];
            if (probe && !candidates.includes(probe)) candidates.push(probe);
        }
    return {
        probe: candidates.length === 1 ? candidates[0] : "",
        candidates,
        notes: [
            ...inventory.notes,
            ...(!text.trim() ? ["USB name enumeration unavailable; using structured inventory."] : [])
        ]
    };
}
module.exports = { probeCandidates, probeFromText, usbInventory, detectProbe };
