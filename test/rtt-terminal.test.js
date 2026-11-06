"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const { RttTerminalService, MAX_INPUT_BYTES } = require("../src/services/rttTerminalService");
const { RttBuffer } = require("../src/rttBuffer");
const { formatTimestamp } = require("../src/rttLineFormatter");
const { FakeClock } = require("./helpers/fake-clock");
const { createRttTerminals, createRttController } = require("../src/composition");

class FakeEventEmitter {
    constructor() {
        this.listeners = new Set();
        this.event = (listener) => {
            this.listeners.add(listener);
            return { dispose: () => this.listeners.delete(listener) };
        };
    }
    fire(data) {
        for (const listener of [...this.listeners]) listener(data);
    }
    dispose() {
        this.listeners.clear();
    }
}

const oneChannel = {
    up: [{ index: 0, name: "Terminal", size: 1024, flags: 2, mode: "block" }],
    down: [{ index: 0, name: "Input", size: 2048, flags: 0, mode: "skip" }]
};
const twoChannels = {
    up: [
        { index: 0, name: "Terminal", size: 1024, flags: 2, mode: "block" },
        { index: 2, name: "Log", size: 512, flags: 0, mode: "skip" }
    ],
    down: [{ index: 0, name: "Input", size: 16, flags: 0, mode: "skip" }]
};

function fakeVscode() {
    const terminals = [];
    return {
        EventEmitter: FakeEventEmitter,
        window: {
            createTerminal: (options) => {
                const terminal = {
                    name: options.name,
                    pty: options.pty,
                    shown: 0,
                    show: () => {
                        terminal.shown++;
                    }
                };
                terminals.push(terminal);
                options.pty.open();
                return terminal;
            }
        },
        terminals
    };
}

// A controller stand-in with real RttBuffers: emit() feeds a channel, start/stop/reattach move the state and
// notify() reaches the service the way the provider forwards the controller's onStatus.
function fakeController(channels) {
    const writes = [];
    let generation = 0;
    let state = "stopped";
    let buffers = new Map();
    let yieldedFor = null;
    let extras = {};
    const controller = {
        writes,
        notify: null,
        status() {
            return {
                state,
                yieldedFor,
                ...extras,
                channels,
                buffers: [...buffers.entries()].map(([channel, buffer]) => ({
                    channel,
                    connected: true,
                    ...buffer.stats()
                }))
            };
        },
        async start() {
            generation += 1;
            state = "running";
            extras = {};
            buffers = new Map(channels.up.map((channel) => [channel.index, new RttBuffer({ generation })]));
            controller.notify?.(controller.status());
            return controller.status();
        },
        async stop() {
            state = "stopped";
            extras = { reason: "user-stopped" };
            buffers = new Map();
            controller.notify?.(controller.status());
            return controller.status();
        },
        setState(next, { yieldedFor: operation, ...rest } = {}) {
            state = next;
            yieldedFor = operation || null;
            extras = rest;
            if (next === "stopped") buffers = new Map();
            controller.notify?.(controller.status());
        },
        reattach() {
            generation += 1;
            buffers = new Map(channels.up.map((channel) => [channel.index, new RttBuffer({ generation })]));
            controller.notify?.(controller.status());
        },
        emit(channel, data) {
            buffers.get(channel)?.append(data);
        },
        read(channel, request) {
            if (state !== "running") throw Object.assign(new Error("RTT is stopped"), { code: "RTT_NOT_RUNNING" });
            return buffers.get(channel).read(request);
        },
        write(channel, data) {
            if (state !== "running") throw Object.assign(new Error("RTT is stopped"), { code: "RTT_NOT_RUNNING" });
            writes.push({ channel, data: String(data) });
            return Buffer.byteLength(String(data));
        }
    };
    return controller;
}

function makeService({ channels = oneChannel, settings = {}, vscode } = {}) {
    const controller = fakeController(channels);
    const notices = [];
    const noticeIds = [];
    const cleared = [];
    const posted = [];
    const clock = new FakeClock();
    const service = new RttTerminalService({
        vscode: vscode || fakeVscode(),
        clock,
        controller: () => controller,
        t: (key, params) => key + (params?.bytes !== undefined ? ` ${params.bytes}` : ""),
        settings: () => ({ timestamps: false, logFile: "", logMaxBytes: 8 * 1024 * 1024, ...settings }),
        onNotice: (notice, id) => {
            notices.push(notice);
            noticeIds.push(id);
        },
        clearNotice: (id) => cleared.push(id),
        post: (message) => posted.push(message)
    });
    controller.notify = (status) => service.onStatus(status);
    return { service, controller, clock, notices, noticeIds, cleared, posted, vscode: service._vscode };
}

// Everything the service fires at one terminal's pty, collected from the moment this is called.
const firedOf = (terminal) => {
    const chunks = [];
    terminal.pty.onDidWrite((text) => chunks.push(text));
    return () => chunks.join("");
};

