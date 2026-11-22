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

    await scenario("Windows sleeps with a fine timer and keeps the coarse fallback", async () => {
        for (const highResolution of [true, false]) {
            const fake = new FakeClock();
            const sleeps = [];
            let firstYieldAt;
            const clock = {
                monotonicMs: fake.now,
                schedule(callback, delay) {
                    sleeps.push(delay);
                    return fake.schedule(callback, highResolution ? delay : 15.6);
                },
                immediate(callback) {
                    firstYieldAt ??= fake.now();
                    return fake.schedule(callback, 0.25);
                },
                cancel: fake.cancel,
                cancelImmediate: fake.cancel
            };
            const options = { platform: "win32", highResolution, clock };
            const started = fake.now();
            let firedAt = null;
            scheduleSamplingTick(4.5, () => (firedAt = fake.now()), options);
            await fake.advance(4);
            assert.strictEqual(firedAt, null, "an early wake must not read before the deadline");
            await fake.advance(1);
            assert.ok(firedAt >= started + 4.5 && firedAt <= started + 5);
            assert.deepStrictEqual(sleeps, highResolution ? [3] : []);
            assert.strictEqual(firstYieldAt, started + (highResolution ? 3 : 0));

            const timer = scheduleSamplingTick(5, () => assert.fail("cancelled timer fired"), options);
            await fake.advance(4);
            timer.cancel();
            await fake.advance(10);
        }
    });
    console.log("Sampling clock lifecycle and cancellation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
