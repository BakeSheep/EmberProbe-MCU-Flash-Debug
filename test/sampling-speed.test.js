"use strict";

const assert = require("assert");
const path = require("path");
const { EventEmitter } = require("events");
const { scenario } = require("./helpers/scenario");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");
const { FakeClock } = require("./helpers/fake-clock");
const { loadModule } = require("./helpers/load-module");
const { loadProvider } = require("./helpers/load-provider");
const { render } = require("./helpers/render-webview");
const openocdProcess = require("../src/openocdProcess");
const { ManagedOpenOcdSession } = loadModule("src/liveWatch.js", {
    "./openocdProcess": {
        ...openocdProcess,
        managedServerLaunch: () => ({ executable: "fake", cwd: ".", args: [] })
    }
});
const { SamplingSession } = require("../src/samplingSession");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { ProbeConnectionService } = require("../src/services/probeConnectionService");
const { RttController } = require("../src/services/rttController");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");
const { CACHE_KEYS } = require("../src/cacheKeys");
const { writeConnectionIdentity } = require("../src/writeAuthorization");
const { getLiveWatchContent } = require("../src/liveWatchView");
const {
    SAMPLING_SPEED_LADDERS_KHZ,
    DEFAULT_SPEED_LADDER_KHZ,
    configuredSamplingSpeedKhz,
    samplingSpeedLadder,
    parseAdapterSpeedKhz,
    u32ToLittleEndianHex,
    selectBenchmarkRamBlock,
    median,
    isMeaningfulImprovement,
    isSignificantSlowdown,
    midpointCandidateKhz,
    buildBenchmarkPlan,
    verifyBenchmarkReply
} = require("../src/samplingSpeed");

const RAM_BASE = 0x20000000;
const RAM_RANGES = [{ start: RAM_BASE, end: RAM_BASE + 0x10000 }];
const WATCH_ITEM = [{ name: "g_val", address: RAM_BASE + 0x100, size: 4, type: "u32" }];

async function createTunedSession({
    probe = "cmsis-dap.cfg",
    initialKhz = 1000,
    scatterVersion = "1",
    watch = WATCH_ITEM,
    ramRanges = RAM_RANGES,
    speedMap = null,
    speedReadBehavior = null,
    options = {},
    handlers = {}
} = {}) {
    const fake = new FakeOpenOcdServer();
    fake.adapterSpeedKhz = initialKhz;
    fake.scatterVersion = scatterVersion;
    fake.speedMap = speedMap;
    fake.seed(RAM_BASE, new Array(1024).fill(0x5a));
    await fake.start();

    let monoMs = 100;
    const fakeClock = new FakeClock();
    const errors = [];
    const disconnects = [];
    const clock = {
        now: () => fakeClock.now(),
        monotonicMs: () => monoMs,
        sampleNow: () => fakeClock.now() + 0.5,
        schedule: (fn, ms) => fakeClock.schedule(fn, ms),
        cancel: (id) => fakeClock.cancel(id),
        ...options.clock
    };

    let session;
    fake.onSpeedLog = (line) => session._fakeServerLog?.(line);
    fake.speedReadBehavior = (actualKhz, requestedKhz, command) => {
        const res = speedReadBehavior ? speedReadBehavior(actualKhz, requestedKhz, command) : null;
        if (res?.advanceMs) monoMs += res.advanceMs;
        else monoMs += Math.max(0.2, 2000 / Math.max(100, actualKhz));
        if (res?.timeout) {
            setImmediate(() => {
                monoMs += 600;
                void fakeClock.advance(600);
            });
        }
        return res;
    };

    session = new ManagedOpenOcdSession(
        {
            executable: "fake-openocd",
            probe,
            target: "stm32f4x.cfg",
            port: fake.port,
            intervalMs: 100,
            ...options,
            clock
        },
        {
            onError: (message) => {
                errors.push(message);
                handlers.onError?.(message);
            },
            onDisconnect: (error) => {
                disconnects.push(error);
                handlers.onDisconnect?.(error);
            },
            ...handlers
        }
    );

    session.server.start = (_launch, callbacks) => {
        session._fakeServerLog = callbacks.onLine;
        session.server.listening = true;
    };
    session.server.terminate = async () => true;
    session.server.waitForExit = async () => true;
    session._waitForTclListening = async () => {};
    session._scheduleNext = () => {};
    session.tcl.detectNoEcho = async () => {
        session.tcl.noEchoResponses = true;
        return true;
    };

    if (watch.length) session.setWatch(watch, ramRanges);

    return {
        fake,
        session,
        fakeClock,
        errors,
        disconnects,
        getMonoMs: () => monoMs,
        addMonoMs: (delta) => {
            monoMs += delta;
        },
        close: async () => {
            await session.stop(50);
            await fake.stop();
        }
    };
}

