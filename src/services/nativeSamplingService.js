"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { inspectElf } = require("../../skills/_emberprobe/elf-file");
const { trustedSerial, normalizeAdapterSpeed } = require("../../skills/_emberprobe/probe-connection");

function nativeSamplingIdentity(config) {
    return {
        backend: config.samplingBackend || "openocd",
        chip: config.probeRsChip || "",
        description: config.probeRsTargetDescription || "",
        executable: config.probeRsNativePath || ""
    };
}
const failure = (code, message) => Object.assign(new Error(message), { code, retryable: false });
class NativeSamplingService {
    constructor(options) {
        this.root = options.extensionPath;
        this.snapshot = options.snapshot;
        this.selection = options.selection;
        this.inspect = options.inspectElf || inspectElf;
        this.runCatalog = options.runCatalog || require("util").promisify(require("child_process").execFile);
    }
    resolveExecutable(config, cwd) {
        const configuredPath = String(config.probeRsNativePath || "").trim();
        const binary = "emberprobe-probe-rs" + (process.platform === "win32" ? ".exe" : "");
        const executable = configuredPath
            ? path.resolve(cwd, configuredPath)
            : path.join(this.root, "resources", "probe-rs", `${process.platform}-${process.arch}`, binary);
        if (!fs.existsSync(executable) || !fs.statSync(executable).isFile())
            throw failure(
                "PROBE_RS_NOT_INSTALLED",
                "Native sampler is unavailable; build it or set emberprobe.probeRsNativePath"
            );
        if (!configuredPath) {
            const manifestPath = path.join(path.dirname(executable), "manifest.json");
            if (fs.statSync(manifestPath).size > 4096 || fs.statSync(executable).size > 128 * 1024 * 1024)
                throw failure("PROBE_RS_PACKAGE_INVALID", "Native package exceeds its file budget");
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            const digest = crypto.createHash("sha256").update(fs.readFileSync(executable)).digest("hex");
            if (manifest.protocol !== 1 || manifest.file !== binary || manifest.sha256 !== digest)
                throw failure("PROBE_RS_PACKAGE_INVALID", "Bundled native sampler failed its integrity check");
        }
        return executable;
    }
    async listChips(cwd) {
        const config = this.snapshot();
        const executable = this.resolveExecutable(config, cwd);
        const descriptions = [path.join(this.root, "resources", "probe-rs-targets", "STM32C593RGT6.yaml")];
        if (config.probeRsTargetDescription) descriptions.push(path.resolve(cwd, config.probeRsTargetDescription));
        const { stdout } = await this.runCatalog(executable, ["--list-chips", ...new Set(descriptions)], {
            cwd,
            windowsHide: true,
            timeout: 10000,
            maxBuffer: 4 * 1024 * 1024,
            encoding: "utf8"
        });
        const catalog = JSON.parse(stdout);
        if (
            catalog.protocol !== 1 ||
            !Array.isArray(catalog.chips) ||
            catalog.chips.length > 30000 ||
            catalog.chips.some(
                (chip) =>
                    !chip ||
                    typeof chip.name !== "string" ||
                    !/^[A-Za-z0-9_.+-]{1,128}$/.test(chip.name) ||
                    typeof chip.family !== "string" ||
                    chip.family.length > 256 ||
                    typeof chip.core !== "string"
            )
        )
            throw failure("PROBE_RS_CATALOG_INVALID", "Native sampler returned an invalid chip catalog");
        return catalog.chips;
    }
    async prepare(options) {
        const config = this.snapshot();
        const identity = nativeSamplingIdentity(config);
        const selected = this.selection();
        if (selected?.source !== "user" || !selected.probeSerial || selected.probe !== options.probe)
            throw failure("PROBE_SELECTION_REQUIRED", "Pick a USB probe in the sidebar before using native sampling");
        const device = options.inventory?.devices?.find((entry) => entry.id === options.deviceId);
        const serial = device?.descriptorSerial || trustedSerial(device, device?.family);
        if (!device || !serial || options.profile?.kind !== "usb")
            throw failure("PROBE_IDENTITY_UNVERIFIED", "Native sampling requires a verified USB probe serial");
        if (!/^[\da-f]{4}$/i.test(device.vid) || !/^[\da-f]{4}$/i.test(device.pid))
            throw failure("PROBE_IDENTITY_UNVERIFIED", "Cannot resolve the selected probe USB IDs");
        const chip = String(config.probeRsChip || "").trim();
        if (!chip || chip.length > 128 || !/^[A-Za-z0-9_.+-]+$/.test(chip))
            throw Object.assign(
                failure("PROBE_RS_CHIP_REQUIRED", "Select the exact probe-rs MCU model under MCU Configuration"),
                { i18nKey: "native.chipRequired" }
            );
        const executable = this.resolveExecutable(config, options.cwd);
        let description = String(config.probeRsTargetDescription || "").trim();
        if (!description && chip === "STM32C593RGT6")
            description = path.join(this.root, "resources", "probe-rs-targets", "STM32C593RGT6.yaml");
        if (description) {
            description = path.resolve(options.cwd, description);
            const stat = fs.statSync(description);
            if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
                throw failure("PROBE_RS_TARGET_INVALID", "Native target YAML exceeds its file budget");
        }
        if (!config.elf) throw failure("ELF_REQUIRED", "Select the ELF currently running on the target");
        const inspected = await this.inspect(config.elf);
        if (
            JSON.stringify(identity) !== JSON.stringify(nativeSamplingIdentity(this.snapshot())) ||
            config.elf !== this.snapshot().elf ||
            JSON.stringify(selected) !== JSON.stringify(this.selection())
        )
            throw failure("PROBE_CONFIGURATION_CHANGED", "Native sampling configuration changed during preparation");
        return {
            samplingBackend: "probe-rs",
            nativeExecutable: executable,
            nativeIdentity: identity,
            native: {
                chip,
                elf: config.elf,
                elfSha256: inspected.sha256,
                targetDescription: description || null,
                vendorId: parseInt(device.vid, 16),
                productId: parseInt(device.pid, 16),
                serial,
                speedKhz:
                    normalizeAdapterSpeed(config.samplingAdapterSpeedKhz) ||
                    normalizeAdapterSpeed(options.adapterSpeedKhz) ||
                    1000,
                protocol: String(options.transport || "").replace(/^hla_/, "") === "jtag" ? "jtag" : "swd"
            }
        };
    }
}
module.exports = { NativeSamplingService, nativeSamplingIdentity };
