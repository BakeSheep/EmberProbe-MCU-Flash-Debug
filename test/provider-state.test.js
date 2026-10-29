"use strict";

const { scenario } = require("./helpers/scenario");

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
        setDeliveryHold(held) {
            this.deliveryHold = held;
        }
    }
    const P = loadProvider(
        { debug: {}, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } },
        { "./liveWatch": { LiveWatchSession: Session } }
    );
    const p = Object.create(P.prototype);
    p._probeCoordinator = new ProbeCoordinator();
    p._probeConnectionService = { prepare: async () => ({}) };
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
    const stopping = p.stopLiveWatch();
    pathGate.resolve("fake-openocd");
    await cancelled;
    await stopping;
    assert.strictEqual(sessions.length, 0);
    assert.strictEqual(p._probeCoordinator.anyActive(), false);
    p._resolveOpenOcdPath = async () => "fake-openocd";
    p._samplingCoordinator.setBackpressure(true);
    await p.startLiveWatch();
    const first = sessions[0];
    assert.strictEqual(first.enabled, true, "archive backpressure does not stop Worker sampling");
    assert.strictEqual(first.deliveryHold, true, "it holds delivery until the archive drains");
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
    p._syncSidebarTarget = (_post, skipElf) => {
        assert.strictEqual(skipElf, true, "list edits must not resend the ELF snapshot");
        calls.push("sidebar");
    };
    p._syncGraphTarget = (_entry, skipElf) => {
        assert.strictEqual(skipElf, true);
        calls.push("graph");
    };
    await p._saveWatchList("chart", []);
    assert.deepStrictEqual(calls, ["save", "prune", "prune", "refresh", "sidebar", "graph"]);
    calls.length = 0;
    await p._saveWatchList("mcu.sidebarWriteList", [], { syncSidebar: false });
    assert.deepStrictEqual(calls, ["save", "prune", "prune", "refresh", "graph"], "local edits avoid a sidebar echo");

    await scenario("Cancel pending ELF startup and retain ownership until disconnect is confirmed", async () => {
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
        const { p, sessions, statuses } = providerFixture();
        const elf = deferred();
        p._elfService = { workerPath: "fake", ready: () => elf.promise };
        const starting = p.startLiveWatch();
        await tick();
        const stopping = p.stopLiveWatch();
        elf.resolve();
        await Promise.all([starting, stopping]);
        assert.strictEqual(p._samplingIntent, false);
        assert.strictEqual(sessions.length, 0);
        p._elfService = null;
        await p.startLiveWatch();
        const exit = deferred();
        const live = sessions[0];
        let accepted = 0;
        p._handleRawSamples = () => {
            accepted++;
        };
        await p.startLiveWatch();
        live.events.onSample([], 1);
        assert.strictEqual(accepted, 1, "refreshing an active watch plan must keep receiving its samples");
        live.stop = () => exit.promise;
        live.events.onDisconnect(Object.assign(Error("USB removed"), { i18nKey: "live.probeDisconnected" }));
        assert.strictEqual(live.enabled, false);
        assert.strictEqual(statuses.at(-1).key, "live.disconnecting");
        live.events.onSample([], 1);
        assert.strictEqual(accepted, 1, "disconnect must discard late samples from the same session");
        assert.strictEqual(p._probeCoordinator.firstActive(), "liveWatch");
        exit.resolve(false);
        await assert.rejects(p._liveStopPromise, { code: "PROBE_EXIT_UNCONFIRMED" });
        assert.strictEqual(statuses.at(-1).key, "live.exitUnconfirmed");
        assert.strictEqual(p._liveSession, live);
        live.stop = async () => true;
        await p.stopLiveWatch();
        assert.strictEqual(p._probeCoordinator.anyActive(), false);
    });

    console.log("Provider cancellation, stale events and list synchronization tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
