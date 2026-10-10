"use strict";

const assert = require("node:assert/strict");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");

function fixture(options = {}) {
    const events = [];
    const messages = [];
    const warnings = [];
    const errors = [];
    const state = new Map([["mcu.elfPath", "firmware.elf"]]);
    const settings = { backend: "probe-rs", probeRsChip: "STM32H723VG", probeRsPath: "fake-probe-rs" };
    const sampling = options.sampling !== false;
    const automatic = sampling && !options.legacy;
    const session = { id: "watch", type: "emberprobe-probe-rs", configuration: { __emberprobeWatchOnly: true } };
    let provider;
    let oldLease;
    const vscode = {
        workspace: { isTrusted: true, getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) },
        debug: {
            activeDebugSession: automatic ? session : null,
            stopDebugging: async (stopped) => {
                assert.equal(stopped, session);
                assert.equal(provider._probeRsTransition, true, "suppress automatic restoration during teardown");
                events.push("stop-dap");
                provider._debugBridge.activeSession = null;
                provider._debugBridge.hasAnySession = false;
                provider._debugBridge.hasSession = false;
                provider._debugBridge.allSessions.clear();
                vscode.debug.activeDebugSession = null;
                if (options.removeAdapterDuringStop) provider._probeRsAdapters.delete(session.id);
                options.afterStop?.(provider);
                return true;
            }
        },
        window: {
            showInformationMessage: () => events.push("success"),
            showErrorMessage: (message) => errors.push(message),
            showWarningMessage: (message) => warnings.push(message)
        }
    };
    const MainViewProvider = loadProvider(vscode, {
        "./services/probeRsFlashService": {
            downloadWithProbeRs: async (_settings, elf, cwd, runOptions) => {
                assert.equal(elf, "firmware.elf");
                assert.equal(cwd, "/workspace");
                assert.equal(provider._downloadRunning, true);
                assert.equal(provider._liveSession, null);
                if (sampling) assert.ok(events.includes("exited"), "physical process exit precedes the download lease");
                options.beforeRun?.(provider);
                runOptions.beforeRun();
                events.push("flash");
                for (let index = 0; index < 8; index++)
                    runOptions.onProgress({ stage: "program", level: "info", message: `page ${index}` });
                if (options.stopDuringFlash) await provider.stopLiveWatch();
                if (options.failFlash) throw new Error("Flash failed");
                return { sha256: "snapshot" };
            }
        }
    });
    const symbol = { name: "counter", address: 0x20000004, size: 4 };
    const graphSamples = new Map([["counter", { bytes: [1] }]]);
    provider = Object.create(MainViewProvider.prototype);
    Object.assign(provider, {
        commandHandlers: {},
        _context: { workspaceState: { get: (key) => state.get(key) } },
        _probeCoordinator: new ProbeCoordinator(),
        _samplingCoordinator: new SamplingCoordinator(),
        _probeRsAdapters: new Map(),
        _probeRsStatusService: { resolve: async (executable) => executable },
        _probeRsTransition: false,
        _samplingIntent: sampling,
        _liveStartGeneration: 0,
        _liveConsumers: new Set(["sidebar", "graph"]),
        _livePanels: new Map([
            ["graph", { latestSamples: graphSamples, watchKey: "graph", post: (message) => messages.push(message) }]
        ]),
        _latestSidebarSamples: new Map([["counter", { bytes: [1] }]]),
        _liveIntervalMs: 50,
        _debugBridge: {
            activeSession: automatic ? session : null,
            hasSession: automatic,
            hasAnySession: automatic,
            allSessions: new Map(automatic ? [[session.id, session]] : []),
            setIntent() {},
            waitForState: async (predicate) => {
                assert.ok(predicate({ state: "none" }));
                assert.equal(provider._downloadRunning, false);
                events.push("detached");
            }
        },
        _webviewView: { webview: { postMessage: (message) => messages.push(message) } },
        _flushPendingWebviewSamples() {},
        _postConsumerStatuses() {},
        _postProbeOperationStatus() {},
        _postLive: (message) => messages.push(message),
        _commandContext: () => ({ cwd: "/workspace" }),
        _t: (key) => key,
        _activeReadPlan: () => [symbol],
        _watchLists: { invalidate: () => events.push("invalidate-watch") },
        _elfService: {
            invalidate: () => events.push("invalidate-elf"),
            ready: async () => {
                if (options.failRefresh) throw new Error("ELF parse failed");
                return { symbols: [symbol] };
            }
        },
        _memoryAnalysisController: {
            refresh: async () => {
                events.push("memory-start");
                await Promise.resolve();
                events.push("memory-ready");
            }
        },
        _hydrateSelectedLayouts: async () => {},
        _rebindWatchLists: async (symbols) => {
            events.push("rebind");
            assert.equal(symbols[0].address, 0x20000004);
        },
        _scalarWatchList: () => [symbol],
        _watchListWithDisplayNames: () => [symbol],
        _syncGraphTarget: () => {},
        _syncSidebarTarget: () => events.push("sidebar-refresh"),
        _liveSession: null,
        startLiveWatch: async (_items, interval, consumer) => {
            assert.equal(provider._downloadRunning, false, "release the flash lease before reconnecting");
            assert.equal(provider._probeRsTransition, false);
            assert.ok(events.includes("memory-ready"));
            assert.ok(events.includes("rebind"));
            assert.ok(events.includes("sidebar-refresh"));
            assert.equal(provider._latestSidebarSamples.size, 0);
            assert.equal(graphSamples.size, 0);
            assert.equal(interval, 50);
            assert.equal(consumer, "refresh");
            events.push("resume");
            if (options.failResume) throw new Error("Reconnect failed");
            provider._samplingIntent = true;
        }
    });
    if (automatic) {
        oldLease = provider._probeCoordinator.acquire("debugServer");
        provider._probeRsAdapters.set(session.id, {
            waitForExit: async () => {
                events.push("wait-exit");
                await Promise.resolve();
                assert.equal(provider._probeCoordinator.isActive("debugServer"), true);
                assert.equal(provider._downloadRunning, false);
                if (options.failExit) return false;
                oldLease.release();
                provider._probeRsAdapters.delete(session.id);
                events.push("exited");
                return true;
            }
        });
    } else if (sampling) {
        provider._liveWatchLease = oldLease = provider._probeCoordinator.acquire("liveWatch");
        provider._liveSession = {
            stop: async () => {
                events.push("stop-live");
                await Promise.resolve();
                assert.equal(provider._liveWatchRunning, true);
                options.afterStop?.(provider);
                events.push("exited");
                return true;
            }
        };
    }
    provider.registerCommandHandlers();
    return { provider, events, warnings, errors, messages, state, vscode, settings, oldLease };
}

