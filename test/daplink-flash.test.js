"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { spawnSync } = require("child_process");
const { normalizeProbeSerial, resolveProbeConnection } = require("../skills/_emberprobe/probe-connection");
const {
    listProbes,
    parseWindowsInventory,
    parseMacInventory,
    USB_INVENTORY
} = require("../skills/_emberprobe/probe-inventory");
const { prepareProbeConnection } = require("../skills/_emberprobe/probe-preflight");
const { buildOpenOcdConfigArgs } = require("../skills/_emberprobe/openocd-launch");
const { buildFlashProgramCommand, flashPhaseFromLine } = require("../skills/_emberprobe/openocd-flash");
const { diagnoseOpenOcdFailure } = require("../skills/_emberprobe/openocd-diagnostics");
const { FlashAuthorization } = require("../src/flashAuthorization");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { ProbeCoordinator } = require("../src/probeCoordinator");

const serial = "000Aa123";
const launch = {
    executable: "fake",
    probePath: "/interface/cmsis-dap.cfg",
    targetPath: "/target/stm32f4x.cfg",
    scriptsRoot: "/scripts",
    cwd: "/scripts"
};

async function identities() {
    assert.strictEqual(normalizeProbeSerial(serial), serial);
    assert.strictEqual(normalizeProbeSerial("000123", "jlink"), "123");
    for (const value of ["x;shutdown", "[shutdown]", "$env", "x y", "x\ny", "a".repeat(129)])
        assert.throws(() => normalizeProbeSerial(value), { code: "PROBE_SERIAL_INVALID" });
    for (const [adapterFamily, family, probe] of [
        ["cmsis-dap", "cmsis-dap", "cmsis-dap.cfg"],
        ["hla", "stlink", "stlink.cfg"],
        ["st-link", "stlink", "stlink.cfg"]
    ]) {
        const device = { family, serial, id: "usb-1" };
        const inventory = { available: true, devices: [device], notes: [] };
        const config = { probe, target: "stm32f4x.cfg", adapterFamily };
        const prepared = await prepareProbeConnection(config, {
            resolveLaunch: () => launch,
            checkCapability: async () => ({ adapterFamily }),
            listProbes: async (options) => {
                assert.strictEqual(options.family, family);
                return inventory;
            }
        });
        assert.strictEqual(prepared.probeSerial, serial);
        assert.strictEqual(prepared.deviceId, device.id);
        const two = { ...inventory, devices: [device, { ...device, serial: "other", id: "usb-2" }] };
        assert.throws(() => resolveProbeConnection(config, two), { code: "PROBE_SELECTION_REQUIRED" });
        assert.strictEqual(resolveProbeConnection({ ...config, probeSerial: serial }, two).deviceId, "usb-1");
        assert.throws(() => resolveProbeConnection({ ...config, probeSerial: "missing" }, inventory), {
            code: "PROBE_SELECTED_NOT_FOUND"
        });
        assert.throws(
            () => resolveProbeConnection({ ...config, probeSerial: serial }, { ...two, devices: [device, device] }),
            { code: "PROBE_IDENTITY_AMBIGUOUS" }
        );
        assert.throws(
            () =>
                resolveProbeConnection(
                    { ...config, probeSerial: serial },
                    { ...two, devices: [device, { ...device, serial: "" }] }
                ),
            { code: "PROBE_IDENTITY_AMBIGUOUS" }
        );
        assert.throws(() => resolveProbeConnection(config, { available: false, devices: [] }), {
            code: "PROBE_SELECTION_REQUIRED"
        });
        assert.strictEqual(
            resolveProbeConnection({ ...config, probeSerial: serial }, { available: false, devices: [] }).probeSerial,
            serial
        );
        let saved;
        const service = new ProbeConnectionService({
            getConfig: () => config,
            saveSuccessfulConnection: async (value) => {
                saved = value;
            }
        });
        await service.recordSuccess(prepared);
        assert.strictEqual(saved.probeSerial, serial);
        const remembered = { ...config, successfulConnection: saved };
        assert.throws(() => resolveProbeConnection(remembered, { available: true, devices: [] }), {
            code: "PROBE_SELECTED_NOT_FOUND"
        });
        const authorization = new FlashAuthorization();
        const plan = { ...config, probeSerial: serial, elf: { path: "/firmware.elf", sha256: "abc" } };
        const pending = authorization.authorize(plan);
        assert.throws(() => authorization.authorize({ ...plan, probeSerial: "other" }, pending.confirmationId), {
            code: "FLASH_CONFIRMATION_INVALID"
        });
    }
}

