"use strict";

const assert = require("node:assert/strict");
const { loadProvider } = require("./helpers/load-provider");
const i18n = require("../src/i18n");
const { ProbeCoordinator } = require("../src/probeCoordinator");

const targets = [
    { label: "STM32F407ZG", description: "STM32F4 Series" },
    { label: "STM32H723VG", description: "STM32H7 Series" }
];

function fixture(initial = {}, detected = {}) {
    const values = { backend: "probe-rs", probeRsPath: "custom-probe-rs", probeRsChip: "", ...initial };
    const state = new Map([
        ["mcu.debugger", "jlink.cfg"],
        ["mcu.mcuCore", "stm32f4x.cfg"]
    ]);
    const writes = [],
        picks = [],
        notices = [],
        calls = [];
    const vscode = {
        ConfigurationTarget: { Workspace: 2 },
        workspace: {
            getConfiguration: () => ({
                get: (key, fallback) => values[key] ?? fallback,
                update: async (key, value, scope) => {
                    writes.push({ key, value, scope });
                    values[key] = value;
                }
            })
        },
        window: {
            showQuickPick: async (items, options) => {
                picks.push({ items, options });
                return items[0];
            },
            showInputBox: () => {
                throw new Error("MCU targets must use the registry picker");
            },
            showInformationMessage: (message) => notices.push(message),
            showWarningMessage: (message) => notices.push(message)
        }
    };
    const dependencies = {
        list: async (executable) => {
            calls.push({ executable });
            return targets;
        }
    };
    const Provider = loadProvider(vscode, {
        "./services/probeRsTargets": {
            listProbeRsTargets: (...args) => dependencies.list(...args)
        },
        "./autoDetect": {
            detectWorkspace: async (...args) => {
                calls.push({ detection: args });
                return { elf: "", mcu: "", mcuCandidates: [], debugger: "", probeCandidates: [], ...detected };
            }
        }
    });
    const provider = Object.create(Provider.prototype);
    Object.assign(provider, {
        commandHandlers: {},
        _context: {
            workspaceState: {
                get: (key) => state.get(key),
                update: async (key, value) => {
                    writes.push({ key, value });
                    state.set(key, value);
                }
            }
        },
        _debugBridge: { hasAnySession: false },
        _probeCoordinator: new ProbeCoordinator(),
        _cubemxConfiguration: { detectIoc: async () => "board.ioc" },
        _assertCpuIdle() {},
        _assertProbeDriverIdle() {},
        _refreshElfBindings: async () => {},
        _refreshJlinkDriverChoice: () => {
            throw new Error("probe-rs configuration must not select OpenOCD drivers");
        },
        updateView: async () => {},
        _t: (key, params) => i18n.t("en", key, params)
    });
    provider.registerCommandHandlers();
    return { provider, vscode, values, state, writes, picks, notices, calls, dependencies };
}