async function main() {
    for (const options of [{}, { removeAdapterDuringStop: true }, { legacy: true }]) {
        const active = fixture(options);
        assert.equal(await active.provider.commandHandlers["mcu-vscode.download"](), true);
        const position = (event) => active.events.indexOf(event);
        assert.ok(position("exited") < position("flash"));
        assert.ok(position("flash") < position("rebind"));
        assert.ok(position("sidebar-refresh") < position("resume"));
        assert.equal(active.provider._samplingIntent, true);
        assert.equal(active.provider._probeCoordinator.anyActive(), false);
        assert.equal(active.provider._recentProgress.length, 6);
        assert.ok(active.messages.some((message) => message.type === "sidebarWatchList" && message.resetValues));
        assert.ok(active.messages.some((message) => message.type === "watchList" && message.resetValues));
    }

    const idle = fixture({ sampling: false });
    await idle.provider._downloadProbeRs();
    assert.ok(idle.events.includes("rebind"));
    assert.ok(!idle.events.includes("resume"));

    const exitFailed = fixture({ failExit: true });
    await assert.rejects(exitFailed.provider._downloadProbeRs(), { code: "PROBE_EXIT_UNCONFIRMED" });
    assert.equal(exitFailed.oldLease.released, false, "exit timeout retains the adapter's physical ownership");
    assert.ok(!exitFailed.events.includes("flash"));
    assert.ok(!exitFailed.events.includes("resume"));
    assert.equal(exitFailed.provider._probeRsTransition, false);
    exitFailed.oldLease.release();

    const failed = fixture({ failFlash: true });
    await assert.rejects(failed.provider._downloadProbeRs(), /Flash failed/);
    assert.equal(failed.provider._probeCoordinator.anyActive(), false);
    assert.equal(failed.provider._samplingIntent, false);
    assert.ok(!failed.events.includes("success"));
    assert.ok(!failed.events.includes("resume"));

    for (const options of [{ failRefresh: true }, { failResume: true }]) {
        const followup = fixture(options);
        assert.equal(await followup.provider._downloadProbeRs(), true);
        assert.equal(followup.warnings.length, 1);
        assert.equal(followup.errors.length, 0);
        assert.equal(followup.provider._probeCoordinator.anyActive(), false);
        if (options.failRefresh) assert.ok(!followup.events.includes("resume"));
    }

    const stopped = fixture({ stopDuringFlash: true });
    await stopped.provider._downloadProbeRs();
    assert.ok(!stopped.events.includes("resume"), "a newer explicit stop cancels automatic sampling restoration");
    assert.equal(stopped.provider._samplingIntent, false);

    const cases = [
        ["PROBE_DRIVER_BUSY", (item) => (item.provider._probeDriverSwitching = true)],
        ["PROBE_EXIT_UNCONFIRMED", (item) => (item.provider._liveExitUnconfirmed = true)],
        ["PROBE_EXIT_UNCONFIRMED", (item) => (item.provider._liveConnectionClosing = true)],
        ["PROBE_EXIT_UNCONFIRMED", (item) => (item.provider._shutdownPromise = Promise.resolve())],
        ["PROBE_BUSY", (item) => (item.provider._foreignDebugPending = true)],
        ["PROBE_BUSY", (item) => (item.provider._debugCommandPending = true)],
        ["PROBE_BUSY", (item) => (item.provider._probeRsTransition = true)],
        ["PROBE_BUSY", (item) => (item.provider._liveStartPromise = Promise.resolve())],
        ["PROBE_BUSY", (item) => (item.vscode.debug.activeDebugSession = { id: "foreign", type: "cortex-debug" })]
    ];
    for (const [code, arrange] of cases) {
        const guarded = fixture({ sampling: false });
        arrange(guarded);
        await assert.rejects(guarded.provider._downloadProbeRs(), { code });
        assert.ok(!guarded.events.includes("flash"));
    }
    const untrusted = fixture({ sampling: false });
    untrusted.vscode.workspace.isTrusted = false;
    await assert.rejects(untrusted.provider._downloadProbeRs(), /trusted workspace/);
    assert.ok(!untrusted.events.includes("flash"));

    const incomplete = fixture();
    incomplete.state.delete("mcu.elfPath");
    await assert.rejects(incomplete.provider._downloadProbeRs(), /Select a Rust ELF/);
    assert.ok(!incomplete.events.includes("stop-dap"));
    assert.equal(incomplete.oldLease.released, false);
    incomplete.oldLease.release();

    const shared = fixture();
    shared.provider._debugBridge.allSessions.set("other", { id: "other" });
    await assert.rejects(shared.provider._downloadProbeRs(), { code: "PROBE_BUSY" });
    assert.ok(!shared.events.includes("stop-dap"), "do not tear down one session while another remains active");
    shared.oldLease.release();

    const changed = fixture({ afterStop: () => (changed.settings.probeRsChip = "STM32F407VG") });
    await assert.rejects(changed.provider._downloadProbeRs(), { code: "PROBE_RS_CONFIGURATION_CHANGED" });
    assert.ok(!changed.events.includes("flash"));
    assert.equal(changed.provider._probeCoordinator.anyActive(), false);

    const detachmentFailed = fixture();
    detachmentFailed.provider._debugBridge.waitForState = async () => {
        throw Object.assign(new Error("debug state timed out"), { code: "DEBUG_CONTROL_TIMEOUT" });
    };
    await assert.rejects(detachmentFailed.provider._downloadProbeRs(), { code: "DEBUG_CONTROL_TIMEOUT" });
    assert.equal(detachmentFailed.oldLease.released, false);
    assert.ok(!detachmentFailed.events.includes("flash"));
    detachmentFailed.oldLease.release();

    for (const operation of [
        "download",
        "debugStart",
        "debugServer",
        "agentRead",
        "chipInfo",
        "externalDebug",
        "cpuLoad"
    ]) {
        const guarded = fixture({ sampling: false });
        const lease = guarded.provider._probeCoordinator.acquire(operation);
        await assert.rejects(guarded.provider._downloadProbeRs(), { code: "PROBE_BUSY" });
        assert.equal(lease.released, false);
        assert.ok(!guarded.events.includes("flash"));
        lease.release();
    }
    for (const hook of ["afterStop", "beforeRun"]) {
        const guarded = fixture({ [hook]: (provider) => (provider._probeDriverSwitching = true) });
        await assert.rejects(guarded.provider._downloadProbeRs(), { code: "PROBE_DRIVER_BUSY" });
        assert.ok(!guarded.events.includes("flash"), "recheck gates after asynchronous preparation");
        assert.equal(guarded.provider._probeCoordinator.anyActive(), false);
        assert.equal(guarded.provider._probeRsTransition, false);
    }
    console.log("probe-rs flash teardown, gates, refresh and sampling restoration tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
