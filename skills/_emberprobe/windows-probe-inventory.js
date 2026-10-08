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
    const bind = (name, args) => library.func("__stdcall", name, "uint32_t", args);
    return {
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
    service: propertyKey(deviceGuid, 6),
    driverProvider: propertyKey(driverGuid, 9),
    driverInf: propertyKey(driverGuid, 5)
};
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
        if (classify(match[2].toLowerCase(), match[3].toLowerCase(), name)) prefixes.add(prefix);
        rows.push({ instanceId: id, name, node, prefix });
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
            for (const field of ["service", "driverProvider", "driverInf"])
                row[field] = stringProperty(node, keys[field]);
            return row;
        });
}

module.exports = { listWindowsProbeRows };
