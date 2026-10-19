"use strict";

// Writes g_stressWriteF32 while managed runtime sampling runs and changes sampling or target state mid-write.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const WATCH_KEY = "mcu.sidebarWatchList";
const WRITE_KEY = "mcu.sidebarWriteList";
const WRITE_TARGET = "g_stressWriteF32";
const LOAD = [
    "g_stressFrames",
    "g_stressPacked",
    "g_stressWave",
    "g_stressBytes",
    "g_stressMatrix",
    ...Array.from({ length: 16 }, (_, index) => `g_stressCh${String(index).padStart(2, "0")}`),
    "g_stressEcho",
    "g_stressWriteU32"
];
const TOGGLED = "g_stressCh23";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RAW_CANCEL = /Runtime read was cancelled by a target state change/;

async function waitFor(check, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (check()) return;
        await sleep(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
    // Sandboxed hosts may forbid the user temp directory used for OpenOCD's silent Tcl responses.
    if (process.env.RUNTIME_BOARD_TMP) process.env.TEMP = process.env.TMP = process.env.RUNTIME_BOARD_TMP;
    const extension = vscode.extensions.getExtension("BakeSheep.emberprobe");
    await extension.activate();
    const provider = extension.exports.debugTestProvider;
    const env = process.env;
    const state = provider._context.workspaceState;
    await state.update("mcu.debugger", env.RUNTIME_BOARD_PROBE);
    await state.update("mcu.mcuCore", env.RUNTIME_BOARD_TARGET);
    await state.update("mcu.elfPath", env.RUNTIME_BOARD_ELF);
    const config = vscode.workspace.getConfiguration("emberprobe");
    const target = vscode.ConfigurationTarget.Workspace;
    if (env.RUNTIME_BOARD_OPENOCD) await config.update("openocdPath", env.RUNTIME_BOARD_OPENOCD, target);
    if (env.RUNTIME_BOARD_TRANSPORT) await config.update("transport", env.RUNTIME_BOARD_TRANSPORT, target);
    if (env.RUNTIME_BOARD_PROBE_SERIAL) await config.update("probeSerial", env.RUNTIME_BOARD_PROBE_SERIAL, target);
    if (env.RUNTIME_BOARD_ADAPTER_SPEED_KHZ)
        await config.update("adapterSpeedKhz", Number(env.RUNTIME_BOARD_ADAPTER_SPEED_KHZ), target);
    await provider._refreshElfBindings();

    const label = env.RUNTIME_BOARD_LABEL || "board";
    const report = { label, extension: extension.extensionPath, elf: env.RUNTIME_BOARD_ELF, phases: {}, output: "" };
    const output = [];
    let session,
        stopped = false,
        thread;
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory("emberprobe", {
        createDebugAdapterTracker(current) {
            session = current;
            return {
                onDidSendMessage(message) {
                    if (message.event === "stopped") {
                        stopped = true;
                        thread = message.body.threadId ?? thread;
                    }
                    if (message.event === "continued") stopped = false;
                    if (message.event === "output") output.push(message.body.output);
                }
            };
        }
    });
    const events = [];
    const postStatuses = provider._postConsumerStatuses;
    provider._postConsumerStatuses = function (current, ...rest) {
        events.push({ t: Date.now(), mode: current?.mode, key: current?.key, message: current?.message });
        return postStatuses.call(this, current, ...rest);
    };
    const postLive = provider._postLive;
    provider._postLive = function (message, ...rest) {
        if (/error|status/i.test(message?.type || ""))
            events.push({ t: Date.now(), type: message.type, key: message.key, message: message.message });
        return postLive.call(this, message, ...rest);
    };
    let sampleBatches = 0,
        failedSamples = 0;
    const handleSamples = provider._handleRawSamples;
    provider._handleRawSamples = function (samples, ...rest) {
        sampleBatches++;
        failedSamples += (samples || []).filter((item) => !item.bytes && !item.runtimeTree).length;
        return handleSamples.call(this, samples, ...rest);
    };
    const status = () => provider._samplingStatus();
    const writable = () => {
        const current = status();
        return current.mode === "debug-running-sampling" && current.canWrite === true;
    };
    let value = 1;
    const write = async (trigger) => {
        const started = Date.now();
        const requested = (value = Math.round(value * 7 + 3) % 100000) / 4;
        const entry = { trigger, value: requested, stoppedBefore: stopped };
        try {
            const result = await provider._writeUiVariable(WRITE_TARGET, requested);
            entry.ok = true;
            entry.source = result.source;
            entry.verified = result.results?.[0]?.verified;
        } catch (error) {
            entry.ok = false;
            entry.code = error.code;
            entry.key = error.i18nKey;
            entry.message = error.message;
            entry.details = error.details && { ...error.details, results: undefined };
        }
        entry.ms = Date.now() - started;
        entry.stoppedAfter = stopped;
        return entry;
    };
    const symbol = (name) => provider.readElfSymbols().symbols.find((item) => item.name === name);
    const identities = (names) =>
        names.map((name) => {
            const item = symbol(name);
            assert(item, `${name} is missing from the ELF; flash the probe-lab stress firmware`);
            return { name: item.name, type: item.type };
        });
    const resultsDir = env.RUNTIME_BOARD_RESULTS || path.join(extension.extensionPath, "test-results");
    try {
        await provider._prepareRequestedLayouts([...LOAD, TOGGLED, WRITE_TARGET].map((name) => ({ name })));
        await provider._saveWatchList(WATCH_KEY, identities([...LOAD, TOGGLED]));
        await provider._saveWatchList(WRITE_KEY, identities([WRITE_TARGET]), { syncSidebar: false });
        report.readPlan = provider._activeReadPlan().map((item) => ({ name: item.name, size: item.size }));
        assert(
            await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
                type: "emberprobe",
                request: "attach",
                name: "EmberProbe running-write board acceptance",
                executable: env.RUNTIME_BOARD_ELF,
                gdbPath: env.RUNTIME_BOARD_GDB,
                rtos: ""
            })
        );
        await waitFor(() => stopped, 30000, "attach stop");
        if (!thread) thread = (await session.customRequest("threads", {})).threads[0].id;
        await session.customRequest("continue", { threadId: thread });
        await waitFor(() => !stopped, 5000, "continue");
        await provider.startLiveWatch(provider._context.workspaceState.get(WATCH_KEY), 100, "sidebar");
        await waitFor(writable, 20000, "runtime sampling with writes enabled");
        report.statusAtStart = status();
        // A run without real sampling load cannot reproduce the race; fail instead of reporting a pass.
        await waitFor(() => sampleBatches > 0, 15000, "runtime samples from the board");
        const counted = sampleBatches;
        await sleep(2000);
        report.sampling = {
            batchesPerSecond: (sampleBatches - counted) / 2,
            failedSamples,
            stats: provider._managedDebugServer?.stats?.() || null
        };

        // Phase A: sampling reconfiguration while a running write is queued or in flight.
        const reconfigure = [];
        let watchHasToggled = true;
        const triggers = {
            watch: async () => {
                watchHasToggled = !watchHasToggled;
                await provider._saveWatchList(WATCH_KEY, identities(watchHasToggled ? [...LOAD, TOGGLED] : LOAD));
            },
            rate: async () => provider._setLiveInterval(reconfigure.length % 2 ? 50 : 100),
            backpressure: async () => {
                provider._setSamplingArchiveBackpressure(true);
                await sleep(20);
                provider._setSamplingArchiveBackpressure(false);
            }
        };
        const delays = [0, 10, 30, 60, 100, 150];
        const rounds = Number(env.RUNTIME_BOARD_ROUNDS) || 12;
        for (let round = 0; round < rounds; round++) {
            for (const [name, fire] of Object.entries(triggers)) {
                await waitFor(writable, 10000, `writable before ${name} round ${round}`);
                const delay = delays[(round + reconfigure.length) % delays.length];
                const pending = write(name);
                await sleep(delay);
                await fire();
                const entry = await pending;
                entry.delay = delay;
                reconfigure.push(entry);
            }
        }
        report.phases.reconfigure = summarize(reconfigure);
        const unexpected = reconfigure.filter(
            (entry) => !entry.ok && !["LIVE_READ_CANCELLED", "DEBUG_STATE_CHANGED"].includes(entry.code)
        );
        assert.deepStrictEqual(unexpected, [], "reconfiguration writes may only fail by cancellation");

        // Phase B: a breakpoint stops the target while writes keep arriving.
        await waitFor(writable, 10000, "writable before breakpoint phase");
        const breakpoint = [];
        const stops = Number(env.RUNTIME_BOARD_STOPS) || 4;
        const set = await session.customRequest("setFunctionBreakpoints", {
            breakpoints: [{ name: "ProbeLab_StressBreakpoint" }]
        });
        report.breakpoint = set.breakpoints;
        for (let hit = 0; hit < stops; hit++) {
            await waitFor(() => !stopped, 5000, "running before breakpoint");
            await waitFor(writable, 10000, `writable before stop ${hit}`);
            const deadline = Date.now() + 8000;
            while (!stopped && Date.now() < deadline) {
                const entry = await write("breakpoint");
                breakpoint.push({ hit, ...entry });
                if (!entry.ok && !stopped) await sleep(20);
            }
            assert(stopped, `Breakpoint ${hit} was not hit within 8 s`);
            await sleep(300);
            await session.customRequest("continue", { threadId: thread });
        }
        await session.customRequest("setFunctionBreakpoints", { breakpoints: [] });
        report.phases.breakpoint = summarize(breakpoint);
        report.phases.breakpoint.aroundStops = breakpoint.filter((entry) => !entry.ok || entry.stoppedAfter);

        const reconfigureFailures = reconfigure.filter((entry) => !entry.ok);
        const rawMessages = [...reconfigure, ...breakpoint].filter((entry) => RAW_CANCEL.test(entry.message || ""));
        report.findings = {
            reconfigureCancelled: reconfigureFailures.filter(
                (entry) => entry.code === "LIVE_READ_CANCELLED" || RAW_CANCEL.test(entry.message || "")
            ).length,
            rawCancelMessages: rawMessages.length,
            breakpointTargetChanged: breakpoint.filter((entry) => entry.code === "DEBUG_STATE_CHANGED").length
        };
        if (env.RUNTIME_BOARD_EXPECT === "fixed") {
            assert.deepStrictEqual(reconfigureFailures, [], "sampling reconfiguration must not fail running writes");
            assert(
                reconfigure.every((entry) => entry.verified === true),
                "every running write must be verified"
            );
            assert.strictEqual(rawMessages.length, 0, "cancellations must be reported with the written state");
            for (const entry of breakpoint.filter((item) => item.code === "DEBUG_STATE_CHANGED")) {
                assert.match(entry.key || "", /^sb\.writeTargetChanged\./);
                assert.strictEqual(typeof entry.details?.written, "boolean");
            }
        }
        report.passed = true;
    } catch (error) {
        report.error = error.stack || error.message;
        throw error;
    } finally {
        report.output = output.join("").slice(-20000);
        report.events = events.slice(-300);
        provider._handleRawSamples = handleSamples;
        provider._postConsumerStatuses = postStatuses;
        provider._postLive = postLive;
        fs.mkdirSync(resultsDir, { recursive: true });
        fs.writeFileSync(path.join(resultsDir, `runtime-write-${label}.json`), JSON.stringify(report, null, 2));
        try {
            if (session) {
                try {
                    await session.customRequest("setFunctionBreakpoints", { breakpoints: [] }).catch(() => {});
                    if (stopped && thread) await session.customRequest("continue", { threadId: thread });
                } finally {
                    await vscode.debug.stopDebugging(session);
                }
            }
        } finally {
            tracker.dispose();
        }
    }
}

function summarize(entries) {
    const outcomes = {};
    for (const entry of entries) {
        const key = entry.ok ? `ok:${entry.source}` : `${entry.code || "error"}:${entry.key || entry.message}`;
        outcomes[key] = (outcomes[key] || 0) + 1;
    }
    const byTrigger = {};
    for (const entry of entries) {
        const bucket = (byTrigger[entry.trigger] ||= { total: 0, failed: 0 });
        bucket.total++;
        if (!entry.ok) bucket.failed++;
    }
    return { total: entries.length, outcomes, byTrigger, failures: entries.filter((entry) => !entry.ok) };
}

module.exports = { run };
