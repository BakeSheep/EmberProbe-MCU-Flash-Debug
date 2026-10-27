"use strict";
const path = require("path");
const { createRequire } = require("module");

// Read-only Configuration Manager calls avoid starting PowerShell's slow PnP provider.
// Koffi is already packaged for the Windows sampling timer; standalone skills can fall back to PowerShell.
function loadApi() {
    const root = path.basename(__dirname) === "dist" ? __dirname : path.resolve(__dirname, "../../dist");
    let koffi;
    try {
        koffi = createRequire(path.join(root, "sampling-timer/entry.cjs"))("koffi");
    } catch {
        koffi = createRequire(__filename)("koffi");
    }
    const library = koffi.load("cfgmgr32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const bind = (name, args) => library.func("__stdcall", name, "uint32_t", args);
    return {
        interfaceListSize: bind("CM_Get_Device_Interface_List_SizeW", ["void *", "void *", "str16", "uint32_t"]),
        interfaceList: bind("CM_Get_Device_Interface_ListW", ["void *", "str16", "void *", "uint32_t", "uint32_t"]),
        open: kernel32.func("__stdcall", "CreateFileW", "intptr_t", [
            "str16",
            "uint32_t",
            "uint32_t",
            "void *",
            "uint32_t",
            "uint32_t",
            "intptr_t"
        ]),
        ioctl: kernel32.func("__stdcall", "DeviceIoControl", "int", [
            "intptr_t",
            "uint32_t",
            "void *",
            "uint32_t",
            "void *",
            "uint32_t",
            "void *",
            "void *"
        ]),
        close: kernel32.func("__stdcall", "CloseHandle", "int", ["intptr_t"]),
        listSize: bind("CM_Get_Device_ID_List_SizeW", ["void *", "str16", "uint32_t"]),
        list: bind("CM_Get_Device_ID_ListW", ["str16", "void *", "uint32_t", "uint32_t"]),
        locate: bind("CM_Locate_DevNodeW", ["void *", "str16", "uint32_t"]),
        parent: bind("CM_Get_Parent", ["void *", "uint32_t", "uint32_t"]),
        deviceId: bind("CM_Get_Device_IDW", ["uint32_t", "void *", "uint32_t", "uint32_t"]),
        property: bind("CM_Get_DevNode_PropertyW", ["uint32_t", "void *", "void *", "void *", "void *", "uint32_t"])
    };
}

function propertyKey(guid, pid) {
    const bytes = Buffer.from(guid.replace(/-/g, ""), "hex");
    const key = Buffer.alloc(20);
    key.writeUInt32LE(bytes.readUInt32BE(0), 0);
    key.writeUInt16LE(bytes.readUInt16BE(4), 4);
    key.writeUInt16LE(bytes.readUInt16BE(6), 6);
    bytes.copy(key, 8, 8);
    key.writeUInt32LE(pid, 16);
    return key;
}

const deviceGuid = "a45c254e-df1c-4efd-8020-67d146a850e0";
const driverGuid = "a8b865dd-2e3d-4094-ad97-e593a70c75d6";
const keys = {
    name: propertyKey(deviceGuid, 14),
    description: propertyKey(deviceGuid, 2),
    // DEVPKEY_Device_BusReportedDeviceDesc: the USB iProduct/iInterface string reported by the device.
    reportedName: propertyKey("540b947e-8b40-45bc-a8a2-6a0b894cbda2", 4),
    service: propertyKey(deviceGuid, 6),
    driverProvider: propertyKey(driverGuid, 9),
    driverInf: propertyKey(driverGuid, 5),
    arrival: propertyKey("83da6326-97a6-4088-9453-a1923f573b29", 102),
    // DEVPKEY_Device_Address: a USB device's port number on its parent hub.
    address: propertyKey(deviceGuid, 30)
};
const hubInterface = propertyKey("f18a0e88-c30c-11d0-8815-00a0c906bed8", 0).subarray(0, 16);
const IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX = 0x220448;
const IOCTL_USB_GET_DESCRIPTOR_FROM_NODE_CONNECTION = 0x220410;
// Exact serials read from hubs, by instance and arrival, so polling does not repeat USB control requests.
const descriptorSerials = new Map();
const maxDescriptorSerials = 64;

// Windows stores characters a PnP instance ID cannot hold as "_", so an OS serial containing "_" does not say
// which string OpenOCD must match. The hub returns the device's iSerialNumber descriptor unchanged without
// opening the probe; it is accepted only when it maps back to the instance ID.
function hubDescriptorSerial(native, node, row, budget) {
    if (!native.open || !native.ioctl || !native.close) return "";
    const match = row.instanceId.match(/^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})\\([^&\\]*_[^&\\]*)$/i);
    if (!match || !row.parentId) return "";
    const cacheKey = row.instanceId.toUpperCase() + "|" + row.attachmentId;
    if (row.attachmentId && descriptorSerials.has(cacheKey)) return descriptorSerials.get(cacheKey);
    budget();
    const address = Buffer.alloc(4);
    const type = Buffer.alloc(4);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(4);
    if (native.property(node, keys.address, type, address, size, 0) !== 0 || type.readUInt32LE() !== 0x07) return "";
    const port = address.readUInt32LE();
    if (!port) return "";
    const chars = Buffer.alloc(4);
    if (native.interfaceListSize(chars, hubInterface, row.parentId, 0) !== 0) return "";
    const length = chars.readUInt32LE();
    if (length < 2 || length > 4096) return "";
    const paths = Buffer.alloc(length * 2);
    if (native.interfaceList(hubInterface, row.parentId, paths, length, 0) !== 0) return "";
    const hubPath = paths.toString("utf16le").split("\0")[0];
    if (!hubPath) return "";
    // GENERIC_WRITE with FILE_SHARE_WRITE is what the hub IOCTLs need; no administrator rights are required.
    const handle = Number(native.open(hubPath, 0x40000000, 0x2, null, 3, 0, 0));
    if (handle === -1 || handle === 0) return "";
    try {
        const returned = Buffer.alloc(4);
        // USB_NODE_CONNECTION_INFORMATION_EX is packed: the device descriptor follows the 4-byte port.
        const connection = Buffer.alloc(512);
        connection.writeUInt32LE(port, 0);
        budget();
        if (
            !native.ioctl(
                handle,
                IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX,
                connection,
                connection.length,
                connection,
                connection.length,
                returned,
                null
            ) ||
            returned.readUInt32LE() < 22 ||
            connection.readUInt16LE(12) !== parseInt(match[1], 16) ||
            connection.readUInt16LE(14) !== parseInt(match[2], 16)
        )
            return "";
        const serialIndex = connection[20];
        if (!serialIndex) return "";
        const stringDescriptor = (index, language) => {
            budget();
            // USB_DESCRIPTOR_REQUEST: the port, the 8-byte setup packet, then the descriptor.
            const request = Buffer.alloc(12 + 255);
            request.writeUInt32LE(port, 0);
            request.writeUInt16LE(0x0300 | index, 6);
            request.writeUInt16LE(language, 8);
            request.writeUInt16LE(255, 10);
            if (
                !native.ioctl(
                    handle,
                    IOCTL_USB_GET_DESCRIPTOR_FROM_NODE_CONNECTION,
                    request,
                    request.length,
                    request,
                    request.length,
                    returned,
                    null
                )
            )
                return null;
            const bytes = request[12];
            if (request[13] !== 3 || bytes < 2 || bytes % 2 || 12 + bytes > returned.readUInt32LE()) return null;
            return request.subarray(14, 12 + bytes);
        };
        const languages = stringDescriptor(0, 0);
        const value = stringDescriptor(serialIndex, languages?.length >= 2 ? languages.readUInt16LE(0) : 0x0409);
        const serial = value ? value.toString("utf16le") : "";
        if (!serial || serial.replace(/[\u0000- \u007f-￿,]/g, "_").toUpperCase() !== match[3].toUpperCase()) return "";
        if (row.attachmentId) {
            if (descriptorSerials.size >= maxDescriptorSerials) descriptorSerials.clear();
            descriptorSerials.set(cacheKey, serial);
        }
        return serial;
    } finally {
        native.close(handle);
    }
}
const presentOnly = 0x100;
const bufferSmall = 0x1a;
const maxListChars = 512 * 1024;
const maxPropertyBytes = 8192;
let api;

