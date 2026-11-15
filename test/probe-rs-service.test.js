"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { scenario } = require("./helpers/scenario");
const { NativeSamplingService, nativeSamplingIdentity } = require("../src/services/nativeSamplingService");

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-native-config-"));
    const helper = path.join(root, "helper");
    const description = path.join(root, "chip.yaml");
    fs.writeFileSync(helper, "fake native executable");
    fs.writeFileSync(description, "name: test");
    let config = {
        elf: "firmware.elf",
        samplingBackend: "probe-rs",
        probeRsChip: "STM32F407ZG",
        probeRsNativePath: helper,
        probeRsTargetDescription: description,
        samplingAdapterSpeedKhz: 4000
    };
    let selection = { source: "user", probe: "cmsis-dap.cfg", probeSerial: "test-probe" };
    const options = {
        cwd: root,
        probe: "cmsis-dap.cfg",
        deviceId: "device",
        transport: "swd",
        profile: { kind: "usb" },
        inventory: { devices: [{ id: "device", serial: "test-probe", vid: "1a86", pid: "8012", family: "cmsis-dap" }] }
    };
    const service = new NativeSamplingService({
        extensionPath: root,
        snapshot: () => config,
        selection: () => selection,
        inspectElf: async () => ({ sha256: "digest" })
    });
    try {
        await scenario("native settings retain exact selected USB identity", async () => {
            const result = await service.prepare(options);
            assert.equal(result.samplingBackend, "probe-rs");
            assert.equal(result.native.serial, "test-probe");
            assert.equal(result.native.vendorId, 0x1a86);
            assert.equal(result.native.speedKhz, 4000);
            assert.equal(result.native.elfSha256, "digest");
            assert.deepEqual(result.nativeIdentity, nativeSamplingIdentity(config));
            const original = config;
            config = { ...config, samplingAdapterSpeedKhz: 0 };
            assert.equal(
                (await service.prepare({ ...options, adapterSpeedKhz: 2000, transport: "jtag" })).native.protocol,
                "jtag"
            );
            assert.equal((await service.prepare(options)).native.speedKhz, 1000);
            assert.equal((await service.prepare({ ...options, transport: "hla_jtag" })).native.protocol, "jtag");
            config = original;
        });
        await scenario("missing identity, tools and target are rejected without hardware", async () => {
            const originalSelection = selection;
            selection = { ...selection, source: "auto" };
            await assert.rejects(service.prepare(options), { code: "PROBE_SELECTION_REQUIRED" });
            selection = originalSelection;
            await assert.rejects(service.prepare({ ...options, deviceId: "missing" }), {
                code: "PROBE_IDENTITY_UNVERIFIED"
            });
            await assert.rejects(service.prepare({ ...options, profile: { kind: "tcp" } }), {
                code: "PROBE_IDENTITY_UNVERIFIED"
            });
            const original = config;
            config = { ...original, probeRsChip: "" };
            await assert.rejects(service.prepare(options), {
                code: "PROBE_RS_CHIP_REQUIRED",
                i18nKey: "native.chipRequired"
            });
            config = { ...original, probeRsNativePath: path.join(root, "missing") };
            await assert.rejects(service.prepare(options), { code: "PROBE_RS_NOT_INSTALLED" });
            config = { ...original, probeRsTargetDescription: root };
            await assert.rejects(service.prepare(options), { code: "PROBE_RS_TARGET_INVALID" });
            config = { ...original, elf: "" };
            await assert.rejects(service.prepare(options), { code: "ELF_REQUIRED" });
            config = original;
        });
        await scenario("configuration changed during ELF inspection is cancelled", async () => {
            const changing = new NativeSamplingService({
                extensionPath: root,
                snapshot: () => config,
                selection: () => selection,
                inspectElf: async () => {
                    config = { ...config, probeRsChip: "different" };
                    return { sha256: "digest" };
                }
            });
            await assert.rejects(changing.prepare(options), { code: "PROBE_CONFIGURATION_CHANGED" });
        });
        await scenario("chip catalog is bounded, validated and does not require a selected probe", async () => {
            let stdout = JSON.stringify({
                protocol: 1,
                chips: [{ name: "STM32F407VGTx", family: "STM32F4", core: "armv7em" }]
            });
            const catalog = new NativeSamplingService({
                extensionPath: root,
                snapshot: () => config,
                selection: () => null,
                runCatalog: async (executable, args, options) => {
                    assert.equal(executable, helper);
                    assert.equal(args[0], "--list-chips");
                    assert.ok(args.some((arg) => arg.endsWith("STM32C593RGT6.yaml")));
                    assert.ok(args.includes(description));
                    assert.equal(options.windowsHide, true);
                    assert.equal(options.timeout, 10000);
                    assert.equal(options.maxBuffer, 4 * 1024 * 1024);
                    return { stdout };
                }
            });
            assert.equal((await catalog.listChips(root))[0].name, "STM32F407VGTx");
            stdout = '{"protocol":2,"chips":[]}';
            await assert.rejects(catalog.listChips(root), { code: "PROBE_RS_CATALOG_INVALID" });
            stdout = '{"protocol":1,"chips":[{"name":"bad/path"}]}';
            await assert.rejects(catalog.listChips(root), { code: "PROBE_RS_CATALOG_INVALID" });
        });
        await scenario("bundled native executables are hash checked and C593 has a read-only target", async () => {
            const directory = path.join(root, "resources", "probe-rs", `${process.platform}-${process.arch}`);
            fs.mkdirSync(directory, { recursive: true });
            const name = "emberprobe-probe-rs" + (process.platform === "win32" ? ".exe" : "");
            fs.writeFileSync(path.join(directory, name), "binary");
            fs.writeFileSync(
                path.join(directory, "manifest.json"),
                JSON.stringify({
                    protocol: 1,
                    file: name,
                    sha256: crypto.createHash("sha256").update("binary").digest("hex")
                })
            );
            const targets = path.join(root, "resources", "probe-rs-targets");
            fs.mkdirSync(targets);
            fs.writeFileSync(path.join(targets, "STM32C593RGT6.yaml"), "name: test");
            config = { ...config, probeRsNativePath: "", probeRsTargetDescription: "", probeRsChip: "STM32C593RGT6" };
            const result = await service.prepare(options);
            assert.match(result.native.targetDescription, /STM32C593RGT6.yaml$/);
            fs.writeFileSync(path.join(directory, name), "tampered");
            await assert.rejects(service.prepare(options), { code: "PROBE_RS_PACKAGE_INVALID" });
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
main()
    .then(() => console.log("probe-rs configuration tests passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
