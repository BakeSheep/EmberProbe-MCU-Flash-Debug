"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { DebugLifecycle, debugStartupPolicy } = require("../src/services/debugLifecycle");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { ProbeCoordinator } = require("../src/probeCoordinator");
(async () => {
    const timers = [];
    const cancelled = [];
    const lifecycle = new DebugLifecycle({
        schedule: (fn) => {
            timers.push(fn);
            return timers.length;
        },
        cancel: (id) => cancelled.push(id)
    });
    assert.strictEqual(debugStartupPolicy("win32", "1.12.1").timeoutMs, 15000);
    for (const [platform, version] of [
        ["linux", "1.12.1"],
        ["darwin", "1.12.1"],
        ["win32", "1.12.2"]
    ])
        assert.strictEqual(debugStartupPolicy(platform, version).timeoutMs, 60000);
    let recovered = 0;
    const expired = lifecycle.arm(10, () => {
        recovered++;
        lifecycle.clear();
    });
    timers[0]();
    assert.strictEqual((await expired).kind, "timeout");
    await Promise.resolve();
    assert.strictEqual(recovered, 1);
    const ready = lifecycle.arm(10, () => recovered++);
    lifecycle.session = { id: "current" };
    lifecycle.ready({ id: "old" }, true);
    assert.strictEqual(lifecycle.pending, true);
    lifecycle.ready({ id: "current" }, true);
    assert.strictEqual((await ready).kind, "ready");
    timers[1]();
    assert.strictEqual(recovered, 1);
    const early = lifecycle.arm(10, () => recovered++);
    lifecycle.clear({ kind: "terminated" });
    assert.strictEqual((await early).kind, "terminated");
    const P = loadProvider();
    const p = Object.create(P.prototype);
    p._probeCoordinator = new ProbeCoordinator();
    p._samplingCoordinator = new SamplingCoordinator();
    p._debugBridge = new DebugSessionBridge();
    p._debugLifecycle = lifecycle;
    p._samplingIntent = true;
    p._agentSamplingStatus = null;
    p._managedDebugToken = "token";
    p._managedDebugSessionId = "";
    p._terminatedDebugSessionIds = new Set();
    p._activeReadPlan = () => [];
    p._configureManagedRuntimeWatch = () => [{ name: "tick", address: 0x20000000, size: 4 }];
    p._commandContext = () => ({ folder: { uri: { toString: () => "workspace" } } });
    const server = {
        samplingEnabled: true,
        setSamplingEnabled(value) {
            this.samplingEnabled = value;
            return value;
        }
    };
    p._managedDebugServer = server;
    const session = {
        id: "current",
        type: "cortex-debug",
        configuration: { __emberprobeManagedToken: "token" },
        workspaceFolder: { uri: { toString: () => "workspace" } }
    };
    try {
        p.handleDebugSessionStart(session);
        assert.strictEqual(p._managedDebugSessionId, "current");
        assert.strictEqual(server.samplingEnabled, false);
        p._samplingCoordinator.setRuntimeEnabled(server, true, p._debugBridge);
        const messages = [];
        const entry = { ready: true, watchKey: "watch", post: (m) => messages.push(m), latestSamples: new Map() };
        p._scalarWatchList = () => [];
        p._syncGraphTarget(entry);
        assert.strictEqual(messages.find((m) => m.type === "liveStatus").mode, "debug-running-sampling");
        p._livePanels = new Map();
        p._postConsumerStatuses = () => {};
        p._setSamplingArchiveBackpressure(true);
        await p._refreshSamplingPlan();
        assert.strictEqual(server.samplingEnabled, false);
        assert.strictEqual(p._debugBridge.intentEnabled, false);
        let stopped = 0,
            restored = 0;
        p._stopManagedDebugServer = async () => {
            stopped++;
            p._managedDebugServer = null;
        };
        p.restoreSamplingAfterDebug = async () => restored++;
        await p.handleDebugSessionTerminate(session);
        assert.strictEqual(stopped, 1);
        assert.strictEqual(restored, 1);
        await p.handleDebugSessionTerminate(session);
        p.handleDebugSessionStart(session);
        assert.strictEqual(p._debugBridge.hasAnySession, false);
        assert.strictEqual(stopped, 1);
    } finally {
        p._debugBridge.dispose();
        lifecycle.clear();
    }
    // Preparing external debug must await pending probe cleanup before returning.
    const q = Object.create(P.prototype),
        events = [];
    q._debugBridge = { setWorkspace: () => {} };
    q._commandContext = () => ({});
    q._probeCoordinator = new ProbeCoordinator();
    q._liveSession = {};
    q._postConsumerStatuses = () => {};
    q.stopAgentReadIfRunning = () => Promise.resolve().then(() => events.push("agent-stopped"));
    q.stopLiveWatch = () => Promise.resolve().then(() => events.push("live-stopped"));
    await q.prepareForCortexDebug();
    assert.deepStrictEqual(events, ["agent-stopped", "live-stopped"]);
    console.log("Cortex-Debug lifecycle behavior tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
