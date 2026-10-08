"use strict";

function probeCandidates(inventory) {
    const text = String(inventory || "");
    return [
        [/st[- ]?link|stm32\s+stlink/i, "stlink.cfg"],
        [/j[- ]?link/i, "jlink.cfg"],
        [/cmsis(?:[- _]?dap)|daplink|pico\s?probe|mcu[- ]?link/i, "cmsis-dap.cfg"],
        [/xds[- ]?110/i, "xds110.cfg"],
        [/nu[- ]?link/i, "nulink.cfg"]
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
const { listProbes, listLinuxUsbRows } = require("./probe-inventory");
const { listWindowsProbeRows } = require("./windows-probe-inventory");

async function usbInventory(options = {}) {
    const platform = options.platform || process.platform;
    const run = options.run || execFileAsync;
    if (platform === "win32") {
        if (!options.run || options.nativeList) {
            try {
                const rows = await (options.nativeList || listWindowsProbeRows)(() => true);
                return rows.map((row) => row.name).join("\n");
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
    try {
        /** @type {[string, string[]]} */
        const command = platform === "darwin" ? ["system_profiler", ["SPUSBDataType"]] : ["lsusb", []];
        return (await run(command[0], command[1], { timeout: 6000, maxBuffer: 2 * 1024 * 1024 })).stdout;
    } catch {
        return "";
    }
}

async function detectProbe(dependencies = {}) {
    const inventoryPromise = Promise.resolve((dependencies.listProbes || listProbes)({ family: "all" }));
    const names = () => (dependencies.usbInventory || usbInventory)();
    const [text, inventory] = await Promise.all([
        (dependencies.platform || process.platform) === "linux"
            ? inventoryPromise.then((result) =>
                  typeof result.discoveryText === "string" ? result.discoveryText : names()
              )
            : names(),
        inventoryPromise
    ]);
    const candidates = probeCandidates(text);
    if (inventory.available)
        for (const device of inventory.devices) {
            const probe = { jlink: "jlink.cfg", "cmsis-dap": "cmsis-dap.cfg", stlink: "stlink.cfg" }[device.family];
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
