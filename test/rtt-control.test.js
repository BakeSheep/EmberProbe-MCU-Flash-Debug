"use strict";

const assert = require("assert");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const { ManagedOpenOcdSession } = require("../src/liveWatch");
const { SamplingSession } = require("../src/samplingSession");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");
const { FakeClock } = require("./helpers/fake-clock");

const block = { address: 0x20000400, size: 168 };

async function fixture(options = {}) {
    const fake = new FakeOpenOcdServer();
    await fake.start();
    const clock = new FakeClock();
    const session = new ManagedOpenOcdSession({ mode: options.mode || "standalone", clock }, {});
    session._scheduleNext = () => {};
    session.tcl.attach(await fake.connect());
    // Debug mode keeps the default echo handling, so RTT commands run through the silent response file.
    if (options.mode !== "debug") session.tcl.noEchoResponses = true;
    let locks = 0;
    const release = session._releaseExclusive.bind(session);
    session._releaseExclusive = () => {
        locks--;
        return release();
    };
    const acquire = session._acquireExclusive.bind(session);
    session._acquireExclusive = async (deadline) => {
        await acquire(deadline);
        locks++;
    };
    return {
        fake,
        session,
        clock,
        locks: () => locks,
        rttCommands: () => fake.commands.filter((command) => command.startsWith("rtt")),
        close: async () => {
            await session.stop(50);
            await fake.stop();
        }
    };
}

