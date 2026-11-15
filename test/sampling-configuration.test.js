"use strict";
const assert = require("assert");
const { SamplingConfiguration } = require("../src/services/samplingConfiguration");
const { createFixture } = require("./helpers/service-fixture");
const { scenario } = require("./helpers/scenario");

async function main() {
    const fixture = createFixture();
    const chips = [
        { name: "STM32C593RGT6", family: "STM32C593", core: "armv8m" },
        { name: "STM32F407VGTx", family: "STM32F4", core: "armv7em" }
    ];
    let busy = false;
    let changed = 0;
    let pick;
    fixture.vscode.window = { showQuickPick: (...args) => pick(...args) };
    const host = {
        _assertConnectionEditable() {
            if (busy) throw new Error("busy");
        },
        _commandContext: () => ({ cwd: fixture.temp }),
        _t: (key) => key,
        _nativeSamplingService: { listChips: async () => chips },
        updateView: async () => {
            changed++;
        }
    };
    const controller = new SamplingConfiguration({ host, vscode: fixture.vscode });
    fixture.state.set(fixture.cacheKeys.mcuCore, "stm32f4x.cfg");
    fixture.state.set(fixture.cacheKeys.elfPath, fixture.elf);
    try {
        await scenario("backend choices retain shared ELF and OpenOCD target", async () => {
            pick = async (options) => {
                assert.equal(options.length, 2);
                assert.equal(options[0].picked, true);
                return options[1];
            };
            assert.equal(await controller.selectBackend(), true);
            assert.equal(fixture.settings.get("samplingBackend"), "probe-rs");
            assert.equal(changed, 1);
            pick = async () => undefined;
            assert.equal(await controller.selectBackend(), null);
            assert.equal(changed, 1);
            assert.equal(fixture.state.get(fixture.cacheKeys.mcuCore), "stm32f4x.cfg");
            assert.equal(fixture.state.get(fixture.cacheKeys.elfPath), fixture.elf);
        });
        await scenario("searchable chip choices keep the current chip first and save only its name", async () => {
            fixture.settings.set("probeRsChip", chips[1].name);
            pick = async (options, settings) => {
                assert.equal(settings.matchOnDescription, true);
                assert.equal(settings.matchOnDetail, true);
                assert.equal(options[0].label, chips[1].name);
                assert.equal(options[0].picked, true);
                return options.find((option) => option.label === chips[0].name);
            };
            assert.equal(await controller.selectChip(), true);
            assert.equal(fixture.settings.get("probeRsChip"), chips[0].name);
            assert.equal(fixture.settings.get("samplingBackend"), "probe-rs");
            assert.equal(fixture.state.get(fixture.cacheKeys.mcuCore), "stm32f4x.cfg");
            pick = async () => undefined;
            assert.equal(await controller.selectChip(), null);
        });
        await scenario("busy sessions and settings changed during a picker cannot save stale selections", async () => {
            busy = true;
            await assert.rejects(controller.selectChip(), /busy/);
            await assert.rejects(controller.selectBackend(), /busy/);
            busy = false;
            const dynamicConfiguration = fixture.vscode.workspace.getConfiguration;
            fixture.vscode.workspace.getConfiguration = () => {
                const snapshot = new Map(fixture.settings);
                return {
                    get: (key, fallback) => (snapshot.has(key) ? snapshot.get(key) : fallback),
                    update: async () => assert.fail("stale picker saved settings")
                };
            };
            pick = async (options) => {
                busy = true;
                return options[0];
            };
            await assert.rejects(controller.selectChip(), /busy/);
            busy = false;
            pick = async (options) => {
                busy = true;
                return options[0];
            };
            await assert.rejects(controller.selectBackend(), /busy/);
            busy = false;
            pick = async (options) => {
                fixture.settings.set("probeRsTargetDescription", "changed.yaml");
                return options[0];
            };
            assert.equal(await controller.selectChip(), null);
            pick = async (options) => {
                fixture.settings.set("samplingBackend", "openocd");
                return options[1];
            };
            assert.equal(await controller.selectBackend(), null);
            fixture.vscode.workspace.getConfiguration = dynamicConfiguration;
            host._nativeSamplingService.listChips = async () => {
                throw new Error("catalog unavailable");
            };
            await assert.rejects(controller.selectChip(), /catalog unavailable/);
        });
    } finally {
        fixture.dispose();
    }
}
main()
    .then(() => console.log("Sampling configuration pickers passed"))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
