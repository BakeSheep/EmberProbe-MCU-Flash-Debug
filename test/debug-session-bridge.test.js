"use strict";

const { scenario } = require("./helpers/scenario");

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

async function testBackgroundStatusBroadcasts(debugType) {
    const statuses = [];
    const bridge = new DebugSessionBridge({
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        onStatus: (value) => statuses.push(value)
    });
    const selected = {
        id: "selected",
        type: debugType,
        configuration: { serverGroup: "dual", targetProcessor: 0 }
    };
    const background = {
        ...selected,
        id: "background",
        configuration: { serverGroup: "dual", targetProcessor: 1 }
    };
    bridge.attach(selected);
    bridge.attach(background);
    const conflictStatusCount = statuses.length;
    bridge.handleMessage(background, { type: "event", event: "output" });
    assert.strictEqual(statuses.length, conflictStatusCount, "background output must not rebroadcast a conflict");
    bridge.selectSession({ sessionId: selected.id });
    const statusCount = statuses.length;
    const selectedStatus = bridge.status();
    const selectedAgentStatus = bridge.agentStatus();
    let waiterChecks = 0;
    const stopped = bridge.waitForState((status) => {
        waiterChecks++;
        return status.sessions.some((session) => session.id === background.id && session.paused);
    });
    const messages = [
        ...["stackTrace", "scopes", "variables", "threads", "evaluate", "readMemory", "launch", "attach"].map(
            (command) => ({ type: "response", command, success: true })
        ),
        { type: "response", command: "variables", success: false },
        { type: "event", event: "output", body: { category: "console", output: "background step" } },
        { type: "event", event: "invalidated" },
        { type: "event", event: "thread", body: { reason: "started", threadId: 19 } }
    ];
    for (let index = 0; index < 20; index++) for (const message of messages) bridge.handleMessage(background, message);
    assert.strictEqual(statuses.length, statusCount, "background DAP traffic must not rebroadcast identical status");
    assert.strictEqual(waiterChecks, 1, "background traffic with no state change must not recheck state waiters");
    assert.deepStrictEqual(bridge.status(), selectedStatus);
    assert.deepStrictEqual(bridge.agentStatus(), selectedAgentStatus);
    bridge.handleMessage(background, {
        type: "event",
        event: "stopped",
        body: { reason: "breakpoint", threadId: 19 }
    });
    assert.strictEqual(statuses.length, statusCount + 1, "a background pause must publish its session-list change");
    assert.strictEqual(bridge.stateWaiters.size, 0, "the background pause must settle waiters synchronously");
    const pausedStatus = await stopped;
    assert.strictEqual(waiterChecks, 2);
    assert(pausedStatus.sessions.find((session) => session.id === background.id).paused);
    assert.strictEqual(pausedStatus.session.id, selected.id);
    assert.deepStrictEqual(bridge.status(), selectedStatus, "the selected sampling status remains unchanged");

    bridge.handleMessage(background, {
        type: "event",
        event: "stopped",
        body: { reason: "step", threadId: 20 }
    });
    bridge.handleMessage(background, {
        type: "response",
        command: "initialize",
        success: true,
        body: { supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true, supportsRestartRequest: true }
    });
    bridge.handleMessage(background, {
        type: "event",
        event: "capabilities",
        body: { capabilities: { supportsRestartRequest: false } }
    });
    bridge.handleMessage(background, { type: "event", event: "thread", body: { reason: "exited", threadId: 20 } });
    bridge.handleRequest(background, { type: "request", command: "next", seq: 42 });
    bridge.handleMessage(background, { type: "response", command: "next", request_seq: 42, success: false });
    assert.strictEqual(
        statuses.length,
        statusCount + 1,
        "background context details must not broadcast when their observable pause flag is unchanged"
    );
    bridge.selectSession({ sessionId: background.id });
    assert(bridge.paused);
    assert.strictEqual(bridge.stopReason, "step", "background stop reasons remain available on selection");
    assert.strictEqual(bridge.threadId, null, "background thread exit still invalidates its cached task");
    assert.strictEqual(bridge.transitionKind, "", "background failed transitions still restore their context");
    assert.deepStrictEqual(bridge.capabilities, {
        read: true,
        write: true,
        restart: false,
        functionBreakpoints: false
    });
    bridge.selectSession({ sessionId: selected.id });
    const resumeStatusCount = statuses.length;
    const reselectedAgentStatus = bridge.agentStatus();
    const continued = bridge.waitForState((status) =>
        status.sessions.some((session) => session.id === background.id && !session.paused)
    );
    bridge.handleMessage(background, { type: "event", event: "continued" });
    assert.strictEqual(
        statuses.length,
        resumeStatusCount + 1,
        "a background resume must publish its session-list change"
    );
    assert.strictEqual(bridge.stateWaiters.size, 0, "the background resume must settle waiters synchronously");
    assert.strictEqual((await continued).sessions.find((session) => session.id === background.id).paused, false);
    bridge.handleMessage(background, { type: "event", event: "continued" });
    assert.strictEqual(statuses.length, resumeStatusCount + 1, "repeated background running status must be suppressed");
    assert.deepStrictEqual(bridge.agentStatus(), {
        ...reselectedAgentStatus,
        sessions: reselectedAgentStatus.sessions.map((session) =>
            session.id === background.id ? { ...session, paused: false } : session
        )
    });

    for (const event of ["terminated", "exited"]) {
        bridge.handleMessage(background, { type: "event", event: "stopped" });
        const beforeExit = statuses.length;
        const exited = bridge.waitForState((status) =>
            status.sessions.some((session) => session.id === background.id && !session.paused)
        );
        bridge.handleMessage(background, { type: "event", event });
        assert.strictEqual(statuses.length, beforeExit + 1, event + " must publish a background pause-state change");
        assert.strictEqual(bridge.stateWaiters.size, 0);
        assert.strictEqual((await exited).sessions.find((session) => session.id === background.id).paused, false);
    }
    bridge.dispose();
}

