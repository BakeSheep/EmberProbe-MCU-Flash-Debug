"use strict";

const assert = require("assert");
const {
    DebugSessionBridge,
    MIN_DAP_INTERVAL_MS,
    SNAPSHOT_INITIAL_DELAY_MS,
    SNAPSHOT_RETRY_DELAYS_MS,
    mergeReadPlan
} = require("../src/services/debugSessionBridge");

const { FakeClock } = require("./helpers/fake-clock");
const clock = new FakeClock();
const delay = (ms) => clock.advance(ms);

(async () => {
    const groups = mergeReadPlan([
        { name: "b", address: 0x20000002, size: 2 },
        { name: "a", address: 0x20000000, size: 4 },
        { name: "c", address: 0x20000100, size: 1 }
    ]);
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].address, 0x20000000);
    assert.strictEqual(groups[0].size, 4);

    const requests = [];
    const samples = [];
    const statuses = [];
    const targetStates = [];
    const targetEvents = [];
    let quiesceCalls = 0;
    let readPlan = [{ name: "x", address: 0x20000000, size: 4 }];
    const memory = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const session = {
        id: "one",
        type: "cortex-debug",
        workspaceFolder: { uri: { toString: () => "file:///workspace" } },
        async customRequest(command, args) {
            requests.push({ command, args });
            if (command === "readMemory") {
                const address = Number.parseInt(args.memoryReference, 16);
                return {
                    address: args.memoryReference,
                    data: memory.subarray(address - 0x20000000, address - 0x20000000 + args.count).toString("base64")
                };
            }
            if (command === "writeMemory") return { bytesWritten: Buffer.from(args.data, "base64").length };
            throw new Error("unexpected request");
        }
    };
    const bridge = new DebugSessionBridge({
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        getReadPlan: () => readPlan,
        getIntervalMs: () => 1,
        onSamples: (value) => samples.push(value),
        onStatus: (value) => statuses.push(value),
        onTargetState: (value) => {
            targetStates.push(value.state);
            targetEvents.push(value);
        },
        beforePausedRead: async () => {
            quiesceCalls++;
        }
    });
    bridge.setWorkspace(session.workspaceFolder);
    bridge.attach(session);
    bridge.setIntent(true);
    await delay(20);
    assert.strictEqual(requests.length, 0, "running targets must never be read");

    bridge.handleMessage(session, {
        type: "response",
        command: "initialize",
        success: true,
        body: { supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true }
    });
    bridge.handleMessage(session, { type: "event", event: "stopped" });
    const directPausedRead = await bridge.readPausedItems([{ name: "direct", address: 0x20000000, size: 4 }]);
    assert.deepStrictEqual([...directPausedRead[0].bytes], [1, 2, 3, 4]);
    assert.strictEqual(bridge.status().snapshotReady, false);
    assert.strictEqual(bridge.status().mode, "debug-paused-reading");
    await delay(SNAPSHOT_INITIAL_DELAY_MS + 40);
    assert.strictEqual(samples.length, 1);
    assert.deepStrictEqual([...samples[0][0].bytes], [1, 2, 3, 4]);
    assert.strictEqual(bridge.status().mode, "debug-paused-ready");
    assert.strictEqual(bridge.status().snapshotReady, true);
    assert.ok(quiesceCalls >= 1, "paused DAP reads should wait for managed Tcl reads to quiesce");
    assert.strictEqual(bridge.canWrite, true);
    const pausedRequestCount = requests.length;
    await delay(MIN_DAP_INTERVAL_MS + 20);
    assert.strictEqual(requests.length, pausedRequestCount, "a paused target should be read only once per stop event");
    readPlan = [...readPlan, { name: "y", address: 0x20000004, size: 4 }];
    bridge.refreshSnapshot();
    await delay(SNAPSHOT_INITIAL_DELAY_MS + 40);
    assert.strictEqual(samples.length, 2, "changing the watch plan while paused should refresh one snapshot");
    assert.deepStrictEqual(
        samples[1].map((item) => item.name),
        ["x", "y"]
    );

    bridge.handleRequest(session, { type: "request", command: "stepOut" });
    assert.strictEqual(targetEvents.at(-1).state, "transition");
    assert.strictEqual(targetEvents.at(-1).transition, "step");
    assert.strictEqual(bridge.status().snapshotReady, false, "a step request must invalidate the paused snapshot");
    assert.strictEqual(
        bridge.canRead,
        false,
        "direct paused reads must be blocked while execution control is in progress"
    );
    await assert.rejects(
        () => bridge.readPausedItems([{ name: "blocked", address: 0x20000000, size: 4 }]),
        (error) => error.code === "DEBUG_STATE_TRANSITION"
    );
    bridge.handleMessage(session, { type: "event", event: "continued" });
    assert.deepStrictEqual(targetStates.slice(0, 3), ["stopped", "transition", "continued"]);
    assert.strictEqual(
        targetEvents.at(-1).transition,
        "step",
        "step continuation must remain distinguishable from free run"
    );
    const requestCount = requests.length;
    await delay(MIN_DAP_INTERVAL_MS + 20);
    assert.strictEqual(requests.length, requestCount, "continued targets must not be read or written");
    assert.strictEqual(bridge.status().mode, "debug-running-waiting");

    bridge.handleMessage(session, { type: "event", event: "stopped" });
    await delay(SNAPSHOT_INITIAL_DELAY_MS + 40);
    bridge.handleRequest(session, { type: "request", command: "next", seq: 42 });
    bridge.handleMessage(session, {
        type: "response",
        command: "next",
        request_seq: 42,
        success: false
    });
    assert.strictEqual(targetEvents.at(-1).state, "transition-failed");
    await delay(SNAPSHOT_INITIAL_DELAY_MS + 40);
    assert.strictEqual(
        bridge.status().snapshotReady,
        true,
        "a rejected step request should restore the paused snapshot"
    );

    const tx = await bridge.writeAndVerify([{ name: "x", address: 0x20000000, bytes: Uint8Array.from([9, 9, 9, 9]) }]);
    assert.strictEqual(tx.before.length, 1);
    assert.strictEqual(tx.after.length, 1);
    assert(requests.some((item) => item.command === "writeMemory"));

    // A state change during the aligned read must prevent any subsequent writeMemory request.
    for (const change of ["continued", "session-replaced", "epoch-changed"]) {
        const guarded = new DebugSessionBridge({ schedule: clock.schedule, cancel: clock.cancel, now: clock.now });
        const commands = [];
        let readCount = 0;
        const guardedSession = {
            ...session,
            async customRequest(command) {
                commands.push(command);
                if (command === "readMemory") {
                    if (++readCount === 2) {
                        if (change === "continued")
                            guarded.handleMessage(guardedSession, { type: "event", event: "continued" });
                        else if (change === "session-replaced")
                            guarded.sessions.set(guardedSession.id, { ...guardedSession });
                        else guarded.epoch++;
                    }
                    return { data: Buffer.from([1, 2, 3, 4]).toString("base64") };
                }
                return { bytesWritten: 4 };
            }
        };
        guarded.sessions.set(guardedSession.id, guardedSession);
        guarded.intentEnabled = true;
        guarded.paused = true;
        guarded.snapshotReady = true;
        guarded.capabilities = { read: true, write: true };
        await assert.rejects(
            guarded.writeAndVerify([{ name: "byte", address: 0x20000001, bytes: [9] }]),
            /Target state changed before the DAP write/
        );
        assert.deepStrictEqual(commands, ["readMemory", "readMemory"], change);
        assert.strictEqual(guarded.writing, false);
        guarded.dispose();
    }

    bridge.setIntent(false);
    assert.strictEqual(bridge.canRead, false);
    assert(statuses.some((status) => status.mode === "debug-running-waiting"));
    bridge.dispose();

    let optInReads = 0;
    const optInSamples = [];
    const optInSession = {
        ...session,
        id: "opt-in",
        async customRequest(command, args) {
            if (command !== "readMemory") throw new Error("unexpected request");
            optInReads++;
            return { address: args.memoryReference, data: memory.subarray(0, args.count).toString("base64") };
        }
    };
    const optIn = new DebugSessionBridge({
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        getReadPlan: () => [{ name: "x", address: 0x20000000, size: 4 }],
        onSamples: (value) => optInSamples.push(value),
        onStatus() {}
    });
    optIn.setWorkspace(optInSession.workspaceFolder);
    optIn.attach(optInSession);
    optIn.handleMessage(optInSession, {
        type: "response",
        command: "initialize",
        body: { supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true }
    });
    assert.strictEqual(optIn.intentEnabled, false);
    assert.strictEqual(
        optIn.status().mode,
        "debug-running-waiting",
        "a running debug target should be visible before sampling is enabled"
    );
    optIn.setIntent(true);
    await delay(SNAPSHOT_INITIAL_DELAY_MS + 30);
    assert.strictEqual(
        optInReads,
        0,
        "enabling sampling while debugging runs must not contend for the probe or read DAP memory"
    );
    optIn.handleMessage(optInSession, { type: "event", event: "stopped" });
    optIn.setIntent(false);
    await delay(SNAPSHOT_INITIAL_DELAY_MS + 30);
    assert.strictEqual(optInReads, 0, "a paused debug target must remain untouched until the user enables sampling");
    optIn.setIntent(true);
    await delay(SNAPSHOT_INITIAL_DELAY_MS + 40);
    assert.strictEqual(optInReads, 1);
    assert.strictEqual(optInSamples.length, 1, "enabling sampling while paused should acquire exactly one snapshot");
    optIn.handleMessage(optInSession, { type: "event", event: "continued" });
    assert.strictEqual(optIn.status().mode, "debug-running-waiting");
    assert.strictEqual(optIn.status().snapshotReady, false);
    optIn.dispose();

    const conflict = new DebugSessionBridge({
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        onStatus() {}
    });
    const second = { ...session, id: "two" };
    conflict.attach(session);
    conflict.attach(second);
    conflict.setIntent(true);
    assert.strictEqual(conflict.conflict, true);
    assert.strictEqual(conflict.status().mode, "debug-session-conflict");
    conflict.detach(second);
    conflict.handleMessage(session, {
        type: "response",
        command: "initialize",
        body: { supportsReadMemoryRequest: false, supportsWriteMemoryRequest: false }
    });
    conflict.handleMessage(session, { type: "event", event: "stopped" });
    assert.strictEqual(conflict.status().mode, "debug-paused-unsupported");
    conflict.handleMessage(session, { type: "event", event: "terminated" });
    conflict.detach(session);
    assert.strictEqual(conflict.hasSession, false);
    conflict.dispose();

    let busyReads = 0;
    const retrySamples = [];
    const retrySession = {
        ...session,
        id: "retry",
        async customRequest(command, args) {
            if (command !== "readMemory") throw new Error("unexpected request");
            busyReads++;
            if (busyReads < 3) throw new Error("Cortex-Debug is busy handling the stopped event");
            return { address: args.memoryReference, data: memory.subarray(0, args.count).toString("base64") };
        }
    };
    const retryBridge = new DebugSessionBridge({
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        getReadPlan: () => [{ name: "x", address: 0x20000000, size: 4 }],
        onSamples: (value) => retrySamples.push(value),
        onStatus() {},
        onError() {}
    });
    retryBridge.setWorkspace(retrySession.workspaceFolder);
    retryBridge.attach(retrySession);
    retryBridge.setIntent(true);
    retryBridge.handleMessage(retrySession, {
        type: "response",
        command: "initialize",
        body: { supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true }
    });
    retryBridge.handleMessage(retrySession, { type: "event", event: "stopped" });
    await delay(SNAPSHOT_INITIAL_DELAY_MS + SNAPSHOT_RETRY_DELAYS_MS[0] + SNAPSHOT_RETRY_DELAYS_MS[1] + 100);
    assert.strictEqual(busyReads, 3, "transient DAP busy errors should be retried");
    assert.strictEqual(retrySamples.length, 1);
    assert.strictEqual(retryBridge.status().snapshotReady, true);
    retryBridge.dispose();

    let quiesceAttempts = 0;
    let readsAfterQuiesce = 0;
    const quiesceSession = {
        ...session,
        id: "quiesce-retry",
        async customRequest(command, args) {
            if (command !== "readMemory") throw new Error("unexpected request");
            readsAfterQuiesce++;
            return { address: args.memoryReference, data: memory.subarray(0, args.count).toString("base64") };
        }
    };
    const quiesceBridge = new DebugSessionBridge({
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        getReadPlan: () => [{ name: "x", address: 0x20000000, size: 4 }],
        onStatus() {},
        onError() {},
        beforePausedRead: async () => {
            quiesceAttempts++;
            if (quiesceAttempts < 3) throw new Error("managed Tcl read is still active");
        }
    });
    quiesceBridge.setWorkspace(quiesceSession.workspaceFolder);
    quiesceBridge.attach(quiesceSession);
    quiesceBridge.setIntent(true);
    quiesceBridge.handleMessage(quiesceSession, {
        type: "response",
        command: "initialize",
        body: { supportsReadMemoryRequest: true }
    });
    quiesceBridge.handleMessage(quiesceSession, { type: "event", event: "stopped" });
    await delay(SNAPSHOT_INITIAL_DELAY_MS + SNAPSHOT_RETRY_DELAYS_MS[0] + SNAPSHOT_RETRY_DELAYS_MS[1] + 100);
    assert.strictEqual(quiesceAttempts, 3, "a busy Tcl channel should be retried before taking a DAP snapshot");
    assert.strictEqual(readsAfterQuiesce, 1, "DAP must not read memory until Tcl quiescence succeeds");
    quiesceBridge.dispose();
    console.log("debug session bridge tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