(async () => {
    await scenario("start creates one revealed terminal per up channel", async () => {
        const { service, vscode } = makeService({ channels: twoChannels });
        await service.startCommand();
        assert.deepStrictEqual(
            vscode.terminals.map((terminal) => terminal.name),
            ["EmberProbe RTT #0 Terminal", "EmberProbe RTT #2 Log"]
        );
        assert.ok(
            vscode.terminals.every((terminal) => terminal.shown >= 1),
            "the terminals are revealed"
        );
        await service.stopCommand();
    });

    await scenario("channel data reaches the terminal as CRLF terminal text", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, Buffer.from("hello\nwor"));
        await clock.advance(50);
        controller.emit(0, Buffer.from("ld\r\n"));
        await clock.advance(50);
        assert.strictEqual(fired(), "hello\r\nworld\r\n");
        await service.stopCommand();
    });

    await scenario("UTF-8 split across chunks is joined before it is shown", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, Buffer.from("度"));
        await clock.advance(50);
        controller.emit(0, Buffer.from("r\n"));
        await clock.advance(50);
        assert.strictEqual(fired(), "度r\r\n");
        await service.stopCommand();
    });

    await scenario("host timestamps prefix each line when enabled", async () => {
        const { service, controller, clock, vscode } = makeService({ settings: { timestamps: true } });
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, Buffer.from("a\nb\n"));
        await clock.advance(50);
        const stamp = `[${formatTimestamp(clock.now())}] `;
        assert.strictEqual(fired(), `${stamp}a\r\n${stamp}b\r\n`);
        await service.stopCommand();
    });

    await scenario("Enter sends the echoed line to the down channel", async () => {
        const { service, controller, vscode } = makeService();
        await service.startCommand();
        const pty = vscode.terminals[0].pty;
        const fired = firedOf(vscode.terminals[0]);
        pty.handleInput("ab\x7fc\r");
        assert.deepStrictEqual(controller.writes, [{ channel: 0, data: "ac\n" }]);
        assert.strictEqual(fired(), "ab\b \bc\r\n");
        await service.stopCommand();
    });

    await scenario("escape sequences and control characters never reach the line", async () => {
        const { service, controller, vscode } = makeService();
        await service.startCommand();
        const pty = vscode.terminals[0].pty;
        const fired = firedOf(vscode.terminals[0]);
        pty.handleInput("\u001b[A\u0003ok\r");
        assert.deepStrictEqual(controller.writes, [{ channel: 0, data: "ok\n" }]);
        assert.strictEqual(fired(), "ok\r\n");
        await service.stopCommand();
    });

    await scenario("oversized input is capped at the line limit", async () => {
        const { service, controller, vscode } = makeService();
        await service.startCommand();
        vscode.terminals[0].pty.handleInput("x".repeat(MAX_INPUT_BYTES + 40));
        vscode.terminals[0].pty.handleInput("\r");
        assert.strictEqual(controller.writes.length, 1);
        assert.strictEqual(controller.writes[0].data.length, MAX_INPUT_BYTES + 1);
        await service.stopCommand();
    });

    await scenario("the line ending setting applies to the next line", async () => {
        const settings = { inputLineEnding: "crlf" };
        const { service, controller, vscode } = makeService({ settings });
        await service.startCommand();
        const { pty } = vscode.terminals[0];
        pty.handleInput("a\r");
        settings.inputLineEnding = "none";
        pty.handleInput("\r");
        pty.handleInput("b\r");
        settings.inputLineEnding = "cr";
        pty.handleInput("c\r");
        assert.deepStrictEqual(
            controller.writes.map((write) => write.data),
            ["a\r\n", "b", "c\r"]
        );
        await service.stopCommand();
    });

    await scenario("raw input sends keystrokes at once with no local echo", async () => {
        const { service, controller, vscode } = makeService({ settings: { inputMode: "raw" } });
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        const { pty } = vscode.terminals[0];
        pty.handleInput("a");
        pty.handleInput("\u0003");
        pty.handleInput("\u001b[A");
        pty.handleInput("\r");
        assert.deepStrictEqual(
            controller.writes.map((write) => write.data),
            ["a", "\u0003", "\u001b[A", "\r"]
        );
        assert.strictEqual(fired(), "");
        await service.stopCommand();
    });

    await scenario("raw input over the down buffer is refused whole", async () => {
        const { service, controller, vscode } = makeService({ channels: twoChannels, settings: { inputMode: "raw" } });
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        vscode.terminals[0].pty.handleInput("x".repeat(16));
        assert.deepStrictEqual(controller.writes, []);
        assert.ok(fired().includes("rtt.inputTooLong 16"));
        vscode.terminals[1].pty.handleInput("x");
        assert.deepStrictEqual(controller.writes, [], "a channel with no down buffer sends nothing");
        await service.stopCommand();
    });

    await scenario(
        "input goes to the mapped down channel's size, and the write stays addressed by up channel",
        async () => {
            const channels = {
                up: [{ ...oneChannel.up[0], downChannel: 1 }],
                down: [
                    { index: 0, size: 0 },
                    { index: 1, size: 8 }
                ]
            };
            const { service, controller, vscode } = makeService({ channels });
            await service.startCommand();
            vscode.terminals[0].pty.handleInput("hi\r");
            assert.deepStrictEqual(controller.writes, [{ channel: 0, data: "hi\n" }]);
            await service.stopCommand();
        }
    );

    await scenario("a channel's format and encoding choose its formatter", async () => {
        const channels = {
            up: [
                { ...oneChannel.up[0], format: "text", encoding: "gbk" },
                { index: 1, name: "Bin", size: 64, format: "hex", encoding: "utf-8" },
                { index: 2, name: "Shell", size: 64, format: "raw", encoding: "utf-8" }
            ],
            down: []
        };
        const { service, controller, clock, vscode } = makeService({ channels });
        await service.startCommand();
        const fired = vscode.terminals.map(firedOf);
        controller.emit(0, Buffer.of(0xce, 0xc2, 0x0a));
        controller.emit(1, Buffer.of(0x41));
        controller.emit(2, Buffer.from("\x1b[2J\n"));
        await clock.advance(100);
        assert.strictEqual(fired[0](), "温\r\n");
        assert.strictEqual(fired[1](), `00000000  41${" ".repeat(45)}  |A|\r\n`);
        assert.strictEqual(fired[2](), "\x1b[2J\n");
        await service.stopCommand();
    });

    await scenario("virtual terminals apply only to channel 0 and follow the setting", async () => {
        const marked = Buffer.concat([Buffer.of(0xff, 0x31), Buffer.from("x\n")]);
        const run = async (settings) => {
            const { service, controller, clock, vscode } = makeService({ channels: twoChannels, settings });
            await service.startCommand();
            const fired = vscode.terminals.map(firedOf);
            for (const channel of [0, 2]) controller.emit(channel, marked);
            await clock.advance(100);
            const text = fired.map((read) => read());
            await service.stopCommand();
            return text;
        };
        const [first, second] = await run({});
        assert.strictEqual(first, "[T1] x\r\n");
        assert.ok(!second.includes("[T1]"));
        assert.ok(!(await run({ virtualTerminals: false }))[0].includes("[T1]"));
    });

    await scenario("with timestamps, arriving bytes take their time at once", async () => {
        const { service, controller, clock, vscode } = makeService({ settings: { timestamps: true } });
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, "a\n");
        service.dataArrived(0);
        assert.strictEqual(fired(), `[${formatTimestamp(clock.now())}] a\r\n`);
        service.dataArrived(9);
        await service.stopCommand();
    });

    await scenario("without timestamps, arriving bytes wait for the tick", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, "a\n");
        service.dataArrived(0);
        assert.strictEqual(fired(), "");
        await clock.advance(100);
        assert.strictEqual(fired(), "a\r\n");
        await service.stopCommand();
    });

    await scenario("a gap finishes the partial line before its marker", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, "partial\r");
        await clock.advance(100);
        const read = controller.read;
        controller.read = (channel, request) => {
            controller.read = read;
            return { ...read(channel, request), droppedBytes: 4 };
        };
        controller.emit(0, "x");
        await clock.advance(100);
        const text = fired();
        assert.ok(text.indexOf("partial\r") < text.indexOf("rtt.termGap"));
        assert.ok(text.endsWith("x"));
        await service.stopCommand();
    });

    await scenario("a raw log holds the channel's bytes and none of the terminal's text", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rtt-raw-"));
        const file = path.join(directory, "rtt.bin");
        const settings = { logFile: file, logRaw: true, timestamps: true };
        const { service, controller, clock } = makeService({ settings });
        await service.startCommand();
        const bytes = Buffer.of(0x00, 0xff, 0x0a, 0x80);
        controller.emit(0, bytes);
        await clock.advance(100);
        await service.stopCommand();
        await service.dispose();
        assert.deepStrictEqual(fs.readFileSync(file), bytes);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    await scenario("automatic start keeps focus and reports a failure without throwing", async () => {
        const { service, controller, notices, vscode } = makeService();
        const status = await service.startAutoCommand();
        assert.strictEqual(status.state, "running");
        assert.strictEqual(vscode.terminals[0].shown, 1, "only the creation show, which keeps focus");
        await service.stopCommand();
        controller.start = async () => {
            throw Object.assign(new Error("nope"), { code: "RTT_INVALID_CHANNELS" });
        };
        assert.strictEqual(await service.startAutoCommand(), false);
        assert.strictEqual(notices.length, 1);
    });

    await scenario("input without a down buffer warns and writes nothing", async () => {
        const channels = { up: oneChannel.up, down: [] };
        const { service, controller, notices, vscode } = makeService({ channels });
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        vscode.terminals[0].pty.handleInput("hi\r");
        assert.deepStrictEqual(controller.writes, []);
        assert.strictEqual(fired(), "hi\r\n\x1b[33mrtt.inputUnavailable\x1b[0m\r\n");
        assert.deepStrictEqual(notices, [], "the problem stays in the terminal being typed in");
        await service.stopCommand();
    });

    await scenario("a write failure is shown in the terminal", async () => {
        const { service, controller, notices, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.write = () => {
            throw Object.assign(new Error("RTT channel 0 lost its data connection"), {
                code: "RTT_CHANNEL_DISCONNECTED"
            });
        };
        vscode.terminals[0].pty.handleInput("hi\r");
        assert.ok(fired().includes("rtt.writeFailed: rtt.err.channelDisconnected"), JSON.stringify(fired()));
        assert.deepStrictEqual(notices, []);
        await service.stopCommand();
    });

    await scenario("stopping flushes the formatter, marks the stop and keeps the terminal", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const terminal = vscode.terminals[0];
        const fired = firedOf(terminal);
        let closed = false;
        terminal.pty.onDidClose(() => {
            closed = true;
        });
        controller.emit(0, Buffer.from("tail")); // No newline: the flush emits it on close.
        await clock.advance(50);
        await service.stopCommand();
        assert.ok(fired().endsWith("tail\r\nrtt.termStopped\r\n"), `unexpected tail: ${JSON.stringify(fired())}`);
        assert.strictEqual(closed, false, "the output stays readable");
        terminal.pty.handleInput("ignored\r");
        assert.deepStrictEqual(controller.writes, [], "a stopped terminal takes no input");
        const afterStop = fired();
        controller.emit(0, Buffer.from("late\n"));
        await clock.advance(200);
        assert.strictEqual(fired(), afterStop, "polling stops with the terminal");
    });

    await scenario("a yield pauses the terminals and a re-attach marks the boundary", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, Buffer.from("before\n"));
        await clock.advance(50);
        controller.setState("pending-host", { yieldedFor: "download" });
        assert.ok(fired().includes("rtt.termPending"), "the pause is shown in the terminal");
        controller.emit(0, Buffer.from("dropped")); // No polling while pending: nothing is read.
        await clock.advance(200);
        controller.setState("running");
        controller.reattach();
        assert.ok(fired().includes("rtt.termReattached"), "the re-attach is shown in the terminal");
        controller.emit(0, Buffer.from("after\n"));
        await clock.advance(50);
        assert.ok(fired().endsWith("after\r\n"), "data flows again from the new attachment");
        await service.stopCommand();
    });

    await scenario("a closed terminal keeps its channel and can be reopened", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const first = vscode.terminals[0];
        const firedFirst = firedOf(first);
        first.pty.close();
        controller.emit(0, Buffer.from("while closed\n"));
        await clock.advance(50);
        assert.strictEqual(firedFirst(), "", "a closed terminal receives nothing");
        assert.ok(service.showTerminals(), "the channel is shown again");
        const second = vscode.terminals.at(-1);
        assert.notStrictEqual(second, first);
        assert.ok(second.shown >= 1);
        const firedSecond = firedOf(second);
        controller.emit(0, Buffer.from("reopened\n"));
        await clock.advance(50);
        assert.strictEqual(firedSecond(), "reopened\r\n");
        await service.stopCommand();
    });

    await scenario("showTerminals reports when nothing runs", async () => {
        const { service, notices } = makeService();
        assert.strictEqual(service.showTerminals(), false);
        assert.deepStrictEqual(notices, [{ level: "warning", key: "rtt.err.notRunning" }]);
    });

    await scenario("starts preserve user and Agent origins and localize target and mode policy failures", async () => {
        const { service, controller, notices } = makeService();
        const starts = [];
        controller.start = async (options) => {
            starts.push(options);
            return { state: "starting" };
        };
        await service.startCommand();
        await service.startAgentCommand();
        assert.deepStrictEqual(starts, [{ origin: "user" }, { origin: "agent" }]);
        for (const [code, key] of [
            ["RTT_EXACT_ADDRESS_REQUIRED", "rtt.err.exactAddressRequired"],
            ["RTT_TARGET_INVALID", "rtt.err.targetInvalid"],
            ["RTT_MODE_REQUIRES_UI_START", "rtt.err.modeRequiresUiStart"],
            ["RTT_MODE_TARGET_CHANGED", "rtt.err.modeTargetChanged"],
            ["RTT_READBACK_MISMATCH", "rtt.err.modeVerifyFailed"],
            ["RTT_ACCESS_UNSUPPORTED", "rtt.err.accessUnsupported"],
            ["RTT_CHANNEL_UNINITIALIZED", "rtt.err.unknownChannel"],
            ["RTT_INVALID_LAYOUT", "rtt.err.targetInvalid"],
            ["RTT_VALUE_CHANGED", "rtt.err.targetChanged"],
            ["RTT_IDENTITY_CHANGED", "rtt.err.targetChanged"],
            ["RTT_TARGET_BUDGET_EXCEEDED", "rtt.err.targetBudget"]
        ]) {
            const failure = Object.assign(new Error("raw backend text"), { code });
            controller.start = async () => {
                throw failure;
            };
            await assert.rejects(service.startAgentCommand(), (error) => error === failure);
            assert.strictEqual(notices.at(-1).error.i18nKey, key);
        }
        service.dispose();
    });

    await scenario("a start failure maps its code to an i18n key", async () => {
        const { service, controller, notices } = makeService();
        controller.start = async () => {
            throw Object.assign(new Error("Select the probe and target before starting RTT"), {
                code: "CONFIG_INCOMPLETE"
            });
        };
        assert.strictEqual(await service.startCommand(), false);
        const notice = notices.find((entry) => entry.titleKey === "notice.rttStartFailed");
        assert.ok(notice, "the failure is noticed");
        assert.strictEqual(notice.error.i18nKey, "rtt.err.configIncomplete");
    });

    await scenario("Agent starts reveal the same terminals and propagate noticed failures once", async () => {
        const { service, controller, notices, vscode } = makeService();
        const status = await service.startAgentCommand();
        assert.strictEqual(status.state, "running");
        assert.ok(vscode.terminals[0].shown > 0);
        await service.stopCommand();
        const failure = Object.assign(new Error("start timed out"), { code: "RTT_START_TIMEOUT" });
        controller.start = async () => {
            controller.setState("starting");
            controller.setState("stopped", { reason: "start-failed", error: failure });
            throw failure;
        };
        const before = notices.length;
        await assert.rejects(service.startAgentCommand(), (error) => error === failure);
        assert.strictEqual(notices.length, before + 1, "the catch does not duplicate the status notice");
        service.dispose();
    });

    await scenario("a restart reuses the stopped terminal and marks the boundary", async () => {
        const { service, controller, clock, posted, vscode } = makeService();
        await service.startCommand();
        const terminal = vscode.terminals[0];
        const fired = firedOf(terminal);
        await service.stopCommand();
        assert.strictEqual(posted.at(-1).view.terminals, 1, "the stopped terminal can still be shown");
        await service.startCommand();
        assert.strictEqual(vscode.terminals.length, 1, "no second terminal appears");
        controller.emit(0, "again\n");
        await clock.advance(50);
        assert.ok(fired().includes("rtt.termStopped\r\n\r\nrtt.termReattached\r\nagain\r\n"), JSON.stringify(fired()));
        await service.stopCommand();
    });

    await scenario("closing a stopped terminal releases it and a closed one does not come back", async () => {
        const { service, posted, vscode } = makeService();
        await service.startCommand();
        await service.stopCommand();
        vscode.terminals[0].pty.close();
        assert.strictEqual(posted.at(-1).view.terminals, 0);
        await service.startCommand();
        assert.strictEqual(vscode.terminals.length, 2, "a released terminal is created anew");
        vscode.terminals[1].pty.close();
        await service.stopCommand();
        assert.strictEqual(posted.at(-1).view.terminals, 0, "nothing is kept for a terminal already closed");
        assert.strictEqual(service.showTerminals(), false);
        assert.strictEqual(vscode.terminals.length, 2);
    });

    await scenario("a channel the firmware renamed gets a new terminal", async () => {
        const channels = { up: [{ ...oneChannel.up[0] }], down: [] };
        const { service, vscode } = makeService({ channels });
        await service.startCommand();
        await service.stopCommand();
        channels.up[0].name = "Console";
        await service.startCommand();
        assert.deepStrictEqual(
            vscode.terminals.map((terminal) => terminal.name),
            ["EmberProbe RTT #0 Terminal", "EmberProbe RTT #0 Console"]
        );
        await service.stopCommand();
    });

    await scenario("the terminal's last line names why RTT ended", async () => {
        for (const [options, expected] of [
            [{ reason: "host-ended" }, "rtt.termHostEnded\r\n"],
            [{ reason: "host-lost" }, "rtt.termHostLost\r\n"],
            [
                { reason: "start-failed", error: { code: "RTT_START_TIMEOUT", message: "x" } },
                "rtt.termStopped\r\nrtt.err.startTimeout\r\n"
            ],
            [
                { reason: "resume-failed", error: { code: "OTHER", message: "raw text" } },
                "rtt.termStopped\r\nraw text\r\n"
            ]
        ]) {
            const { service, controller, vscode } = makeService();
            await service.startCommand();
            const fired = firedOf(vscode.terminals[0]);
            controller.setState("stopped", options);
            assert.ok(fired().endsWith(expected), JSON.stringify(fired()));
        }
    });

    await scenario("a failure the user did not start reaches the notice box once", async () => {
        const { service, controller, notices, posted } = makeService();
        await service.startCommand();
        controller.setState("starting");
        const error = { code: "RTT_START_TIMEOUT", message: "gave up" };
        controller.setState("stopped", { reason: "start-failed", error });
        controller.setState("stopped", { reason: "start-failed", error });
        assert.strictEqual(notices.length, 1);
        assert.strictEqual(notices[0].titleKey, "notice.rttStartFailed");
        assert.strictEqual(notices[0].level, "error");
        assert.strictEqual(notices[0].error.i18nKey, "rtt.err.startTimeout");
        assert.strictEqual(posted.at(-1).state, "stopped");
        controller.setState("running");
        controller.setState("stopped", { reason: "resume-failed", error: { code: "X", message: "m" } });
        assert.strictEqual(notices.at(-1).titleKey, "notice.rttStopped");
        controller.setState("running");
        controller.setState("stopped", { reason: "host-lost" });
        assert.deepStrictEqual(notices.at(-1), { level: "warning", key: "rtt.err.hostLost" });
        const before = notices.length;
        controller.setState("running");
        controller.setState("stopped", { reason: "host-ended" });
        controller.setState("running");
        await service.stopCommand();
        assert.strictEqual(notices.length, before, "planned stops are not failures");
    });

    await scenario("a start that fails after attaching reports once and clears earlier notices", async () => {
        const { service, controller, notices, cleared } = makeService();
        const failure = Object.assign(new Error("gave up"), { code: "RTT_START_TIMEOUT" });
        controller.start = async () => {
            controller.setState("starting");
            controller.setState("stopped", {
                reason: "start-failed",
                error: { code: failure.code, message: failure.message }
            });
            throw failure;
        };
        assert.strictEqual(await service.startCommand(), false);
        assert.strictEqual(notices.length, 1);
        assert.deepStrictEqual(cleared, ["rtt", "rtt-channels", "rtt-log"]);
    });

    await scenario("conditions of a running attachment warn once each", async () => {
        const { service, controller, notices, noticeIds, cleared } = makeService();
        await service.startCommand();
        const error = { code: "RTT_CHANNEL_DISCONNECTED", message: "lost" };
        controller.setState("running", { error });
        controller.setState("running", { error });
        assert.strictEqual(notices.length, 1);
        assert.strictEqual(notices[0].error.i18nKey, "rtt.err.channelDisconnected");
        controller.setState("running", { missingChannels: [3, 5] });
        controller.setState("running", { missingChannels: [3, 5] });
        assert.strictEqual(notices.length, 2);
        assert.deepStrictEqual(notices[1].params, { channels: "3, 5" });
        assert.strictEqual(noticeIds[1], "rtt-channels");
        controller.setState("pending-host");
        cleared.length = 0;
        controller.setState("running");
        assert.deepStrictEqual(cleared, ["rtt", "rtt-channels"], "a resumed attachment starts clean");
        await service.stopCommand();
    });

    await scenario("showTerminals says the terminals are coming while RTT starts", async () => {
        const { service, controller, notices } = makeService();
        controller.setState("starting");
        assert.strictEqual(service.showTerminals(), false);
        assert.deepStrictEqual(notices, [{ level: "info", key: "rtt.terminalsPending" }]);
    });

    await scenario("a yield is noted once however many states it passes through", async () => {
        const { service, controller, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.setState("pending-host", { reason: "yielded" });
        controller.setState("pending-host", { reason: "host-switched" });
        controller.setState("starting");
        assert.strictEqual(fired().split("rtt.termPending").length - 1, 1);
        controller.setState("running");
        controller.setState("pending-host");
        assert.strictEqual(fired().split("rtt.termPending").length - 1, 2, "the next yield notes again");
        controller.setState("running");
        await service.stopCommand();
    });

    await scenario("Esc alone does not swallow the keys after it", async () => {
        const { service, controller, vscode } = makeService();
        await service.startCommand();
        const pty = vscode.terminals[0].pty;
        pty.handleInput("\x1b");
        pty.handleInput("1");
        pty.handleInput("2");
        pty.handleInput("\x1bOA\x1b[1;5C\x1bx");
        pty.handleInput("\r");
        assert.deepStrictEqual(controller.writes, [{ channel: 0, data: "12\n" }]);
        await service.stopCommand();
    });

    await scenario("backspace erases the cells a character took", async () => {
        const { service, controller, vscode } = makeService();
        await service.startCommand();
        const pty = vscode.terminals[0].pty;
        const fired = firedOf(vscode.terminals[0]);
        pty.handleInput("中");
        pty.handleInput("\x7f");
        assert.strictEqual(fired(), "中\b\b  \b\b");
        pty.handleInput("\x7f");
        assert.strictEqual(fired(), "中\b\b  \b\b", "an empty line has nothing to erase");
        pty.handleInput("😀é\x7f\x7f\r");
        assert.strictEqual(controller.writes[0].data, "\n");
        assert.ok(fired().includes("😀é\b \b\b\b  \b\b"), JSON.stringify(fired()));
        await service.stopCommand();
    });

    await scenario("a line that cannot fit the down buffer is refused whole", async () => {
        const channels = { up: oneChannel.up, down: [{ index: 0, size: 16 }] };
        const { service, controller, vscode } = makeService({ channels });
        await service.startCommand();
        const pty = vscode.terminals[0].pty;
        const fired = firedOf(vscode.terminals[0]);
        pty.handleInput("x".repeat(15) + "\r");
        assert.deepStrictEqual(controller.writes, []);
        assert.ok(fired().includes("rtt.inputTooLong"));
        pty.handleInput("x".repeat(14) + "\r");
        assert.strictEqual(controller.writes[0].data.length, 15, "size minus one fits");
        await service.stopCommand();
    });

    await scenario("the log keeps session marks and only the input that was sent", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-term-"));
        const logFile = path.join(dir, "rtt.log");
        try {
            const { service, controller, clock, vscode } = makeService({ settings: { logFile } });
            await service.startCommand();
            const pty = vscode.terminals[0].pty;
            pty.handleInput("sent\r");
            const write = controller.write;
            controller.write = () => {
                throw Object.assign(new Error("busy"), { code: "RTT_INPUT_BUSY" });
            };
            pty.handleInput("dropped\r");
            controller.write = write;
            controller.emit(0, "first\n");
            await clock.advance(50);
            controller.emit(0, "x".repeat(300000));
            await clock.advance(50);
            controller.setState("pending-host");
            controller.setState("running");
            controller.reattach();
            await clock.advance(50);
            await service.stopCommand();
            const log = fs.readFileSync(logFile, "utf8");
            assert.ok(log.startsWith("sent\r\nfirst\r\n"), log.slice(0, 40));
            assert.ok(!log.includes("dropped"));
            assert.ok(log.includes("rtt.termGap 37856\r\n"), "the exact reader gap is recorded");
            assert.ok(log.includes("rtt.termReattached"), "the attachment boundary is recorded");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await scenario("a broken log path reports once until its settings change", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-term-"));
        const logFile = path.join(dir, "missing", "rtt.log");
        const settings = { logFile };
        try {
            const { service, controller, clock, notices, noticeIds, cleared } = makeService({ settings });
            await service.startCommand();
            controller.emit(0, "a\n");
            await clock.advance(50);
            controller.setState("running");
            controller.emit(0, "b\n");
            await clock.advance(50);
            controller.setState("running");
            controller.emit(0, "c\n");
            await clock.advance(50);
            assert.strictEqual(notices.filter((notice) => notice.key === "rtt.logFailed").length, 1);
            assert.strictEqual(noticeIds[0], "rtt-log");
            fs.mkdirSync(path.dirname(logFile));
            controller.emit(0, "d\n");
            await clock.advance(50);
            assert.strictEqual(fs.existsSync(logFile), false, "the failed path stays off");
            service.settingsChanged();
            assert.ok(cleared.includes("rtt-log"));
            controller.emit(0, "e\n");
            await clock.advance(50);
            assert.strictEqual(fs.readFileSync(logFile, "utf8"), "e\r\n");
            await service.stopCommand();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await scenario("saving without a resolvable directory warns where the log would be", async () => {
        const settings = { logEnabled: true, logDirectory: "" };
        const { service, notices, noticeIds, posted } = makeService({ settings });
        await service.startCommand();
        assert.deepStrictEqual(notices, [{ level: "warning", key: "rtt.logNoDirectory" }]);
        assert.strictEqual(noticeIds[0], "rtt-log");
        service.settingsChanged();
        assert.strictEqual(notices.length, 2);
        assert.deepStrictEqual(posted.at(-1).view.log, { enabled: true, directory: "" });
        await service.stopCommand();
    });

    await scenario("a stopped channel no longer counts towards the per-channel log names", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-term-"));
        const channels = { up: [...twoChannels.up], down: [] };
        try {
            const logFile = path.join(dir, "rtt.log");
            const { service, controller, clock } = makeService({ channels, settings: { logFile } });
            await service.startCommand();
            await service.stopCommand();
            channels.up = [channels.up[0]];
            await service.startCommand();
            controller.emit(0, "one\n");
            await clock.advance(50);
            await service.stopCommand();
            assert.ok(fs.readFileSync(logFile, "utf8").endsWith("one\r\n"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await scenario("settings reach the sidebar with the status", async () => {
        const settings = { timestamps: false, logEnabled: false, logDirectory: "C:/logs" };
        const { service, posted } = makeService({ settings });
        service.postStatus();
        assert.deepStrictEqual(posted.at(-1).view, {
            terminals: 0,
            timestamps: false,
            log: { enabled: false, directory: "C:/logs" }
        });
        settings.timestamps = true;
        service.settingsChanged();
        assert.strictEqual(posted.at(-1).view.timestamps, true);
    });

    await scenario("the log file records plain text, one file per channel", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-term-"));
        try {
            const logFile = path.join(dir, "rtt.log");
            const { service, controller, clock } = makeService({
                channels: twoChannels,
                settings: { logFile, logMaxBytes: 1024 * 1024 }
            });
            await service.startCommand();
            controller.emit(0, Buffer.from("\x1b[31mred\x1b[0m line\n"));
            controller.emit(2, Buffer.from("second\n"));
            await clock.advance(50);
            await service.stopCommand();
            assert.strictEqual(fs.readFileSync(path.join(dir, "rtt-ch0.log"), "utf8"), "red line\r\n");
            assert.strictEqual(fs.readFileSync(path.join(dir, "rtt-ch2.log"), "utf8"), "second\r\n");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await scenario("a single channel logs to the configured path itself", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-term-"));
        try {
            const logFile = path.join(dir, "rtt.log");
            const { service, controller, clock } = makeService({ settings: { logFile } });
            await service.startCommand();
            controller.emit(0, Buffer.from("only\n"));
            await clock.advance(50);
            await service.stopCommand();
            assert.strictEqual(fs.readFileSync(logFile, "utf8"), "only\r\n");
            assert.deepStrictEqual(fs.readdirSync(dir), ["rtt.log"]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await scenario("timestamp settings apply to the running terminals", async () => {
        const settings = { timestamps: false };
        const { service, controller, clock, vscode } = makeService({ settings });
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, Buffer.from("plain\n"));
        await clock.advance(50);
        settings.timestamps = true;
        service.settingsChanged();
        controller.emit(0, Buffer.from("stamped\n"));
        await clock.advance(50);
        const stamp = `[${formatTimestamp(clock.now())}] `;
        assert.strictEqual(fired(), `plain\r\n${stamp}stamped\r\n`);
        await service.stopCommand();
    });

    await scenario("dispose closes the entries without stop notes", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, Buffer.from("x\n"));
        await clock.advance(50);
        service.dispose();
        assert.strictEqual(fired(), "x\r\n", "no stop line is added by dispose");
        assert.strictEqual(service.state, "stopped");
    });
    await scenario("UTF-8 input including Enter fits the controller byte cap", async () => {
        const { service, controller, vscode } = makeService();
        await service.startCommand();
        const pty = vscode.terminals[0].pty;
        pty.handleInput("中".repeat(400) + "\r");
        assert.strictEqual(Buffer.byteLength(controller.writes[0].data), MAX_INPUT_BYTES - 1);
        pty.handleInput("😀\b好\r");
        assert.strictEqual(controller.writes[1].data, "好\n");
        await service.stopCommand();
    });

    await scenario("a session switch discards unfinished input and partial UTF-8 output", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const pty = vscode.terminals[0].pty;
        const fired = firedOf(vscode.terminals[0]);
        pty.handleInput("old");
        controller.emit(0, Buffer.from([0xe4, 0xb8]));
        await clock.advance(50);
        controller.setState("pending-host");
        pty.handleInput("ignored\r");
        controller.setState("running");
        controller.reattach();
        pty.handleInput("new\r");
        controller.emit(0, Buffer.from("new\n"));
        await clock.advance(50);
        assert.deepStrictEqual(controller.writes, [{ channel: 0, data: "new\n" }]);
        assert.ok(fired().endsWith("new\r\n"));
        assert.ok(!fired().includes("�"));
        await service.stopCommand();
    });

    await scenario("known generations count evictions before the first terminal poll", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, "x".repeat(300000));
        await clock.advance(50);
        assert.ok(fired().includes("rtt.termGap 37856\r\n"));
        assert.ok(!fired().includes("rtt.termReattached"), "initial retained history has no unknown boundary");
        await clock.advance(50);
        assert.strictEqual(fired().split("rtt.termGap").length - 1, 1, "the gap is counted once");
        await service.stopCommand();
    });

    await scenario(
        "empty reads report numeric gaps and unannounced generation resets in terminals and logs",
        async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-term-"));
            const logFile = path.join(dir, "rtt.log");
            const { service, controller, vscode } = makeService({ settings: { logFile } });
            try {
                await service.startCommand();
                const fired = firedOf(vscode.terminals[0]);
                let result = {
                    generation: 1,
                    cursor: 24,
                    nextCursor: 24,
                    droppedBytes: 24,
                    reset: false,
                    more: false,
                    data: Buffer.alloc(0)
                };
                controller.read = () => result;
                service.flush();
                result = { ...result, droppedBytes: 0 };
                service.flush();
                assert.strictEqual(fired(), "\r\nrtt.termGap 24\r\n");
                result = { ...result, generation: 2, cursor: 7, nextCursor: 7, reset: true };
                service.flush();
                result = { ...result, reset: false };
                service.flush();
                const expected = "\r\nrtt.termGap 24\r\n\r\nrtt.termReattached\r\n\r\nrtt.termGap 7\r\n";
                assert.strictEqual(fired(), expected);
                assert.strictEqual(fs.readFileSync(logFile, "utf8"), expected);
                controller.notify(controller.status()); // The status reports generation 1, which is another boundary.
                assert.strictEqual(fired().split("rtt.termReattached").length - 1, 2);
            } finally {
                service.dispose();
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    );

    await scenario("status generation changes mark unknown gaps once and count the new history eviction", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.reattach();
        controller.emit(0, "x".repeat(300000));
        controller.notify(controller.status());
        await clock.advance(50);
        assert.ok(fired().startsWith("\r\nrtt.termReattached\r\n\r\nrtt.termGap 37856\r\n"));
        assert.strictEqual(fired().split("rtt.termReattached").length - 1, 1);
        await service.stopCommand();
    });

    await scenario("buffer overruns mark the gap and continue from retained data", async () => {
        const { service, controller, clock, vscode } = makeService();
        await service.startCommand();
        const fired = firedOf(vscode.terminals[0]);
        controller.emit(0, "first\n");
        await clock.advance(50);
        controller.emit(0, "x".repeat(300000));
        await clock.advance(50);
        assert.ok(fired().includes("rtt.termGap"));
        await service.stopCommand();
    });

    await scenario("logs strip ANSI across chunks, flush CR, and apply settings live", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-rtt-term-"));
        const settings = { logFile: path.join(dir, "rtt.log"), logMaxBytes: 32 };
        const { service, controller, clock } = makeService({ settings });
        try {
            await service.startCommand();
            for (const chunk of ["\x1b[3", "1mred\x1b]0;ti", "tle\x1b", "\\\x1b[0m\r"]) {
                controller.emit(0, chunk);
                await clock.advance(50);
            }
            service.dispose();
            assert.strictEqual(fs.readFileSync(settings.logFile, "utf8"), "red\r");
            await service.startCommand();
            settings.stripAnsi = false;
            service.settingsChanged();
            controller.emit(0, "\x1b[31mhi\x1b[0m\n");
            await clock.advance(50);
            assert.ok(fs.readFileSync(settings.logFile, "utf8").includes("\x1b[31m"));
            settings.logFile = "";
            service.settingsChanged();
            const bytes = fs.statSync(path.join(dir, "rtt.log")).size;
            controller.emit(0, "not logged");
            await clock.advance(50);
            assert.strictEqual(fs.statSync(path.join(dir, "rtt.log")).size, bytes);
        } finally {
            service.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    await scenario("timestamp and save commands update settings and respect dialog cancellation", async () => {
        const vscode = fakeVscode();
        const values = {};
        const updates = [];
        let selected;
        vscode.ConfigurationTarget = { Workspace: 2, Global: 1 };
        vscode.workspace = {
            workspaceFolders: [{ uri: { fsPath: "C:/work" } }],
            getConfiguration: () => ({
                get: (key, fallback) => values[key] ?? fallback,
                update: async (key, value, target) => {
                    values[key] = value;
                    updates.push({ key, value, target });
                }
            })
        };
        vscode.window.showOpenDialog = async () => selected;
        const { service } = makeService({ vscode });
        await service.toggleTimestamps();
        assert.deepStrictEqual(updates.pop(), { key: "rtt.timestamps", value: true, target: 2 });
        await service.saveLog();
        assert.deepStrictEqual(updates, []);
        selected = [{ fsPath: "C:/logs" }];
        await service.saveLog();
        assert.strictEqual(values["rtt.logFile.directory"], "C:/logs");
        assert.strictEqual(values["rtt.logFile.enabled"], true);
        await service.saveLog();
        assert.strictEqual(values["rtt.logFile.enabled"], false);
        vscode.workspace.workspaceFolders = [];
        await service.toggleTimestamps();
        assert.deepStrictEqual(updates.at(-1), { key: "rtt.timestamps", value: false, target: 1 });
        service.dispose();
    });
    await scenario("composition resolves workspace log paths and forwards lifecycle statuses", async () => {
        const vscode = fakeVscode();
        const values = { "rtt.logFile.enabled": true, "rtt.logFile.directory": "logs" };
        vscode.workspace = {
            workspaceFolders: [{ uri: { fsPath: path.resolve("test-workspace") } }],
            getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback })
        };
        const posted = [];
        const host = {
            _t: (key) => key,
            _notices: { notify() {}, clear() {} },
            _webviewView: { webview: { postMessage: (message) => posted.push(message) } }
        };
        const controller = createRttController(host, vscode, null);
        host._rtt = controller;
        host._rttTerminals = host._rttTerminalController = createRttTerminals(host, vscode);
        const settings = host._rttTerminals._settings();
        assert.strictEqual(settings.logFile, path.resolve("test-workspace", "logs", "rtt.log"));
        assert.strictEqual(settings.logEnabled, true);
        assert.strictEqual(settings.logDirectory, path.resolve("test-workspace", "logs"));
        assert.strictEqual(settings.logMaxBytes, 8 * 1024 * 1024);
        values["rtt.logFile.enabled"] = false;
        assert.strictEqual(host._rttTerminals._settings().logFile, "");
        host._rttTerminals.postStatus();
        controller.onStatus({ state: "stopped", error: { code: "RTT_INVALID_CHANNELS" } });
        assert.strictEqual(posted.at(-1).error.code, "RTT_INVALID_CHANNELS");
        controller.onBeforeStop();
        vscode.workspace.workspaceFolders = [];
        values["rtt.logFile.enabled"] = true;
        assert.strictEqual(host._rttTerminals._settings().logFile, "");
        values["rtt.logFile.directory"] = path.resolve("logs");
        assert.strictEqual(host._rttTerminals._settings().logFile, path.resolve("logs", "rtt.log"));
        host._rttTerminals.dispose();
    });
    console.log("RTT terminal tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
