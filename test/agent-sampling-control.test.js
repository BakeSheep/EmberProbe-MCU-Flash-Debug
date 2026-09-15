"use strict";
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
        ["--start", "--interval", "19"],
        ["--start", "--interval", "10001"],
        ["--start", "--interval", "20.5"],
        ["--start", "--interval", "NaN"],
        ["--workspace"],
        ["--unknown"]
    ])
        assert.throws(() => args(invalid));
    assert.deepStrictEqual(args(["--start", "--interval", "250"]).params, { intervalMs: 250 });

    const { provider: p, sidebar, chart } = fixture();
    assert.strictEqual((await p._controlAgentSampling("status")).running, false);
    assert.strictEqual(sidebar.length, 0, "status queries must not mutate UI state");
    for (const params of [null, [], "bad", { intervalMs: "100" }, { intervalMs: 0 }, { variables: [] }])
        await assert.rejects(p._controlAgentSampling("start", params), { code: "INVALID_PARAMS" });
    await assert.rejects(p._controlAgentSampling("stop", { intervalMs: 100 }), { code: "INVALID_PARAMS" });
    assert.strictEqual(p._samplingIntent, false);

    const started = await p._controlAgentSampling("start", { intervalMs: 250 });
    assert.strictEqual(started.running, true);
    assert.strictEqual(started.canRead, true);
    assert.strictEqual(started.intervalMs, 250);
    assert.strictEqual(sidebar.at(-1).running, started.running);
    assert.deepStrictEqual(sidebar, chart, "sidebar and chart receive identical shared status and interval changes");
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
    assert.strictEqual(sidebar.at(-1).running, false);
    assert.deepStrictEqual(sidebar, chart);
    await p._controlAgentSampling("stop");

    const busy = p._probeCoordinator.acquire("download");
    await assert.rejects(p._controlAgentSampling("start"), { i18nKey: "live.downloadRunning" });
    assert.strictEqual(p._samplingIntent, false);
    busy.release();
    p._resolveOpenOcdPath = async () => null;
    await assert.rejects(p._controlAgentSampling("start"), { i18nKey: "live.notReady" });
    assert.strictEqual(sidebar.at(-1).error, true);
    assert.strictEqual(p._liveStarting, false);
    await p._controlAgentSampling("stop");

    // Stop during async startup must prevent the late continuation from reopening sampling.
    let resolveExecutable;
    p._resolveOpenOcdPath = () => new Promise((resolve) => (resolveExecutable = resolve));
    const pending = p._controlAgentSampling("start");
    assert.strictEqual((await p._controlAgentSampling("status")).starting, true);
    await p._controlAgentSampling("stop");
    resolveExecutable("fake-openocd");
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
    console.log("Agent sampling control and shared UI state tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
