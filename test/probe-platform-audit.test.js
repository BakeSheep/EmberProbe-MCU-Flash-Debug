"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs/promises");
const {
    listProbes,
    listLinuxUsbRows,
    parseWindowsInventory,
    parseMacInventory,
    USB_INVENTORY
} = require("../skills/_emberprobe/probe-inventory");
const { usbInventory, detectProbe, probeCandidates } = require("../skills/_emberprobe/probe-detection");
const { normalizeProbeSerial, resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
const { prepareProbeConnection } = require("../skills/_emberprobe/probe-preflight");
const { diagnoseOpenOcdFailure } = require("../skills/_emberprobe/openocd-diagnostics");

function sysfs(devices, entries = Object.keys(devices)) {
    const reads = [];
    return {
        platform: "linux",
        family: "all",
        readdir: async () => entries,
        readFile: async (filename) => {
            const id = path.basename(path.dirname(filename));
            const key = path.basename(filename);
            reads.push(`${id}/${key}`);
            const value = devices[id]?.[key];
            if (value instanceof Error) throw value;
            if (value === undefined) throw Object.assign(new Error("No attribute"), { code: "ENOENT" });
            return value;
        },
        reads
    };
}

async function main() {
    // Compare the same PID matrix on every supported inventory backend, with generic names.
    for (const pid of ["3744", "3748", "374b", "374d", "374e", "374f", "3752", "3753", "3754", "3755", "3757"]) {
        const id = `USB\\VID_0483&PID_${pid}\\000Ab123`;
        const win = parseWindowsInventory(
            JSON.stringify([
                { instanceId: id, name: "USB Composite Device" },
                {
                    instanceId: `USB\\VID_0483&PID_${pid}&MI_00\\location`,
                    name: "USB device",
                    parentId: id.toLowerCase()
                }
            ]),
            "all"
        );
        assert.strictEqual(win.length, 1);
        assert.strictEqual(win[0].family, "stlink");
        assert.strictEqual(win[0].serial, "000Ab123");
        assert.strictEqual(win[0].interfaces.length, 2);
        const mac = parseMacInventory(
            JSON.stringify({ vendor_id: "0x0483", product_id: `0x${pid}`, serial_num: "000Ab123" }),
            "all"
        );
        assert.strictEqual(mac[0].family, "stlink");
        const linux = await listProbes(sysfs({ "1-2": { idVendor: "0483", idProduct: pid, serial: "000Ab123\n" } }));
        assert.strictEqual(linux.devices[0].serial, "000Ab123");
    }
    assert(USB_INVENTORY.includes("374[48BDEF]|375[23457]"));
    assert.deepStrictEqual(
        parseWindowsInventory(
            JSON.stringify({ instanceId: "USB\\VID_0483&PID_9999\\0001", name: "USB device" }),
            "all"
        ),
        []
    );
    for (const name of ["SEGGER Flasher", "J-Trace"]) {
        assert.deepStrictEqual(probeCandidates(name), []);
        const root = "USB\\VID_1366&PID_0101\\000123";
        assert.deepStrictEqual(
            parseWindowsInventory(
                JSON.stringify([
                    { instanceId: root, name: "USB Composite Device" },
                    { instanceId: "USB\\VID_1366&PID_0101&MI_00\\location", name, parentId: root }
                ]),
                "all"
            ),
            [],
            "A generic composite parent must not hide an excluded SEGGER product"
        );
    }

    // CMSIS-DAP v2 may identify itself only through an interface descriptor.
    const fixture = sysfs(
        {
            "1-2": { idVendor: "1FC9\n", idProduct: "ABCD\n", product: "Development board\n", serial: "000Aa1\n" },
            "1-2:1.0": { interface: "CMSIS-DAP v2\n" },
            "1-2:1.1": { interface: "Virtual serial port\n" },
            "1-3": { idVendor: "1366", idProduct: "0101", product: "J-Link", serial: "000123\n" },
            "1-4": { idVendor: "0483", idProduct: "374b", product: "USB Composite Device", serial: "000Bc2\n" },
            "1-5": { idVendor: "0451", idProduct: "bef3", product: "XDS110\n" },
            "1-6": { idVendor: "0416", idProduct: "511b", product: "Nu-Link\n" }
        },
        ["1-2", "1-2:1.0", "1-2:1.1", "1-3", "1-4", "1-5", "1-6", "usb1", "../../outside", "1-2.bad", "1-7:1.0"]
    );
    const inventory = await listProbes(fixture);
    assert.strictEqual(inventory.available, true);
    assert.deepStrictEqual(
        inventory.devices.map((device) => device.family),
        ["cmsis-dap", "jlink", "stlink"]
    );
    assert.deepStrictEqual(
        inventory.devices.map((device) => device.serial),
        ["000Aa1", "123", "000Bc2"]
    );
    assert.strictEqual(inventory.devices[0].interfaces.length, 2);
    assert(!fixture.reads.some((name) => /outside|bad|usb1|1-7/.test(name)));
    const text = await usbInventory({
        ...fixture,
        run: () => assert.fail("A successful sysfs query must not invoke lsusb")
    });
    assert(text.includes("CMSIS-DAP v2") && text.includes("Nu-Link") && text.includes("XDS110"));
    const detected = await detectProbe({
        platform: "linux",
        usbInventory: () => assert.fail("Reuse sysfs names without a second enumeration"),
        listProbes: async () => inventory
    });
    assert.strictEqual(detected.probe, "");
    assert.strictEqual(detected.candidates.length, 5, "Mixed supported adapter families must remain ambiguous");
    for (const [adapterFamily, probe, serial] of [
        ["cmsis-dap", "cmsis-dap.cfg", "000Aa1"],
        ["jlink", "jlink.cfg", "123"],
        ["st-link", "stlink.cfg", "000Bc2"],
        ["hla", "stlink-v2.cfg", "000Bc2"]
    ]) {
        const prepared = await prepareProbeConnection(
            { probe, target: "stm32h7x.cfg" },
            {
                platform: "linux",
                resolveLaunch: () => ({}),
                checkCapability: async () => ({ adapterFamily }),
                listProbes: async () => inventory,
                resolveTransport: async () => "swd"
            }
        );
        assert.strictEqual(prepared.probeSerial, serial);
        assert(prepared.deviceId);
    }
    const collision = await listProbes(
        sysfs({
            "1-2": { idVendor: "1366", idProduct: "0101", serial: "000123" },
            "1-3": { idVendor: "1366", idProduct: "0105", serial: "123" }
        })
    );
    assert.throws(() => resolveProbeConnection({ probe: "jlink.cfg", probeSerial: "123" }, collision), {
        code: "PROBE_IDENTITY_AMBIGUOUS"
    });
    assert.throws(() => resolveProbeConnection({ probe: "stlink.cfg", probeSerial: "other" }, inventory), {
        code: "PROBE_SELECTED_NOT_FOUND"
    });

    const rawUid = Buffer.from("57FF72067265575742132067", "hex").toString("latin1");
    const oldStlink = await listProbes(
        sysfs({ "1-2": { idVendor: "0483", idProduct: "3748", serial: rawUid + "\n" } })
    );
    assert.strictEqual(oldStlink.devices[0].serial, "57FF72067265575742132067");
    assert.strictEqual(
        resolveProbeConnection({ probe: "stlink.cfg" }, oldStlink).probeSerial,
        "57FF72067265575742132067"
    );
    assert.throws(
        () => normalizeProbeSerial(rawUid, "stlink"),
        { code: "PROBE_SERIAL_INVALID" },
        "Raw user input must remain rejected"
    );
    for (const serial of [rawUid.slice(1), "中".repeat(12)]) {
        const unknown = await listProbes(sysfs({ "1-2": { idVendor: "0483", idProduct: "3748", serial } }));
        assert.strictEqual(unknown.devices[0].serial, "");
    }

    for (const key of ["idVendor", "idProduct", "product", "serial"]) {
        const unreadable = await listProbes(
            sysfs({
                "1-2": {
                    idVendor: "0483",
                    idProduct: "3748",
                    [key]: Object.assign(new Error("Denied"), { code: "EACCES" })
                }
            })
        );
        assert.strictEqual(unreadable.available, false);
        assert(unreadable.notes[0].includes(key) && unreadable.notes[0].includes("EACCES"));
    }
    const removed = await listProbes(
        sysfs({ "1-2": { idVendor: Object.assign(new Error("Removed"), { code: "ENODEV" }) } })
    );
    assert.strictEqual(removed.available, true);
    assert.deepStrictEqual(removed.devices, []);
    const missingSerial = await listProbes(sysfs({ "1-2": { idVendor: "0483", idProduct: "3748" } }));
    assert.strictEqual(missingSerial.devices.length, 1);
    assert.throws(() => resolveProbeConnection({ probe: "stlink.cfg" }, missingSerial), {
        code: "PROBE_SELECTION_REQUIRED"
    });
    for (const options of [
        { readdir: async () => new Promise(() => {}), timeoutMs: 10 },
        { ...sysfs({ "1-2": {} }), readFile: async () => new Promise(() => {}), timeoutMs: 10 },
        { readdir: async () => Array(4097).fill("1-2") },
        sysfs({ "1-2": { idVendor: "0483", idProduct: "3748", product: "x".repeat(8193) } }),
        sysfs({ "1-2": { idVendor: "not-a-vid", idProduct: "3748" } })
    ]) {
        const result = await listProbes({ platform: "linux", family: "all", ...options });
        assert.strictEqual(result.available, false);
        assert(result.notes.length);
    }
    await assert.rejects(listLinuxUsbRows({ timeoutMs: 0 }), /budget/);
    const fallback = await usbInventory({
        platform: "linux",
        readdir: async () => {
            throw new Error("No sysfs");
        },
        run: async (command) => {
            assert.strictEqual(command, "lsusb");
            return { stdout: "CMSIS-DAP" };
        }
    });
    assert.strictEqual(fallback, "CMSIS-DAP");
    const winNames = await usbInventory({
        platform: "win32",
        nativeList: () => [{ name: "ST-LINK" }, { name: "XDS110" }],
        run: () => assert.fail("No PowerShell after native enumeration")
    });
    assert(winNames.includes("ST-LINK") && winNames.includes("XDS110"));
    const winFallback = await usbInventory({
        platform: "win32",
        nativeList: () => {
            throw new Error("No native runtime");
        },
        run: async () => ({ stdout: "J-Link" })
    });
    assert.strictEqual(winFallback, "J-Link");
    const denied = diagnoseOpenOcdFailure(["Error: libusb_open() failed with LIBUSB_ERROR_ACCESS"], {
        platform: "linux"
    });
    assert.strictEqual(denied.code, "PROBE_PERMISSION_DENIED");
    assert(denied.suggestedActions.some((action) => action.includes("udev")));
    if (process.platform === "linux") {
        // Actual Linux paths and fs.readFile AbortSignal behavior, using ordinary fixture files only.
        const results = path.resolve(__dirname, "../test-results");
        await fs.mkdir(results, { recursive: true });
        const root = await fs.mkdtemp(path.join(results, "linux-sysfs-"));
        assert(root.startsWith(results + path.sep));
        try {
            for (const [id, attributes] of Object.entries({
                "1-2": { idVendor: "1fc9", idProduct: "abcd", product: "Development board", serial: "000Aa1" },
                "1-2:1.0": { interface: "CMSIS-DAP v2" },
                "1-3": { idVendor: "0483", idProduct: "3748", serial: rawUid }
            })) {
                await fs.mkdir(path.join(root, id));
                for (const [name, value] of Object.entries(attributes))
                    await fs.writeFile(path.join(root, id, name), value + "\n", "utf8");
            }
            const actualFiles = await listProbes({ platform: "linux", family: "all", sysfsRoot: root });
            assert.strictEqual(actualFiles.available, true, actualFiles.notes.join("\n"));
            assert.deepStrictEqual(
                actualFiles.devices.map((device) => device.serial),
                ["000Aa1", "57FF72067265575742132067"]
            );
            assert(actualFiles.discoveryText.includes("CMSIS-DAP v2"));
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    }
    console.log("Probe cross-platform IDs, Linux interfaces/serials/budgets, discovery and ownership tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
