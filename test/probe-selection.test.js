"use strict";
const assert = require("assert");
const {
    createProbeProfile,
    captureProfileScript,
    PRINT_PROFILE,
    parseProfileEvents,
    normalizeInventoryQuery
} = require("../skills/_emberprobe/probe-profile");
const {
    resolveProbeConnection,
    assertWriteIdentity,
    normalizeProbeSerial
} = require("../skills/_emberprobe/probe-connection");
const { prepareProbeConnection, checkAdapterCapability } = require("../skills/_emberprobe/probe-preflight");
const {
    parseWindowsInventory,
    parseMacInventory,
    attachMacRegistryIds,
    listLinuxUsbRows,
    listProbes
} = require("../skills/_emberprobe/probe-inventory");
const { buildOpenOcdConfigArgs } = require("../skills/_emberprobe/openocd-launch");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { FlashAuthorization } = require("../src/flashAuthorization");
const { WriteAuthorization } = require("../src/writeAuthorization");
const { detectProbe } = require("../skills/_emberprobe/probe-detection");

const launch = {
    executable: "mock",
    probePath: "/scripts/interface/mock.cfg",
    targetPath: "/scripts/target/test.cfg",
    scriptsRoot: "/scripts"
};
const inventory = (devices, available = true) => ({ available, devices, notes: [] });
function profileOutput(events) {
    const hex = (word) => [...word].map((char) => char.codePointAt(0).toString(16).padStart(6, "0")).join("");
    return (
        "EP_PROFILE_BEGIN\n" +
        events.map((words) => "EP_PROFILE_WORD=" + words.map(hex).join(":")).join("\n") +
        "\nEP_PROFILE_END\n"
    );
}

