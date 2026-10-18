"use strict";
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { normalizeProbeSerial } = require("./probe-connection");
const { listWindowsProbeRows } = require("./windows-probe-inventory");
const { USB_PROFILES, normalizeInventoryQuery, matchesUsbIds } = require("./probe-profile");

// Only OS metadata is read. No SEGGER tool, OpenOCD init or driver installer is invoked.
const WINDOWS_INVENTORY = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$keys = @('DEVPKEY_Device_Parent', 'DEVPKEY_Device_ContainerId', 'DEVPKEY_Device_Service',
 'DEVPKEY_Device_DriverProvider', 'DEVPKEY_Device_DriverInfPath', 'DEVPKEY_Device_BusReportedDeviceDesc', 'DEVPKEY_Device_LastArrivalDate');
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
 [pscustomobject]@{ instanceId=$d.InstanceId; name=$d.FriendlyName; reportedName=$p['DEVPKEY_Device_BusReportedDeviceDesc']; parentId=$p['DEVPKEY_Device_Parent']; containerId=[string]$p['DEVPKEY_Device_ContainerId']; service=$p['DEVPKEY_Device_Service']; driverProvider=$p['DEVPKEY_Device_DriverProvider']; driverInf=$p['DEVPKEY_Device_DriverInfPath']; attachmentId=if($p['DEVPKEY_Device_LastArrivalDate']) {$p['DEVPKEY_Device_LastArrivalDate'].ToFileTimeUtc().ToString()} else {''} }
}) | ConvertTo-Json -Depth 4 -Compress`;
const USB_INVENTORY = WINDOWS_INVENTORY.replace(
    "$_.InstanceId -like 'USB\\VID_1366*'",
    "$_.InstanceId -match '^(USB|HID)\\\\VID_'"
).replace(
    "$properties = @{};",
    // Keep every interface/root of matching VID/PID pairs, including unnamed composite parents.
    // Querying properties for keyboards, mice and cameras can exhaust the bounded query budget, so only
    // unmatched USB roots get one batched iProduct query (CMSIS-DAP clones often have generic Windows names).
    `$prefixes = @{};
$pattern = 'j[- ]?link|cmsis[- _]?dap|daplink|mcu[- ]?link|picoprobe|st[- ]?link|xds[- ]?110|nu[- ]?link|kitprog|versaloon|vsllink|icdi';
foreach ($d in $devices) {
 if ($d.InstanceId -match '^(USB|HID)\\\\VID_(1366&PID_[0-9A-F]{4}|0D28&PID_0204|C251&PID_(F001|F002|2722|2750)|0483&PID_(374[48BDEF]|375[23457]|A038)|0451&PID_(BEF3|BEF4)|1CBE&PID_(02A5|00FD)|0416&PID_(511[B-D]|520[01])|04B4&PID_F139)' -or $d.FriendlyName -match $pattern) {
  if ($d.InstanceId -match '^(USB|HID)\\\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})') { $prefixes[$Matches[2]] = $true }
 }
};
$roots = @($devices | Where-Object { $_.InstanceId -match '^USB\\\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})\\\\' -and !$prefixes.ContainsKey($Matches[1]) });
if ($roots.Count) {
 Get-PnpDeviceProperty -InstanceId $roots.InstanceId -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc' -ErrorAction SilentlyContinue | ForEach-Object {
  if ([string]$_.Data -match $pattern -and $_.InstanceId -match '^USB\\\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})') { $prefixes[$Matches[1]] = $true }
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
    // Generic FTDI bridges are usually serial cables; they count as probes only when an interface selects their IDs.
    for (const profile of Object.values(USB_PROFILES))
        if (
            profile.family !== "ft232r" &&
            profile.ids?.some(
                ([vendor, product]) => Number.parseInt(vid, 16) === vendor && Number.parseInt(pid, 16) === product
            )
        )
            return profile.family;
    if (/\bxds[- ]?110/i.test(name)) return "xds110";
    if (/\bnu[- ]?link/i.test(name)) return "nulink";
    return "";
}

