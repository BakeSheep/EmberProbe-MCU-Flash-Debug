"use strict";
const path = require("path");

const assert = require("assert");
const { OpenOcdStatusService } = require("../src/services/openocdStatusService");
const { createFixture } = require("./helpers/service-fixture");
(async () => {
    const fixture = createFixture();
    const { temp, elf, state, settings, cacheKeys, context, vscode, store } = fixture;
    try {
        const statusEvents = [];
        const checker = {
            probeOpenOcd: async (target) => ({ found: true, path: target, requested: target, version: "1.0" }),
            setCache(result) {
                this.cached = result;
            },
            getCachedResult() {
                return this.cached;
            },
            isCompatibleResult(result) {
                return Boolean(result?.found && Number.parseFloat(result.version) >= 0.12);
            },
            resolveOpenOcdStatus: async (_target, _context, result, report) => {
                report({ state: "ready", result });
                return result.path;
            }
        };
        const statusService = new OpenOcdStatusService({
            vscode: {
                workspace: { getConfiguration: () => ({ get: () => "openocd" }) },
                commands: { executeCommand: () => {} }
            },
            context,
            checker,
            getLang: () => "en",
            onStatus: (status) => statusEvents.push(status)
        });
        assert.strictEqual(await statusService.refresh(), "openocd");
        assert.strictEqual(await statusService.resolve("openocd"), "openocd");
        assert.ok(statusEvents.some((event) => event.state === "ready"));
        checker.installBundledAndConfigure = async () => "/bundled/openocd";
        checker.pickOpenOcdPath = async () => "/picked/openocd";
        assert.strictEqual(await statusService.handleAction("install"), "/bundled/openocd");
        assert.strictEqual(await statusService.handleAction("select"), "/picked/openocd");
        checker.cached = { found: true, path: "old", requested: "old", version: "0.12.0" };
        assert.strictEqual(await statusService.resolve("new-openocd"), "new-openocd");
    } finally {
        fixture.dispose();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