async function main() {
    const cloneId = "USB\\VID_0483&PID_3748\\5&26B53364&0&3";
    const clone = parseWindowsInventory(
        JSON.stringify({ instanceId: cloneId, name: "ST-Link", attachmentId: "arrival-1" }),
        "all"
    );
    assert.strictEqual(clone[0].serial, "");
    const anonymous = resolveProbeConnection({ probe: "stlink.cfg" }, inventory(clone));
    assert.strictEqual(anonymous.deviceId, cloneId);
    assert.strictEqual(anonymous.adapterSerial, "");
    assert.strictEqual(anonymous.selectionIdentity.attachmentId, "arrival-1");
    assertWriteIdentity(anonymous);
    assert(!buildOpenOcdConfigArgs(launch, "auto", anonymous).some((arg) => arg.startsWith("adapter serial")));
    assert.throws(
        () => assertWriteIdentity({ selectionIdentity: { ...anonymous.selectionIdentity, attachmentId: "" } }),
        { code: "PROBE_IDENTITY_UNVERIFIED" }
    );
    // Without OS inventory OpenOCD keeps the interface default; the write guard still applies.
    const unlisted = resolveProbeConnection({ probe: "stlink.cfg" }, inventory(clone, false));
    assert.strictEqual(unlisted.selection.probe, "script-default");
    assert.strictEqual(unlisted.adapterSerial, "");
    assert.throws(() => assertWriteIdentity(unlisted), { code: "PROBE_IDENTITY_UNVERIFIED" });
    assert.strictEqual(
        resolveProbeConnection({ probe: "stlink.cfg" }, inventory([])).selection.probe,
        "script-default"
    );
    assert.throws(
        () => resolveProbeConnection({ probe: "stlink.cfg" }, inventory([...clone, { ...clone[0], id: "other" }])),
        { code: "PROBE_SELECTION_REQUIRED" }
    );

    const atk = parseWindowsInventory(
        JSON.stringify({
            instanceId: "USB\\VID_04D8&PID_00DF\\ATK_20190528",
            name: "CMSIS-DAP",
            attachmentId: "arrival-2"
        }),
        "all"
    );
    for (const successfulConnection of [
        undefined,
        { version: 1, probe: "cmsis-dap.cfg", probeSerial: "ATK_20190528" }
    ]) {
        const result = resolveProbeConnection({ probe: "cmsis-dap.cfg", successfulConnection }, inventory(atk));
        assert.strictEqual(result.adapterSerial, "");
        assert.strictEqual(result.selectionIdentity.anonymous, true);
    }
    const explicit = resolveProbeConnection({ probe: "cmsis-dap.cfg", probeSerial: "ATK 20190528" }, inventory(atk));
    assert.throws(
        () =>
            resolveProbeConnection(
                {
                    probe: "cmsis-dap.cfg",
                    successfulConnection: { version: 1, probe: "cmsis-dap.cfg", probeSerial: "ATK_20190528" }
                },
                inventory([...atk, { ...atk[0], id: "other-usb", serial: "OTHER_SERIAL" }])
            ),
        { code: "PROBE_SELECTION_REQUIRED" }
    );
    // An explicit true serial selects its Windows alias among several probes.
    const twoAtk = [...atk, { ...atk[0], id: "USB\VID_04D8&PID_00DF\ATK_20190529", serial: "ATK_20190529" }];
    const chosen = resolveProbeConnection({ probe: "cmsis-dap.cfg", probeSerial: "ATK 20190528" }, inventory(twoAtk));
    assert.strictEqual(chosen.deviceId, atk[0].id);
    assert.strictEqual(chosen.adapterSerial, "ATK 20190528");
    // A serial that matches no inexact alias is left to OpenOCD and binds no unrelated device.
    const unmatched = resolveProbeConnection({ probe: "cmsis-dap.cfg", probeSerial: "OTHER" }, inventory(twoAtk));
    assert.strictEqual(unmatched.deviceId, "");
    assert.strictEqual(unmatched.selection.inventory, "unconfirmed");
    // Windows aliases without "_" are exact serials, so remembered probes keep working with several devices.
    const daplinks = ["0240000034544E45", "0240000034544E46"].map((serial) => ({
        id: "USB\VID_0D28&PID_0204\\" + serial,
        family: "cmsis-dap",
        vid: "0d28",
        pid: "0204",
        serial,
        serialSource: "os-instance"
    }));
    const rememberedDap = resolveProbeConnection(
        {
            probe: "cmsis-dap.cfg",
            successfulConnection: { version: 1, probe: "cmsis-dap.cfg", probeSerial: daplinks[1].serial }
        },
        inventory(daplinks)
    );
    assert.strictEqual(rememberedDap.adapterSerial, daplinks[1].serial);
    assert.strictEqual(rememberedDap.selectionIdentity.anonymous, false);
    // Without inventory a remembered serial is still enforced by OpenOCD rather than dropped.
    const offline = resolveProbeConnection(
        {
            probe: "cmsis-dap.cfg",
            successfulConnection: { version: 1, probe: "cmsis-dap.cfg", probeSerial: daplinks[1].serial }
        },
        inventory([], false)
    );
    assert.strictEqual(offline.adapterSerial, daplinks[1].serial);
    // A changed interface configuration drops the remembered device and says why the user must pick again.
    const dapProfile = createProbeProfile("cmsis-dap", [["adapter driver", "cmsis-dap"]]);
    assert.throws(
        () =>
            resolveProbeConnection(
                {
                    probe: "cmsis-dap.cfg",
                    profile: dapProfile,
                    successfulConnection: {
                        version: 2,
                        probe: "cmsis-dap.cfg",
                        probeSerial: daplinks[1].serial,
                        profile: "f".repeat(64)
                    }
                },
                inventory(daplinks)
            ),
        (error) =>
            error.code === "PROBE_SELECTION_REQUIRED" &&
            error.i18nKey === "probe.rememberedProfileChanged" &&
            error.details.rememberedProfileChanged === true
    );
    assert.throws(
        () => resolveProbeConnection({ probe: "cmsis-dap.cfg", profile: dapProfile }, inventory(daplinks)),
        (error) => error.code === "PROBE_SELECTION_REQUIRED" && error.i18nKey === "probe.selectionRequired"
    );
    assert.strictEqual(explicit.adapterSerial, "ATK 20190528");
    assert.strictEqual(
        explicit.selectionIdentity.attachmentId,
        "",
        "An exact serial preserves normal authorization reuse after reattachment"
    );
    assert(buildOpenOcdConfigArgs(launch, "auto", explicit).includes('adapter serial "ATK 20190528"'));
    for (const serial of ["a;shutdown", "[shutdown]", "$env", "a\nb", "a\0b", "x".repeat(129)])
        assert.throws(() => normalizeProbeSerial(serial), { code: "PROBE_SERIAL_INVALID" });
    assert.strictEqual(normalizeProbeSerial("Ab 001"), "Ab 001");
    assert.throws(() => normalizeProbeSerial("Ab 001", "jlink"), { code: "PROBE_SERIAL_INVALID" });
    assert.throws(
        () =>
            resolveProbeConnection(
                {
                    probe: "cmsis-dap.cfg",
                    successfulConnection: { version: 1, probe: "cmsis-dap.cfg", probeSerial: "missing" }
                },
                inventory(atk)
            ),
        { code: "PROBE_SELECTED_NOT_FOUND" }
    );

    let saved;
    let picks = 0;
    const service = new ProbeConnectionService({
        getConfig: () => ({ probe: "stlink.cfg" }),
        getSuccessfulConnection: () => saved,
        saveSuccessfulConnection: async (value) => {
            saved = value;
        },
        window: {
            showQuickPick: async (choices) => {
                picks++;
                return choices[0];
            }
        },
        prepareConnection: async (request) => ({
            ...resolveProbeConnection(request, inventory(clone)),
            inventory: inventory(clone),
            adapterFamily: "st-link"
        })
    });
    await service.recordSuccess(await service.prepare({}));
    assert.deepStrictEqual(saved, {
        version: 3,
        probe: "stlink.cfg",
        probeSerial: "",
        family: "stlink",
        deviceId: String.raw`USB\VID_0483&PID_3748\5&26B53364&0&3`,
        source: "success"
    });
    saved = { version: 1, probe: "stlink.cfg", probeSerial: "old-probe" };
    await assert.rejects(service.prepare({}), { code: "PROBE_SELECTED_NOT_FOUND" });
    assert.strictEqual((await service.prepare({}, true)).adapterSerial, "");
    assert.strictEqual(picks, 1);

    for (const [driver, family, events] of [
        ["xds110", "xds110", []],
        [
            "hla",
            "nulink",
            [
                ["hla layout", "nulink"],
                ["hla device_desc", "Nu-Link"]
            ]
        ],
        ["hla", "ti-icdi", [["hla layout", "ti-icdi"]]],
        [
            "ftdi",
            "ftdi",
            [
                ["ftdi vid_pid", "0x0403", "0x6010"],
                ["ftdi channel", "0"]
            ]
        ],
        ["ft232r", "ft232r", []],
        ["vsllink", "vsllink", []],
        ["kitprog", "kitprog", []]
    ]) {
        const profile = createProbeProfile(driver, events);
        assert.strictEqual(profile.family, family);
        const [vid, pid] = profile.vidPid[0];
        const device = {
            family,
            id: "usb-1",
            serial: "001",
            vid: vid.toString(16).padStart(4, "0"),
            pid: pid.toString(16).padStart(4, "0"),
            attachmentId: "1",
            serialSource: "usb-descriptor"
        };
        let queries = 0;
        const result = await prepareProbeConnection(
            { probe: "custom.cfg", target: "test.cfg" },
            {
                resolveLaunch: () => launch,
                checkCapability: async () => ({ adapterFamily: driver, profile }),
                listProbes: async (query) => {
                    queries++;
                    assert.strictEqual(query.family, family);
                    return inventory([device]);
                }
            }
        );
        assert.strictEqual(queries, 1);
        assert.strictEqual(result.deviceId, "usb-1");
        assert.throws(
            () =>
                resolveProbeConnection(
                    { probe: "custom.cfg", profile },
                    inventory([device, { ...device, id: "usb-2", serial: "002" }])
                ),
            { code: "PROBE_SELECTION_REQUIRED" }
        );
        if (profile.supportsSerial) {
            assert.strictEqual(
                resolveProbeConnection(
                    { probe: "custom.cfg", profile, probeSerial: "002" },
                    inventory([device, { ...device, id: "usb-2", serial: "002" }])
                ).deviceId,
                "usb-2"
            );
        } else {
            // A serial the backend cannot enforce is ignored for a unique device.
            const single = resolveProbeConnection(
                { probe: "custom.cfg", profile, probeSerial: "001" },
                inventory([device])
            );
            assert.strictEqual(single.adapterSerial, "");
            assert.strictEqual(single.selectionIdentity.anonymous, true);
        }
    }
    // Unverified adapters keep pass-through behavior with any explicit serial.
    const unverified = resolveProbeConnection(
        { profile: createProbeProfile("unverified-usb"), probeSerial: "AB 01" },
        inventory([])
    );
    assert.strictEqual(unverified.selectionIdentity.kind, "unknown");
    assert.strictEqual(unverified.adapterSerial, "AB 01");
    assert.strictEqual(createProbeProfile("hla", [["adapter driver", "hla"]], "stlink.cfg").kind, "unknown");
    assert.strictEqual(
        resolveProbeConnection({ profile: createProbeProfile("dummy") }, inventory([])).selectionIdentity.kind,
        "local"
    );
    const tcp = createProbeProfile("cmsis-dap", [
        ["cmsis-dap backend", "tcp"],
        ["cmsis-dap tcp host", "probe.local"],
        ["cmsis-dap tcp port", "5555"]
    ]);
    const remote = await prepareProbeConnection(
        { probe: "custom-tcp.cfg" },
        {
            resolveLaunch: () => launch,
            checkCapability: async () => ({ adapterFamily: "cmsis-dap", profile: tcp }),
            listProbes: () => assert.fail("A TCP probe must not query local USB")
        }
    );
    assert.strictEqual(remote.selectionIdentity.endpoint, "probe.local:5555");
    let tcpSaved;
    await new ProbeConnectionService({
        getConfig: () => ({}),
        saveSuccessfulConnection: async (value) => {
            tcpSaved = value;
        }
    }).recordSuccess(remote);
    assert.strictEqual(tcpSaved.version, 3);
    assert.strictEqual(tcpSaved.profile, tcp.fingerprint);
    assert.strictEqual(tcpSaved.family, "cmsis-dap");
    assert.strictEqual(tcpSaved.deviceId, "", "a network probe has no USB device identity");
    for (const [driver, events] of [
        ["st-link", [["st-link backend", "tcp", "7185"]]],
        [
            "hla",
            [
                ["hla layout", "stlink"],
                ["hla stlink_backend", "tcp", "7185"]
            ]
        ]
    ]) {
        const profile = createProbeProfile(driver, events);
        assert.strictEqual(profile.endpoint, "127.0.0.1:7185");
        const connection = await prepareProbeConnection(
            { probe: "custom.cfg", probeSerial: "001122" },
            {
                resolveLaunch: () => launch,
                checkCapability: async () => ({ adapterFamily: driver, profile }),
                listProbes: () => assert.fail("ST-Link TCP must not query USB")
            }
        );
        assert.strictEqual(connection.adapterSerial, "001122");
        assert.strictEqual(connection.selectionIdentity.serial, "001122");
    }
    assert.deepStrictEqual(
        createProbeProfile("vsllink", [
            ["vsllink usb_vid", "0x1234"],
            ["vsllink usb_pid", "0x5678"]
        ]).vidPid,
        [[0x1234, 0x5678]]
    );
    assert.strictEqual(
        createProbeProfile("cmsis-dap", [["adapter serial", "actual serial"], ["adapter serial"]]).scriptSerial,
        "actual serial"
    );
    assert.throws(() => createProbeProfile("ftdi"), { code: "PROBE_CAPABILITY_UNKNOWN" });
    for (const events of [
        [["cmsis-dap backend", "tcp"]],
        [
            ["cmsis-dap backend", "tcp"],
            ["cmsis-dap tcp host", "bad;host"]
        ]
    ])
        assert.throws(() => createProbeProfile("cmsis-dap", events), { code: "PROBE_ENDPOINT_INVALID" });
    assert.throws(() => createProbeProfile("cmsis-dap", [["cmsis-dap tcp host", "probe.local"]]), {
        code: "PROBE_BACKEND_AMBIGUOUS"
    });

    const flash = new FlashAuthorization();
    const tcpPlan = { ...remote, elf: { path: "firmware.elf", sha256: "test" } };
    const tcpGrant = flash.authorize(tcpPlan);
    assert.throws(
        () =>
            flash.authorize(
                { ...tcpPlan, selectionIdentity: { ...tcpPlan.selectionIdentity, endpoint: "other.local:5555" } },
                tcpGrant.confirmationId
            ),
        { code: "FLASH_CONFIRMATION_INVALID" }
    );
    const plan = { ...anonymous, elf: { path: "firmware.elf", sha256: "test" } };
    const grant = flash.authorize(plan);
    assert.throws(
        () =>
            flash.authorize(
                { ...plan, selectionIdentity: { ...plan.selectionIdentity, attachmentId: "arrival-3" } },
                grant.confirmationId
            ),
        { code: "FLASH_CONFIRMATION_INVALID" }
    );
    const storage = new Map();
    const writes = new WriteAuthorization({
        get: (key) => storage.get(key),
        update: async (key, value) => storage.set(key, value)
    });
    const writePlan = {
        connection: { ...anonymous, target: "test.cfg" },
        elfResult: { elf: { path: "firmware.elf", sha256: "test" } },
        items: []
    };
    const request = writes.authorize(writePlan).response;
    assert.deepStrictEqual(request.choices, ["once"]);
    assert.strictEqual(writes.authorize(writePlan, { confirmationId: request.confirmationId }).mode, "once");
    assert.strictEqual(writes.authorize(writePlan).authorized, false);
    await assert.rejects(writes.trustWorkspace(writePlan), { code: "WRITE_CONFIRMATION_INVALID" });
    assert.throws(() => writes.authorize(writePlan, { remember: true }), { code: "WRITE_CONFIRMATION_INVALID" });
    assert.strictEqual(writes.isTrusted(writePlan), false);

    const commands = [
        ["adapter", "driver", "cmsis-dap"],
        ["cmsis-dap", "backend", "tcp"],
        ["cmsis-dap", "tcp", "host", "probe.local"]
    ];
    const decoded = parseProfileEvents(profileOutput(commands));
    assert.deepStrictEqual(decoded, [
        ["adapter driver", "cmsis-dap"],
        ["cmsis-dap backend", "tcp"],
        ["cmsis-dap tcp host", "probe.local"]
    ]);
    const capability = await checkAdapterCapability(launch, {
        stat: async () => ({ size: 1, mtimeMs: 1 }),
        readFile: async () => "adapter driver cmsis-dap",
        run: async (_exe, args) =>
            args.includes("-f")
                ? "EP_ADAPTER_NAME=cmsis-dap\n" + profileOutput(commands)
                : "EP_ADAPTERS_BEGIN\ncmsis-dap\nEP_ADAPTERS_END\n"
    });
    assert.strictEqual(capability.profile.kind, "tcp");
    await assert.rejects(
        checkAdapterCapability(launch, {
            stat: async () => ({ size: 1, mtimeMs: 1 }),
            readFile: async () => "adapter driver cmsis-dap",
            run: async (_exe, args) => {
                if (args.includes("-f")) throw Object.assign(new Error("Interface script failed"), { code: 1 });
                return "EP_ADAPTERS_BEGIN\ncmsis-dap\nEP_ADAPTERS_END\n";
            }
        }),
        { code: "PROBE_CAPABILITY_UNKNOWN" }
    );
    assert(captureProfileScript().includes("upcall adapter"));
    assert(PRINT_PROFILE.includes("EP_PROFILE_END"));
    for (const text of [
        "",
        "EP_PROFILE_BEGIN\nnot a record\nEP_PROFILE_END",
        "EP_PROFILE_BEGIN\nEP_PROFILE_WORD=nothex\nEP_PROFILE_END"
    ])
        assert.throws(() => parseProfileEvents(text), { code: "PROBE_CAPABILITY_UNKNOWN" });
    for (const query of [
        { family: "bad" },
        { vidPid: [[1]] },
        { vidPid: [[-1, 1]] },
        { vidPid: Array(17).fill([1, 1]) }
    ])
        assert.throws(() => normalizeInventoryQuery(query), { code: "PROBE_SELECTION_UNSUPPORTED" });
    assert.throws(() => createProbeProfile("ftdi", [["ftdi vid_pid", "1"]]), { code: "PROBE_CAPABILITY_UNKNOWN" });

    for (const [vid, pid, family, name] of [
        ["0451", "bef3", "xds110", "XDS110"],
        ["0416", "511b", "nulink", "Nu-Link"]
    ]) {
        const devices = parseWindowsInventory(
            JSON.stringify({
                instanceId: `USB\\VID_${vid}&PID_${pid}\\001`,
                name: "USB Composite Device",
                reportedName: name
            }),
            "all"
        );
        assert.strictEqual(devices[0].family, family);
        const detection = await detectProbe({
            listProbes: async () => inventory(devices),
            usbInventory: async () => "USB Composite Device"
        });
        assert.strictEqual(detection.probe, family + ".cfg");
    }
    const mac = parseMacInventory(
        JSON.stringify({ vendor_id: "0x0483", product_id: "0x3748", _name: "ST-Link", location_id: "0x14100000" }),
        "all"
    );
    attachMacRegistryIds(
        mac,
        '+-o ST-Link <class IOUSBHostDevice, id 0x100000321, registered>\n "locationID" = 0x14100000\n "idVendor" = 1155\n "idProduct" = 14152'
    );
    assert.strictEqual(mac[0].attachmentId, "0x100000321");
    assert.throws(() => attachMacRegistryIds(mac, "x".repeat(2 * 1024 * 1024 + 1)), /budget/);
    const custom = await listProbes({
        platform: "win32",
        family: "ftdi",
        vidPid: [[0x1234, 0x5678]],
        run: async () => JSON.stringify({ instanceId: "USB\\VID_1234&PID_5678\\ABC", name: "Vendor probe" })
    });
    assert.strictEqual(custom.devices[0].family, "ftdi");
    let generation = 100n;
    const linuxOptions = {
        readdir: async () => ["1-1"],
        readFile: async (file) =>
            ({ idVendor: "0483", idProduct: "3748", product: "ST-Link", busnum: "1", devnum: "2", serial: "" })[
                require("path").basename(file)
            ] || "",
        stat: async () => ({ ino: 42n, ctimeNs: generation })
    };
    const linuxFirst = (await listLinuxUsbRows(linuxOptions))[0];
    assert.strictEqual(linuxFirst.attachmentId, "1:2:42:100");
    generation++;
    assert.notStrictEqual((await listLinuxUsbRows(linuxOptions))[0].attachmentId, linuxFirst.attachmentId);
    const linuxUnknown = (
        await listLinuxUsbRows({
            ...linuxOptions,
            stat: async () => {
                throw new Error("unavailable");
            }
        })
    )[0];
    assert.strictEqual(linuxUnknown.attachmentId, "");
    const spacedStlink = (
        await listLinuxUsbRows({
            ...linuxOptions,
            readFile: async (file) =>
                require("path").basename(file) === "serial" ? "ST LINK 0012\n" : linuxOptions.readFile(file)
        })
    )[0];
    assert.strictEqual(
        spacedStlink.serial,
        "ST LINK 0012",
        "An ASCII ST-Link serial with spaces is not a legacy byte-valued UID"
    );
    console.log("Probe selection, backend profiles, serial-less connections and plan-bound authorization tests passed");
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
