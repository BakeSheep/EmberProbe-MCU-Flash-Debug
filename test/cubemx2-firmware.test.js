"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const {
    inspectFirmware,
    packRepository,
    projectRequirements,
    versionMatches
} = require("../src/services/cubemx2Firmware");
const { parseIoc2 } = require("../src/services/cubemx2Project");

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx2-firmware-"));
    const repository = path.join(root, "packs");
    const fixture = await fs.readFile(path.join(__dirname, "fixtures/cubemx2/c593.ioc2"), "utf8");
    const project = path.join(root, "board.ioc2");
    const options = { platform: "win32", env: { CMSIS_PACK_ROOT: repository }, installation: async () => ({}) };
    const config = { target: "stm32c5x.cfg", cubemx2Path: "CubeMX2.exe", iocPath: project };
    async function pack(name, version, content = null) {
        const directory = path.join(repository, "STMicroelectronics", name, version);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(
            path.join(directory, "STMicroelectronics." + name + ".pdsc"),
            content ||
                "<package><vendor>STMicroelectronics</vendor><name>" +
                    name +
                    '</name><releases><release version="' +
                    version +
                    '"/></releases></package>'
        );
    }
    try {
        await fs.writeFile(project, fixture);
        await scenario("Resolve CubeMX2 pack roots from the environment, settings and platform defaults", async () => {
            assert.strictEqual(await packRepository(options), repository);
            const home = path.join(root, "home");
            const settings = path.join(home, "AppData", "Roaming", "stm32cube");
            const localOptions = { platform: "win32", home, env: {} };
            assert.strictEqual(
                await packRepository(localOptions),
                path.join(home, "AppData", "Local", "stm32cube", "packs")
            );
            assert.strictEqual(
                await packRepository({ ...localOptions, platform: "linux" }),
                path.join(home, ".local", "share", "stm32cube", "packs")
            );
            await fs.mkdir(settings, { recursive: true });
            const file = path.join(settings, "CubeUserConfig.json");
            await fs.writeFile(file, JSON.stringify({ cmsis_pack_root: repository }));
            assert.strictEqual(await packRepository(localOptions), repository);
            assert.strictEqual(await packRepository({ ...localOptions, env: { CMSIS_PACK_ROOT: root } }), root);
            await fs.writeFile(file, JSON.stringify({ cmsis_pack_root: "../outside" }));
            await assert.rejects(packRepository(localOptions), /absolute/);
            await assert.rejects(packRepository({ ...options, env: { CMSIS_PACK_ROOT: "relative" } }), /absolute/);
        });
        await scenario("Verify every pack and exact version declared by a real ioc2", async () => {
            const requirements = projectRequirements(parseIoc2(fixture));
            assert.strictEqual(requirements.length, 5);
            assert.strictEqual((await inspectFirmware(config, options)).state, "missing");
            await pack("stm32c5xx_dfp", "2.2.0");
            let result = await inspectFirmware(config, options);
            assert.strictEqual(result.state, "version-mismatch");
            assert.strictEqual(result.installed, false);
            const dfp = result.packs.find((entry) => entry.name === "stm32c5xx_dfp");
            assert.strictEqual(dfp.requiredVersion, "2.1.0");
            assert.deepStrictEqual(dfp.versions, ["2.2.0"]);
            for (const requirement of requirements) await pack(requirement.name, requirement.requiredVersion);
            result = await inspectFirmware(config, options);
            assert.strictEqual(result.installed, true);
            assert.strictEqual(result.state, "installed");
            assert.deepStrictEqual(result.packs.find((entry) => entry.name === dfp.name).versions, ["2.2.0", "2.1.0"]);
            assert.strictEqual(
                await fs.readFile(project, "utf8"),
                fixture,
                "inspection preserves the project's requirements"
            );
        });
        await scenario("Inspect future series through project metadata and target-only detection", async () => {
            for (const family of ["g5", "h7"]) {
                const content = fixture.replace(/c5/g, family).replace(/C5/g, family.toUpperCase());
                await fs.writeFile(project, content);
                const result = await inspectFirmware({ ...config, target: "stm32" + family + "x.cfg" }, options);
                assert.strictEqual(result.family, family.toUpperCase());
                assert.ok(result.packs.some((entry) => entry.name === "stm32" + family + "xx_hal_drivers"));
                assert.strictEqual(result.installed, false);
            }
            for (const part of ["dfp", "hal_drivers"]) await pack("stm32g5xx_" + part, "3.0.0");
            const result = await inspectFirmware({ ...config, target: "stm32g5x.cfg", iocPath: "" }, options);
            assert.strictEqual(result.installed, true);
            assert.strictEqual(result.packs.length, 2);
            await fs.writeFile(project, fixture);
            await assert.rejects(inspectFirmware({ ...config, target: "stm32h7x.cfg" }, options), /do not match/);
        });
        await scenario(
            "Respect declared version ranges and mark local or conditional requirements unknown",
            async () => {
                for (const [version, required, matched] of [
                    ["2.1.0", "2.1.0", true],
                    ["2.2.0", "2.1.0", false],
                    ["2.1.0", "", true],
                    ["2.2.0", "^2.1.0", true],
                    ["3.0.0", "^2.1.0", false],
                    ["2.1.1", "~2.1.0", true],
                    ["2.2.0", "~2.1.0", false],
                    ["2.0.9", ">=2.1.0", false],
                    ["3.0.0", ">=2.1.0", true],
                    ["2.1.0", "*", null],
                    ["0.2.3", "^0.2.0", true],
                    ["0.3.0", "^0.2.0", false],
                    ["0.0.3", "^0.0.3", true],
                    ["0.0.4", "^0.0.3", false]
                ])
                    assert.strictEqual(versionMatches(version, required), matched);
                const mixedUnsupported = fixture.replace(
                    "    - pack: STMicroelectronics::syscalls@2.0.0",
                    "    - pack: STMicroelectronics::syscalls@2.0.0\n    - pack: STMicroelectronics::stm32c5xx_dfp@*"
                );
                await fs.writeFile(project, mixedUnsupported);
                assert.strictEqual(
                    (await inspectFirmware(config, options)).state,
                    "unknown",
                    "an unsupported sibling range must classify as unknown rather than false version-mismatch"
                );
                const wbOnly = await inspectFirmware(
                    { cubemx2Path: config.cubemx2Path, target: "target/stm32wbx.cfg", iocPath: "" },
                    options
                );
                assert.strictEqual(wbOnly.family, "WB");
                const h7rsOnly = await inspectFirmware(
                    { cubemx2Path: config.cubemx2Path, target: "target/stm32h7rsx.cfg", iocPath: "" },
                    options
                );
                assert.strictEqual(h7rsOnly.family, "H7RS");
                const conditional = fixture.replace(
                    "STMicroelectronics::stm32c5xx_dfp@2.1.0",
                    "STMicroelectronics::stm32c5xx_dfp@2.1.0\n      for-context: +Debug"
                );
                await fs.writeFile(project, conditional);
                assert.strictEqual((await inspectFirmware(config, options)).state, "unknown");
                const ranged = fixture.replace(
                    "STMicroelectronics::stm32c5xx_dfp@2.1.0",
                    "STMicroelectronics::stm32c5xx_dfp@^2.2.0"
                );
                await fs.writeFile(project, ranged);
                assert.strictEqual((await inspectFirmware(config, options)).installed, true);
                const conflict = fixture.replace(
                    "    - pack: STMicroelectronics::syscalls@2.0.0",
                    "    - pack: STMicroelectronics::syscalls@2.0.0\n    - pack: STMicroelectronics::stm32c5xx_dfp@2.2.0"
                );
                await fs.writeFile(project, conflict);
                assert.strictEqual(
                    (await inspectFirmware(config, options)).state,
                    "version-mismatch",
                    "two installed versions cannot satisfy conflicting requirements for one pack"
                );
            }
        );
        await scenario("Reject malformed metadata and ignore incomplete or unrelated installed packs", async () => {
            await fs.writeFile(project, fixture);
            await pack("stm32c5xx_hal_drivers", "2.1.0", "<package><vendor>Other</vendor><name>wrong</name></package>");
            assert.strictEqual((await inspectFirmware(config, options)).installed, false);
            await fs.writeFile(
                project,
                fixture.replace("STMicroelectronics::syscalls@2.0.0", "Vendor::../escape@2.0.0")
            );
            await assert.rejects(inspectFirmware(config, options), /identifier/);
            await fs.writeFile(project, "invalid .ioc2");
            await assert.rejects(inspectFirmware(config, options));
            assert.strictEqual(await inspectFirmware({ ...config, cubemx2Path: "" }, options), null);
            assert.strictEqual(await inspectFirmware({ ...config, target: "", iocPath: "" }, options), null);
            assert.strictEqual(await inspectFirmware(config, { ...options, platform: "darwin" }), null);
        });
        console.log("CubeMX2 firmware detection and project version matching passed");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
