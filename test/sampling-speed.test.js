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
const { createLivePanelHandler } = require("../src/controllers/livePanelRoutes");
const {
    SAMPLING_SPEED_LADDERS_KHZ,
    DEFAULT_SPEED_LADDER_KHZ,
    MIN_MANUAL_SAMPLING_SPEED_KHZ,
    MAX_MANUAL_SAMPLING_SPEED_KHZ,
    MANUAL_SAMPLING_SPEED_STEP_KHZ,
    configuredSamplingSpeedKhz,
    samplingSpeedLadder,
    clampManualSamplingSpeedKhz,
    isValidManualSamplingSpeedKhz,
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
    unlimited = true,
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
            adaptiveAdapterSpeed: "sampling",
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

    if (watch.length) {
        session.setSamplingPlan({
            graphItems: watch,
            ramSectionRanges: ramRanges,
            graphIntervalMs: session.targetIntervalMs,
            unlimited
        });
    }

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
        assert.deepStrictEqual(
            [MIN_MANUAL_SAMPLING_SPEED_KHZ, MAX_MANUAL_SAMPLING_SPEED_KHZ, MANUAL_SAMPLING_SPEED_STEP_KHZ],
            [1000, 20000, 1000]
        );
        assert.strictEqual(clampManualSamplingSpeedKhz(1800), 2000);
        assert.strictEqual(clampManualSamplingSpeedKhz(500), 1000);
        assert.strictEqual(clampManualSamplingSpeedKhz(24000), 20000);
        assert.strictEqual(clampManualSamplingSpeedKhz(null), 2000);
        assert.strictEqual(isValidManualSamplingSpeedKhz(1000), true);
        assert.strictEqual(isValidManualSamplingSpeedKhz(12000), true);
        assert.strictEqual(isValidManualSamplingSpeedKhz(20000), true);
        assert.strictEqual(isValidManualSamplingSpeedKhz(1500), false);
        assert.strictEqual(isValidManualSamplingSpeedKhz(500), false);
        assert.strictEqual(isValidManualSamplingSpeedKhz(24000), false);
        assert.strictEqual(isValidManualSamplingSpeedKhz("1000"), false);

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
        assert.strictEqual(isMeaningfulImprovement(10, 9.6), false); // Only 4% despite saving 0.4 ms.
        assert.strictEqual(isMeaningfulImprovement(1, 0.9), false); // Only 0.1 ms despite saving 10%.
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

    await scenario("successive small improvements keep the lowest effective clock on a plateau", async () => {
        const durations = { 2000: 12, 4000: 8, 7000: 5, 8000: 4.85, 9000: 4.71 };
        const effectiveClocks = { 8000: 7000, 12000: 8000, 16000: 9000 };
        const f = await createTunedSession({
            initialKhz: 2000,
            speedMap: (requested) => ({ actualKhz: effectiveClocks[requested] ?? requested }),
            speedReadBehavior: (actual) => ({ advanceMs: durations[actual] ?? 4 })
        });
        try {
            await f.session.start();
            const { adaptiveSpeed, adapterSpeedKhz } = f.session.stats();
            assert.deepStrictEqual(
                adaptiveSpeed.testedSteps.map((step) => step.effectiveKhz),
                [4000, 7000, 8000, 9000]
            );
            assert.strictEqual(isMeaningfulImprovement(5, 4.71), true, "cumulative gain alone would promote 9 MHz");
            assert.strictEqual(adaptiveSpeed.reason, "plateau");
            assert.strictEqual(adapterSpeedKhz, 7000);
            assert.strictEqual(f.fake.adapterSpeedKhz, 7000);
        } finally {
            await f.close();
        }
    });

    await scenario(
        "capped sampling keeps the first clock that fits its read budget and retunes when the cap changes",
        async () => {
            const f = await createTunedSession({
                initialKhz: 2000,
                unlimited: false,
                options: { intervalMs: 5 },
                speedReadBehavior: (actual) => ({ advanceMs: actual <= 2000 ? 4.4 : actual <= 4000 ? 4.2 : 2 })
            });
            try {
                await f.session.start();
                const checkClock = (khz, reason, testedSteps) => {
                    const stats = f.session.stats();
                    assert.strictEqual(stats.adapterSpeedKhz, khz);
                    assert.strictEqual(f.fake.adapterSpeedKhz, khz);
                    assert.strictEqual(stats.adaptiveSpeed.reason, reason);
                    assert.deepStrictEqual(
                        stats.adaptiveSpeed.testedSteps.map((step) => step.requestedKhz),
                        testedSteps
                    );
                };
                checkClock(4000, "target_reached", [4000]);
                assert.ok(!f.fake.commands.includes("adapter speed 8000"));

                const plan = { graphItems: WATCH_ITEM, ramSectionRanges: RAM_RANGES, graphIntervalMs: 5 };
                f.session.setSamplingPlan({ ...plan, unlimited: true });
                await f.session._sampleTick();
                checkClock(8000, "plateau", [4000, 8000, 12000, 16000]);

                f.session.setSamplingPlan({ ...plan, unlimited: false });
                await f.session._sampleTick();
                checkClock(4000, "target_reached", [4000]);

                f.session.setIntervalMs(10);
                await f.session._sampleTick();
                checkClock(2000, "target_reached", []);
                const clockChanges = () => f.fake.commands.filter((cmd) => cmd.startsWith("adapter speed ")).length;
                const changes = clockChanges();
                await f.session._sampleTick();
                assert.strictEqual(clockChanges(), changes);
            } finally {
                await f.close();
            }
        }
    );

    await scenario("the unlimited flag still uses the sidebar budget when the graph has no watches", async () => {
        const f = await createTunedSession({
            initialKhz: 2000,
            watch: [],
            speedReadBehavior: () => ({ advanceMs: 10 })
        });
        try {
            f.session.setSamplingPlan({ sidebarItems: WATCH_ITEM, graphIntervalMs: 5, unlimited: true });
            await f.session.start();
            const stats = f.session.stats();
            assert.strictEqual(stats.unlimitedActive, false);
            assert.strictEqual(stats.targetIntervalMs, 50);
            assert.strictEqual(stats.adapterSpeedKhz, 2000);
            assert.strictEqual(stats.adaptiveSpeed.reason, "target_reached");
            assert.deepStrictEqual(stats.adaptiveSpeed.testedSteps, []);
        } finally {
            await f.close();
        }
    });

    await scenario("20 to 200 Hz uses the measured frame cost immediately after tuning", async () => {
        let readsAt4000 = 0;
        const f = await createTunedSession({
            initialKhz: 2000,
            unlimited: false,
            options: { intervalMs: 50 },
            speedReadBehavior: (actual, _requested, command) => {
                if (!command.includes("0x20000100")) return { advanceMs: 0.5 };
                if (actual === 2000) return { advanceMs: 8 };
                // One slow measurement makes 4000 kHz miss the mean budget, despite a passing median.
                if (actual === 4000 && ++readsAt4000 === 3) return { advanceMs: 9 };
                return { advanceMs: actual === 4000 ? 3 : 0.5 };
            }
        });
        try {
            await f.session.start();
            assert.strictEqual(f.session.stats().effectiveIntervalMs, 50);
            assert.strictEqual(f.fake.adapterSpeedKhz, 2000);
            const delays = [];
            f.session._scheduleNext = (delay) => delays.push(delay);
            await f.session._sampleTick(true);

            f.session.setIntervalMs(5);
            await f.session._sampleTick(true);
            assert.strictEqual(f.fake.adapterSpeedKhz, 8000);
            assert.strictEqual(f.session.stats().effectiveIntervalMs, 5);
            assert.strictEqual(delays.at(-1), 4.5, "no 100 ms warm-up or old 20 Hz deadline");
            assert.strictEqual(f.session.stats().actualHz, 0, "the 20 Hz points are out of the new rate window");

            for (let frame = 0; frame < 220; frame++) {
                f.addMonoMs(delays.at(-1));
                await f.session._sampleTick(true);
                assert.strictEqual(f.session.stats().actualHz, 200);
            }
        } finally {
            await f.close();
        }
    });

    await scenario("capped tuning times the watch plan and rechecks when the amount of data changes", async () => {
        for (const scatterVersion of ["1", null]) {
            const f = await createTunedSession({
                initialKhz: 2000,
                scatterVersion,
                unlimited: false,
                options: { intervalMs: 5 },
                speedReadBehavior: (actual, _requested, cmd) => ({
                    advanceMs: /0x20000100 32 64\b/.test(cmd) ? (actual === 2000 ? 7 : 3) : 2
                })
            });
            try {
                await f.session.start();
                assert.strictEqual(f.fake.adapterSpeedKhz, 2000);
                assert.ok(f.fake.commands.some((cmd) => /0x20000100 32 1\b/.test(cmd)));
                assert.ok(!f.fake.commands.some((cmd) => cmd.startsWith("adapter speed ")));

                f.session.setSamplingPlan({
                    graphItems: [{ ...WATCH_ITEM[0], size: 256 }],
                    graphIntervalMs: 5,
                    ramSectionRanges: RAM_RANGES
                });
                await f.session._sampleTick();
                assert.strictEqual(f.fake.adapterSpeedKhz, 4000);
                assert.strictEqual(f.session.stats().adaptiveSpeed.reason, "target_reached");
                assert.deepStrictEqual(
                    f.session.stats().adaptiveSpeed.testedSteps.map((step) => step.requestedKhz),
                    [4000]
                );
            } finally {
                await f.close();
            }
        }
    });

    await scenario("a capped candidate must successfully read the watch plan before it is selected", async () => {
        const f = await createTunedSession({
            initialKhz: 2000,
            unlimited: false,
            options: { intervalMs: 5 },
            speedReadBehavior: (actual, _requested, cmd) => ({
                advanceMs: actual === 2000 ? 8 : 2,
                fail: actual > 2000 && cmd.includes("0x20000100")
            })
        });
        try {
            await f.session.start();
            const { adapterSpeedKhz, adaptiveSpeed } = f.session.stats();
            assert.strictEqual(adapterSpeedKhz, 2000);
            assert.strictEqual(f.fake.adapterSpeedKhz, 2000);
            assert.strictEqual(adaptiveSpeed.reason, "stability_limit");
            assert.deepStrictEqual(
                adaptiveSpeed.testedSteps.map(({ requestedKhz, ok }) => [requestedKhz, ok]),
                [
                    [4000, false],
                    [3000, false]
                ]
            );
            assert.strictEqual(f.session.samplingEnabled, true);
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
                [{ adaptiveAdapterSpeed: false }, "disabled", null],
                [{ adaptiveAdapterSpeed: undefined }, "disabled", null]
            ]) {
                const f = await createTunedSession({ options: opts });
                try {
                    await f.session.start();
                    const st = f.session.stats();
                    assert.strictEqual(st.adaptiveSpeed.state, "disabled");
                    assert.strictEqual(st.adaptiveSpeed.reason, reason);
                    assert.strictEqual(st.adapterSpeedKhz, expectedSpeed);
                    assert.ok(!f.fake.commands.some((c) => c.startsWith("adapter speed")));
                    assert.ok(!f.fake.commands.some((c) => /target current|0xe000ed00/i.test(c)));
                } finally {
                    await f.close();
                }
            }

            for (const [targetType, transport] of [
                ["riscv", "jtag"],
                ["cortex_a", "swd"],
                ["cortex_m", "jtag"]
            ]) {
                const f = await createTunedSession();
                f.fake.targetType = targetType;
                f.fake.transport = transport;
                try {
                    await f.session.start();
                    assert.strictEqual(f.session.stats().adaptiveSpeed.state, "ineligible");
                    assert.strictEqual(f.session.stats().adaptiveSpeed.reason, "unsupported_target_or_transport");
                    assert.ok(!f.fake.commands.some((command) => /0xe000ed00|adapter speed/i.test(command)));
                } finally {
                    await f.close();
                }
            }

            let failSample = true;
            const deferred = await createTunedSession({
                initialKhz: 1000,
                speedReadBehavior: (_actual, _requested, command) => ({
                    fail: failSample && /0x20000/i.test(command)
                })
            });
            deferred.fake.targetNotExamined = true;
            try {
                await deferred.session.start();
                assert.strictEqual(deferred.session.stats().adaptiveSpeed.state, "pending");
                assert.strictEqual(deferred.session._speedTuner.shouldRecheckAfterFirstCycle(), true);
                const countEligibility = () =>
                    deferred.fake.commands.filter((command) => command.startsWith("set _ep_t")).length;
                for (let i = 0; i < 3; i++) await deferred.session._sampleTick();
                assert.strictEqual(countEligibility(), 1, "failed sample cycles do not re-probe eligibility");
                deferred.fake.targetNotExamined = false;
                failSample = false;
                await deferred.session._sampleTick();
                assert.strictEqual(deferred.session.stats().adaptiveSpeed.state, "tuned");
                assert.ok(deferred.session.stats().adapterSpeedKhz > 1000);
                assert.strictEqual(countEligibility(), 2, "the first good cycle rechecks eligibility once");
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
            speedReadBehavior: (actual) => ({ advanceMs: actual === 1000 ? 125 : actual === 2000 ? 30 : 15 })
        });
        try {
            const start = f.getMonoMs();
            const timedProbes = [];
            const probe = f.session.tcl.probe.bind(f.session.tcl);
            f.session.tcl.probe = (cmd, timeoutMs) => {
                timedProbes.push({ cmd, timeoutMs, elapsed: f.getMonoMs() - start });
                return probe(cmd, timeoutMs);
            };
            await f.session.start();
            const st = f.session.stats();
            assert.strictEqual(st.adaptiveSpeed.reason, "budget_reached");
            assert.strictEqual(st.adapterSpeedKhz, 2000);
            assert.strictEqual(f.fake.adapterSpeedKhz, 2000, "overdue candidate is restored");
            assert.ok(!st.adaptiveSpeed.testedSteps.some((s) => s.requestedKhz === 8000));
            const attempted = timedProbes.findIndex(({ cmd }) => cmd === "adapter speed 4000");
            assert.ok(attempted > 0);
            assert.ok(timedProbes[attempted + 1].timeoutMs <= 600 - timedProbes[attempted + 1].elapsed);
            assert.strictEqual(timedProbes[attempted + 2].cmd, "adapter speed 2000", "skip remaining benchmark RPCs");
            assert.ok(f.getMonoMs() - start < 700, "only bounded recovery can extend tuning");
        } finally {
            await f.close();
        }
    });

    await scenario("startup reports only a verified recovery clock and aborts when neither restore works", async () => {
        for (const restoreBase of [true, false]) {
            const f = await createTunedSession({
                initialKhz: 2000,
                speedReadBehavior: (actual) => ({ advanceMs: actual === 2000 ? 10 : 5, fail: actual === 8000 })
            });
            f.fake.speedMap = (khz) => ({
                reject: f.fake.adapterSpeedKhz === 8000 && (khz === 4000 || !restoreBase)
            });
            try {
                if (restoreBase) {
                    await f.session.start();
                    assert.strictEqual(f.session.stats().adaptiveSpeed.reason, "restore_failed");
                    assert.strictEqual(f.session.stats().adapterSpeedKhz, 2000);
                    assert.strictEqual(f.fake.adapterSpeedKhz, 2000);
                    assert.strictEqual(f.session.stopped, false);
                } else {
                    await assert.rejects(f.session.start(), { code: "SAMPLING_CLOCK_RESTORE_FAILED" });
                    assert.strictEqual(f.session.stats().adapterSpeedKhz, null);
                    assert.strictEqual(f.session.stats().adaptiveSpeed.state, "failed");
                    assert.strictEqual(f.fake.adapterSpeedKhz, 8000);
                    assert.strictEqual(f.session.stopped, true);
                    assert.strictEqual(f.disconnects.length, 0, "startup rejection is the only notification");
                }
            } finally {
                await f.close();
            }
        }
    });

    await scenario("scheduled fallback aborts and reports Tcl reconnect failure", async () => {
        const f = await createTunedSession({
            initialKhz: 2000,
            speedReadBehavior: (actual) => ({ advanceMs: actual >= 8000 ? 2 : 16000 / actual })
        });
        try {
            await f.session.start();
            assert.strictEqual(f.session.stats().adapterSpeedKhz, 8000);
            let reconnects = 0;
            f.session.tcl.probe = async (cmd) => {
                assert.strictEqual(cmd, "adapter speed 4000");
                f.session.tcl.close();
                throw Object.assign(new Error("Tcl timeout"), { code: "OPENOCD_RPC_TIMEOUT" });
            };
            f.session._connectWithRetry = async (_port, timeoutMs) => {
                reconnects++;
                assert.ok(timeoutMs > 0 && timeoutMs <= 600);
                throw new Error("Tcl reconnect refused");
            };
            f.session._speedTuner.requestStepDown();
            await f.session._sampleTick(true);
            assert.strictEqual(reconnects, 1);
            assert.strictEqual(f.session.samplingEnabled, false);
            assert.strictEqual(f.session.connectionFailed, true);
            assert.strictEqual(f.session.timer, null);
            assert.strictEqual(f.session.stats().adapterSpeedKhz, null);
            assert.strictEqual(f.disconnects.length, 1);
            assert.strictEqual(f.disconnects[0].code, "SAMPLING_CLOCK_RECONNECT_FAILED");
        } finally {
            await f.close();
        }
    });

    await scenario("runtime adaptive step-down drops one notch then baseKhz and never steps back up", async () => {
        let failReads = false;
        const f = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 1000,
            speedReadBehavior: (actual, _requested, cmd) => ({
                advanceMs: actual >= 8000 ? 2 : actual >= 4000 ? 4 : 8,
                fail: failReads && !/^(?:ocd_)?read_memory 0xe000ed00 32 1$/i.test(cmd),
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
            { intervalMs: 20, adaptiveAdapterSpeed: "sampling" },
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
        assert.strictEqual(createdOptions.at(-1).adaptiveAdapterSpeed, "agent");

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

    await scenario(
        "host controller persists samplingAdapterSpeedKhz, remembers adaptive kHz and locks while active",
        async () => {
            const wsState = new Map();
            const cfgValues = { samplingAdapterSpeedKhz: 0, adapterSpeedKhz: 0 };
            const cfgUpdates = [];
            const vscode = {
                ConfigurationTarget: { Workspace: 2 },
                workspace: {
                    getConfiguration: () => ({
                        get: (key, fallback) => (Object.hasOwn(cfgValues, key) ? cfgValues[key] : fallback),
                        update: async (key, value, target) => {
                            cfgUpdates.push({ key, value, target });
                            cfgValues[key] = value;
                        }
                    })
                }
            };
            const Provider = loadProvider(vscode);
            const provider = Object.create(Provider.prototype);
            const panelMessages = [];
            const entry = {
                panelId: 2,
                watchKey: CACHE_KEYS.watchList,
                latestSamples: new Map(),
                post: (m) => panelMessages.push(m)
            };
            Object.assign(provider, {
                _context: {
                    workspaceState: {
                        get: (k) => wsState.get(k),
                        update: async (k, v) => wsState.set(k, v)
                    }
                },
                _lang: "zh",
                _probeCoordinator: new ProbeCoordinator(),
                _samplingCoordinator: new SamplingCoordinator(),
                _debugBridge: { hasSession: false, hasAnySession: false, setIntent: () => {} },
                _agentOperations: { readRunning: false },
                _probeConnectionService: { markConfigurationChanged: () => {} },
                _connectedProbesController: { refresh: async () => {} },
                _livePanels: new Map([[2, entry]]),
                _seriesStyleStore: { styles: {} },
                _chartBackgroundState: () => ({ type: "chartBackgroundIcon", icon: null }),
                chartBackground: () => ({ ready: () => {} }),
                _curveVisibility: () => ({}),
                _syncGraphTarget: () => {},
                _samplingArchive: { clear: () => {}, status: () => ({ variables: [] }) },
                _postLive: () => {},
                _postProbeOperationStatus: () => {},
                _postConsumerStatuses: () => {}
            });
            provider._samplingController = undefined;
            provider._sampling.lastManualSpeedKhz = 2000;

            const handle = createLivePanelHandler(provider, entry, vscode);
            await handle({ type: "ready", panelId: 2 });
            const initial = panelMessages.find((m) => m.type === "samplingSpeedConfig");
            assert.deepStrictEqual(initial, {
                type: "samplingSpeedConfig",
                adaptive: true,
                samplingAdapterSpeedKhz: 0,
                adapterSpeedKhz: 0,
                effectiveKhz: null,
                adaptiveEffectiveKhz: null,
                adaptiveState: null,
                adaptiveReason: null,
                manualSpeedKhz: 2000,
                locked: false
            });

            // Adaptive session chooses 12000 kHz and stops: lastAdaptiveSpeedKhz stays visible on stopped UI.
            provider._sampling.session = {
                stats: () => ({
                    adapterSpeedKhz: 12000,
                    adaptiveSpeed: { state: "tuned", reason: "plateau", effectiveKhz: 12000 }
                }),
                setSamplingEnabled: () => {},
                stop: async () => true
            };
            provider._sampling.intent = true;
            assert.strictEqual(provider._sampling.samplingSpeedState().locked, true);
            assert.strictEqual(provider._sampling.samplingSpeedState().adaptiveEffectiveKhz, 12000);

            // Changing while active is rejected cleanly and resyncs panel state.
            panelMessages.length = 0;
            await handle({ type: "setSamplingSpeed", adaptive: false, speedKhz: 8000, panelId: 2 });
            assert.strictEqual(cfgUpdates.length, 0);
            assert.strictEqual(panelMessages.at(-1).type, "liveError");
            assert.strictEqual(panelMessages.at(-2).type, "samplingSpeedConfig");
            assert.strictEqual(panelMessages.at(-2).locked, true);

            await provider._sampling.stop();
            assert.strictEqual(provider._sampling.samplingSpeedState().locked, false);
            assert.strictEqual(provider._sampling.samplingSpeedState().adaptiveEffectiveKhz, 12000);

            // Turning adaptive off without speedKhz adopts the adaptive-selected 12000 kHz cleanly.
            await handle({ type: "setSamplingSpeed", adaptive: false, panelId: 2 });
            assert.strictEqual(cfgValues.samplingAdapterSpeedKhz, 12000);
            assert.strictEqual(wsState.get("liveWatch.manualSamplingSpeedKhz"), 12000);
            assert.strictEqual(cfgUpdates.at(-1).target, vscode.ConfigurationTarget.Workspace);

            // Invalid manual steps/bounds are rejected without updating settings.
            for (const bad of [
                { adaptive: "yes" },
                { adaptive: false, speedKhz: 1500 },
                { adaptive: false, speedKhz: 24000 }
            ]) {
                const count = cfgUpdates.length;
                panelMessages.length = 0;
                await handle({ type: "setSamplingSpeed", ...bad, panelId: 2 });
                assert.strictEqual(cfgUpdates.length, count);
                assert.strictEqual(panelMessages.at(-1).type, "liveError");
            }

            // Slider updates persist 1000..20000 kHz, and turning adaptive on writes explicit 0.
            await handle({ type: "setSamplingSpeed", adaptive: false, speedKhz: 16000, panelId: 2 });
            assert.strictEqual(cfgValues.samplingAdapterSpeedKhz, 16000);
            await handle({ type: "setSamplingSpeed", adaptive: true, panelId: 2 });
            assert.strictEqual(cfgValues.samplingAdapterSpeedKhz, 0);

            // Agent read in progress also locks sampling clock updates.
            provider._agentOperations.readRunning = true;
            panelMessages.length = 0;
            await handle({ type: "setSamplingSpeed", adaptive: false, speedKhz: 6000, panelId: 2 });
            assert.strictEqual(cfgValues.samplingAdapterSpeedKhz, 0);
            assert.strictEqual(panelMessages.at(-1).type, "liveError");
            assert.strictEqual(panelMessages.at(-2).locked, true);
            provider._agentOperations.readRunning = false;

            // External connection/adapterSpeedKhz change clears cached adaptive clock and broadcasts state.
            cfgValues.adapterSpeedKhz = 4000;
            panelMessages.length = 0;
            provider.connectionConfigurationChanged(false, false);
            const synced = panelMessages.find((m) => m.type === "samplingSpeedConfig");
            assert.strictEqual(synced.adapterSpeedKhz, 4000);
            assert.strictEqual(synced.adaptiveEffectiveKhz, 4000);
            assert.strictEqual(provider._sampling.lastAdaptiveSpeedKhz, null);
        }
    );

    await scenario("chart settings popup renders sampling clock slider/switch states cleanly across locales", () => {
        for (const lang of ["en", "zh"]) {
            const view = render(getLiveWatchContent({ panelId: 4 }, lang));
            try {
                const doc = view.document;
                const toggle = doc.getElementById("chartSettingsToggle");
                const popup = doc.getElementById("chartSettingsPopup");
                const option = doc.getElementById("samplingClockOption");
                const label = doc.getElementById("samplingClockLabel");
                const autoSwitch = doc.getElementById("samplingClockAuto");
                const slider = doc.getElementById("samplingClockSlider");
                const value = doc.getElementById("samplingClockValue");
                const hint = doc.getElementById("samplingClockHint");
                const hints = {
                    zh: "提供时钟频率可有效提高采样率。关闭“自适应”后，可手动设置采样时钟。",
                    en: "Setting the clock frequency can improve the sampling rate. Turn off Adaptive to set the sampling clock manually."
                };
                assert.strictEqual(hint.textContent, hints[lang]);
                assert.strictEqual(label.nextElementSibling, value);
                assert.strictEqual(autoSwitch.getAttribute("aria-label"), lang === "zh" ? "自适应" : "Auto");
                const controlsText = option.textContent.replace(label.textContent, "").replace(hint.textContent, "");
                assert.ok(!controlsText.includes(autoSwitch.getAttribute("aria-label")));
                assert.ok(!option.textContent.includes("1000 kHz") && !option.textContent.includes("MHz"));
                assert.ok(slider.classList.contains("write-slider"));
                assert.strictEqual(doc.getElementById("chartSettings").nextElementSibling, null);
                assert.strictEqual(slider.min, "1000");
                assert.strictEqual(slider.max, "20000");
                assert.strictEqual(slider.step, "1000");
                assert.strictEqual(autoSwitch.checked, true);
                assert.strictEqual(autoSwitch.disabled, false);
                assert.strictEqual(slider.disabled, true);
                assert.strictEqual(slider.hidden, false);

                assert.strictEqual(value.textContent, lang === "zh" ? "待采样" : "Pending");

                toggle.click();
                assert.strictEqual(popup.hidden, false);

                // While running, both switch and slider are grayed out and locked at the adaptive-selected clock.
                view.send({
                    type: "liveStatus",
                    running: true,
                    adapterSpeedKhz: 12000,
                    adaptiveSpeed: { state: "tuned", effectiveKhz: 12000 }
                });
                assert.strictEqual(autoSwitch.disabled, true);
                assert.strictEqual(slider.disabled, true);
                assert.ok(option.classList.contains("is-locked"));
                assert.strictEqual(hint.textContent, hints[lang]);
                assert.strictEqual(slider.value, "12000");
                assert.strictEqual(value.textContent, "12 MHz");

                // Runtime fallback or deferred update via chartValues updates the locked slider readout live.
                view.send({
                    type: "chartValues",
                    samples: [],
                    adapterSpeedKhz: 8000,
                    adaptiveSpeed: { state: "fallback", effectiveKhz: 8000 }
                });
                assert.strictEqual(slider.value, "8000");
                assert.strictEqual(value.textContent, "8 MHz");
                assert.strictEqual(autoSwitch.disabled, true);

                // Stopping unlocks the adaptive switch while keeping the slider disabled and fixed on 8000 kHz.
                view.send({ type: "liveStatus", running: false, actualHz: 0 });
                assert.strictEqual(autoSwitch.disabled, false);
                assert.strictEqual(slider.disabled, true);
                assert.ok(!option.classList.contains("is-locked"));
                assert.strictEqual(slider.value, "8000");
                assert.strictEqual(value.textContent, "8 MHz");

                // Switching adaptive off unlocks the slider starting from 8000 kHz.
                autoSwitch.checked = false;
                autoSwitch.dispatchEvent(new view.window.Event("change"));
                assert.deepStrictEqual(view.messages.at(-1), {
                    type: "setSamplingSpeed",
                    adaptive: false,
                    speedKhz: 8000,
                    panelId: 4
                });
                assert.strictEqual(slider.disabled, false);
                assert.strictEqual(slider.hidden, false);

                // Drag preview updates readout on `input` and commits once on `change`; interaction keeps popup open.
                const sentBefore = view.messages.length;
                slider.value = "16000";
                slider.dispatchEvent(new view.window.Event("input"));
                assert.strictEqual(value.textContent, "16 MHz");
                assert.strictEqual(view.messages.length, sentBefore);
                slider.dispatchEvent(new view.window.Event("change"));
                assert.deepStrictEqual(view.messages.at(-1), {
                    type: "setSamplingSpeed",
                    adaptive: false,
                    speedKhz: 16000,
                    panelId: 4
                });
                assert.strictEqual(popup.hidden, false);

                // Turning adaptive back on re-disables the slider cleanly.
                autoSwitch.checked = true;
                autoSwitch.dispatchEvent(new view.window.Event("change"));
                assert.strictEqual(slider.disabled, true);
                assert.strictEqual(slider.hidden, false);
                assert.deepStrictEqual(view.messages.at(-1), {
                    type: "setSamplingSpeed",
                    adaptive: true,
                    panelId: 4
                });

                // An inherited adapter clock updates the readout while keeping the description fixed.
                view.send({
                    type: "samplingSpeedConfig",
                    adaptive: true,
                    samplingAdapterSpeedKhz: 0,
                    adapterSpeedKhz: 1800,
                    effectiveKhz: null,
                    adaptiveEffectiveKhz: 1800,
                    manualSpeedKhz: 16000,
                    locked: false
                });
                assert.strictEqual(value.textContent, "1.8 MHz");
                assert.strictEqual(slider.getAttribute("aria-valuetext"), "1.8 MHz");
                assert.strictEqual(hint.textContent, hints[lang]);

                // Language switch also relocalizes the fixed description.
                view.send({ type: "setLang", lang: lang === "en" ? "zh" : "en" });
                assert.strictEqual(label.textContent, lang === "en" ? "自适应采样时钟" : "Sampling clock");
                assert.strictEqual(hint.textContent, hints[lang === "en" ? "zh" : "en"]);
                view.assertHealthy();
            } finally {
                view.close();
            }
        }
    });

    await scenario("CMSIS-DAP CMD_DAP_SWJ_CLOCK rejection and restore window logs do not abort tuning", async () => {
        const ctx = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 1000,
            unlimited: true,
            speedMap: (khz) => {
                if (khz >= 14000) {
                    return {
                        reject: true,
                        logLine: "Error: CMSIS-DAP command CMD_DAP_SWJ_CLOCK failed."
                    };
                }
                return { actualKhz: khz };
            },
            speedReadBehavior: (actualKhz) => ({
                advanceMs: Math.max(2, Math.round(48000 / Math.max(1000, actualKhz)))
            })
        });
        try {
            const origRestore = ctx.session._speedTuner._restoreSpeed.bind(ctx.session._speedTuner);
            ctx.session._speedTuner._restoreSpeed = async (session, targetKhz, info, deadline) => {
                ctx.session._fakeServerLog?.("Error: target communication error");
                return origRestore(session, targetKhz, info, deadline);
            };
            await ctx.session.start();
            assert.strictEqual(ctx.session.connectionFailed, false);
            assert.strictEqual(ctx.disconnects.length, 0);
            assert.strictEqual(ctx.session.stats().adaptiveSpeed.state, "tuned");
            assert.strictEqual(ctx.session.stats().adapterSpeedKhz, 12000);
        } finally {
            await ctx.close();
        }
    });

    await scenario("Startup tuning blocks premature _sampleTick and tolerates NULL pointer diagnostics", async () => {
        const ptrWatch = [
            {
                name: "g_ptr.value",
                address: RAM_BASE + 0x100,
                size: 4,
                type: "u32",
                runtimeRanges: RAM_RANGES,
                runtimeSegments: [{ kind: "member", name: "value" }],
                runtimeLayout: {
                    root: 0,
                    types: [
                        { kind: "pointer", byteSize: 4, target: 1 },
                        { kind: "scalar", byteSize: 4, watchType: "u32" }
                    ]
                }
            }
        ];
        const ctx = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 1000,
            unlimited: false,
            watch: ptrWatch,
            speedReadBehavior: (_actualKhz, requestedKhz) => ({
                advanceMs: requestedKhz >= 4000 ? 10 : 40
            })
        });
        try {
            ctx.fake.seed(RAM_BASE + 0x100, [0, 0, 0, 0]);
            let scheduledDuringStart = false;
            ctx.session._scheduleNext = ManagedOpenOcdSession.prototype._scheduleNext.bind(ctx.session);
            const origTune = ctx.session._speedTuner.tune.bind(ctx.session._speedTuner);
            ctx.session._speedTuner.tune = async (session) => {
                session.setIntervalMs(20);
                scheduledDuringStart = session.timer !== null;
                return origTune(session);
            };
            await ctx.session.start();
            assert.strictEqual(scheduledDuringStart, false, "no tick timer scheduled while start() is still tuning");
            assert.strictEqual(ctx.session.stats().adaptiveSpeed.state, "tuned");
        } finally {
            await ctx.close();
        }
    });

    await scenario("Pre-cycle stepDown with MultiRatePlan does not emit an empty 0-item cycle", async () => {
        const ctx = await createTunedSession({
            probe: "cmsis-dap.cfg",
            initialKhz: 1000,
            unlimited: false,
            speedReadBehavior: (_actualKhz, requestedKhz) => ({
                advanceMs: requestedKhz >= 4000 ? 2 : 10
            })
        });
        try {
            await ctx.session.start();
            ctx.session.setIntervalMs(20);
            for (let i = 0; i < 4; i++) {
                ctx.addMonoMs(100);
                await ctx.session._sampleTick();
            }
            assert.strictEqual(ctx.session.effectiveIntervalMs, 20);
            ctx.session._speedTuner.requestStepDown();
            const batches = [];
            ctx.session.handlers.onSample = (samples) => batches.push(samples);
            ctx.addMonoMs(25);
            await ctx.session._sampleTick();
            assert.strictEqual(batches.length, 1);
            assert.strictEqual(batches[0].length, 1, "due graph item is read immediately after pre-cycle stepDown");
        } finally {
            await ctx.close();
        }
    });

    console.log("Adaptive sampling speed tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