function listWindowsProbeRows(classify, options = {}) {
    const native = options.api || (api ||= loadApi());
    const now = options.now || Date.now;
    const deadline = now() + 2000;
    const budget = () => {
        if (now() > deadline) throw new Error("Native USB metadata query exceeded its time budget");
    };
    const number = Buffer.alloc(4);
    let ids;
    for (let attempt = 0; attempt < 3; attempt++) {
        budget();
        if (native.listSize(number, null, presentOnly) !== 0) throw new Error("Unable to size present USB inventory");
        const chars = number.readUInt32LE();
        if (chars < 1 || chars > maxListChars) throw new Error("Present USB inventory exceeds its size budget");
        const buffer = Buffer.alloc(chars * 2);
        const result = native.list(null, buffer, chars, presentOnly);
        if (result === bufferSmall) continue; // A device arrived between sizing and listing.
        if (result !== 0) throw new Error("Unable to list present USB inventory");
        ids = buffer.toString("utf16le").split("\0").filter(Boolean);
        break;
    }
    if (!ids || ids.length > 4096) throw new Error("Present USB inventory changed or exceeds its device budget");
    const stringProperty = (node, key) => {
        budget();
        const buffer = Buffer.alloc(maxPropertyBytes);
        const type = Buffer.alloc(4);
        const size = Buffer.alloc(4);
        size.writeUInt32LE(buffer.length);
        const result = native.property(node, key, type, buffer, size, 0);
        const bytes = size.readUInt32LE();
        if (result !== 0 || type.readUInt32LE() !== 0x12 || bytes > buffer.length || bytes % 2) return "";
        return buffer.toString("utf16le", 0, bytes).split("\0")[0];
    };
    const rows = [];
    const prefixes = new Set();
    for (const id of ids) {
        const match = id.match(/^(?:USB|HID)\\(VID_([0-9A-F]{4})&PID_([0-9A-F]{4}))/i);
        if (!match) continue;
        budget();
        // NORMAL (0) locates an existing devnode and never creates a phantom device.
        if (native.locate(number, id, 0) !== 0) throw new Error("USB device changed during inventory query");
        const node = number.readUInt32LE();
        const name = stringProperty(node, keys.name) || stringProperty(node, keys.description);
        const prefix = match[1].toUpperCase();
        const vid = match[2].toLowerCase();
        const pid = match[3].toLowerCase();
        let reportedName = "";
        if (classify(vid, pid, name)) prefixes.add(prefix);
        else if (!prefixes.has(prefix) && /^USB\\/i.test(id)) {
            // Windows gives CMSIS-DAP clones generic names; the spec requires "CMSIS-DAP" in iProduct.
            reportedName = stringProperty(node, keys.reportedName);
            if (reportedName && classify(vid, pid, reportedName)) prefixes.add(prefix);
        }
        rows.push({ instanceId: id, name, ...(reportedName ? { reportedName } : {}), node, prefix, attachmentId: "" });
    }
    return rows
        .filter((row) => prefixes.has(row.prefix))
        .map(({ node, prefix: _prefix, ...row }) => {
            budget();
            if (native.parent(number, node, 0) !== 0) throw new Error("Unable to identify USB device parent");
            const parent = number.readUInt32LE();
            const buffer = Buffer.alloc(2048);
            if (native.deviceId(parent, buffer, buffer.length / 2, 0) !== 0)
                throw new Error("Unable to read USB device parent identity");
            row.parentId = buffer.toString("utf16le").split("\0")[0];
            // The product filter needs the root iProduct; query it only for matched probes.
            if (!row.reportedName && /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\/i.test(row.instanceId)) {
                const reportedName = stringProperty(node, keys.reportedName);
                if (reportedName) row.reportedName = reportedName;
            }
            const arrival = Buffer.alloc(8);
            const arrivalSize = Buffer.alloc(4);
            const arrivalType = Buffer.alloc(4);
            arrivalSize.writeUInt32LE(8);
            if (
                native.property(node, keys.arrival, arrivalType, arrival, arrivalSize, 0) === 0 &&
                arrivalType.readUInt32LE() === 0x10 &&
                arrivalSize.readUInt32LE() === 8 &&
                arrival.readBigUInt64LE() > 0n
            )
                row.attachmentId = arrival.readBigUInt64LE().toString();
            for (const field of ["service", "driverProvider", "driverInf"])
                row[field] = stringProperty(node, keys[field]);
            const descriptorSerial = hubDescriptorSerial(native, node, row, budget);
            if (descriptorSerial) row.descriptorSerial = descriptorSerial;
            return row;
        });
}

module.exports = { listWindowsProbeRows };
