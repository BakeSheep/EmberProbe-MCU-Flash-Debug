"use strict";

const assert = require("assert");
const net = require("net");
const { OpenOcdDebugController, allocateDebugPorts } = require("../src/services/debugServerController");
const { normalizeDebugServerOptions, validateDebugConfiguration } = require("../src/services/debugConfiguration");
const { normalizeTargetSelection, buildOpenOcdTargetArgs } = require("../src/openocdScripts");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { loadProvider } = require("./helpers/load-provider");

const settings = { executable: "fake", probe: "cmsis-dap.cfg", target: "stm32h7x.cfg", port: 32000, gdbPort: 32001 };
function fixture(options = {}, overrides = {}) {
    const calls = [];
    const runtime = {
        stopped: false,
        samplingEnabled: false,
        start: async () => ({ gdbTarget: `127.0.0.1:${options.gdbPort || settings.gdbPort}`, tclPort: settings.port }),
        stop: async () => {
            calls.push("stop");
            runtime.stopped = true;
            return true;
        },
        setSamplingEnabled: (enabled) => (runtime.samplingEnabled = enabled),
        setWatch: (items) => calls.push(items),
        setIntervalMs: (value) => calls.push(value),
        setPauseReason: (value) => calls.push(value),
        stats: () => ({ actualHz: 7 }),
        readOnce: async (items) => items,
        waitForIdle: async () => true,
        waitForExit: async () => true,
        ...overrides
    };
    let created = 0;
    const controller = new OpenOcdDebugController(
        null,
        { ...settings, ...options },
        {},
        {
            resolveLaunch: () => {
                calls.push("preflight");
                return { executable: "fake" };
            },
            createRuntime: (_host, config) => {
                created++;
                assert.strictEqual(config.mode, "debug");
                return runtime;
            }
        }
    );
    return {
        controller,
        runtime,
        calls,
        get created() {
            return created;
        }
    };
}

