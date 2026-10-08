"use strict";
const assert = require("assert");
const { listWindowsProbeRows } = require("../skills/_emberprobe/windows-probe-inventory");
const { listProbes, parseWindowsInventory } = require("../skills/_emberprobe/probe-inventory");

const root = "USB\\VID_C251&PID_F001\\0001A0000000";
const usb = "USB\\VID_C251&PID_F001&MI_02\\location";
const hid = "HID\\VID_C251&PID_F001&MI_02\\location";
const fixture = [
    { instanceId: root, name: "USB Composite Device", parent: 5 },
    { instanceId: usb, name: "USB 输入设备", parent: 1, service: "HidUsb" },
    { instanceId: hid, name: "符合 HID 标准的供应商定义设备", parent: 2 },
    { instanceId: "USB\\VID_1234&PID_5678\\keyboard", name: "Keyboard", parent: 5 },
    { instanceId: "USB\\ROOT_HUB30\\location", name: "USB hub" }
];
const classify = (vid, pid) => vid === "c251" && pid === "f001";

function mockApi(rows = fixture) {
    const text = rows.map((row) => row.instanceId).join("\0") + "\0\0";
    let propertyCalls = 0;
    return {
        get propertyCalls() {
            return propertyCalls;
        },
        listSize: (size, filter, flags) => {
            assert.strictEqual(filter, null);
            assert.strictEqual(flags, 0x100, "Only currently present devices may be enumerated");
            size.writeUInt32LE(text.length);
            return 0;
        },
        list: (filter, buffer, chars, flags) => {
            assert.strictEqual(filter, null);
            assert.strictEqual(chars, text.length);
            assert.strictEqual(flags, 0x100);
            buffer.write(text, "utf16le");
            return 0;
        },
        locate: (node, id, flags) => {
            assert.strictEqual(flags, 0, "No phantom-device creation is allowed");
            node.writeUInt32LE(rows.findIndex((row) => row.instanceId === id) + 1);
            return 0;
        },
        parent: (parent, node, flags) => {
            assert.strictEqual(flags, 0);
            parent.writeUInt32LE(rows[node - 1].parent);
            return 0;
        },
        deviceId: (node, buffer, chars, flags) => {
            assert.strictEqual(chars, buffer.length / 2);
            assert.strictEqual(flags, 0);
            buffer.write(rows[node - 1].instanceId + "\0", "utf16le");
            return 0;
        },
        property: (node, key, type, buffer, size, flags) => {
            assert.strictEqual(flags, 0);
            assert.strictEqual(size.readUInt32LE(), buffer.length);
            propertyCalls++;
            const deviceKey = key.subarray(0, 16).toString("hex") === "4e255ca41cdffd4e802067d146a850e0";
            const field = deviceKey
                ? { 14: "name", 2: "description", 6: "service" }[key.readUInt32LE(16)]
                : { 9: "driverProvider", 5: "driverInf" }[key.readUInt32LE(16)];
            const value = rows[node - 1][field];
            if (!value) return 0x25;
            type.writeUInt32LE(0x12);
            size.writeUInt32LE(Buffer.byteLength(value + "\0", "utf16le"));
            buffer.write(value + "\0", "utf16le");
            return 0;
        }
    };
}

