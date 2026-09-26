"use strict";
const assert = require("assert");
const { ChipInfoService } = require("../src/services/chipInfoService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
    try {
        const active = new Set();
        const chipPosts = [];
        let chipDiagnostics = null;
        let targetState = "running";
        const actions = [];
        const chipService = new ChipInfoService({
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            context: { workspaceState: { get: (key) => (key === "debugger" ? "p.cfg" : "t.cfg") } },
            cacheKeys: { debugger: "debugger", mcuCore: "target" },
            chipInfo: {
                readChipInfo: async () => ({ core: "Cortex-M4", targetState }),
                controlTarget: async (_options, action) => {
                    actions.push(action);
                    targetState = action === "pause" ? "halted" : "running";
                    return { state: targetState };
                }
            },
            coordinator: {
                isActive: (name) => active.has(name),
                acquire: (name) => {
                    active.add(name);
                    return { release: () => active.delete(name) };
                }
            },
            t: (key) => key,
            resolveExecutable: async (value) => value,
            commandContext: () => ({ cwd: temp }),
            onPost: (message) => chipPosts.push(message),
            onDiagnostics: (diagnostic) => {
                chipDiagnostics = diagnostic;
            },
            isDebugActive: () => false
        });
        const chipResult = await chipService.read();
        assert.strictEqual(chipResult.core, "Cortex-M4");
        assert.ok(Number.isFinite(Date.parse(chipResult.readAt)));
        assert.strictEqual(chipService.running, false);
        assert.ok(chipPosts.some((message) => message.type === "chipInfo"));
        assert.strictEqual(chipDiagnostics.target, "t.cfg");
        assert.ok(chipDiagnostics.timings.totalMs >= 0);
        assert.ok(chipDiagnostics.timings.configMs >= 0);
        assert.ok(chipDiagnostics.timings.preflightMs >= 0);
        assert.ok(chipDiagnostics.timings.openOcdMs >= 0);
        assert.strictEqual((await chipService.control("pause")).targetState, "halted");
        assert.strictEqual((await chipService.control("continue")).targetState, "running");
        assert.strictEqual((await chipService.control("reset")).targetState, "running");
        assert.deepStrictEqual(actions, ["pause", "continue", "reset"]);
        assert.strictEqual(chipService.running, false);
        await assert.rejects(
            () => chipService.control("bogus"),
            (error) => error.code === "CHIP_ACTION_INVALID"
        );
        active.add("download");
        assert.strictEqual(await chipService.read(), null);
        assert.strictEqual(await chipService.control("pause"), null);
        assert.deepStrictEqual(actions, ["pause", "continue", "reset"]);
        assert.ok(chipPosts.some((message) => message.key === "chip.busyDownload"));
        active.delete("download");

        const unavailableChip = new ChipInfoService({
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            context: { workspaceState: { get: () => "configured.cfg" } },
            cacheKeys: { debugger: "debugger", mcuCore: "target" },
            chipInfo: { readChipInfo: async () => ({}) },
            coordinator: {
                isActive: () => false,
                acquire: () => ({ release: () => {} })
            },
            t: (key) => key,
            resolveExecutable: async () => null,
            commandContext: () => ({ cwd: temp }),
            onPost: () => {},
            onDiagnostics: () => {},
            isDebugActive: () => false
        });
        await assert.rejects(
            () => unavailableChip.read(true),
            (error) => error.code === "OPENOCD_NOT_READY"
        );
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
