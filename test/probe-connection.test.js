"use strict";
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
            if (file.endsWith("serial")) return "1234\n";
            throw new Error("unreadable optional attribute");
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
    fails(config, unavailable, "PROBE_SELECTION_REQUIRED");
    fails({ ...config, probeSerial: "12" }, inventory, "PROBE_SELECTED_NOT_FOUND");
    fails(config, { available: true, devices: [...devices, ...devices] }, "PROBE_SELECTION_REQUIRED");
    fails(
        { ...config, probeSerial: "123456789" },
        { available: true, devices: [...devices, ...devices] },
        "PROBE_IDENTITY_AMBIGUOUS"
    );
    assert.strictEqual(resolveProbeConnection({ ...config, probeSerial: "12" }, unavailable).probeSerial, "12");
    for (const value of ["1; shutdown", "-1", "4294967296", "1.5"]) assert.throws(() => normalizeProbeSerial(value));
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
            if (args.includes("-f")) return "EP_ADAPTER_NAME=jlink\n";
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
                run: async (_exe, args) => (args.includes("-f") ? "EP_ADAPTER_NAME=jlink\n" : numberedAdapters)
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
    console.log("Probe inventory, identity and preflight tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
