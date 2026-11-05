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

// Checks stream lines: "S <8 hex seq> <letters derived from seq and column>\n", 64 bytes each.
function checkStream(text) {
    const result = { lines: 0, lost: 0, malformed: 0, resets: 0, first: null, last: null };
    let previous = null;
    for (const line of text.split("\n")) {
        const match = /^S ([0-9a-f]{8}) ([a-z]+)$/u.exec(line);
        if (!match) {
            if (/^S /u.test(line)) result.malformed++;
            continue;
        }
        const seq = parseInt(match[1], 16);
        const pattern = match[2];
        const intact =
            line.length === 63 &&
            [...pattern].every((char, index) => char.charCodeAt(0) - 97 === (seq + 11 + index) % 26);
        if (!intact) result.malformed++;
        result.lines++;
        if (result.first === null) result.first = seq;
        if (previous !== null) {
            if (seq <= previous) result.resets++;
            else result.lost += seq - previous - 1;
        }
        previous = seq;
        result.last = seq;
    }
    return result;
}

async function run() {
    const profile = JSON.parse(process.env.EMBERPROBE_SMOKE_PROFILE || "null");
    assert(profile, "EMBERPROBE_SMOKE_PROFILE is required");
    const rttChecks = profile.checks?.rtt || {};
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

    // Agent cursor per channel. Text read so far accumulates until a check consumes it.
    const readers = new Map();
    const reader = (channel) => {
        if (!readers.has(channel))
            readers.set(channel, { generation: undefined, cursor: undefined, text: "", dropped: 0, resets: 0 });
        return readers.get(channel);
    };
    const pull = async (channel) => {
        const state = reader(channel);
        for (;;) {
            const reply = await call("rtt.read", {
                channel,
                ...(state.cursor !== undefined ? { generation: state.generation, cursor: state.cursor } : {})
            });
            if (reply.reset && state.cursor !== undefined) state.resets++;
            state.generation = reply.generation;
            state.cursor = reply.nextCursor;
            state.dropped += reply.droppedBytes || 0;
            state.text += reply.text;
            if (!reply.more) return state;
        }
    };
    const drain = async (channel) => {
        const state = await pull(channel);
        state.text = "";
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

    const flash = async () => {
        const plan = await call("flash.authorize", { elf, elfSha256, operation: "flash.execute" });
        assert(plan.confirmationRequired && plan.confirmationId, "flash did not request confirmation");
        const result = await call("flash.execute", { elf, elfSha256, confirmationId: plan.confirmationId });
        assert.strictEqual(result.verified, true, `flash failed: ${result.detail || "unverified"}`);
        return { verified: result.verified };
    };

    // Through the firmware's command, over the down channel: the channel must keep its buffer afterwards.
    const setUpMode = async (channel, mode) => {
        type(0, `mode ${channel} ${mode}`);
        await expectText(0, new RegExp(`ok: ch${channel} mode=${mode}`, "u"));
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

        const stream = async (commandText, seconds) => {
            await drain(1);
            type(0, commandText);
            const deadline = Date.now() + seconds * 1000;
            while (Date.now() < deadline) {
                await pull(1);
                await sleep(100);
            }
            const state = await pull(1);
            return { ...checkStream(state.text), dropped: state.dropped };
        };
        await step(
            "stream.8kB",
            async () => {
                const result = await stream("rate 8000", 8);
                type(0, "rate 0");
                await sleep(300);
                assert(result.lines > 500, `only ${result.lines} lines`);
                assert.strictEqual(result.lost, 0, JSON.stringify(result));
                assert.strictEqual(result.malformed, 0, JSON.stringify(result));
                assert.strictEqual(result.dropped, 0, "the host buffer dropped data");
                return result;
            },
            20000
        );
        await step(
            "mode.trim",
            async () => {
                await setUpMode(1, "trim");
                const result = await stream("burst 64000", 4);
                await heartbeat();
                assert(result.lines > 100, `only ${result.lines} lines`);
                return result;
            },
            40000
        );
        await step(
            "mode.block",
            async () => {
                await setUpMode(1, "block");
                const result = await stream("burst 64000", 10);
                await heartbeat();
                assert(result.lines * 64 >= 60000, `only ${result.lines} lines`);
                assert.strictEqual(result.lost, 0, JSON.stringify(result));
                assert.strictEqual(result.malformed, 0, JSON.stringify(result));
                await setUpMode(1, "skip");
                return result;
            },
            50000
        );

        // --- Following the probe owner ---
        await step(
            "follow.agentRead",
            async () => {
                const before = await call("rtt.status");
                const values = await call("variables.read", { variables: ["g_rtt_test.uptimeSeconds"] });
                const status = await running("own-session", 20000);
                await heartbeat();
                return { before: before.buffers?.[0]?.generation, after: status.buffers?.[0]?.generation, values };
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
                const status = await running("debug-server", 30000);
                let debug = await waitDebug((next) => next.paused, 20000).catch(() => call("debug.status"));
                if (debug.paused) await call("debug.control", { action: "continue" });
                await waitDebug((next) => next.state === "running");
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