(async () => {
    assert.deepStrictEqual(normalizeTargetSelection({}), {});
    assert.deepStrictEqual(
        normalizeTargetSelection({ numberOfProcessors: 2, targetProcessor: 1, targetName: "chip.cpu1" }),
        {
            numberOfProcessors: 2,
            targetProcessor: 1,
            targetName: "chip.cpu1"
        }
    );
    assert.deepStrictEqual(buildOpenOcdTargetArgs({}, undefined), []);
    for (const config of [
        { numberOfProcessors: 0 },
        { numberOfProcessors: 33 },
        { numberOfProcessors: "2" },
        { numberOfProcessors: 2, targetProcessor: 2 },
        { targetProcessor: -1 },
        { targetProcessor: 0.5 },
        { targetName: "cpu;shutdown" },
        { targetName: "[target current]" },
        { targetName: "" },
        { targetName: null }
    ])
        assert.throws(() => normalizeTargetSelection(config), { code: "OPENOCD_TARGET_INVALID" });
    for (const ports of [undefined, [1], [1, 1], [0, 2], [1, 65536], [1, "2"]])
        assert.throws(() => buildOpenOcdTargetArgs({ numberOfProcessors: 2 }, ports), {
            code: "OPENOCD_TARGET_PORT_INVALID"
        });
    for (const servertype of ["jlink", "other", null, 1]) {
        if (servertype === null) continue; // absent/null retain the default
        assert.throws(() => normalizeDebugServerOptions({ servertype }), { code: "DEBUG_SERVER_UNSUPPORTED" });
        assert.throws(
            () => validateDebugConfiguration({ request: "launch", servertype }, { uri: { fsPath: __dirname } }),
            {
                code: "DEBUG_SERVER_UNSUPPORTED"
            }
        );
    }
    for (const serverpath of [1, "", "  ", "openocd\nshutdown"])
        assert.throws(() => normalizeDebugServerOptions({ serverpath }), { code: "DEBUG_SERVER_PATH_INVALID" });
    assert.strictEqual(normalizeDebugServerOptions({ serverpath: " /tools/openocd " }).serverpath, "/tools/openocd");

    const one = fixture();
    assert.strictEqual(one.created, 0, "Construction/preflight never create a worker or process");
    one.controller.preflight();
    assert.strictEqual(one.created, 0);
    assert.strictEqual(one.controller.ready, false);
    assert.strictEqual(one.controller.stopped, false);
    assert.strictEqual(one.controller.samplingEnabled, false);
    assert.strictEqual(one.controller.setSamplingEnabled(true), false);
    assert.strictEqual(await one.controller.waitForIdle(), true);
    assert.strictEqual(await one.controller.waitForExit(), true);
    await assert.rejects(one.controller.readOnce([]), /not ready/);
    const first = one.controller.start();
    assert.strictEqual(one.controller.start(), first);
    const connection = await first;
    assert(Object.isFrozen(connection));
    assert.strictEqual(one.created, 1);
    assert.strictEqual(one.controller.ready, true);
    assert.throws(() => one.controller.preflight(), /already/);
    assert.strictEqual(one.controller.setSamplingEnabled(true), true);
    one.controller.setWatch([{ address: 0x20000000, size: 4 }]);
    one.controller.setIntervalMs(100);
    one.controller.setPauseReason("backpressure");
    assert.deepStrictEqual(one.controller.stats(), { actualHz: 7 });
    assert.deepStrictEqual(await one.controller.readOnce(["value"]), ["value"]);
    assert.strictEqual(await one.controller.waitForIdle(), true);
    assert.strictEqual(await one.controller.waitForExit(), true);
    const stop = one.controller.stop();
    assert.strictEqual(one.controller.stop(), stop);
    await stop;
    assert.strictEqual(one.controller.stopped, true);
    assert.strictEqual(one.controller.connection, null);
    assert.strictEqual(one.controller.ready, false);
    assert.strictEqual(one.calls.filter((value) => value === "stop").length, 1);
    const unused = fixture().controller;
    await unused.stop();
    assert.throws(() => unused.start(), /already/);

    const two = fixture({ numberOfProcessors: 2, targetProcessor: 1, gdbPorts: [32001, 32002], gdbPort: 32002 });
    await two.controller.start();
    assert.strictEqual(two.controller.connection.gdbTarget, "127.0.0.1:32002");
    assert.strictEqual(two.controller.capabilities.runtimeRead, false);
    assert.strictEqual(two.controller.setSamplingEnabled(true), false);
    two.controller.setWatch([]);
    assert.throws(() => two.controller.setWatch([{}]), { code: "DEBUG_RUNTIME_READ_UNSUPPORTED" });
    await assert.rejects(two.controller.readOnce([]), { code: "DEBUG_RUNTIME_READ_UNSUPPORTED" });
    const coordinator = new SamplingCoordinator();
    assert.strictEqual(coordinator.setRuntimeEnabled(two.controller, true, { paused: false }), false);
    const bridge = {
        hasSession: true,
        hasAnySession: true,
        paused: false,
        status: () => ({ source: "dap", canRead: false })
    };
    assert.strictEqual(coordinator.status({ intent: true, bridge, managedServer: two.controller }).source, "dap");
    await two.controller.stop();

    for (const options of [
        { rtos: "FreeRTOs" },
        { port: 32001 },
        { port: 0 },
        { numberOfProcessors: 2, gdbPorts: [32001, 32002], gdbPort: 32002 }
    ]) {
        const invalid = fixture(options);
        assert.throws(() => invalid.controller.start());
        assert.strictEqual(invalid.created, 0);
        await invalid.controller.stop();
    }
    const failed = fixture(
        {},
        {
            start: async () => {
                throw new Error("probe unplugged");
            }
        }
    );
    await assert.rejects(failed.controller.start(), /probe unplugged/);
    assert.strictEqual(failed.controller.state, "stopped");
    assert.strictEqual(failed.controller.stopped, true, "a failed start must not orphan a spawned OpenOCD");
    assert.deepStrictEqual(
        failed.calls.filter((value) => value === "stop"),
        ["stop"]
    );
    await failed.controller.stop();
    let finishStart;
    const early = fixture(
        {},
        {
            start: () =>
                new Promise((resolve) => {
                    finishStart = resolve;
                })
        }
    );
    const starting = early.controller.start();
    await early.controller.stop();
    finishStart({ gdbTarget: "127.0.0.1:32001" });
    await assert.rejects(starting, /stopped during startup/);
    assert.strictEqual(early.controller.state, "stopped");

    let confirmExit = false;
    const stubborn = fixture({}, { stop: async () => confirmExit });
    await stubborn.controller.start();
    const Provider = loadProvider();
    const host = Object.create(Provider.prototype);
    host._probeCoordinator = new ProbeCoordinator();
    host._debugServerLease = host._probeCoordinator.acquire("debugServer");
    host._managedDebugServer = stubborn.controller;
    host._managedDebugToken = "retained";
    await assert.rejects(host._stopManagedDebugServer(), { code: "DEBUG_SERVER_STOP_FAILED" });
    assert.strictEqual(host._managedDebugServer, stubborn.controller);
    assert.strictEqual(host._managedDebugToken, "retained");
    assert.throws(() => host._probeCoordinator.acquire("download"), { code: "PROBE_BUSY" });
    confirmExit = true;
    await host._stopManagedDebugServer();
    assert.strictEqual(host._managedDebugServer, null);
    assert.strictEqual(host._probeCoordinator.anyActive(), false);

    // Exercise the production host startup/cleanup, including a bind retry. The
    // controller runtime is replaced; no OpenOCD process or hardware is used.
    const starts = [];
    const stopped = [];
    const allocations = [];
    const retryHostClass = loadProvider(
        {},
        {
            "./services/debugServerController": {
                allocateDebugPorts: async (count, excluded) => {
                    allocations.push({ count, excluded });
                    return Array.from({ length: count }, (_, index) => 40000 + allocations.length * 10 + index);
                },
                OpenOcdDebugController: class extends OpenOcdDebugController {
                    constructor(hostApi, config, handlers) {
                        super(hostApi, config, handlers, {
                            resolveLaunch: () => ({}),
                            createRuntime: () => ({
                                start: async () => {
                                    starts.push(config);
                                    if (starts.length === 1) throw new Error("Address already in use");
                                    handlers.onConnectionConfirmed();
                                    return { gdbTarget: `127.0.0.1:${config.gdbPort}`, gdbTargets: config.gdbPorts };
                                },
                                setSamplingEnabled: () => false,
                                stop: async () => {
                                    stopped.push(config);
                                    return true;
                                }
                            })
                        });
                    }
                }
            }
        }
    );
    const retryHost = Object.create(retryHostClass.prototype);
    retryHost._probeCoordinator = new ProbeCoordinator();
    retryHost._debugStartLease = retryHost._probeCoordinator.acquire("debugStart");
    retryHost._debugLifecycle = { pending: false };
    let prepared = 0,
        recorded = 0;
    retryHost._probeConnectionService = {
        prepare: async () => {
            prepared++;
            return { probeSerial: "1234" };
        },
        recordSuccess: () => {
            recorded++;
        }
    };
    const configuration = { inspect: () => null, get: (_name, fallback) => fallback };
    const managed = await retryHost._startManagedDebugServer(
        "fake",
        "cmsis-dap.cfg",
        "stm32h7x.cfg",
        configuration,
        false,
        "FreeRTOS",
        {
            numberOfProcessors: 2,
            targetProcessor: 1,
            targetName: "chip.cpu1"
        }
    );
    assert.strictEqual(managed.gdbTarget, "127.0.0.1:40022");
    assert.deepStrictEqual(
        allocations.map((value) => value.count),
        [3, 3]
    );
    assert.deepStrictEqual(starts[1].gdbPorts, [40021, 40022]);
    assert.strictEqual(starts[1].port, 40020);
    assert.strictEqual(starts[1].probeSerial, "1234");
    assert.strictEqual(prepared, 1);
    assert.strictEqual(recorded, 1);
    assert.strictEqual(stopped.length, 1, "The failed server is stopped before retrying");
    assert.strictEqual(retryHost._probeCoordinator.isActive("debugStart"), true);
    assert.deepStrictEqual(retryHost._configureManagedRuntimeWatch(), []);
    retryHost._managedDebugSessionId = "core1";
    retryHost._handleManagedTargetState({ session: { id: "core1" }, state: "continued", epoch: 1 });
    assert.strictEqual(retryHost._runtimeResumeTimer, null, "Unsupported runtime reads never schedule Tcl sampling");
    await retryHost._stopManagedDebugServer();
    assert.strictEqual(stopped.length, 2);
    assert.strictEqual(retryHost._probeCoordinator.anyActive(), false);

    await assert.rejects(allocateDebugPorts(0), /1..33/);
    await assert.rejects(allocateDebugPorts(34), /1..33/);
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    try {
        const blockedPort = blocker.address().port;
        const ports = await allocateDebugPorts(4, [blockedPort]);
        assert.strictEqual(new Set(ports).size, 4);
        assert(!ports.includes(blockedPort));
        // The reservation sockets are all closed before control returns to startup.
        for (const port of ports) {
            const server = net.createServer();
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, "127.0.0.1", resolve);
            });
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        await new Promise((resolve) => blocker.close(resolve));
    }
    console.log("OpenOCD controller, core selection, ports and lease tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