function stlinkV3Table(requestedKhz) {
    const steps = [200, 1000, 3300, 8000, 24000];
    let selected = steps[0];
    for (const step of steps) {
        if (requestedKhz >= step) selected = step;
    }
    return { actualKhz: selected };
}

(async () => {
    await scenario("pure helpers compute ladders, RAM blocks, metrics, plans and midpoints", () => {
        assert.deepStrictEqual(samplingSpeedLadder({ probe: "stlink.cfg" }), SAMPLING_SPEED_LADDERS_KHZ.stlink);
        assert.deepStrictEqual(samplingSpeedLadder({ probe: "jlink.cfg" }), SAMPLING_SPEED_LADDERS_KHZ.jlink);
        assert.deepStrictEqual(
            samplingSpeedLadder({ probe: "cmsis-dap.cfg" }),
            SAMPLING_SPEED_LADDERS_KHZ["cmsis-dap"]
        );
        assert.deepStrictEqual(
            samplingSpeedLadder({ probe: "ftdi/ft2232.cfg", profile: { family: "ftdi" } }),
            SAMPLING_SPEED_LADDERS_KHZ.ftdi
        );
        assert.deepStrictEqual(samplingSpeedLadder({ adapterFamily: "ftdi" }), SAMPLING_SPEED_LADDERS_KHZ.ftdi);
        assert.deepStrictEqual(samplingSpeedLadder({ probe: "xds110.cfg" }), SAMPLING_SPEED_LADDERS_KHZ.xds110);
        assert.deepStrictEqual(samplingSpeedLadder({ probe: "nulink.cfg" }), SAMPLING_SPEED_LADDERS_KHZ.nulink);
        assert.deepStrictEqual(
            samplingSpeedLadder({ probe: "custom.cfg", profile: { family: "stlink" } }),
            SAMPLING_SPEED_LADDERS_KHZ.stlink
        );
        assert.deepStrictEqual(samplingSpeedLadder({ probe: "unknown.cfg" }), DEFAULT_SPEED_LADDER_KHZ);

        assert.strictEqual(configuredSamplingSpeedKhz({}), 0);
        assert.strictEqual(configuredSamplingSpeedKhz({ adapterSpeedKhz: 1000 }), 1000);
        assert.strictEqual(configuredSamplingSpeedKhz({ adapterSpeedKhz: 1000, samplingAdapterSpeedKhz: 4000 }), 4000);
        assert.throws(() => configuredSamplingSpeedKhz({ samplingAdapterSpeedKhz: -5 }), {
            code: "ADAPTER_SPEED_INVALID"
        });

        assert.strictEqual(parseAdapterSpeedKhz("adapter speed: 2000 kHz\n"), 2000);
        assert.strictEqual(parseAdapterSpeedKhz("adapter speed: RCLK - adaptive"), 0);
        assert.strictEqual(parseAdapterSpeedKhz(""), 0);
        assert.strictEqual(u32ToLittleEndianHex(0x410fc241), "41c20f41");

        // RAM block selection skips runtime objects, aligns words, clamps to section bounds and enforces min size.
        assert.strictEqual(selectBenchmarkRamBlock([], RAM_RANGES), null);
        assert.strictEqual(
            selectBenchmarkRamBlock([{ name: "ptr", address: RAM_BASE, size: 4, runtimeLayout: {} }], RAM_RANGES),
            null
        );
        assert.strictEqual(
            selectBenchmarkRamBlock(
                [{ name: "tiny", address: RAM_BASE + 2, size: 4 }],
                [{ start: RAM_BASE + 2, end: RAM_BASE + 64 }]
            ),
            null
        );
        assert.deepStrictEqual(
            selectBenchmarkRamBlock(
                [{ name: "tail", address: RAM_BASE + 0xfffe, size: 2 }],
                [{ start: RAM_BASE, end: RAM_BASE + 0x10000 }]
            ),
            { address: RAM_BASE + 0xfe00, words: 128 }
        );
        assert.deepStrictEqual(
            selectBenchmarkRamBlock(
                [{ name: "small", address: RAM_BASE + 6, size: 2 }],
                [{ start: RAM_BASE + 2, end: RAM_BASE + 70 }]
            ),
            { address: RAM_BASE + 4, words: 16 }
        );

        assert.strictEqual(median([9, 2, 5]), 5);
        assert.strictEqual(median([10, 2, 4, 8]), 6);
        assert.strictEqual(median([0, -1, NaN]), null);

        assert.strictEqual(isMeaningfulImprovement(10, 9.4), true);
        assert.strictEqual(isMeaningfulImprovement(10, 9.6), true); // 4% and 0.4ms >= 0.15ms
        assert.strictEqual(isMeaningfulImprovement(1, 0.96), false); // 4% but only 0.04ms < 0.15ms
        assert.strictEqual(isMeaningfulImprovement(10, 9.8), false);
        assert.strictEqual(isSignificantSlowdown(5, 5.6), true);
        assert.strictEqual(isSignificantSlowdown(5, 5.5), false);

        assert.strictEqual(midpointCandidateKhz(8000, 12000), 10000);
        assert.strictEqual(midpointCandidateKhz(12000, 15000), 13500);
        assert.strictEqual(midpointCandidateKhz(1000, 2000), 0);

        const cpuid = 0x410fc241;
        const cpuidHex = u32ToLittleEndianHex(cpuid);
        const block = { address: RAM_BASE, words: 16 };
        const ramScatter = buildBenchmarkPlan({
            scatterReads: true,
            readCmd: "read_memory",
            ramBlock: block,
            expectedCpuid: cpuid,
            batchUnsupported: false
        });
        assert.strictEqual(ramScatter.mode, "ram-scatter");
        assert.strictEqual(verifyBenchmarkReply(ramScatter, `${cpuidHex}\n${"ab".repeat(64)}\n${cpuidHex}`), true);
        assert.strictEqual(verifyBenchmarkReply(ramScatter, `${cpuidHex}\n${"ab".repeat(64)}\n00000000`), false);

        const ramBatch = buildBenchmarkPlan({
            scatterReads: false,
            readCmd: "read_memory",
            ramBlock: block,
            expectedCpuid: cpuid,
            batchUnsupported: false
        });
        assert.strictEqual(ramBatch.mode, "ram-batch");
        assert.strictEqual(
            verifyBenchmarkReply(ramBatch, `0x410fc241\n${new Array(16).fill("0x1").join(" ")}\n0x410fc241`),
            true
        );

        const ramSingle = buildBenchmarkPlan({
            scatterReads: false,
            readCmd: "read_memory",
            ramBlock: block,
            expectedCpuid: cpuid,
            batchUnsupported: true
        });
        assert.strictEqual(ramSingle.mode, "ram-single");
        assert.strictEqual(
            verifyBenchmarkReply(ramSingle, ["0x410fc241", new Array(16).fill("0x1").join(" "), "0x410fc241"]),
            true
        );

        const cpuidScatter = buildBenchmarkPlan({
            scatterReads: true,
            readCmd: "read_memory",
            ramBlock: null,
            expectedCpuid: cpuid,
            batchUnsupported: false
        });
        assert.strictEqual(cpuidScatter.mode, "cpuid-scatter");
        assert.strictEqual(verifyBenchmarkReply(cpuidScatter, new Array(32).fill(cpuidHex).join("\n")), true);

        const cpuidBatch = buildBenchmarkPlan({
            scatterReads: false,
            readCmd: "read_memory",
            ramBlock: null,
            expectedCpuid: cpuid,
            batchUnsupported: false
        });
        assert.strictEqual(cpuidBatch.mode, "cpuid-batch");
        assert.strictEqual(verifyBenchmarkReply(cpuidBatch, new Array(8).fill("0x410fc241").join("\n")), true);

        const cpuidSingle = buildBenchmarkPlan({
            scatterReads: false,
            readCmd: "read_memory",
            ramBlock: null,
            expectedCpuid: cpuid,
            batchUnsupported: true
        });
        assert.strictEqual(cpuidSingle.mode, "cpuid-single");
        assert.strictEqual(verifyBenchmarkReply(cpuidSingle, new Array(4).fill("0x410fc241")), true);
    });

    await scenario("ST-Link V2 discrete clamp selects 4000 kHz and skips duplicate clamped steps", async () => {
        const f = await createTunedSession({
            probe: "stlink.cfg",
            initialKhz: 1800,
            speedMap: (khz) => ({ actualKhz: khz >= 4000 ? 4000 : 1800 }),
            speedReadBehavior: (actual) => ({ advanceMs: actual >= 4000 ? 3 : 8 })
        });
        try {
            await f.session.start();
            const st = f.session.stats();
            assert.strictEqual(st.adapterSpeedKhz, 4000);
            assert.strictEqual(st.baseAdapterSpeedKhz, 1800);
            assert.strictEqual(st.adaptiveSpeed.state, "tuned");
            assert.deepStrictEqual(
                st.adaptiveSpeed.testedSteps.map((s) => s.effectiveKhz),
                [4000]
            );
            assert.strictEqual(f.fake.adapterSpeedKhz, 4000);
        } finally {
            await f.close();
        }
    });

    await scenario(
        "ST-Link V3 skips intermediate duplicate 12000->8000 to reach 24000, and falls back if 24000 fails",
        async () => {
            const f = await createTunedSession({
                probe: "stlink.cfg",
                initialKhz: 200,
                speedMap: stlinkV3Table,
                speedReadBehavior: (actual) => ({ advanceMs: 24000 / Math.max(200, actual) })
            });
            try {
                await f.session.start();
                const st = f.session.stats();
                assert.strictEqual(st.adapterSpeedKhz, 24000);
                assert.strictEqual(st.adaptiveSpeed.state, "tuned");
                assert.deepStrictEqual(
                    st.adaptiveSpeed.testedSteps.map((s) => s.effectiveKhz),
                    [1000, 3300, 8000, 24000]
                );
            } finally {
                await f.close();
            }

            const f2 = await createTunedSession({
                probe: "stlink.cfg",
                initialKhz: 200,
                speedMap: stlinkV3Table,
                speedReadBehavior: (actual) => ({
                    advanceMs: 24000 / Math.max(200, actual),
                    corruptCpuid: actual === 24000
                })
            });
            try {
                await f2.session.start();
                const st = f2.session.stats();
                assert.strictEqual(st.adapterSpeedKhz, 8000);
                assert.strictEqual(st.adaptiveSpeed.state, "tuned");
                assert.strictEqual(f2.fake.adapterSpeedKhz, 8000);
            } finally {
                await f2.close();
            }
        }
    );

    await scenario("J-Link stderr clamp stops at hardware ceiling and restores exact OpenOCD clock", async () => {
        const f = await createTunedSession({
            probe: "jlink.cfg",
            initialKhz: 2000,
            speedMap: (khz) =>
                khz > 12000
                    ? {
                          actualKhz: 12000,
                          reportedKhz: khz,
                          logLine: `Info : Reduced speed from ${khz} kHz to 12000 kHz (maximum).`
                      }
                    : { actualKhz: khz },
            speedReadBehavior: (actual) => ({ advanceMs: 20000 / actual })
        });
        try {
            await f.session.start();
            const st = f.session.stats();
            assert.strictEqual(st.adapterSpeedKhz, 12000);
            assert.strictEqual(st.adaptiveSpeed.reason, "driver_clamped");
            assert.strictEqual(f.fake.adapterSpeedKhz, 12000);
            assert.strictEqual(f.fake._reportedSpeedKhz, 12000);
        } finally {
            await f.close();
        }

        const ob = await createTunedSession({
            probe: "jlink.cfg",
            initialKhz: 1000,
            speedMap: (khz) =>
                khz > 6000
                    ? {
                          actualKhz: 6000,
                          reportedKhz: khz,
                          logLine: `Info : Reduced speed from ${khz} kHz to 6000 kHz (maximum).`
                      }
                    : { actualKhz: khz },
            speedReadBehavior: (actual) => ({ advanceMs: 12000 / actual })
        });
        try {
            await ob.session.start();
            const st = ob.session.stats();
            assert.strictEqual(st.adapterSpeedKhz, 6000);
            assert.strictEqual(st.adaptiveSpeed.reason, "driver_clamped");
            assert.strictEqual(ob.fake.adapterSpeedKhz, 6000);
            assert.strictEqual(ob.fake._reportedSpeedKhz, 6000);
        } finally {
            await ob.close();
        }
    });

    await scenario("CMSIS-DAP stops on throughput plateau and locks lowest peak speed", async () => {
        const f = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 1000,
            speedReadBehavior: (actual) => ({
                advanceMs: actual <= 2000 ? 8 : actual <= 4000 ? 5 : actual <= 8000 ? 3 : 2.95
            })
        });
        try {
            await f.session.start();
            const st = f.session.stats();
            assert.strictEqual(st.adapterSpeedKhz, 8000);
            assert.strictEqual(st.adaptiveSpeed.reason, "plateau");
            assert.ok(!st.adaptiveSpeed.testedSteps.some((s) => s.requestedKhz === 20000));
            assert.strictEqual(f.fake.adapterSpeedKhz, 8000);
        } finally {
            await f.close();
        }
    });

    await scenario("CMSIS-DAP instability refines midpoint on read error or driver reject", async () => {
        const f = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 2000,
            speedReadBehavior: (actual) => ({
                advanceMs: 24000 / actual,
                corruptCpuid: actual > 10000
            })
        });
        try {
            await f.session.start();
            const st = f.session.stats();
            assert.strictEqual(st.adapterSpeedKhz, 10000);
            assert.strictEqual(st.adaptiveSpeed.state, "tuned");
            assert.strictEqual(f.fake.adapterSpeedKhz, 10000);
        } finally {
            await f.close();
        }

        const rejected = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 2000,
            speedMap: (khz) => (khz >= 12000 ? { reject: true } : { actualKhz: khz }),
            speedReadBehavior: (actual) => ({ advanceMs: 24000 / actual })
        });
        try {
            await rejected.session.start();
            const st = rejected.session.stats();
            assert.strictEqual(st.adapterSpeedKhz, 10000);
            assert.strictEqual(st.adaptiveSpeed.state, "tuned");
            assert.strictEqual(rejected.fake.adapterSpeedKhz, 10000);
        } finally {
            await rejected.close();
        }

        const bothFail = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 2000,
            speedReadBehavior: (actual) => ({
                advanceMs: 24000 / actual,
                fail: actual > 8000
            })
        });
        try {
            await bothFail.session.start();
            const st = bothFail.session.stats();
            assert.strictEqual(st.adapterSpeedKhz, 8000);
            assert.strictEqual(st.adaptiveSpeed.reason, "stability_limit");
        } finally {
            await bothFail.close();
        }
    });

    await scenario("SWD WAIT slowdown stops immediately and restores faster verified clock", async () => {
        const f = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 2000,
            speedReadBehavior: (actual) => ({
                advanceMs: actual === 2000 ? 10 : actual === 4000 ? 5 : actual === 8000 ? 3 : 4
            })
        });
        try {
            await f.session.start();
            const st = f.session.stats();
            assert.strictEqual(st.adapterSpeedKhz, 8000);
            assert.strictEqual(st.adaptiveSpeed.reason, "slowdown");
            assert.strictEqual(f.fake.adapterSpeedKhz, 8000);
        } finally {
            await f.close();
        }
    });

    await scenario(
        "tentative target errors and timeouts recover safely while USB transport loss still aborts",
        async () => {
            const f = await createTunedSession({
                probe: "cmsis-dap.cfg",
                initialKhz: 2000,
                speedReadBehavior: (actual) =>
                    actual >= 12000
                        ? {
                              advanceMs: 1,
                              logLine: "Error: target communication error\nPolling failed",
                              fail: true
                          }
                        : { advanceMs: 24000 / actual }
            });
            try {
                await f.session.start();
                assert.strictEqual(f.errors.length, 0);
                assert.strictEqual(f.disconnects.length, 0);
                assert.strictEqual(f.session.stopped, false);
                assert.strictEqual(f.session.stats().adapterSpeedKhz, 10000);
            } finally {
                await f.close();
            }

            let timedOut = false;
            const timeoutSession = await createTunedSession({
                probe: "cmsis-dap.cfg",
                initialKhz: 2000,
                speedReadBehavior: (actual) => {
                    if (actual === 12000 && !timedOut) {
                        timedOut = true;
                        return { timeout: true };
                    }
                    return { advanceMs: 24000 / actual, corruptCpuid: actual > 8000 };
                }
            });
            try {
                await timeoutSession.session.start();
                assert.strictEqual(timeoutSession.disconnects.length, 0);
                assert.strictEqual(timeoutSession.session.stopped, false);
                assert.strictEqual(timeoutSession.session.tcl.connected, true);
                assert.strictEqual(timeoutSession.session.stats().adapterSpeedKhz, 8000);
            } finally {
                await timeoutSession.close();
            }

            const usbLoss = await createTunedSession({
                probe: "cmsis-dap.cfg",
                initialKhz: 2000,
                speedReadBehavior: (actual) =>
                    actual === 4000 ? { logLine: "LIBUSB_ERROR_NO_DEVICE", fail: true } : { advanceMs: 10000 / actual }
            });
            try {
                await assert.rejects(usbLoss.session.start(), (error) => error?.i18nKey === "live.probeDisconnected");
                assert.strictEqual(usbLoss.session.stopped, true);
            } finally {
                await usbLoss.close();
            }
        }
    );

    await scenario(
        "eligibility checks respect explicit configs, debug mode, disabled flag, target/transport and deferred examine",
        async () => {
            for (const [opts, reason, expectedSpeed] of [
                [{ samplingAdapterSpeedKhz: 4000 }, "explicit_config", 4000],
                [{ adapterSpeedKhz: 1500 }, "explicit_config", 1500],
                [{ mode: "debug", gdbPort: 13333 }, "debug_mode", null],
                [{ adaptiveAdapterSpeed: false }, "disabled", null]
            ]) {
                const f = await createTunedSession({ options: opts });
                try {
                    await f.session.start();
                    const st = f.session.stats();
                    assert.strictEqual(st.adaptiveSpeed.state, "disabled");
                    assert.strictEqual(st.adaptiveSpeed.reason, reason);
                    assert.strictEqual(st.adapterSpeedKhz, expectedSpeed);
                    assert.ok(!f.fake.commands.some((c) => c.startsWith("adapter speed")));
                } finally {
                    await f.close();
                }
            }

            for (const [targetType, transport] of [
                ["riscv", "jtag"],
                ["cortex_m", "jtag"]
            ]) {
                const f = await createTunedSession();
                f.fake.targetType = targetType;
                f.fake.transport = transport;
                try {
                    await f.session.start();
                    assert.strictEqual(f.session.stats().adaptiveSpeed.state, "ineligible");
                    assert.strictEqual(f.session.stats().adaptiveSpeed.reason, "unsupported_target_or_transport");
                } finally {
                    await f.close();
                }
            }

            const deferred = await createTunedSession({ initialKhz: 1000 });
            deferred.fake.targetNotExamined = true;
            try {
                await deferred.session.start();
                assert.strictEqual(deferred.session.stats().adaptiveSpeed.state, "pending");
                assert.strictEqual(deferred.session._speedTuner.shouldRecheckAfterFirstCycle(), true);
                deferred.fake.targetNotExamined = false;
                await deferred.session._sampleTick();
                assert.strictEqual(deferred.session.stats().adaptiveSpeed.state, "tuned");
                assert.ok(deferred.session.stats().adapterSpeedKhz > 1000);
            } finally {
                await deferred.close();
            }
        }
    );

    await scenario(
        "pure CPUID fallback works across scatter, batch, single and failed baseline RAM paths",
        async () => {
            for (const [scatterVersion, rejectBatchCommand, expectedPrefix] of [
                ["1", false, "emberprobe_read_scatter {0xe000ed00"],
                [null, false, "join [list [read_memory 0xe000ed00"],
                [null, true, "read_memory 0xe000ed00 32 1"]
            ]) {
                const f = await createTunedSession({
                    scatterVersion,
                    ramRanges: [],
                    speedReadBehavior: (actual) => ({ advanceMs: 12000 / actual })
                });
                f.fake.rejectBatchCommand = rejectBatchCommand;
                try {
                    await f.session.start();
                    assert.strictEqual(f.session.stats().adaptiveSpeed.state, "tuned");
                    assert.ok(f.fake.commands.some((cmd) => cmd.startsWith(expectedPrefix)));
                } finally {
                    await f.close();
                }
            }

            const ramFail = await createTunedSession({
                scatterVersion: "1",
                ramRanges: RAM_RANGES,
                speedReadBehavior: (actual, _req, cmd) => ({
                    advanceMs: 12000 / actual,
                    fail: cmd.includes("0x20000")
                })
            });
            try {
                await ramFail.session.start();
                assert.strictEqual(ramFail.session.stats().adaptiveSpeed.state, "tuned");
                assert.ok(
                    ramFail.fake.commands.some((c) =>
                        c.startsWith("emberprobe_read_scatter {0xe000ed00 32 1} {0xe000ed00")
                    )
                );
            } finally {
                await ramFail.close();
            }
        }
    );

    await scenario("time budget cap stops climbing and locks best verified clock", async () => {
        const f = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 1000,
            speedReadBehavior: (actual) => ({ advanceMs: actual === 1000 ? 150 : actual === 2000 ? 60 : 10 })
        });
        try {
            await f.session.start();
            const st = f.session.stats();
            assert.strictEqual(st.adaptiveSpeed.reason, "budget_reached");
            assert.strictEqual(st.adapterSpeedKhz, 2000);
            assert.ok(!st.adaptiveSpeed.testedSteps.some((s) => s.requestedKhz === 8000));
        } finally {
            await f.close();
        }
    });

    await scenario("runtime adaptive step-down drops one notch then baseKhz and never steps back up", async () => {
        let failReads = false;
        const f = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 1000,
            speedReadBehavior: (actual) => ({
                advanceMs: actual >= 8000 ? 2 : actual >= 4000 ? 4 : 8,
                fail: failReads,
                errorMessage: "scatter memory read failed (-4)"
            })
        });
        try {
            await f.session.start();
            assert.strictEqual(f.session.stats().adapterSpeedKhz, 8000);
            f.session.setSamplingEnabled(true);
            f.session._recordCycle(2, true);
            assert.strictEqual(f.session._recentDurations.length, 1);

            // Failed stepDown must not burn the one-notch fallback.
            f.fake.speedMap = (khz) => (khz === 4000 ? { reject: true } : { actualKhz: khz });
            failReads = true;
            await f.session._sampleTick();
            await f.session._sampleTick();
            assert.strictEqual(f.session.stats().adapterSpeedKhz, 8000);

            f.fake.speedMap = null;
            await f.session._sampleTick();
            await f.session._sampleTick();
            failReads = false;
            assert.strictEqual(f.session.stats().adapterSpeedKhz, 4000);
            assert.strictEqual(f.session.stats().adaptiveSpeed.state, "fallback");
            assert.strictEqual(f.session._recentDurations.length, 0);

            // Two polling failures request step-down before the next tick and drop to baseKhz.
            f.session._handlePollingFailure("Polling failed");
            f.session._handlePollingFailure("Polling failed");
            await f.session._sampleTick();
            assert.strictEqual(f.session.stats().adapterSpeedKhz, 1000);
            assert.strictEqual(f.session._pollFailureCount, 0);

            // Subsequent successes never step back up.
            for (let i = 0; i < 5; i++) await f.session._sampleTick();
            assert.strictEqual(f.session.stats().adapterSpeedKhz, 1000);
        } finally {
            await f.close();
        }
    });

    await scenario("caller wiring, Worker forwarding and write-authorization identity invariants hold", async () => {
        const fallback = Object.create(SamplingSession.prototype);
        fallback.options = { intervalMs: 5 };
        fallback.mode = "standalone";
        assert.strictEqual(fallback.stats().adapterSpeedKhz, null);
        assert.strictEqual(fallback.stats().baseAdapterSpeedKhz, null);
        assert.strictEqual(fallback.stats().adaptiveSpeed, null);

        const workerSession = new SamplingSession(
            { intervalMs: 20 },
            {},
            path.join(__dirname, "helpers/sampling-worker-fixture.js")
        );
        try {
            await workerSession.start();
            const stats = (await workerSession.request("stats")).result;
            assert.strictEqual(stats.adapterSpeedKhz, null);
            assert.strictEqual(stats.adaptiveSpeed.state, "pending");
        } finally {
            await workerSession.stop();
        }

        const { run: runWorker } = require("../src/samplingWorker");
        const port = new EventEmitter();
        const messages = [];
        port.postMessage = (message) => messages.push(message);
        let workerInnerSession;
        runWorker(port, { adaptiveAdapterSpeed: false }, (options, handlers) => {
            workerInnerSession = new ManagedOpenOcdSession(options, handlers);
            return workerInnerSession;
        });
        port.emit("message", { id: 1, method: "stats", args: [] });
        await new Promise((resolve) => setImmediate(resolve));
        const statsMsg = messages.find((m) => m.id === 1);
        assert.strictEqual(statsMsg.result.adaptiveSpeed.state, "disabled");
        assert.strictEqual(statsMsg.result.adaptiveSpeed.reason, "disabled");
        await workerInnerSession.stop();
        port.emit("close");

        const createdOptions = [];
        class FakeSession {
            constructor(options) {
                createdOptions.push(options);
                this.options = options;
                this.stopped = false;
            }
            async start() {}
            async stop() {
                this.stopped = true;
                return true;
            }
            async readOnce() {
                return [{ name: "v", bytes: [1, 0, 0, 0] }];
            }
            stats() {
                return {
                    adapterSpeedKhz: 12000,
                    adaptiveSpeed: { state: "tuned", baseKhz: 2000, effectiveKhz: 12000 }
                };
            }
        }
        const vscode = {
            debug: {},
            workspace: { getConfiguration: () => ({ get: (_k, fb) => fb }) }
        };
        const Provider = loadProvider(vscode, { "./liveWatch": { ManagedOpenOcdSession: FakeSession } });
        const provider = Object.create(Provider.prototype);
        const stateMap = new Map([
            [CACHE_KEYS.debugger, "cmsis-dap.cfg"],
            [CACHE_KEYS.mcuCore, "stm32f4x.cfg"]
        ]);
        const connection = {
            probe: "cmsis-dap.cfg",
            target: "stm32f4x.cfg",
            transport: "swd",
            probeSerial: "123",
            adapterSpeedKhz: 0,
            samplingAdapterSpeedKhz: 0,
            selectionIdentity: { kind: "usb", family: "cmsis-dap", serial: "123" },
            settingsIdentity: {
                probe: "cmsis-dap.cfg",
                target: "stm32f4x.cfg",
                transport: "swd",
                probeSerial: "",
                adapterSpeedKhz: 0,
                openocd: "fake-openocd"
            }
        };
        const connService = new ProbeConnectionService({
            getConfig: () => ({
                probe: "cmsis-dap.cfg",
                target: "stm32f4x.cfg",
                transport: "swd",
                adapterSpeedKhz: 0,
                samplingAdapterSpeedKhz: 0,
                openocdPath: "fake-openocd"
            }),
            prepareConnection: async () => connection
        });
        Object.assign(provider, {
            _context: { workspaceState: { get: (k) => stateMap.get(k) } },
            _probeCoordinator: new ProbeCoordinator(),
            _samplingCoordinator: new SamplingCoordinator(),
            _debugBridge: { hasSession: false, agentStatus: () => ({ state: "none" }) },
            _resolveOpenOcdPath: async () => "fake-openocd",
            _probeConnectionService: connService,
            _resolveTclPort: async () => 6666,
            _commandContext: () => ({ cwd: "." }),
            _postSamplingStatus: () => {},
            _t: (k) => k
        });
        await provider._agentOps.withProbe(async () => "ok", { total: 1 });
        assert.strictEqual(createdOptions.at(-1).adaptiveAdapterSpeed, false);
        await provider._agentOps.withProbe(async () => "ok", { total: 10 });
        assert.strictEqual(createdOptions.at(-1).adaptiveAdapterSpeed, true);

        const rttHost = {
            debugLaunch: { managedServer: null, starting: false, liveSession: () => null },
            _sampling: { running: false, session: null },
            _probeCoordinator: new ProbeCoordinator(),
            _context: { workspaceState: { get: (k) => stateMap.get(k) } },
            _resolveOpenOcdPath: async () => "fake-openocd",
            _probeConnectionService: { prepare: async () => ({}) },
            _commandContext: () => ({ cwd: "." }),
            _resolveTclPort: async () => 6666,
            _downloadRunning: false,
            _chipInfoRunning: false
        };
        const rtt = new RttController(rttHost, { vscode, ManagedOpenOcdSession: FakeSession });
        await rtt._startOwnSession();
        assert.strictEqual(createdOptions.at(-1).adaptiveAdapterSpeed, false);

        // LiveWatchController status forwarding and write-authorization invariance.
        const session = new FakeSession(connection);
        provider._sampling.session = session;
        const status = provider._sampling.status();
        assert.strictEqual(status.adapterSpeedKhz, 12000);
        assert.strictEqual(status.adaptiveSpeed.state, "tuned");
        assert.strictEqual(writeConnectionIdentity(session.options).adapterSpeedKhz, 0);
        assert.doesNotThrow(() => connService.assertCurrent(session));
    });

    await scenario("liveWatch webview tooltip displays SWD speed only when positive", () => {
        const graph = render(getLiveWatchContent({ panelId: 1 }, "en"));
        try {
            graph.assertHealthy();
            const rate = graph.document.getElementById("rate");
            graph.send({
                type: "liveStatus",
                running: true,
                actualHz: 180,
                bytesPerSecond: 1440,
                effectiveIntervalMs: 0,
                p95DurationMs: 2.1,
                unlimitedActive: true,
                limitedBy: "probe",
                hostHoldMs: 0,
                adapterSpeedKhz: 12000
            });
            assert.ok(rate.title.includes("SWD: 12000 kHz"));

            graph.send({
                type: "liveStatus",
                running: true,
                actualHz: 30,
                bytesPerSecond: 240,
                effectiveIntervalMs: 33,
                p95DurationMs: 2.1,
                missedDeadlines: 0,
                unlimitedActive: false,
                adapterSpeedKhz: 4000
            });
            assert.ok(rate.title.includes("SWD: 4000 kHz"));

            graph.send({
                type: "liveStatus",
                running: true,
                actualHz: 30,
                bytesPerSecond: 240,
                effectiveIntervalMs: 33,
                p95DurationMs: 2.1,
                missedDeadlines: 0,
                unlimitedActive: false,
                adapterSpeedKhz: null
            });
            assert.ok(!rate.title.includes("SWD:"));
        } finally {
            graph.close();
        }
    });

    console.log("Adaptive sampling speed tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
