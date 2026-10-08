"use strict";
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { normalizeProbeSerial } = require("./probe-connection");

// Only OS metadata is read. No SEGGER tool, OpenOCD init or driver installer is invoked.
const WINDOWS_INVENTORY = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
@($keys = @('DEVPKEY_Device_Parent', 'DEVPKEY_Device_ContainerId', 'DEVPKEY_Device_Service',
 'DEVPKEY_Device_DriverProvider', 'DEVPKEY_Device_DriverInfPath');
 Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.InstanceId -like 'USB\\VID_1366*' } | ForEach-Object {
 $d = $_; $p = @{};
 Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName $keys -ErrorAction SilentlyContinue | ForEach-Object { $p[$_.KeyName] = $_.Data };
 [pscustomobject]@{ instanceId=$d.InstanceId; name=$d.FriendlyName; parentId=$p['DEVPKEY_Device_Parent']; containerId=[string]$p['DEVPKEY_Device_ContainerId']; service=$p['DEVPKEY_Device_Service']; driverProvider=$p['DEVPKEY_Device_DriverProvider']; driverInf=$p['DEVPKEY_Device_DriverInfPath'] }
}) | ConvertTo-Json -Depth 4 -Compress`;
const USB_INVENTORY = WINDOWS_INVENTORY.replace(
    "$_.InstanceId -like 'USB\\VID_1366*'",
    "$_.InstanceId -match '^(USB|HID)\\\\VID_'"
);
function windowsHelperPath(moduleDir = __dirname) {
    // esbuild places the extension's bundled modules in dist/; unbundled Agent Skills
    // still run from skills/_emberprobe/. Both layouts share the extension resources/.
    const resources = path.basename(moduleDir) === "dist" ? "../resources" : "../../resources";
    return path.resolve(moduleDir, resources, "driver-helper/win32-x64/emberprobe-driver-helper.exe");
}
const WINDOWS_HELPER = windowsHelperPath();

function serialOrUnknown(value, family = "jlink") {
    try {
        return normalizeProbeSerial(value || "", family);
    } catch {
        return "";
    }
}

function deviceRecord(values) {
    return { family: "jlink", name: "SEGGER USB device", serial: "", vid: "1366", pid: "", interfaces: [], ...values };
}

function usbFamily(vid, pid, name) {
    if (vid === "1366" && !/flasher|j[- ]?trace/i.test(name)) return "jlink";
    if (/cmsis[- _]?dap|daplink|mcu[- ]?link|picoprobe/i.test(name) || (vid === "0d28" && pid === "0204"))
        return "cmsis-dap";
    if (/st[- ]?link/i.test(name) || (vid === "0483" && /^(374[8bef]|375[234])$/.test(pid))) return "stlink";
    return "";
}

function parseWindowsInventory(text, family = "jlink") {
    const parsed = JSON.parse(String(text || "[]").replace(/^\uFEFF/, ""));
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const roots = new Map(
        rows
            .filter((row) => row.containerId && /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\/i.test(row.instanceId || ""))
            .map((row) => [row.containerId, row.instanceId])
    );
    const groups = new Map();
    for (const row of rows) {
        const id = String(row.instanceId || "");
        const usbId = id.match(/^(?:USB|HID)\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
        if (!usbId || (family === "jlink" && usbId[1].toLowerCase() !== "1366")) continue;
        const parent = String(row.parentId || "");
        let physicalId = String(
            roots.get(row.containerId) ||
                (/&MI_[0-9a-f]{2}/i.test(id) || /^HID\\/i.test(id)
                    ? /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\/i.test(parent)
                        ? parent
                        : row.containerId || id
                    : id)
        );
        if (usbId[1].toLowerCase() === "1366") physicalId = physicalId.toUpperCase();
        const group =
            groups.get(physicalId) ||
            deviceRecord({ id: physicalId, vid: usbId[1].toLowerCase(), pid: usbId[2].toLowerCase(), family: "" });
        const classified = usbFamily(group.vid, group.pid, row.name || "");
        if (classified) group.family = classified;
        if (row.name && /j[- ]?link/i.test(row.name)) group.name = row.name;
        if (row.name && /cmsis|daplink|st[- ]?link/i.test(row.name)) group.name = row.name;
        const serialId =
            roots.get(row.containerId) || (/^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\[^&\\]+$/i.test(id) ? id : parent);
        const serial = /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\[^&\\]+$/i.test(serialId)
            ? serialOrUnknown(serialId.split("\\").pop(), group.family)
            : "";
        if (serial) group.serial = serial;
        group.interfaces.push({
            instanceId: id,
            name: row.name || "",
            interfaceNumber: id.match(/&MI_([0-9A-F]{2})/i)?.[1] || "",
            service: row.service || "",
            driverProvider: row.driverProvider || "",
            driverInf: row.driverInf || ""
        });
        groups.set(physicalId, group);
    }
    return [...groups.values()].filter(
        (device) =>
            device.family &&
            (family === "all" || device.family === family) &&
            !device.interfaces.every((item) => /flasher|j[- ]?trace/i.test(item.name))
    );
}

function parseMacInventory(text, family = "jlink") {
    const devices = [];
    const visit = (value) => {
        if (!value || typeof value !== "object") return;
        const vid =
            String(value.vendor_id || "")
                .match(/0x([0-9a-f]{4})/i)?.[1]
                ?.toLowerCase() || "";
        const pid =
            String(value.product_id || "")
                .match(/0x([0-9a-f]{4})/i)?.[1]
                ?.toLowerCase() || "";
        const classified = usbFamily(vid, pid, value._name || "");
        if (classified && (family === "all" || family === classified)) {
            devices.push(
                deviceRecord({
                    id: String(value.location_id || `usb-${devices.length}`),
                    name: value._name || "SEGGER USB device",
                    vid,
                    pid,
                    family: classified,
                    serial: serialOrUnknown(value.serial_num, classified)
                })
            );
        }
        for (const child of Object.values(value))
            if (child && typeof child === "object") {
                if (Array.isArray(child)) child.forEach(visit);
                else visit(child);
            }
    };
    visit(JSON.parse(text));
    return devices;
}

function runInventory(command, args) {
    return new Promise((resolve, reject) =>
        execFile(
            command,
            args,
            { timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true },
            (error, stdout) => (error ? reject(error) : resolve(stdout))
        )
    );
}

async function listProbes(options = {}) {
    const platform = options.platform || process.platform;
    const family = options.family || "jlink";
    const run = options.run || runInventory;
    try {
        let devices;
        if (platform === "win32") {
            if (family === "jlink" && (!options.run || options.fastRun)) {
                try {
                    if (!options.fastRun) await fs.access(WINDOWS_HELPER);
                    devices = parseWindowsInventory(await (options.fastRun || runInventory)(WINDOWS_HELPER, ["list"]));
                } catch {
                    // Older development helpers have no list action; keep the PowerShell fallback.
                }
            }
            if (!devices)
                devices = parseWindowsInventory(
                    await run("powershell.exe", [
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        family === "jlink" ? WINDOWS_INVENTORY : USB_INVENTORY
                    ]),
                    family
                );
        } else if (platform === "darwin")
            devices = parseMacInventory(await run("system_profiler", ["SPUSBDataType", "-json"]), family);
        else if (platform === "linux") {
            devices = [];
            const root = options.sysfsRoot || "/sys/bus/usb/devices";
            const read = options.readFile || fs.readFile;
            const entries = await (options.readdir || fs.readdir)(root);
            for (const name of entries.filter((entry) => /^\d+-[\d.]+$/.test(entry))) {
                const value = async (file) => String(await read(path.join(root, name, file), "utf8")).trim();
                let vendor;
                try {
                    vendor = await value("idVendor");
                } catch {
                    continue;
                }
                const optional = async (file) => {
                    try {
                        return await value(file);
                    } catch {
                        return "";
                    }
                };
                const product = await optional("product");
                const pid = await optional("idProduct");
                const classified = usbFamily(vendor.toLowerCase(), pid.toLowerCase(), product);
                if (!classified || (family !== "all" && classified !== family)) continue;
                devices.push(
                    deviceRecord({
                        id: name,
                        name: product || "SEGGER USB device",
                        vid: vendor.toLowerCase(),
                        pid: pid.toLowerCase(),
                        family: classified,
                        serial: serialOrUnknown(await optional("serial"), classified)
                    })
                );
            }
        } else throw new Error("USB inventory is unavailable on this platform");
        return { available: true, platform, devices, notes: [] };
    } catch (error) {
        return {
            available: false,
            platform,
            devices: [],
            notes: [`USB inventory unavailable: ${String(error.message).slice(0, 300)}`]
        };
    }
}

module.exports = {
    listProbes,
    parseWindowsInventory,
    parseMacInventory,
    windowsHelperPath,
    WINDOWS_INVENTORY,
    USB_INVENTORY
};
