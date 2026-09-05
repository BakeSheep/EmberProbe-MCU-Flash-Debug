"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { DebugLifecycle } = require("../src/services/debugLifecycle");
function deferred() {
    let resolve;
    return {
        promise: new Promise((done) => {
            resolve = done;
        }),
        resolve: (value) => resolve(value)
    };
}
(async () => {
    const sessions = [];
    class Session {
        constructor(_vscode, _options, events) {
            this.events = events;
            this.stops = 0;
            sessions.push(this);
        }
        setWatch() {}
        async start() {}
        async stop() {
            this.stops++;
        }
        setSamplingEnabled(value) {
            this.enabled = value;
        }
    }
    const P = loadProvider(
        { debug: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
        { "./liveWatch": { LiveWatchSession: Session } }
    );
    const p = Object.create(P.prototype);
    p._probeCoordinator = new ProbeCoordinator();
    p._samplingCoordinator = new SamplingCoordinator();
    p._debugLifecycle = new DebugLifecycle();
    p._chipInfoService = { running: false };
    p._debugBridge = { setIntent: () => {} };
    p._context = { workspaceState: { get: () => "configured" } };
    p._activeReadPlan = () => [{ name: "tick", address: 0x20000000, size: 4 }];
    p._liveConsumers = new Set();
    p._setLiveInterval = () => {};
    p._commandContext = () => ({});
    p._t = (key) => key;
    let samples = 0,
        statuses = 0;
    p._handleRawSamples = () => samples++;
    p._postConsumerStatuses = () => statuses++;
    p._postLive = () => statuses++;
    p._resolveTclPort = async () => 1234;
    const pathGate = deferred();
    p._resolveOpenOcdPath = () => pathGate.promise;
    const cancelled = p.startLiveWatch();
    assert.strictEqual(p._probeCoordinator.firstActive(), "liveStart");
    p.stopLiveWatch();
    pathGate.resolve("fake-openocd");
    await cancelled;
    assert.strictEqual(sessions.length, 0);
    assert.strictEqual(p._probeCoordinator.anyActive(), false);
    p._resolveOpenOcdPath = async () => "fake-openocd";
    p._samplingCoordinator.setBackpressure(true);
    await p.startLiveWatch();
    const first = sessions[0];
    assert.strictEqual(first.enabled, false);
    assert.strictEqual(p._probeCoordinator.firstActive(), "liveWatch");
    await p.stopLiveWatch();
    await p.startLiveWatch();
    const count = statuses;
    first.events.onSample([], 1);
    first.events.onStatus({});
    first.events.onError("stale");
    first.events.onDisconnect(Error("old"));
    assert.strictEqual(samples, 0);
    assert.strictEqual(statuses, count);
    assert.strictEqual(p._liveSession, sessions[1]);
    await p.stopLiveWatch();
    assert.strictEqual(p._probeCoordinator.anyActive(), false);
    // Every list update goes through invalidation, pruning, plan refresh and panel synchronization.
    const calls = [];
    p._watchLists = { save: async () => calls.push("save") };
    p._latestSidebarSamples = new Map();
    p._livePanels = new Map([["panel", { watchKey: "chart", latestSamples: new Map() }]]);
    p._pruneSampleMap = () => calls.push("prune");
    p._refreshSamplingPlan = async () => calls.push("refresh");
    p._syncSidebarTarget = () => calls.push("sidebar");
    p._syncGraphTarget = () => calls.push("graph");
    await p._saveWatchList("chart", []);
    assert.deepStrictEqual(calls, ["save", "prune", "prune", "refresh", "sidebar", "graph"]);
    console.log("Provider cancellation, stale events and list synchronization tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
