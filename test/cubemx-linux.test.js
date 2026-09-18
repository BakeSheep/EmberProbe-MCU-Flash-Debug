"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { installation, discover, readUpdater } = require("../src/services/cubemxEnvironment");
const { CubeMxConfiguration } = require("../src/services/cubemxConfiguration");
const { CubeMxService } = require("../src/services/cubemxService");
const { snapshot, stageGeneration, normalizeGenerated, hash } = require("../src/services/cubemxProject");
const { runCubeMx } = require("../src/services/cubemxRunner");
const { launchInstaller, inspectFirmware } = require("../src/services/cubemxFirmware");

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-linux-")));
    const write = async (file, content = "", mode = 0o644) => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
        await fs.chmod(file, mode);
        return file;
    };
    try {
        const directory = path.join(root, "工具 空格", "STM32CubeMX");
        const executable = await write(path.join(directory, "STM32CubeMX"), "fixture", 0o755);
        const java = await write(path.join(directory, "jre/bin/java"), "fixture", 0o755);
        const versionFile = await write(path.join(directory, "db/version.xml"), "<Version>6.12.0</Version>");
        const options = { platform: "linux", updater: null };
        const tool = await installation(executable, options);
        assert.strictEqual(tool.platform, "linux");
        assert.strictEqual(tool.java, java);
        assert.strictEqual(tool.version, "6.12.0");
        for (const value of [undefined, "relative", executable + "\n"])
            await assert.rejects(installation(value, options), { code: "CUBEMX_PATH_INVALID" });
        const wrongName = await write(path.join(directory, "STM32CubeMX.exe"));
        await assert.rejects(installation(wrongName, options), { code: "CUBEMX_PATH_INVALID" });
        await assert.rejects(installation(executable, { platform: "darwin" }), { code: "CUBEMX_PLATFORM_UNSUPPORTED" });
        await fs.unlink(java);
        await assert.rejects(installation(executable, options), { code: "CUBEMX_JAVA_MISSING" });
        await write(java, "fixture", 0o755);
        if (process.platform !== "win32") {
            await fs.chmod(executable, 0o644);
            await assert.rejects(installation(executable, options), { code: "EACCES" });
            await fs.chmod(executable, 0o755);
            await fs.chmod(java, 0o644);
            await assert.rejects(installation(executable, options), { code: "CUBEMX_JAVA_MISSING" });
            await fs.chmod(java, 0o755);
            const alias = path.join(root, "cube-alias");
            await fs.symlink(executable, alias);
            assert.strictEqual((await installation(alias, options)).executable, executable);
        }
        const discovery = {
            platform: "linux",
            roots: [],
            env: { HOME: root },
            exec: async () => {
                throw new Error("Linux discovery must not query the Windows registry");
            }
        };
        assert.strictEqual(await discover(discovery), null);
        assert.strictEqual(await discover({ ...discovery, platform: "darwin" }), null);
        assert.strictEqual((await discover({ ...discovery, hints: [executable] })).executable, executable);
        assert.strictEqual((await discover({ ...discovery, env: { PATH: directory } })).executable, executable);
        assert.strictEqual((await discover({ ...discovery, roots: [path.dirname(directory)] })).executable, executable);
        const homeInstall = path.join(root, "STMicroelectronics", "STM32Cube", "STM32CubeMX");
        await write(path.join(homeInstall, "STM32CubeMX"), "fixture", 0o755);
        await write(path.join(homeInstall, "jre/bin/java"), "fixture", 0o755);
        await write(path.join(homeInstall, "version.xml"), "<Version>6.11.0</Version>");
        assert.strictEqual((await discover({ ...discovery, roots: [root] })).version, "6.11.0");
        const updaterFile = path.join(root, ".stm32cubemx/plugins/updater/updater.ini");
        await fs.unlink(versionFile);
        await write(updaterFile, `SoftwarePath="${directory}${path.sep}"\nSoftVersion=MX.6.12.0\n`);
        assert.strictEqual((await discover(discovery)).version, "6.12.0");
        await write(updaterFile, `SoftwarePath=${executable}\nSoftVersion=MX.6.12.0\n`);
        assert.strictEqual((await readUpdater(root, "linux")).executable, executable);
        assert.strictEqual((await discover(discovery)).version, "6.12.0");
        assert.strictEqual(
            (await installation(executable, { ...options, updater: { executable: wrongName, version: "9.0.0" } }))
                .version,
            ""
        );
        await write(versionFile, "<Version>6.12.0</Version>");

        let selected = executable;
        let dialogOptions;
        const configuration = new CubeMxConfiguration({
            platform: "linux",
            t: (key) => key,
            changed: () => {},
            context: {},
            vscode: {
                ConfigurationTarget: { Global: 1 },
                workspace: {
                    getConfiguration: (section) => ({
                        get: () => selected,
                        inspect: () => (section.startsWith("stm32cube") ? { globalValue: executable } : {}),
                        update: async (_key, value) => {
                            selected = value;
                        }
                    })
                },
                window: {
                    showQuickPick: async () => ({ action: "select" }),
                    showOpenDialog: async (opts) => {
                        dialogOptions = opts;
                        return [{ fsPath: executable }];
                    }
                }
            }
        });
        assert.strictEqual((await configuration.detect()).executable, executable);
        assert.strictEqual(selected, executable);
        assert.strictEqual(configuration.status, "cubemx.ready");
        await configuration.select("tool");
        assert.strictEqual(dialogOptions.filters, undefined, "Linux picker must allow extensionless executables");
        selected = wrongName;
        assert.strictEqual(await configuration.detect(), null);
        assert.strictEqual(configuration.status, "cubemx.invalid");

        const project = path.join(root, "工程 空格");
        const content =
            "Mcu.Name=STM32F407VGTx\nMxCube.Version=6.12.0\nProjectManager.ProjectName=demo\nProjectManager.TargetToolchain=CMake\nProjectManager.KeepUserCode=true\nProjectManager.UnderRoot=true\nUSART2.BaudRate=9600\n";
        const ioc = await write(path.join(project, "demo.ioc"), content);
        await write(path.join(project, "main.c"), "baud=9600;\n");
        const storage = new Map();
        const service = new CubeMxService({
            platform: "linux",
            storageDir: path.join(root, "records"),
            storage: { get: (key) => storage.get(key), update: async (key, value) => storage.set(key, value) },
            config: () => ({ iocPath: ioc, cubemxPath: executable }),
            roots: () => [project],
            run: async (actualTool, stage, name) => {
                assert.strictEqual(actualTool.platform, "linux");
                const staged = await fs.readFile(path.join(stage, name), "utf8");
                await fs.writeFile(
                    path.join(stage, "demo", "main.c"),
                    `baud=${staged.match(/USART2.BaudRate=(\d+)/)[1]};\n`
                );
                return { log: "generated" };
            }
        });
        assert.strictEqual((await service.inspect()).tool.executable, executable);
        const candidate = content.replace("9600", "115200");
        await assert.rejects(service.execute({ content: candidate }), { code: "CUBEMX_CONFIRMATION_INVALID" });
        const prepared = await service.prepare({ content: candidate });
        assert.strictEqual(
            (await service.execute({ content: candidate, confirmationId: prepared.confirmationId })).generated,
            true
        );
        assert.strictEqual(await fs.readFile(path.join(project, "main.c"), "utf8"), "baud=115200;\n");
        assert.strictEqual((await service.check()).status, "consistent");
        assert.strictEqual((await service.check({ mode: "deep", wait: true })).status, "consistent");
        await fs.writeFile(path.join(project, "main.c"), "user change");
        assert.strictEqual((await service.check()).status, "drift_detected");

        // Native Linux output stays nested for both UnderRoot values; never accept
        // conflicting user directories, missing ownership evidence or mixed output roots.
        for (const underRoot of ["true", "false"]) {
            await fs.writeFile(ioc, content.replace("UnderRoot=true", `UnderRoot=${underRoot}`));
            const before = await snapshot(project);
            const stage = path.join(root, `stage-${underRoot}`);
            const staged = await stageGeneration(stage, before, "demo.ioc", tool);
            assert.strictEqual(staged.output, path.join(stage, "demo"));
            assert.strictEqual(await fs.readFile(path.join(staged.output, "main.c"), "utf8"), "user change");
            const generated = await snapshot(stage);
            assert(normalizeGenerated(before, generated, "demo.ioc", tool).has("main.c"));
            const missing = new Map(generated);
            missing.delete(path.join("demo", "demo.ioc"));
            assert.throws(
                () => normalizeGenerated(before, missing, "demo.ioc", tool),
                (error) => error.details.condition === "missing_nested_ioc"
            );
            const mixed = new Map(generated);
            mixed.set("main.c", { bytes: Buffer.from("unexpected"), hash: hash("unexpected") });
            assert.throws(
                () => normalizeGenerated(before, mixed, "demo.ioc", tool),
                (error) => error.details.condition === "dual_root_and_nested_output"
            );
            const conflict = new Map(before);
            conflict.set(path.join("demo", "user.txt"), { bytes: Buffer.from("keep"), hash: hash("keep") });
            await assert.rejects(
                stageGeneration(path.join(root, `conflict-${underRoot}`), conflict, "demo.ioc", tool),
                (error) => error.details.condition === "directory_conflict"
            );
            assert.throws(
                () => normalizeGenerated(conflict, generated, "demo.ioc", tool),
                (error) => error.details.condition === "directory_conflict"
            );
        }

        const missingPackage = await inspectFirmware(
            { target: "stm32f4x.cfg", cubemxPath: executable },
            { platform: "linux", home: root }
        );
        assert.strictEqual(missingPackage.installed, false);
        let script;
        let child;
        const spawn = (mode) => (command, args, opts) => {
            assert.strictEqual(command, executable, "Linux invokes the native launcher, not java -jar");
            assert.strictEqual(args[0], mode);
            assert.strictEqual(args.length, 2);
            assert.strictEqual(opts.shell, false);
            assert.strictEqual(opts.cwd, directory);
            script = args[1];
            child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.unref = () => {};
            child.kill = () => {};
            setImmediate(() => {
                child.emit("spawn");
                if (mode === "-q") {
                    child.stdout.emit("data", Buffer.from("Code generated successfully"));
                    child.emit("close", 0);
                }
            });
            return child;
        };
        await runCubeMx(tool, project, "demo.ioc", { spawn: spawn("-q") });
        await launchInstaller(tool, "F4", "1.28.0", { temp: root, spawn: spawn("-s") });
        assert.strictEqual(await fs.readFile(script, "utf8"), "swmgr refresh\nswmgr install stm32cube_f4_1.28.0 ask\n");
        child.emit("close", 0);
        console.log("Linux CubeMX discovery, configuration, generation and firmware tests passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
