"use strict";

// Extension Host half of run-smoke.js --suite rtt. Needs firmware with the protocol of the H750_RttTest project: a text
// terminal on channel 0, a numbered line stream on channel 1. Commands and terminal input take the same paths as the
// sidebar and a user typing; Agent routes are called through the dispatcher.
const assert = require("assert");
const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { checkStream, delta32, fixtureDelta, parseFixtureStatus } = require("../helpers/rtt-stream");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REPLACEMENT = "\ufffd";
const REGISTRY_DIR = "agent-bridges";

// A plain Node child must not inherit the Electron switch of the Extension Host, and finds this host's Bridge in its
// private user data, not through a registry or pointer of another window.
function nodeEnv(storage) {
    const { ELECTRON_RUN_AS_NODE: _unused, ...env } = process.env;
    return { ...env, EMBERPROBE_BRIDGE_REGISTRY: path.join(storage, REGISTRY_DIR) };
}

function summarize(error) {
    return { message: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) };
}

function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { code: "HIL_STEP_TIMEOUT" })),
                ms
            );
        })
    ]).finally(() => clearTimeout(timer));
}

async function run() {
    const profile = JSON.parse(process.env.EMBERPROBE_SMOKE_PROFILE || "null");
    assert(profile, "EMBERPROBE_SMOKE_PROFILE is required");
    const rttChecks = profile.checks?.rtt || {};
    const stress = rttChecks.stress?.enabled ? rttChecks.stress : null;
    const stressOptions = {
        durationMs: stress?.durationMs ?? 3000,
        rate: stress?.rate ?? 32000,
        completionTimeoutMs: stress?.completionTimeoutMs ?? 30000,
        drainTimeoutMs: stress?.drainTimeoutMs ?? 10000
    };
    if (stress) {
        for (const [key, min, max] of [
            ["durationMs", 1000, 10000],
            ["rate", 16384, 96000],
            ["completionTimeoutMs", 5000, 60000],
            ["drainTimeoutMs", 1000, 30000]
        ])
            assert(
                Number.isInteger(stressOptions[key]) && stressOptions[key] >= min && stressOptions[key] <= max,
                `checks.rtt.stress.${key} must be an integer from ${min} to ${max}`
            );
        for (const [values, allowed, label] of [
            [stress.pollingIntervalsMs ?? [100, 10], [100, 10], "pollingIntervalsMs"],
            [
                stress.contexts ?? ["own-session", "live-watch", "debug-server"],
                ["own-session", "live-watch", "debug-server"],
                "contexts"
            ]
        ])
            assert(
                Array.isArray(values) &&
                    values.length > 0 &&
                    new Set(values).size === values.length &&
                    values.every((value) => allowed.includes(value)),
                `stress ${label} must select unique allowed values`
            );
        if (stress.maxSamplingIntervalMs !== undefined)
            assert(
                Number.isInteger(stress.maxSamplingIntervalMs) &&
                    stress.maxSamplingIntervalMs > 0 &&
                    stress.maxSamplingIntervalMs <= 10000,
                "stress maxSamplingIntervalMs must be from 1 to 10000"
            );
        assert(
            Number.isInteger(stress.samplingIntervalMs ?? 100) &&
                (stress.samplingIntervalMs ?? 100) >= 10 &&
                (stress.samplingIntervalMs ?? 100) <= 1000,
            "stress samplingIntervalMs must be an integer from 10 to 1000"
        );
    }
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    await extension.activate();
    const provider = extension.exports.debugTestProvider;
    const agent = provider._agentService;
    const terminals = provider._rttTerminals;
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const elf = path.join(folder, profile.elfRelative);
    const elfSha256 = crypto.createHash("sha256").update(fs.readFileSync(elf)).digest("hex");
    const directory = path.join(extension.extensionPath, "test-results");
    const file = path.join(directory, `hil-rtt-${process.platform}-${profile.name}.json`);
    const logDirectory = path.join(folder, "rtt-logs");
    const report = { profile: profile.name, elf: profile.elf, startedAt: new Date().toISOString(), steps: [] };
    const save = () => {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
    };
    const call = (method, params = {}) => agent.call(method, params);
    const command = (name, ...args) => vscode.commands.executeCommand(name, ...args);
    const setting = (key, value) =>
        vscode.workspace.getConfiguration("emberprobe").update(key, value, vscode.ConfigurationTarget.Workspace);

    let failures = 0;
    const only = process.env.EMBERPROBE_RTT_ONLY ? new RegExp(process.env.EMBERPROBE_RTT_ONLY, "u") : null;
    const step = async (name, action, timeoutMs = 30000) => {
        if (only && !only.test(name)) return undefined;
        const entry = { name, startedAt: new Date().toISOString() };
        report.steps.push(entry);
        const started = Date.now();
        try {
            entry.result = await withTimeout(Promise.resolve().then(action), timeoutMs, name);
            entry.ok = true;
            console.log(`  ok   ${name} (${Date.now() - started} ms)`);
            return entry.result;
        } catch (error) {
            entry.ok = false;
            entry.error = summarize(error);
            entry.rtt = await call("rtt.status").catch(summarize);
            failures++;
            console.log(`  FAIL ${name}: ${error.code || ""} ${error.message}`);
            return undefined;
        } finally {
            entry.ms = Date.now() - started;
            save();
        }
    };
    // Setup failures make every later step meaningless; the rest report independently.
    const required = async (name, action, timeoutMs) => {
        const before = failures;
        const result = await step(name, action, timeoutMs);
        if (failures !== before) throw new Error(`${name} failed`);
        return result;
    };
    const waitStatus = async (accept, timeoutMs = 20000) => {
        const deadline = Date.now() + timeoutMs;
        let status;
        do {
            status = await call("rtt.status");
            if (accept(status)) return status;
            await sleep(100);
        } while (Date.now() < deadline);
        throw Object.assign(new Error(`RTT status not reached: ${JSON.stringify(status).slice(0, 600)}`), {
            code: "HIL_RTT_STATE"
        });
    };
    const running = (source, timeoutMs) =>
        waitStatus((status) => status.state === "running" && (!source || status.source === source), timeoutMs);
    const stopped = (timeoutMs) => waitStatus((status) => status.state === "stopped", timeoutMs);
    const waitDebug = async (accept, timeoutMs = 30000) => {
        const deadline = Date.now() + timeoutMs;
        let status;
        do {
            status = await call("debug.status");
            if (accept(status)) return status;
            await sleep(200);
        } while (Date.now() < deadline);
        throw Object.assign(new Error(`Debug state stayed ${status.state}`), { code: "HIL_DEBUG_STATE" });
    };

    // Channel 1 is collected as raw bytes, independently of UTF-8 terminal/file formatting.
    const readers = new Map();
    const reader = (channel) => {
        if (!readers.has(channel))
            readers.set(channel, {
                generation: undefined,
                cursor: undefined,
                text: "",
                chunks: [],
                rawBytes: 0,
                dropped: 0,
                resets: 0
            });
        return readers.get(channel);
    };
    const pull = async (channel) => {
        const state = reader(channel);
        const deadline = Date.now() + 5000;
        for (;;) {
            const reply = await call("rtt.read", {
                channel,
                ...(channel === 1 ? { encoding: "base64" } : {}),
                ...(state.cursor !== undefined ? { generation: state.generation, cursor: state.cursor } : {})
            });
            if (reply.reset && state.cursor !== undefined) state.resets++;
            state.generation = reply.generation;
            state.cursor = reply.nextCursor;
            state.dropped += reply.droppedBytes || 0;
            if (channel === 1) {
                const bytes = Buffer.from(reply.dataBase64, "base64");
                state.chunks.push(bytes);
                state.rawBytes += bytes.length;
                state.text += bytes.toString("latin1");
            } else state.text += reply.text;
            if (!reply.more) return state;
            assert(Date.now() < deadline, "RTT consumer could not catch up within 5 seconds");
        }
    };
    const drain = async (channel) => {
        const state = await pull(channel);
        state.text = "";
        state.chunks = [];
        state.rawBytes = 0;
        state.dropped = 0;
        state.resets = 0;
    };
    const expectText = async (channel, pattern, timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        const state = reader(channel);
        do {
            await pull(channel);
            const match = pattern.exec(state.text);
            if (match) return match[0];
            await sleep(50);
        } while (Date.now() < deadline);
        throw Object.assign(new Error(`${pattern} not seen on channel ${channel}: ${state.text.slice(-400)}`), {
            code: "HIL_RTT_OUTPUT"
        });
    };
    const heartbeat = async () => {
        await drain(0);
        return expectText(0, /hb \d+ stream seq=\d+ dropped=\d+\r?\n/u);
    };

    // What each pseudoterminal showed, captured at its write event.
    const shown = new Map();
    const watched = new WeakSet();
    const watchTerminals = () => {
        for (const [channel, entry] of terminals._channels) {
            if (!entry.write || watched.has(entry.write)) continue;
            watched.add(entry.write);
            shown.set(channel, shown.get(channel) || "");
            entry.write.event((text) => shown.set(channel, shown.get(channel) + text));
        }
    };
    const terminal = (channel) => {
        const entry = terminals._channels.get(channel);
        assert(entry?.terminal, `no terminal for channel ${channel}`);
        return entry.terminal;
    };
    const type = (channel, text) => terminal(channel).sendText(`${text}\r`, false);
    const expectShown = async (channel, patterns, timeoutMs = 8000) => {
        const deadline = Date.now() + timeoutMs;
        const missing = () => patterns.filter((pattern) => !pattern.test(shown.get(channel) || ""));
        while (missing().length && Date.now() < deadline) await sleep(50);
        const left = missing();
        if (left.length)
            throw Object.assign(
                new Error(`${left.join(", ")} not shown on ${channel}: ${(shown.get(channel) || "").slice(-400)}`),
                { code: "HIL_RTT_OUTPUT" }
            );
    };
    // Settings are frozen at start, so each set gets its own start.
    const startWith = async (entries) => {
        await command("mcu-vscode.stopRtt");
        await stopped();
        for (const [key, value] of entries) await setting(key, value);
        await command("mcu-vscode.startRtt");
        const status = await running(null, 30000);
        readers.clear();
        shown.clear();
        watchTerminals();
        await drain(0);
        await expectText(0, /hb \d+/u);
        return status;
    };
    const withSettings = async (values, action) => {
        const settings = vscode.workspace.getConfiguration("emberprobe");
        const previous = Object.keys(values).map((key) => [key, settings.inspect(key)?.workspaceValue]);
        await startWith(Object.entries(values));
        try {
            return await action();
        } finally {
            await startWith(previous);
        }
    };
    // The firmware reports the bytes down channel 1 received since it was last asked.
    const received = async () => {
        await drain(0);
        type(0, "rx");
        const line = await expectText(0, /rx1:[ 0-9a-f]*\r?\n/u);
        return line.replace("rx1:", "").trim();
    };

    const flash = async () => {
        const plan = await call("flash.authorize", { elf, elfSha256, operation: "flash.execute" });
        assert(plan.confirmationRequired && plan.confirmationId, "flash did not request confirmation");
        const result = await call("flash.execute", { elf, elfSha256, confirmationId: plan.confirmationId });
        assert.strictEqual(result.verified, true, `flash failed: ${result.detail || "unverified"}`);
        return { verified: result.verified };
    };

    // Through the firmware's command, over the down channel: the channel must keep its buffer afterwards.
    const setUpMode = async (channel, mode) => {
        await drain(0);
        type(0, `mode ${channel} ${mode}`);
        await expectText(0, new RegExp(`ok: ch${channel} mode=${mode}`, "u"));
    };
    const firmwareStatus = async () => {
        await drain(0);
        type(0, "status");
        await expectText(0, /^status: ch1 mode=\w+ written=\d+ dropped=\d+ maxCycles=\d+\r?\n/mu);
        const status = parseFixtureStatus(reader(0).text);
        assert(status, `incomplete fixture status: ${reader(0).text.slice(-600)}`);
        return status;
    };
    const stopRate = async () => {
        await drain(0);
        type(0, "rate 0");
        await expectText(0, /ok: rate=0\r?\n/u);
    };
    // Producer completion precedes drain completion. Quiet time confirms no late TCP data beyond acceptedBytes;
    // failure to receive those bytes by the deadline fails instead of passing after an arbitrary capture duration.
    const drainAccepted = async (acceptedBytes, pollingIntervalMs, timeoutMs = 10000) => {
        const deadline = Date.now() + timeoutMs;
        const quietMs = Math.max(250, pollingIntervalMs * 3);
        let quietSince = null;
        do {
            const state = await pull(1);
            assert.strictEqual(state.resets, 0, "RTT generation changed during the stream capture");
            assert(
                state.rawBytes <= acceptedBytes,
                `received ${state.rawBytes} bytes, firmware accepted ${acceptedBytes}`
            );
            if (state.rawBytes === acceptedBytes) {
                quietSince ??= Date.now();
                if (Date.now() - quietSince >= quietMs) return;
            } else quietSince = null;
            await sleep(25);
        } while (Date.now() < deadline);
        throw new Error(
            `RTT drain timed out: accepted=${acceptedBytes}, rawReceived=${reader(1).rawBytes}, ` +
                `consumerGapBytes=${reader(1).dropped}, consumerResets=${reader(1).resets}`
        );
    };
    const prepareStream = async (pollingIntervalMs) => {
        await stopRate();
        const status = await firmwareStatus();
        // Clear prior captures only after the stopped producer and transport have quiesced.
        let previous = -1;
        let quietSince = Date.now();
        const deadline = Date.now() + 10000;
        do {
            const state = await pull(1);
            if (state.rawBytes !== previous) {
                previous = state.rawBytes;
                quietSince = Date.now();
            }
            if (Date.now() - quietSince >= Math.max(250, pollingIntervalMs * 3)) {
                await drain(1);
                return status;
            }
            await sleep(25);
        } while (Date.now() < deadline);
        throw new Error("RTT did not quiesce before stream capture");
    };
    const captureStream = async ({
        rate,
        mode,
        durationMs = 3000,
        pollingIntervalMs = 10,
        completionTimeoutMs = 30000,
        drainTimeoutMs = 10000,
        requireComplete = false
    } = {}) => {
        const before = await prepareStream(pollingIntervalMs);
        const started = Date.now();
        let after;
        if (rate) {
            type(0, `rate ${rate}`);
            try {
                const deadline = Date.now() + durationMs;
                while (Date.now() < deadline) {
                    await pull(1);
                    await sleep(25);
                }
            } finally {
                await stopRate();
            }
            after = await firmwareStatus();
        } else {
            type(0, "burst 64000");
            const deadline = Date.now() + completionTimeoutMs;
            for (;;) {
                await pull(1);
                after = await firmwareStatus();
                const attempts = delta32(after.sequence, before.sequence);
                assert(attempts <= 1000, `burst exceeded 1000 attempts: ${attempts}`);
                if (attempts === 1000) break;
                assert(Date.now() < deadline, `burst timed out at ${attempts}/1000 attempts`);
                await sleep(25);
            }
        }
        const producerCompletedMs = Date.now() - started;
        const counters = fixtureDelta(before, after);
        if (!rate) {
            assert.strictEqual(counters.attempts, 1000);
            assert.strictEqual(counters.attemptedBytes, 64000);
        } else assert(counters.attempts > 0, "sustained stream made no write attempts");
        let drainError;
        try {
            await drainAccepted(counters.acceptedBytes, pollingIntervalMs, drainTimeoutMs);
        } catch (error) {
            drainError = error;
        }
        const elapsedMs = Date.now() - started;
        const state = reader(1);
        const integrity = checkStream(state.chunks, counters);
        const result = {
            ...counters,
            ...integrity,
            requestedRate: rate || null,
            attemptedBytesPerSecond: (counters.attemptedBytes * 1000) / producerCompletedMs,
            producerCompletedMs,
            elapsedMs,
            rawReceivedBytes: state.rawBytes,
            rawReceiveBytesPerSecond: (state.rawBytes * 1000) / elapsedMs,
            consumerGapBytes: state.dropped,
            consumerResets: state.resets,
            before,
            after,
            overhead: { terminal: true, fileLog: true, timestamps: terminals._view().timestamps },
            ...(drainError ? { drainError: summarize(drainError) } : {})
        };
        // Keep measurements in failed-step reports too (including target refusal versus consumer gaps).
        report.steps.at(-1).captures ??= [];
        report.steps.at(-1).captures.push(result);
        if (drainError) throw drainError;
        assert.strictEqual(state.rawBytes, counters.acceptedBytes, JSON.stringify(result));
        assert.strictEqual(state.dropped, 0, JSON.stringify(result));
        assert.strictEqual(state.resets, 0, JSON.stringify(result));
        assert.strictEqual(integrity.duplicates, 0, JSON.stringify(result));
        assert.strictEqual(integrity.resets, 0, JSON.stringify(result));
        assert.strictEqual(integrity.outOfEnvelope, 0, JSON.stringify(result));
        if (mode === "skip") {
            assert.strictEqual(counters.rejectedBytes % 64, 0, JSON.stringify(result));
            assert.strictEqual(integrity.malformed, 0, JSON.stringify(result));
            assert.strictEqual(integrity.partialBytes, 0, JSON.stringify(result));
        }
        if (requireComplete || counters.rejectedBytes === 0) {
            assert.strictEqual(counters.rejectedBytes, 0, JSON.stringify(result));
            assert.strictEqual(integrity.complete, true, JSON.stringify(result));
            if (!rate) assert.strictEqual(integrity.lines, 1000, JSON.stringify(result));
        }
        return result;
    };

    try {
        await required("setup", async () => {
            fs.mkdirSync(logDirectory, { recursive: true });
            await setting("openocdPath", profile.openocd);
            await setting("armToolchainPath", profile.toolchain);
            await call("config.set", {
                values: {
                    elf: profile.elfRelative,
                    debugger: profile.probe,
                    mcu: profile.target,
                    transport: profile.transport,
                    adapterSpeedKhz: profile.adapterSpeedKhz,
                    rtos: profile.rtos
                }
            });
            if (profile.probeSerial)
                await provider._connectedProbes.selection().set({
                    probe: profile.probe,
                    probeSerial: profile.probeSerial,
                    source: "user"
                });
            await setting("rtt.channels", [0, 1]);
            await setting("rtt.pollingIntervalMs", 10);
            await setting("rtt.logFile.enabled", true);
            await setting("rtt.logFile.directory", "rtt-logs");
            await setting("rtt.logFile.maxBytes", 1048576);
            return call("probe.list");
        });
        await required("chip.read", () => call("chip.read", { sections: ["identity"] }));
        await required("flash", flash, 180000);

        await step("agent.stopped", async () => {
            const status = await call("rtt.status");
            assert.strictEqual(status.state, "stopped");
            await assert.rejects(call("rtt.read", {}), (error) => error.code === "RTT_NOT_RUNNING");
            await assert.rejects(call("rtt.write", {}), (error) => /METHOD|UNKNOWN|NOT_FOUND/u.test(error.code || ""));
            return status;
        });

        // --- Sidebar path ---
        await required(
            "ui.start",
            async () => {
                await command("mcu-vscode.startRtt");
                const status = await running(null, 30000);
                assert.strictEqual(status.source, "own-session", "with no session RTT must own one");
                assert.strictEqual(status.block.source, "symbol");
                const names = status.channels.up.map((channel) => channel.name);
                assert(names.includes("Terminal") && names.includes("Stream"), `channels: ${names}`);
                assert(!("servers" in status), "Agent status must not expose local ports");
                watchTerminals();
                return status;
            },
            45000
        );
        await step("ui.terminals", async () => {
            const names = vscode.window.terminals.map((item) => item.name).filter((name) => /RTT/u.test(name));
            assert(
                names.some((name) => /#0 .*Terminal/u.test(name)),
                `terminals: ${names}`
            );
            assert(
                names.some((name) => /#1 .*Stream/u.test(name)),
                `terminals: ${names}`
            );
            const view = terminals._view();
            return { names, view };
        });
        await step("output.boot", () =>
            expectText(0, /EmberProbe RTT test, profile=\w+, control block 0x[0-9a-f]{8}/u)
        );
        await step("output.heartbeat", heartbeat);
        await step("output.terminalMirrors", async () => {
            await sleep(600);
            assert(/hb \d+/u.test(shown.get(0) || ""), `terminal showed: ${(shown.get(0) || "").slice(-200)}`);
        });

        await step("input.channel0", async () => {
            await drain(0);
            type(0, "auto off");
            await expectText(0, /ok: auto=off/u);
            await drain(0);
            type(0, "echo 你好 RTT");
            return expectText(0, /echo: 你好 RTT/u);
        });
        await step("input.channel1", async () => {
            await drain(1);
            type(1, "ping");
            return expectText(1, /down1: ping/u);
        });
        await step("input.tooLong", async () => {
            const before = (shown.get(0) || "").length;
            await drain(0);
            type(0, "x".repeat(200));
            await sleep(500);
            const notice = (shown.get(0) || "").slice(before);
            assert(/\x1b\[33m/u.test(notice), `no refusal shown: ${JSON.stringify(notice.slice(-200))}`);
            await pull(0);
            assert(!reader(0).text.includes("xxxx"), "an oversized line reached the firmware");
        });

        await step("utf8.splitAcrossReads", async () => {
            await drain(0);
            type(0, "utf8");
            const line = await expectText(0, /utf8: [^\n]* end/u);
            assert.strictEqual(line, "utf8: 中文 🔥 end");
            assert(!reader(0).text.includes(REPLACEMENT));
            await sleep(300);
            assert(!(shown.get(0) || "").includes(REPLACEMENT), "the terminal split a character");
            return line;
        });
        await step("agent.readSmallLimit", async () => {
            await drain(0);
            type(0, "utf8");
            await sleep(900);
            let cursor = reader(0).cursor;
            const { generation } = reader(0);
            let text = "";
            for (let index = 0; index < 500 && !text.includes(" end"); index++) {
                const reply = await call("rtt.read", { channel: 0, generation, cursor, maxBytes: 1 });
                text += reply.text;
                cursor = reply.nextCursor;
                if (!reply.more && !reply.text) await sleep(20);
            }
            assert(text.includes("utf8: 中文 🔥 end"), `read ${JSON.stringify(text.slice(-100))}`);
            reader(0).cursor = cursor;
            return text.slice(-20);
        });
        await step("agent.readBase64", async () => {
            await drain(0);
            const { generation, cursor } = reader(0);
            type(0, "ansi");
            await sleep(500);
            const reply = await call("rtt.read", { channel: 0, generation, cursor, encoding: "base64" });
            const text = Buffer.from(reply.dataBase64, "base64").toString("utf8");
            assert(text.includes("\x1b[31mred\x1b[0m"), `raw bytes: ${JSON.stringify(text)}`);
            reader(0).cursor = reply.nextCursor;
        });

        await step("timestamps", async () => {
            await command("mcu-vscode.rttToggleTimestamps");
            await sleep(300);
            const before = (shown.get(0) || "").length;
            await sleep(2500);
            const text = (shown.get(0) || "").slice(before);
            assert(/\[\d\d:\d\d:\d\d\.\d{3}\] hb \d+/u.test(text), `no timestamp: ${JSON.stringify(text.slice(-200))}`);
            await command("mcu-vscode.rttToggleTimestamps");
            await sleep(1500);
        });

        await step("log.file", async () => {
            await sleep(500);
            const zero = path.join(logDirectory, "rtt-ch0.log");
            const one = path.join(logDirectory, "rtt-ch1.log");
            assert(fs.existsSync(zero) && fs.existsSync(one), `logs: ${fs.readdirSync(logDirectory)}`);
            const text = fs.readFileSync(zero, "utf8");
            assert(/hb \d+/u.test(text), "heartbeat missing from the log");
            assert(text.includes("ansi: red green bold yellow plain"), "ANSI was not stripped from the log");
            assert(/echo 你好 RTT/u.test(text), "sent input was not logged");
            assert(!text.includes("xxxxx"), "refused input was logged");
            assert(/\[\d\d:\d\d:\d\d\.\d{3}\] hb \d+/u.test(text), "timestamped lines missing from the log");
            return { bytes: text.length };
        });

        await step("input.lineEndings", async () => {
            await received();
            try {
                const seen = {};
                for (const [ending, bytes] of [
                    ["crlf", "61 62 0d 0a"],
                    ["cr", "61 62 0d"],
                    ["none", "61 62"],
                    ["lf", "61 62 0a"]
                ]) {
                    await setting("rtt.input.lineEnding", ending);
                    await sleep(200);
                    type(1, "ab");
                    await sleep(300);
                    await setting("rtt.input.lineEnding", "lf");
                    await sleep(200);
                    seen[ending] = await received();
                    assert.strictEqual(seen[ending], bytes, `${ending} sent other bytes`);
                }
                return seen;
            } finally {
                await setting("rtt.input.lineEnding", undefined);
            }
        });
        await step("input.raw", async () => {
            await setting("rtt.input.mode", "raw");
            await sleep(200);
            try {
                await received();
                const before = (shown.get(1) || "").length;
                terminal(1).sendText("ab\x03\x7f中", false);
                await sleep(300);
                const bytes = await received();
                assert.strictEqual(bytes, "61 62 03 7f e4 b8 ad", "raw keys were not sent as typed");
                assert(!/ab|中/u.test((shown.get(1) || "").slice(before)), "raw input was echoed locally");
                await drain(0);
                type(0, "echo raw keys");
                await expectText(0, /echo: raw keys\r?\n/u);
                return bytes;
            } finally {
                // The next start must not see half a line.
                terminal(1).sendText("\r", false);
                await sleep(200);
                await setting("rtt.input.mode", undefined);
            }
        });
        await step(
            "channels.downMapped",
            () =>
                withSettings(
                    {
                        "rtt.channels": [
                            { index: 0, down: 1 },
                            { index: 1, down: 0 }
                        ]
                    },
                    async () => {
                        await drain(1);
                        type(0, "crossed");
                        await expectText(1, /down1: crossed\r?\n/u);
                        await drain(0);
                        type(1, "echo crossed back");
                        await expectText(0, /echo: crossed back\r?\n/u);
                        return (await call("rtt.status")).channels.up.map((entry) => entry.downChannel);
                    }
                ),
            60000
        );
        // Only channel 0 is read, so channel 1 stays up only as an input port: its stream must still be drained.
        await step(
            "channels.downInputOnly",
            async () => {
                await drain(0);
                type(0, "rate 8000");
                await expectText(0, /ok: rate=8000\r?\n/u);
                try {
                    return await withSettings({ "rtt.channels": [{ index: 0, down: 1 }] }, async () => {
                        const status = await call("rtt.status");
                        assert.deepStrictEqual(
                            status.channels.up.map((entry) => entry.index),
                            [0]
                        );
                        const dropped = async () => Number(/dropped=(\d+)/u.exec(await heartbeat())[1]);
                        const before = await dropped();
                        await sleep(4000);
                        const after = await dropped();
                        assert.strictEqual(after, before, "the unread input-only channel filled up");
                        await drain(0);
                        type(0, "input only");
                        await expectText(0, /down1: input only\r?\n/u);
                        return { dropped: after };
                    });
                } finally {
                    await stopRate();
                }
            },
            60000
        );
        await step(
            "format.hex",
            () =>
                withSettings({ "rtt.channels": [0, { index: 1, format: "hex" }] }, async () => {
                    type(1, "hexcheck");
                    await expectShown(1, [
                        /[0-9a-f]{8} {2}64 6f 77 6e 31 3a 20 68 65 78 63 68 65 63 6b 0a {2}\|down1: hexcheck\.\|/u
                    ]);
                }),
            60000
        );
        await step(
            "format.raw",
            () =>
                withSettings({ "rtt.channels": [{ index: 0, format: "raw" }, 1] }, async () => {
                    type(0, "ansi");
                    type(0, "newlines");
                    await expectShown(0, [/\x1b\[31mred\x1b\[0m/u, /newline: lf\ncrlf\r\n/u, /\rprogress: 100%\n/u]);
                }),
            60000
        );
        await step(
            "encoding.channelDefault",
            async () => {
                const seen = {};
                const settings = vscode.workspace.getConfiguration("emberprobe");
                const previous = settings.inspect("rtt.encoding")?.workspaceValue;
                try {
                    for (const [encoding, text] of [
                        ["gbk", "中文"],
                        ["gb18030", "\u{1f525}"],
                        ["big5", "中文"],
                        ["shift_jis", "日本"],
                        ["euc-kr", "한글"],
                        ["latin1", "café"]
                    ]) {
                        await startWith([["rtt.encoding", encoding]]);
                        type(0, `enc ${encoding}`);
                        await expectShown(0, [new RegExp(`enc ${encoding}: ${text} end\\r\\n`, "u")]);
                        seen[encoding] = text;
                    }
                    return seen;
                } finally {
                    await startWith([["rtt.encoding", previous]]);
                }
            },
            120000
        );
        await step(
            "encoding.perChannel",
            () =>
                withSettings({ "rtt.channels": [{ index: 0, encoding: "gbk" }, 1] }, async () => {
                    type(0, "enc gbk");
                    await expectShown(0, [/enc gbk: 中文 end\r\n/u]);
                    await sleep(300);
                    // Input stays UTF-8 whatever the channel shows.
                    await received();
                    type(0, "echo 中");
                    await expectText(0, /echo: .+\r?\n/u);
                    await drain(0);
                    type(1, "中");
                    await sleep(300);
                    assert.strictEqual(await received(), "e4 b8 ad 0a", "input was not sent as UTF-8");
                    const log = fs.readFileSync(path.join(logDirectory, "rtt-ch0.log"), "utf8");
                    assert(log.includes("enc gbk: 中文 end"), "the log does not hold the decoded text");
                    const reply = await call("rtt.read", { channel: 0, maxBytes: 64 });
                    assert.strictEqual(reply.textEncoding, "gbk", "the Agent read lost the channel encoding");
                    type(0, "enc gbk");
                    await expectText(0, /enc gbk: 中文 end\r?\n/u);
                    return reply.textEncoding;
                }),
            60000
        );
        await step("vterm.switch", async () => {
            await sleep(300);
            await drain(0);
            shown.set(0, "");
            type(0, "vterm");
            await expectShown(0, [
                /\[T1\] vterm: one\r\nvterm: zero\r\n\[TA\] vterm: ten\r\nvterm: part\r\n\[T2\] vterm: two\r\n/u,
                /\[T3\] vterm: split\r\nvterm: end\r\n/u
            ]);
            await sleep(500);
            const log = fs.readFileSync(path.join(logDirectory, "rtt-ch0.log"), "utf8");
            assert(log.includes("[T3] vterm: split"), "the log lost the terminal prefix");
            await expectText(0, /vterm: end\r?\n/u);
            assert(/\uFFFD1vterm: one/u.test(reader(0).text), "the Agent text lost the terminal markers");
        });
        await step(
            "vterm.off",
            () =>
                withSettings({ "rtt.virtualTerminals": false, "rtt.encoding": "latin1" }, async () => {
                    type(0, "vterm");
                    await expectShown(0, [/ÿ1vterm: one\r\nÿ0vterm: zero\r\n/u, /ÿ3vterm: split\r\n/u]);
                }),
            60000
        );
        await step(
            "log.raw",
            async () => {
                const contains = (file, bytes) =>
                    fs.readFileSync(path.join(logDirectory, file)).includes(Buffer.from(bytes, "latin1"));
                const sent = async (file) => {
                    type(0, "enc gbk");
                    type(0, "ansi");
                    await expectText(0, /ansi: .*plain\r?\n/u);
                    await sleep(500);
                    assert(contains(file, "enc gbk: \xd6\xd0\xce\xc4 end\n"), `${file} changed the bytes`);
                    assert(contains(file, "\x1b[31mred"), `${file} lost the ANSI sequences`);
                };
                await withSettings({ "rtt.logFile.raw": true, "rtt.channels": [0] }, () => sent("rtt.bin"));
                await withSettings({ "rtt.logFile.raw": true }, async () => {
                    type(1, "raw log");
                    await sent("rtt-ch0.bin");
                });
                assert(fs.existsSync(path.join(logDirectory, "rtt-ch1.bin")), "no raw log for channel 1");
            },
            90000
        );

        await step(
            "stream.8kB",
            async () => {
                await setUpMode(1, "skip");
                return captureStream({ rate: 8000, durationMs: 5000, requireComplete: true });
            },
            40000
        );
        for (const mode of ["skip", "trim", "block"]) {
            await step(
                `mode.${mode}`,
                async () => {
                    await setUpMode(1, mode);
                    try {
                        const result = await captureStream({ mode, requireComplete: mode === "block" });
                        await heartbeat();
                        return result;
                    } finally {
                        await setUpMode(1, "skip");
                    }
                },
                90000
            );
        }

        // Optional six comparisons instead of a full context × mode × rate matrix. Each context uses one mode,
        // compares 100/10 ms, sends above the old 10240 B/s polling limit, then sends an over-capacity finite burst.
        if (stress) {
            for (const source of stress.contexts ?? ["own-session", "live-watch", "debug-server"]) {
                const mode = { "own-session": "skip", "live-watch": "trim", "debug-server": "block" }[source];
                for (const pollingIntervalMs of stress.pollingIntervalsMs ?? [100, 10]) {
                    await step(
                        `stress.${source}.${pollingIntervalMs}ms.${mode}`,
                        async () => {
                            await stopRate();
                            await setUpMode(1, "skip");
                            await command("mcu-vscode.stopRtt");
                            await stopped();
                            await setting("rtt.pollingIntervalMs", pollingIntervalMs);
                            await setting("rtt.channels", [0, { index: 1, mode }]);
                            try {
                                if (source === "live-watch") {
                                    await call("watch.add", { variables: ["g_rtt_test.uptimeSeconds"] });
                                    await call("sampling.start", { intervalMs: stress.samplingIntervalMs ?? 100 });
                                } else if (source === "debug-server") {
                                    await call("debug.start");
                                    await waitDebug((next) => next.paused || next.state === "running", 60000);
                                    // debug.start can report running before the entry stop, which would leave RTT halted.
                                    const debug = await waitDebug((next) => next.paused, 20000).catch(() =>
                                        call("debug.status")
                                    );
                                    if (debug.paused) await call("debug.control", { action: "continue" });
                                    await waitDebug((next) => next.state === "running");
                                }
                                await command("mcu-vscode.startRtt");
                                const status = await waitStatus(
                                    (next) =>
                                        next.state === "running" &&
                                        next.source === source &&
                                        next.channels.up.some(
                                            (channel) =>
                                                channel.index === 1 &&
                                                channel.mode === mode &&
                                                channel.modeState === "applied"
                                        ),
                                    30000
                                );
                                assert.strictEqual(status.pollingIntervalMs, pollingIntervalMs);
                                const actual = status.channels.up.find((channel) => channel.index === 1);
                                assert(Number.isInteger(actual.flags), "actual channel Flags readback is missing");
                                assert.strictEqual(actual.flags & 3, { skip: 0, trim: 1, block: 2 }[mode]);
                                readers.clear();
                                watchTerminals();
                                await drain(0);
                                type(0, "auto off");
                                await expectText(0, /ok: auto=off/u);
                                const common = { ...stressOptions, pollingIntervalMs, mode };
                                const samplingBefore = source === "live-watch" ? await call("sampling.status") : null;
                                const baseline =
                                    source === "own-session"
                                        ? await captureStream({ ...common, rate: 8000, requireComplete: true })
                                        : null;
                                const sustained = await captureStream({ ...common, requireComplete: mode === "block" });
                                const burst = await captureStream({
                                    ...common,
                                    rate: undefined,
                                    requireComplete: mode === "block"
                                });
                                const samplingAfter = source === "live-watch" ? await call("sampling.status") : null;
                                if (samplingAfter) {
                                    report.steps.at(-1).sampling = { before: samplingBefore, after: samplingAfter };
                                    assert.strictEqual(samplingAfter.running, true, JSON.stringify(samplingAfter));
                                    // actualHz follows the chart; a watch list alone is read at the sidebar rate.
                                    assert(
                                        Math.max(samplingAfter.actualHz, samplingAfter.consumers?.sidebarHz ?? 0) > 0,
                                        `no actual sampling load: ${JSON.stringify(samplingAfter)}`
                                    );
                                    if (stress.maxSamplingIntervalMs !== undefined)
                                        assert(
                                            samplingAfter.effectiveIntervalMs <= stress.maxSamplingIntervalMs,
                                            `sampling interval exceeded profile limit: ${JSON.stringify(samplingAfter)}`
                                        );
                                }
                                return {
                                    source,
                                    mode,
                                    pollingIntervalMs,
                                    hostFlags: actual.flags,
                                    baseline,
                                    sustained,
                                    burst,
                                    samplingBefore,
                                    samplingAfter
                                };
                            } finally {
                                // Leave firmware in skip before detaching: stopping a reader does not restore block Flags.
                                const current = await call("rtt.status");
                                if (current.state === "running") {
                                    await stopRate();
                                    await setUpMode(1, "skip");
                                }
                                await command("mcu-vscode.stopRtt");
                                await stopped();
                                if (source === "live-watch") await call("sampling.stop");
                                if (source === "debug-server" && (await call("debug.status")).state !== "none") {
                                    await call("debug.control", { action: "stop" });
                                    await waitDebug((next) => next.state === "none");
                                }
                                await setting("rtt.channels", [0, 1]);
                                await setting("rtt.pollingIntervalMs", 10);
                                await command("mcu-vscode.startRtt");
                                await running("own-session", 30000);
                                readers.clear();
                                watchTerminals();
                            }
                        },
                        240000
                    );
                }
            }
        }

        // --- Following the probe owner ---
        await step(
            "follow.statusKeepsSession",
            async () => {
                const before = await call("rtt.status");
                const fixture = await firmwareStatus();
                const status = await call("rtt.status");
                assert.strictEqual(status.source, "own-session");
                assert.strictEqual(status.buffers?.[0]?.generation, before.buffers?.[0]?.generation);
                return { generation: status.buffers?.[0]?.generation, fixture };
            },
            40000
        );
        await step(
            "follow.chipRead",
            async () => {
                await call("chip.read", { sections: ["identity"] });
                await running("own-session", 20000);
                return heartbeat();
            },
            40000
        );
        await step(
            "follow.sampling",
            async () => {
                await call("watch.add", { variables: ["g_rtt_test.uptimeSeconds"] });
                await call("sampling.start", { intervalMs: 100 });
                try {
                    const status = await running("live-watch", 20000);
                    await heartbeat();
                    await call("sampling.stop");
                    const after = await running("own-session", 20000);
                    await heartbeat();
                    return { during: status.source, after: after.source };
                } finally {
                    await call("sampling.stop");
                }
            },
            70000
        );
        // Debugging takes the probe from live watch; RTT must end on the managed server, not on the old session.
        await step(
            "follow.debugFromSampling",
            async () => {
                await call("sampling.start", { intervalMs: 100 });
                try {
                    await running("live-watch", 20000);
                    await call("debug.start");
                    await waitDebug((next) => next.state === "paused" || next.state === "running", 60000);
                    // At the entry stop the startup code has cleared the control block; RTT attaches once it runs.
                    const debug = await waitDebug((next) => next.paused, 20000).catch(() => call("debug.status"));
                    if (debug.paused) await call("debug.control", { action: "continue" });
                    await waitDebug((next) => next.state === "running");
                    const status = await running("debug-server", 30000);
                    return { source: status.source, debug: (await call("debug.status")).state };
                } finally {
                    await call("sampling.stop").catch(() => {});
                    const debug = await call("debug.status");
                    if (debug.state !== "none") {
                        await call("debug.control", { action: "stop" });
                        await waitDebug((next) => next.state === "none");
                    }
                    await running("own-session", 30000);
                }
            },
            130000
        );
        await step(
            "follow.debug",
            async () => {
                await call("debug.start");
                await waitDebug((next) => next.state === "paused" || next.state === "running", 60000);
                let debug = await waitDebug((next) => next.paused, 20000).catch(() => call("debug.status"));
                if (debug.paused) await call("debug.control", { action: "continue" });
                await waitDebug((next) => next.state === "running");
                const status = await running("debug-server", 30000);
                await drain(0);
                await expectText(0, /hb \d+/u, 15000);
                await call("debug.control", { action: "pause" });
                debug = await waitDebug((next) => next.paused);
                await sleep(300);
                await drain(0);
                await sleep(2200);
                await pull(0);
                assert(!/hb \d+/u.test(reader(0).text), "output continued while paused");
                await call("debug.control", { action: "continue" });
                await waitDebug((next) => next.state === "running");
                await expectText(0, /hb \d+/u, 8000);
                await call("debug.control", { action: "stop" });
                await waitDebug((next) => next.state === "none");
                const after = await running("own-session", 30000);
                await heartbeat();
                return { during: status.source, after: after.source };
            },
            170000
        );
        await step(
            "follow.flash",
            async () => {
                const before = await call("rtt.status");
                await flash();
                const status = await running("own-session", 45000);
                assert.notStrictEqual(status.buffers[0].generation, before.buffers[0].generation);
                assert.deepStrictEqual(status.block.address, before.block.address);
                await expectText(0, /EmberProbe RTT test, profile=/u, 15000);
                await sleep(300);
                return { generation: status.buffers[0].generation, resets: reader(0).resets };
            },
            240000
        );
        await step("firmware.softReset", async () => {
            await sleep(500);
            await drain(0);
            type(0, "reset");
            await expectText(0, /EmberProbe RTT test, profile=/u, 15000);
            await heartbeat();
        });

        await step("ui.stop", async () => {
            const before = (shown.get(0) || "").length;
            await command("mcu-vscode.stopRtt");
            await stopped();
            await sleep(300);
            const note = (shown.get(0) || "").slice(before);
            assert(note.length > 0, "the terminal shows no end of output");
            await call("chip.read", { sections: ["identity"] });
            return JSON.stringify(note.slice(-120));
        });

        // --- Agent path ---
        await step(
            "agent.start",
            async () => {
                const reply = await call("rtt.start");
                const status = await running(null, 30000);
                watchTerminals();
                readers.clear();
                await expectText(0, /hb \d+/u);
                return { reply: reply.state, source: status.source };
            },
            60000
        );
        await step("agent.channelErrors", async () => {
            await assert.rejects(call("rtt.read", { channel: 9 }), (error) => error.code === "RTT_UNKNOWN_CHANNEL");
            await assert.rejects(call("rtt.read", { encoding: "hex" }), (error) => error.code === "INVALID_PARAMS");
        });
        await step("agent.stop", async () => {
            await call("rtt.stop");
            await stopped();
            await call("chip.read", { sections: ["identity"] });
        });

        // --- autoStart: borrows a session that holds the probe, and never opens one ---
        const stays = async (accept, durationMs = 2500) => {
            const deadline = Date.now() + durationMs;
            do {
                const status = await call("rtt.status");
                assert(accept(status), `RTT left its state: ${JSON.stringify(status).slice(0, 400)}`);
                await sleep(100);
            } while (Date.now() < deadline);
        };
        const samplingSession = async (action) => {
            await call("sampling.start", { intervalMs: 100 });
            try {
                return await action();
            } finally {
                await call("sampling.stop");
            }
        };
        await step(
            "autoStart.noSession",
            async () => {
                await setting("rtt.autoStart", true);
                await call("chip.read", { sections: ["identity"] });
                await stays((status) => status.state === "stopped");
            },
            20000
        );
        await step(
            "autoStart.sampling",
            async () => {
                await call("watch.add", { variables: ["g_rtt_test.uptimeSeconds"] });
                const source = await samplingSession(async () => {
                    const status = await running("live-watch", 20000);
                    readers.clear();
                    await expectText(0, /hb \d+/u);
                    return status.source;
                });
                await stopped();
                return source;
            },
            60000
        );
        await step(
            "autoStart.userStopHolds",
            () =>
                samplingSession(async () => {
                    await running("live-watch", 20000);
                    await command("mcu-vscode.stopRtt");
                    await stopped();
                    await stays((status) => status.state === "stopped");
                }),
            60000
        );
        await step(
            "autoStart.debug",
            async () => {
                await call("debug.start");
                try {
                    const status = await running("debug-server", 60000);
                    return status.source;
                } finally {
                    // Stopping a paused session leaves the target halted, and the later steps need it running.
                    const debug = await waitDebug((next) => next.paused, 20000).catch(() => call("debug.status"));
                    if (debug.paused) {
                        await call("debug.control", { action: "continue" });
                        await waitDebug((next) => next.state === "running");
                    }
                    await call("debug.control", { action: "stop" });
                    await waitDebug((next) => next.state === "none");
                    await stopped();
                }
            },
            120000
        );
        await step(
            "autoStart.modeRefused",
            async () => {
                await setting("rtt.channels", [0, { index: 1, mode: "skip" }]);
                try {
                    return await samplingSession(async () => {
                        await stays((status) => status.state === "stopped", 3000);
                        return (await call("rtt.status")).error;
                    });
                } finally {
                    await setting("rtt.channels", [0, 1]);
                }
            },
            60000
        );
        await setting("rtt.autoStart", undefined);

        // --- Skill script and MCP server, over the real Bridge ---
        await step(
            "skill.path",
            async () => {
                await command("mcu-vscode.enableAgentAccess");
                // The copy a user gets. Any other location stops at the Bridge's modal approval of unmanaged skills.
                await provider._skillStatusService.installer.installSkill(
                    vscode,
                    provider._context,
                    provider._lang,
                    "workspace"
                );
                const script = path.join(folder, ".agents", "skills", "mcu-rtt", "scripts", "rtt.js");
                // Asynchronous: the Bridge lives in this process, so a synchronous child would deadlock on it.
                const run = (...args) =>
                    new Promise((resolve, reject) =>
                        execFile(
                            "node",
                            [script, "--workspace", folder, ...args],
                            { timeout: 30000, env: nodeEnv(provider._context.globalStorageUri.fsPath) },
                            (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout)))
                        )
                    );
                await run("--start");
                await running(null, 30000);
                await sleep(1500);
                const read = await run("--read", "--channel", "0");
                assert(/hb \d+/u.test(read.text), `skill read: ${JSON.stringify(read).slice(0, 300)}`);
                const status = await run("--status");
                assert.strictEqual(status.state, "running");
                await run("--stop");
                await stopped();
                return { cursor: read.nextCursor, source: status.source };
            },
            60000
        );
        await step(
            "mcp.path",
            async () => {
                const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
                const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
                const client = new Client({ name: "emberprobe-rtt-smoke", version: "1.0.0" }, { capabilities: {} });
                await client.connect(
                    new StdioClientTransport({
                        command: "node",
                        args: [path.join(extension.extensionPath, "dist", "mcp-server.js")],
                        cwd: folder,
                        env: { ...nodeEnv(provider._context.globalStorageUri.fsPath), EMBERPROBE_WORKSPACE: folder },
                        stderr: "inherit"
                    })
                );
                const tool = async (name, args = {}) => {
                    const reply = await client.callTool({ name, arguments: args });
                    assert(!reply.isError, `${name}: ${JSON.stringify(reply.content).slice(0, 300)}`);
                    return reply.structuredContent ?? JSON.parse(reply.content[0].text);
                };
                try {
                    const names = (await client.listTools()).tools.map((item) => item.name);
                    for (const name of ["rtt_status", "rtt_read", "rtt_control"])
                        assert(names.includes(name), `missing tool ${name}`);
                    await tool("rtt_control", { action: "start" });
                    await running(null, 30000);
                    await sleep(1500);
                    const read = await tool("rtt_read", { channel: 0 });
                    const text = JSON.stringify(read);
                    assert(/hb \d+/u.test(text), `mcp read: ${text.slice(0, 300)}`);
                    const status = await tool("rtt_status");
                    assert.strictEqual(status.state, "running");
                    await tool("rtt_control", { action: "stop" });
                    await stopped();
                    return { source: status.source };
                } finally {
                    await client.close();
                }
            },
            90000
        );

        // --- Control block location ---
        const locate = async (expected, prepare) => {
            await prepare();
            await command("mcu-vscode.startRtt");
            const status = await running(null, 60000);
            assert.strictEqual(status.block.source, expected);
            readers.clear();
            await expectText(0, /hb \d+/u);
            await command("mcu-vscode.stopRtt");
            await stopped();
            return status.block;
        };
        if (rttChecks.controlBlockAddress)
            await step(
                "locate.address",
                () =>
                    locate("address", () => setting("rtt.controlBlockAddress", rttChecks.controlBlockAddress)).finally(
                        () => setting("rtt.controlBlockAddress", undefined)
                    ),
                90000
            );
        if (rttChecks.nosymRelative) {
            await required("nosym.elf", async () => {
                // Some CMSIS-DAP probes stall on block reads at the clock a target script defaults to.
                if (rttChecks.scanSpeedKhz) await setting("samplingAdapterSpeedKhz", rttChecks.scanSpeedKhz);
                return call("config.set", { values: { elf: rttChecks.nosymRelative } });
            });
            // Firmware whose control block lies outside the ELF's writable sections cannot be found this way.
            if (rttChecks.sectionScan !== false)
                await step("locate.sections", () => locate("sections", async () => {}), 90000);
            if (rttChecks.searchRange)
                await step(
                    "locate.range",
                    () =>
                        locate("range", () => setting("rtt.searchRange", rttChecks.searchRange)).finally(() =>
                            setting("rtt.searchRange", undefined)
                        ),
                    90000
                );
            await required("nosym.restore", async () => {
                await setting("samplingAdapterSpeedKhz", undefined);
                return call("config.set", { values: { elf: profile.elfRelative } });
            });
        }
        await step(
            "channels.missing",
            async () => {
                await setting("rtt.channels", [0, 5]);
                await command("mcu-vscode.startRtt");
                const status = await running(null, 30000);
                assert.deepStrictEqual(status.missingChannels, [5]);
                await command("mcu-vscode.stopRtt");
                await stopped();
                return status.missingChannels;
            },
            45000
        );
        await step(
            "channels.allMissingGivesUp",
            async () => {
                await setting("rtt.channels", [5]);
                const started = Date.now();
                const outcome = await call("rtt.start").then(
                    (reply) => ({ reply }),
                    (error) => ({ error: summarize(error) })
                );
                const status = await waitStatus((next) => next.state !== "running" || next.retry, 5000).catch(
                    () => null
                );
                await call("rtt.stop");
                await stopped();
                await setting("rtt.channels", [0, 1]);
                return { outcome, retry: status?.retry, state: status?.state, ms: Date.now() - started };
            },
            120000
        );
        report.passed = failures === 0;
        if (failures) throw new Error(`${failures} RTT step(s) failed`);
    } catch (error) {
        report.passed = false;
        report.error = summarize(error);
        throw error;
    } finally {
        try {
            await call("sampling.stop").catch(() => {});
            await call("rtt.stop").catch(() => {});
            const status = await call("debug.status");
            if (status.state !== "none")
                await withTimeout(call("debug.control", { action: "stop" }), 20000, "debug cleanup");
        } catch (error) {
            report.cleanupError = summarize(error);
        }
        report.finishedAt = new Date().toISOString();
        save();
    }
}

module.exports = { run };
