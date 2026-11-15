"use strict";
// The real MainViewProvider constructor with a fake VS Code API: the provider holds every service the composition root
// builds, the services' callbacks reach the provider, and shutdown releases what construction started.
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { createProvider } = require("./helpers/load-provider");
const { createServices } = require("../src/composition");
const { CACHE_KEYS } = require("../src/cacheKeys");

(async () => {
    await scenario("native standalone sampling uses common preflight and preserves its lease", async () => {
        const { provider, vscode, context, dispose } = createProvider();
        const sampling = provider._sampling;
        let nativeFailure = false;
        let exitConfirmed = true;
        try {
            vscode.workspace.getConfiguration = () => ({
                get: (key, fallback) => (key === "samplingBackend" ? "probe-rs" : fallback)
            });
            await context.workspaceState.update(CACHE_KEYS.debugger, "cmsis-dap.cfg");
            await context.workspaceState.update(CACHE_KEYS.mcuCore, "stm32c5x.cfg");
            provider._resolveOpenOcdPath = async () => "preflight-openocd";
            provider._resolveTclPort = async () => 6666;
            const connection = { deviceId: "selected-usb" };
            provider._probeConnectionService.prepare = async () => connection;
            let prepared = 0;
            provider._nativeSamplingService.prepare = async (input) => {
                assert.equal(input.deviceId, connection.deviceId);
                assert.equal(provider._probeCoordinator.anyActive(), true);
                prepared++;
                return { samplingBackend: "probe-rs", nativeExecutable: "native-fixture" };
            };
            sampling.activeReadPlan = () => [{ name: "counter", address: 0x20000000, size: 4 }];
            sampling.applySamplingPlan = () => {};
            sampling._ManagedOpenOcdSession = class {
                constructor(options) {
                    this.options = options;
                    this.capabilities = { write: false, peripherals: false, rtt: false };
                }
                async start() {
                    if (nativeFailure) throw new Error("native startup failed");
                }
                stats() {
                    return { linkSpeedKhz: 1000 };
                }
                setIntervalMs() {}
                setSamplingEnabled(enabled) {
                    this.samplingEnabled = enabled;
                }
                async stop() {
                    return exitConfirmed;
                }
            };
            await sampling.start();
            assert.equal(prepared, 1);
            assert.equal(sampling.session.options.nativeExecutable, "native-fixture");
            assert.equal(sampling.status().source, "probe-rs");
            assert.equal(sampling.status().canRead, true);
            assert.equal(sampling.status().canWrite, false);
            assert.equal(sampling.status().haltWrite, false);
            assert.equal(sampling.status().linkSpeedKhz, 1000);
            const applyPlan = sampling.applySamplingPlan;
            sampling.applySamplingPlan = () => {
                throw new Error("invalid updated plan");
            };
            await assert.rejects(sampling.start(), /invalid updated plan/);
            assert.equal(
                sampling.session.samplingEnabled,
                false,
                "a failed update cannot keep acquiring behind an off switch"
            );
            assert.equal(sampling.status().canRead, false);
            sampling.applySamplingPlan = applyPlan;
            await sampling.stop();
            assert.equal(provider._probeCoordinator.anyActive(), false);
            provider._nativeSamplingService.prepare = async () => {
                throw new Error("native preflight failed");
            };
            await assert.rejects(sampling.start(), /native preflight failed/);
            assert.equal(provider._probeCoordinator.anyActive(), false);
            assert.equal(sampling.session, null);
            assert.equal(sampling.status().running, false, "a failed start must turn the shared sampling switch off");
            assert.equal(sampling.status().intentEnabled, false);
            assert.match(sampling.status().lastStartError.message, /native preflight failed/);
            provider._nativeSamplingService.prepare = async () => ({ samplingBackend: "probe-rs" });
            nativeFailure = true;
            exitConfirmed = false;
            await assert.rejects(sampling.start(), /native startup failed/);
            assert.equal(sampling.status().running, false);
            assert.equal(sampling.status().canRead, false);
            assert.equal(sampling.status().mode, "exit-unconfirmed");
            assert.equal(provider._probeCoordinator.anyActive(), true, "unconfirmed helper exit retains the lease");
            exitConfirmed = true;
            await sampling.stop();
            assert.equal(provider._probeCoordinator.anyActive(), false);
            nativeFailure = false;
            await sampling.start();
            assert.equal(sampling.status().lastStartError, undefined, "a new start clears the previous startup error");
            await sampling.stop();
        } finally {
            exitConfirmed = true;
            await dispose();
        }
    });
    await scenario("Reuse sampling for peripherals and never create a temporary peripheral connection", async () => {
        const { provider, dispose } = createProvider();
        let lease;
        try {
            const access = provider._peripheralAccessService;
            assert.strictEqual(access.status().canRead, false);
            await assert.rejects(
                provider._agentOps.withProbe(() => assert.fail("must not connect"), {
                    peripheralAccess: true,
                    allowPausedDebugRead: true
                }),
                { code: "PERIPHERAL_SAMPLING_REQUIRED" }
            );
            assert.strictEqual(provider._probeCoordinator.anyActive(), false);
            const messages = [];
            provider._webviewView = { webview: { postMessage: (message) => messages.push(message) } };
            const session = { setSamplingEnabled() {} };
            provider._probeConnectionService.assertCurrent = (physical) => assert.strictEqual(physical, session);
            provider._sampling.session = session;
            provider._sampling.intent = true;
            lease = provider._probeCoordinator.acquire("liveWatch");
            provider._postConsumerStatuses({});
            assert.strictEqual(messages.findLast((message) => message.type === "peripheralDebugStatus").canRead, true);
            const result = await access.withAccess(() => ({ reused: true }));
            assert.strictEqual(result.access.source, "active-sampling");
            assert.strictEqual(result.reused, true);
            for (const flag of ["closing", "exitUnconfirmed"]) {
                provider._sampling[flag] = true;
                assert.strictEqual(access.status().canRead, false, flag);
                assert.strictEqual(access.status().canWrite, false, flag);
                provider._sampling[flag] = false;
                assert.strictEqual(access.status().canRead, true);
            }
            session.stopped = true;
            assert.strictEqual(access.status().canRead, false, "a stopped Worker cannot provide peripheral access");
            session.stopped = false;
            const generation = access.status().generation;
            provider._sampling.intent = false;
            provider._postConsumerStatuses({});
            const stopped = messages.findLast((message) => message.type === "peripheralDebugStatus");
            assert.strictEqual(stopped.canRead, false);
            assert.strictEqual(stopped.canWrite, false);
            assert.notStrictEqual(stopped.generation, generation);
            await assert.rejects(
                access.withAccess(() => assert.fail("must not access")),
                {
                    code: "PERIPHERAL_SAMPLING_REQUIRED"
                }
            );
            await assert.rejects(
                provider._agentOps.withProbe(() => assert.fail("must not connect"), {
                    peripheralAccess: true
                }),
                { code: "PERIPHERAL_SAMPLING_REQUIRED" }
            );
        } finally {
            provider._sampling.session = null;
            lease?.release();
            await dispose();
        }
    });
    await scenario("Hold every service the composition root builds", async () => {
        const { provider, vscode, context, dispose } = createProvider();
        try {
            const built = createServices(provider, context, { vscode });
            for (const [name, service] of Object.entries(built)) {
                const held = provider[`_${name}`];
                if (service === null) assert.strictEqual(held, null, name);
                else assert.strictEqual(held?.constructor, service.constructor, name);
            }
            assert.notStrictEqual(provider._bridgeRegistry, null, "the context has global storage");
            assert.strictEqual(provider._latestSidebarSamples, provider._liveWatchService.latestSidebarSamples);
            assert.strictEqual(typeof provider.commandHandlers["mcu-vscode.download"], "function");
        } finally {
            await dispose();
        }
    });

    await scenario("Route service callbacks and Agent calls to the provider", async () => {
        const { provider, dispose } = createProvider();
        try {
            const posts = [];
            provider._webviewView = { webview: { postMessage: (message) => posts.push(message) } };
            provider._probeCoordinator.acquire("chipInfo").release();
            assert(posts.some((message) => message.type === "probeOperationStatus"));
            assert(provider._agentService.methods().includes("variables.read"));
            const snapshot = await provider._agentService.call("config.get");
            assert.strictEqual(typeof snapshot, "object");
        } finally {
            await dispose();
        }
    });

    await scenario("Wire peripheral access to the composed bridge and managed debug server", async () => {
        const { provider, dispose } = createProvider();
        const bridge = provider._debugBridge;
        try {
            const access = provider._peripheralAccessService;
            assert.strictEqual(access.debugBridge, bridge);
            assert.strictEqual(access.status().mode, "standalone");
            bridge.sessions.set("selected", { id: "selected" });
            bridge.agentStatus = () => ({ state: "running", epoch: 1, session: bridge.activeSession });
            provider.debugLaunch.managedSessionId = "selected";
            let reads = 0;
            const server = {
                capabilities: { runtimeRead: true },
                peripheralTransaction: async (request) => {
                    assert.deepStrictEqual(request.reads, [{ address: 0x40020000, size: 4 }]);
                    reads++;
                    return { reads: [[1, 2, 3, 4]] };
                }
            };
            provider.debugLaunch.managedServer = server;
            provider._probeConnectionService.assertCurrent = (session) => assert.strictEqual(session, server);
            provider._sampling.runtimeRamPlan = () => {
                throw new Error("SVD accesses must use their register widths");
            };
            const result = await access.withAccess(async (transport) => ({
                bytes: Array.from(await transport.read(0x40020000, 4, 4, "little"))
            }));
            assert.deepStrictEqual(result.bytes, [1, 2, 3, 4]);
            assert.strictEqual(reads, 1);
            assert.strictEqual(result.access.source, "debug-running-openocd");
            server.capabilities.runtimeRead = false;
            await assert.rejects(
                access.withAccess(() => {}),
                { code: "PERIPHERAL_ACCESS_UNSUPPORTED" }
            );
            assert.strictEqual(bridge.peripheralBusy, false);
        } finally {
            provider.debugLaunch.managedServer = null;
            provider.debugLaunch.managedSessionId = null;
            bridge.sessions.clear();
            await dispose();
        }
    });

    await scenario("Refresh both CubeMX paths and keep only the workspace IOC selector in the sidebar", async () => {
        const { provider, dispose } = createProvider();
        try {
            provider._cubemxConfiguration.selectIoc = async () => "workspace.ioc";
            provider._cubemxConfiguration.refresh = async () => "both installations";
            assert.strictEqual(provider.commandHandlers["mcu-vscode.selectCubeMx"], undefined);
            assert.strictEqual(provider.commandHandlers["mcu-vscode.selectCubeMx2"], undefined);
            assert.strictEqual(await provider.commandHandlers["mcu-vscode.selectIoc"](), "workspace.ioc");
            assert.strictEqual(await provider.refreshCubeMxStatus(), "both installations");
        } finally {
            await dispose();
        }
    });

    console.log("Provider construction tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
