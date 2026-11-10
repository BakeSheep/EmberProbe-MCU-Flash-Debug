"use strict";

const assert = require("assert");
const net = require("net");
const { EventEmitter } = require("events");
const { scenario } = require("./helpers/scenario");
const { RttController } = require("../src/services/rttController");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { CACHE_KEYS } = require("../src/cacheKeys");
const pkg = require("../package.json");
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

// An idle socket whose writes are recorded, for down-channel input.
function writableSocket(writes = []) {
    const socket = idleSocket();
    socket.write = (bytes) => {
        writes.push(Buffer.from(bytes));
        return true;
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
        vscode: options.vscode || fakeVscode,
        clock: options.clock || new FakeClock(),
        findFreePort: options.findFreePort || (async () => 19021),
        rttSettings: "rttSettings" in options ? options.rttSettings : () => ({ controlBlockAddress: "0x24000000" }),
        ramRegions: options.ramRegions,
        net: options.net,
        onStatus: (status) => statuses.push(status),
        onBeforeStop: options.onBeforeStop,
        onData: options.onData,
        onAutoStart: options.onAutoStart,
        autoStart: options.autoStart
    });
    return { controller, statuses };
}

(async () => {
    await scenario(
        "Agent mode overrides reject before probe access and frozen settings cannot add later writes",
        async () => {
            const host = fakeHost();
            let settings = { controlBlockAddress: "0x24000000", channels: [{ index: 0, mode: "trim" }] };
            const { controller } = makeController(host, { rttSettings: () => settings });
            await assert.rejects(controller.start({ origin: "agent" }), { code: "RTT_MODE_REQUIRES_UI_START" });
            assert.strictEqual(host._probeCoordinator.anyActive(), false);
            const managed = fakeHostSession();
            host.debugLaunch.managedServer = managed.session;
            settings = { controlBlockAddress: "0x24000000", channels: [0], pollingIntervalMs: 20 };
            await controller.start({ origin: "agent" });
            settings = { ...settings, channels: [{ index: 0, mode: "block" }], pollingIntervalMs: 1 };
            await controller.yieldForRestart("debug");
            controller.onSessionsChanged();
            await flushQueue(controller);
            assert.strictEqual(managed.calls.filter((call) => call.operation === "start").at(-1).pollingIntervalMs, 20);
            assert.ok(!managed.calls.some((call) => call.operation === "setMode"));
            await controller.stop();
        }
    );

    await scenario("mode overrides require an exact block before issuing RTT control", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host, {
            rttSettings: () => ({
                searchRange: { address: "0x24000000", size: 4096 },
                channels: [{ index: 0, mode: "trim" }]
            })
        });
        await assert.rejects(controller.start(), { code: "RTT_EXACT_ADDRESS_REQUIRED" });
        assert.ok(!managed.calls.some((call) => call.operation === "start"));
    });

    await scenario(
        "modes apply once after all sockets connect and firmware changes are observed, not overridden",
        async () => {
            const host = fakeHost({ _writes: { sessionConnection: () => ({ probe: "test", target: "stm32f4x" }) } });
            const managed = fakeHostSession();
            host.debugLaunch.managedServer = managed.session;
            const base = managed.session.rttControl;
            managed.session.rttControl = async (request) => {
                if (request.operation === "setMode") {
                    managed.calls.push(request);
                    return { channel: { index: 0, flags: 1, mode: "trim" }, changed: true };
                }
                if (request.operation === "snapshot") {
                    managed.calls.push(request);
                    return {
                        snapshot: {
                            channels: [{ index: 0, flags: 0, mode: "skip", size: 1024, usedBytes: 12, capacity: 1023 }]
                        }
                    };
                }
                return base(request);
            };
            const socket = idleSocket();
            const clock = new FakeClock();
            const { controller } = makeController(host, {
                clock,
                net: { connect: () => socket },
                rttSettings: () => ({ controlBlockAddress: "0x24000000", channels: [{ index: 0, mode: "trim" }] })
            });
            await controller.start();
            assert.strictEqual(controller.status().channels.up[0].modeState, "pending");
            assert.ok(!managed.calls.some((call) => call.operation === "setMode"));
            socket.emit("connect");
            await flushQueue(controller);
            assert.strictEqual(controller.status().channels.up[0].mode, "trim");
            assert.strictEqual(controller.status().channels.up[0].modeState, "applied");
            socket.emit("data", Buffer.alloc(2000));
            await clock.advance(1000);
            await waitFor(() => controller.status().targetTelemetry.available);
            assert.strictEqual(controller.status().buffers[0].rateBytesPerSecond, 2000);
            assert.strictEqual(controller.status().channels.up[0].modeState, "mismatch");
            await clock.advance(1000);
            assert.strictEqual(controller.status().buffers[0].rateBytesPerSecond, 0);
            assert.strictEqual(managed.calls.filter((call) => call.operation === "setMode").length, 1);
            assert.strictEqual(controller.status().targetDroppedBytes, null);
            await controller.stop();
            const calls = managed.calls.length;
            await clock.advance(5000);
            assert.strictEqual(managed.calls.length, calls);
        }
    );

    await scenario("uncertain mode writes stop attachment without automatic retries", async () => {
        const host = fakeHost({ _writes: { sessionConnection: () => ({ probe: "test" }) } });
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const base = managed.session.rttControl;
        managed.session.rttControl = async (request) => {
            if (request.operation === "setMode") {
                managed.calls.push(request);
                throw Object.assign(new Error("write result unknown"), {
                    code: "RTT_READBACK_MISMATCH",
                    retryable: true,
                    details: { resultUnknown: true }
                });
            }
            return base(request);
        };
        const socket = idleSocket();
        const clock = new FakeClock();
        const { controller } = makeController(host, {
            clock,
            net: { connect: () => socket },
            rttSettings: () => ({ controlBlockAddress: "0x24000000", channels: [{ index: 0, mode: "trim" }] })
        });
        await controller.start();
        socket.emit("connect");
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "stopped");
        assert.strictEqual(controller.status().error.details.resultUnknown, true);
        await clock.advance(20000);
        assert.strictEqual(managed.calls.filter((call) => call.operation === "setMode").length, 1);
    });

    await scenario("a busy lock delays a mode write without ending RTT", async () => {
        const host = fakeHost({ _writes: { sessionConnection: () => ({ probe: "test" }) } });
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const base = managed.session.rttControl;
        let busy = 2;
        managed.session.rttControl = async (request) => {
            if (request.operation === "setMode" && busy-- > 0)
                throw Object.assign(new Error("lock busy"), { code: "PROBE_CONNECTION_BUSY_TIMEOUT" });
            return base(request);
        };
        const socket = idleSocket();
        const clock = new FakeClock();
        const { controller } = makeController(host, {
            clock,
            net: { connect: () => socket },
            rttSettings: () => ({ controlBlockAddress: "0x24000000", channels: [{ index: 0, mode: "trim" }] })
        });
        await controller.start();
        socket.emit("connect");
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "running");
        await clock.advance(300);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "running");
        assert.strictEqual(managed.calls.filter((call) => call.operation === "setMode").length, 1);
        await controller.stop();
    });

    await scenario("stopped status keeps no polling, origin or mode settings from the finished run", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host, {
            net: { connect: () => idleSocket() },
            rttSettings: () => ({ controlBlockAddress: "0x24000000", pollingIntervalMs: 50 })
        });
        await controller.start();
        assert.strictEqual(controller.status().configuredPollingIntervalMs, 50);
        await controller.stop();
        assert.strictEqual(controller._runSettings, null);
        assert.strictEqual(controller._origin, null);
        assert.notStrictEqual(controller.status().configuredPollingIntervalMs, 50);
    });

    await scenario("a mapped down channel gets an input-only server and writes route to it", async () => {
        const channels = {
            up: [{ index: 0, name: "Terminal", size: 1024, flags: 2, mode: "block" }],
            down: [
                { index: 0, name: "Unused", size: 16, flags: 0, mode: "skip" },
                { index: 2, name: "Shell", size: 16, flags: 0, mode: "skip" }
            ]
        };
        const host = fakeHost();
        const managed = fakeHostSession({ channels });
        host.debugLaunch.managedServer = managed.session;
        const sockets = [];
        const ports = [19021, 19022];
        const { controller } = makeController(host, {
            findFreePort: async () => ports.shift(),
            net: {
                connect: () => {
                    const writes = [];
                    const socket = writableSocket(writes);
                    socket.writes = writes;
                    sockets.push(socket);
                    return socket;
                }
            },
            rttSettings: () => ({ controlBlockAddress: "0x24000000", channels: [{ index: 0, down: 2 }] })
        });
        const status = await controller.start();
        assert.strictEqual(status.channels.up[0].downChannel, 2);
        const start = managed.calls.find((call) => call.operation === "startServers" || call.servers);
        assert.deepStrictEqual(
            start.servers.map(({ channel, inputOnly }) => ({ channel, inputOnly })),
            [
                { channel: 0, inputOnly: undefined },
                { channel: 2, inputOnly: true }
            ]
        );
        for (const socket of sockets) socket.emit("connect");
        await flushQueue(controller);
        sockets[1].emit("data", Buffer.from("discarded"));
        assert.strictEqual(controller.read(0, {}).data.length, 0);
        assert.strictEqual(controller.write(0, "x\n"), 2);
        assert.deepStrictEqual(sockets[0].writes, []);
        assert.strictEqual(Buffer.concat(sockets[1].writes.map((data) => Buffer.from(data))).toString(), "x\n");
        await controller.stop();
    });

    await scenario("received bytes notify onData and a throwing consumer keeps the socket", async () => {
        const host = fakeHost();
        host.debugLaunch.managedServer = fakeHostSession().session;
        const socket = idleSocket();
        const seen = [];
        const { controller } = makeController(host, {
            net: { connect: () => socket },
            onData: (channel) => {
                seen.push(channel);
                throw new Error("consumer failed");
            }
        });
        await controller.start();
        socket.emit("connect");
        await flushQueue(controller);
        socket.emit("data", Buffer.from("a"));
        assert.deepStrictEqual(seen, [0]);
        assert.strictEqual(controller.read(0, {}).data.toString(), "a");
        await controller.stop();
    });

    await scenario("automatic start acts once per host and never opens the probe", async () => {
        const host = fakeHost();
        let starts = 0;
        const { controller } = makeController(host, { autoStart: () => true, onAutoStart: () => starts++ });
        controller.onSessionsChanged();
        assert.strictEqual(starts, 0, "no session, no start");
        const first = fakeHostSession().session;
        host.debugLaunch.managedServer = first;
        controller.onSessionsChanged();
        controller.onSessionsChanged();
        assert.strictEqual(starts, 1);
        host.debugLaunch.managedServer = null;
        controller.onSessionsChanged();
        host.debugLaunch.managedServer = first;
        controller.onSessionsChanged();
        assert.strictEqual(starts, 2, "a session that went away counts as new");
        const off = makeController(host, { autoStart: () => false, onAutoStart: () => assert.fail("disabled") });
        off.controller.onSessionsChanged();
    });

    await scenario("a user stop is not undone on the same host, and the next host starts again", async () => {
        const host = fakeHost();
        const session = fakeHostSession().session;
        host.debugLaunch.managedServer = session;
        let autoStarts = 0;
        const { controller } = makeController(host, {
            autoStart: () => true,
            onAutoStart: () => autoStarts++,
            net: { connect: () => idleSocket() }
        });
        await controller.start();
        await controller.stop();
        controller.onSessionsChanged();
        assert.strictEqual(autoStarts, 0);
        host.debugLaunch.managedServer = fakeHostSession().session;
        controller.onSessionsChanged();
        assert.strictEqual(autoStarts, 1);
    });

    await scenario("origin auto borrows a session, refuses mode writes and never starts its own", async () => {
        const host = fakeHost();
        const { controller } = makeController(host, { net: { connect: () => idleSocket() } });
        assert.strictEqual((await controller.start({ origin: "auto" })).state, "stopped");
        assert.strictEqual(controller._ownSession ?? null, null);
        const modes = makeController(host, {
            rttSettings: () => ({ channels: [{ index: 0, mode: "trim" }] })
        });
        host.debugLaunch.managedServer = fakeHostSession().session;
        await assert.rejects(modes.controller.start({ origin: "auto" }), { code: "RTT_MODE_REQUIRES_UI_START" });
        assert.strictEqual((await controller.start({ origin: "auto" })).state, "running");
        await controller.stop();
    });

    await scenario(
        "telemetry is unavailable for scanning and late samples cannot revive a detached generation",
        async () => {
            const host = fakeHost();
            const managed = fakeHostSession();
            host.debugLaunch.managedServer = managed.session;
            const clock = new FakeClock();
            const { controller } = makeController(host, { clock, net: { connect: idleSocket } });
            let resolveSample;
            const base = managed.session.rttControl;
            managed.session.rttControl = (request) =>
                request.operation === "snapshot"
                    ? new Promise((resolve) => {
                          resolveSample = resolve;
                      })
                    : base(request);
            await controller.start();
            await clock.advance(1000);
            assert.ok(resolveSample);
            await controller.stop();
            resolveSample({ snapshot: { channels: [] } });
            await Promise.resolve();
            assert.strictEqual(controller.status().targetTelemetry.available, false);
            assert.strictEqual(controller.status().targetTelemetry.reason, "RTT_NOT_RUNNING");
            const scanned = makeController(host, {
                clock,
                net: { connect: idleSocket },
                rttSettings: () => ({ searchRange: { address: "0x24000000", size: 4096 } })
            }).controller;
            await scanned.start();
            assert.strictEqual(scanned.status().targetTelemetry.reason, "RTT_EXACT_ADDRESS_REQUIRED");
            await scanned.stop();
        }
    );

    await scenario("a silent receiver has a bounded mode startup deadline and pending sockets are closed", async () => {
        const host = fakeHost({ _writes: { sessionConnection: () => ({ probe: "test" }) } });
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const socket = idleSocket();
        const clock = new FakeClock();
        const { controller } = makeController(host, {
            clock,
            net: { connect: () => socket },
            rttSettings: () => ({ controlBlockAddress: "0x24000000", channels: [{ index: 0, mode: "block" }] })
        });
        await controller.start();
        await clock.advance(10000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "stopped");
        assert.strictEqual(controller.status().error.code, "RTT_CHANNEL_DISCONNECTED");
        assert.strictEqual(socket.destroyed, true);
        assert.ok(!managed.calls.some((call) => call.operation === "setMode"));
    });

    await scenario("stop or receiver loss between mode writes prevents the remaining block write", async () => {
        for (const action of ["stop", "disconnect"]) {
            const host = fakeHost({ _writes: { sessionConnection: () => ({ probe: "test" }) } });
            const channels = { up: [oneChannel.up[0], { ...oneChannel.up[0], index: 1 }], down: [] };
            const managed = fakeHostSession({ channels });
            host.debugLaunch.managedServer = managed.session;
            const sockets = [idleSocket(), idleSocket()];
            let next = 0;
            let release;
            const base = managed.session.rttControl;
            managed.session.rttControl = (request) => {
                if (request.operation !== "setMode") return base(request);
                managed.calls.push(request);
                return new Promise((resolve) => {
                    release = () => resolve({ channel: { index: request.channel, mode: "block", flags: 2 } });
                });
            };
            const { controller } = makeController(host, {
                net: { connect: () => sockets[next++] },
                rttSettings: () => ({
                    controlBlockAddress: "0x24000000",
                    channels: [
                        { index: 0, mode: "block" },
                        { index: 1, mode: "block" }
                    ]
                })
            });
            await controller.start();
            sockets.forEach((socket) => socket.emit("connect"));
            await waitFor(() => !!release);
            const stopping = action === "stop" ? controller.stop() : null;
            if (action === "disconnect") {
                sockets[1].destroy();
                sockets[1].emit("close");
            }
            release();
            await flushQueue(controller);
            if (stopping) await stopping;
            assert.deepStrictEqual(
                managed.calls.filter((call) => call.operation === "setMode").map((call) => call.channel),
                [0]
            );
            await controller.stop();
        }
    });

    await scenario("same-session epoch changes invalidate delayed and cached target telemetry", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        managed.session.targetEpoch = 1;
        host.debugLaunch.managedServer = managed.session;
        const base = managed.session.rttControl;
        let epoch = 0;
        managed.session.rttControl = async (request) =>
            request.operation === "snapshot"
                ? { snapshot: { targetEpoch: epoch, channels: [{ index: 0, mode: "skip", flags: 0 }] } }
                : base(request);
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock, net: { connect: idleSocket } });
        await controller.start();
        await clock.advance(1000);
        assert.strictEqual(controller.status().targetTelemetry.available, false);
        assert.strictEqual(controller.status().targetTelemetry.reason, "LIVE_READ_CANCELLED");
        epoch = 1;
        await clock.advance(1000);
        await waitFor(() => controller.status().targetTelemetry.available);
        managed.session.targetEpoch = 2;
        assert.strictEqual(controller.status().targetTelemetry.available, false);
        await controller.stop();
    });

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

    await scenario("a search that stalls the connection names the search, not the sampling connection", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        managed.session.rttControl = async () => {
            throw Object.assign(new Error("OpenOCD response timed out; sampling connection reset"), {
                code: "OPENOCD_RPC_TIMEOUT"
            });
        };
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host, {
            rttSettings: () => ({ searchRange: { address: "0x20000000", size: "0x8000" } })
        });
        await assert.rejects(controller.start(), (error) => error.code === "RTT_SCAN_TIMEOUT");
        assert.strictEqual(controller.status().error.code, "RTT_SCAN_TIMEOUT");
    });

    await scenario("the retry ladder gives up after its attempt budget", async () => {
        const host = fakeHost();
        const managed = fakeHostSession({ channels: emptyChannels });
        host._sampling = { running: true, session: managed.session };
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        await controller.start();
        assert.strictEqual(controller.status().source, "live-watch");
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

    await scenario("a debug server keeps an exact-address start waiting while the target may be halted", async () => {
        const host = fakeHost();
        // Halted at the entry breakpoint: the control block appears only after the user continues.
        let initialized = false;
        const managed = fakeHostSession({ channels: () => (initialized ? oneChannel : emptyChannels) });
        host.debugLaunch.managedServer = managed.session;
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock, net: { connect: () => idleSocket() } });
        await controller.start();
        await clock.advance(60000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "starting", "a manual start outlasts a long halt");
        initialized = true;
        await clock.advance(2000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "running");
        await controller.stop();
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

    await scenario("a start refused while waiting keeps the intent to restore the own session", async () => {
        const host = fakeHost();
        const order = [];
        const clock = new FakeClock();
        const { controller } = makeController(host, { clock });
        controller._ManagedOpenOcdSession = ownSessionClass(order);
        await controller.start();
        await controller.yieldForRestart("externalDebug");
        const external = host._probeCoordinator.acquire("externalDebug");
        await assert.rejects(controller.start(), (error) => error.code === "PROBE_BUSY");
        assert.strictEqual(controller.status().state, "pending-host");
        external.release();
        controller.onProbeChanged();
        await flushQueue(controller);
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.status().state, "running");
        assert.strictEqual(controller.status().source, "own-session");
        await controller.stop();
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

    await scenario("polling defaults to 10 ms and explicit zero restores 100 ms on a reused session", async () => {
        const properties = Object.assign({}, ...pkg.contributes.configuration.map((group) => group.properties));
        const rttKeys = Object.keys(properties).filter((key) => key.startsWith("emberprobe.rtt."));
        // VS Code answers a setting without a default with its type's empty value, such as 0 for an integer.
        assert.deepStrictEqual(
            rttKeys.filter((key) => !("default" in properties[key])),
            [],
            "every RTT setting names the value an unset setting reads as"
        );
        const user = { "rtt.controlBlockAddress": "0x24000000" };
        const read = (name) => (name in user ? user[name] : properties[`emberprobe.${name}`].default);
        const vscode = { workspace: { getConfiguration: () => ({ get: read }) } };

        const host = fakeHost();
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const { controller } = makeController(host, { vscode, rttSettings: undefined });
        await controller.start();
        const start = managed.calls.find((call) => call.operation === "start");
        assert.strictEqual(start.pollingIntervalMs, 10);
        assert.strictEqual(controller.status().pollingIntervalMs, 10);
        assert.strictEqual(controller.status().state, "running");
        await controller.stop();
        user["rtt.pollingIntervalMs"] = 0;
        await controller.start();
        assert.strictEqual(managed.calls.filter((call) => call.operation === "start").at(-1).pollingIntervalMs, 100);
        assert.strictEqual(controller.status().configuredPollingIntervalMs, 0);
        await controller.stop();

        user["rtt.pollingIntervalMs"] = 20;
        const set = fakeHost();
        const configured = fakeHostSession();
        set.debugLaunch.managedServer = configured.session;
        const { controller: tuned } = makeController(set, { vscode, rttSettings: undefined });
        await tuned.start();
        assert.strictEqual(configured.calls.find((call) => call.operation === "start").pollingIntervalMs, 20);
        await tuned.stop();
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
        "a channel that keeps losing its connection re-attaches once, then stops; a good connection resets the budget",
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
            const starts = () => managed.calls.filter((call) => call.operation === "start").length;
            const exhaust = async () => {
                for (let round = 0; round < 21; round++) {
                    sockets.at(-1).emit("close");
                    await clock.advance(400);
                }
                await flushQueue(controller);
            };
            assert.strictEqual(starts(), 1);
            await exhaust();
            assert.strictEqual(controller.status().state, "running", "the first exhaustion re-attaches");
            assert.strictEqual(controller.status().error, null);
            assert.strictEqual(starts(), 2, "the re-attachment starts RTT and its servers again");
            await exhaust();
            assert.strictEqual(controller.status().state, "stopped", "a second exhaustion ends RTT visibly");
            assert.strictEqual(controller.status().error.code, "RTT_CHANNEL_DISCONNECTED");
            assert.strictEqual(controller.status().recovery.reason, "channel-lost");
        }
    );

    // A target whose channel 0 telemetry the test scripts; data sockets come from `sockets`.
    function stallFixture({ pollingIntervalMs, own = false } = {}) {
        const target = { readOffset: 0, usedBytes: 0 };
        const gate = { hold: null }; // A promise here keeps the next snapshot waiting, like a busy OpenOCD.
        const snapshot = async () => {
            if (gate.hold) await gate.hold;
            return {
                snapshot: {
                    channels: [{ index: 0, flags: 2, mode: "block", size: 1024, capacity: 1023, ...target }]
                }
            };
        };
        const host = fakeHost();
        const clock = new FakeClock();
        const sockets = [];
        const order = [];
        const { controller } = makeController(host, {
            clock,
            net: {
                connect: () => {
                    const socket = idleSocket();
                    sockets.push(socket);
                    return socket;
                }
            },
            rttSettings: () => ({ controlBlockAddress: "0x24000000", pollingIntervalMs })
        });
        let calls;
        if (own) {
            calls = [];
            controller._ManagedOpenOcdSession = ownSessionClass(order, {
                rttControl: async (request) => {
                    calls.push(request);
                    if (request.operation === "snapshot") return snapshot();
                    if (request.operation === "start" || request.operation === "channels")
                        return { channels: oneChannel };
                    return {};
                }
            });
        } else {
            const managed = fakeHostSession();
            host.debugLaunch.managedServer = managed.session;
            const base = managed.session.rttControl;
            managed.session.rttControl = async (request) => {
                if (request.operation !== "snapshot") return base(request);
                managed.calls.push(request);
                return snapshot();
            };
            calls = managed.calls;
        }
        // One telemetry sample per second.
        const sample = async (count = 1) => {
            for (let i = 0; i < count; i++) {
                await clock.advance(1000);
                await flushQueue(controller);
            }
        };
        const starts = () => calls.filter((call) => call.operation === "start").length;
        return { host, controller, target, gate, sockets, order, sample, starts, calls: () => calls };
    }

    await scenario("target data nobody reads restarts RTT once on the same session, then stops", async () => {
        const { controller, target, sockets, sample, starts, calls } = stallFixture();
        await controller.start();
        sockets[0].emit("connect");
        target.usedBytes = 120;
        await sample(3);
        assert.strictEqual(starts(), 1, "three quiet samples are not yet a stall");
        await sample();
        assert.strictEqual(starts(), 2, "the fourth quiet sample restarts RTT");
        const restart = calls()
            .map((call) => call.operation)
            .slice(calls().findIndex((call) => call.operation === "start") + 1);
        assert.ok(
            restart.indexOf("stop") !== -1 && restart.indexOf("stop") < restart.lastIndexOf("start"),
            "rtt stop precedes the new rtt start, so OpenOCD registers its poll again"
        );
        const status = controller.status();
        assert.strictEqual(status.state, "running");
        assert.strictEqual(status.source, "debug-server");
        assert.deepStrictEqual(status.recovery, { reason: "stalled", channel: 0, at: status.recovery.at });
        assert.strictEqual(status.buffers[0].generation, 2, "the restart starts a new buffer generation");
        await sample(4);
        assert.strictEqual(controller.status().state, "stopped", "a second stall with no byte in between ends RTT");
        assert.strictEqual(controller.status().error.code, "RTT_STREAM_STALLED");
        assert.strictEqual(starts(), 2);
    });

    await scenario("progress, an empty target buffer or new bytes keep the stream alive", async () => {
        const { controller, target, sockets, sample, starts } = stallFixture();
        await controller.start();
        sockets[0].emit("connect");
        target.usedBytes = 120;
        for (let i = 0; i < 6; i++) {
            target.readOffset += 10; // OpenOCD reads, even if the host saw nothing yet.
            await sample();
        }
        target.usedBytes = 0; // A quiet firmware with nothing waiting.
        await sample(6);
        target.usedBytes = 120;
        for (let i = 0; i < 6; i++) {
            sockets.at(-1).emit("data", Buffer.from("x"));
            await sample();
        }
        assert.strictEqual(starts(), 1, "none of these is a stall");
        await sample(4);
        assert.strictEqual(starts(), 2);
        sockets.at(-1).emit("connect");
        sockets.at(-1).emit("data", Buffer.from("back"));
        await sample(4);
        assert.strictEqual(controller.status().state, "running", "bytes after a restart renew its budget");
        assert.strictEqual(starts(), 3);
        await controller.stop();
        assert.strictEqual(controller.status().recovery.reason, "stalled");
        await controller.start();
        assert.strictEqual(controller.status().recovery, null, "a new start clears the last recovery");
        await controller.stop();
    });

    await scenario("time alone is not a stall: OpenOCD busy between two samples polls nothing either", async () => {
        const { controller, target, gate, sockets, sample, starts } = stallFixture();
        await controller.start();
        sockets[0].emit("connect");
        target.usedBytes = 120;
        await sample();
        let release;
        gate.hold = new Promise((resolve) => {
            release = resolve;
        });
        await sample(5);
        gate.hold = null;
        release();
        await sample();
        assert.strictEqual(starts(), 1, "two quiet samples five seconds apart are not enough");
        await sample();
        assert.strictEqual(starts(), 2, "the third quiet sample after the busy spell is");
        await controller.stop();
    });

    await scenario("a slow polling interval needs a longer quiet period", async () => {
        const { controller, target, sockets, sample, starts } = stallFixture({ pollingIntervalMs: 2000 });
        await controller.start();
        sockets[0].emit("connect");
        target.usedBytes = 120;
        await sample(8);
        assert.strictEqual(starts(), 1, "four polls of 2 s have not passed since the first quiet sample");
        await sample();
        assert.strictEqual(starts(), 2);
        await controller.stop();
    });

    await scenario("a stall restart keeps the owned session and its lease", async () => {
        const { host, controller, target, sockets, order, sample, starts } = stallFixture({ own: true });
        await controller.start();
        sockets[0].emit("connect");
        target.usedBytes = 120;
        await sample(4);
        assert.strictEqual(starts(), 2);
        assert.deepStrictEqual(
            order.map((entry) => entry.type),
            ["ownStart"],
            "the OpenOCD process is not restarted"
        );
        assert.strictEqual(host._probeCoordinator.isActive("rtt"), true);
        assert.strictEqual(controller.status().source, "own-session");
        await controller.stop();
        assert.strictEqual(host._probeCoordinator.isActive("rtt"), false);
    });

    await scenario("down-channel input goes to the connected channel socket", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const writes = [];
        const sockets = [writableSocket(writes)];
        const { controller } = makeController(host, { net: { connect: () => sockets[0] } });
        await controller.start();
        assert.throws(() => controller.write(0, "early\n"), /no data connection/);
        sockets[0].emit("connect");
        assert.strictEqual(controller.write(0, "line\n"), 5);
        assert.deepStrictEqual(writes, [Buffer.from("line\n")]);
        assert.throws(() => controller.write(4, "x\n"), /no data connection/);
        assert.strictEqual(controller.write(0, ""), 0, "an empty write sends nothing");
        assert.strictEqual(writes.length, 1);
        await controller.stop();
        assert.throws(() => controller.write(0, "late\n"), /RTT is stopped/);
    });

    await scenario("oversized input is refused before it reaches the socket", async () => {
        const host = fakeHost();
        const managed = fakeHostSession();
        host.debugLaunch.managedServer = managed.session;
        const writes = [];
        const socket = writableSocket(writes);
        const { controller } = makeController(host, { net: { connect: () => socket } });
        await controller.start();
        socket.emit("connect");
        assert.throws(() => controller.write(0, "x".repeat(2049)), /limited to/);
        assert.deepStrictEqual(writes, [], "nothing is written when the input is refused");
        await controller.stop();
    });

    await scenario("selected channels preserve firmware numbers and reject invalid selections", async () => {
        const host = fakeHost();
        const managed = fakeHostSession({
            channels: {
                up: [oneChannel.up[0], { ...oneChannel.up[0], index: 2 }],
                down: []
            }
        });
        host.debugLaunch.managedServer = managed.session;
        const tooMany = Array.from({ length: 17 }, (_, index) => index);
        for (const selection of [[2], [], [256], ["0"], tooMany]) {
            const { controller } = makeController(host, {
                rttSettings: () => ({ controlBlockAddress: "0x24000000", channels: selection }),
                net: { connect: () => idleSocket() }
            });
            if (selection[0] === 2) {
                await controller.start();
                assert.deepStrictEqual(
                    controller.status().channels.up.map((channel) => channel.index),
                    [2]
                );
                assert.strictEqual(controller.status().servers[0].channel, 2);
            } else {
                await assert.rejects(controller.start(), (error) => error.code === "RTT_INVALID_CHANNELS");
                assert.strictEqual(controller.state, "stopped");
            }
            await controller.stop();
        }
    });

    await scenario("a selected channel the firmware adds late is waited for, then reported", async () => {
        const host = fakeHost();
        const late = { up: [{ ...oneChannel.up[0], index: 7 }], down: [] };
        const managed = fakeHostSession({ channels: (calls) => (calls >= 3 ? late : oneChannel) });
        host.debugLaunch.managedServer = managed.session;
        const clock = new FakeClock();
        const options = { clock, net: { connect: () => idleSocket() } };
        const settings = () => ({ controlBlockAddress: "0x24000000", channels: [7] });
        const { controller } = makeController(host, { ...options, rttSettings: settings });
        await controller.start();
        assert.strictEqual(controller.state, "starting", "an unconfigured selection retries instead of failing");
        await clock.advance(2000);
        await flushQueue(controller);
        assert.strictEqual(controller.state, "running");
        await controller.stop();

        const never = fakeHost();
        never.debugLaunch.managedServer = fakeHostSession({ channels: oneChannel }).session;
        const { controller: exhausted } = makeController(never, { ...options, rttSettings: settings });
        await exhausted.start();
        await clock.advance(60000);
        await flushQueue(exhausted);
        assert.strictEqual(exhausted.status().error.code, "RTT_UNKNOWN_CHANNEL");
    });

    await scenario("a partly configured selection runs and names what is missing", async () => {
        const host = fakeHost();
        const twoUp = { up: [oneChannel.up[0], { ...oneChannel.up[0], index: 2 }], down: [] };
        host.debugLaunch.managedServer = fakeHostSession({ channels: twoUp }).session;
        const { controller } = makeController(host, {
            rttSettings: () => ({ controlBlockAddress: "0x24000000", channels: [2, 5] }),
            net: { connect: () => idleSocket() }
        });
        await controller.start();
        assert.strictEqual(controller.state, "running");
        assert.deepStrictEqual(controller.status().missingChannels, [5]);
        const listed = twoUp.up.map(({ index, name, size }) => ({ index, name, size }));
        assert.deepStrictEqual(controller.status().firmwareChannels, listed, "every listed channel, read or not");
        await controller.stop();
        assert.deepStrictEqual(controller.status().missingChannels, []);
        assert.deepStrictEqual(controller.status().firmwareChannels, listed, "the picker keeps them after stop");
    });

    await scenario("a shared host busy for one transaction does not fail the start", async () => {
        const host = fakeHost();
        const managed = fakeHostSession({ channels: oneChannel });
        const rttControl = managed.session.rttControl;
        let busy = 2;
        managed.session.rttControl = (request) => {
            if (request.operation === "start" && busy-- > 0)
                return Promise.reject(
                    Object.assign(new Error("busy"), { code: "LIVE_READ_CANCELLED", retryable: false })
                );
            return rttControl.call(managed.session, request);
        };
        host.debugLaunch.managedServer = managed.session;
        const clock = new FakeClock();
        const { controller } = makeController(host, {
            clock,
            rttSettings: () => ({ controlBlockAddress: "0x24000000", channels: [0] }),
            net: { connect: () => idleSocket() }
        });
        await controller.start();
        await clock.advance(1000);
        await flushQueue(controller);
        assert.strictEqual(controller.state, "running");
        await controller.stop();
    });

    await scenario("re-attaching and a user stop leave no stale yield or error behind", async () => {
        const host = fakeHost();
        host.debugLaunch.managedServer = fakeHostSession({ channels: oneChannel }).session;
        const { controller } = makeController(host, { net: { connect: () => idleSocket() } });
        await controller.start();
        await controller.yieldForRestart("download");
        assert.strictEqual(controller.status().yieldedFor, "download");
        controller.onSessionsChanged();
        await flushQueue(controller);
        assert.strictEqual(controller.state, "running");
        assert.strictEqual(controller.status().yieldedFor, null);
        controller.error = { code: "RTT_CHANNEL_DISCONNECTED", message: "lost" };
        await controller.stop();
        assert.strictEqual(controller.status().error, null);
    });

    await scenario("input rejects missing down buffers and socket backpressure", async () => {
        const host = fakeHost();
        const managed = fakeHostSession({ channels: { up: oneChannel.up, down: [] } });
        host.debugLaunch.managedServer = managed.session;
        const writes = [];
        const socket = writableSocket(writes);
        const { controller } = makeController(host, { net: { connect: () => socket } });
        await controller.start();
        socket.emit("connect");
        assert.throws(
            () => controller.write(0, "x"),
            (error) => error.code === "RTT_INPUT_UNAVAILABLE"
        );
        controller.channels.down = oneChannel.down;
        socket.writableNeedDrain = true;
        assert.throws(
            () => controller.write(0, "x"),
            (error) => error.code === "RTT_INPUT_BUSY"
        );
        assert.deepStrictEqual(writes, []);
        await controller.stop();
    });
    await scenario("stop drains unread terminal data before destroying the attachment", async () => {
        const host = fakeHost();
        host.debugLaunch.managedServer = fakeHostSession().session;
        const socket = writableSocket();
        let drained;
        const { controller } = makeController(host, {
            net: { connect: () => socket },
            onBeforeStop: () => {
                drained = controller.read(0).data.toString();
            }
        });
        await controller.start();
        socket.emit("connect");
        socket.emit("data", Buffer.from("last line\n"));
        await controller.stop();
        assert.strictEqual(drained, "last line\n");
        assert.strictEqual(socket.destroyed, true);
    });
    console.log("RTT controller tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
