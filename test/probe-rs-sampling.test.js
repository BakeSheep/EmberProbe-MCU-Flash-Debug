"use strict";

const assert = require("node:assert/strict");
const { DebugSessionBridge, mergeReadPlan, SNAPSHOT_RETRY_DELAYS_MS } = require("../src/services/debugSessionBridge");
const { filterRuntimeRamPlan } = require("../src/services/liveWatchService");
const { validateManagedReadPlan } = require("../src/liveWatch");
const { FakeClock } = require("./helpers/fake-clock");

const base = 0x20000000;
const scalar = { name: "counter", address: base, size: 4 };
const sections = [{ name: ".data", addr: base, size: 0x4000, flags: 3 }];

function fixture({ interval = 50, readMs = 25, plan = [scalar], ramSections = sections, timerAvailable = true } = {}) {
    const clock = new FakeClock();
    const requests = [];
    const samples = [];
    const errors = [];
    const timerState = { acquisitions: 0, releases: 0 };
    let inFlight = 0;
    let maxInFlight = 0;
    let failReads = false;
    let afterRead = () => {};
    const session = {
        id: "probe-rs-sampling",
        type: "emberprobe-probe-rs",
        async customRequest(command, args) {
            assert.equal(command, "readMemory");
            requests.push({ command, args, time: clock.now() });
            maxInFlight = Math.max(maxInFlight, ++inFlight);
            await new Promise((resolve) => clock.schedule(resolve, readMs));
            inFlight--;
            afterRead();
            if (failReads) throw new Error("Probe read failed");
            const offset = Number(args.memoryReference) - base;
            return {
                data: Buffer.from(Array.from({ length: args.count }, (_, i) => (offset + i) & 255)).toString("base64")
            };
        }
    };
    const bridge = new DebugSessionBridge({
        schedule: clock.schedule,
        cancel: clock.cancel,
        now: clock.now,
        timerResolution: {
            acquire() {
                timerState.acquisitions++;
                return timerAvailable;
            },
            release() {
                timerState.releases++;
            }
        },
        getIntervalMs: () => interval,
        getReadPlan: () => plan,
        validateReadPlan: (items) => {
            const result = filterRuntimeRamPlan(items, ramSections);
            assert.deepEqual(result.denied, [], "every physical read must stay in validated ELF RAM");
            validateManagedReadPlan(result.allowed);
            return result;
        },
        onSamples: (value, time) => samples.push({ value, time }),
        onError: (error) => errors.push(error)
    });
    bridge.attach(session);
    bridge.setIntent(true);
    bridge.handleMessage(session, {
        type: "response",
        command: "initialize",
        success: true,
        body: { supportsReadMemoryRequest: true }
    });
    bridge.handleMessage(session, { type: "response", command: "attach", success: true });
    return {
        bridge,
        session,
        clock,
        requests,
        samples,
        errors,
        timerState,
        maxInFlight: () => maxInFlight,
        setFailure: (value) => (failReads = value),
        afterRead: (callback) => (afterRead = callback)
    };
}

async function cadence() {
    const normal = fixture();
    await normal.clock.advance(2999);
    assert.equal(normal.samples.length, 60, "25 ms reads must fit inside a 50 ms sampling period");
    assert.equal(normal.bridge.stats().actualHz, 20, "20 Hz must not become 13.3 Hz by adding read latency");
    assert.equal(normal.bridge.stats().p95DurationMs, 25);
    assert.equal(normal.bridge.stats().missedDeadlines, 0);
    assert.deepEqual(normal.timerState, { acquisitions: 1, releases: 0 }, "active cycles share one timer request");
    normal.bridge.dispose();
    assert.equal(normal.timerState.releases, 1, "disposal must restore the prior timer resolution");

    const fast = fixture({ interval: 5, readMs: 1 });
    await fast.clock.advance(999);
    assert.equal(fast.samples.length, 200, "the bridge must honor the configured 200 Hz when reads fit");
    assert.equal(fast.bridge.stats().actualHz, 200);
    assert.equal(fast.bridge.stats().effectiveIntervalMs, 5);
    assert.equal(fast.maxInFlight(), 1);
    fast.bridge.dispose();

    const slow = fixture({ interval: 5, readMs: 26 });
    await slow.clock.advance(259);
    assert.equal(slow.samples.length, 9);
    assert.ok(slow.bridge.stats().actualHz > 38 && slow.bridge.stats().actualHz < 39);
    assert.equal(slow.maxInFlight(), 1, "overruns must not queue overlapping sampling cycles");
    assert.equal(slow.bridge.stats().missedDeadlines, 8);
    slow.bridge.dispose();
}

