"use strict";
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { normalizeProbeSerial } = require("./probe-connection");
const { listWindowsProbeRows } = require("./windows-probe-inventory");

// Only OS metadata is read. No SEGGER tool, OpenOCD init or driver installer is invoked.
const WINDOWS_INVENTORY = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$keys = @('DEVPKEY_Device_Parent', 'DEVPKEY_Device_ContainerId', 'DEVPKEY_Device_Service',
 'DEVPKEY_Device_DriverProvider', 'DEVPKEY_Device_DriverInfPath');
$devices = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.InstanceId -like 'USB\\VID_1366*' });
$properties = @{};
if ($devices.Count) {
 Get-PnpDeviceProperty -InstanceId $devices.InstanceId -KeyName $keys -ErrorAction SilentlyContinue | ForEach-Object {
  if (!$properties.ContainsKey($_.InstanceId)) { $properties[$_.InstanceId] = @{} };
  $properties[$_.InstanceId][$_.KeyName] = $_.Data
 }
};
@($devices | ForEach-Object {
 $d = $_; $p = $properties[$d.InstanceId]; if (!$p) { $p = @{} };
 if (!$p['DEVPKEY_Device_Parent']) {
  Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName @('DEVPKEY_Device_Parent', 'DEVPKEY_Device_ContainerId') -ErrorAction SilentlyContinue | ForEach-Object { $p[$_.KeyName] = $_.Data }
 };
 [pscustomobject]@{ instanceId=$d.InstanceId; name=$d.FriendlyName; parentId=$p['DEVPKEY_Device_Parent']; containerId=[string]$p['DEVPKEY_Device_ContainerId']; service=$p['DEVPKEY_Device_Service']; driverProvider=$p['DEVPKEY_Device_DriverProvider']; driverInf=$p['DEVPKEY_Device_DriverInfPath'] }
}) | ConvertTo-Json -Depth 4 -Compress`;
const USB_INVENTORY = WINDOWS_INVENTORY.replace(
    "$_.InstanceId -like 'USB\\VID_1366*'",
    "$_.InstanceId -match '^(USB|HID)\\\\VID_'"
).replace(
    "$properties = @{};",
    // Keep every interface/root of matching VID/PID pairs, including unnamed composite parents.
    // Querying properties for keyboards, mice and cameras can exhaust the bounded query budget.
    `$prefixes = @{};
