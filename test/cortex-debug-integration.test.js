"use strict";
const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { DebugLifecycle, debugStartupPolicy } = require("../src/services/debugLifecycle");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { ProbeCoordinator } = require("../src/probeCoordinator");
(async () => {
    for (const debugType of ["cortex-debug", "emberprobe"]) {
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

        // DAP convergence tests on DebugLifecycle:
        // 1. Initialized arrives before launch response (success)
        const d1 = lifecycle.arm(10);
        lifecycle.session = { id: "d1" };
        lifecycle.markInitialized({ id: "d1" }, true);
        assert.strictEqual(lifecycle.pending, true);
        lifecycle.markLaunchResponse({ id: "d1" }, true, true);
        assert.strictEqual((await d1).kind, "ready");
        assert.strictEqual(lifecycle.pending, false);

        // 2. Launch response (success) arrives before initialized
        const d2 = lifecycle.arm(10);
        lifecycle.session = { id: "d2" };
        lifecycle.markLaunchResponse({ id: "d2" }, true, true);
        assert.strictEqual(lifecycle.pending, true);
        lifecycle.markInitialized({ id: "d2" }, true);
        assert.strictEqual((await d2).kind, "ready");
        assert.strictEqual(lifecycle.pending, false);

        // 3. Initialized arrives before launch failure
        const d3 = lifecycle.arm(10);
        lifecycle.session = { id: "d3" };
        lifecycle.markInitialized({ id: "d3" }, true);
        assert.strictEqual(lifecycle.pending, true);
        lifecycle.markLaunchResponse({ id: "d3" }, true, false, { message: "Launch failed: target halted" });
        const res3 = await d3;
        assert.strictEqual(res3.kind, "failed");
        assert.strictEqual(res3.message, "Launch failed: target halted");
        assert.strictEqual(lifecycle.pending, false);

        // 4. Launch failure arrives before initialized
        const d4 = lifecycle.arm(10);
        lifecycle.session = { id: "d4" };
        lifecycle.markLaunchResponse({ id: "d4" }, true, false, { message: "Launch failed immediately" });
        const res4 = await d4;
        assert.strictEqual(res4.kind, "failed");
        assert.strictEqual(res4.message, "Launch failed immediately");
        assert.strictEqual(lifecycle.pending, false);

        // 5. Mismatched session events do not trigger ready
        const d5 = lifecycle.arm(10);
        lifecycle.session = { id: "d5" };
        lifecycle.markInitialized({ id: "other" }, false);
        lifecycle.markLaunchResponse({ id: "other" }, false, true);
        assert.strictEqual(lifecycle.pending, true);
        lifecycle.clear({ kind: "terminated" });
        assert.strictEqual((await d5).kind, "terminated");
        const stoppedSessions = [];
        let activeDebugSession = null;
        const P = loadProvider({
            window: { showErrorMessage: () => {} },
            debug: {
                get activeDebugSession() {
                    return activeDebugSession;
                },
                stopDebugging: (s) => {
                    stoppedSessions.push(s);
                    return Promise.resolve(true);
                }
            }
        });
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
            type: debugType,
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

        // Provider integration test: DAP initialized then launch failure triggers idempotent cleanup
        {
            const prov = Object.create(P.prototype);
            const lc = new DebugLifecycle({ schedule: () => 1, cancel: () => {} });
            prov._probeCoordinator = new ProbeCoordinator();
            prov._samplingCoordinator = new SamplingCoordinator();
            prov._debugBridge = new DebugSessionBridge();
            prov._debugLifecycle = lc;
            prov._managedDebugToken = "test-token";
            prov._terminatedDebugSessionIds = new Set();
            prov._debugStartupErrorReported = false;
            prov._debugStartupFailureCleanedUp = false;
            prov._t = (key) => key;
            prov._activeReadPlan = () => [];
            prov._commandContext = () => ({ folder: null });
            prov._managedDebugServer = { setSamplingEnabled: () => {} };

            const webviewMessages = [];
            prov._webviewView = { webview: { postMessage: (msg) => webviewMessages.push(msg) } };

            let stoppedServerCount = 0;
            let restoredSamplingCount = 0;
            prov._stopManagedDebugServer = async () => {
                stoppedServerCount++;
            };
            prov.restoreSamplingAfterDebug = async () => {
                restoredSamplingCount++;
            };

            const sess = {
                id: "sess-fail",
                type: debugType,
                configuration: { __emberprobeManagedToken: "test-token" }
            };

            const gate = prov._armDebugStartupWatchdog();
            prov.handleDebugSessionStart(sess);
            assert.strictEqual(prov._managedDebugSessionId, sess.id);
            stoppedSessions.length = 0;

            // Step 1: Initialized event arrives
            prov.handleDebugAdapterMessage(sess, { type: "event", event: "initialized" });
            assert.strictEqual(prov._debugLifecycle.pending, true);
            assert.strictEqual(stoppedServerCount, 0);

            // Step 2: Launch failure response arrives
            prov.handleDebugAdapterMessage(sess, {
                type: "response",
                command: "launch",
                success: false,
                message: "Target voltage too low"
            });

            // Gate must resolve to failed
            const gateOutcome = await gate;
            assert.strictEqual(gateOutcome.kind, "failed");

            // Verify error reported to webview
            assert.strictEqual(webviewMessages.length, 1);
            assert.strictEqual(webviewMessages[0].type, "commandError");
            assert.strictEqual(webviewMessages[0].error, "Target voltage too low");
            assert.strictEqual(prov._debugLifecycle.session, null);

            // The command observes the cleared lifecycle, so cleanup must recover the original session from the bridge.
            await prov._handleDebugStartupFailure(prov._debugLifecycle.session, gateOutcome.message);
            assert.strictEqual(stoppedSessions.length, 1);
            assert.strictEqual(stoppedSessions[0], sess);
            assert.strictEqual(prov._debugBridge.hasAnySession, false);
            assert.strictEqual(stoppedServerCount, 1);
            assert.strictEqual(restoredSamplingCount, 1);

            // Idempotent: repeated calls must NOT repeat cleanup
            await prov._handleDebugStartupFailure(sess, gateOutcome.message);
            assert.strictEqual(stoppedServerCount, 1);
            assert.strictEqual(restoredSamplingCount, 1);

            prov._debugBridge.dispose();
            lc.clear();
        }

        // Failure before a managed session starts must leave unrelated sessions alone.
        {
            const prov = Object.create(P.prototype);
            const lc = new DebugLifecycle({ schedule: () => 1, cancel: () => {} });
            const coordinator = new ProbeCoordinator();
            prov._probeCoordinator = coordinator;
            prov._debugBridge = new DebugSessionBridge();
            prov._debugLifecycle = lc;
            prov._managedDebugToken = "managed-token";
            prov._managedDebugSessionId = "";
            prov._terminatedDebugSessionIds = new Set();
            prov._debugStartupErrorReported = false;
            prov._debugStartupFailureCleanedUp = false;
            prov._t = (key) => key;
            const unrelated = {
                id: "other-session",
                type: debugType,
                configuration: { __emberprobeManagedToken: "other-token" }
            };
            prov._debugBridge.attach(unrelated);
            activeDebugSession = unrelated;
            stoppedSessions.length = 0;
            let stoppedServer = false;
            prov._debugServerLease = coordinator.acquire("debugServer");
            prov._managedDebugServer = {
                setSamplingEnabled: () => {},
                stop: async () => {
                    stoppedServer = true;
                }
            };
            prov.restoreSamplingAfterDebug = async () => {};
            const gate = lc.arm(10);

            await prov._handleDebugStartupFailure(null, "launch failed");
            assert.strictEqual((await gate).kind, "failed");
            assert.strictEqual(stoppedSessions.length, 0);
            assert.strictEqual(prov._debugBridge.allSessions.get(unrelated.id), unrelated);
            assert.strictEqual(prov._terminatedDebugSessionIds.has(unrelated.id), false);
            assert.strictEqual(stoppedServer, true);
            assert.strictEqual(coordinator.isActive("debugServer"), false);

            activeDebugSession = null;
            prov._debugBridge.dispose();
            lc.clear();
        }

        // Provider integration test: Launch success response then initialized event resolves to ready
        {
            const prov = Object.create(P.prototype);
            const lc = new DebugLifecycle({ schedule: () => 1, cancel: () => {} });
            prov._probeCoordinator = new ProbeCoordinator();
            prov._debugBridge = new DebugSessionBridge();
            prov._debugLifecycle = lc;
            prov._managedDebugToken = "test-token";
            prov._terminatedDebugSessionIds = new Set();
            prov._t = (key) => key;

            let successRecorded = 0;
            prov._probeConnectionService = {
                recordSuccess: () => {
                    successRecorded++;
                }
            };
            prov._managedDebugServer = { options: { probe: "jlink.cfg" } };

            const sess = {
                id: "sess-succ",
                type: debugType,
                configuration: { __emberprobeManagedToken: "test-token" }
            };

            const gate = prov._armDebugStartupWatchdog();
            prov._debugLifecycle.session = sess;

            // Launch response arrives first
            prov.handleDebugAdapterMessage(sess, {
                type: "response",
                command: "launch",
                success: true
            });
            assert.strictEqual(successRecorded, 1);
            assert.strictEqual(prov._debugLifecycle.pending, true);

            // Initialized arrives second
            prov.handleDebugAdapterMessage(sess, { type: "event", event: "initialized" });
            assert.strictEqual(prov._debugLifecycle.pending, false);
            const gateOutcome = await gate;
            assert.strictEqual(gateOutcome.kind, "ready");

            prov._debugBridge.dispose();
            lc.clear();
        }

        // Provider integration test: Timeout after session has already been created (P1 & P2 verification)
        {
            const prov = Object.create(P.prototype);
            let scheduledTimeoutFn = null;
            const lc = new DebugLifecycle({
                schedule: (fn) => {
                    scheduledTimeoutFn = fn;
                    return 1;
                },
                cancel: () => {}
            });
            const coordinator = new ProbeCoordinator();
            prov._probeCoordinator = coordinator;
            prov._samplingCoordinator = new SamplingCoordinator();
            prov._debugBridge = new DebugSessionBridge();
            prov._debugLifecycle = lc;
            prov._managedDebugToken = "test-token";
            prov._terminatedDebugSessionIds = new Set();
            prov._debugCommandPending = true;
            prov._debugStartupErrorReported = false;
            prov._debugStartupFailureCleanedUp = false;
            prov._t = (key) => key;
            prov._postConsumerStatuses = () => {};
            prov._commandContext = () => ({ folder: { uri: { toString: () => "workspace" } } });
            prov._activeReadPlan = () => [];

            // P2 setup: Acquire debugServer lease
            prov._debugServerLease = coordinator.acquire("debugServer");
            assert.strictEqual(coordinator.isActive("debugServer"), true);

            let serverStopped = false;
            let samplingRestored = false;
            let leaseHeldDuringStop = false;
            let pendingHeldDuringStop = false;
            let blockedConcurrentAcquire = false;

            prov._managedDebugServer = {
                samplingEnabled: true,
                setSamplingEnabled(v) {
                    this.samplingEnabled = v;
                },
                stop: async () => {
                    // P2 assertion: Lease and pending MUST still be active while OpenOCD is stopping!
                    leaseHeldDuringStop = coordinator.isActive("debugServer");
                    pendingHeldDuringStop = prov._debugCommandPending;
                    try {
                        coordinator.acquire("download");
                    } catch (err) {
                        if (err.code === "PROBE_BUSY") blockedConcurrentAcquire = true;
                    }
                    await new Promise((r) => setTimeout(r, 10));
                    serverStopped = true;
                }
            };
            prov.restoreSamplingAfterDebug = async () => {
                // P1 assertion: Session must already be detached from bridge when restoring sampling!
                assert.strictEqual(
                    prov._debugBridge.hasAnySession,
                    false,
                    "bridge must have no session when restoring sampling"
                );
                samplingRestored = true;
            };

            const sess = {
                id: "sess-created-then-timeout",
                type: debugType,
                configuration: { __emberprobeManagedToken: "test-token" }
            };

            const gate = prov._armDebugStartupWatchdog();

            // Step 1: Session starts and attaches to bridge
            prov.handleDebugSessionStart(sess);
            assert.strictEqual(prov._debugBridge.hasAnySession, true, "session must be attached to bridge");
            assert.strictEqual(prov._managedDebugSessionId, sess.id);
            assert.strictEqual(prov._debugLifecycle.pending, true);

            // Step 2: Timeout occurs while waiting for startup gate
            assert.ok(scheduledTimeoutFn, "watchdog timeout must be scheduled");
            stoppedSessions.length = 0;

            // Trigger timeout recovery
            await prov._recoverDebugStartupTimeout();

            // P1 assertions:
            // 1. VS Code stopDebugging was called with the session
            assert.strictEqual(stoppedSessions.length, 1);
            assert.strictEqual(stoppedSessions[0].id, sess.id);
            // 2. Session was detached from debugBridge
            assert.strictEqual(prov._debugBridge.hasAnySession, false);
            // 3. Sampling was restored
            assert.strictEqual(samplingRestored, true);

            // P2 assertions:
            // 1. OpenOCD server stop completed
            assert.strictEqual(serverStopped, true);
            // 2. Lease and pending were held during server stop
            assert.strictEqual(leaseHeldDuringStop, true, "lease must be held during server stop");
            assert.strictEqual(pendingHeldDuringStop, true, "command pending must be held during server stop");
            assert.strictEqual(blockedConcurrentAcquire, true, "concurrent acquire must be blocked during server stop");
            // 3. Lease was released only AFTER server stop completed
            assert.strictEqual(coordinator.isActive("debugServer"), false);
            // 4. Pending was cleared only AFTER cleanup completed
            assert.strictEqual(prov._debugCommandPending, false);

            // 5. Subsequent probe operation can now acquire lease without conflict
            const newLease = coordinator.acquire("download");
            assert.strictEqual(coordinator.isActive("download"), true);
            newLease.release();

            // 6. Startup gate must resolve to failed
            const gateOutcome = await gate;
            assert.strictEqual(gateOutcome.kind, "failed");

            prov._debugBridge.dispose();
            lc.clear();
        }

        // Provider integration test: Startup gate timeout with session already created
        {
            const prov = Object.create(P.prototype);
            const lc = new DebugLifecycle({ schedule: () => 1, cancel: () => {} });
            const coordinator = new ProbeCoordinator();
            prov._probeCoordinator = coordinator;
            prov._samplingCoordinator = new SamplingCoordinator();
            prov._debugBridge = new DebugSessionBridge();
            prov._debugLifecycle = lc;
            prov._managedDebugToken = "test-token-2";
            prov._terminatedDebugSessionIds = new Set();
            prov._debugCommandPending = true;
            prov._debugStartupErrorReported = false;
            prov._debugStartupFailureCleanedUp = false;
            prov._t = (key) => key;
            prov._postConsumerStatuses = () => {};
            prov._commandContext = () => ({ folder: { uri: { toString: () => "workspace" } } });
            prov._activeReadPlan = () => [];

            prov._debugServerLease = coordinator.acquire("debugServer");
            let serverStopped = false;
            prov._managedDebugServer = {
                samplingEnabled: true,
                setSamplingEnabled(v) {
                    this.samplingEnabled = v;
                },
                stop: async () => {
                    serverStopped = true;
                }
            };
            let samplingRestored = false;
            prov.restoreSamplingAfterDebug = async () => {
                samplingRestored = true;
            };

            const sess = {
                id: "sess-gate-timeout",
                type: debugType,
                configuration: { __emberprobeManagedToken: "test-token-2" }
            };

            const gate = prov._armDebugStartupWatchdog();
            prov.handleDebugSessionStart(sess);
            assert.strictEqual(prov._debugBridge.hasAnySession, true);

            // Startup gate clears with timeout outcome
            stoppedSessions.length = 0;
            lc.clear({ kind: "timeout" });
            const gateOutcome = await gate;
            assert.strictEqual(gateOutcome.kind, "timeout");

            // MainViewProvider handles failure with session
            await prov._handleDebugStartupFailure(sess, "debug start timeout");

            assert.strictEqual(stoppedSessions.length, 1);
            assert.strictEqual(stoppedSessions[0].id, sess.id);
            assert.strictEqual(prov._debugBridge.hasAnySession, false);
            assert.strictEqual(serverStopped, true);
            assert.strictEqual(coordinator.isActive("debugServer"), false);
            assert.strictEqual(prov._debugCommandPending, false);
            assert.strictEqual(samplingRestored, true);

            // Idempotent: second call (e.g. from _recoverDebugStartupTimeout) is a no-op
            await prov._recoverDebugStartupTimeout();
            assert.strictEqual(stoppedSessions.length, 1);

            prov._debugBridge.dispose();
            lc.clear();
        }

        // Provider integration test: Session termination during startup clears watchdog and cleans up
        {
            const prov = Object.create(P.prototype);
            const lc = new DebugLifecycle({ schedule: () => 1, cancel: () => {} });
            prov._probeCoordinator = new ProbeCoordinator();
            prov._debugBridge = new DebugSessionBridge();
            prov._debugLifecycle = lc;
            prov._managedDebugToken = "test-token";
            prov._managedDebugSessionId = "sess-term";
            prov._terminatedDebugSessionIds = new Set();
            prov._t = (key) => key;

            let termStopped = 0;
            let termRestored = 0;
            prov._stopManagedDebugServer = async () => {
                termStopped++;
            };
            prov.restoreSamplingAfterDebug = async () => {
                termRestored++;
            };

            const sess = {
                id: "sess-term",
                type: debugType,
                configuration: { __emberprobeManagedToken: "test-token" }
            };

            const gate = prov._armDebugStartupWatchdog();
            prov._debugLifecycle.session = sess;

            assert.strictEqual(prov._debugLifecycle.pending, true);
            await prov.handleDebugSessionTerminate(sess);

            const gateOutcome = await gate;
            assert.strictEqual(gateOutcome.kind, "terminated");
            assert.strictEqual(termStopped, 1);
            assert.strictEqual(termRestored, 1);

            prov._debugBridge.dispose();
            lc.clear();
        }
        console.log("Cortex-Debug lifecycle behavior tests passed");
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