async function batching() {
    const plan = Array.from({ length: 10 }, (_, i) => ({ name: `v${i}`, address: base + i * 16, size: 4 }));
    const batched = fixture({ plan });
    await batched.clock.advance(25);
    assert.equal(batched.requests.length, 1, "nearby RAM globals should share one DAP request");
    assert.equal(batched.requests[0].args.count, 148);
    assert.deepEqual(
        batched.samples[0].value.map((sample) => ({ name: sample.name, bytes: [...sample.bytes] })),
        plan.map((item) => ({ name: item.name, bytes: [0, 1, 2, 3].map((byte) => item.address - base + byte) }))
    );
    batched.bridge.dispose();

    const ranges = [{ start: base, end: base + 0x4000 }];
    const options = { maxGapBytes: 64, ranges };
    assert.equal(mergeReadPlan(plan).length, 10, "default and paused reads must not widen unvalidated ranges");
    assert.equal(mergeReadPlan(plan, 4096, { maxGapBytes: 64 }).length, 10);
    assert.equal(mergeReadPlan(plan, 4096, options).length, 1);
    assert.equal(mergeReadPlan([scalar, { name: "far", address: base + 69, size: 4 }], 4096, options).length, 2);
    const boundary = mergeReadPlan(plan, 4096, {
        maxGapBytes: 64,
        ranges: [
            { start: base, end: base + 4 },
            { start: base + 16, end: base + 0x4000 }
        ]
    });
    assert.equal(boundary.length, 2, "coalescing must not cross ELF RAM section boundaries");
    const large = mergeReadPlan(
        [
            { name: "block", address: base, size: 4092 },
            { name: "tail", address: base + 4096, size: 4 }
        ],
        4096,
        options
    );
    assert.equal(large.length, 2, "padding must count toward the 4096-byte request budget");
    const edge = mergeReadPlan([scalar, { name: "edge", address: base + 68, size: 4 }], 4096, options);
    assert.equal(edge.length, 1, "a 64-byte gap is within the merge limit");

    const split = fixture({
        plan: [scalar, { name: "other", address: base + 16, size: 4 }],
        ramSections: [0, 16].map((offset) => ({
            ...sections[0],
            addr: base + offset,
            size: 4
        }))
    });
    await split.clock.advance(50);
    assert.deepEqual(
        split.requests.slice(0, 2).map((request) => request.args.count),
        [4, 4]
    );
    split.bridge.dispose();

    const adjacentSections = fixture({
        plan: [scalar, { name: "adjacent", address: base + 4, size: 4 }],
        ramSections: [0, 4].map((offset) => ({ ...sections[0], addr: base + offset, size: 4 }))
    });
    await adjacentSections.clock.advance(50);
    assert.deepEqual(
        adjacentSections.requests.slice(0, 2).map((request) => request.args.count),
        [4, 4]
    );
    adjacentSections.bridge.dispose();

    const fullBudget = fixture({
        plan: [
            { name: "block", address: base, size: 4080 },
            { name: "tail", address: base + 4112, size: 16 }
        ]
    });
    await fullBudget.clock.advance(50);
    assert.deepEqual(
        fullBudget.requests.slice(0, 2).map((request) => request.args.count),
        [4080, 16],
        "combined physical reads must retain the 4096-byte cycle budget including gap bytes"
    );
    fullBudget.bridge.dispose();
}

