"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { loadProvider } = require("./helpers/load-provider");
const { DebugLifecycle } = require("../src/services/debugLifecycle");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { DebugControlService } = require("../src/services/debugControlService");
const { ProbeCoordinator } = require("../src/probeCoordinator");

const ticks = async (count = 10) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Reproduces the real-board ordering: the adapter exits first, so the session leaves the bridge
// (settling debug.stop's state wait) while managed OpenOCD is still stopping and VS Code still
// reports the session as activeDebugSession until its own terminate event arrives later.
function setup() {
    const vscodeDebug = { activeDebugSession: null, terminating: null };
    const P = loadProvider({
        window: { showErrorMessage: () => {} },
        debug: {
            get activeDebugSession() {
                return vscodeDebug.activeDebugSession;
            }
        }
    });
    const p = Object.create(P.prototype);
    const coordinator = new ProbeCoordinator();
    p._probeCoordinator = coordinator;
    p._debugBridge = new DebugSessionBridge();
    p._debugLifecycle = new DebugLifecycle();
    p._terminatedDebugSessionIds = new Set();
    p._debugSessionReleases = new Map();
    p._t = (key) => key;
    let restored = 0;
    p.restoreSamplingAfterDebug = async () => restored++;
    let finishStop;
    const server = {
        stops: 0,
        setSamplingEnabled() {},
        stop() {
            this.stops++;
            return new Promise((resolve, reject) => {
                finishStop = { resolve, reject };
            });
        }
    };
    p._debugServerLease = coordinator.acquire("debugStart").transition("debugServer");
    p._managedDebugServer = server;
    p._managedDebugToken = "token";
    p._managedDebugSessionId = "s1";
    const session = { id: "s1", type: "emberprobe", configuration: { __emberprobeManagedToken: "token" } };
    p._debugBridge.attach(session);
    vscodeDebug.activeDebugSession = session;
    // The adapter-exit tracker runs the terminate handler without awaiting it, as extension.js does.
    const stopDebugging = (target) => {
        vscodeDebug.terminating = p.handleDebugSessionTerminate(target);
        return Promise.resolve(true);
    };
    const service = new DebugControlService({
        vscode: { debug: { stopDebugging } },
        debugBridge: p._debugBridge,
        waitForRelease: (target) => p._debugSessionReleased(target)
    });
    return {
        p,
        coordinator,
        server,
        session,
        service,
        vscodeDebug,
        finishStop: () => finishStop,
        restored: () => restored
    };
}

function track(promise) {
    const state = { settled: false };
    promise.then(
        () => (state.settled = true),
        () => (state.settled = true)
    );
    return state;
}