async function main() {
    const api = mockApi();
    const rows = listWindowsProbeRows(classify, { api });
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[1].service, "HidUsb");
    const parsed = parseWindowsInventory(JSON.stringify(rows), "all");
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].serial, "0001A0000000");
    assert.strictEqual(parsed[0].interfaces.length, 3);
    assert.strictEqual(api.propertyCalls, 13, "Only candidate probes need driver/parent metadata");

    // Every call queries present devices afresh, including unplug/replug with a different serial.
    const replacement = fixture.map((row) => ({
        ...row,
        instanceId: row.instanceId.replace("0001A0000000", "0002B0000000")
    }));
    const changed = listWindowsProbeRows(classify, { api: mockApi(replacement) });
    assert.strictEqual(parseWindowsInventory(JSON.stringify(changed), "all")[0].serial, "0002B0000000");
    assert.deepStrictEqual(listWindowsProbeRows(classify, { api: mockApi([]) }), []);
    const named = fixture.map((row) => ({
        ...row,
        instanceId: row.instanceId.replace(/C251&PID_F001/g, "1234&PID_ABCD"),
        name: row.instanceId === hid ? "CMSIS-DAP" : row.name
    }));
    const namedRows = listWindowsProbeRows((_vid, _pid, name) => /CMSIS-DAP/.test(name), { api: mockApi(named) });
    assert.strictEqual(namedRows.length, 3, "An identified interface must retain its unnamed composite root");
    assert.strictEqual(parseWindowsInventory(JSON.stringify(namedRows), "all")[0].serial, "0001A0000000");

    let calls = 0;
    const originalList = api.list;
    api.list = (...args) => (++calls === 1 ? 0x1a : originalList(...args));
    assert.strictEqual(listWindowsProbeRows(classify, { api }).length, 3);
    assert.strictEqual(calls, 2, "A larger device list must be resized before retrying");
    api.list = () => 0x1a;
    assert.throws(() => listWindowsProbeRows(classify, { api }), /changed/);
    assert.throws(() => listWindowsProbeRows(classify, { api: { listSize: () => 1 } }), /size present/);
    assert.throws(
        () =>
            listWindowsProbeRows(classify, {
                api: {
                    listSize: (out) => {
                        out.writeUInt32LE(524289);
                        return 0;
                    }
                }
            }),
        /size budget/
    );
    assert.throws(() => listWindowsProbeRows(classify, { api: { ...mockApi(), locate: () => 1 } }), /changed/);
    assert.throws(() => listWindowsProbeRows(classify, { api: { ...mockApi(), parent: () => 1 } }), /parent/);
    assert.throws(
        () => listWindowsProbeRows(classify, { api: { ...mockApi(), deviceId: () => 1 } }),
        /parent identity/
    );
    let time = 0;
    assert.throws(() => listWindowsProbeRows(classify, { api: mockApi(), now: () => (time += 1001) }), /time budget/);
    for (const badProperty of [
        (_node, _key, type, _buffer, size) => {
            type.writeUInt32LE(0x13);
            size.writeUInt32LE(4);
            return 0;
        },
        (_node, _key, type, _buffer, size) => {
            type.writeUInt32LE(0x12);
            size.writeUInt32LE(8194);
            return 0;
        }
    ]) {
        const result = listWindowsProbeRows(classify, { api: { ...mockApi(), property: badProperty } });
        assert.strictEqual(result[0].name, "");
        assert.strictEqual(parseWindowsInventory(JSON.stringify(result), "all")[0].serial, "0001A0000000");
    }

    const fast = await listProbes({
        platform: "win32",
        family: "all",
        nativeList: () => rows,
        run: () => {
            throw new Error("PowerShell must not start");
        }
    });
    assert.strictEqual(fast.devices[0].serial, "0001A0000000");
    const empty = await listProbes({
        platform: "win32",
        family: "all",
        nativeList: () => [],
        run: () => {
            throw new Error("Empty inventory must remain empty");
        }
    });
    assert.strictEqual(empty.available, true);
    assert.deepStrictEqual(empty.devices, []);
    const fallback = await listProbes({
        platform: "win32",
        family: "all",
        nativeList: () => {
            throw new Error("No native runtime");
        },
        run: async () => JSON.stringify(rows)
    });
    assert.strictEqual(fallback.devices[0].serial, "0001A0000000");
    const unavailable = await listProbes({
        platform: "win32",
        family: "all",
        nativeList: () => {
            throw new Error("Native API failed");
        },
        run: () => {
            throw new Error("PnP provider failed");
        }
    });
    assert.strictEqual(unavailable.available, false);
    console.log("Windows native USB inventory, fresh identity, budgets and fallback tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