function linuxSerial(value, family, vid) {
    // sysfs appends one newline. Keep all UID bytes until the legacy ST-Link conversion is decided.
    const raw = String(value).replace(/\n$/, "");
    if (
        family === "stlink" &&
        vid === "0483" &&
        raw.length === 12 &&
        !/^[A-Za-z0-9_.: -]+$/.test(raw) &&
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

// A device that cannot be read in time (for example a target whose USB stack stops answering while the kernel
// holds its device lock) is skipped instead of failing the query. Skipped devices may still be probes.
async function scanLinuxUsb(options = {}) {
    const root = options.sysfsRoot || "/sys/bus/usb/devices";
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 2000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error("Invalid USB query budget");
    let timer;
    const expired = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
    });
    // Resolves to null when the budget expires first.
    const withinBudget = (promise) =>
        Promise.race([Promise.resolve(promise).then((value) => ({ value })), expired.then(() => null)]);
    try {
        const listed = await withinBudget((options.readdir || fs.readdir)(root));
        if (!listed) throw new Error("Linux USB metadata query timed out");
        const entries = listed.value;
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
        const readDevice = async (id) => {
            const [vendor, productId, product] = await Promise.all([
                value(id, "idVendor"),
                value(id, "idProduct"),
                value(id, "product")
            ]);
            const vid = vendor.trim().toLowerCase();
            const pid = productId.trim().toLowerCase();
            if (!vid || !pid) return null;
            if (!/^[0-9a-f]{4}$/.test(vid) || !/^[0-9a-f]{4}$/.test(pid))
                throw new Error(`Linux USB metadata ${id}: invalid VID/PID`);
            const children = [];
            for (const child of interfaces.get(id) || []) {
                const name = (await value(child.id, "interface")).trim();
                if (name) children.push({ instanceId: child.id, name, interfaceNumber: child.interfaceNumber });
            }
            const name = product.trim();
            const family =
                options.vidPid?.length && options.family !== "all" && matchesUsbIds({ vid, pid }, options.vidPid)
                    ? options.family
                    : usbFamily(vid, pid, [name, ...children.map((child) => child.name)].join("\n"));
            let attachmentId = "";
            if (family) {
                const [bus, address, metadata] = await Promise.all([
                    value(id, "busnum"),
                    value(id, "devnum"),
                    (options.stat || fs.stat)(path.join(root, id), { bigint: true }).catch(() => null)
                ]);
                if (
                    /^\d+$/.test(bus.trim()) &&
                    /^\d+$/.test(address.trim()) &&
                    metadata?.ino > 0n &&
                    metadata?.ctimeNs > 0n
                )
                    attachmentId = `${bus.trim()}:${address.trim()}:${metadata.ino}:${metadata.ctimeNs}`;
            }
            return {
                id,
                name,
                product: name,
                vid,
                pid,
                family,
                serialSource: "usb-descriptor",
                attachmentId,
                interfaces: children,
                serial: family ? linuxSerial(await value(id, "serial"), family, vid) : ""
            };
        };
        /** @type {Array<{row?: any, failure?: string}|undefined>} */
        const results = new Array(devices.length);
        let next = 0;
        const worker = async () => {
            while (next < devices.length && !controller.signal.aborted) {
                const index = next++;
                try {
                    const row = await readDevice(devices[index]);
                    results[index] = { row };
                } catch (error) {
                    results[index] = { failure: String(error.message) };
                }
            }
        };
        await withinBudget(Promise.all(Array.from({ length: Math.min(4, devices.length) }, worker)));
        // Snapshot synchronously: workers still blocked in a read must not change the returned inventory.
        const rows = [];
        const skipped = [];
        devices.forEach((id, index) => {
            const result = results[index];
            if (!result) skipped.push({ id, reason: `Linux USB metadata ${id}: query timed out` });
            else if (result.failure !== undefined) skipped.push({ id, reason: result.failure });
            else if (result.row) rows.push(result.row);
        });
        // No readable device at all is an unavailable inventory, not an empty one.
        if (skipped.length && skipped.length === devices.length) throw new Error(skipped[0].reason);
        return { rows, skipped };
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

async function listLinuxUsbRows(options = {}) {
    return (await scanLinuxUsb(options)).rows;
}

function parseWindowsInventory(text, family = "jlink", vidPid = []) {
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
        const classified =
            vidPid.length && family !== "all" && matchesUsbIds(group, vidPid)
                ? family
                : usbFamily(group.vid, group.pid, [row.name, row.reportedName].filter(Boolean).join("\n"));
        if (classified) group.family = classified;
        for (const name of [row.name, row.reportedName])
            if (name && /j[- ]?link|cmsis|daplink|st[- ]?link|xds|nu[- ]?link|kitprog|versaloon|vsllink/i.test(name)) {
                group.name = name;
                break;
            }
        const serialId = physicalId;
        const serial = /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\[^&\\]+$/i.test(serialId)
            ? serialOrUnknown(serialId.split("\\").pop(), group.family)
            : "";
        if (serial) group.serial = serial;
        group.serialSource = "os-instance";
        if (id.toUpperCase() === physicalId.toUpperCase()) group.product = row.reportedName || row.name || "";
        if (row.attachmentId && id.toUpperCase() === physicalId.toUpperCase())
            group.attachmentId = String(row.attachmentId);
        group.interfaces.push({
            instanceId: id,
            name: row.name || "",
            ...(row.reportedName ? { reportedName: row.reportedName } : {}),
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

// macOS 26 renamed the USB data type and its JSON keys along with it: `SPUSBHostDataType`
// reports USBDeviceKeyVendorID / USBDeviceKeyProductID / USBDeviceKeySerialNumber /
// USBKeyLocationID where `SPUSBDataType` used vendor_id / product_id / serial_num /
// location_id. Accept both so either table shape parses without a second walker.
function macField(value, ...keys) {
    for (const key of keys) {
        const field = value[key];
        if (field !== undefined && field !== null && field !== "") return field;
    }
    return "";
}

function parseMacInventory(text, family = "jlink", vidPid = []) {
    const devices = [];
    const visit = (value) => {
        if (!value || typeof value !== "object") return;
        const vid =
            String(macField(value, "vendor_id", "USBDeviceKeyVendorID"))
                .match(/0x([0-9a-f]{4})/i)?.[1]
                ?.toLowerCase() || "";
        const pid =
            String(macField(value, "product_id", "USBDeviceKeyProductID"))
                .match(/0x([0-9a-f]{4})/i)?.[1]
                ?.toLowerCase() || "";
        const classified =
            vidPid.length && family !== "all" && matchesUsbIds({ vid, pid }, vidPid)
                ? family
                : usbFamily(vid, pid, value._name || "");
        if (classified && (family === "all" || family === classified)) {
            devices.push(
                deviceRecord({
                    id: String(macField(value, "location_id", "USBKeyLocationID") || `usb-${devices.length}`),
                    name: value._name || "USB debug probe",
                    product: value._name || "",
                    vid,
                    pid,
                    family: classified,
                    serialSource: "usb-descriptor",
                    attachmentId: "",
                    serial: serialOrUnknown(macField(value, "serial_num", "USBDeviceKeySerialNumber"), classified)
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

// macOS 26 renamed the USB data type: `system_profiler SPUSBDataType` still exits 0 but
// returns an empty table, while `SPUSBHostDataType` carries the real data. Keep the old
// name first so hosts before macOS 26 behave exactly as before.
const MAC_USB_DATA_TYPES = ["SPUSBDataType", "SPUSBHostDataType"];

function isEmptyMacUsbTable(text) {
    try {
        const parsed = JSON.parse(text);
        const rows = parsed && typeof parsed === "object" ? Object.values(parsed)[0] : null;
        return Array.isArray(rows) && rows.length === 0;
    } catch {
        return false;
    }
}

function macUsbNames(text) {
    const names = [];
    const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (typeof value._name === "string") names.push(value._name);
        for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
    };
    visit(JSON.parse(text));
    return names.join("\n");
}

async function listMacProbeRows(run, family, vidPid = []) {
    // The last table that parsed; an empty old table is a valid answer if the renamed type fails.
    let table = null;
    let failure;
    for (const dataType of MAC_USB_DATA_TYPES) {
        try {
            const text = await run("system_profiler", [dataType, "-json"]);
            table = { devices: parseMacInventory(text, family, vidPid), text };
        } catch (error) {
            // A failed or unparsable query must not hide the other data type, nor a table already read.
            failure = error;
            continue;
        }
        // Fall back only when the table itself is empty. An empty result for our family on a
        // healthy table is a genuine "no probe attached" and must not pay a second cold start.
        if (table.devices.length || !isEmptyMacUsbTable(table.text)) break;
    }
    if (!table) throw failure;
    return table;
}

async function listProbes(options = {}) {
    const platform = options.platform || process.platform;
    const family = options.family || "jlink";
    const filters = normalizeInventoryQuery({ family, vidPid: options.vidPid });
    const classify = (vid, pid, name) =>
        matchesUsbIds({ vid, pid }, filters.vidPid) &&
        (usbFamily(vid, pid, name) || (filters.vidPid.length ? family : ""));
    const run = options.run || runInventory;
    try {
        let devices;
        let discoveryText;
        let skipped = [];
        if (platform === "win32") {
            if (family === "jlink" && (!options.run || options.fastRun)) {
                try {
                    if (!options.fastRun) await fs.access(WINDOWS_HELPER);
                    devices = parseWindowsInventory(await (options.fastRun || runInventory)(WINDOWS_HELPER, ["list"]));
                    if (devices.some((device) => !device.serial)) devices = undefined;
                } catch {
                    // Older development helpers have no list action; keep the PowerShell fallback.
                }
            }
            if (!devices && (!options.run || options.nativeList)) {
                try {
                    devices = parseWindowsInventory(
                        JSON.stringify(await (options.nativeList || listWindowsProbeRows)(classify)),
                        family,
                        filters.vidPid
                    );
                } catch {
                    // Missing native runtime or a changing device list retains the bounded OS-query fallback.
                }
            }
            if (!devices) {
                const script =
                    family === "jlink"
                        ? WINDOWS_INVENTORY
                        : !filters.vidPid.length
                          ? USB_INVENTORY
                          : USB_INVENTORY.replace(
                                "$prefixes = @{};",
                                "$prefixes = @{}; " +
                                    filters.vidPid
                                        .map(
                                            ([vid, pid]) =>
                                                `$prefixes['VID_${vid.toString(16).padStart(4, "0")}&PID_${pid.toString(16).padStart(4, "0")}'] = $true;`
                                        )
                                        .join(" ")
                            );
                devices = parseWindowsInventory(
                    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]),
                    family,
                    filters.vidPid
                );
            }
        } else if (platform === "darwin") {
            const table = await listMacProbeRows(run, family, filters.vidPid);
            devices = table.devices;
            // Probe detection reuses these names instead of starting system_profiler again.
            if (family === "all") discoveryText = macUsbNames(table.text);
            if (devices.some((device) => !device.serial || device.family === "kitprog")) {
                try {
                    attachMacRegistryIds(devices, await run("ioreg", ["-p", "IOUSB", "-l", "-w", "0"]));
                } catch {
                    /* Unknown attachments cannot authorize anonymous writes. */
                }
            }
        } else if (platform === "linux") {
            const scan = await scanLinuxUsb(options);
            const rows = scan.rows;
            skipped = scan.skipped;
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
        devices = devices.filter((device) => matchesUsbIds(device, filters.vidPid));
        // A partial inventory still identifies the probes it lists but cannot prove any other probe absent.
        return {
            available: true,
            ...(skipped.length ? { partial: true } : {}),
            platform,
            devices,
            notes: skipped.length
                ? [
                      `USB inventory incomplete; skipped ${skipped.length} unreadable device(s): ${skipped
                          .slice(0, 3)
                          .map((item) => item.reason)
                          .join("; ")}`.slice(0, 400)
                  ]
                : [],
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

function attachMacRegistryIds(devices, text) {
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("IORegistry exceeds its byte budget");
    const records = [];
    let record;
    for (const line of String(text).split(/\r?\n/)) {
        const header = line.match(/\+-o .*<class (?:IOUSBHostDevice|IOUSBDevice), id (0x[0-9a-f]+),/i);
        if (line.includes("+-o ")) {
            record = header ? { id: header[1] } : null;
            if (record) records.push(record);
        }
        if (!record) continue;
        for (const [property, key] of [
            ["locationID", "location"],
            ["idVendor", "vid"],
            ["idProduct", "pid"]
        ]) {
            const value = line.match(new RegExp(`"${property}" = (0x[0-9a-f]+|[0-9]+)`, "i"));
            if (value) record[key] = Number(value[1]);
        }
    }
    for (const device of devices) {
        const location = Number.parseInt(device.id.match(/0x[0-9a-f]+/i)?.[0] || "", 16);
        const matches = records.filter(
            (item) =>
                item.location === location &&
                item.vid === Number.parseInt(device.vid, 16) &&
                item.pid === Number.parseInt(device.pid, 16)
        );
        if (matches.length === 1) device.attachmentId = matches[0].id;
    }
}

module.exports = {
    listProbes,
    parseWindowsInventory,
    parseMacInventory,
    windowsHelperPath,
    listLinuxUsbRows,
    scanLinuxUsb,
    MAC_USB_DATA_TYPES,
    WINDOWS_INVENTORY,
    USB_INVENTORY,
    attachMacRegistryIds
};
