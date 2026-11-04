"use strict";

const assert = require("assert");
const net = require("net");
const { EventEmitter } = require("events");
const { scenario } = require("./helpers/scenario");
const { RttController } = require("../src/services/rttController");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { CACHE_KEYS } = require("../src/cacheKeys");
const { FakeClock } = require("./helpers/fake-clock");
const { waitFor } = require("./helpers/wait");

const emptyChannels = { up: [], down: [] };
const oneChannel = {
    up: [{ index: 0, name: "Terminal", size: 1024, flags: 2, mode: "block" }],
    down: [{ index: 0, name: "Input", size: 16, flags: 0, mode: "skip" }]
};

function fakeHost(overrides = {}) {
    return {
        debugLaunch: { managedServer: null, starting: false, liveSession: () => null },
        _sampling: { running: false, session: null },
        _probeCoordinator: new ProbeCoordinator(),
        _context: {
            workspaceState: {
                get: (key) => ({ [CACHE_KEYS.debugger]: "cmsis-dap.cfg", [CACHE_KEYS.mcuCore]: "stm32f4x.cfg" })[key]
            }
        },
        _resolveOpenOcdPath: async () => "openocd",
        _probeConnectionService: {
            prepare: async () => ({}),
            resolveProbe: async () => "cmsis-dap.cfg",
            recordSuccess: async () => {}
        },
        _commandContext: () => ({ cwd: "C:/work" }),
        _resolveTclPort: async () => 0,
        readElfSymbols: () => ({ symbols: [], memory: { sections: [] } }),
        _downloadRunning: false,
        _chipInfoRunning: false,
        ...overrides
    };
}

// A data socket that never connects on its own; scenarios emit its events.
function idleSocket() {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => {
        socket.destroyed = true;
    };
    return socket;
}

const fakeVscode = { workspace: { getConfiguration: () => ({ get: (_name, fallback) => fallback }) } };

// A borrowed host session (managed debug server or live-watch session) with a scriptable rttControl.
function fakeHostSession({ channels = oneChannel, failures = [] } = {}) {
    const calls = [];
    const session = {
        ready: true,
        stopped: false,
        capabilities: { runtimeRead: true },
        rttControl: async (request) => {
            calls.push(request);
            if (failures.length) {
                const failure = failures.shift();
                if (failure) throw failure;
            }
            if (request.operation === "start" || request.operation === "channels") {
                return { channels: typeof channels === "function" ? channels(calls.length) : channels };
            }
            return {};
        }
    };
    return { session, calls };
}

// The lightweight session the controller starts when it owns the probe. `order` records the teardown-relevant
// steps of every instance.
function ownSessionClass(order, { channels = oneChannel, rttControl } = {}) {
    return class {
        constructor(options, handlers) {
            this.options = options;
            this.handlers = handlers;
            this.stopped = false;
            this.rttCalls = [];
            this.rttControl =
                rttControl ||
                (async (request) => {
                    this.rttCalls.push(request);
                    if (request.operation === "start" || request.operation === "channels")
                        return { channels: typeof channels === "function" ? channels(this.rttCalls.length) : channels };
                    return {};
                });
        }
        async start() {
            order.push({ type: "ownStart", session: this });
            return {};
        }
        async stop() {
            this.stopped = true;
            order.push({ type: "ownStop", session: this });
            return true;
        }
    };
}

const flushQueue = (controller) => controller._queue;

function makeController(host, options = {}) {
    const statuses = [];
    const controller = new RttController(host, {
        vscode: fakeVscode,
        clock: options.clock || new FakeClock(),
        findFreePort: options.findFreePort || (async () => 19021),
        rttSettings: options.rttSettings || (() => ({ controlBlockAddress: "0x24000000" })),
        ramRegions: options.ramRegions,
        net: options.net,
        onStatus: (status) => statuses.push(status)
    });
    return { controller, statuses };
}

