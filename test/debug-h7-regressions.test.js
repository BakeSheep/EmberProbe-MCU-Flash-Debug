"use strict";
const assert = require("assert");
const { LiveWatchSession, ManagedOpenOcdSession } = require("../src/liveWatch");
const { createChipParser } = require("../src/chip/parser");

(async () => {
    let now = 0;
    const errors = [],
        statuses = [],
        disconnected = [];
    const session = new LiveWatchSession(
        null,
        { now: () => now },
        {
            onError: (error) => errors.push(error),
            onStatus: (status) => statuses.push(status),
            onDisconnect: (error) => disconnected.push(error)
        }
    );
    session.socket = {
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    };
    session.watch = [{ name: "count", address: 0x20000000, size: 4 }];
    session._readItems = async () => ({ samples: [], ok: 1 });
    const message = "[stm32h7x.cpu0] Polling failed, trying to reexamine";
    session._handlePollingFailure(message);
    await session._sampleTick();
    now = 1000;
    session._handlePollingFailure(message);
    await session._sampleTick();
    now = 3100;
    session._handlePollingFailure(message);
    assert.strictEqual(errors.length, 1, "identical polling errors are shown once");
    assert.strictEqual(statuses.length, 0, "successful RAM reads must not clear repeated target polling errors");
    assert.strictEqual(session.stopped, true);
    assert.strictEqual(disconnected[0].code, "LIVE_TARGET_POLL_FAILED");
    assert.strictEqual(session.setSamplingEnabled(true), false);

    let degraded = 0,
        killed = 0;
    now = 0;
    const managed = new ManagedOpenOcdSession(
        null,
        { mode: "debug", now: () => now },
        { onDegraded: () => degraded++ }
    );
    managed.child = { kill: () => killed++ };
    for (now of [0, 1000, 3100, 4000]) managed._handlePollingFailure(message);
    assert.strictEqual(degraded, 1);
    assert.strictEqual(killed, 0, "sampling degradation must not kill GDB's OpenOCD server");
    assert.strictEqual(managed.setSamplingEnabled(true), false);

    const parser = createChipParser("stm32h7x.cfg");
    parser.handleLine("0xe000ed00: 411fc271");
    parser.handleLine("EP_KV state unknown");
    parser.handleLine("EP_KV stateError target polling failed");
    const info = parser.finish(0);
    assert.strictEqual(info.targetState, "unknown");
    assert.strictEqual(info.stateError, "target polling failed");
    console.log("H7 polling stability and fresh chip state regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
