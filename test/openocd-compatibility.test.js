"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { canonicalFileSync, canonicalFile, normalizeFileIdentity } = require("../skills/_emberprobe/file-identity");
const { FlashAuthorization } = require("../src/flashAuthorization");
const { AgentFlashService } = require("../src/services/agentFlashService");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { diagnoseOpenOcdFailure } = require("../src/openocdRunner");
const launch = require("../src/openocdScripts");
const common = require("../skills/_emberprobe/flash-common");
const { probeCandidates, probeFromText } = require("../skills/_emberprobe/probe-detection");

(async () => {
    assert.strictEqual(common.resolveOpenOcdLaunch, launch.resolveOpenOcdLaunch);
    assert.strictEqual(normalizeFileIdentity("c:\\Work\\File.elf", "win32"), "C:/Work/File.elf");
    assert.notStrictEqual(normalizeFileIdentity("/Work/F.elf", "linux"), normalizeFileIdentity("/Work/f.elf", "linux"));
    assert.notStrictEqual(
        normalizeFileIdentity("C:/Work/F.elf", "win32"),
        normalizeFileIdentity("C:/Work/f.elf", "win32")
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-compat-"));
    const oldPath = process.env.PATH;
    const oldScripts = process.env.OPENOCD_SCRIPTS;
    try {
        const elf = path.join(root, "固件 with spaces.elf");
        fs.writeFileSync(elf, "firmware");
        const supplied = process.platform === "win32" ? elf[0].toLowerCase() + elf.slice(1) : elf;
        assert.strictEqual(canonicalFileSync(supplied), await canonicalFile(elf));
        const images = path.join(root, "images");
        fs.mkdirSync(images);
        fs.writeFileSync(path.join(images, "firmware.elf"), "firmware");
        fs.symlinkSync(images, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
        assert.strictEqual(
            canonicalFileSync(path.join(root, "alias", "firmware.elf")),
            await canonicalFile(path.join(images, "firmware.elf"))
        );
        if (process.platform === "linux") {
            fs.writeFileSync(path.join(images, "FIRMWARE.elf"), "different");
            assert.notStrictEqual(
                canonicalFileSync(path.join(images, "firmware.elf")),
                await canonicalFile(path.join(images, "FIRMWARE.elf"))
            );
        }
        const authorization = new FlashAuthorization();
        const coordinator = new ProbeCoordinator();
        const plan = {
            elf: {
                path: canonicalFileSync(supplied),
                sha256: crypto.createHash("sha256").update("firmware").digest("hex")
            },
            target: "stm32f4x.cfg",
            probe: "jlink.cfg",
            openocd: "openocd",
            transport: "swd"
        };
        let runs = 0;
        const service = new AgentFlashService({
            authorization,
            coordinator,
            isDebugActive: () => false,
            resolveLaunch: () => ({ executable: "fake" }),
            check: async () => ({ compatible: true }),
            run: async (options) => {
                runs++;
                assert.strictEqual(options.transport, "swd");
                assert(options.buildCommands().join(" ").includes("verify reset exit"));
                return { exitCode: 0, openocdTail: [] };
            }
        });
        const params = { ...plan, elf: supplied, elfSha256: plan.elf.sha256 };
        let confirmationId = authorization.authorize(plan).confirmationId;
        assert.strictEqual((await service.execute({ ...params, confirmationId })).verified, true);
        await assert.rejects(service.execute({ ...params, confirmationId }), { code: "FLASH_CONFIRMATION_INVALID" });
        confirmationId = authorization.authorize(plan).confirmationId;
        await assert.rejects(service.execute({ ...params, confirmationId, transport: "jtag" }), {
            code: "FLASH_CONFIRMATION_INVALID"
        });
        confirmationId = authorization.authorize(plan).confirmationId;
        fs.writeFileSync(elf, "changed");
        await assert.rejects(service.execute({ ...params, confirmationId }), {
            code: "ELF_CHANGED_DURING_FLASH_CONFIRMATION"
        });
        assert.strictEqual(runs, 1);

        const binary = path.join(root, "bin", process.platform === "win32" ? "openocd.exe" : "openocd");
        const scripts = path.join(root, "share", "openocd", "scripts");
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, "", { mode: 0o755 });
        for (const [kind, name] of [
            ["interface", "jlink.cfg"],
            ["target", "stm32f4x.cfg"]
        ]) {
            fs.mkdirSync(path.join(scripts, kind), { recursive: true });
            fs.writeFileSync(path.join(scripts, kind, name), "");
        }
        delete process.env.OPENOCD_SCRIPTS;
        const resolved = launch.resolveOpenOcdLaunch(binary, "jlink.cfg", "stm32f4x.cfg");
        for (const transport of ["auto", "swd", "jtag", "hla_swd", "hla_jtag"]) {
            const args = launch.buildOpenOcdConfigArgs(resolved, transport);
            assert.strictEqual(args.includes(`transport select ${transport}`), transport !== "auto");
            if (transport !== "auto") {
                assert(args.indexOf(resolved.probePath) < args.indexOf(`transport select ${transport}`));
                assert(args.indexOf(`transport select ${transport}`) < args.indexOf(resolved.targetPath));
            }
        }
        assert.throws(() => launch.buildOpenOcdConfigArgs(resolved, "swd; shutdown"), {
            code: "OPENOCD_TRANSPORT_INVALID"
        });
        assert.throws(() => launch.resolveOpenOcdLaunch(root, "jlink.cfg", "stm32f4x.cfg"), {
            code: "OPENOCD_NOT_FOUND"
        });
        assert.throws(() => launch.resolveOpenOcdLaunch(binary, "missing.cfg", "stm32f4x.cfg"), {
            code: "OPENOCD_CONFIG_NOT_FOUND"
        });
        const directory = path.join(root, "shadow");
        fs.mkdirSync(path.join(directory, path.basename(binary)), { recursive: true });
        process.env.PATH = [directory, path.dirname(binary)].join(path.delimiter);
        assert.strictEqual(launch.resolveExecutablePath("openocd"), fs.realpathSync(binary));
        if (process.platform === "win32") {
            assert.throws(() => launch.resolveExecutablePath("openocd.cmd"), {
                code: "OPENOCD_EXECUTABLE_UNSUPPORTED"
            });
            assert.strictEqual(
                (await common.probeOpenOcdCompatibility("openocd.bat")).code,
                "OPENOCD_EXECUTABLE_UNSUPPORTED"
            );
        }
        fs.unlinkSync(path.join(scripts, "interface", "jlink.cfg"));
        fs.rmdirSync(path.join(scripts, "interface"));
        assert.throws(() => launch.resolveOpenOcdLaunch(binary, "jlink.cfg", "stm32f4x.cfg"), {
            code: "OPENOCD_CONFIG_NOT_FOUND"
        });
    } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldScripts === undefined) delete process.env.OPENOCD_SCRIPTS;
        else process.env.OPENOCD_SCRIPTS = oldScripts;
        fs.rmSync(root, { recursive: true, force: true });
    }

    for (const [usb, code] of Object.entries({
        ACCESS: "PROBE_PERMISSION_DENIED",
        BUSY: "PROBE_BUSY",
        NO_DEVICE: "PROBE_DISCONNECTED",
        NOT_FOUND: "PROBE_NOT_FOUND",
        NOT_SUPPORTED: "PROBE_DRIVER_UNSUPPORTED"
    })) {
        for (const platform of ["win32", "linux", "darwin"]) {
            const result = diagnoseOpenOcdFailure(
                [
                    `Error: libusb_open() failed with LIBUSB_ERROR_${usb}`,
                    ...Array(30).fill("Info: trailing output"),
                    "Error: init failed"
                ],
                { probe: "jlink.cfg", platform }
            );
            assert.strictEqual(result.code, code);
            assert.strictEqual(result.details.openocdTail.length, 8);
            assert.strictEqual(result.suggestedActions.join(" ").includes("SEGGER"), platform === "win32");
            assert.strictEqual(result.suggestedActions.join(" ").includes("udev"), platform === "linux");
        }
    }
    for (const volts of ["3.300000", "3.291", "1.800000", "unknown"]) {
        assert.notStrictEqual(
            diagnoseOpenOcdFailure([`Info: Target voltage: ${volts} V`, "Error: init failed"]).code,
            "TARGET_UNPOWERED"
        );
    }
    for (const volts of ["0.000000", "0.3", "0.5"]) {
        assert.strictEqual(diagnoseOpenOcdFailure([`Info: Target voltage: ${volts} V`]).code, "TARGET_UNPOWERED");
    }
    assert.strictEqual(
        diagnoseOpenOcdFailure(["Error: Debug adapter doesn't support 'swd' transport"]).code,
        "OPENOCD_TRANSPORT_INVALID"
    );
    assert.deepStrictEqual(probeCandidates("SEGGER J-Link\nST-LINK/V2"), ["stlink.cfg", "jlink.cfg"]);
    assert.strictEqual(probeFromText("SEGGER J-Link\nST-LINK/V2"), "");
    assert.strictEqual(probeFromText("J-Link\nJ-Link"), "jlink.cfg");
    console.log("OpenOCD compatibility regression tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
