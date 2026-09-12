"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const {
    targetFamily,
    updaterSettings,
    packageVersions,
    availableVersions,
    inspectFirmware,
    launchInstaller,
    CubeMxFirmware
} = require("../src/services/cubemxFirmware");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx-firmware-test-"));
    const write = async (name, content = "") => {
        const file = path.join(root, name);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
        return file;
    };
    try {
        for (const [target, family] of [
            ["target/stm32h7x.cfg", "H7"],
            ["STM32H750VBTx", "H7"],
            ["stm32h7rsx.cfg", "H7RS"],
            ["stm32wb0x.cfg", "WB0"],
            ["stm32wbx.cfg", "WB"],
            ["stm32f4x.cfg", "F4"],
            ["nrf52.cfg", ""],
            ["stm32h7evil.cfg", ""],
            ["", ""]
        ])
            assert.strictEqual(targetFamily(target), family);
        const home = path.join(root, "home");
        const repository = path.join(root, "固件 仓库");
        const updater = "home/.stm32cubemx/plugins/updater/";
        assert.strictEqual((await updaterSettings(home)).repository, path.join(home, "STM32Cube", "Repository"));
        assert.deepStrictEqual(await availableVersions(home, "H7"), []);
        await write(updater + "updater.ini", `RepositoryPath=${repository}\n`);
        await write(
            updater + "STMUpdaterDefinitions.xml",
            '<Packages><Firmwares><Firmware><PackDescription Release="FW.H7.1.9.0"/></Firmware><Firmware><PackDescription Release="FW.H7.1.12.0" Patch="FW.H7.1.12.1"/></Firmware><Firmware><PackDescription Release="FW.F1.1.8.0"/></Firmware></Firmwares></Packages>'
        );
        assert.deepStrictEqual(await availableVersions(path.join(root, updater), "H7"), ["1.12.1", "1.9.0"]);
        assert.deepStrictEqual(await packageVersions(repository, "H7"), []);
        const config = { target: "stm32h7x.cfg", cubemxPath: "CubeMX.exe", iocPath: "" };
        const options = { home, platform: "win32", installation: async () => ({}) };
        assert.strictEqual(await inspectFirmware({ ...config, cubemxPath: "" }, options), null);
        assert.strictEqual(await inspectFirmware({ ...config, target: "nrf52.cfg" }, options), null);
        assert.strictEqual(await inspectFirmware(config, { ...options, platform: "linux" }), null);
        assert.strictEqual((await inspectFirmware(config, options)).installed, false);
        const packageRoot = "固件 仓库/STM32Cube_FW_H7_V1.13.0/";
        await write(packageRoot + "package.xml", '<Package><PackDescription Release="FW.H7.1.13.0"/></Package>');
        assert.strictEqual((await inspectFirmware(config, options)).installed, false, "incomplete download");
        await write(packageRoot + "Drivers/CMSIS/file");
        await write(packageRoot + "Drivers/STM32H7xx_HAL_Driver/file");
        assert.strictEqual((await inspectFirmware(config, options)).installed, true);
        config.iocPath = await write(
            "demo.ioc",
            "Mcu.Name=STM32H750VBTx\nProjectManager.FirmwarePackage=STM32Cube FW_H7 V1.12.0\n"
        );
        let result = await inspectFirmware(config, options);
        assert.strictEqual(result.installed, false, "other version does not satisfy ioc");
        assert.deepStrictEqual(result.available, ["1.12.0"]);
        await fs.appendFile(config.iocPath, "ProjectManager.DefaultFWLocation=false\n");
        await assert.rejects(inspectFirmware(config, options), /custom firmware/);
        await fs.writeFile(
            config.iocPath,
            "Mcu.Name=STM32F103C8Tx\nProjectManager.FirmwarePackage=STM32Cube FW_F1 V1.8.0"
        );
        await assert.rejects(inspectFirmware(config, options), /do not match/);
        await fs.writeFile(
            config.iocPath,
            "Mcu.Name=STM32H750VBTx\nProjectManager.FirmwarePackage=STM32Cube FW_H7 V1.13.0"
        );
        assert.strictEqual((await inspectFirmware(config, options)).installed, true);
        await fs.writeFile(path.join(root, updater, "updater.ini"), "RepositoryPath=relative/path\n");
        await assert.rejects(inspectFirmware(config, options), /Invalid CubeMX RepositoryPath/);

        let child;
        let script;
        const tool = { java: path.join(root, "工具 java.exe"), executable: path.join(root, "STM32CubeMX.exe") };
        await launchInstaller(tool, "H7", "1.13.0", {
            temp: root,
            spawn: (exe, args, opts) => {
                assert.strictEqual(exe, tool.java);
                assert.deepStrictEqual(args.slice(0, 3), ["-jar", tool.executable, "-s"]);
                script = args[3];
                assert.strictEqual(opts.shell, false);
                child = new EventEmitter();
                child.unref = () => {};
                process.nextTick(() => child.emit("spawn"));
                return child;
            }
        });
        assert.strictEqual(await fs.readFile(script, "utf8"), "swmgr refresh\nswmgr install stm32cube_h7_1.13.0 ask\n");
        child.emit("close");
        await assert.rejects(launchInstaller(tool, "H7", "1.0.0\nexit"), /Invalid firmware/);
        await assert.rejects(
            launchInstaller(tool, "H7", "1.0.0", {
                temp: root,
                spawn: () => {
                    const child = new EventEmitter();
                    process.nextTick(() => child.emit("error", new Error("spawn failed")));
                    return child;
                }
            }),
            /spawn failed/
        );

        let launches = 0;
        let changed = 0;
        let nextChoice = "1.13.0";
        result = { family: "H7", installed: false, requiredVersion: "", available: ["1.13.0"] };
        const service = new CubeMxFirmware({
            context: { workspaceState: { get: (key) => (key === "mcu.mcuCore" ? config.target : config.iocPath) } },
            vscode: {
                workspace: { getConfiguration: () => ({ get: () => config.cubemxPath }) },
                window: {
                    showQuickPick: async () => (nextChoice ? { value: nextChoice } : undefined),
                    showInputBox: async (opts) => {
                        assert(opts.validateInput("bad"));
                        assert.strictEqual(opts.validateInput("1.13.0"), null);
                        return nextChoice;
                    },
                    showInformationMessage: async () => {},
                    showWarningMessage: async () => {}
                }
            },
            inspect: async () => result,
            installation: async () => tool,
            launch: async (_tool, family, version) => {
                assert.strictEqual(family, "H7");
                assert.strictEqual(version, "1.13.0");
                launches++;
            },
            t: (key) => key,
            changed: () => changed++
        });
        await service.install();
        assert.strictEqual(launches, 1);
        nextChoice = "";
        await service.install();
        assert.strictEqual(launches, 1, "cancellation must not launch");
        nextChoice = "1.13.0";
        result.available = [];
        await service.install();
        assert.strictEqual(launches, 2);
        result.requiredVersion = "1.13.0";
        await service.install();
        assert.strictEqual(launches, 3);
        result.installed = true;
        await service.install();
        assert.strictEqual(launches, 3);
        service.inspect = async () => {
            throw new Error("invalid config");
        };
        await service.install();
        assert.strictEqual(service.error, "invalid config");
        assert(changed > 0);

        for (const lang of ["zh", "en"]) {
            const view = render(getModernWebviewContent({ cubemxFirmware: { ...result, installed: false } }, lang));
            try {
                view.assertHealthy();
                assert.strictEqual(
                    view.document.querySelectorAll('#otherConfig [data-i18n="common.optional"]').length,
                    3
                );
                view.document.querySelector('[data-command="mcu-vscode.installCubeMxFirmware"]').click();
                assert.strictEqual(view.messages.at(-1).cmd, "mcu-vscode.installCubeMxFirmware");
            } finally {
                view.window.close();
            }
        }
        console.log("CubeMX firmware tests passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