async function inventory() {
    const root = `USB\\VID_0D28&PID_0204\\${serial}`;
    const rows = [
        { instanceId: root, name: "USB Composite Device", containerId: "dap-container" },
        {
            instanceId: "USB\\VID_0D28&PID_0204&MI_00\\location",
            parentId: root,
            name: "CMSIS-DAP",
            containerId: "dap-container"
        },
        {
            instanceId: "HID\\VID_0D28&PID_0204&MI_00\\location",
            parentId: "USB\\VID_0D28&PID_0204&MI_00\\location",
            name: "CMSIS-DAP",
            containerId: "dap-container"
        },
        { instanceId: "USB\\VID_0483&PID_374B\\000aBc", name: "ST-Link" }
    ];
    const devices = parseWindowsInventory(JSON.stringify(rows), "all");
    assert.strictEqual(devices.length, 2);
    assert.strictEqual(devices[0].serial, serial);
    assert.strictEqual(devices[0].interfaces.length, 3);
    assert.strictEqual(devices[1].serial, "000aBc");
    assert.strictEqual(parseWindowsInventory(JSON.stringify(rows), "cmsis-dap").length, 1);
    assert(!USB_INVENTORY.includes("-like 'USB\\VID_1366*'"));
    const win = await listProbes({
        platform: "win32",
        family: "cmsis-dap",
        run: async (_cmd, args) => {
            assert.strictEqual(args[3], USB_INVENTORY);
            return JSON.stringify(rows);
        }
    });
    assert.strictEqual(win.devices[0].serial, serial);
    const mac = parseMacInventory(
        JSON.stringify({
            _items: [{ vendor_id: "0x0d28", product_id: "0x0204", _name: "CMSIS-DAP", serial_num: serial }]
        }),
        "all"
    );
    assert.strictEqual(mac[0].serial, serial);
    const linux = await listProbes({
        platform: "linux",
        family: "all",
        readdir: async () => ["1-2"],
        readFile: async (file) =>
            ({ idVendor: "0d28", idProduct: "0204", serial, product: "DAPLink" })[path.basename(file)]
    });
    assert.strictEqual(linux.devices[0].serial, serial);

    // Real C251:F001 layout: generic localized names and an HID grandchild.
    // Root properties can be absent, while Windows parent IDs use different casing.
    const c251Root = "USB\\VID_C251&PID_F001\\0001A0000000";
    const c251Interface = "USB\\VID_C251&PID_F001&MI_02\\8&location&0&0002";
    const c251Rows = [
        { instanceId: c251Interface, name: "USB 输入设备", parentId: c251Root, containerId: "dap" },
        { instanceId: c251Root, name: "USB Composite Device" },
        {
            instanceId: "HID\\VID_C251&PID_F001&MI_02\\9&location&0&0000",
            name: "符合 HID 标准的供应商定义设备",
            parentId: c251Interface.toLowerCase(),
            containerId: "dap"
        },
        {
            instanceId: "USB\\VID_C251&PID_F001&MI_00\\8&location&0&0000",
            name: "USB 串行设备 (COM5)",
            parentId: c251Root,
            containerId: "dap"
        },
        { instanceId: "HID\\VID_1234&PID_5678\\unrelated", name: "HID Keyboard Device" }
    ];
    const c251Inventory = { available: true, devices: parseWindowsInventory(JSON.stringify(c251Rows), "all") };
    assert.strictEqual(c251Inventory.devices.length, 1);
    assert.strictEqual(c251Inventory.devices[0].interfaces.length, 4);
    assert.strictEqual(c251Inventory.devices[0].serial, "0001A0000000");
    const chosen = resolveProbeConnection({ probe: "cmsis-dap.cfg", target: "stm32h7x.cfg" }, c251Inventory);
    assert.strictEqual(chosen.probeSerial, "0001A0000000");
    assert.strictEqual(chosen.deviceId, c251Root);
    assert(buildOpenOcdConfigArgs(launch, "auto", chosen).includes("adapter serial 0001A0000000"));
    for (const pid of ["f001", "f002", "2722", "2750"]) {
        const macDevice = parseMacInventory(JSON.stringify({ vendor_id: "0xc251", product_id: `0x${pid}` }), "all");
        assert.strictEqual(macDevice[0].family, "cmsis-dap");
        const linuxDevice = await listProbes({
            platform: "linux",
            family: "cmsis-dap",
            readdir: async () => ["1-2"],
            readFile: async (file) =>
                ({ idVendor: "c251", idProduct: pid, serial: "0001A0000000", product: "USB device" })[
                    path.basename(file)
                ]
        });
        assert.strictEqual(linuxDevice.devices[0].serial, "0001A0000000");
    }
    assert.deepStrictEqual(parseMacInventory(JSON.stringify({ vendor_id: "0xc251", product_id: "0xf099" }), "all"), []);
    if (process.platform === "win32") {
        const fixtureJson = JSON.stringify(c251Rows).replace(/'/g, "''");
        const mock = `$fixture = '${fixtureJson}' | ConvertFrom-Json; $propertyCalls = 0;
function Get-PnpDevice { [CmdletBinding()] param([switch]$PresentOnly) $fixture }
function Get-PnpDeviceProperty { [CmdletBinding()] param([string[]]$InstanceId, [string[]]$KeyName)
 $script:propertyCalls++;
 if ($script:propertyCalls -eq 1 -and $InstanceId.Count -ne 4) { throw 'Probe properties must be batched without unrelated devices' };
 if ($script:propertyCalls -gt 1 -and $KeyName.Count -ne 2) { throw 'Only missing identity properties may be retried' };
 foreach ($row in $fixture) { foreach ($key in @('Parent', 'ContainerId')) {
  if ($InstanceId -notcontains $row.instanceId) { continue };
  $value = if ($key -eq 'Parent') { $row.parentId } else { $row.containerId };
  if ($value) { [pscustomobject]@{ InstanceId=$row.instanceId; KeyName='DEVPKEY_Device_' + $key; Data=$value } }
 } }
}`;
        const query = spawnSync(
            path.join(
                process.env.SystemRoot || "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe"
            ),
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `${mock}; ${USB_INVENTORY}; if ($propertyCalls -ne 2) { exit 9 }`
            ],
            { encoding: "utf8", windowsHide: true, timeout: 10000 }
        );
        assert.strictEqual(query.status, 0, query.error?.message || query.stderr);
        assert.strictEqual(query.stderr.trim(), "", "Missing optional properties must not produce indexing errors");
        const parsed = parseWindowsInventory(query.stdout, "all");
        assert.strictEqual(parsed.length, 1);
        assert.strictEqual(parsed[0].serial, chosen.probeSerial);
        assert.strictEqual(parsed[0].interfaces.length, 4);
    }
}