(async () => {
    await scenario("start runs setup, interval, start and channels as one transaction", async () => {
        const f = await fixture();
        try {
            const result = await f.session.rttControl({ operation: "start", block, pollingIntervalMs: 20 });
            assert.deepStrictEqual(f.rttCommands(), [
                'rtt setup 0x20000400 168 "SEGGER RTT"',
                "rtt polling_interval 20",
                "rtt start",
                "rtt channels"
            ]);
            assert.deepStrictEqual(f.fake.rtt, { address: 0x20000400, size: 168 });
            assert.strictEqual(f.fake.rttStarted, true);
            assert.strictEqual(f.fake.rttPollingIntervalMs, 20);
            assert.deepStrictEqual(
                result.channels,
                { up: [], down: [] },
                "the list may be empty until the firmware configures it"
            );
            assert.strictEqual(f.locks(), 0, "the exclusive lock is released");
        } finally {
            await f.close();
        }
    });

    await scenario("start without a polling interval skips the interval command", async () => {
        const f = await fixture();
        try {
            await f.session.rttControl({ operation: "start", block });
            assert.deepStrictEqual(f.rttCommands(), [
                'rtt setup 0x20000400 168 "SEGGER RTT"',
                "rtt start",
                "rtt channels"
            ]);
            assert.strictEqual(f.fake.rttPollingIntervalMs, null);
        } finally {
            await f.close();
        }
    });

    await scenario("the channel listing keeps channel numbers, modes and sizes", async () => {
        const f = await fixture();
        try {
            await f.session.rttControl({ operation: "start", block });
            f.fake.rttChannels =
                "Channels: up=3, down=1\nUp-channels:\n0: Terminal 1024 2\n2: Log 64 0\nDown-channels:\n0: Input 16 1\n";
            const result = await f.session.rttControl({ operation: "channels" });
            assert.deepStrictEqual(result.channels, {
                up: [
                    { index: 0, name: "Terminal", size: 1024, flags: 2, mode: "block" },
                    { index: 2, name: "Log", size: 64, flags: 0, mode: "skip" }
                ],
                down: [{ index: 0, name: "Input", size: 16, flags: 1, mode: "trim" }]
            });
        } finally {
            await f.close();
        }
    });

    await scenario("server start and stop carry the port and channel of each server", async () => {
        const f = await fixture();
        try {
            await f.session.rttControl({ operation: "start", block });
            await f.session.rttControl({
                operation: "serverStart",
                servers: [
                    { port: 19021, channel: 0 },
                    { port: 19022, channel: 2 }
                ]
            });
            assert.deepStrictEqual(f.rttCommands().slice(-2), ["rtt server start 19021 0", "rtt server start 19022 2"]);
            assert.deepStrictEqual(f.fake.rttServers, [
                { port: 19021, channel: 0 },
                { port: 19022, channel: 2 }
            ]);
            await f.session.rttControl({ operation: "serverStop", ports: [19021] });
            assert.deepStrictEqual(f.fake.rttServers, [{ port: 19022, channel: 2 }]);
            await f.session.rttControl({ operation: "stop" });
            assert.strictEqual(f.fake.rttStarted, false);
            assert.strictEqual(f.locks(), 0);
        } finally {
            await f.close();
        }
    });

    await scenario("debug mode sends RTT commands through the silent response file", async () => {
        const f = await fixture({ mode: "debug" });
        try {
            const result = await f.session.rttControl({ operation: "start", block, pollingIntervalMs: 10 });
            assert.deepStrictEqual(f.rttCommands(), [
                'rtt setup 0x20000400 168 "SEGGER RTT"',
                "rtt polling_interval 10",
                "rtt start",
                "rtt channels"
            ]);
            assert.deepStrictEqual(result.channels, { up: [], down: [] });
        } finally {
            await f.close();
        }
    });

    await scenario("commands before the control block is found are retryable Tcl errors", async () => {
        const f = await fixture();
        try {
            await assert.rejects(f.session.rttControl({ operation: "channels" }), (error) => {
                assert.strictEqual(error.code, "OPENOCD_TCL_ERROR");
                assert.strictEqual(error.retryable, true);
                assert.strictEqual(error.details.operation, "channels");
                assert.strictEqual(error.details.executed, 0, "the rejected command is not counted as executed");
                return true;
            });
            f.fake.rttBlockPresent = false;
            await assert.rejects(f.session.rttControl({ operation: "start", block }), (error) => {
                assert.strictEqual(error.code, "OPENOCD_TCL_ERROR");
                assert.strictEqual(error.retryable, true, "the firmware may not have initialized yet");
                assert.strictEqual(f.fake.rttStarted, false);
                return true;
            });
            assert.strictEqual(f.locks(), 0, "failed transactions release the lock");
        } finally {
            await f.close();
        }
    });

    await scenario("a start that fails without a Tcl message is reported as a search miss", async () => {
        const f = await fixture();
        f.fake.rttBlockPresent = false;
        try {
            await assert.rejects(f.session.rttControl({ operation: "start", block }), (error) => {
                assert.strictEqual(error.retryable, true);
                assert.strictEqual(error.code, "OPENOCD_TCL_ERROR");
                assert.match(error.message, /no control block found/);
                return true;
            });
        } finally {
            await f.close();
        }
    });

    await scenario("a channel listing cut short by an unreadable name still starts RTT", async () => {
        const f = await fixture();
        f.fake.rttChannelsTruncated = true;
        f.fake.rttChannels = ["Channels: up=1, down=2", "Up-channels:", "0: Terminal 4096 0"].join(
            String.fromCharCode(10)
        );
        try {
            const result = await f.session.rttControl({ operation: "start", block });
            assert.deepStrictEqual(
                result.channels.up.map((channel) => channel.name),
                ["Terminal"]
            );
            f.fake.rttChannels = "rtt: some other failure";
            await assert.rejects(f.session.rttControl({ operation: "channels" }), { code: "OPENOCD_TCL_ERROR" });
        } finally {
            await f.close();
        }
    });

    await scenario("an OpenOCD without the rtt commands is not retryable", async () => {
        const f = await fixture();
        try {
            f.fake.rttSupported = false;
            await assert.rejects(f.session.rttControl({ operation: "start", block }), (error) => {
                assert.strictEqual(error.code, "OPENOCD_TCL_ERROR");
                assert.strictEqual(error.retryable, false);
                assert.strictEqual(error.details.executed, 0, "the sequence stops at the first command");
                return true;
            });
        } finally {
            await f.close();
        }
    });

    await scenario("invalid requests are rejected before any command is sent", async () => {
        const f = await fixture();
        try {
            const cases = [
                [{ operation: "bogus" }, { code: "RTT_INVALID_OPERATION" }],
                [{ operation: "start" }, { code: "RTT_INVALID_CONTROL_BLOCK" }],
                [{ operation: "start", block: null }, { code: "RTT_INVALID_CONTROL_BLOCK" }],
                [{ operation: "start", block: { address: -1, size: 168 } }, { code: "RTT_INVALID_ADDRESS" }],
                [{ operation: "start", block: { address: 0x20000400, size: 8 } }, { code: "RTT_INVALID_RANGE" }],
                [{ operation: "start", block, pollingIntervalMs: 0 }, { code: "RTT_INVALID_INTERVAL" }],
                [{ operation: "serverStart" }, { code: "RTT_INVALID_SERVERS" }],
                [{ operation: "serverStart", servers: [] }, { code: "RTT_INVALID_SERVERS" }],
                [
                    { operation: "serverStart", servers: Array(17).fill({ port: 19021, channel: 0 }) },
                    { code: "RTT_INVALID_SERVERS" }
                ],
                [{ operation: "serverStart", servers: [{ port: 0, channel: 0 }] }, { code: "RTT_INVALID_PORT" }],
                [
                    { operation: "serverStart", servers: [{ port: 19021, channel: 256 }] },
                    { code: "RTT_INVALID_CHANNEL" }
                ],
                [{ operation: "serverStop" }, { code: "RTT_INVALID_PORTS" }],
                [{ operation: "serverStop", ports: [70000] }, { code: "RTT_INVALID_PORT" }]
            ];
            for (const [request, expected] of cases) await assert.rejects(f.session.rttControl(request), expected);
            assert.deepStrictEqual(f.rttCommands(), [], "no RTT command left the host");
            assert.strictEqual(f.locks(), 0, "invalid requests never take the lock");
        } finally {
            await f.close();
        }
    });

    await scenario("a target invalidation cancels the transaction before its first command", async () => {
        const f = await fixture();
        try {
            const pending = f.session.rttControl({ operation: "start", block });
            f.session.invalidateTarget();
            await assert.rejects(pending, (error) => {
                assert.strictEqual(error.code, "LIVE_READ_CANCELLED");
                assert.strictEqual(error.retryable, false);
                assert.strictEqual(error.details.executed, 0);
                return true;
            });
            assert.deepStrictEqual(f.rttCommands(), []);
        } finally {
            await f.close();
        }
    });

    await scenario("the transaction budget stops the sequence between commands", async () => {
        const f = await fixture();
        try {
            const pending = f.session.rttControl({ operation: "start", block }, 100);
            // The deadline was captured synchronously; pushing the clock past it fails the next check.
            f.clock.time += 5000;
            await assert.rejects(pending, (error) => {
                assert.strictEqual(error.code, "LIVE_READ_BUDGET_EXCEEDED");
                assert.strictEqual(error.retryable, false);
                assert.strictEqual(error.details.executed, 0);
                return true;
            });
            assert.deepStrictEqual(f.rttCommands(), []);
            assert.strictEqual(f.locks(), 0);
        } finally {
            await f.close();
        }
    });

    await scenario("rtt control crosses the sampling worker boundary", async () => {
        const session = new SamplingSession(
            { intervalMs: 20 },
            {},
            path.join(__dirname, "helpers/sampling-worker-fixture.js")
        );
        try {
            await session.start();
            const started = await session.rttControl({ operation: "start", block, pollingIntervalMs: 10 });
            assert.deepStrictEqual(started.channels, { up: [], down: [] });
            await session.rttControl({ operation: "serverStart", servers: [{ port: 19021, channel: 0 }] });
            const channels = await session.rttControl({ operation: "channels" });
            assert.deepStrictEqual(channels.channels, { up: [], down: [] });
            await session.rttControl({ operation: "stop" });
        } finally {
            await session.stop();
        }
    });

    console.log("RTT session control tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
