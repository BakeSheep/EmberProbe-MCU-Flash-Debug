"use strict";

const assert = require("assert");
const { CpuLoadService } = require("../src/services/cpuLoadService");
const { ProbeCoordinator, PROBE_OPERATIONS } = require("../src/probeCoordinator");
const { loadProvider } = require("./helpers/load-provider");
const { metadata } = require("./helpers/cpu-load-fixture");
const { buildCpuLoadPlan } = require("../src/services/cpuLoadModel");

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function fixture(overrides = {}) {
    const calls = [];
    const data = metadata();
    const plan = buildCpuLoadPlan(data.result, data.layout);
    let image = plan.image;
    const coordinator = new ProbeCoordinator();
    const runtime = {
        setSamplingEnabled(value) {
            assert.strictEqual(value, false);
        },
        start: async () => calls.push("connect"),
        setCpuLoadPlan: async (value) => calls.push(value ? "install" : "clear"),
        stop: async () => {
            calls.push("exit");
            return true;
        },
        selectCpuIdleTask: async () => {}
    };
    const service = new CpuLoadService({
        coordinator,
        assertAvailable() {},
        post() {},
        elf: {
            cpuLoadPlan: async () => {
                calls.push("metadata");
                return plan;
            },
            read: () => ({ elf: { sha256: image } })
        },
        create: async () => {
            calls.push("create");
            return runtime;
        },
        ...overrides
    });
    return {
        service,
        coordinator,
        calls,
        runtime,
        plan,
        changeImage: () => {
            image = "new";
        }
    };
}