async function main() {
    const manual = fixture({ probeRsChip: "STM32H723VG" });
    assert.equal(await manual.provider.commandHandlers["mcu-vscode.selectMcuCore"](), true);
    assert.equal(manual.calls[0].executable, "custom-probe-rs");
    assert.equal(manual.picks[0].items[0].label, "STM32H723VG", "show the current chip first");
    assert.equal(manual.picks[0].options.matchOnDescription, true);
    assert.match(manual.picks[0].options.placeHolder, /chip|MCU/i);
    assert.deepEqual(manual.writes, [{ key: "probeRsChip", value: "STM32H723VG", scope: 2 }]);
    assert.equal(manual.state.get("mcu.mcuCore"), "stm32f4x.cfg");

    const cancelled = fixture({ probeRsChip: "STM32H723VG" });
    cancelled.vscode.window.showQuickPick = async () => undefined;
    assert.equal(await cancelled.provider.commandHandlers["mcu-vscode.selectMcuCore"](), null);
    assert.equal(cancelled.writes.length, 0);

    const automatic = fixture({}, { elf: "firmware.elf", mcu: "STM32H723VG", mcuCandidates: ["STM32H723VG"] });
    const found = await automatic.provider.runAutoDetect(true);
    assert.equal(found.mcu, "STM32H723VG");
    assert.equal(automatic.values.probeRsChip, "STM32H723VG");
    assert.equal(automatic.picks.length, 0, "unique workspace targets configure automatically");
    assert.deepEqual(automatic.calls.find((call) => call.detection).detection.slice(1), [
        "probe-rs",
        targets,
        "board.ioc"
    ]);
    assert.equal(automatic.state.get("mcu.mcuCore"), "stm32f4x.cfg");
    assert.equal(automatic.state.get("mcu.debugger"), "jlink.cfg");
    assert.match(automatic.notices[0], /STM32H723VG/);

    const unresolved = fixture({}, { mcuCandidates: ["STM32H723VG", "STM32F407ZG"] });
    await unresolved.provider.runAutoDetect(true);
    assert.equal(unresolved.picks.length, 1);
    assert.equal(unresolved.values.probeRsChip, "STM32F407ZG");

    const missing = fixture();
    await missing.provider.runAutoDetect(true);
    assert.equal(missing.picks.length, 1, "one-click setup includes the MCU picker when hints are missing");
    assert.equal(missing.values.probeRsChip, "STM32F407ZG");

    const cancelSetup = fixture({ probeRsChip: "unsupported-chip" });
    cancelSetup.vscode.window.showQuickPick = async () => undefined;
    await cancelSetup.provider.runAutoDetect(true);
    assert.equal(cancelSetup.values.probeRsChip, "unsupported-chip", "cancelled setup preserves the current target");
    assert.equal(cancelSetup.writes.length, 0);

    const keep = fixture({ probeRsChip: "STM32H723VG" });
    await keep.provider.runAutoDetect(true);
    assert.equal(keep.picks.length, 0, "keep an existing registry target when there are no workspace hints");
    assert.equal(keep.values.probeRsChip, "STM32H723VG");

    const background = fixture();
    await background.provider.runAutoDetect(false);
    assert.equal(background.picks.length, 0, "background detection must not show pickers");
    assert.equal(background.writes.length, 0);
    const backgroundMatch = fixture({}, { mcu: "STM32H723VG", mcuCandidates: ["STM32H723VG"] });
    await backgroundMatch.provider.runAutoDetect(false);
    assert.equal(backgroundMatch.values.probeRsChip, "STM32H723VG");
    assert.equal(backgroundMatch.notices.length, 0);
    const backgroundKeep = fixture({ probeRsChip: "STM32F407ZG" }, { mcu: "STM32H723VG" });
    await backgroundKeep.provider.runAutoDetect(false);
    assert.equal(backgroundKeep.values.probeRsChip, "STM32F407ZG");
    assert.equal(
        backgroundKeep.calls.some((call) => call.executable),
        false
    );

    for (const force of [false, true]) {
        const failed = fixture({ probeRsChip: force ? "STM32H723VG" : "" });
        failed.dependencies.list = async () => {
            throw Object.assign(new Error("missing executable"), { code: "PROBE_RS_TARGET_LIST_FAILED" });
        };
        await assert.rejects(failed.provider.runAutoDetect(force), { code: "PROBE_RS_TARGET_LIST_FAILED" });
        assert.equal(failed.writes.length, 0);
        assert.equal(failed.picks.length, 0);
    }
    const failedManual = fixture();
    failedManual.dependencies.list = async () => {
        throw Object.assign(new Error("missing executable"), { code: "PROBE_RS_TARGET_LIST_FAILED" });
    };
    await assert.rejects(failedManual.provider.commandHandlers["mcu-vscode.selectMcuCore"](), {
        code: "PROBE_RS_TARGET_LIST_FAILED"
    });
    assert.equal(failedManual.writes.length, 0);

    for (const action of [
        (f) => f.provider.commandHandlers["mcu-vscode.selectMcuCore"](),
        (f) => f.provider.runAutoDetect(true)
    ]) {
        const busy = fixture();
        busy.provider._debugBridge.hasAnySession = true;
        await assert.rejects(action(busy), { code: "PROBE_CONFIGURATION_BUSY" });
        assert.equal(busy.calls.length, 0, "reject busy sessions before listing or detecting");
        const downloading = fixture();
        const download = downloading.provider._probeCoordinator.acquire("download");
        try {
            await assert.rejects(action(downloading), { code: "PROBE_CONFIGURATION_BUSY" });
            assert.equal(downloading.calls.length, 0, "probe ownership blocks configuration before discovery");
        } finally {
            download.release();
        }
        const changedWhileLoading = fixture();
        changedWhileLoading.dependencies.list = async () => {
            changedWhileLoading.values.probeRsPath = "other-probe-rs";
            return targets;
        };
        await assert.rejects(action(changedWhileLoading), { code: "PROBE_RS_CONFIGURATION_CHANGED" });
        assert.equal(changedWhileLoading.writes.length, 0);
        assert.equal(changedWhileLoading.picks.length, 0);
        for (const change of [
            (f) => {
                f.provider._debugBridge.hasAnySession = true;
            },
            (f) => {
                f.values.backend = "openocd";
            },
            (f) => {
                f.values.probeRsPath = "other-probe-rs";
            },
            (f) => {
                f.values.probeRsChip = "STM32H723VG";
            },
            (f) => {
                f.provider._probeCoordinator.acquire("liveStart");
            }
        ]) {
            const stale = fixture();
            stale.vscode.window.showQuickPick = async (items) => {
                change(stale);
                return items[0];
            };
            await assert.rejects(action(stale), (error) =>
                ["PROBE_CONFIGURATION_BUSY", "PROBE_RS_CONFIGURATION_CHANGED"].includes(error.code)
            );
            assert.equal(stale.writes.length, 0, "a changed connection must not receive a stale selection");
        }
    }
    console.log("probe-rs manual and one-click MCU selection, cancellation and connection guards passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
