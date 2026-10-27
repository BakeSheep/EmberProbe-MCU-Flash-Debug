"use strict";
const assert = require("assert");
const { listWindowsProbeRows } = require("../skills/_emberprobe/windows-probe-inventory");
const { listProbes, parseWindowsInventory } = require("../skills/_emberprobe/probe-inventory");
const { trustedSerial } = require("../skills/_emberprobe/probe-connection");

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
            const guid = key.subarray(0, 16).toString("hex");
            if (guid === "2663da83a69788409453a1923f573b29" && key.readUInt32LE(16) === 102) {
                const arrival = rows[node - 1].arrival;
                if (!arrival) return 0x25;
                type.writeUInt32LE(0x10);
                size.writeUInt32LE(8);
                buffer.writeBigUInt64LE(BigInt(arrival));
                return 0;
            }
            const field =
                guid === "4e255ca41cdffd4e802067d146a850e0"
                    ? { 14: "name", 2: "description", 6: "service" }[key.readUInt32LE(16)]
                    : guid === "7e940b54408bbc45a8a26a0b894cbda2" && key.readUInt32LE(16) === 4
                      ? "reportedName"
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
    assert.strictEqual(
        api.propertyCalls,
        18,
        "Only candidate probes need driver/parent metadata; an unmatched USB device gets one iProduct query"
    );
    assert(!rows.some((row) => "reportedName" in row), "Classified names need no iProduct query");

    const arrived = fixture.map((row) => ({
        ...row,
        arrival: row.instanceId === root ? "133000000000000001" : "133000000000000002"
    }));
    const arrivedProbe = parseWindowsInventory(
        JSON.stringify(listWindowsProbeRows(classify, { api: mockApi(arrived) })),
        "all"
    )[0];
    assert.strictEqual(
        arrivedProbe.attachmentId,
        "133000000000000001",
        "Use the physical root's FILETIME without precision loss"
    );
    arrived[0].arrival = "133000000000000003";
    assert.strictEqual(
        parseWindowsInventory(JSON.stringify(listWindowsProbeRows(classify, { api: mockApi(arrived) })), "all")[0]
            .attachmentId,
        "133000000000000003"
    );

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

    // Horco CMSIS-DAP (EF1A:74E5): Windows names are generic; only the bus-reported iProduct identifies it.
    const horcoRoot = "USB\\VID_EF1A&PID_74E5\\4844332732";
    const horco = [
        { instanceId: horcoRoot, name: "USB Composite Device", reportedName: "Horco CMSIS-DAP", parent: 6 },
        { instanceId: "USB\\VID_EF1A&PID_74E5&MI_00\\location", name: "USB 输入设备", parent: 1 },
        { instanceId: "HID\\VID_EF1A&PID_74E5&MI_00\\location", name: "USB 输入设备", parent: 2 },
        { instanceId: "USB\\VID_EF1A&PID_74E5&MI_01\\location", name: "USB 串行设备 (COM20)", parent: 1 },
        {
            instanceId: "USB\\VID_A8A5&PID_2255\\keyboard",
            name: "USB Composite Device",
            reportedName: "G3 A",
            parent: 6
        },
        { instanceId: "USB\\ROOT_HUB30\\location", name: "USB hub" }
    ];
    const horcoApi = mockApi(horco);
    const horcoProbes = await listProbes({
        platform: "win32",
        family: "cmsis-dap",
        nativeList: (usbFamily) => listWindowsProbeRows(usbFamily, { api: horcoApi }),
        run: () => {
            throw new Error("PowerShell must not start");
        }
    });
    assert.strictEqual(horcoProbes.devices.length, 1, "An unrelated generic composite device must stay excluded");
    assert.strictEqual(horcoProbes.devices[0].family, "cmsis-dap");
    assert.strictEqual(horcoProbes.devices[0].serial, "4844332732");
    assert.strictEqual(horcoProbes.devices[0].name, "Horco CMSIS-DAP");
    assert.strictEqual(horcoProbes.devices[0].interfaces.length, 4);
    assert.strictEqual(horcoProbes.devices[0].id, horcoRoot);

    // An instance serial containing "_" is replaced by the exact iSerialNumber its parent hub reports.
    const aliasRoot = "USB\\VID_C251&PID_F001\\LU_2022_8888";
    const hubId = "USB\\ROOT_HUB30\\location";
    const hubPath = "\\\\?\\USB#ROOT_HUB30#location#{f18a0e88-c30c-11d0-8815-00a0c906bed8}";
    const hubApi = (descriptor, arrival, { vid = 0xc251 } = {}) => {
        const base = mockApi([
            { instanceId: aliasRoot, name: "CMSIS-DAP", parent: 2, arrival },
            { instanceId: hubId, name: "USB hub" }
        ]);
        const calls = { open: 0, close: 0, descriptors: [] };
        return {
            ...base,
            calls,
            property: (node, key, type, buffer, size, flags) => {
                // DEVPKEY_Device_Address: the probe sits on hub port 3.
                if (
                    key.subarray(0, 16).toString("hex") === "4e255ca41cdffd4e802067d146a850e0" &&
                    key.readUInt32LE(16) === 30
                ) {
                    type.writeUInt32LE(0x07);
                    size.writeUInt32LE(4);
                    buffer.writeUInt32LE(3);
                    return 0;
                }
                return base.property(node, key, type, buffer, size, flags);
            },
            interfaceListSize: (chars, guid, id, flags) => {
                assert.strictEqual(
                    guid.toString("hex"),
                    "880e8af10cc3d011881500a0c906bed8",
                    "GUID_DEVINTERFACE_USB_HUB"
                );
                assert.deepStrictEqual([id, flags], [hubId, 0]);
                chars.writeUInt32LE(hubPath.length + 2);
                return 0;
            },
            interfaceList: (guid, id, buffer, chars) => {
                assert.strictEqual(chars, hubPath.length + 2);
                buffer.write(hubPath + "\0\0", "utf16le");
                return 0;
            },
            open: (path, access, share, security, disposition) => {
                assert.deepStrictEqual([path, access, share, disposition], [hubPath, 0x40000000, 0x2, 3]);
                calls.open++;
                return 77;
            },
            ioctl: (handle, code, input, _inputSize, output, _outputSize, returned) => {
                assert.strictEqual(handle, 77);
                assert.strictEqual(input.readUInt32LE(0), 3, "the request names the probe's hub port");
                if (code === 0x220448) {
                    output.writeUInt16LE(vid, 12);
                    output.writeUInt16LE(0xf001, 14);
                    output[20] = 3;
                    returned.writeUInt32LE(35);
                    return 1;
                }
                assert.strictEqual(code, 0x220410);
                const index = input.readUInt16LE(6) & 0xff;
                calls.descriptors.push([input.readUInt16LE(6) >> 8, index, input.readUInt16LE(8)]);
                const text = index ? Buffer.from(descriptor, "utf16le") : Buffer.from([0x09, 0x04]);
                Buffer.concat([Buffer.from([2 + text.length, 3]), text]).copy(output, 12);
                returned.writeUInt32LE(14 + text.length);
                return 1;
            },
            close: (handle) => {
                assert.strictEqual(handle, 77);
                calls.close++;
                return 1;
            }
        };
    };
    const spacedApi = hubApi("LU 2022 8888", "133000000000000010");
    const spaced = parseWindowsInventory(JSON.stringify(listWindowsProbeRows(classify, { api: spacedApi })), "all")[0];
    assert.deepStrictEqual([spaced.serial, spaced.descriptorSerial], ["LU_2022_8888", "LU 2022 8888"]);
    assert.strictEqual(trustedSerial(spaced, spaced.family), "LU 2022 8888");
    assert.deepStrictEqual(spacedApi.calls.descriptors, [
        [3, 0, 0],
        [3, 3, 0x0409]
    ]);
    assert.deepStrictEqual([spacedApi.calls.open, spacedApi.calls.close], [1, 1], "the hub handle is closed");
    listWindowsProbeRows(classify, { api: spacedApi });
    assert.strictEqual(spacedApi.calls.open, 1, "an unchanged attachment is not asked again");
    const underscored = parseWindowsInventory(
        JSON.stringify(listWindowsProbeRows(classify, { api: hubApi("LU_2022_8888", "133000000000000011") })),
        "all"
    )[0];
    assert.strictEqual(trustedSerial(underscored, underscored.family), "LU_2022_8888");
    for (const [label, api] of [
        ["a descriptor that does not map back to the instance ID", hubApi("LU-2022-8888", "133000000000000012")],
        ["another device on the hub port", hubApi("LU 2022 8888", "133000000000000013", { vid: 0x1234 })]
    ]) {
        const row = listWindowsProbeRows(classify, { api })[0];
        assert.strictEqual(row.descriptorSerial, undefined, label);
        const device = parseWindowsInventory(JSON.stringify([row]), "all")[0];
        assert.strictEqual(trustedSerial(device, device.family), "", label);
        assert.strictEqual(api.calls.close, api.calls.open);
    }

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