async function processLifetime() {
    const filename = path.resolve(__dirname, "../src/openocdRunner.js");
    const localRequire = createRequire(filename);
    const mod = { exports: {} };
    let child;
    const overrides = {
        "./openocdScripts": { ...localRequire("./openocdScripts"), resolveOpenOcdLaunch: () => launch },
        child_process: {
            spawn: () => {
                child = new EventEmitter();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.exitCode = null;
                child.signalCode = null;
                child.kill = () => {
                    child.killed = true;
                };
                return child;
            }
        }
    };
    vm.runInThisContext("(function(require,module,exports){" + fs.readFileSync(filename, "utf8") + "\n})", {
        filename
    })((name) => overrides[name] || localRequire(name), mod, mod.exports);
    const vscode = {
        EventEmitter: class {
            fire() {}
        },
        window: { createTerminal: () => ({ show() {}, dispose() {} }) }
    };
    for (const mode of ["timeout", "output"]) {
        const coordinator = new ProbeCoordinator();
        const lease = coordinator.acquire("download");
        let settled = false;
        const options = {
            executable: "fake",
            elf: "/firmware.elf",
            probe: "cmsis-dap.cfg",
            target: "stm32f4x.cfg",
            probeSerial: serial,
            timeoutMs: mode === "timeout" ? 10 : 1000
        };
        const pending = mod.exports
            .runOpenOcd(vscode, options, () => {})
            .finally(() => {
                settled = true;
                lease.release();
            });
        const rejected = assert.rejects(
            pending,
            (error) =>
                error.code === (mode === "timeout" ? "OPENOCD_TIMEOUT" : "OPENOCD_OUTPUT_LIMIT") &&
                error.stage === "reset_init" &&
                error.details.resultUnknown &&
                error.details.openocdTail.includes("EP_FLASH_STAGE=reset_init")
        );
        child.stderr.write("EP_FLASH_STAGE=reset_init\n");
        if (mode === "output") child.stderr.write("x".repeat(65537));
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.strictEqual(settled, false);
        assert.strictEqual(child.killed, true);
        assert.throws(() => coordinator.acquire("debugStart"), { code: "PROBE_BUSY" });
        await assert.rejects(
            mod.exports.runOpenOcd(vscode, options, () => {}),
            { code: "PROBE_BUSY" }
        );
        child.exitCode = 1;
        child.emit("close", 1);
        await rejected;
        assert.strictEqual(coordinator.anyActive(), false);
    }
}

(async () => {
    await identities();
    await inventory();
    await processLifetime();
    const args = buildOpenOcdConfigArgs(launch, "swd", { probeSerial: serial, adapterSpeedKhz: 100 });
    assert(args.includes(`adapter serial ${serial}`));
    const cap = args.find((arg) => arg.includes("proc _ep_speed_event"));
    assert(cap.includes("local proc adapter") && cap.includes("upcall adapter"));
    assert(cap.includes("cget -event") && cap.includes("reset-init"));
    assert(!buildOpenOcdConfigArgs(launch, "auto").some((arg) => arg.includes("_ep_speed_event")));
    assert(buildFlashProgramCommand('"a b.elf"').includes("upcall reset"));
    assert.strictEqual(flashPhaseFromLine("EP_FLASH_STAGE=reset_run"), "reset_run");
    const result = diagnoseOpenOcdFailure([
        "EP_FLASH_STAGE=reset_init",
        "** Programming Started **",
        "** Verify Started **",
        "Error: timeout"
    ]);
    assert.strictEqual(result.stage, "verify");
    assert.strictEqual(result.code, "OPENOCD_CONNECTION_TIMEOUT");
    console.log("DAPLink/ST-Link identity, speed policy, flash phases and lease lifetime tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