(async () => {
    for (const debugType of ["cortex-debug", "emberprobe"]) {
        await testBackgroundStatusBroadcasts(debugType);
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
            type: debugType,
            workspaceFolder: { uri: { toString: () => "file:///workspace" } },
            async customRequest(command, args) {
                requests.push({ command, args });
                if (command === "readMemory") {
                    const address = Number.parseInt(args.memoryReference, 16);
                    return {
                        address: args.memoryReference,
                        data: memory
                            .subarray(address - 0x20000000, address - 0x20000000 + args.count)
                            .toString("base64")
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
        assert.strictEqual(bridge.status().haltWrite, true);
        assert.strictEqual(bridge.status({ canWrite: false }).haltWrite, false);
        const pausedRequestCount = requests.length;
        await delay(MIN_DAP_INTERVAL_MS + 20);
        assert.strictEqual(
            requests.length,
            pausedRequestCount,
            "a paused target should be read only once per stop event"
        );
        readPlan = [...readPlan, { name: "y", address: 0x20000004, size: 4 }];
        bridge.refreshSnapshot();
        await delay(SNAPSHOT_INITIAL_DELAY_MS + 40);
        assert.strictEqual(samples.length, 2, "changing the watch plan while paused should refresh one snapshot");
        assert.deepStrictEqual(
            samples[1].map((item) => item.name),
            ["x", "y"]
        );
        bridge.snapshotReady = false;
        bridge.onSamples = () => {};
        bridge.onStatus = () => {};
        await bridge.prepareWriteSnapshot([{ name: "write-prime", address: 0x20000000, size: 4 }]);
        assert.strictEqual(bridge.status().snapshotReady, true);

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

        const tx = await bridge.writeAndVerify([
            { name: "x", address: 0x20000000, bytes: Uint8Array.from([9, 9, 9, 9]) }
        ]);
        assert.strictEqual(tx.halted, true);
        assert.strictEqual(tx.before.length, 1);
        assert.strictEqual(tx.after.length, 1);
        assert(requests.some((item) => item.command === "writeMemory"));
        requests.length = 0;
        await bridge.writeAndVerify([
            { name: "a", address: 0x20000000, bytes: Uint8Array.from([9, 9, 9, 9]) },
            { name: "b", address: 0x20000004, bytes: Uint8Array.from([8, 8, 8, 8]) }
        ]);
        assert.deepStrictEqual(
            requests.map((item) => item.command),
            ["readMemory", "writeMemory", "readMemory"],
            "adjacent aligned writes share one write and retain before/after verification"
        );
        assert.strictEqual(Buffer.from(requests[1].args.data, "base64").length, 8);

        // A state change while a narrow write is read back must prevent the aligned fallback write.
        for (const change of ["continued", "session-replaced", "epoch-changed"]) {
            const guarded = new DebugSessionBridge({ schedule: clock.schedule, cancel: clock.cancel, now: clock.now });
            const commands = [];
            let readCount = 0;
            const guardedSession = {
                ...session,
                async customRequest(command, args) {
                    commands.push(command);
                    if (command === "readMemory") {
                        if (++readCount === 2) {
                            if (change === "continued")
                                guarded.handleMessage(guardedSession, { type: "event", event: "continued" });
                            else if (change === "session-replaced")
                                guarded.sessions.set(guardedSession.id, { ...guardedSession });
                            else guarded.epoch++;
                        }
                        return { data: Buffer.alloc(args.count, 1).toString("base64") };
                    }
                    return { bytesWritten: Buffer.from(args.data, "base64").length };
                }
            };
            guarded.sessions.set(guardedSession.id, guardedSession);
            guarded.intentEnabled = true;
            guarded.paused = true;
            guarded.snapshotReady = true;
            guarded.capabilities = { read: true, write: true };
            await assert.rejects(
                guarded.writeAndVerify([{ name: "byte", address: 0x20000001, bytes: [9] }]),
                /Target state changed during the DAP write/
            );
            assert.deepStrictEqual(commands, ["readMemory", "writeMemory", "readMemory"], change);
            assert.strictEqual(guarded.writing, false);
            guarded.dispose();
        }

        // Narrow writes keep neighbouring bytes that DMA changes mid-transaction; dropped narrow
        // writes (Cortex-M7 byte lanes) fall back to an aligned read-modify-write.
        const pausedMemoryBridge = (dropNarrow) => {
            const ram = Buffer.from([0x11, 0x22, 0x33, 0x44]);
            const writesSeen = [];
            const memorySession = {
                ...session,
                id: "memory-" + dropNarrow,
                async customRequest(command, args) {
                    const offset = Number(args.memoryReference) - 0x20000000;
                    if (command === "readMemory")
                        return { data: ram.subarray(offset, offset + args.count).toString("base64") };
                    const data = Buffer.from(args.data, "base64");
                    writesSeen.push({ offset, length: data.length });
                    ram[3] = 0x99; // DMA updates a neighbouring byte while the target is halted
                    if (!dropNarrow || data.length === 4) data.copy(ram, offset);
                    return { bytesWritten: data.length };
                }
            };
            const memoryBridge = new DebugSessionBridge();
            memoryBridge.sessions.set(memorySession.id, memorySession);
            Object.assign(memoryBridge, { intentEnabled: true, paused: true, snapshotReady: true });
            memoryBridge.capabilities = { read: true, write: true };
            return { memoryBridge, ram, writesSeen };
        };
        {
            const { memoryBridge, ram, writesSeen } = pausedMemoryBridge(false);
            const narrow = await memoryBridge.writeAndVerify([{ name: "flag", address: 0x20000001, bytes: [0xaa] }]);
            assert.deepStrictEqual(writesSeen, [{ offset: 1, length: 1 }], "only the variable's byte is written");
            assert.deepStrictEqual([...ram], [0x11, 0xaa, 0x33, 0x99], "a concurrent DMA update survives");
            assert.deepStrictEqual([...narrow.after[0].bytes], [0xaa]);
            memoryBridge.dispose();
        }
        {
            const { memoryBridge, ram, writesSeen } = pausedMemoryBridge(true);
            await memoryBridge.writeAndVerify([{ name: "flag", address: 0x20000001, bytes: [0xaa] }]);
            assert.deepStrictEqual(writesSeen, [
                { offset: 1, length: 1 },
                { offset: 0, length: 4 }
            ]);
            assert.strictEqual(ram[1], 0xaa, "a dropped narrow write is retried as an aligned word");
            memoryBridge.dispose();
        }
        {
            // Agent writes run with live sampling off: a primed snapshot of this stop is enough.
            const { memoryBridge, ram } = pausedMemoryBridge(false);
            Object.assign(memoryBridge, { intentEnabled: false, snapshotReady: false });
            assert.strictEqual(memoryBridge.canWritePaused, false, "a paused write needs a snapshot of this stop");
            await memoryBridge.prepareWriteSnapshot([{ name: "flag", address: 0x20000001, size: 1 }]);
            assert.strictEqual(memoryBridge.canWrite, false, "sidebar writes still require live sampling");
            assert.strictEqual(memoryBridge.canWritePaused, true);
            await memoryBridge.writeAndVerify([{ name: "flag", address: 0x20000001, bytes: [0xaa] }]);
            assert.strictEqual(ram[1], 0xaa);
            memoryBridge.paused = false;
            await assert.rejects(
                memoryBridge.writeAndVerify([{ name: "flag", address: 0x20000001, bytes: [0xbb] }]),
                /must be paused/
            );
            memoryBridge.dispose();
        }
        {
            // A second writer arriving while a snapshot read drains must not interleave.
            const { memoryBridge } = pausedMemoryBridge(false);
            memoryBridge.polling = true;
            const first = memoryBridge.writeAndVerify([{ name: "a", address: 0x20000000, bytes: [1, 2, 3, 4] }]);
            assert.strictEqual(memoryBridge.writing, true, "the write is reserved before awaiting the poll");
            await assert.rejects(
                memoryBridge.writeAndVerify([{ name: "b", address: 0x20000000, bytes: [5, 6, 7, 8] }]),
                { code: "DEBUG_CONTROL_BUSY" }
            );
            memoryBridge.polling = false;
            await first;
            assert.strictEqual(memoryBridge.writing, false);
            memoryBridge.dispose();
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
        assert.strictEqual(
            optInReads,
            0,
            "a paused debug target must remain untouched until the user enables sampling"
        );
        optIn.setIntent(true);
        await delay(SNAPSHOT_INITIAL_DELAY_MS + 40);
        assert.strictEqual(optInReads, 1);
        assert.strictEqual(
            optInSamples.length,
            1,
            "enabling sampling while paused should acquire exactly one snapshot"
        );
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
        const successfulRead = retrySession.customRequest;
        retrySession.customRequest = async () => {
            throw new Error("DAP memory is unavailable");
        };
        retryBridge.refreshSnapshot();
        await delay(SNAPSHOT_INITIAL_DELAY_MS);
        assert.strictEqual(retryBridge.status().key, "live.dapRetrying");
        assert.strictEqual(retryBridge.status().canWrite, false);
        await delay(SNAPSHOT_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0) + 100);
        assert.strictEqual(retryBridge.status().key, "live.dapFailed", "status queries preserve the failure reason");
        assert.strictEqual(retryBridge.status().canWrite, false);
        retrySession.customRequest = successfulRead;
        retryBridge.refreshSnapshot();
        await delay(SNAPSHOT_INITIAL_DELAY_MS);
        assert.strictEqual(retryBridge.status().key, "live.dapReady");
        assert.strictEqual(retryBridge.status().canWrite, true);
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
    }

    await scenario("Read each block of a paused snapshot once", async () => {
        // g_peerPtr -> struct Peer { u32 magic; Peer* owner; Peer* self; u32 updates; }
        const memory = Buffer.alloc(0x20);
        memory.writeUInt32LE(0x20000010, 0);
        memory.writeUInt32LE(40679, 0x10);
        memory.writeUInt32LE(0, 0x14);
        memory.writeUInt32LE(0x20000010, 0x18);
        memory.writeUInt32LE(49086, 0x1c);
        const reads = [];
        const session = {
            id: "paused",
            type: "emberprobe",
            async customRequest(command, args) {
                assert.strictEqual(command, "readMemory");
                const offset = Number.parseInt(args.memoryReference, 16) - 0x20000000;
                reads.push([offset, args.count]);
                return {
                    address: args.memoryReference,
                    data: memory.subarray(offset, offset + args.count).toString("base64")
                };
            }
        };
        const runtimeLayout = {
            root: 0,
            types: [
                { kind: "pointer", typeName: "Peer *", target: 1, pointerTarget: "Peer", byteSize: 4 },
                {
                    kind: "class",
                    typeName: "Peer",
                    byteSize: 16,
                    fields: [
                        { name: "magic", type: 2, offset: 0 },
                        { name: "owner", type: 0, offset: 4 },
                        { name: "self", type: 0, offset: 8 },
                        { name: "updates", type: 2, offset: 12 }
                    ]
                },
                { kind: "scalar", typeName: "unsigned int", watchType: "u32", byteSize: 4 }
            ]
        };
        const bridge = new DebugSessionBridge({ schedule: clock.schedule, cancel: clock.cancel, now: clock.now });
        try {
            bridge.attach(session);
            bridge.handleMessage(session, {
                type: "response",
                command: "initialize",
                success: true,
                body: { supportsReadMemoryRequest: true }
            });
            bridge.handleMessage(session, { type: "event", event: "stopped" });
            const samples = await bridge.readPausedItems([
                { name: "g_peerPtr", address: 0x20000000, size: 4 },
                {
                    name: "g_peerPtr.value",
                    address: 0x20000000,
                    runtimeLayout,
                    runtimeSegments: [{ kind: "member", name: "value" }],
                    runtimeRanges: [{ start: 0x20000000, end: 0x20000020 }]
                }
            ]);
            const tree = samples.find((sample) => sample.name === "g_peerPtr.value").runtimeTree;
            assert.deepStrictEqual(
                tree.members.map((member) => member.name),
                ["magic", "owner", "self", "updates"]
            );
            assert.strictEqual(tree.members[0].value, 40679);
            assert.deepStrictEqual(
                reads,
                [
                    [0, 4],
                    [0x10, 16]
                ],
                "the pointer word and the object are each read once; a halted target needs no re-verification"
            );
        } finally {
            bridge.dispose();
        }
    });

    await scenario("Reject short memory reads and changed stop epochs", async () => {
        const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
        const bridge = new DebugSessionBridge();
        try {
            const session = { id: "one", customRequest: async () => ({ data: "AQ==" }) };
            bridge.sessions.set(session.id, session);
            bridge.paused = true;
            bridge.capabilities.read = true;
            await assert.rejects(bridge.readPausedMemory(0x20000000, 4), /incomplete/);
            session.customRequest = async () => {
                bridge.stopEpoch++;
                return { data: "AQIDBA==" };
            };
            await assert.rejects(
                bridge.readPausedMemory(0x20000000, 4),
                (error) => error.code === "DEBUG_STATE_CHANGED"
            );
        } finally {
            bridge.dispose();
        }
    });
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