foreach ($d in $devices) {
 if ($d.InstanceId -match '^(USB|HID)\\\\VID_(1366&PID_[0-9A-F]{4}|0D28&PID_0204|C251&PID_(F001|F002|2722|2750)|0483&PID_(374[48BDEF]|375[23457]))' -or $d.FriendlyName -match 'j[- ]?link|cmsis[- _]?dap|daplink|mcu[- ]?link|picoprobe|st[- ]?link') {
  if ($d.InstanceId -match '^(USB|HID)\\\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})') { $prefixes[$Matches[2]] = $true }
 }
};
$devices = @($devices | Where-Object { $_.InstanceId -match '^(USB|HID)\\\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})' -and $prefixes.ContainsKey($Matches[2]) });
$properties = @{};`
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
    return { family: "jlink", name: "USB debug probe", serial: "", vid: "1366", pid: "", interfaces: [], ...values };
}

function usbFamily(vid, pid, name) {
    if (vid === "1366" && !/flasher|j[- ]?trace/i.test(name)) return "jlink";
    if (vid === "0483" && /^(374[48bdef]|375[23457])$/.test(pid)) return "stlink";
    // OpenOCD's known CMSIS-DAP IDs also identify devices whose Windows names are generic USB/HID.
    if (
        /cmsis[- _]?dap|daplink|mcu[- ]?link|picoprobe/i.test(name) ||
        (vid === "0d28" && pid === "0204") ||
        (vid === "c251" && ["f001", "f002", "2722", "2750"].includes(pid))
    )
        return "cmsis-dap";
    if (/st[- ]?link/i.test(name)) return "stlink";
    return "";
}

function linuxSerial(value, family, vid) {
    // sysfs appends one newline. Keep all UID bytes until the legacy ST-Link conversion is decided.
    const raw = String(value).replace(/\n$/, "");
    if (
        family === "stlink" &&
        vid === "0483" &&
        raw.length === 12 &&
        !/^[A-Za-z0-9_.:-]+$/.test(raw) &&
        [...raw].every((char) => char.charCodeAt(0) <= 255)
    ) {
        // Old ST-Link/V2 DFU exposes twelve byte-valued UTF-16 code points.
        // Match OpenOCD's stlink_usb_get_alternate_serial without widening user-input validation.
        return Buffer.from([...raw].map((char) => char.charCodeAt(0)))
            .toString("hex")
            .toUpperCase();
    }
    return serialOrUnknown(raw, family);
}

async function listLinuxUsbRows(options = {}) {
    const root = options.sysfsRoot || "/sys/bus/usb/devices";
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 2000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error("Invalid USB query budget");
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Linux USB metadata query timed out"));
        }, timeoutMs);
    });
    const enumerate = async () => {
        const entries = await (options.readdir || fs.readdir)(root);
        if (entries.length > 4096) throw new Error("Linux USB inventory exceeds its device budget");
        const devices = entries.filter((name) => /^\d+-\d+(?:\.\d+)*$/.test(name));
        const interfaces = new Map();
        for (const name of entries) {
            const match = name.match(/^(\d+-\d+(?:\.\d+)*):\d+\.(\d+)$/);
            if (!match) continue;
            const list = interfaces.get(match[1]) || [];
            list.push({ id: name, interfaceNumber: match[2] });
            interfaces.set(match[1], list);
        }
        const value = async (name, file) => {
            controller.signal.throwIfAborted();
            try {
                const filename = path.join(root, name, file);
                const text = String(
                    await (options.readFile
                        ? options.readFile(filename, "utf8")
                        : fs.readFile(filename, { encoding: "utf8", signal: controller.signal }))
                );
                if (Buffer.byteLength(text, "utf8") > 8192) throw new Error("USB property exceeds its byte budget");
                return text;
            } catch (error) {
                // An absent optional attribute or a device removed during enumeration is ordinary.
                // Permission/I/O failures must not masquerade as a successful empty inventory.
                if (["ENOENT", "ENODEV"].includes(error.code)) return "";
                throw new Error(`Linux USB metadata ${name}/${file}: ${error.code || error.message}`);
            }
        };
        const rows = new Array(devices.length);
        let next = 0;
        const worker = async () => {
            while (next < devices.length) {
                const index = next++;
                const id = devices[index];
                const [vendor, productId, product] = await Promise.all([
                    value(id, "idVendor"),
                    value(id, "idProduct"),
                    value(id, "product")
                ]);
                const vid = vendor.trim().toLowerCase();
                const pid = productId.trim().toLowerCase();
                if (!vid || !pid) continue;
                if (!/^[0-9a-f]{4}$/.test(vid) || !/^[0-9a-f]{4}$/.test(pid))
                    throw new Error("Invalid USB VID/PID metadata");
                const children = [];
                for (const child of interfaces.get(id) || []) {
                    const name = (await value(child.id, "interface")).trim();
                    if (name) children.push({ instanceId: child.id, name, interfaceNumber: child.interfaceNumber });
                }
                const name = product.trim();
                const family = usbFamily(vid, pid, [name, ...children.map((child) => child.name)].join("\n"));
                rows[index] = {
                    id,
                    name,
                    vid,
                    pid,
                    family,
                    interfaces: children,
                    serial: family ? linuxSerial(await value(id, "serial"), family, vid) : ""
                };
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, devices.length) }, worker));
        return rows.filter(Boolean);
    };
    try {
        return await Promise.race([enumerate(), timeout]);
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

function parseWindowsInventory(text, family = "jlink") {
    const parsed = JSON.parse(String(text || "[]").replace(/^\uFEFF/, ""));
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const roots = new Map(
        rows
            .filter((row) => row.containerId && /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\/i.test(row.instanceId || ""))
            .map((row) => [row.containerId, row.instanceId])
    );
    const rowsById = new Map(rows.map((row) => [String(row.instanceId || "").toUpperCase(), row]));
    const physicalRoot = (row) => {
        let current = row;
        const visited = new Set();
        for (let depth = 0; current && depth < 16; depth++) {
            const id = String(current.instanceId || "");
            if (/^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\/i.test(id)) return id;
            if (visited.has(id.toUpperCase())) break;
            visited.add(id.toUpperCase());
            const parent = String(current.parentId || "");
            if (/^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\/i.test(parent))
                return rowsById.get(parent.toUpperCase())?.instanceId || parent;
            current = rowsById.get(parent.toUpperCase());
        }
        return roots.get(row.containerId) || row.containerId || row.instanceId;
    };
    const groups = new Map();
    for (const row of rows) {
        const id = String(row.instanceId || "");
        const usbId = id.match(/^(?:USB|HID)\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
        if (!usbId || (family === "jlink" && usbId[1].toLowerCase() !== "1366")) continue;
        let physicalId = String(physicalRoot(row));
        if (usbId[1].toLowerCase() === "1366") physicalId = physicalId.toUpperCase();
        const groupKey = physicalId.toUpperCase();
        const group =
            groups.get(groupKey) ||
            deviceRecord({ id: physicalId, vid: usbId[1].toLowerCase(), pid: usbId[2].toLowerCase(), family: "" });
        const classified = usbFamily(group.vid, group.pid, row.name || "");
        if (classified) group.family = classified;
        if (row.name && /j[- ]?link/i.test(row.name)) group.name = row.name;
        if (row.name && /cmsis|daplink|st[- ]?link/i.test(row.name)) group.name = row.name;
        const serialId = physicalId;
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
        groups.set(groupKey, group);
    }
    return [...groups.values()].filter(
        (device) =>
            device.family &&
            (family === "all" || device.family === family) &&
            !device.interfaces.some((item) => /flasher|j[- ]?trace/i.test(item.name))
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
                    name: value._name || "USB debug probe",
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
            // A cold Windows PnP provider can take over ten seconds even for one composite probe.
            { timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true },
            (error, stdout, stderr) => {
                if (error) {
                    const reason = error.killed
                        ? "query timed out"
                        : String(stderr || error.code || "query failed").trim();
                    reject(new Error(`USB metadata query failed: ${reason.slice(0, 300)}`));
                } else resolve(stdout);
            }
        ).stdin?.end()
    );
}

async function listProbes(options = {}) {
    const platform = options.platform || process.platform;
    const family = options.family || "jlink";
    const run = options.run || runInventory;
    try {
        let devices;
        let discoveryText;
        if (platform === "win32") {
            if (family === "jlink" && (!options.run || options.fastRun)) {
                try {
                    if (!options.fastRun) await fs.access(WINDOWS_HELPER);
                    devices = parseWindowsInventory(await (options.fastRun || runInventory)(WINDOWS_HELPER, ["list"]));
                } catch {
                    // Older development helpers have no list action; keep the PowerShell fallback.
                }
            }
            if (!devices && (!options.run || options.nativeList)) {
                try {
                    devices = parseWindowsInventory(
                        JSON.stringify(await (options.nativeList || listWindowsProbeRows)(usbFamily)),
                        family
                    );
                } catch {
                    // Missing native runtime or a changing device list retains the bounded OS-query fallback.
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
            const rows = await listLinuxUsbRows(options);
            if (family === "all") {
                discoveryText = rows
                    .flatMap((row) => [row.name, ...row.interfaces.map((child) => child.name)])
                    .join("\n");
                if (Buffer.byteLength(discoveryText, "utf8") > 2 * 1024 * 1024)
                    throw new Error("Linux USB names exceed their byte budget");
            }
            devices = rows
                .filter((row) => row.family && (family === "all" || row.family === family))
                .map((row) => deviceRecord({ ...row, name: row.name || "USB debug probe" }));
        } else throw new Error("USB inventory is unavailable on this platform");
        return {
            available: true,
            platform,
            devices,
            notes: [],
            ...(discoveryText === undefined ? {} : { discoveryText })
        };
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
    listLinuxUsbRows,
    WINDOWS_INVENTORY,
    USB_INVENTORY
};
