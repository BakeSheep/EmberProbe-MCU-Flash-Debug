"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const {
    resolveProbeConnection,
    normalizeProbeSerial,
    normalizeAdapterSpeed
} = require("../skills/_emberprobe/probe-connection");
const {
    parseWindowsInventory,
    parseMacInventory,
    listProbes,
    windowsHelperPath,
    WINDOWS_INVENTORY
} = require("../skills/_emberprobe/probe-inventory");
const {
    checkAdapterCapability,
    prepareProbeConnection,
    parseAdapterList
} = require("../skills/_emberprobe/probe-preflight");
const { buildOpenOcdConfigArgs } = require("../skills/_emberprobe/openocd-launch");

async function main() {
    const { args: configArgs } = require("../skills/mcu-config/scripts/config");
    assert.strictEqual(configArgs(["--probes"]).probes, true);
    assert.throws(() => configArgs(["--probes", "--set", "probeSerial=1234"]));
    assert(require("../skills/_emberprobe/agent-client").isReadOnlyMethod("probe.list"));
    const parent = "USB\\VID_1366&PID_0105\\123456789";
    const devices = parseWindowsInventory(
        JSON.stringify([
            { instanceId: parent, name: "USB Composite Device" },
            {
                instanceId: "USB\\VID_1366&PID_0105&MI_00\\location",
                parentId: parent.toLowerCase(),
                name: "J-Link",
                service: "JLink"
            },
            {
                instanceId: "USB\\VID_1366&PID_0105&MI_02\\location",
                parentId: parent,
                name: "J-Link",
                service: "WinUSB"
            }
        ])
    );
    assert.strictEqual(devices.length, 1, "composite interfaces are one physical probe");
    assert.strictEqual(devices[0].serial, "123456789");
    assert.strictEqual(devices[0].interfaces.length, 3);
    assert.strictEqual(devices[0].interfaces[2].service, "WinUSB");
    const unknown = parseWindowsInventory(JSON.stringify({ instanceId: "USB\\VID_1366&PID_0101\\6&abc&0&1" }));
    assert.strictEqual(unknown[0].serial, "", "USB location is not a serial");
    const mac = parseMacInventory(
        JSON.stringify({
            SPUSBDataType: [
                {
                    _items: [
                        { vendor_id: "0x1366 (SEGGER)", product_id: "0x0101", _name: "J-Link", serial_num: "001234" }
                    ]
                }
            ]
        })
    );
    assert.strictEqual(mac[0].serial, "1234");
    // macOS 26 renamed the keys as well: SPUSBHostDataType uses USBDeviceKey* / USBKey* names.
    const macRenamedKeys = parseMacInventory(
        JSON.stringify({
            SPUSBHostDataType: [
                {
                    _items: [
                        {
                            _name: "Horco CMSIS-DAP",
                            USBDeviceKeyVendorID: "0xfaed",
                            USBDeviceKeyProductID: "0x4870",
                            USBDeviceKeySerialNumber: "134244833088",
                            USBKeyLocationID: "0x00100000"
                        }
                    ]
                }
            ]
        }),
        "cmsis-dap"
    );
    assert.strictEqual(macRenamedKeys.length, 1);
    assert.strictEqual(macRenamedKeys[0].vid, "faed");
    assert.strictEqual(macRenamedKeys[0].pid, "4870");
    assert.strictEqual(macRenamedKeys[0].serial, "134244833088");
    assert.strictEqual(macRenamedKeys[0].id, "0x00100000");
    const helper = path.join("extension", "resources", "driver-helper", "win32-x64", "emberprobe-driver-helper.exe");
    assert.strictEqual(windowsHelperPath(path.join("extension", "dist")), path.resolve(helper));
    assert.strictEqual(windowsHelperPath(path.join("extension", "skills", "_emberprobe")), path.resolve(helper));
    let fastCalls = 0;
    const fast = await listProbes({
        platform: "win32",
        fastRun: async (_helper, args) => {
            fastCalls++;
            assert.deepStrictEqual(args, ["list"]);
            return JSON.stringify([{ instanceId: parent, name: "J-Link", service: "WinUSB" }]);
        },
        run: async () => assert.fail("PowerShell fallback must not run after a successful helper inventory")
    });
    assert.strictEqual(fastCalls, 1);
    assert.strictEqual(fast.devices[0].interfaces[0].service, "WinUSB");
    if (process.platform === "win32") {
        const powershell = path.join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
        );
        const mock = "function Get-PnpDevice { [CmdletBinding()] param([switch]$PresentOnly)";
        const args = (body) => ["-NoProfile", "-NonInteractive", "-Command", `${mock} ${body} }; ${WINDOWS_INVENTORY}`];
        const empty = execFileSync(powershell, args("return"), { encoding: "utf8" });
        assert.deepStrictEqual(parseWindowsInventory(empty), [], "an empty PnP query is a valid inventory");
        const failed = spawnSync(powershell, args("Write-Error 'PnP unavailable'"), { encoding: "utf8" });
        assert.notStrictEqual(failed.status, 0, "a PnP query failure must not look like an empty inventory");
    }
    const linux = await listProbes({
        platform: "linux",
        readdir: async () => ["1-2", "1-2:1.0", "usb1"],
        readFile: async (file) => {
            if (file.endsWith("idVendor")) return "1366\n";
            if (file.endsWith("idProduct")) return "0101\n";
            if (file.endsWith("serial")) return "1234\n";
            throw Object.assign(new Error("absent optional attribute"), { code: "ENOENT" });
        }
    });
    assert.strictEqual(linux.devices.length, 1);
    assert.strictEqual(linux.devices[0].serial, "1234");
    const darwinProbes = await listProbes({
        platform: "darwin",
        run: async (cmd, args) => {
            assert.strictEqual(cmd, "system_profiler");
            assert.deepStrictEqual(args, ["SPUSBDataType", "-json"]);
            return JSON.stringify({
                SPUSBDataType: [
                    {
                        _name: "J-Link",
                        vendor_id: "0x1366 (SEGGER)",
                        product_id: "0x0101",
                        serial_num: "987654321",
                        location_id: "0x14100000"
                    }
                ]
            });
        }
    });
    assert.strictEqual(darwinProbes.available, true);
    assert.strictEqual(darwinProbes.devices.length, 1);
    assert.strictEqual(darwinProbes.devices[0].serial, "987654321");
    assert.strictEqual(darwinProbes.devices[0].family, "jlink");
    // macOS 26 renamed the USB data type: SPUSBDataType exits 0 with an empty table.
    const macRenamedCalls = [];
    const macRenamed = await listProbes({
        platform: "darwin",
        family: "cmsis-dap",
        run: async (cmd, args) => {
            assert.strictEqual(cmd, "system_profiler");
            macRenamedCalls.push(args[0]);
            if (args[0] === "SPUSBDataType") return JSON.stringify({ SPUSBDataType: [] });
            // Real macOS 26 shape, including the renamed keys.
            return JSON.stringify({
                SPUSBHostDataType: [
                    {
                        _items: [
                            {
                                _name: "Horco CMSIS-DAP",
                                USBDeviceKeyVendorID: "0xfaed",
                                USBDeviceKeyProductID: "0x4870",
                                USBDeviceKeySerialNumber: "134244833088",
                                USBKeyLocationID: "0x00100000"
                            }
                        ]
                    }
                ]
            });
        }
    });
    assert.deepStrictEqual(macRenamedCalls, ["SPUSBDataType", "SPUSBHostDataType"]);
    assert.strictEqual(macRenamed.devices.length, 1);
    assert.strictEqual(macRenamed.devices[0].family, "cmsis-dap");
    assert.strictEqual(macRenamed.devices[0].serial, "134244833088");
    // A healthy table without our family is already conclusive: no second cold start.
    const macHealthyCalls = [];
    const macHealthy = await listProbes({
        platform: "darwin",
        family: "cmsis-dap",
        run: async (cmd, args) => {
            macHealthyCalls.push(args[0]);
            return JSON.stringify({
                SPUSBDataType: [{ _name: "USB Keyboard", vendor_id: "0x05ac", product_id: "0x024f" }]
            });
        }
    });
    assert.deepStrictEqual(macHealthyCalls, ["SPUSBDataType"]);
    assert.strictEqual(macHealthy.devices.length, 0);
    // Before macOS 26 the renamed type does not exist: an empty old table is still a valid answer.
    for (const renamed of [
        async () => {
            throw new Error("Unknown data type");
        },
        async () => ""
    ]) {
        const macEmpty = await listProbes({
            platform: "darwin",
            family: "cmsis-dap",
            run: async (cmd, args) => (args[0] === "SPUSBDataType" ? JSON.stringify({ SPUSBDataType: [] }) : renamed())
        });
        assert.strictEqual(macEmpty.available, true);
        assert.deepStrictEqual(macEmpty.devices, []);
    }
    // Both names empty: report an empty inventory instead of failing the query.
    const macEmpty = await listProbes({
        platform: "darwin",
        family: "cmsis-dap",
        run: async (cmd, args) => JSON.stringify({ [args[0]]: [] })
    });
    assert.strictEqual(macEmpty.available, true);
    assert.strictEqual(macEmpty.devices.length, 0);
    const unavailable = await listProbes({
        platform: "win32",
        run: async () => {
            throw new Error("denied");
        }
    });
    assert.strictEqual(unavailable.available, false);
    assert.match(unavailable.notes[0], /denied/);

    const config = { probe: "jlink.cfg", target: "stm32f1x.cfg", transport: "swd" };
    const inventory = { available: true, devices };
    assert.strictEqual(resolveProbeConnection(config, inventory).probeSerial, "123456789");
    const fails = (options, list, code) =>
        assert.throws(
            () => resolveProbeConnection(options, list),
            (error) => error.code === code
        );
    assert.strictEqual(resolveProbeConnection({ ...config, transport: "auto" }, inventory).transport, "swd");
    // Without OS inventory OpenOCD applies the interface default selection.
    assert.strictEqual(resolveProbeConnection(config, unavailable).selection.probe, "script-default");
    fails({ ...config, probeSerial: "12" }, inventory, "PROBE_SELECTED_NOT_FOUND");
    fails(config, { available: true, devices: [...devices, ...devices] }, "PROBE_SELECTION_REQUIRED");
    fails(
        { ...config, probeSerial: "123456789" },
        { available: true, devices: [...devices, ...devices] },
        "PROBE_IDENTITY_AMBIGUOUS"
    );
    assert.strictEqual(resolveProbeConnection({ ...config, probeSerial: "12" }, unavailable).probeSerial, "12");
    for (const value of ["1; shutdown", "-1", "4294967296", "1.5"])
        assert.throws(() => normalizeProbeSerial(value, "jlink"));
    for (const value of [-1, 1.5, Infinity, "100; shutdown"]) assert.throws(() => normalizeAdapterSpeed(value));

    const launch = {
        executable: "openocd",
        probePath: "/scripts/interface/jlink.cfg",
        targetPath: "/scripts/target/stm32f1x.cfg",
        scriptsRoot: "/scripts"
    };
    const calls = [];
    const options = {
        stat: async () => ({ mtimeMs: 1, size: 2 }),
        readFile: async () => "adapter driver jlink",
        run: async (_exe, args) => {
            calls.push(args);
            if (args.includes("-f")) return "EP_ADAPTER_NAME=jlink\nEP_PROFILE_BEGIN\nEP_PROFILE_END\n";
            return "EP_ADAPTERS_BEGIN\njlink { jtag swd } st-link { dapdirect_swd }\nEP_ADAPTERS_END";
        }
    };
    assert.deepStrictEqual(parseAdapterList("EP_ADAPTERS_BEGIN\njlink st-link\nEP_ADAPTERS_END"), ["jlink", "st-link"]);
    const numberedAdapters =
        "EP_ADAPTERS_BEGIN\nThe following debug adapters are available:\n1: dummy\n12: jlink\n23: cmsis-dap\n\nEP_ADAPTERS_END";
    assert.deepStrictEqual(parseAdapterList(numberedAdapters), ["dummy", "jlink", "cmsis-dap"]);
    assert.strictEqual(parseAdapterList(numberedAdapters.replace("12: jlink", "12: ???")), null);
    assert.strictEqual(
        (
            await checkAdapterCapability(launch, {
                ...options,
                run: async (_exe, args) =>
                    args.includes("-f") ? "EP_ADAPTER_NAME=jlink\nEP_PROFILE_BEGIN\nEP_PROFILE_END\n" : numberedAdapters
            })
        ).adapterFamily,
        "jlink"
    );
    assert.strictEqual((await checkAdapterCapability(launch, options)).adapterFamily, "jlink");
    assert(
        calls.every((args) => args.includes("noinit") && !args.includes("init") && !args.includes(launch.targetPath))
    );
    await assert.rejects(
        checkAdapterCapability(launch, {
            ...options,
            run: async () => "EP_ADAPTERS_BEGIN\ncmsis-dap { swd }\nEP_ADAPTERS_END"
        }),
        (error) => error.code === "PROBE_DRIVER_MISSING"
    );
    const readyInventory = {
        available: true,
        devices: [
            {
                ...devices[0],
                interfaces: [{ ...devices[0].interfaces[0], service: "usbccgp" }, devices[0].interfaces[2]]
            }
        ]
    };
    const prepared = await prepareProbeConnection(config, {
        resolveLaunch: () => launch,
        checkCapability: async () => ({ adapterFamily: "jlink" }),
        resolveTransport: async (_launch, transport) => transport,
        listProbes: async () => readyInventory
    });
    assert.strictEqual(prepared.probeSerial, "123456789");
    const args = buildOpenOcdConfigArgs(launch, "swd", { probeSerial: "1234", adapterSpeedKhz: 100 });
    const order = [
        launch.probePath,
        "adapter serial 1234",
        "transport select swd",
        launch.targetPath,
        "adapter speed 100"
    ].map((item) => args.indexOf(item));
    assert(
        order.every((index, i) => index >= 0 && (!i || index > order[i - 1])),
        "connection order is interface/serial/transport/target/speed"
    );

    await scenario("Keep cross-platform USB identities, serials, sysfs errors and budgets consistent", async () => {
        const fs = require("fs/promises");
        const {
            listProbes,
            listLinuxUsbRows,
            parseWindowsInventory,
            parseMacInventory,
            USB_INVENTORY
        } = require("../skills/_emberprobe/probe-inventory");
        const { usbInventory, probeCandidates } = require("../skills/_emberprobe/probe-detection");
        const { normalizeProbeSerial, resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
        const { prepareProbeConnection } = require("../skills/_emberprobe/probe-preflight");
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
            const linux = await listProbes(
                sysfs({ "1-2": { idVendor: "0483", idProduct: pid, serial: "000Ab123\n" } })
            );
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
            ["cmsis-dap", "jlink", "stlink", "xds110", "nulink"]
        );
        assert.deepStrictEqual(
            inventory.devices.map((device) => device.serial),
            ["000Aa1", "123", "000Bc2", "", ""]
        );
        assert.strictEqual(inventory.devices[0].interfaces.length, 2);
        assert(!fixture.reads.some((name) => /outside|bad|usb1|1-7/.test(name)));
        const text = await usbInventory({
            ...fixture,
            run: () => assert.fail("A successful sysfs query must not invoke lsusb")
        });
        assert(text.includes("CMSIS-DAP v2") && text.includes("Nu-Link") && text.includes("XDS110"));
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
        assert.strictEqual(resolveProbeConnection({ probe: "stlink.cfg" }, missingSerial).adapterSerial, "");
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
    });

    await scenario("Skip unreadable Linux USB devices without failing probe selection", async () => {
        const { usbInventory, detectProbe } = require("../skills/_emberprobe/probe-detection");
        const hang = () => new Promise(() => {});
        // Issue #39: a target's own USB CDC device stalls sysfs reads while the probe stays readable.
        function sysfs(devices) {
            return {
                platform: "linux",
                timeoutMs: 30,
                readdir: async () => Object.keys(devices),
                readFile: async (filename) => {
                    const value = devices[path.basename(path.dirname(filename))]?.[path.basename(filename)];
                    if (typeof value === "function") return value();
                    if (value instanceof Error) throw value;
                    if (value === undefined) throw Object.assign(new Error("No attribute"), { code: "ENOENT" });
                    return value;
                },
                stat: async () => ({ ino: 7n, ctimeNs: 9n })
            };
        }
        const probe = {
            idVendor: "c251\n",
            idProduct: "f00a\n",
            product: "Horco CMSIS-DAP\n",
            serial: "ABC123\n",
            busnum: "1\n",
            devnum: "4\n"
        };
        const target = { idVendor: "0483\n", idProduct: "5740\n", product: hang, serial: "2059384E5642\n" };
        const hub = { idVendor: "1d6b\n", idProduct: "0002\n", product: Object.assign(new Error(), { code: "EINTR" }) };
        const stalled = sysfs({ "1-1": probe, "1-2": target, "1-3": hub });
        const partial = await listProbes({ ...stalled, family: "cmsis-dap" });
        assert.strictEqual(partial.available, true, partial.notes.join("\n"));
        assert.strictEqual(partial.partial, true);
        assert.deepStrictEqual(
            partial.devices.map((device) => device.serial),
            ["ABC123"]
        );
        assert(partial.notes[0].includes("skipped 2"));
        assert(partial.notes[0].includes("1-2: query timed out") && partial.notes[0].includes("1-3/product: EINTR"));
        const complete = await listProbes({ ...sysfs({ "1-1": probe }), family: "cmsis-dap" });
        assert.strictEqual(complete.partial, undefined);
        assert.deepStrictEqual(complete.notes, []);

        const remembered = (probeSerial) => ({
            probe: "cmsis-dap.cfg",
            target: "stm32h7x.cfg",
            successfulConnection: { version: 2, probe: "cmsis-dap.cfg", probeSerial }
        });
        const present = resolveProbeConnection(remembered("ABC123"), partial);
        assert.strictEqual(present.selection.probe, "remembered");
        assert.strictEqual(present.adapterSerial, "ABC123");
        assert.strictEqual(present.deviceId, "1-1");
        // The skipped device could be the remembered probe, so OpenOCD enforces the serial instead.
        const absent = resolveProbeConnection(remembered("OTHER1"), partial);
        assert.strictEqual(absent.adapterSerial, "OTHER1");
        assert.strictEqual(absent.selection.inventory, "unconfirmed");
        assert.throws(() => resolveProbeConnection(remembered("OTHER1"), complete), {
            code: "PROBE_SELECTED_NOT_FOUND"
        });
        const stlink = await listProbes({ ...stalled, family: "stlink" });
        assert.strictEqual(stlink.partial, true);
        assert.strictEqual(
            resolveProbeConnection({ probe: "stlink.cfg", probeSerial: "ST1" }, stlink).selection.inventory,
            "unconfirmed"
        );
        assert.throws(
            () => resolveProbeConnection({ probe: "stlink.cfg", probeSerial: "ST1" }, { ...stlink, partial: false }),
            { code: "PROBE_SELECTED_NOT_FOUND" }
        );
        const unique = resolveProbeConnection({ probe: "cmsis-dap.cfg" }, partial);
        assert.strictEqual(unique.selection.probe, "unique-device");
        assert.strictEqual(unique.adapterSerial, "ABC123");

        // A serial-less probe stays connectable, but its attachment cannot authorize writes while another
        // device that might be a probe was skipped.
        const anonymous = { ...probe, serial: "\n" };
        const anonymousPartial = await listProbes({
            ...sysfs({ "1-1": anonymous, "1-2": target }),
            family: "cmsis-dap"
        });
        const anonymousComplete = await listProbes({ ...sysfs({ "1-1": anonymous }), family: "cmsis-dap" });
        assert.strictEqual(anonymousPartial.devices[0].attachmentId, "1:4:7:9");
        assert.strictEqual(
            resolveProbeConnection({ probe: "cmsis-dap.cfg" }, anonymousPartial).selectionIdentity.attachmentId,
            ""
        );
        assert.strictEqual(
            resolveProbeConnection({ probe: "cmsis-dap.cfg" }, anonymousComplete).selectionIdentity.attachmentId,
            "1:4:7:9"
        );

        // Probe type detection uses the same scan.
        const detected = await detectProbe({
            platform: "linux",
            listProbes: (query) => listProbes({ ...stalled, ...query })
        });
        assert.strictEqual(detected.probe, "cmsis-dap.cfg");
        assert(detected.notes.some((note) => note.includes("incomplete")));
        const names = await usbInventory({
            ...stalled,
            run: () => assert.fail("Readable sysfs must not invoke lsusb")
        });
        assert(names.includes("Horco CMSIS-DAP"));

        // Nothing readable at all is still an unavailable inventory.
        const nothing = await listProbes({ ...sysfs({ "1-2": target, "1-3": hub }), family: "all" });
        assert.strictEqual(nothing.available, false);
        assert.strictEqual(nothing.partial, undefined);
    });

    await scenario("Reuse interface profiles and transports only for unchanged self-contained scripts", async () => {
        const { resolveInterfaceTransport } = require("../skills/_emberprobe/probe-preflight");
        const launch = {
            executable: "openocd",
            probePath: "/scripts/interface/jlink.cfg",
            targetPath: "/scripts/target/stm32f4x.cfg",
            scriptsRoot: "/scripts"
        };
        let script = "# source [find other.cfg] is only a comment\nadapter driver jlink";
        let mtimeMs = 1;
        let starts = 0;
        const cache = new Map();
        const options = {
            cache,
            stat: async () => ({ mtimeMs, size: 2 }),
            readFile: async () => script,
            run: async (_exe, args) => {
                if (!args.includes("-f")) return "EP_ADAPTERS_BEGIN\njlink { jtag swd }\nEP_ADAPTERS_END";
                starts++;
                return "EP_ADAPTER_NAME=jlink\nEP_PROFILE_BEGIN\nEP_PROFILE_END\n";
            }
        };
        const first = await checkAdapterCapability(launch, options);
        const again = await checkAdapterCapability(launch, options);
        assert.strictEqual(starts, 1, "an unchanged script reuses its interface profile");
        assert.strictEqual(again.profile.fingerprint, first.profile.fingerprint);
        assert(first.cacheKey && again.cacheKey === first.cacheKey);
        script += "\nadapter speed 4000";
        await checkAdapterCapability(launch, options);
        mtimeMs = 2;
        await checkAdapterCapability(launch, options);
        assert.strictEqual(starts, 3, "changed script text or OpenOCD build is profiled again");
        script = "source [find interface/jlink.cfg]";
        const sourced = await checkAdapterCapability(launch, options);
        await checkAdapterCapability(launch, options);
        assert.strictEqual(starts, 5, "a script that loads other files is profiled every time");
        assert.strictEqual(sourced.cacheKey, "");
        const unresolved = {
            ...options,
            run: async (_exe, args) => (args.includes("-f") ? "" : options.run(_exe, args))
        };
        script = "adapter driver jlink\n# unresolved";
        await assert.rejects(
            checkAdapterCapability(launch, unresolved),
            (error) => error.code === "PROBE_CAPABILITY_UNKNOWN"
        );
        await checkAdapterCapability(launch, options);
        assert.strictEqual(starts, 6, "an unresolved profile is not remembered");

        let queries = 0;
        const query = async () => {
            queries++;
            return "EP_TRANSPORT=swd\n";
        };
        assert.strictEqual(await resolveInterfaceTransport(launch, "auto", query, cache, first.cacheKey), "swd");
        assert.strictEqual(await resolveInterfaceTransport(launch, "auto", query, cache, first.cacheKey), "swd");
        assert.strictEqual(await resolveInterfaceTransport(launch, "swd", query, cache, first.cacheKey), "swd");
        assert.strictEqual(queries, 2, "each requested transport is queried once per cached script");
        await resolveInterfaceTransport(launch, "auto", query, cache, "");
        assert.strictEqual(queries, 3, "an uncached script is queried every time");
        await assert.rejects(
            resolveInterfaceTransport(launch, "jtag", async () => "EP_TRANSPORT=swd\n", cache, first.cacheKey),
            (error) => error.code === "PROBE_CAPABILITY_UNKNOWN"
        );
        assert(!("transport:jtag" in cache.get(first.cacheKey)), "a rejected transport is not remembered");

        const passed = [];
        await prepareProbeConnection(
            { probe: "jlink.cfg", target: "stm32f4x.cfg", transport: "auto" },
            {
                resolveLaunch: () => launch,
                checkCapability: async () => ({ adapterFamily: "jlink", cache, cacheKey: first.cacheKey }),
                resolveTransport: async (...args) => {
                    passed.push(args.slice(3));
                    return "swd";
                },
                listProbes: async () => ({ available: false, devices: [], notes: [] }),
                platform: "linux"
            }
        );
        assert.deepStrictEqual(passed, [[cache, first.cacheKey]]);
    });

    await scenario("Open HID-only Windows CMSIS-DAP probes through the HID backend", async () => {
        const { createProbeProfile } = require("../skills/_emberprobe/probe-profile");
        const device = (services) => ({
            id: "USB\\VID_C251&PID_F001\\LU_2022_8888",
            family: "cmsis-dap",
            serial: "LU_2022_8888",
            descriptorSerial: "LU_2022_8888",
            serialSource: "os-instance",
            interfaces: services.map((service, index) => ({ instanceId: `i${index}`, service }))
        });
        const resolve = (services, events = []) =>
            resolveProbeConnection(
                {
                    probe: "cmsis-dap.cfg",
                    target: "stm32h7x.cfg",
                    profile: createProbeProfile("cmsis-dap", events, "cmsis-dap.cfg")
                },
                { available: true, devices: [device(services)] }
            );
        const hid = resolve(["usbccgp", "HidUsb", "", "usbser"]);
        assert.strictEqual(hid.adapterBackend, "hid");
        assert.strictEqual(resolve(["usbccgp", "HidUsb", "WinUSB"]).adapterBackend, undefined);
        assert.strictEqual(resolve(["usbccgp", "WinUSB"]).adapterBackend, undefined);
        assert.strictEqual(resolve([]).adapterBackend, undefined, "a non-Windows inventory gives no hint");
        assert.strictEqual(
            resolve(["HidUsb"], [["cmsis-dap backend", "usb_bulk"]]).adapterBackend,
            undefined,
            "a backend chosen by the interface script is kept"
        );
        const launch = {
            probePath: "/s/interface/cmsis-dap.cfg",
            targetPath: "/s/target/stm32h7x.cfg",
            scriptsRoot: "/s"
        };
        const args = buildOpenOcdConfigArgs(launch, "auto", hid);
        assert.strictEqual(args[args.indexOf(launch.probePath) + 2], "cmsis-dap backend hid");
        assert(!buildOpenOcdConfigArgs(launch, "auto", {}).includes("cmsis-dap backend hid"));
    });

    console.log("Probe inventory, identity and preflight tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
