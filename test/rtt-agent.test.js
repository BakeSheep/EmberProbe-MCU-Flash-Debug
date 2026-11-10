"use strict";

const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const { RttController } = require("../src/services/rttController");
const { RttTerminalService } = require("../src/services/rttTerminalService");
const { RttBuffer } = require("../src/rttBuffer");
const { TOOLS } = require("../src/mcp/tools");
const client = require("../skills/_emberprobe/agent-client");
const { args } = require("../skills/mcu-rtt/scripts/rtt");

function fixture() {
    const controller = new RttController({});
    const notices = [];
    const posts = [];
    const terminals = new RttTerminalService({
        vscode: {},
        controller: () => controller,
        onNotice: (notice) => notices.push(notice),
        post: (message) => posts.push(message)
    });
    controller.onStatus = (status) => terminals.onStatus(status);
    const host = { _rtt: controller, _rttTerminals: terminals };
    return { controller, terminals, notices, posts, routes: createAgentRoutes(host) };
}

(async () => {
    await scenario("Status works before RTT starts and omits local servers and private error fields", () => {
        const { controller, routes } = fixture();
        assert.deepStrictEqual(routes["rtt.status"](), {
            state: "stopped",
            source: null,
            reason: null,
            yieldedFor: null,
            retry: null,
            block: null,
            channels: null,
            missingChannels: [],
            buffers: [],
            configuredPollingIntervalMs: null,
            pollingIntervalMs: null,
            targetDroppedBytes: null,
            targetTelemetry: { available: false, reason: "RTT_NOT_RUNNING", sampledAt: null, channels: [] },
            recovery: null,
            error: null
        });
        controller._servers = [{ channel: 0, port: 12345 }];
        controller.error = Object.assign(new Error("failure"), { code: "RTT_START_TIMEOUT", details: { port: 12345 } });
        const status = routes["rtt.status"]({});
        assert.deepStrictEqual(status.error, { code: "RTT_START_TIMEOUT", message: "failure" });
        assert.strictEqual("servers" in status, false);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(status)), status);
    });

    await scenario("Agent status keeps uncertain and partial mode outcomes while filtering private details", () => {
        const { controller, routes } = fixture();
        controller.error = Object.assign(new Error("mode could not be verified"), {
            code: "RTT_READBACK_MISMATCH",
            details: {
                resultUnknown: true,
                writeAcknowledged: true,
                attempted: 0x20000030,
                expectedFlags: 2,
                actualFlags: 1,
                completedChannels: [0, 2, -1, "3", 256],
                completed: [{ index: 0, flags: 2, mode: "block", port: 12345, private: true }, null],
                port: 12345,
                socket: { secret: true },
                commandCount: 10
            }
        });
        assert.deepStrictEqual(routes["rtt.status"]().error, {
            code: "RTT_READBACK_MISMATCH",
            message: "mode could not be verified",
            details: {
                resultUnknown: true,
                writeAcknowledged: true,
                attempted: 0x20000030,
                expectedFlags: 2,
                actualFlags: 1,
                completedChannels: [0, 2],
                completed: [{ index: 0, flags: 2, mode: "block" }]
            }
        });
    });

    await scenario("Agent status and reads project cached diagnostics without starting or refreshing hardware", () => {
        const { controller, routes } = fixture();
        let statusReads = 0;
        const buffer = new RttBuffer({ generation: 3, maxBytes: 4 });
        buffer.append("abcdef");
        const cached = {
            state: "running",
            configuredPollingIntervalMs: 0,
            pollingIntervalMs: 100,
            targetDroppedBytes: null,
            targetTelemetry: {
                available: true,
                sampledAt: 1234,
                reason: null,
                channels: [{ index: 0, usedBytes: 7, capacity: 15, size: 16, mode: "trim", flags: 1 }]
            },
            channels: { up: [{ index: 0, mode: "trim", desiredMode: "block", modeState: "mismatch" }], down: [] },
            buffers: [{ channel: 0, connected: true, ...buffer.stats(), receivedBytes: 6, rateBytesPerSecond: 0 }],
            servers: [{ channel: 0, port: 12345 }],
            error: null
        };
        controller.status = () => {
            statusReads++;
            return cached;
        };
        controller.start = () => assert.fail("cached observations must not start RTT");
        controller.state = "running";
        controller._buffers.set(0, buffer);
        const status = routes["rtt.status"]();
        for (const key of [
            "configuredPollingIntervalMs",
            "pollingIntervalMs",
            "targetDroppedBytes",
            "targetTelemetry",
            "channels",
            "buffers"
        ])
            assert.deepStrictEqual(status[key], cached[key]);
        assert.strictEqual("servers" in status, false);
        const read = routes["rtt.read"]({ generation: 3, cursor: 0 });
        assert.strictEqual(read.droppedBytes, 2);
        assert.strictEqual(read.text, "cdef");
        assert.strictEqual(statusReads, 1, "read uses cached bytes without querying status or telemetry");
    });

    await scenario("a GBK channel reads as text without cutting a character across reads", () => {
        const { controller, routes } = fixture();
        const buffer = new RttBuffer({ generation: 1 });
        buffer.append(Buffer.of(0xce, 0xc2, 0xb6));
        controller.state = "running";
        controller.channels = { up: [{ index: 0, encoding: "gbk" }], down: [] };
        controller._buffers.set(0, buffer);
        const first = routes["rtt.read"]({ generation: 1, cursor: 0 });
        assert.strictEqual(first.text, "温");
        assert.strictEqual(first.textEncoding, "gbk");
        assert.strictEqual(first.nextCursor, 2);
        buffer.append(Buffer.of(0xc8));
        const second = routes["rtt.read"]({ generation: 1, cursor: first.nextCursor });
        assert.strictEqual(second.text, "度");
        assert.strictEqual(second.nextCursor, 4);
    });

    await scenario("All RTT routes reject non-objects and unknown keys before accessing the host", async () => {
        const routes = createAgentRoutes({});
        for (const method of ["status", "read", "start", "stop"]) {
            for (const params of [null, [], 1, "x", false, { unknown: true }, { write: "command" }]) {
                await assert.rejects(async () => routes[`rtt.${method}`](params), { code: "INVALID_PARAMS" });
            }
        }
        for (const [key, values] of Object.entries({
            channel: [-1, 256, 0.5, "0", null],
            generation: [-1, Number.MAX_SAFE_INTEGER + 1, NaN, "1"],
            cursor: [-1, Infinity, 0.5, "1"],
            maxBytes: [0, 65537, 0.5, "1"],
            encoding: [null, "UTF8", "hex", 1]
        })) {
            for (const value of values)
                assert.throws(() => routes["rtt.read"]({ [key]: value }), { code: "INVALID_PARAMS" });
        }
        for (const method of ["status", "start", "stop"])
            await assert.rejects(async () => routes[`rtt.${method}`]({ channel: 0 }), { code: "INVALID_PARAMS" });
    });

    await scenario("Reads propagate controller errors and use documented defaults without hardware", () => {
        const { controller, routes } = fixture();
        assert.throws(() => routes["rtt.read"](), { code: "RTT_NOT_RUNNING" });
        controller.state = "running";
        assert.throws(() => routes["rtt.read"](), { code: "RTT_UNKNOWN_CHANNEL" });
        const buffer = new RttBuffer();
        buffer.append("a".repeat(17000));
        controller._buffers.set(0, buffer);
        const read = routes["rtt.read"]();
        assert.strictEqual(read.channel, 0);
        assert.strictEqual(read.text.length, 16384);
        assert.strictEqual(read.nextCursor, 16384);
        assert.strictEqual(read.more, true);
        assert.strictEqual("data" in read, false);
        assert.strictEqual("dataBase64" in read, false);
    });

    await scenario("UTF-8 holds incomplete tails at both the byte limit and the current buffer end", () => {
        for (const char of ["é", "温", "😀"]) {
            for (let length = 1; length < Buffer.byteLength(char); length++) {
                const { controller, routes } = fixture();
                const buffer = new RttBuffer({ generation: 7 });
                controller.state = "running";
                controller._buffers.set(0, buffer);
                const bytes = Buffer.from(char);
                buffer.append(Buffer.concat([Buffer.from("a"), bytes.subarray(0, length)]));
                const first = routes["rtt.read"]();
                assert.strictEqual(first.text, "a");
                assert.strictEqual(first.nextCursor, 1);
                assert.strictEqual(first.more, false, "a held tail needs more bytes, so looping on more cannot help");
                const tail = routes["rtt.read"]({ generation: 7, cursor: 1 });
                assert.strictEqual(tail.text, "");
                assert.strictEqual(tail.nextCursor, tail.cursor);
                buffer.append(bytes.subarray(length));
                const limited = routes["rtt.read"]({ generation: 7, cursor: 1, maxBytes: length });
                assert.strictEqual(limited.text, char, "a limit below one character still makes progress");
                assert.strictEqual(limited.nextCursor, 1 + bytes.length);
                const complete = routes["rtt.read"]({ generation: 7, cursor: 1 });
                assert.strictEqual(complete.text, char);
                assert.strictEqual(complete.more, false);
                assert.strictEqual(complete.nextCursor, 1 + bytes.length);
                assert.strictEqual(routes["rtt.read"]({ generation: 7, cursor: complete.nextCursor }).text, "");
            }
        }
    });

    await scenario("Base64 preserves exact bytes even across a UTF-8 boundary", () => {
        const { controller, routes } = fixture();
        const buffer = new RttBuffer({ generation: 2 });
        const bytes = Buffer.concat([Buffer.from("a温"), Buffer.from([0xff, 0, 0xf0])]);
        buffer.append(bytes);
        controller.state = "running";
        controller._buffers.set(255, buffer);
        const first = routes["rtt.read"]({ channel: 255, maxBytes: 2, encoding: "base64" });
        assert.deepStrictEqual(Buffer.from(first.dataBase64, "base64"), bytes.subarray(0, 2));
        assert.strictEqual(first.nextCursor, 2);
        assert.strictEqual(first.more, true);
        assert.strictEqual("text" in first, false);
        const rest = routes["rtt.read"]({ channel: 255, generation: 2, cursor: 2, encoding: "base64" });
        assert.deepStrictEqual(Buffer.from(rest.dataBase64, "base64"), bytes.subarray(2));
        assert.strictEqual(rest.nextCursor, bytes.length);
    });

    await scenario("Stale cursors reset and evictions report dropped bytes", () => {
        const { controller, routes } = fixture();
        const buffer = new RttBuffer({ generation: 3, maxBytes: 4 });
        buffer.append("abcdef");
        controller.state = "running";
        controller._buffers.set(0, buffer);
        const stale = routes["rtt.read"]({ generation: 2, cursor: 1 });
        assert.strictEqual(stale.reset, true);
        assert.strictEqual(stale.cursor, 2);
        assert.strictEqual(stale.text, "cdef");
        assert.strictEqual(routes["rtt.read"]({ generation: 3, cursor: 999 }).reset, true);
        const dropped = routes["rtt.read"]({ generation: 3, cursor: 0 });
        assert.strictEqual(dropped.reset, false);
        assert.strictEqual(dropped.droppedBytes, 2);
    });

    await scenario(
        "Agent start rethrows original failures while sidebar start still returns false with a notice",
        async () => {
            const { controller, routes, terminals, notices } = fixture();
            const failure = Object.assign(new Error("probe preparation failed"), { code: "CONFIG_INCOMPLETE" });
            controller.start = async () => {
                throw failure;
            };
            await assert.rejects(routes["rtt.start"](), (error) => error === failure);
            assert.strictEqual(notices.length, 1);
            assert.strictEqual(await terminals.startCommand(), false);
            assert.strictEqual(notices.length, 2);
            assert.strictEqual(notices[1].titleKey, "notice.rttStartFailed");
            controller.start = async () => {
                controller.state = "starting";
                controller._retry = { attempts: 1, delayMs: 200, reason: "initializing" };
                return controller.status();
            };
            const started = await routes["rtt.start"]({});
            assert.strictEqual(started.state, "starting");
            assert.strictEqual(terminals.state, "starting");
            assert.strictEqual(started.retry.attempts, 1);
            assert.strictEqual("servers" in started, false);
            assert.strictEqual((await terminals.startCommand()).state, "starting");
        }
    );

    await scenario("Stop uses the terminal flow and is idempotent even before a start", async () => {
        const { routes, terminals } = fixture();
        let stops = 0;
        const stop = terminals.stopCommand.bind(terminals);
        terminals.stopCommand = async () => {
            stops++;
            await stop();
        };
        const first = await routes["rtt.stop"]();
        assert.strictEqual(first.state, "stopped");
        assert.deepStrictEqual(await routes["rtt.stop"]({}), first);
        assert.strictEqual(stops, 2);
    });

    await scenario("No RTT write surface exists in routes, tools or the skill client", () => {
        const routes = Object.keys(createAgentRoutes({})).filter((method) => method.startsWith("rtt."));
        assert.deepStrictEqual(routes, ["rtt.status", "rtt.read", "rtt.start", "rtt.stop"]);
        assert.deepStrictEqual(
            TOOLS.filter((tool) => tool.name.startsWith("rtt_")).map((tool) => tool.name),
            ["rtt_status", "rtt_read", "rtt_control"]
        );
        for (const method of ["status", "read", "start", "stop"])
            assert.strictEqual(args([`--${method}`]).method, `rtt.${method}`);
        for (const argv of [
            ["--write", "x"],
            ["--read", "--data", "x"],
            ["--start", "--input", "x"]
        ])
            assert.throws(() => args(argv), /Unknown argument/);
        for (const set of [client.OBSERVATION_METHODS, client.READ_ONLY_METHODS, client.DRIVER_SETUP_METHODS])
            assert.strictEqual(set.has("rtt.write"), false);
        assert.strictEqual(client.DRIVER_SETUP_METHODS.has("rtt.start"), true);
        assert.strictEqual(client.DRIVER_SETUP_METHODS.has("rtt.read"), false);
        assert.strictEqual(client.DRIVER_SETUP_METHODS.has("rtt.status"), false);
        for (const method of ["rtt.start", "rtt.stop"]) {
            const diagnostic = client.diagnosticForError(
                Object.assign(new Error("timeout"), {
                    code: "BRIDGE_TIMEOUT",
                    details: { method, resultUnknown: true }
                }),
                { operation: method }
            );
            assert.ok(diagnostic.error.actions.some((action) => action.method === "rtt.status"));
        }
    });
    console.log("RTT Agent tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
