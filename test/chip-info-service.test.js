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
        const chipService = new ChipInfoService({
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            context: { workspaceState: { get: (key) => (key === "debugger" ? "p.cfg" : "t.cfg") } },
            cacheKeys: { debugger: "debugger", mcuCore: "target" },
            chipInfo: { readChipInfo: async () => ({ core: "Cortex-M4" }) },
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
            onDiagnostics: () => {},
            isDebugActive: () => false
        });
        assert.deepStrictEqual(await chipService.read(), { core: "Cortex-M4" });
        assert.strictEqual(chipService.running, false);
        assert.ok(chipPosts.some((message) => message.type === "chipInfo"));
        active.add("download");
        assert.strictEqual(await chipService.read(), null);
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
