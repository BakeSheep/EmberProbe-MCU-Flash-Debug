"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { args } = require("../skills/mcu-variables/scripts/sampling");

class Session {
    constructor() {
        this.stopped = false;
    }
    setWatch(items) {
        this.items = items;
    }
    setIntervalMs(value) {
        this.intervalMs = value;
    }
    setSamplingEnabled(value) {
        this.enabled = value;
    }
    async start() {}
    async stop() {
        await Promise.resolve();
        this.stopped = true;
    }
}

function fixture() {
    const vscode = {
        debug: {},
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }
    };
    const Provider = loadProvider(vscode, { "./liveWatch": { ManagedOpenOcdSession: Session } });
    const provider = Object.create(Provider.prototype);
    const sidebar = [],
        chart = [];
    Object.assign(provider, {
        _context: { workspaceState: { get: () => "configured" } },
        _probeCoordinator: new ProbeCoordinator(),
        _samplingCoordinator: new SamplingCoordinator(),
        _debugBridge: {
            hasSession: false,
            setIntent(value) {
                this.intentEnabled = value;
            },
            status() {
                return { mode: "debug-running-waiting", canRead: false, source: "dap" };
            }
        },
        _livePanels: new Map([["chart", { post: (message) => chart.push(message) }]]),
        _webviewView: { webview: { postMessage: (message) => sidebar.push(message) } },
        _resolveOpenOcdPath: async () => "fake-openocd",
        _probeConnectionService: {
            prepare: async (_options, interactive) => {
                provider.lastInteractive = interactive;
                return { probeSerial: "1234", adapterSpeedKhz: 100 };
            }
        },
        _resolveTclPort: async () => 6666,
        _commandContext: () => ({}),
        _t: (key) => key
    });
    Object.assign(provider._sampling, { intent: false, intervalMs: 100, consumers: new Set() });
    Object.assign(provider._sampling, { activeReadPlan: () => [{ name: "tick", address: 0x20000000, size: 4 }] });
    return { provider, sidebar, chart };
}

