"use strict";

const { scenario } = require("./helpers/scenario");

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
        checker.installBundledAndConfigure = async () =>
            assert.fail("Legacy install actions must not install or configure");
        checker.pickOpenOcdPath = async () => "/picked/openocd";
        assert.strictEqual(await statusService.handleAction("install"), "openocd");
        assert.strictEqual(await statusService.handleAction("select"), "/picked/openocd");
        checker.cached = { found: true, path: "old", requested: "old", version: "0.12.0" };
        assert.strictEqual(await statusService.resolve("new-openocd"), "new-openocd");
    } finally {
        fixture.dispose();
    }

    await scenario("Share concurrent OpenOCD resolve and refresh results", async () => {
        function deferred() {
            let resolve;
            const promise = new Promise((done) => {
                resolve = done;
            });
            return { promise, resolve };
        }
        const probe = deferred();
        const checker = {
            probeOpenOcd: () => probe.promise,
            getCachedResult: () => null,
            isCompatibleResult: () => false,
            setCache() {},
            resolveOpenOcdStatus: async (_target, _context, result, report) => {
                report({ state: "ready" });
                return result.path;
            }
        };
        const status = new OpenOcdStatusService({
            checker,
            context: {},
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            onStatus() {}
        });
        const resolving = status.resolve("openocd"),
            refreshing = status.refresh();
        probe.resolve({ path: "valid-openocd" });
        assert.deepStrictEqual(await Promise.all([resolving, refreshing]), ["valid-openocd", "valid-openocd"]);
    });

    await scenario(
        "Prefer the bundled default over a compatible system cache without changing explicit paths",
        async () => {
            let preparations = 0;
            const probes = [];
            const checker = {
                cached: { found: true, path: "/usr/bin/openocd", requested: "openocd", version: "0.12.0" },
                getCachedResult() {
                    return this.cached;
                },
                setCache(result) {
                    this.cached = result;
                },
                isCompatibleResult: (result) => Boolean(result?.found),
                shouldUseBundledDefault: (target) => target === "openocd",
                async probeDefaultOpenOcd(target) {
                    if (target !== "openocd") return undefined;
                    preparations++;
                    return { found: true, path: "/storage/bundled/openocd", requested: target, bundled: true };
                },
                async probeOpenOcd(target) {
                    probes.push(target);
                    return { found: true, path: target, requested: target };
                },
                async resolveOpenOcdStatus(_target, _context, result, report) {
                    report({ state: result.found ? "ready" : "missing" });
                    return result.found ? result.path : null;
                }
            };
            const service = new OpenOcdStatusService({
                checker,
                context: {},
                vscode: {
                    workspace: { getConfiguration: () => ({ get: () => "" }) },
                    commands: { executeCommand() {} }
                },
                onStatus() {}
            });
            assert.strictEqual(await service.resolve("openocd"), "/storage/bundled/openocd");
            assert.deepStrictEqual(await Promise.all([service.resolve(""), service.refresh()]), [
                "/storage/bundled/openocd",
                "/storage/bundled/openocd"
            ]);
            assert.strictEqual(preparations, 2, "并发默认路径解析必须共用一次准备操作");
            assert.deepStrictEqual(probes, [], "不得探测或启动系统默认可执行文件");
            assert.strictEqual(await service.resolve("/usr/bin/openocd"), "/usr/bin/openocd");
            assert.strictEqual(await service.resolve("/custom/openocd"), "/custom/openocd");
            assert.deepStrictEqual(probes, ["/usr/bin/openocd", "/custom/openocd"]);

            checker.probeDefaultOpenOcd = async () => ({ found: false, requested: "openocd", error: "install failed" });
            assert.strictEqual(await service.resolve("openocd"), null);
            assert.deepStrictEqual(probes, ["/usr/bin/openocd", "/custom/openocd"], "准备失败不得回退到系统包");
        }
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
