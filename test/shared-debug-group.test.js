"use strict";
const assert = require("assert");
const { SharedDebugGroup } = require("../src/services/sharedDebugGroup");
const { normalizeDebugServerOptions } = require("../src/services/debugConfiguration");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { FakeClock } = require("./helpers/fake-clock");
const { loadProvider } = require("./helpers/load-provider");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");

const folder = { uri: { toString: () => "file:///group", fsPath: "C:/group" } };
const options = {
    executable: "openocd",
    probe: "cmsis-dap.cfg",
    target: "stm32h7x.cfg",
    rtos: "FreeRTOS",
    numberOfProcessors: 2,
    targetProcessor: 0,
    targetName: "chip.cpu0",
    serverGroup: "dual"
};
function makeGroup(onFailure) {
    const clock = new FakeClock();
    const coordinator = new ProbeCoordinator();
    const lease = coordinator.acquire("debugStart").transition("debugServer");
    let stops = 0;
    let stopFailure = false;
    const controller = {
        options,
        ready: true,
        setSamplingEnabled() {},
        async stop() {
            stops++;
            if (stopFailure) throw new Error("exit not confirmed");
            controller.ready = false;
        }
    };
    const connection = { targetNames: ["chip.cpu0", "chip.cpu1"], gdbTargets: ["127.0.0.1:30001", "127.0.0.1:30002"] };
    const group = new SharedDebugGroup({
        id: "dual",
        workspace: folder.uri.toString(),
        controller,
        lease,
        connection,
        onFailure,
        lifecycleOptions: { schedule: clock.schedule, cancel: clock.cancel }
    });
    return {
        group,
        coordinator,
        lease,
        controller,
        connection,
        clock,
        get stops() {
            return stops;
        },
        failStop(value) {
            stopFailure = value;
        }
    };
}
function reserve(group, core, request = core ? "attach" : "launch", overrides = {}) {
    return group.reserve(
        folder.uri.toString(),
        { ...options, targetProcessor: core, targetName: undefined, ...overrides },
        request
    );
}
function bind(group, member) {
    const session = {
        id: "core" + member.core,
        type: "emberprobe",
        workspaceFolder: folder,
        configuration: {
            executable: "firmware" + member.core + ".elf",
            serverGroup: "dual",
            targetProcessor: member.core,
            gdbTarget: member.connection,
            __emberprobeManagedToken: member.token
        }
    };
    assert.strictEqual(group.bind(session), member);
    group.message(session, { type: "event", event: "initialized" });
    assert(member.lifecycle.pending, "initialized alone does not authorize another core startup");
    group.message(session, { type: "response", command: member.core ? "attach" : "launch", success: true });
    assert(!member.lifecycle.pending);
    return session;
}

