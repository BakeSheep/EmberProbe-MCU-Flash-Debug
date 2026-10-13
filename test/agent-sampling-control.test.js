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
    const Provider = loadProvider(vscode, { "./liveWatch": { LiveWatchSession: Session } });
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
        _samplingIntent: false,
        _liveIntervalMs: 100,
        _liveConsumers: new Set(),
        _livePanels: new Map([["chart", { post: (message) => chart.push(message) }]]),
        _webviewView: { webview: { postMessage: (message) => sidebar.push(message) } },
        _activeReadPlan: () => [{ name: "tick", address: 0x20000000, size: 4 }],
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
    assert.strictEqual((await p._controlAgentSampling("status")).running, false);
    assert.strictEqual(sidebar.length, 0, "status queries must not mutate UI state");
    for (const params of [null, [], "bad", { intervalMs: "100" }, { intervalMs: 0 }, { variables: [] }])
        await assert.rejects(p._controlAgentSampling("start", params), { code: "INVALID_PARAMS" });
    await assert.rejects(p._controlAgentSampling("stop", { intervalMs: 100 }), { code: "INVALID_PARAMS" });
    assert.strictEqual(p._samplingIntent, false);

    const started = await p._controlAgentSampling("start", { intervalMs: 250 });
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
    const session = p._liveSession;
    await p._controlAgentSampling("start");
    assert.strictEqual(p._liveSession, session, "repeated start reuses the connection");
    assert.strictEqual(session.intervalMs, 250);
    p._setSamplingArchiveBackpressure(true);
    assert.strictEqual((await p._controlAgentSampling("status")).canRead, false);
    p._setSamplingArchiveBackpressure(false);

    // A user stop is reflected in Agent queries; an Agent stop is reflected in both UIs.
    await p.stopLiveWatch();
    assert.strictEqual((await p._controlAgentSampling("status")).running, false);
    await p.startLiveWatch(undefined, 300, "sidebar");
    assert.strictEqual((await p._controlAgentSampling("status")).intervalMs, 300);
    const userSession = p._liveSession;
    const stopped = await p._controlAgentSampling("stop");
    assert.strictEqual(userSession.stopped, true, "stop response waits for connection cleanup");
    assert.strictEqual(stopped.running, false);
    assert.strictEqual(sidebar.filter((message) => message.type === "liveStatus").at(-1).running, false);
    assert.strictEqual(
        sidebar.filter((message) => message.type === "liveStatus").at(-1).intentEnabled,
        chart.at(-1).intentEnabled
    );
    await p._controlAgentSampling("stop");

    const busy = p._probeCoordinator.acquire("download");
    await assert.rejects(p._controlAgentSampling("start"), { i18nKey: "live.downloadRunning" });
    assert.strictEqual(p._samplingIntent, false);
    busy.release();
    p._resolveOpenOcdPath = async () => null;
    await assert.rejects(p._controlAgentSampling("start"), { i18nKey: "live.notReady" });
    assert.strictEqual(sidebar.filter((message) => message.type === "liveStatus").at(-1).error, true);
    assert.strictEqual(p._liveStarting, false);
    await p._controlAgentSampling("stop");

    // Stop during async startup must prevent the late continuation from reopening sampling.
    let resolveExecutable;
    p._resolveOpenOcdPath = () => new Promise((resolve) => (resolveExecutable = resolve));
    const pending = p._controlAgentSampling("start");
    assert.strictEqual((await p._controlAgentSampling("status")).starting, true);
    const cancelling = p._controlAgentSampling("stop");
    assert.strictEqual(p._liveStarting, true, "startup keeps its reservation until cancellation settles");
    resolveExecutable("fake-openocd");
    await cancelling;
    assert.strictEqual((await pending).running, false);
    assert.strictEqual(p._liveWatchRunning, false);

    const { provider: q } = fixture();
    q._activeReadPlan = () => [];
    const empty = await q._controlAgentSampling("start");
    assert.strictEqual(empty.intentEnabled, true);
    assert.strictEqual(empty.canRead, false, "empty watch lists do not claim acquisition");
    await q._controlAgentSampling("stop");
    q._agentReadLease = q._probeCoordinator.acquire("agentRead");
    const temporary = (q._agentReadSession = new Session());
    q._postAgentSampling(true, "live.agentSampling");
    await q._controlAgentSampling("stop");
    assert.strictEqual(temporary.stopped, true);
    assert.strictEqual(q._agentReadRunning, false);
    assert.strictEqual(q._agentSamplingStatus, null);

    // Shared debugging stays alive while Agent disables acquisition and clears restart intent.
    q._debugBridge.hasSession = true;
    q._managedDebugServer = {
        samplingEnabled: true,
        setSamplingEnabled(value) {
            this.samplingEnabled = value;
            return value;
        }
    };
    await q._controlAgentSampling("start");
    await q._controlAgentSampling("stop");
    assert.strictEqual(q._debugBridge.hasSession, true);
    assert.strictEqual(q._debugBridge.intentEnabled, false);
    assert.strictEqual(q._managedDebugServer.samplingEnabled, false);
    assert.strictEqual((await q._controlAgentSampling("status")).running, false);

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
                constructor(_vscode, _options, events) {
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
                { "./liveWatch": { LiveWatchSession: Session } }
            );
            const p = Object.create(P.prototype);
            Object.assign(p, {
                _probeCoordinator: new ProbeCoordinator(),
                _samplingCoordinator: new SamplingCoordinator(),
                _debugLifecycle: new DebugLifecycle(),
                _probeConnectionService: { prepare: async () => ({}) },
                _debugBridge: { setIntent() {}, agentStatus: () => ({ state: "inactive" }) },
                _context: { workspaceState: { get: () => "configured" } },
                _liveConsumers: new Set(),
                _activeReadPlan: () => [{ name: "tick", address: 0x20000000, size: 4 }],
                _setLiveInterval() {},
                _commandContext: () => ({}),
                _t: (key) => key,
                _resolveTclPort: async () => 1234,
                _resolveOpenOcdPath: async () => "fake",
                _postConsumerStatuses: (status) => statuses.push(status),
                _postLive() {},
                _postAgentSampling() {},
                _handleRawSamples: () => {
                    throw Error("Late sample accepted");
                }
            });
            return { p, sessions, statuses };
        }
        for (const phase of ["prepare", "port"]) {
            const fixture = providerFixture(),
                gate = deferred();
            if (phase === "prepare") fixture.p._probeConnectionService.prepare = () => gate.promise;
            else fixture.p._resolveTclPort = () => gate.promise;
            const read = fixture.p._withAgentProbe(async () => {
                throw Error("Cancelled handler ran");
            });
            const rejected = assert.rejects(read, { code: "AGENT_READ_CANCELLED" });
            await tick();
            const cancelled = fixture.p.stopAgentReadIfRunning();
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
                setSamplingEnabled(value) {
                    this.samplingEnabled = value;
                    return value;
                }
            };
            const status = () => sampling.status({ intent: true, bridge, managedServer: server });
            assert.strictEqual(status().mode, "debug-running-sampling");
            sampling.setBackpressure(true);
            sampling.setDebugIntent(bridge, true);
            sampling.setRuntimeEnabled(server, true, bridge);
            assert.strictEqual(bridge.intentEnabled, false);
            assert.strictEqual(server.samplingEnabled, false);
            sampling.setDebugIntent(bridge, true);
            assert.strictEqual(bridge.intentEnabled, false);
            assert.strictEqual(status().canRead, false);
            sampling.setBackpressure(false);
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

    console.log("Agent sampling control and shared UI state tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
