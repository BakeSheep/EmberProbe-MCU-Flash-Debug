"use strict";
const assert = require("assert");
const path = require("path");
const { SamplingSession } = require("../src/samplingSession");
const { CpuLoadService } = require("../src/services/cpuLoadService");
const { CpuOpenOcdServer } = require("./helpers/cpu-openocd-server");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { loadProvider } = require("./helpers/load-provider");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, message) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        assert(Date.now() < deadline, message);
        await wait(10);
    }
}

(async () => {
    const source = new CpuOpenOcdServer();
    for (const mode of ["standalone", "debug"]) {
        const events = [],
            variables = [];
        const session = new SamplingSession(
            { mode, intervalMs: 20 },
            {
                onCpuLoad: (result) => events.push(result),
                onSample: (samples) => variables.push(samples)
            },
            path.join(__dirname, "helpers/cpu-sampling-worker-fixture.js")
        );
        try {
            await session.start();
            await session.setCpuLoadPlan(source.plan);
            await waitFor(
                () => events.some((result) => result.windowMs > 900 && result.acquiredSamples > 0),
                mode + " CPU with empty watch list"
            );
            assert.strictEqual(events.at(-1).capabilities.core, mode === "standalone" ? "Cortex-M7" : "Cortex-M0");
            assert.deepStrictEqual(
                events.at(-1).capabilities.auxiliaryTargets,
                mode === "standalone" ? ["stm32h7x.ap2"] : []
            );
            session.setSamplingPlan({
                graphItems: [{ name: "value", address: 0x20000200, size: 4 }],
                graphIntervalMs: 20
            });
            session.setSamplingEnabled(true);
            await waitFor(() => variables.length > 0, mode + " variable sampling starts");
            const cpuCount = events.length;
            session.setSamplingEnabled(false);
            await waitFor(() => events.length > cpuCount, "stopping variables leaves CPU alive");
            session.setSamplingEnabled(true);
            await session.setCpuLoadPlan(null);
            const variableCount = variables.length,
                stoppedCpu = events.length;
            await waitFor(() => variables.length > variableCount, "stopping CPU leaves variables alive");
            await wait(180);
            assert.strictEqual(events.length, stoppedCpu);
            await session.setCpuLoadPlan({ ...source.plan, generation: 2 });
            await session.setCpuLoadPaused("debug-control");
            await session.waitForIdle();
            assert.strictEqual(events.at(-1).state, "paused");
            await session.setCpuLoadPaused(null);
            await waitFor(() => events.at(-1)?.runGeneration > 1, "resuming CPU starts a new run generation");
        } finally {
            await session.stop();
        }
    }
    // Real Tcl framing and silent debug replies share exactly one socket with writes.
    const server = new CpuOpenOcdServer({ h7: true }),
        native = new ManagedOpenOcdSession(null, { mode: "debug" }, {});
    try {
        await server.start();
        native.socket = await server.connect();
        native._setupSocket();
        native.setCpuLoadPlan(server.plan);
        await waitFor(
            () =>
                server.commands.some(
                    (command) => command.includes("stm32h7x.cpu0 read_memory") && command.includes("curstate")
                ),
            "native CPU sampler acquires a memory sample"
        );
        native.setCpuLoadPaused("control");
        await native.waitForIdle();
        const before = server.commands.length;
        await wait(30);
        assert.strictEqual(server.commands.length, before);
        assert(
            server.commands.every((command) => !/write_memory|\bhalt\b|\bresume\b|\bprofile\b|e000edf0/i.test(command))
        );
        assert(
            server.responses.every((response) => response === ""),
            "CPU does not broadcast data into GDB console"
        );
        assert.strictEqual(server.maxInFlight, 1);
        assert(server.commands.some((command) => command.includes("stm32h7x.cpu0 read_memory")));
        assert(server.commands.some((command) => command.includes("stm32h7x.cpu0 curstate")));
        assert(!server.commands.some((command) => command.includes("stm32h7x.ap2 read_memory")));
        const writing = new ManagedOpenOcdSession(null, { mode: "standalone" }, {});
        try {
            writing.socket = await server.connect();
            writing._setupSocket();
            const beforeStart = server.commands.length;
            writing.setCpuLoadPlan(server.plan);
            await waitFor(
                () => server.commands.slice(beforeStart).some((command) => command.includes("curstate")),
                "standalone CPU sampler starts"
            );
            server.readLatencyMs = 5;
            const beginWrite = server.commands.length;
            await writing.writeAndVerify([{ name: "value", address: 0x20000200, bytes: [9, 8, 7, 6] }]);
            writing.setCpuLoadPaused("after-write");
            await writing.waitForIdle();
            const transaction = server.commands.slice(beginWrite);
            const halt = transaction.indexOf("halt"),
                resume = transaction.indexOf("resume");
            assert(halt >= 0 && resume > halt);
            assert(
                !transaction
                    .slice(halt, resume)
                    .some((command) => command.startsWith("join [list") && command.includes("curstate")),
                "CPU never interleaves with an authorized write transaction"
            );
            assert.deepStrictEqual(server.bytes(0x20000200, 4), [9, 8, 7, 6]);
        } finally {
            await writing.stop();
        }
    } finally {
        await native.stop();
        await server.stop();
    }

    const sent = [],
        plans = [];
    let identity = { session: "standalone", runEpoch: 0 },
        reason = null;
    let image = "image";
    const runtime = { setCpuLoadPlan: async (plan) => plans.push(plan), selectCpuIdleTask: async (key) => key };
    const service = new CpuLoadService({
        elf: { cpuLoadPlan: async () => ({ ...source.plan, image }), read: () => ({ elf: { sha256: image } }) },
        context: async () => ({ runtime, identity, reason }),
        post: (result) => sent.push(result)
    });
    try {
        await service.start();
        const first = plans.at(-1);
        assert(service.accept(runtime, { state: "running", generation: first.generation, identity: first.identity }));
        assert(!service.accept({}, { ...first, state: "running" }));
        reason = "debug-paused";
        await service.reconcile();
        assert(!service.accept(runtime, { state: "running", generation: first.generation, identity: first.identity }));
        reason = null;
        identity = { session: "native", runEpoch: 1 };
        await service.reconcile();
        assert(plans.at(-1).generation > first.generation);
        image = "changed";
        await service.suspend("image-changed");
        await service.reconcile();
        assert.strictEqual(plans.at(-1).identity.image, "changed");
        image = "periodic-change";
        await waitFor(() => plans.at(-1)?.identity.image === image, "integrity check rebuilds a changed image");
        const current = plans.at(-1);
        service.accept(runtime, {
            state: "checking",
            needsMetadataRefresh: true,
            generation: current.generation,
            identity: current.identity
        });
        await waitFor(
            () => plans.at(-1)?.generation > current.generation,
            "observed target restart resolves metadata again"
        );
        await service.selectIdle("verified-key");
        await assert.rejects(service.selectIdle("x".repeat(100)), /active/);
    } finally {
        await service.stop();
    }
    let resolvePlan;
    const racing = new CpuLoadService({
        elf: {
            cpuLoadPlan: () =>
                new Promise((resolve) => {
                    resolvePlan = resolve;
                })
        },
        context: async () => ({ runtime, identity }),
        post() {}
    });
    const pending = racing.start();
    await waitFor(() => !!resolvePlan, "CPU metadata request starts before stop");
    await racing.stop();
    resolvePlan(source.plan);
    await pending;
    assert.strictEqual(racing.runtime, null, "stop invalidates in-flight metadata");
    const unsupported = new CpuLoadService({
        elf: {},
        context: async () => ({ reason: "unsupported", unsupported: true }),
        post() {}
    });
    await unsupported.start();
    assert.strictEqual(unsupported.status().state, "unavailable");
    await unsupported.stop();
    const badLayout = new CpuLoadService({
        elf: {
            cpuLoadPlan: async () => {
                throw new Error("Missing DWARF");
            }
        },
        context: async () => ({ runtime, identity }),
        post() {}
    });
    await badLayout.start();
    assert.strictEqual(badLayout.status().reason, "Missing DWARF");
    await badLayout.stop();

    const Provider = loadProvider({ debug: {}, workspace: {} });
    const provider = Object.create(Provider.prototype);
    provider._context = { workspaceState: { get: () => "firmware.elf" } };
    provider._debugBridge = { hasAnySession: false, setIntent() {} };
    provider._cpuLoadService = { intent: true };
    provider._liveSession = runtime;
    assert.strictEqual((await provider._cpuLoadContext()).runtime, runtime);
    provider._externalDebug = { held: true };
    assert((await provider._cpuLoadContext()).unsupported);
    provider._externalDebug = null;
    provider._managedDebugGroup = {};
    assert((await provider._cpuLoadContext()).unsupported);
    provider._managedDebugGroup = null;
    provider._managedDebugServer = { ready: true, capabilities: { runtimeRead: true } };
    provider._managedDebugSessionId = "native";
    provider._debugBridge = {
        hasAnySession: true,
        activeSession: { id: "native", configuration: { executable: "firmware.elf" } },
        stopEpoch: 3
    };
    assert.strictEqual((await provider._cpuLoadContext()).identity.runEpoch, 3);
    provider._debugBridge.paused = true;
    assert((await provider._cpuLoadContext()).reason);
    // Exercise the complete standalone connection entry with no variable consumers.
    let stopped = 0,
        enabled = null;
    class Runtime {
        constructor(_host, options) {
            this.options = options;
        }
        async start() {}
        async stop() {
            stopped++;
        }
        setSamplingEnabled(value) {
            enabled = value;
        }
    }
    const Standalone = loadProvider(
        { debug: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
        { "./liveWatch": { LiveWatchSession: Runtime } }
    );
    const standalone = Object.create(Standalone.prototype);
    Object.assign(standalone, {
        _probeCoordinator: new (require("../src/probeCoordinator").ProbeCoordinator)(),
        _samplingCoordinator: new (require("../src/services/samplingCoordinator").SamplingCoordinator)(),
        _probeConnectionService: { prepare: async () => ({}) },
        _context: { workspaceState: { get: () => "configured" } },
        _debugBridge: { setIntent() {} },
        _cpuLoadService: { intent: true, reconcile() {}, suspend() {} },
        _samplingIntent: false,
        _liveConsumers: new Set(),
        _activeReadPlan: () => [],
        _applySamplingPlan() {},
        _setLiveInterval() {},
        _postConsumerStatuses() {},
        _commandContext: () => ({}),
        _flushPendingWebviewSamples() {},
        _resolveOpenOcdPath: async () => "fake",
        _resolveTclPort: async () => 1234,
        _t: (key) => key
    });
    await standalone.startLiveWatch(undefined, undefined, "cpu", true);
    assert(standalone._liveSession);
    assert.strictEqual(enabled, false, "CPU startup does not enable variable sampling");
    assert.strictEqual(standalone._liveConsumers.size, 0);
    standalone.stopLiveWatch({ variablesOnly: true });
    assert.strictEqual(stopped, 0);
    standalone._cpuLoadService.intent = false;
    await standalone.stopLiveWatch();
    assert.strictEqual(stopped, 1);
    assert.strictEqual(standalone._probeCoordinator.anyActive(), false);
    console.log("CPU worker isolation, independent consumers, transport and service lifecycle tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
