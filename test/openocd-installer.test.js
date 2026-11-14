"use strict";
const assert = require("assert");
const { createHash } = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const tar = require("tar");
const { scenario } = require("./helpers/scenario");
const targetManifest = require("../resources/openocd-targets-manifest.json");
const installer = require("../src/openocdInstaller");
const { discoverTargetConfigs } = require("../src/openocdScripts");
const { probeDefaultOpenOcd, shouldUseBundledDefault } = require("../src/openocdChecker");
const { AgentFlashService } = require("../src/services/agentFlashService");
const { OpenOcdStatusService } = require("../src/services/openocdStatusService");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const { resolveExecutablePath, resolveOpenOcdLaunch } = require("../src/openocdScripts");
const { runOpenOcdOnce } = require("../src/services/openocdExec");
const { preflight } = require("../skills/_emberprobe/flash-common");
const { minimalElf } = require("./helpers/elf-fixture");
const {
    platformKey,
    getBundledArchive,
    installDir,
    locateOpenOcdBinary,
    installBundledOpenOcd,
    assertSafeEntryPath,
    OPENOCD_BIN
} = installer;

(async () => {
    // Extraction path checks (Zip Slip defence in depth): entries escaping staging are rejected
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "ep-slip-"));
    try {
        assert.doesNotThrow(() => assertSafeEntryPath(staging, "bin/openocd.exe"));
        assert.doesNotThrow(() => assertSafeEntryPath(staging, "xpack-openocd-1.0/scripts/inner.cfg"));
        for (const evil of ["../evil.txt", "/etc/passwd", "a/../../evil"]) {
            assert.throws(
                () => assertSafeEntryPath(staging, evil),
                (error) => error.code === "UNSAFE_ARCHIVE_ENTRY",
                `entry path must be rejected: ${evil}`
            );
        }
        if (process.platform === "win32") {
            assert.throws(
                () => assertSafeEntryPath(staging, "C:\\evil\\openocd.exe"),
                (error) => error.code === "UNSAFE_ARCHIVE_ENTRY"
            );
        }
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }

    // Platform mapping: the current platform maps to a known key or null
    const key = platformKey();
    assert.ok(typeof key === "string" || key === null, "platformKey returns a string or null");
    if (process.platform === "win32" && process.arch === "x64") {
        assert.strictEqual(key, "win32-x64", "win32-x64 maps to a bundled archive key");
    }

    // Shared mock context: asAbsolutePath points at the project root to find bundled archives, globalStorageUri at a
    // temporary extraction directory
    const projectRoot = path.resolve(__dirname, "..");
    const linuxArchive = path.join(projectRoot, "resources", "openocd-linux-x64.tar.gz");
    assert.strictEqual(
        createHash("sha256").update(fs.readFileSync(linuxArchive)).digest("hex"),
        targetManifest.archives.find((item) => item.platform === "linux-x64").sha256,
        "the Linux x64 archive matches the manifest SHA-256 after merging compatibility configs"
    );
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "ep-test-"));
    const mockContext = {
        asAbsolutePath: (p) => path.join(projectRoot, p),
        globalStorageUri: { fsPath: tmpBase }
    };
    const archive = getBundledArchive(mockContext);
    assert.strictEqual(shouldUseBundledDefault("/custom/openocd", mockContext), false);
    assert.strictEqual(await probeDefaultOpenOcd("/custom/openocd", mockContext), undefined);
    assert.strictEqual(shouldUseBundledDefault("openocd", { asAbsolutePath: () => "/missing/archive.tar.gz" }), false);
    // The default runtime is this run's one real extraction; its executable also loads the target configurations below.
    let runtime = null;
    if (["linux", "win32"].includes(process.platform) && process.arch === "x64") {
        assert.strictEqual(shouldUseBundledDefault("openocd", mockContext), true);
        assert.strictEqual(shouldUseBundledDefault("", mockContext), true);
        if (process.platform === "linux") assert.strictEqual(archive, linuxArchive);
        const progress = [];
        const [bundled, otherWindow] = await Promise.all([
            probeDefaultOpenOcd("openocd", mockContext, (event) => progress.push(event)),
            probeDefaultOpenOcd("openocd", mockContext)
        ]);
        assert.ok(bundled.found && bundled.compatible, JSON.stringify(bundled));
        assert.ok(otherWindow.found && otherWindow.compatible, JSON.stringify(otherWindow));
        assert.strictEqual(
            otherWindow.path,
            bundled.path,
            "concurrent preparation across windows shares the published runtime"
        );
        assert.strictEqual(bundled.bundled, true);
        assert.strictEqual(bundled.requested, "openocd");
        assert.ok(
            bundled.path.startsWith(tmpBase),
            "the default runtime installs inside the extension's global storage"
        );
        assert.notStrictEqual(bundled.path, "/usr/bin/openocd");
        await scenario("Agent Flash shares bundled default resolution even with system OpenOCD on PATH", async () => {
            const systemBin = path.join(tmpBase, "system", "bin");
            const systemOpenOcd = path.join(systemBin, OPENOCD_BIN);
            fs.mkdirSync(systemBin, { recursive: true });
            fs.writeFileSync(systemOpenOcd, "", { mode: 0o755 });
            const systemScripts = path.join(systemBin, "..", "scripts");
            fs.mkdirSync(path.join(systemScripts, "target"), { recursive: true });
            fs.writeFileSync(path.join(systemScripts, "outside-bundle.cfg"), "");
            const previousPath = process.env.PATH;
            const previousScripts = process.env.OPENOCD_SCRIPTS;
            process.env.PATH = [systemBin, previousPath].filter(Boolean).join(path.delimiter);
            process.env.OPENOCD_SCRIPTS = systemScripts;
            try {
                const elf = path.join(tmpBase, "firmware.elf");
                fs.writeFileSync(elf, minimalElf());
                let openocdPath = "openocd";
                const getConfig = () => ({ elf, openocdPath, debugger: "cmsis-dap.cfg", mcu: "stm32c5x.cfg" });
                const resolver = new OpenOcdStatusService({
                    checker: require("../src/openocdChecker"),
                    context: mockContext,
                    onStatus() {}
                });
                const flash = new AgentFlashService({
                    getConfig,
                    resolveExecutable: (value) => resolver.resolve(value)
                });
                const routes = createAgentRoutes({ _configurationSnapshot: getConfig, _agentFlashService: flash });
                assert.strictEqual(resolveExecutablePath("openocd"), fs.realpathSync(systemOpenOcd));
                const config = await routes["config.get"]({ resolveOpenOcd: true });
                assert.strictEqual(config.openocdPath, "openocd");
                assert.strictEqual(config.resolvedOpenOcdPath, fs.realpathSync(bundled.path));
                const request = await flash.request({ openocd: config.resolvedOpenOcdPath });
                assert.strictEqual(request.executable, config.resolvedOpenOcdPath);
                assert.strictEqual((await flash.request({ openocd: "openocd" })).executable, request.executable);
                assert.match(
                    resolveOpenOcdLaunch(request.executable, request.probe, request.target).targetPath,
                    /[\\/]target[\\/]stm32c5x\.cfg$/
                );
                const plan = await preflight(
                    { workspace: tmpBase },
                    {
                        call: (_workspace, method, params) => {
                            if (method === "config.get") return routes[method](params);
                            assert.strictEqual(method, "probe.list");
                            return {
                                available: true,
                                devices: [{ family: "cmsis-dap", serial: "fixture", id: "fixture" }],
                                notes: []
                            };
                        }
                    }
                );
                assert.strictEqual(plan.ready, true, JSON.stringify(plan.diagnostics));
                assert.strictEqual(plan.openocd, request.executable);
                const checkedScripts = await runOpenOcdOnce({
                    ...request,
                    buildCommands: () => [
                        "noinit",
                        "if {[catch {find outside-bundle.cfg}]} {echo EP_BUNDLED_SCRIPTS}",
                        "shutdown"
                    ]
                });
                assert.strictEqual(checkedScripts.exitCode, 0);
                assert.ok(checkedScripts.openocdTail.includes("EP_BUNDLED_SCRIPTS"));
                await assert.rejects(flash.request({ openocd: systemOpenOcd }), {
                    code: "OPENOCD_EXECUTABLE_MISMATCH"
                });
                openocdPath = "";
                assert.strictEqual((await flash.request({})).executable, request.executable);
            } finally {
                if (previousPath === undefined) delete process.env.PATH;
                else process.env.PATH = previousPath;
                if (previousScripts === undefined) delete process.env.OPENOCD_SCRIPTS;
                else process.env.OPENOCD_SCRIPTS = previousScripts;
            }
        });
        const installedAt = fs.statSync(bundled.path).mtimeMs;
        const reusedProgress = [];
        const reused = await probeDefaultOpenOcd("openocd", mockContext, (event) => reusedProgress.push(event));
        assert.strictEqual(reused.path, bundled.path);
        assert.strictEqual(
            fs.statSync(bundled.path).mtimeMs,
            installedAt,
            "resolving again does not overwrite the cached runtime"
        );
        assert.deepStrictEqual(
            reusedProgress,
            [],
            "reusing a verified runtime reports no install state (no install card flashing during flash/debug)"
        );
        assert.ok(progress.some((event) => event.key === "oc.preparing" && event.state === "preparing"));
        assert.ok(progress.some((event) => event.key === "oc.extracting"));

        // A verified runtime is reused by its size and mtime without starting it again; a stamp change re-verifies.
        const executable = fs.readFileSync(bundled.path);
        const stampAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
        fs.utimesSync(bundled.path, stampAt, stampAt);
        assert.ok((await probeDefaultOpenOcd("openocd", mockContext)).found, "a new stamp is verified by running it");
        fs.writeFileSync(bundled.path, Buffer.alloc(executable.length));
        fs.utimesSync(bundled.path, stampAt, stampAt);
        const cached = await probeDefaultOpenOcd("openocd", mockContext);
        assert.ok(cached.found && cached.compatible, "an unchanged stamp must not start the executable");
        assert.strictEqual(cached.path, bundled.path);
        fs.utimesSync(bundled.path, stampAt, new Date(stampAt.getTime() + 1000));
        assert.strictEqual((await probeDefaultOpenOcd("openocd", mockContext)).found, false);
        fs.writeFileSync(bundled.path, executable);
        assert.ok((await probeDefaultOpenOcd("openocd", mockContext)).found);

        // A damaged cached runtime must fail without falling back to the affected system build.
        const aside = bundled.path + ".aside";
        fs.renameSync(bundled.path, aside);
        const damaged = await probeDefaultOpenOcd("openocd", mockContext);
        assert.strictEqual(damaged.found, false);
        assert.strictEqual(damaged.errorKey, "oc.prepareFailed");
        assert.match(damaged.error, /缓存验证失败/);
        fs.renameSync(aside, bundled.path);
        runtime = bundled.path;

        const corrupt = path.join(tmpBase, "default-corrupt.tar.gz");
        fs.writeFileSync(corrupt, "not a tar archive");
        const invalid = await probeDefaultOpenOcd("openocd", {
            asAbsolutePath: () => corrupt,
            globalStorageUri: { fsPath: tmpBase }
        });
        assert.strictEqual(invalid.found, false);
        assert.strictEqual(invalid.errorKey, "oc.prepareFailed");
    }
    if (archive) {
        // With a bundled archive for this platform the file must exist and be readable
        assert.ok(fs.existsSync(archive), `bundled archive exists: ${archive}`);
        assert.ok(
            archive.endsWith("openocd-win32-x64.tar.gz") || /\.tar\.gz$/.test(archive),
            "bundled archive is a tar.gz"
        );
    } else {
        // Without a bundled archive for this platform getBundledArchive returns null instead of throwing
        assert.strictEqual(archive, null);
    }

    // installDir: based on the mock context's globalStorageUri
    const dest = installDir(mockContext);
    assert.ok(
        dest.includes(path.join("emberprobe", "openocd")),
        "installDir contains the emberprobe/openocd subdirectory"
    );

    // Installing and replacing run on a small archive with the same layout (into a temporary directory, never the real
    // global storage); its executable is never started.
    if (key) {
        const fixture = path.join(tmpBase, "fixture");
        fs.mkdirSync(path.join(fixture, "bin"), { recursive: true });
        fs.writeFileSync(path.join(fixture, "bin", OPENOCD_BIN), "not an executable");
        const smallArchive = path.join(tmpBase, "small.tar.gz");
        await tar.c({ gzip: true, file: smallArchive, cwd: fixture }, ["bin"]);
        const smallContext = { asAbsolutePath: () => smallArchive, globalStorageUri: { fsPath: tmpBase } };
        const progressCalls = [];
        const result = await installBundledOpenOcd(null, smallContext, (p) => progressCalls.push(p));
        assert.ok(result.ok, `install succeeds, got: ${result.error || JSON.stringify(result)}`);
        assert.ok(result.path, "a successful install returns the executable path");
        assert.ok(result.path.endsWith(OPENOCD_BIN), `path ends with ${OPENOCD_BIN}, got: ${result.path}`);
        assert.ok(fs.existsSync(result.path), "the extracted executable exists");
        assert.ok(progressCalls.length > 0, "extraction reports progress");
        // locateOpenOcdBinary on its own
        const destRoot = installDir(mockContext);
        assert.strictEqual(
            locateOpenOcdBinary(destRoot),
            result.path,
            "locateOpenOcdBinary finds the executable in the extraction directory"
        );

        // A corrupt new archive fails the install, leaving an already working old directory untouched.
        const marker = path.join(destRoot, "existing-install.marker");
        fs.writeFileSync(marker, "keep");
        const rejected = await installBundledOpenOcd(null, smallContext, null, async () => ({
            ok: false,
            error: "simulated runtime failure"
        }));
        assert.strictEqual(rejected.ok, false, "a failed executable check aborts the install");
        assert.ok(fs.existsSync(marker), "a failed executable check keeps the existing OpenOCD");

        const corruptArchive = path.join(tmpBase, "corrupt.tar.gz");
        fs.writeFileSync(corruptArchive, "not a tar archive");
        const corruptContext = {
            asAbsolutePath: () => corruptArchive,
            globalStorageUri: { fsPath: tmpBase }
        };
        const failed = await installBundledOpenOcd(null, corruptContext);
        assert.strictEqual(failed.ok, false, "a corrupt bundled archive fails to install");
        assert.ok(fs.existsSync(marker), "a failed install keeps the existing OpenOCD");
        try {
            fs.rmSync(destRoot, { recursive: true, force: true });
        } catch (e) {
            /* ignore */
        }
    }

    if (runtime) {
        const targets = discoverTargetConfigs(runtime);
        assert.ok(targets.includes("geehy/apm32f0x.cfg"), "the bundled archive includes the APM32F0 target");
        assert.ok(targets.includes("geehy/apm32f1x.cfg"), "the bundled archive includes the APM32F1 target");
        assert.ok(targets.includes("geehy/apm32f4x.cfg"), "the bundled archive includes the APM32F4 target");
        // Configuration-only execution: explicit shutdown prevents implicit init or probe access.
        for (const target of targetManifest.targets) {
            const name = target.path.slice("target/".length);
            assert.ok(targets.includes(name), `merged configuration must be discoverable: ${name}`);
            const rz = name === "renesas_rz_g2.cfg";
            const load = (config, options = {}) => {
                const loaded = spawnSync(
                    runtime,
                    [
                        "-f",
                        rz ? "interface/dummy.cfg" : "interface/cmsis-dap.cfg",
                        "-c",
                        `transport select ${rz ? "jtag" : "swd"}`,
                        ...Object.entries(options).flatMap(([key, value]) => ["-c", `set ${key} ${value}`]),
                        "-f",
                        config,
                        "-c",
                        "echo EP_TARGETS=[target names]",
                        "-c",
                        "echo EP_BANKS=[flash list]",
                        "-c",
                        "echo EP_ADAPTER=[adapter name]",
                        "-c",
                        "echo EP_TRANSPORT=[transport select]",
                        "-c",
                        "shutdown"
                    ],
                    { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
                );
                const output = `${loaded.stdout || ""}\n${loaded.stderr || ""}`;
                assert.ifError(loaded.error);
                assert.strictEqual(loaded.status, 0, output);
                assert.match(output, /EP_TARGETS=\S+/);
                assert.ok(output.includes(`EP_ADAPTER=${rz ? "dummy" : "cmsis-dap"}`), output);
                assert.ok(output.includes(`EP_TRANSPORT=${rz ? "jtag" : "swd"}`), output);
                return output;
            };
            const output = load(target.path);
            assert.deepStrictEqual(
                output.match(/^EP_.*$/gm),
                load(target.canonical, target.options).match(/^EP_.*$/gm),
                `${name} must retain canonical target/bank declarations and adapter/transport`
            );
            if (name === "rp2040-core0.cfg") assert.match(output, /EP_TARGETS=rp2040\.core0\s*$/m);
        }
        // STM32C5 declares an stldr bank, and every DEV_ID loader resolves inside the bundled scripts.
        assert.ok(targets.includes("stm32c5x.cfg") && targets.includes("stm32c0x.cfg"));
        const c5 = spawnSync(
            runtime,
            [
                "-f",
                "interface/cmsis-dap.cfg",
                "-c",
                "transport select swd",
                "-f",
                "target/stm32c5x.cfg",
                "-c",
                "echo EP_TARGETS=[target names]",
                "-c",
                "echo EP_BANKS=[flash list]",
                ...targetManifest.flashLoaders
                    .filter((loader) => loader.devId)
                    .flatMap((loader) => ["-c", `echo EP_LOADER=[file exists [find ${loader.path}]]`]),
                "-c",
                "shutdown"
            ],
            { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
        );
        const c5Output = `${c5.stdout || ""}\n${c5.stderr || ""}`;
        assert.strictEqual(c5.status, 0, c5Output);
        assert.match(c5Output, /EP_TARGETS=[\s\S]*stm32c5x\.cpu/);
        assert.match(c5Output, /EP_BANKS=[\s\S]*driver\s+stldr\s+base\s+0x08000000/);
        assert.deepStrictEqual(c5Output.match(/^EP_LOADER=.*$/gm), ["EP_LOADER=1", "EP_LOADER=1", "EP_LOADER=1"]);

        const runC5Event = (commands, chipName = "stm32c5x") => {
            const loaded = spawnSync(
                runtime,
                [
                    "-c",
                    `set CHIPNAME ${chipName}`,
                    "-f",
                    path.join(__dirname, "fixtures/openocd-c5-event.cfg"),
                    ...[...commands, "shutdown"].flatMap((command) => ["-c", command])
                ],
                { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
            );
            const output = `${loaded.stdout || ""}\n${loaded.stderr || ""}`;
            assert.ifError(loaded.error);
            assert.strictEqual(loaded.status, 0, output);
            return output;
        };

        await scenario("C5 loader events resolve all device IDs inside a programming procedure", () => {
            for (const chipName of ["stm32c5x", "boardC5"]) {
                for (const loader of targetManifest.flashLoaders.filter((item) => item.devId)) {
                    const output = runC5Event(
                        [
                            `set _ep_devid ${loader.devId}`,
                            "_ep_test_examine; echo EP_EXAMINED=$EXAMINED",
                            "_ep_test_examine; echo EP_REEXAMINED=$EXAMINED"
                        ],
                        chipName
                    );
                    assert.ok(output.includes(`EP_STLDR=set_loader ${chipName}.flash `), output);
                    assert.ok(output.includes(path.basename(loader.path)), output);
                    assert.ok(output.includes(`EP_STLDR=set_size ${chipName}.flash 524288`), output);
                    assert.match(output, /EP_EXAMINED=1/);
                    assert.match(output, /EP_REEXAMINED=1/);
                    assert.strictEqual(output.match(/EP_STLDR=set_loader/g)?.length, 1, output);
                    assert.doesNotMatch(output, /no such variable|Error : No STLDR/);
                }
            }
        });

        await scenario("C5 loader failures leave initialization pending and permit a corrected retry", () => {
            for (const failure of ["missing-file", "unknown-device", "set_loader", "set_size"]) {
                const setup = {
                    "missing-file": "set dev_id_loader(0x45A) flash_loaders/missing.xldr",
                    "unknown-device": "set _ep_devid 0xFFF",
                    set_loader: "set _ep_fail set_loader",
                    set_size: "set _ep_fail set_size"
                }[failure];
                const output = runC5Event([
                    "set _ep_devid 0x45A; set saved_loader $dev_id_loader(0x45A)",
                    setup,
                    "set rc [catch {_ep_test_examine} msg]; echo EP_FAILURE=$rc; echo EP_MESSAGE=$msg; " +
                        "echo EP_PENDING=$EXAMINED",
                    "set _ep_devid 0x45A; set _ep_fail {}; set dev_id_loader(0x45A) $saved_loader",
                    "_ep_test_examine; echo EP_RECOVERED=$EXAMINED"
                ]);
                assert.match(output, /EP_FAILURE=1/);
                assert.match(output, /EP_PENDING=0/);
                assert.match(output, /EP_RECOVERED=1/);
                assert.match(output, /EP_STLDR=set_size stm32c5x.flash 524288/);
                if (failure.startsWith("set_")) assert.match(output, /EP_MESSAGE=EP_LOADER_FAILURE/);
                else assert.match(output, /Error : No STLDR loader file found/);
            }
        });
    }

    try {
        fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch (e) {
        /* ignore */
    }

    console.log("OpenOCD installer tests passed");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