(async () => {
    for (const operation of PROBE_OPERATIONS.filter((name) => name !== "cpuLoad")) {
        const f = fixture();
        const owner = f.coordinator.acquire(operation);
        await assert.rejects(f.service.start(), { code: "PROBE_BUSY" });
        assert.deepStrictEqual(f.calls, [], "busy rejection cannot parse or create a connection");
        assert.strictEqual(f.service.intent, false);
        owner.release();
        await f.service.start();
        assert.deepStrictEqual(f.calls.slice(0, 4), ["metadata", "create", "connect", "install"]);
        assert.throws(() => f.coordinator.acquire(operation), { code: "PROBE_BUSY" });
        await f.service.stop();
        assert.strictEqual(f.coordinator.anyActive(), false);
    }
    // Invalid kernel metadata never constructs a hardware worker.
    for (const code of ["CPU_LAYOUT_UNSUPPORTED", "ELF_NOT_CONFIGURED", "ELF_CHANGED"]) {
        const f = fixture({
            elf: {
                cpuLoadPlan: async () => {
                    throw Object.assign(new Error("unsupported"), { code });
                }
            }
        });
        await f.service.refreshSupport();
        assert.strictEqual(f.service.status().canStart, false);
        await assert.rejects(f.service.start(), { code });
        assert.deepStrictEqual(f.calls, []);
        assert.strictEqual(f.service.status().intentEnabled, false);
        assert.strictEqual(f.coordinator.anyActive(), false);
    }
    {
        const f = fixture();
        await f.service.refreshSupport();
        assert(f.service.status().canStart);
        f.service.options.elf.cpuLoadPlan = async () => {
            throw new Error("FreeRTOS was removed");
        };
        await assert.rejects(f.service.start(), /FreeRTOS was removed/);
        assert(!f.service.status().canStart, "failed revalidation cannot retain support from the previous ELF");
        assert.strictEqual(f.service.status().blockedReason.code, "CPU_LAYOUT_UNSUPPORTED");
    }
    {
        const f = fixture();
        await f.service.refreshSupport();
        assert(f.service.status().canStart);
        const pending = f.service.start();
        assert.strictEqual(f.service.start(), pending, "double start shares the operation");
        await pending;
        assert.strictEqual(f.calls.filter((call) => call === "create").length, 1);
        assert(f.service.status().canStop);
        const result = { state: "running", generation: f.service.generation, identity: f.service.binding.identity };
        assert(f.service.accept(f.runtime, result));
        assert(!f.service.accept({}, result));
        assert(!f.service.accept(f.runtime, { ...result, generation: -1 }));
        await f.service.selectIdle("verified");
        await assert.rejects(f.service.selectIdle("x".repeat(100)), /active/);
        await f.service.stop();
        assert(!f.service.accept(f.runtime, result));
    }
    // Cancellation during offline inspection holds the lease, then cancels without touching hardware.
    {
        const f = fixture();
        await f.service.start();
        const old = { state: "running", generation: f.service.generation, identity: f.service.binding.identity };
        assert(f.service.accept(f.runtime, { ...old, state: "checking", needsMetadataRefresh: true }));
        assert(!f.service.accept(f.runtime, old), "window revalidation invalidates late results immediately");
        await tick();
        assert(f.service.generation > old.generation);
        assert.strictEqual(f.calls.filter((call) => call === "install").length, 2);
        const gate = deferred();
        f.service.options.elf.cpuLoadPlan = () => gate.promise;
        f.service.accept(f.runtime, {
            state: "checking",
            needsMetadataRefresh: true,
            generation: f.service.generation,
            identity: f.service.binding.identity
        });
        await tick();
        await f.service.stop();
        f.service.options.elf.cpuLoadPlan = async () => f.plan;
        await f.service.start();
        gate.reject(new Error("old image"));
        await tick();
        assert(f.service.intent, "a cancelled run's late metadata failure cannot stop the new run");
        await f.service.stop();
    }
    {
        const gate = deferred();
        const f = fixture({ elf: { cpuLoadPlan: () => gate.promise } });
        const start = f.service.start();
        const stop = f.service.stop();
        assert(f.coordinator.isActive("cpuLoad"));
        await assert.rejects(f.service.start(), { code: "PROBE_BUSY" });
        gate.resolve(f.plan);
        await Promise.all([start, stop]);
        assert.deepStrictEqual(f.calls, []);
        assert(!f.coordinator.anyActive());
    }
    for (const stage of ["create", "connect", "install"]) {
        const f = fixture();
        if (stage === "create")
            f.service.options.create = async () => {
                throw new Error(stage);
            };
        else if (stage === "connect")
            f.runtime.start = async () => {
                throw new Error(stage);
            };
        else
            f.runtime.setCpuLoadPlan = async (value) => {
                if (value) throw new Error(stage);
            };
        await assert.rejects(f.service.start(), new RegExp(stage));
        assert(!f.service.intent);
        assert(!f.coordinator.anyActive());
        if (stage !== "create") assert(f.calls.includes("exit"));
    }
    // A late constructor belongs to the cancelled run and is closed before any subsequent run.
    {
        const gate = deferred();
        const f = fixture({ create: () => gate.promise });
        const start = f.service.start();
        await tick();
        const stop = f.service.stop();
        gate.resolve(f.runtime);
        await Promise.all([start, stop]);
        assert.deepStrictEqual(f.calls, ["metadata", "clear", "exit"]);
        assert(!f.coordinator.anyActive());
        f.service.options.create = async () => f.runtime;
        await f.service.start();
        await f.service.stop();
    }
    {
        const gate = deferred();
        const f = fixture();
        await f.service.start();
        f.runtime.stop = () => gate.promise;
        const stopped = f.service.stop();
        await tick();
        assert(f.coordinator.isActive("cpuLoad"));
        assert.throws(() => f.coordinator.acquire("download"), { code: "PROBE_BUSY" });
        assert.strictEqual(f.service.status().canStop, false);
        gate.resolve(false);
        await assert.rejects(stopped, { code: "CPU_EXIT_UNCONFIRMED" });
        assert(f.coordinator.isActive("cpuLoad"));
        assert(f.service.status().canStop, "unconfirmed exit can be retried");
        f.runtime.stop = async () => true;
        await f.service.stop();
        assert(!f.coordinator.anyActive());
    }
    {
        const f = fixture();
        await f.service.start();
        f.changeImage();
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert(!f.service.intent);
        assert(!f.coordinator.anyActive());
    }
    {
        const f = fixture();
        await f.service.start();
        f.service.accept(f.runtime, {
            state: "unavailable",
            reason: "unsupported core",
            generation: f.service.generation,
            identity: f.service.binding.identity
        });
        await tick();
        assert(!f.service.intent);
        assert(!f.coordinator.anyActive());
    }
    // Execute production entry points with a CPU owner; none may stop or borrow that owner's runtime.
    const P = loadProvider({ debug: {}, workspace: {} });
    const p = Object.create(P.prototype);
    Object.assign(p, {
        _probeCoordinator: new ProbeCoordinator(),
        _debugBridge: { setIntent() {} },
        commandHandlers: {},
        _t: (key) => key,
        _liveConsumers: new Set(),
        _flushPendingWebviewSamples() {},
        _postConsumerStatuses() {},
        _postLive() {}
    });
    p.registerCommandHandlers();
    const cpu = p._probeCoordinator.acquire("cpuLoad");
    for (const operation of [
        () => p.commandHandlers["mcu-vscode.download"](),
        () => p.commandHandlers["mcu-vscode.debug"](),
        () => p.startLiveWatch(),
        () => p.prepareForCortexDebug(),
        () => p.prepareExternalDebug(),
        () => p.beginForeignDebug(),
        () => p._withAgentProbe(() => {}),
        () => p._readAgentFault(),
        () => p._writeAgentVariables({}),
        () => p._writeUiVariable("x", "1"),
        () => p._agentWritePermission({}),
        () => p.readChipInfoAction(),
        () => p._changeJlinkDriver("winusb")
    ])
        await assert.rejects(async () => operation(), { code: "PROBE_BUSY" });
    cpu.release();
    for (const flag of ["_samplingIntent", "_debugCommandPending", "_foreignDebugPending", "_probeDriverSwitching"]) {
        p[flag] = true;
        assert.throws(() => p._assertCpuAvailable(), { code: "PROBE_BUSY" });
        p[flag] = false;
    }
    const oldDebug = p.beginForeignDebug();
    assert(p.isForeignDebugCurrent(oldDebug));
    assert.throws(() => p._assertCpuAvailable(), { code: "PROBE_BUSY" });
    p.finishForeignDebug();
    assert(!p.isForeignDebugCurrent(oldDebug));
    const newDebug = p.beginForeignDebug();
    assert(!p.isForeignDebugCurrent(oldDebug), "expired F5 preparation cannot regain admission");
    assert(p.isForeignDebugCurrent(newDebug));
    p.finishForeignDebug();
    p._assertCpuAvailable();
    // Variable shutdown also retains its lease and connection until confirmed process exit.
    const variable = p._probeCoordinator.acquire("liveWatch");
    p._liveWatchLease = variable;
    const gate = deferred();
    const session = { setSamplingEnabled() {}, stop: () => gate.promise };
    p._liveSession = session;
    const stop = p.stopLiveWatch();
    assert(p._probeCoordinator.isActive("liveWatch"));
    gate.resolve(false);
    await assert.rejects(stop, { code: "PROBE_EXIT_UNCONFIRMED" });
    assert.strictEqual(p._liveSession, session);
    assert(p._probeCoordinator.isActive("liveWatch"));
    session.stop = async () => true;
    await p.stopLiveWatch();
    assert(!p._probeCoordinator.anyActive());
    // The production CPU connection factory creates its own runtime and never exposes a variable connection.
    class Runtime {
        constructor(_host, options, handlers) {
            this.options = options;
            this.handlers = handlers;
        }
        setSamplingEnabled(value) {
            assert.strictEqual(value, false);
        }
        async start() {}
        async setCpuLoadPlan() {}
        async stop() {
            return true;
        }
    }
    const Host = loadProvider(
        { debug: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
        { "./liveWatch": { LiveWatchSession: Runtime } }
    );
    const host = Object.create(Host.prototype);
    const f = fixture();
    Object.assign(host, {
        _probeCoordinator: f.coordinator,
        _cpuLoadService: f.service,
        _debugBridge: {},
        _context: { workspaceState: { get: () => "configured" } },
        _probeConnectionService: { prepare: async () => ({}), recordSuccess: async () => {} },
        _resolveOpenOcdPath: async () => "fake",
        _resolveTclPort: async () => 1234,
        _commandContext: () => ({}),
        _t: (key) => key
    });
    f.service.options.assertAvailable = () => host._assertCpuAvailable();
    f.service.options.create = (...args) => host._createCpuRuntime(...args);
    await f.service.start();
    assert(f.service.runtime instanceof Runtime);
    assert.strictEqual(f.service.runtime.options.target, "configured");
    assert.strictEqual(host._liveSession, undefined);
    assert.strictEqual(host._samplingIntent, undefined);
    await f.service.stop();
    assert(!f.coordinator.anyActive());
    console.log(
        "CPU admission, metadata-first startup, cancellation, exclusive entry points and confirmed cleanup passed"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
