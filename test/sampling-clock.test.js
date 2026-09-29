"use strict";

const assert = require("assert");
const { scheduleSamplingTick } = require("../src/samplingClock");
const { createWindowsTimerResolution } = require("../src/windowsTimerResolution");

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
    console.log("Sampling clock lifecycle and cancellation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
