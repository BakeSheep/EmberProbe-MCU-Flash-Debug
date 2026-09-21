"use strict";
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { normalizeProbeSerial } = require("./probe-connection");

// Only OS metadata is read. No SEGGER tool, OpenOCD init or driver installer is invoked.
const WINDOWS_INVENTORY = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
@(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.InstanceId -like 'USB\\VID_1366*' } | ForEach-Object {
 $d = $_; $p = @{};
 Get-PnpDeviceProperty -InstanceId $d.InstanceId -ErrorAction SilentlyContinue | ForEach-Object { $p[$_.KeyName] = $_.Data };
 [pscustomobject]@{ instanceId=$d.InstanceId; name=$d.FriendlyName; parentId=$p['DEVPKEY_Device_Parent']; containerId=[string]$p['DEVPKEY_Device_ContainerId']; service=$p['DEVPKEY_Device_Service']; driverProvider=$p['DEVPKEY_Device_DriverProvider']; driverInf=$p['DEVPKEY_Device_DriverInfPath'] }
}) | ConvertTo-Json -Depth 4 -Compress`;

function serialOrUnknown(value) {
    try {
        return normalizeProbeSerial(value || "");
    } catch {
        return "";
    }
}

function deviceRecord(values) {
    return { family: "jlink", name: "SEGGER USB device", serial: "", vid: "1366", pid: "", interfaces: [], ...values };
}

function parseWindowsInventory(text) {
    const parsed = JSON.parse(String(text || "[]").replace(/^\uFEFF/, ""));
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const groups = new Map();
    for (const row of rows) {
        const id = String(row.instanceId || "");
        if (!/^USB\\VID_1366&PID_[0-9A-F]{4}/i.test(id)) continue;
        const parent = String(row.parentId || "");
        const physicalId = String(
            /&MI_[0-9a-f]{2}/i.test(id)
                ? /^USB\\VID_1366&PID_[0-9A-F]{4}\\/i.test(parent)
                    ? parent
                    : row.containerId || id
                : id
        ).toUpperCase();
        const group =
            groups.get(physicalId) ||
            deviceRecord({ id: physicalId, pid: id.match(/PID_([0-9A-F]{4})/i)[1].toLowerCase() });
        if (row.name && /j[- ]?link/i.test(row.name)) group.name = row.name;
        const serial = serialOrUnknown(String(physicalId).split("\\").pop());
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
        (device) => !device.interfaces.every((item) => /flasher|j[- ]?trace/i.test(item.name))
    );
}

function parseMacInventory(text) {
    const devices = [];
    const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (/0x1366/i.test(String(value.vendor_id || "")) && !/flasher|j[- ]?trace/i.test(value._name || "")) {
            devices.push(
                deviceRecord({
                    id: String(value.location_id || `usb-${devices.length}`),
                    name: value._name || "SEGGER USB device",
                    pid:
                        String(value.product_id || "")
                            .match(/0x([0-9a-f]{4})/i)?.[1]
                            ?.toLowerCase() || "",
                    serial: serialOrUnknown(value.serial_num)
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
    const run = options.run || runInventory;
    try {
        let devices;
        if (platform === "win32")
            devices = parseWindowsInventory(
                await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_INVENTORY])
            );
        else if (platform === "darwin")
            devices = parseMacInventory(await run("system_profiler", ["SPUSBDataType", "-json"]));
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
                if (vendor.toLowerCase() !== "1366") continue;
                const optional = async (file) => {
                    try {
                        return await value(file);
                    } catch {
                        return "";
                    }
                };
                const product = await optional("product");
                if (/flasher|j[- ]?trace/i.test(product)) continue;
                devices.push(
                    deviceRecord({
                        id: name,
                        name: product || "SEGGER USB device",
                        pid: await optional("idProduct"),
                        serial: serialOrUnknown(await optional("serial"))
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

module.exports = { listProbes, parseWindowsInventory, parseMacInventory, WINDOWS_INVENTORY };