(async () => {
    for (const serverGroup of ["", "../group", "group;shutdown", null, 2, "a".repeat(65)])
        assert.throws(() => normalizeDebugServerOptions({ numberOfProcessors: 2, serverGroup }), {
            code: "DEBUG_GROUP_INVALID"
        });
    assert.throws(() => normalizeDebugServerOptions({ serverGroup: "dual" }), { code: "DEBUG_GROUP_INVALID" });
    assert.strictEqual(normalizeDebugServerOptions(options).serverGroup, "dual");
    const state = makeGroup();
    assert.throws(
        () =>
            new SharedDebugGroup({
                id: "dual",
                workspace: "",
                controller: state.controller,
                lease: state.lease,
                connection: {}
            }),
        /confirm/
    );
    const first = reserve(state.group, 0);
    assert.throws(() => reserve(state.group, 1), { code: "DEBUG_GROUP_BUSY" });
    const a = bind(state.group, first);
    assert.strictEqual((await first.gate).kind, "ready");
    assert.throws(() => reserve(state.group, 1, "launch"), /attach/);
    assert.throws(() => reserve(state.group, 0, "attach"), { code: "DEBUG_GROUP_CORE_BUSY" });
    assert.throws(() => reserve(state.group, 1, "attach", { probeSerial: "different" }), {
        code: "DEBUG_GROUP_CONFLICT"
    });
    assert.throws(() => state.group.reserve("file:///other", options, "attach"), { code: "DEBUG_GROUP_CONFLICT" });
    assert.throws(() => reserve(state.group, 1, "attach", { serverGroup: "other" }), { code: "DEBUG_GROUP_CONFLICT" });
    assert.throws(() => reserve(state.group, 1, "attach", { targetName: "chip.cpu0" }), /targetName/);
    assert.throws(() => reserve(state.group, 9), /index/);
    const second = reserve(state.group, 1);
    const b = bind(state.group, second);
    for (const modified of [
        { ...b, id: "impostor" },
        { ...b, workspaceFolder: { uri: { toString: () => "file:///other" } } },
        { ...b, configuration: { ...b.configuration, targetProcessor: 0 } },
        { ...b, configuration: { ...b.configuration, gdbTarget: first.connection } }
    ])
        assert.strictEqual(state.group.match(modified), null);
    assert.strictEqual(state.group.bind({ configuration: {} }), null);
    assert.strictEqual(state.group.message({}, {}), null);
    await assert.rejects(state.group.stop(), { code: "DEBUG_GROUP_BUSY" });
    await state.group.release(first.token);
    assert.strictEqual(state.stops, 0, "closing one core must preserve the physical server");
    assert.throws(() => state.coordinator.acquire("agentRead"), { code: "PROBE_BUSY" });
    state.failStop(true);
    await assert.rejects(state.group.release(second.token), /exit not confirmed/);
    assert.throws(() => state.coordinator.acquire("agentRead"), { code: "PROBE_BUSY" });
    assert(!state.group.stopped, "unconfirmed exit retains the lease");
    state.failStop(false);
    await Promise.all([state.group.stop(), state.group.stop()]);
    assert.strictEqual(state.stops, 2, "concurrent cleanup shares a single stop attempt");
    assert(state.group.stopped);
    state.coordinator.acquire("agentRead").release();
    await state.group.release("missing");
    assert.throws(() => reserve(state.group, 0), { code: "DEBUG_GROUP_NOT_READY" });

    const failures = [];
    const failing = makeGroup((token, message) => failures.push({ token, message }));
    const pending = reserve(failing.group, 0);
    await failing.clock.advance(60000);
    assert.strictEqual((await pending.gate).kind, "timeout");
    assert.strictEqual(failures.length, 1);
    await failing.group.release(pending.token);
    const failedAttach = makeGroup((token, message) => failures.push({ token, message }));
    const main = reserve(failedAttach.group, 0);
    bind(failedAttach.group, main);
    const joining = reserve(failedAttach.group, 1);
    failedAttach.group.message(
        {
            configuration: {
                serverGroup: "dual",
                targetProcessor: 1,
                gdbTarget: joining.connection,
                __emberprobeManagedToken: joining.token
            }
        },
        { type: "response", command: "attach", success: false, message: "GDB failed" }
    );
    assert.strictEqual((await joining.gate).kind, "failed");
    assert.strictEqual(failures.at(-1).message, "GDB failed");
    await failedAttach.group.release(joining.token);
    assert.strictEqual(failedAttach.stops, 0, "a joining core failure must preserve the healthy member");
    await failedAttach.group.release(main.token);

    const Provider = loadProvider();
    const hostState = makeGroup();
    const host = Object.create(Provider.prototype);
    let prepared = 0,
        restored = 0;
    Object.assign(host, {
        _managedDebugGroup: hostState.group,
        _managedDebugServer: hostState.controller,
        _debugServerLease: hostState.lease,
        _probeConnectionService: { assertCurrent() {} },
        _debugBridge: new DebugSessionBridge(),
        _terminatedDebugSessionIds: new Set(),
        prepareForCortexDebug: async () => prepared++,
        restoreSamplingAfterDebug: async () => restored++
    });
    const zero = reserve(hostState.group, 0);
    const s0 = bind(hostState.group, zero);
    host._debugBridge.attach(s0);
    const resolved = await host._prepareGroupedDebugConfiguration({
        folder,
        executable: "openocd",
        probe: options.probe,
        target: options.target,
        cfg: { get: () => "auto" },
        rtos: "FreeRTOS",
        serverOptions: { serverGroup: "dual", numberOfProcessors: 2, targetProcessor: 1 },
        debugConfig: { type: "emberprobe", request: "attach", executable: "core1.elf" }
    });
    assert.strictEqual(prepared, 0, "joining must reuse the server and lease");
    assert.strictEqual(resolved.gdbTarget, hostState.connection.gdbTargets[1]);
    assert.strictEqual(resolved.targetName, "chip.cpu1", "do not inherit the first core's targetName");
    const s1 = { id: "host1", type: "emberprobe", workspaceFolder: folder, configuration: resolved };
    hostState.group.bind(s1);
    host._debugBridge.attach(s1);
    await host.handleDebugSessionTerminate(s0);
    assert.strictEqual(restored, 0);
    assert.strictEqual(hostState.stops, 0);
    await host.handleDebugSessionTerminate(s1);
    assert.strictEqual(hostState.stops, 1);
    assert.strictEqual(restored, 1);
    assert.strictEqual(host._managedDebugGroup, null);
    assert.strictEqual(host._managedDebugServer, null);
    host._debugBridge.dispose();
    for (const mode of ["startup", "server-exit"]) {
        const cleanup = makeGroup();
        let recovery = 0;
        const stopping = [];
        let owner;
        const LifecycleProvider = loadProvider({
            debug: {
                stopDebugging: async (session) => {
                    stopping.push(session.id);
                    await owner.handleDebugSessionTerminate(session);
                    return true;
                }
            }
        });
        owner = Object.create(LifecycleProvider.prototype);
        Object.assign(owner, {
            _managedDebugGroup: cleanup.group,
            _managedDebugServer: cleanup.controller,
            _debugServerLease: cleanup.lease,
            _debugBridge: new DebugSessionBridge(),
            _terminatedDebugSessionIds: new Set(),
            _postLive() {},
            restoreSamplingAfterDebug: async () => recovery++
        });
        const one = reserve(cleanup.group, 0);
        const primary = bind(cleanup.group, one);
        owner._debugBridge.attach(primary);
        const two = reserve(cleanup.group, 1);
        const secondary = bind(cleanup.group, two);
        owner._debugBridge.attach(secondary);
        if (mode === "startup") {
            await owner._failGroupedCore(two.token, "startup failed");
            assert.deepStrictEqual(stopping, [secondary.id]);
            assert.strictEqual(cleanup.stops, 0);
            assert.strictEqual(recovery, 0);
            await owner.handleDebugSessionTerminate(primary);
        } else {
            cleanup.controller.ready = false;
            await owner._handleSharedServerExit(new Error("OpenOCD exited"));
            assert.deepStrictEqual(stopping.sort(), [primary.id, secondary.id].sort());
        }
        assert.strictEqual(cleanup.stops, 1);
        assert.strictEqual(recovery, 1);
        assert.strictEqual(owner._managedDebugGroup, null);
        cleanup.coordinator.acquire("agentRead").release();
        owner._debugBridge.dispose();
    }
    // A wedged adapter must not strand the member. member.failing blocks any retry, so if the
    // stop/terminate wait throws before release the group keeps the probe lease until reload.
    const wedged = makeGroup();
    let wedgedRecovery = 0;
    const WedgedProvider = loadProvider({
        debug: {
            stopDebugging: async (session) => {
                if (session.id === "core1") throw new Error("adapter is not responding");
                await wedgedOwner.handleDebugSessionTerminate(session);
                return true;
            }
        }
    });
    const wedgedOwner = Object.create(WedgedProvider.prototype);
    Object.assign(wedgedOwner, {
        _managedDebugGroup: wedged.group,
        _managedDebugServer: wedged.controller,
        _debugServerLease: wedged.lease,
        _debugBridge: new DebugSessionBridge(),
        _terminatedDebugSessionIds: new Set(),
        _postLive() {},
        restoreSamplingAfterDebug: async () => wedgedRecovery++
    });
    const wedgedPrimaryMember = reserve(wedged.group, 0);
    const wedgedPrimary = bind(wedged.group, wedgedPrimaryMember);
    const wedgedSecondaryMember = reserve(wedged.group, 1);
    const wedgedSecondary = bind(wedged.group, wedgedSecondaryMember);
    wedgedOwner._debugBridge.attach(wedgedPrimary);
    wedgedOwner._debugBridge.attach(wedgedSecondary);
    await assert.rejects(wedgedOwner._failGroupedCore(wedgedSecondaryMember.token, "OpenOCD exited"), /not responding/);
    assert.strictEqual(wedged.group.members.size, 1, "a throwing stop must still release the member");
    assert.strictEqual(wedged.group.members.has(wedgedSecondaryMember.token), false);
    assert.strictEqual(wedged.stops, 0);
    await wedgedOwner.handleDebugSessionTerminate(wedgedPrimary);
    assert.strictEqual(wedged.stops, 1);
    assert.strictEqual(wedgedRecovery, 1);
    assert.strictEqual(wedgedOwner._managedDebugGroup, null);
    wedged.coordinator.acquire("agentRead").release();
    wedgedOwner._debugBridge.dispose();
    const realTimers = { setTimeout, clearTimeout };
    try {
        for (const mode of ["hang-joined", "hang-last", "hang-unconfirmed", "late-rejection", "resolved", "rejected"]) {
            const cleanup = makeGroup();
            const clock = new FakeClock();
            const cancelled = [];
            global.setTimeout = clock.schedule;
            global.clearTimeout = (timer) => {
                if (timer !== undefined) cancelled.push(timer);
                clock.cancel(timer);
            };
            let owner;
            let rejectStop;
            const stopRequest = new Promise((_resolve, reject) => {
                rejectStop = reject;
            });
            const TimedProvider = loadProvider({
                debug: {
                    stopDebugging: async (session) => {
                        if (mode === "resolved") {
                            await owner.handleDebugSessionTerminate(session);
                            return true;
                        }
                        if (mode === "rejected") throw new Error("adapter stop failed");
                        return stopRequest;
                    }
                }
            });
            owner = Object.create(TimedProvider.prototype);
            Object.assign(owner, {
                _managedDebugGroup: cleanup.group,
                _managedDebugServer: cleanup.controller,
                _debugServerLease: cleanup.lease,
                _debugBridge: new DebugSessionBridge(),
                _terminatedDebugSessionIds: new Set(),
                _postLive() {},
                restoreSamplingAfterDebug: async () => {}
            });
            const primaryMember = reserve(cleanup.group, 0);
            const primarySession = bind(cleanup.group, primaryMember);
            owner._debugBridge.attach(primarySession);
            let failedMember = primaryMember;
            if (mode === "hang-joined") {
                failedMember = reserve(cleanup.group, 1);
                owner._debugBridge.attach(bind(cleanup.group, failedMember));
            }
            if (mode === "hang-unconfirmed") cleanup.failStop(true);
            const failure = owner._failGroupedCore(failedMember.token, "Shared core failed");
            const completion =
                mode === "resolved"
                    ? failure
                    : assert.rejects(
                          failure,
                          mode === "hang-unconfirmed"
                              ? /exit not confirmed/
                              : mode === "rejected"
                                ? /adapter stop failed/
                                : { code: "DEBUG_CONTROL_TIMEOUT" }
                      );
            await clock.advance(0);
            if (mode.startsWith("hang-") || mode === "late-rejection") {
                await clock.advance(1999);
                assert(cleanup.group.members.has(failedMember.token), "the stop request owns its member until timeout");
                assert.throws(() => cleanup.coordinator.acquire("agentRead"), { code: "PROBE_BUSY" });
                await clock.advance(1);
                if (mode === "late-rejection") rejectStop(new Error("late adapter failure"));
                await clock.advance(2000);
            }
            await completion;
            assert.strictEqual(cleanup.group.members.has(failedMember.token), false);
            assert.strictEqual(clock.tasks.size, 0, "stop and termination timers cannot leak");
            assert(cancelled.length > 0, "the stop race always clears its timer");
            if (mode === "hang-joined") {
                assert.strictEqual(cleanup.stops, 0, "another core keeps the physical server and lease");
                assert.throws(() => cleanup.coordinator.acquire("agentRead"), { code: "PROBE_BUSY" });
                await owner.handleDebugSessionTerminate(primarySession);
            } else if (mode === "hang-unconfirmed") {
                assert.strictEqual(cleanup.group.stopped, false);
                assert.strictEqual(owner._managedDebugServer, cleanup.controller);
                assert.strictEqual(owner._managedDebugGroup, cleanup.group);
                assert.throws(() => cleanup.coordinator.acquire("agentRead"), { code: "PROBE_BUSY" });
                cleanup.failStop(false);
                await cleanup.group.stop();
            } else {
                assert.strictEqual(cleanup.stops, 1, "the final member stops the physical server");
                assert.strictEqual(cleanup.group.stopped, true);
            }
            cleanup.coordinator.acquire("agentRead").release();
            owner._debugBridge.dispose();
        }
    } finally {
        global.setTimeout = realTimers.setTimeout;
        global.clearTimeout = realTimers.clearTimeout;
    }
    // Failure before VS Code's start event still owns a DAP member and must stop it.
    const untracked = makeGroup();
    const pendingMember = reserve(untracked.group, 0);
    const pendingSession = {
        id: "early",
        type: "emberprobe",
        workspaceFolder: folder,
        configuration: {
            serverGroup: "dual",
            targetProcessor: 0,
            gdbTarget: pendingMember.connection,
            __emberprobeManagedToken: pendingMember.token
        }
    };
    untracked.group.message(pendingSession, { type: "response", command: "launch", success: false });
    assert.strictEqual(pendingMember.session, pendingSession);
    await untracked.group.release(pendingMember.token);
    assert(a.id && b.id);
    console.log(
        "Shared debug groups: core joins, failure isolation, identities, termination and confirmed lease release passed"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