(async () => {
    await scenario("the managed debug server is borrowed before the live-watch session", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        const live = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        host._sampling = { running: true, session: live.session };
        const { controller } = makeController(host);
        await controller.start();
        assert.ok(managed.calls.some((call) => call.operation === "start"));
        assert.deepStrictEqual(live.calls, [], "the live-watch session is not touched while a debug server runs");
        assert.strictEqual(controller.status().source, "debug-server");
        assert.strictEqual(controller.status().state, "running");
        await controller.stop();
    });

    await scenario("without a session the controller starts its own under the rtt lease", async () => {
        const host = fakeHost();
        const order = [];
        const { controller } = makeController(host);
        controller._ManagedOpenOcdSession = ownSessionClass(order);
        await controller.start();
        assert.strictEqual(host._probeCoordinator.isActive("rtt"), true, "the rtt lease is held");
        assert.strictEqual(controller.status().source, "own-session");
        assert.strictEqual(controller.status().state, "running");
        await controller.stop();
        assert.strictEqual(host._probeCoordinator.isActive("rtt"), false, "the rtt lease is released");
        assert.strictEqual(order.at(-1).type, "ownStop", "the owned session is stopped last");
        assert.deepStrictEqual(order[0].session.rttCalls[0].block, {
            source: "address",
            address: 0x24000000,
            size: 72,
            exact: true
        });
    });

    await scenario("starting without a session while the probe is busy rejects", async () => {
        const host = fakeHost();
        host._probeCoordinator.acquire("download");
        const { controller } = makeController(host);
        await assert.rejects(controller.start(), { code: "PROBE_BUSY" });
        assert.strictEqual(controller.status().state, "stopped");
    });

    await scenario("multicore debug sessions are rejected", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        managed.session.capabilities = { runtimeRead: false };
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host);
        await assert.rejects(controller.start(), { code: "RTT_MULTICORE_UNSUPPORTED" });
        assert.deepStrictEqual(managed.calls, []);
    });

    await scenario("an empty channel listing retries with backoff until the firmware initializes", async () => {
        const host = fakeHost();
        const managed = fakeHostSession({ channels: (calls) => (calls >= 4 ? oneChannel : emptyChannels) });
        host.debugLaunch.managedServer = managed.session;
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        await controller.start();
        assert.strictEqual(controller.status().state, "starting", "start resolves while the ladder runs");
        await clock.advance(200);
        assert.strictEqual(controller.status().state, "starting");
        await clock.advance(300);
        assert.strictEqual(controller.status().state, "starting");
        await clock.advance(450);
        await waitFor(() => controller.status().state === "running");
        const operations = managed.calls.map((call) => call.operation);
        assert.deepStrictEqual(operations, ["start", "channels", "channels", "channels", "serverStart"]);
        assert.strictEqual(controller.status().channels.up[0].mode, "block");
        await controller.stop();
    });

    await scenario("a retryable start failure repeats the whole start sequence", async () => {
        const host = fakeHost();
        const managed = fakeHostSession({
            failures: [Object.assign(new Error("rtt: No control block found"), { retryable: true })]
        });
        host.debugLaunch.managedServer = managed.session;
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        await controller.start();
        await clock.advance(200);
        await waitFor(() => controller.status().state === "running");
        const operations = managed.calls.map((call) => call.operation);
        assert.deepStrictEqual(operations, ["start", "start", "serverStart"]);
        await controller.stop();
    });

    await scenario("a non-retryable failure stops the controller and releases the probe", async () => {
        const host = fakeHost();
        const order = [];
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        controller._ManagedOpenOcdSession = ownSessionClass(order, {
            rttControl: async () => {
                throw Object.assign(new Error('invalid command name "rtt"'), {
                    code: "OPENOCD_TCL_ERROR",
                    retryable: false
                });
            }
        });
        await assert.rejects(controller.start(), { code: "OPENOCD_TCL_ERROR" });
        assert.strictEqual(controller.status().state, "stopped");
        assert.strictEqual(controller.status().error.code, "OPENOCD_TCL_ERROR");
        assert.strictEqual(host._probeCoordinator.isActive("rtt"), false);
        assert.strictEqual(order.at(-1).type, "ownStop");
    });

    await scenario("the retry ladder gives up after its attempt budget", async () => {
        const host = fakeHost();
        const managed = fakeHostSession({ channels: emptyChannels });
        host.debugLaunch.managedServer = managed.session;
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        await controller.start();
        await clock.advance(60000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "stopped");
        assert.strictEqual(controller.status().error.code, "RTT_START_TIMEOUT");
        assert.strictEqual(
            managed.calls.filter((call) => call.operation === "channels").length,
            12,
            "the ladder polls the channel list at most twelve times"
        );
        assert.strictEqual(managed.calls.at(-1).operation, "stop", "teardown stops RTT on the host session");
    });

    await scenario("channel data flows from the RTT TCP port into the cursor buffer", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const serverSockets = [];
        const listener = net.createServer((socket) => serverSockets.push(socket));
        await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
        const port = listener.address().port;
        const { controller } = makeController(host, { findFreePort: async () => port });
        try {
            await controller.start();
            await waitFor(() => controller.status().buffers[0]?.connected);
            serverSockets[0].write(Buffer.from("hello RTT\n"));
            await waitFor(() => controller.read(0).data.toString() === "hello RTT\n");
            const first = controller.read(0);
            serverSockets[0].write("more");
            await waitFor(
                () =>
                    controller.read(0, { generation: first.generation, cursor: first.nextCursor }).data.toString() ===
                    "more",
                "the cursor continues after the first read"
            );
            const status = controller.status();
            assert.deepStrictEqual(status.servers, [{ port, channel: 0 }]);
            assert.strictEqual(status.buffers[0].connected, true);
        } finally {
            await controller.stop();
            await new Promise((resolve) => listener.close(resolve));
        }
    });

    await scenario("stop tears down data, servers, rtt, the owned session and the lease in order", async () => {
        const host = fakeHost();
        const order = [];
        const listener = net.createServer(() => {});
        await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
        const port = listener.address().port;
        const netFake = {
            connect: (options) => {
                const socket = net.connect(options);
                const destroy = socket.destroy.bind(socket);
                socket.destroy = (...args) => {
                    order.push("destroyData");
                    return destroy(...args);
                };
                return socket;
            }
        };
        const ownClass = ownSessionClass(order);
        const { controller } = makeController(host, { findFreePort: async () => port, net: netFake });
        controller._ManagedOpenOcdSession = ownClass;
        try {
            await controller.start();
            await waitFor(() => controller.status().buffers[0]?.connected);
            const own = order[0].session;
            own.rttControl = async (request) => {
                order.push("rtt:" + request.operation);
                if (request.operation === "start" || request.operation === "channels") return { channels: oneChannel };
                return {};
            };
            await controller.stop();
            assert.deepStrictEqual(
                order.slice(-4).map((entry) => (typeof entry === "string" ? entry : entry.type)),
                ["destroyData", "rtt:serverStop", "rtt:stop", "ownStop"],
                "data stops first, then the RTT servers, RTT itself and the owned session"
            );
            assert.strictEqual(host._probeCoordinator.isActive("rtt"), false);
            assert.strictEqual(controller.status().state, "stopped");
            assert.deepStrictEqual(controller.status().buffers, []);
        } finally {
            await new Promise((resolve) => listener.close(resolve));
        }
    });

    await scenario(
        "yielding for a debug start re-attaches to the debug server and back to its own session",
        async () => {
            const host = fakeHost();
            const order = [];
            const clock = new FakeClock();
            const { controller } = makeController(host, { clock });
            controller._ManagedOpenOcdSession = ownSessionClass(order);
            await controller.start();
            assert.strictEqual(controller.status().source, "own-session");
            await controller.yieldForRestart("debug");
            assert.strictEqual(controller.status().state, "pending-host");
            assert.strictEqual(controller.status().yieldedFor, "debug");
            assert.strictEqual(host._probeCoordinator.isActive("rtt"), false, "yielding releases the probe");
            const managed = fakeHostSession();
            host.debugLaunch.managedServer = managed.session;
            controller.onSessionsChanged();
            await waitFor(
                () => controller.status().state === "running" && controller.status().source === "debug-server"
            );
            assert.ok(managed.calls.some((call) => call.operation === "start"));
            host.debugLaunch.managedServer = null;
            controller.onSessionsChanged();
            await flushQueue(controller);
            await clock.advance(1000);
            await waitFor(
                () => controller.status().state === "running" && controller.status().source === "own-session"
            );
            assert.strictEqual(order.filter((entry) => entry.type === "ownStart").length, 2, "ownership is restored");
            await controller.stop();
        }
    );

    await scenario("a borrowed attachment stops when its session ends without a successor", async () => {
        const host = fakeHost();
        const live = fakeHostSession();
        host._sampling = { running: true, session: live.session };
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        await controller.start();
        assert.strictEqual(controller.status().source, "live-watch");
        host._sampling = { running: false, session: null };
        controller.onSessionsChanged();
        await waitFor(() => controller.status().state === "pending-host");
        await clock.advance(1000);
        await waitFor(() => controller.status().state === "stopped");
        assert.strictEqual(controller.status().reason, "host-ended");
    });

    await scenario("an attachment follows the live watch that replaces its ended debug server", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        await controller.start();
        host.debugLaunch.managedServer = null;
        controller.onSessionsChanged();
        await waitFor(() => controller.status().state === "pending-host");
        await clock.advance(350);
        const live = fakeHostSession();
        host._sampling = { running: true, session: live.session };
        controller.onSessionsChanged();
        await waitFor(() => controller.status().state === "running" && controller.status().source === "live-watch");
        await clock.advance(5000);
        assert.strictEqual(controller.status().state, "running", "the settle timer was cancelled");
        await controller.stop();
    });

    await scenario("a yielded borrowed attachment waits for the live watch to return", async () => {
        const host = fakeHost();
        const live = fakeHostSession();
        host._sampling = { running: true, session: live.session };
        const { controller } = makeController(host);
        await controller.start();
        await controller.yieldForRestart("download");
        assert.strictEqual(controller.status().state, "pending-host");
        // The download stops the live watch it yielded for; with no session and no own-session intent RTT waits.
        host._sampling = { running: false, session: null };
        controller.onSessionsChanged();
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "pending-host", "no session and no own-session intent: wait");
        host._sampling = { running: true, session: fakeHostSession().session };
        controller.onSessionsChanged();
        await waitFor(() => controller.status().state === "running" && controller.status().source === "live-watch");
        await controller.stop();
    });

    await scenario("reads are gated by the running state and the channel list", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host);
        assert.throws(() => controller.read(0), { code: "RTT_NOT_RUNNING" });
        await controller.start();
        assert.throws(() => controller.read(7), { code: "RTT_UNKNOWN_CHANNEL" });
        const read = controller.read(0);
        assert.strictEqual(read.data.length, 0, "a connected channel reads empty until data arrives");
        await controller.stop();
        assert.throws(() => controller.read(0), { code: "RTT_NOT_RUNNING" });
    });

    await scenario("the control block follows the configured address, symbol and region fallbacks", async () => {
        const host = fakeHost();
        const symbolSession = fakeHostSession();
        host.debugLaunch.managedServer = symbolSession.session;
        let regionsCalls = 0;
        const { controller: symbolController } = makeController(host, {
            rttSettings: () => ({}),
            ramRegions: async () => {
                regionsCalls++;
                return [{ type: "ram", origin: 0x20000000, capacity: 0x20000, name: "RAM" }];
            }
        });
        host.readElfSymbols = () => ({
            symbols: [{ name: "_SEGGER_RTT", address: 0x20000400, size: 168 }],
            memory: { sections: [] }
        });
        await symbolController.start();
        const bySymbol = symbolSession.calls.find((call) => call.operation === "start").block;
        assert.deepStrictEqual(
            { source: bySymbol.source, address: bySymbol.address },
            { source: "symbol", address: 0x20000400 }
        );
        assert.strictEqual(regionsCalls, 0, "the region analysis is not needed when the symbol resolves");
        await symbolController.stop();

        host.readElfSymbols = () => ({ symbols: [], memory: { sections: [] } });
        const regionSession = fakeHostSession();
        host.debugLaunch.managedServer = regionSession.session;
        const { controller: regionController } = makeController(host, {
            rttSettings: () => ({}),
            ramRegions: async () => {
                regionsCalls++;
                return [{ type: "ram", origin: 0x20000000, capacity: 0x20000, name: "RAM" }];
            }
        });
        await regionController.start();
        assert.deepStrictEqual(regionController.status().block, {
            source: "region",
            address: 0x20000000,
            size: 0x20000
        });
        assert.strictEqual(regionsCalls, 1);
        await regionController.stop();
    });

    await scenario("re-attaching gives the buffers a new generation so old cursors cannot alias new data", async () => {
        const host = fakeHost();
        const live = fakeHostSession();
        host._sampling = { running: true, session: live.session };
        const { controller } = makeController(host, { net: { connect: () => idleSocket() } });
        await controller.start();
        const before = controller.read(0);
        await controller.yieldForRestart("download");
        controller.onSessionsChanged();
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "running");
        const after = controller.read(0, { generation: before.generation, cursor: 0 });
        assert.ok(after.generation > before.generation);
        assert.strictEqual(after.reset, true);
        await controller.stop();
    });

    await scenario("a stop during a yield wins and nothing re-attaches", async () => {
        const host = fakeHost();
        const live = fakeHostSession();
        host._sampling = { running: true, session: live.session };
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        await controller.start();
        const yielded = controller.yieldForRestart("download");
        await Promise.all([yielded, controller.stop()]);
        assert.strictEqual(controller.status().state, "stopped");
        controller.onSessionsChanged();
        await clock.advance(5000);
        assert.strictEqual(controller.status().state, "stopped");
    });

    await scenario("a start during teardown runs after it on a clean controller", async () => {
        const host = fakeHost();
        const live = fakeHostSession();
        host._sampling = { running: true, session: live.session };
        const { controller } = makeController(host);
        await controller.start();
        const stopped = controller.stop();
        await controller.start();
        await stopped;
        const status = controller.status();
        assert.strictEqual(status.state, "running");
        assert.strictEqual(status.source, "live-watch");
        assert.ok(controller._hostSession, "the new attachment keeps its host");
        assert.deepStrictEqual(
            live.calls.map((call) => call.operation),
            ["start", "serverStart", "serverStop", "stop", "start", "serverStart"]
        );
        await controller.stop();
    });

    await scenario("a stop during the own session startup leaves no session or lease behind", async () => {
        const host = fakeHost();
        const order = [];
        let finishStart;
        const { controller } = makeController(host);
        controller._ManagedOpenOcdSession = class extends ownSessionClass(order) {
            async start() {
                await new Promise((resolve) => (finishStart = resolve));
                return super.start();
            }
        };
        const started = controller.start();
        await waitFor(() => finishStart);
        const stopped = controller.stop();
        finishStart();
        await Promise.all([started, stopped]);
        assert.strictEqual(controller.status().state, "stopped");
        assert.strictEqual(host._probeCoordinator.isActive("rtt"), false);
        assert.strictEqual(order.at(-1).type, "ownStop");
    });

    await scenario("a yield waits for the own session startup instead of losing the probe race", async () => {
        const host = fakeHost();
        const order = [];
        let finishStart;
        const { controller } = makeController(host);
        controller._ManagedOpenOcdSession = class extends ownSessionClass(order) {
            async start() {
                await new Promise((resolve) => (finishStart = resolve));
                return super.start();
            }
        };
        const started = controller.start();
        await waitFor(() => finishStart);
        const yielded = controller.yieldForRestart("liveWatch");
        assert.ok(yielded, "a startup in flight counts as holding the probe");
        finishStart();
        await Promise.all([started, yielded]);
        assert.strictEqual(host._probeCoordinator.isActive("rtt"), false);
        assert.strictEqual(controller.status().state, "pending-host");
        await controller.stop();
    });

    await scenario("own-session intent survives several yields and a busy probe", async () => {
        const host = fakeHost();
        const order = [];
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        controller._ManagedOpenOcdSession = ownSessionClass(order);
        await controller.start();
        await controller.yieldForRestart("liveWatch");
        const live = fakeHostSession();
        host._sampling = { running: true, session: live.session };
        controller.onSessionsChanged();
        await flushQueue(controller);
        assert.strictEqual(controller.status().source, "live-watch");
        await controller.yieldForRestart("download");
        host._sampling = { running: false, session: null };
        // The precheck path: a debug start reserved the probe when the settle timer fires.
        host.debugLaunch.starting = true;
        const debugLease = host._probeCoordinator.acquire("debugStart");
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "pending-host", "a busy probe keeps the wait going");
        host.debugLaunch.starting = false;
        debugLease.release();
        controller.onProbeChanged();
        await flushQueue(controller);
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().source, "own-session", "the owned session comes back");
        await controller.stop();
    });

    await scenario("a busy resume precheck is retryable and keeps the intent", async () => {
        const host = fakeHost();
        const order = [];
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        controller._ManagedOpenOcdSession = ownSessionClass(order);
        await controller.start();
        await controller.yieldForRestart("debug");
        host._downloadRunning = true;
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "pending-host");
        assert.strictEqual(controller.status().error.code, "PROBE_BUSY");
        host._downloadRunning = false;
        controller.onProbeChanged();
        await flushQueue(controller);
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "running");
        await controller.stop();
    });

    await scenario("an operation that never hosted a session does not strand a pending controller", async () => {
        const host = fakeHost();
        const order = [];
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        controller._ManagedOpenOcdSession = ownSessionClass(order);
        await controller.start();
        await controller.yieldForRestart("liveWatch");
        // The live watch failed to start: no lease changed afterwards and no session appeared.
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().source, "own-session");
        await controller.stop();

        const borrowed = fakeHostSession();
        host._sampling = { running: true, session: borrowed.session };
        await controller.start();
        await controller.yieldForRestart("download");
        host._sampling = { running: false, session: null };
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "stopped", "nothing is left to follow");
        assert.strictEqual(controller.status().reason, "host-ended");
    });

    await scenario("a long lease keeps the wait until its release", async () => {
        const host = fakeHost();
        const order = [];
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        controller._ManagedOpenOcdSession = ownSessionClass(order);
        await controller.start();
        await controller.yieldForRestart("externalDebug");
        const external = host._probeCoordinator.acquire("externalDebug");
        await clock.advance(5000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "pending-host");
        external.release();
        controller.onProbeChanged();
        await flushQueue(controller);
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().source, "own-session");
        await controller.stop();
    });

    await scenario("a manual start ends a pending wait", async () => {
        const host = fakeHost();
        const order = [];
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        controller._ManagedOpenOcdSession = ownSessionClass(order);
        const borrowed = fakeHostSession();
        host._sampling = { running: true, session: borrowed.session };
        await controller.start();
        await controller.yieldForRestart("download");
        host._sampling = { running: false, session: null };
        await controller.start();
        assert.strictEqual(controller.status().state, "running");
        assert.strictEqual(controller.status().source, "own-session");
        await controller.stop();
    });

    await scenario("yieldOwnSession displaces only a session RTT owns", async () => {
        const host = fakeHost();
        const live = fakeHostSession();
        host._sampling = { running: true, session: live.session };
        const { controller } = makeController(host);
        await controller.start();
        assert.strictEqual(controller.yieldOwnSession("chipInfo"), null, "a borrowed attachment stays");
        await controller.stop();
        host._sampling = { running: false, session: null };
        const order = [];
        controller._ManagedOpenOcdSession = ownSessionClass(order);
        await controller.start();
        await controller.yieldOwnSession("chipInfo");
        assert.strictEqual(host._probeCoordinator.isActive("rtt"), false);
        assert.strictEqual(controller.status().yieldedFor, "chipInfo");
        await controller.stop();
    });

    await scenario("a configured address works without an ELF", async () => {
        const host = fakeHost();
        host.readElfSymbols = () => {
            throw Object.assign(new Error("ELF is still loading"), { code: "ELF_LOADING" });
        };
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host);
        await controller.start();
        assert.strictEqual(controller.status().state, "running");
        await controller.stop();
    });

    await scenario("a reloading ELF retries and then uses its symbol", async () => {
        const host = fakeHost();
        let loaded = false;
        host.readElfSymbols = () => {
            if (!loaded) throw Object.assign(new Error("ELF changed"), { code: "ELF_CHANGED" });
            return { symbols: [{ name: "_SEGGER_RTT", address: 0x20000400, size: 168 }] };
        };
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock, rttSettings: () => ({}) });
        await controller.start();
        assert.strictEqual(controller.status().state, "starting", "a reloading ELF is not a failure");
        loaded = true;
        await clock.advance(200);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "running");
        assert.strictEqual(managed.calls[0].block.source, "symbol");
        await controller.stop();
    });

    await scenario("an unconfigured ELF falls through to the configured range", async () => {
        const host = fakeHost();
        host.readElfSymbols = () => {
            throw Object.assign(new Error("Select an ELF"), { code: "ELF_NOT_CONFIGURED" });
        };
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host, {
            rttSettings: () => ({ searchRange: { address: "0x20000000", size: "0x1000" } })
        });
        await controller.start();
        assert.strictEqual(managed.calls[0].block.source, "range");
        await controller.stop();
    });

    await scenario("a scan runs slice by slice, keeps the polling interval and stops at the find", async () => {
        const host = fakeHost();
        const missing = () => Object.assign(new Error("rtt: No control block found"), { retryable: true });
        const managed = fakeHostSession({ failures: [missing(), missing()] });
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host, {
            rttSettings: () => ({ searchRange: { address: "0x20000000", size: "0x20000" }, pollingIntervalMs: 20 })
        });
        await controller.start();
        const starts = managed.calls.filter((call) => call.operation === "start");
        assert.deepStrictEqual(
            starts.map((call) => call.block.address),
            [0x20000000, 0x20008000, 0x20010000],
            "the search stops at the slice that finds the block"
        );
        assert.ok(starts.every((call) => call.pollingIntervalMs === 20));
        assert.strictEqual(controller.status().state, "running");
        assert.strictEqual(controller.status().block.size, 0x20000, "the status shows the configured range");
        await controller.stop();
    });

    await scenario("a stop ends a scan between slices", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        let controllerRef = null;
        const rttControl = managed.session.rttControl;
        managed.session.rttControl = async (request) => {
            if (request.operation !== "start") return rttControl(request);
            managed.calls.push(request);
            void controllerRef.stop();
            throw Object.assign(new Error("rtt: No control block found"), { retryable: true });
        };
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host, {
            rttSettings: () => ({ searchRange: { address: "0x20000000", size: "0x100000" } })
        });
        controllerRef = controller;
        await controller.start();
        await flushQueue(controller);
        assert.strictEqual(managed.calls.filter((call) => call.operation === "start").length, 1);
        assert.strictEqual(controller.status().state, "stopped");
    });

    await scenario("a partly failed server start stops the servers it opened", async () => {
        const host = fakeHost();
        const twoChannels = { up: [oneChannel.up[0], { ...oneChannel.up[0], index: 2 }], down: [] };
        const managed = fakeHostSession({ channels: twoChannels });
        const rttControl = managed.session.rttControl;
        managed.session.rttControl = async (request) => {
            if (request.operation === "serverStart") {
                managed.calls.push(request);
                throw Object.assign(new Error("port in use"), {
                    code: "OPENOCD_TCL_ERROR",
                    retryable: false,
                    details: { operation: "serverStart", executed: 1 }
                });
            }
            return rttControl(request);
        };
        host.debugLaunch.managedServer = managed.session;
        let port = 19021;
        const { controller } = makeController(host, { findFreePort: async () => port++ });
        await assert.rejects(controller.start(), { code: "OPENOCD_TCL_ERROR" });
        assert.deepStrictEqual(managed.calls.find((call) => call.operation === "serverStop").ports, [19021]);
    });

    await scenario("server ports carry the real channel numbers", async () => {
        const host = fakeHost();
        const gap = { up: [oneChannel.up[0], { ...oneChannel.up[0], index: 2 }], down: [] };
        const managed = fakeHostSession({ channels: gap });
        host.debugLaunch.managedServer = managed.session;
        let port = 19021;
        const { controller } = makeController(host, {
            findFreePort: async () => port++,
            net: { connect: () => idleSocket() }
        });
        await controller.start();
        assert.deepStrictEqual(controller.status().servers, [
            { port: 19021, channel: 0 },
            { port: 19022, channel: 2 }
        ]);
        assert.ok(controller.read(2));
        await controller.stop();
    });

    await scenario(
        "a channel that keeps losing its connection reports it; a good connection resets the budget",
        async () => {
            const host = fakeHost();
            const managed = fakeHostSession();
            host.debugLaunch.managedServer = managed.session;
            const clock = new FakeClock();
            const sockets = [];
            const { controller } = makeController(host, {
                clock,
                net: {
                    connect: () => {
                        const socket = idleSocket();
                        sockets.push(socket);
                        return socket;
                    }
                }
            });
            await controller.start();
            for (let round = 0; round < 40; round++) {
                sockets.at(-1).emit("connect");
                sockets.at(-1).emit("close");
                await clock.advance(25);
            }
            assert.strictEqual(controller.status().error, null, "connections that succeed never exhaust the budget");
            for (let round = 0; round < 21; round++) {
                sockets.at(-1).emit("close");
                await clock.advance(400);
            }
            assert.strictEqual(controller.status().error.code, "RTT_CHANNEL_DISCONNECTED");
            await controller.stop();
        }
    );

    console.log("RTT controller tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