(async () => {
    for (const invalid of [
        [],
        ["--start", "--stop"],
        ["--start", "--start"],
        ["--status", "--interval", "100"],
        ["--start", "--interval", "4"],
        ["--start", "--interval", "10001"],
        ["--start", "--interval", "5.5"],
        ["--start", "--interval", "NaN"],
        ["--workspace"],
        ["--unknown"]
    ])
        assert.throws(() => args(invalid));
    assert.deepStrictEqual(args(["--start", "--interval", "5"]).params, { intervalMs: 5 });
    assert.deepStrictEqual(args(["--start", "--interval", "250"]).params, { intervalMs: 250 });

    const { provider: p, sidebar, chart } = fixture();
    assert.strictEqual((await p._agentOps.controlSampling("status")).running, false);
    assert.strictEqual(sidebar.length, 0, "status queries must not mutate UI state");
    for (const params of [null, [], "bad", { intervalMs: "100" }, { intervalMs: 0 }, { variables: [] }])
        await assert.rejects(p._agentOps.controlSampling("start", params), { code: "INVALID_PARAMS" });
    await assert.rejects(p._agentOps.controlSampling("stop", { intervalMs: 100 }), { code: "INVALID_PARAMS" });
    assert.strictEqual(p._sampling.intent, false);

    const started = await p._agentOps.controlSampling("start", { intervalMs: 250 });
    assert.strictEqual(p.lastInteractive, false, "Agent sampling must not prompt");
    assert.strictEqual(started.running, true);
    assert.strictEqual(started.canRead, true);
    assert.strictEqual(started.intervalMs, 250);
    assert.strictEqual(sidebar.filter((message) => message.type === "liveStatus").at(-1).running, started.running);
    assert.strictEqual(
        sidebar.filter((message) => message.type === "liveStatus").at(-1).frequencyHz,
        20,
        "sidebar target is independent of the waveform target"
    );
    assert.strictEqual(chart.at(-1).frequencyHz, 4);
    const session = p._sampling.session;
    await p._agentOps.controlSampling("start");
    assert.strictEqual(p._sampling.session, session, "repeated start reuses the connection");
    assert.strictEqual(session.intervalMs, 250);
    p._sampling.setArchiveBackpressure(true);
    assert.strictEqual((await p._agentOps.controlSampling("status")).canRead, false);
    p._sampling.setArchiveBackpressure(false);

    // A user stop is reflected in Agent queries; an Agent stop is reflected in both UIs.
    await p._sampling.stop();
    assert.strictEqual((await p._agentOps.controlSampling("status")).running, false);
    await p._sampling.start(undefined, 300, "sidebar");
    assert.strictEqual((await p._agentOps.controlSampling("status")).intervalMs, 300);
    const userSession = p._sampling.session;
    const stopped = await p._agentOps.controlSampling("stop");
    assert.strictEqual(userSession.stopped, true, "stop response waits for connection cleanup");
    assert.strictEqual(stopped.running, false);
    assert.strictEqual(sidebar.filter((message) => message.type === "liveStatus").at(-1).running, false);
    assert.strictEqual(
        sidebar.filter((message) => message.type === "liveStatus").at(-1).intentEnabled,
        chart.at(-1).intentEnabled
    );
    await p._agentOps.controlSampling("stop");

    const busy = p._probeCoordinator.acquire("download");
    await assert.rejects(p._agentOps.controlSampling("start"), { i18nKey: "live.downloadRunning" });
    assert.strictEqual(p._sampling.intent, false);
    busy.release();
    p._resolveOpenOcdPath = async () => null;
    await assert.rejects(p._agentOps.controlSampling("start"), { i18nKey: "live.notReady" });
    assert.strictEqual(sidebar.filter((message) => message.type === "liveStatus").at(-1).error, true);
    assert.strictEqual(p._sampling.starting, false);
    await p._agentOps.controlSampling("stop");

    // Stop during async startup must prevent the late continuation from reopening sampling.
    let resolveExecutable;
    p._resolveOpenOcdPath = () => new Promise((resolve) => (resolveExecutable = resolve));
    const pending = p._agentOps.controlSampling("start");
    assert.strictEqual((await p._agentOps.controlSampling("status")).starting, true);
    const cancelling = p._agentOps.controlSampling("stop");
    assert.strictEqual(p._sampling.starting, true, "startup keeps its reservation until cancellation settles");
    resolveExecutable("fake-openocd");
    await cancelling;
    assert.strictEqual((await pending).running, false);
    assert.strictEqual(p._sampling.running, false);

    const { provider: q } = fixture();
    q._sampling.activeReadPlan = () => [];
    const empty = await q._agentOps.controlSampling("start");
    assert.strictEqual(empty.intentEnabled, true);
    assert.strictEqual(empty.canRead, false, "empty watch lists do not claim acquisition");
    await q._agentOps.controlSampling("stop");
    q._agentOps._readLease = q._probeCoordinator.acquire("agentRead");
    const temporary = (q._agentOps.readSession = new Session());
    q._agentOps._postSampling(true, "live.agentSampling");
    await q._agentOps.controlSampling("stop");
    assert.strictEqual(temporary.stopped, true);
    assert.strictEqual(q._agentOps.readRunning, false);
    assert.strictEqual(q._agentOps._samplingStatus, null);

    // Shared debugging stays alive while Agent disables acquisition and clears restart intent.
    q._debugBridge.hasSession = true;
    q.debugLaunch.managedServer = {
        samplingEnabled: true,
        setSamplingEnabled(value) {
            this.samplingEnabled = value;
            return value;
        }
    };
    await q._agentOps.controlSampling("start");
    await q._agentOps.controlSampling("stop");
    assert.strictEqual(q._debugBridge.hasSession, true);
    assert.strictEqual(q._debugBridge.intentEnabled, false);
    assert.strictEqual(q.debugLaunch.managedServer.samplingEnabled, false);
    assert.strictEqual((await q._agentOps.controlSampling("status")).running, false);

    await scenario("Cancel Agent reads during connection preparation and port resolution", async () => {
        const { DebugLifecycle } = require("../src/services/debugLifecycle");
        const tick = () => new Promise((resolve) => setImmediate(resolve));
        function deferred() {
            let resolve;
            const promise = new Promise((done) => {
                resolve = done;
            });
            return { promise, resolve };
        }
        function providerFixture() {
            const sessions = [],
                statuses = [];
            class Session {
                constructor(_options, events) {
                    this.events = events;
                    sessions.push(this);
                }
                setWatch() {}
                setSamplingEnabled(value) {
                    this.enabled = value;
                }
                async start() {
                    this.started = true;
                }
                async stop() {
                    return true;
                }
            }
            const P = loadProvider(
                { debug: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
                { "./liveWatch": { ManagedOpenOcdSession: Session } }
            );
            const p = Object.create(P.prototype);
            Object.assign(p, {
                _probeCoordinator: new ProbeCoordinator(),
                _samplingCoordinator: new SamplingCoordinator(),
                _probeConnectionService: { prepare: async () => ({}) },
                _debugBridge: { setIntent() {}, agentStatus: () => ({ state: "inactive" }) },
                _context: { workspaceState: { get: () => "configured" } },
                _commandContext: () => ({}),
                _t: (key) => key,
                _resolveTclPort: async () => 1234,
                _resolveOpenOcdPath: async () => "fake",
                _postConsumerStatuses: (status) => statuses.push(status),
                _postLive() {}
            });
            Object.assign(p._agentOps, { _postSampling() {} });
            Object.assign(p.debugLaunch, { lifecycle: new DebugLifecycle() });
            Object.assign(p._sampling, {
                consumers: new Set(),
                setIntervalMs() {},
                handleRawSamples: () => {
                    throw Error("Late sample accepted");
                }
            });
            Object.assign(p._sampling, { activeReadPlan: () => [{ name: "tick", address: 0x20000000, size: 4 }] });
            return { p, sessions, statuses };
        }
        for (const phase of ["prepare", "port"]) {
            const fixture = providerFixture(),
                gate = deferred();
            if (phase === "prepare") fixture.p._probeConnectionService.prepare = () => gate.promise;
            else fixture.p._resolveTclPort = () => gate.promise;
            const read = fixture.p._agentOps.withProbe(async () => {
                throw Error("Cancelled handler ran");
            });
            const rejected = assert.rejects(read, { code: "AGENT_READ_CANCELLED" });
            await tick();
            const cancelled = fixture.p._agentOps.stopReadIfRunning();
            gate.resolve(phase === "prepare" ? {} : 1234);
            await Promise.all([rejected, cancelled]);
            assert.strictEqual(fixture.sessions.length, 0);
            assert.strictEqual(fixture.p._probeCoordinator.anyActive(), false);
        }
    });

    await scenario("Respect backpressure, pause and continue transitions", async () => {
        const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
        const sampling = new SamplingCoordinator();
        const bridge = new DebugSessionBridge();
        try {
            bridge.sessions.set("session", { id: "session" });
            bridge.intentEnabled = true;
            bridge.capabilities.read = true;
            const server = {
                samplingEnabled: true,
                deliveryHold: false,
                setSamplingEnabled(value) {
                    this.samplingEnabled = value;
                    return value;
                },
                setDeliveryHold(held) {
                    this.deliveryHold = held;
                }
            };
            const status = () => sampling.status({ intent: true, bridge, managedServer: server });
            assert.strictEqual(status().mode, "debug-running-sampling");
            sampling.setBackpressure(true);
            sampling.setDebugIntent(bridge, true);
            sampling.setRuntimeEnabled(server, true, bridge);
            assert.strictEqual(bridge.intentEnabled, false, "host-driven DAP sampling still pauses");
            assert.strictEqual(server.samplingEnabled, true, "Worker sampling keeps acquiring under backpressure");
            assert.strictEqual(server.deliveryHold, true, "and holds delivery until the archive drains");
            sampling.setDebugIntent(bridge, true);
            assert.strictEqual(bridge.intentEnabled, false);
            assert.strictEqual(status().canRead, false);
            sampling.setBackpressure(false);
            sampling.setDeliveryHold(server);
            assert.strictEqual(server.deliveryHold, false);
            sampling.setDeliveryHold(null);
            bridge.paused = true;
            assert.strictEqual(sampling.setRuntimeEnabled(server, true, bridge), false);
            bridge.paused = false;
            bridge.transitionKind = "continue";
            assert.strictEqual(sampling.setRuntimeEnabled(server, true, bridge), false);
            bridge.transitionKind = "";
            assert.strictEqual(sampling.setRuntimeEnabled(server, true, bridge), true);
            assert.strictEqual(status().source, "openocd");
            assert.strictEqual(
                sampling.status({ intent: false, bridge: { hasSession: false }, standaloneRunning: false }).mode,
                "stopped"
            );
        } finally {
            bridge.dispose();
        }
    });

    await scenario("Keep concurrent sample interval waits independent", async () => {
        const Provider = loadProvider({ debug: {}, workspace: {} });
        const host = Object.create(Provider.prototype);
        const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve("hung"), ms).unref());
        // Two variables.sample calls sharing a live connection: the shorter wait used to clear the longer one's
        // timer and drop its resolver, leaving the second call pending forever.
        const long = host._agentOps._waitInterval(40).then(() => "done");
        const short = host._agentOps._waitInterval(5).then(() => "done");
        assert.strictEqual(await short, "done");
        assert.strictEqual(await Promise.race([long, timeout(1000)]), "done");

        // Cancelling the temporary-probe read wakes only its own waits.
        const started = Date.now();
        const temporaryRun = { temporary: true, cancelled: false, wake: null };
        const sharedRun = { temporary: false, cancelled: false, wake: null };
        host._agentOps._sampleRuns = new Set([temporaryRun, sharedRun]);
        const temporary = host._agentOps._waitInterval(60000, temporaryRun).then(() => "woken");
        const shared = host._agentOps._waitInterval(30, sharedRun).then(() => Date.now() - started);
        host._agentOps._wakeReadDelays();
        assert.strictEqual(await Promise.race([temporary, timeout(1000)]), "woken");
        assert.ok((await shared) >= 25, "a shared-connection wait keeps its interval");
        assert.strictEqual(sharedRun.cancelled, false);
        assert.strictEqual(temporaryRun.wake, null, "settled waits are not retained");
    });

    await scenario("Count read time inside the variables.sample interval", async () => {
        const Provider = loadProvider({ debug: {}, workspace: {} });
        const host = Object.create(Provider.prototype);
        const waits = [];
        const realNow = Date.now;
        let now = 1000;
        let readMs = 0;
        Date.now = () => now;
        try {
            Object.assign(host, {
                readElfSymbols: () => ({
                    elf: {},
                    symbols: [{ name: "tick", address: 0x20000000, size: 4, watchType: "u32" }]
                })
            });
            Object.assign(host._agentOps, {
                withProbe: (handler) =>
                    handler({
                        session: {
                            readOnce: async () => {
                                now += readMs;
                                readMs = readMs ? 80 : 13;
                                return [];
                            }
                        },
                        source: "live-sampling",
                        temporary: false
                    }),
                _waitInterval: async (ms) => {
                    waits.push(ms);
                    now += ms;
                }
            });
            Object.assign(host._writes, { firmwareConsistency: () => ({}) });
            Object.assign(host._elfView, { prepareLayouts: async () => {} });
            Object.assign(host._sampling, { runtimeReadRanges: () => [] });
            await host._agentOps.sampleVariables({ variables: [{ name: "tick" }], count: 4, intervalMs: 50 });
            assert.deepStrictEqual(waits, [50, 37, 0], "a read longer than the interval does not wait");
        } finally {
            Date.now = realNow;
        }
    });

    await scenario("Stop a variables.sample running on a borrowed connection", async () => {
        const Provider = loadProvider({ debug: {}, workspace: {} });
        const host = Object.create(Provider.prototype);
        let reads = 0;
        const stops = [];
        Object.assign(host, {
            readElfSymbols: () => ({
                elf: {},
                symbols: [{ name: "tick", address: 0x20000000, size: 4, watchType: "u32" }]
            })
            // A live-sampling (or debug server) connection is reused, not a temporary probe session.
        });
        Object.assign(host._agentOps, {
            withProbe: (handler) =>
                handler({
                    session: { readOnce: async () => (reads++, []) },
                    source: "live-sampling",
                    temporary: false
                }),
            stopReadIfRunning: () => (stops.push("agent"), null)
        });
        Object.assign(host._writes, { firmwareConsistency: () => ({}) });
        Object.assign(host._elfView, { prepareLayouts: async () => {} });
        Object.assign(host._sampling, {
            stop: async () => stops.push("live"),
            status: () => ({ running: false }),
            intervalMs: 100
        });
        Object.assign(host._sampling, { runtimeReadRanges: () => [] });
        const sampling = host._agentOps.sampleVariables({
            variables: [{ name: "tick" }],
            count: 1000,
            intervalMs: 60000
        });
        const outcome = sampling.then(
            () => "completed",
            (error) => error.code
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(reads, 1, "the first sample is read before the interval wait");
        await host._agentOps.controlSampling("stop");
        assert.strictEqual(
            await Promise.race([outcome, new Promise((r) => setTimeout(() => r("hung"), 1000).unref())]),
            "AGENT_READ_CANCELLED"
        );
        assert.strictEqual(reads, 1, "no sample is read after the stop");
        assert.deepStrictEqual(stops, ["agent", "live"]);
        assert.strictEqual(host._agentOps._sampleRuns.size, 0);
    });

    console.log("Agent sampling control and shared UI state tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