async function retryAndCancellation() {
    const retry = fixture();
    await retry.clock.advance(25);
    retry.setFailure(true);
    await retry.clock.advance(50);
    assert.equal(retry.bridge.consecutiveErrors, 1);
    retry.setFailure(false);
    await retry.clock.advance(SNAPSHOT_RETRY_DELAYS_MS[0] + 25);
    assert.equal(retry.samples.length, 2, "a read failure after a valid snapshot must still retry");
    assert.equal(retry.bridge.consecutiveErrors, 0);
    retry.bridge.dispose();

    for (const event of ["stop", "paused", "refresh", "detach"]) {
        const state = fixture();
        await state.clock.advance(1);
        if (event === "stop") state.bridge.setIntent(false);
        if (event === "paused") state.bridge.handleMessage(state.session, { type: "event", event: "stopped" });
        if (event === "refresh") state.bridge.refreshSnapshot();
        if (event === "detach") state.bridge.detach(state.session);
        await state.clock.advance(24);
        assert.equal(state.samples.length, 0, `${event} must discard an in-flight result`);
        assert.equal(state.errors.length, 0);
        assert.equal(state.timerState.releases, 1, `${event} must release its high-resolution timer`);
        state.bridge.dispose();
        await state.clock.advance(1000);
        assert.equal(state.requests.length, 1, "disposed or stopped sampling must leave no request backlog");
    }

    const partial = fixture();
    partial.session.customRequest = async () => ({ data: "AA==", unreadableBytes: 3 });
    await partial.clock.advance(5000);
    assert.equal(partial.samples.length, 0);
    assert.equal(partial.errors.length, 1);
    assert.match(partial.errors[0].message, /invalid or incomplete/);
    assert.equal(partial.bridge.snapshotPending, false, "retries remain bounded");
    assert.equal(partial.timerState.releases, 1, "exhausted retries must release the high-resolution timer");
    partial.bridge.dispose();

    const empty = fixture({ plan: [] });
    await empty.clock.advance(1);
    assert.equal(empty.requests.length, 0);
    assert.equal(empty.timerState.releases, 1, "an empty watch plan must not retain timer resolution");
    empty.bridge.dispose();

    const unsupported = fixture();
    unsupported.bridge.handleMessage(unsupported.session, {
        type: "event",
        event: "capabilities",
        body: { capabilities: { supportsReadMemoryRequest: false } }
    });
    assert.equal(unsupported.timerState.releases, 1, "loss of read capability must release timer resolution");
    unsupported.bridge.dispose();

    const unavailable = fixture({ timerAvailable: false });
    await unavailable.clock.advance(200);
    assert.equal(unavailable.samples.length, 4, "unavailable native timers must not prevent sampling");
    unavailable.bridge.dispose();
    assert.equal(unavailable.timerState.releases, 0, "only acquired timer requests may be released");
}

async function separatedRanges() {
    const plan = Array.from({ length: 12 }, (_, index) => ({
        name: `separate${index}`,
        address: base + index * 1024,
        size: 4
    }));
    const state = fixture({ plan });
    const startedAt = state.clock.now();
    await state.clock.advance(74);
    assert.equal(state.requests.length, 12);
    assert.equal(state.samples.length, 0, "a cycle must collect the whole read plan before publishing");
    assert.equal(state.maxInFlight(), 4, "at most four separate RAM reads may be queued together");
    assert.deepEqual(
        state.requests.map((request) => request.time),
        [0, 0, 0, 0, 25, 25, 25, 25, 50, 50, 50, 50].map((offset) => startedAt + offset),
        "separate ranges must be sent in bounded batches without sequential client round trips"
    );
    await state.clock.advance(1);
    assert.equal(state.samples.length, 1);
    assert.deepEqual(
        state.samples[0].value.map((sample) => sample.name),
        plan.map((item) => item.name)
    );
    state.bridge.dispose();
    await state.clock.advance(100);
    assert.equal(state.maxInFlight(), 4, "sampling cycles must not overlap");

    const cancelled = fixture({ plan });
    await cancelled.clock.advance(1);
    cancelled.bridge.setIntent(false);
    await cancelled.clock.advance(200);
    assert.equal(cancelled.requests.length, 4, "cancellation must prevent the next batch from being queued");
    assert.equal(cancelled.samples.length, 0, "discard all results from an invalidated batch");
    assert.equal(cancelled.bridge.polling, false);
    cancelled.bridge.dispose();

    const failed = fixture({ plan });
    let completed = 0;
    let issued = 0;
    failed.session.customRequest = async () => {
        if (++issued === 1) throw new Error("First batch read failed");
        await new Promise((resolve) => failed.clock.schedule(resolve, 50));
        completed++;
        return { data: "AAAAAA==" };
    };
    await failed.clock.advance(25);
    assert.equal(failed.bridge.polling, true, "a failed request must still drain other replies in its batch");
    assert.equal(completed, 0);
    await failed.clock.advance(25);
    assert.equal(completed, 3);
    assert.equal(issued, 4, "a failed batch must not queue later ranges");
    assert.equal(failed.bridge.polling, false);
    assert.equal(failed.bridge.consecutiveErrors, 1);
    assert.equal(failed.samples.length, 0);
    failed.bridge.dispose();
}

async function main() {
    await cadence();
    await batching();
    await retryAndCancellation();
    await separatedRanges();
    console.log("probe-rs sampling cadence, bounded RAM batching, retries and cancellation tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
