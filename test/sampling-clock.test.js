"use strict";

const assert = require("assert");
const { scheduleSamplingTick } = require("../src/samplingClock");
const { createWindowsTimerResolution } = require("../src/windowsTimerResolution");
const { FakeClock } = require("./helpers/fake-clock");
const { scenario } = require("./helpers/scenario");

(async () => {
    let beginCalls = 0;
    let endCalls = 0;
    const controller = createWindowsTimerResolution("win32", () => ({
        load: (name) => {
            assert.strictEqual(name, "winmm.dll");
            return {
                func: (_convention, name) =>
                    name === "timeBeginPeriod"
                        ? (period) => {
                              assert.strictEqual(period, 1);
                              beginCalls++;
                              return 0;
                          }
                        : (period) => {
                              assert.strictEqual(period, 1);
                              endCalls++;
                              return 0;
                          }
            };
        }
    }));
    assert.strictEqual(controller.acquire(), true);
    assert.strictEqual(controller.acquire(), true);
    assert.strictEqual(beginCalls, 1, "Concurrent sessions must share one resolution request");
    controller.release();
    assert.strictEqual(endCalls, 0);
    controller.release();
    controller.release();
    assert.strictEqual(endCalls, 1, "The final session must restore the prior timer resolution");

    const unavailable = createWindowsTimerResolution("win32", () => {
        throw new Error("Native timer unavailable");
    });
    assert.strictEqual(unavailable.acquire(), false);
    assert.strictEqual(unavailable.acquire(), false);
    unavailable.release();
    assert.strictEqual(
        createWindowsTimerResolution("linux", () => assert.fail("Must not load Windows FFI")).acquire(),
        false
    );

    let fired = false;
    const cancelled = scheduleSamplingTick(
        25,
        () => {
            fired = true;
        },
        { platform: "win32", highResolution: false }
    );
    cancelled.cancel();
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.strictEqual(fired, false, "Cancelled sampling must not read the target");
    await new Promise((resolve) => scheduleSamplingTick(0, resolve, { platform: "win32", highResolution: false }));

    await scenario("a late Windows timer does not control the 200 Hz deadline", async () => {
        const clock = new FakeClock();
        const { setTimeout, setImmediate, clearTimeout, clearImmediate } = global;
        try {
            global.setTimeout = (callback) => clock.schedule(callback, 15.6);
            global.setImmediate = (callback) => clock.schedule(callback, 0.25);
            global.clearTimeout = global.clearImmediate = clock.cancel;
            const nowNs = () => BigInt(Math.round(clock.now() * 1e6));
            for (const highResolution of [true, false]) {
                const started = clock.now();
                let firedAt = null;
                scheduleSamplingTick(4.5, () => (firedAt = clock.now()), { platform: "win32", highResolution, nowNs });
                await clock.advance(4);
                assert.strictEqual(firedAt, null);
                await clock.advance(1);
                assert.ok(firedAt >= started + 4.5 && firedAt <= started + 5);
            }
        } finally {
            Object.assign(global, { setTimeout, setImmediate, clearTimeout, clearImmediate });
        }
    });
    console.log("Sampling clock lifecycle and cancellation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