(async () => {
    await scenario("debug.stop waits for managed OpenOCD and its lease to be released", async () => {
        const { p, coordinator, server, session, service, vscodeDebug, finishStop, restored } = setup();
        const stopping = service.control({ action: "stop" });
        const state = track(stopping);
        await ticks();
        assert.strictEqual(p._debugBridge.allSessions.has(session.id), false, "the session left the bridge");
        assert.strictEqual(server.stops, 1);
        assert.strictEqual(coordinator.isActive("debugServer"), true, "OpenOCD is still stopping");
        assert.strictEqual(state.settled, false, "debug.stop must not resolve while the probe lease is held");
        // VS Code has not cleared activeDebugSession yet, but the torn-down session no longer counts as busy.
        assert.strictEqual(vscodeDebug.activeDebugSession, session);
        assert.strictEqual(p._liveDebugSession(), null);

        finishStop().resolve(true);
        const result = await stopping;
        assert.strictEqual(result.status.state, "none");
        assert.deepStrictEqual(Object.values(coordinator.snapshot()).filter(Boolean), []);
        assert.strictEqual(p._managedDebugServer, null);
        await vscodeDebug.terminating;
        assert.strictEqual(restored(), 1);
        assert.strictEqual(p._debugSessionReleased(session), undefined);

        // The next Agent probe operation (attach.prepare reads a variable) proceeds past the
        // busy checks even though VS Code still reports the stopped session as active.
        p._context = { workspaceState: { get: () => undefined } };
        p._probeConnectionService = { resolveProbe: async () => null };
        await assert.rejects(
            p._withAgentProbe(async () => "read"),
            (error) => error.code === "CONFIG_INCOMPLETE"
        );
        assert.strictEqual(coordinator.anyActive(), false, "the Agent read lease was released");

        // VS Code's own terminate event arrives afterwards and must not stop OpenOCD twice.
        await p.handleDebugSessionTerminate(session);
        assert.strictEqual(server.stops, 1);
        assert.strictEqual(restored(), 1);
    });

    await scenario("debug.stop reports an unconfirmed OpenOCD exit and keeps the lease", async () => {
        const { p, coordinator, server, service, vscodeDebug, finishStop, restored } = setup();
        const stopping = service.control({ action: "stop" });
        await ticks();
        const terminating = vscodeDebug.terminating;
        finishStop().reject(
            Object.assign(new Error("OpenOCD process exit could not be confirmed"), {
                code: "DEBUG_SERVER_STOP_FAILED"
            })
        );
        await assert.rejects(stopping, (error) => error.code === "DEBUG_SERVER_STOP_FAILED");
        await assert.rejects(terminating, (error) => error.code === "DEBUG_SERVER_STOP_FAILED");
        assert.strictEqual(coordinator.isActive("debugServer"), true, "an unconfirmed exit keeps the probe owned");
        assert.strictEqual(p._managedDebugServer, server, "the server stays reachable for a retry");
        assert.strictEqual(restored(), 0);
        assert.strictEqual(service.controlInFlight, null);
    });

    await scenario(
        "the next debug start retries an unconfirmed OpenOCD stop instead of reporting the probe busy",
        async () => {
            const { p, coordinator, server, service, vscodeDebug, finishStop } = setup();
            p._assertProbeDriverIdle = () => {};
            p.stopAgentReadIfRunning = () => null;
            const stopping = service.control({ action: "stop" });
            await ticks();
            const terminating = vscodeDebug.terminating;
            server.state = "stop-failed";
            finishStop().reject(Object.assign(new Error("unconfirmed"), { code: "DEBUG_SERVER_STOP_FAILED" }));
            await assert.rejects(stopping);
            await assert.rejects(terminating);

            // A retry that still cannot confirm the exit keeps the probe owned and reports why.
            const failedRetry = p.prepareProbeForDebug({ uri: {} });
            await ticks();
            finishStop().reject(Object.assign(new Error("unconfirmed"), { code: "DEBUG_SERVER_STOP_FAILED" }));
            await assert.rejects(failedRetry, (error) => error.code === "DEBUG_SERVER_STOP_FAILED");
            assert.strictEqual(p._managedDebugServer, server);
            assert.strictEqual(coordinator.isActive("debugServer"), true);

            const retry = p.prepareProbeForDebug({ uri: {} });
            await ticks();
            assert.strictEqual(server.stops, 3);
            finishStop().resolve(true);
            await retry;
            assert.strictEqual(p._managedDebugServer, null);
            assert.strictEqual(coordinator.isActive("debugServer"), false, "the retried stop releases the probe lease");
        }
    );

    await scenario("a running managed debug server still blocks another debug start", async () => {
        const { p, server } = setup();
        p._assertProbeDriverIdle = () => {};
        server.state = "ready";
        await assert.rejects(p.prepareProbeForDebug({ uri: {} }), (error) => error.code === "PROBE_BUSY");
        assert.strictEqual(server.stops, 0);
    });

    await scenario("debug.stop of a session without managed OpenOCD resolves once it is gone", async () => {
        const { p, coordinator, server, service } = setup();
        p._managedDebugSessionId = "";
        const result = await service.control({ action: "stop" });
        assert.strictEqual(result.status.state, "none");
        assert.strictEqual(server.stops, 0);
        assert.strictEqual(coordinator.isActive("debugServer"), true);
    });

    await scenario("a live foreign debug session still blocks Agent probe access", async () => {
        const { p, vscodeDebug } = setup();
        const foreign = { id: "other", type: "python" };
        vscodeDebug.activeDebugSession = foreign;
        assert.strictEqual(p._liveDebugSession(), foreign);
        p._terminatedDebugSessionIds.add("s1");
        assert.strictEqual(p._liveDebugSession(), foreign);
    });

    console.log("debug stop release tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
