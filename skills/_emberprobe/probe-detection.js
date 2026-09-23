"use strict";

function probeCandidates(inventory) {
    const text = String(inventory || "");
    return [
        [/st[- ]?link|stm32\s+stlink/i, "stlink.cfg"],
        [/j[- ]?link|segger/i, "jlink.cfg"],
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
const { listProbes } = require("./probe-inventory");

async function usbInventory() {
    if (process.platform === "win32") {
        try {
            const { stdout } = await execFileAsync(
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
            const { stdout } = await execFileAsync("pnputil.exe", ["/enum-devices", "/connected"], {
                timeout: 6000,
                windowsHide: true
            });
            return stdout || "";
        } catch {
            return "";
        }
    }
    try {
        /** @type {[string, string[]]} */
        const command = process.platform === "darwin" ? ["system_profiler", ["SPUSBDataType"]] : ["lsusb", []];
        return (await execFileAsync(command[0], command[1], { timeout: 6000 })).stdout;
    } catch {
        return "";
    }
}

async function detectProbe(dependencies = {}) {
    const [text, inventory] = await Promise.all([
        (dependencies.usbInventory || usbInventory)(),
        (dependencies.listProbes || listProbes)()
    ]);
    const candidates = probeCandidates(text);
    if (inventory.available && inventory.devices.length && !candidates.includes("jlink.cfg"))
        candidates.push("jlink.cfg");
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
