"use strict";

const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { SamplingCoordinator } = require("../src/services/samplingCoordinator");

function fixture({ sampling = true, failFlash = false, failRefresh = false, failResume = false } = {}) {
    const events = [],
        warnings = [],
        messages = [];
    const state = new Map([
        ["mcu.elfPath", "firmware.elf"],
        ["mcu.debugger", "stlink.cfg"],
        ["mcu.mcuCore", "stm32f4x.cfg"]
    ]);
    const vscode = {
        debug: {},
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        window: {
            showWarningMessage: (message) => warnings.push(message),
            showInformationMessage() {},
            showErrorMessage() {}
        }
    };
    const Provider = loadProvider(vscode);
    const provider = Object.create(Provider.prototype);
    const symbol = { name: "counter", address: 0x20000004, size: 4 };
    Object.assign(provider, {
        commandHandlers: {},
        _context: { workspaceState: { get: (key) => state.get(key) } },
        _probeCoordinator: new ProbeCoordinator(),
        _samplingCoordinator: new SamplingCoordinator(),
        _samplingIntent: sampling,
        _liveConsumers: new Set(["sidebar", "graph"]),
        _livePanels: new Map(),
        _latestSidebarSamples: new Map([["counter", { bytes: [1] }]]),
        _liveIntervalMs: 50,
        _debugBridge: { hasSession: false, hasAnySession: false, setIntent() {} },
        _webviewView: { webview: { postMessage: (message) => messages.push(message) } },
        _flushPendingWebviewSamples() {},
        _postConsumerStatuses() {},
        _postLive: (message) => messages.push(message),
        _resolveOpenOcdPath: async () => "fake-openocd",
        _commandContext: () => ({}),
        _t: (key) => key,
        _activeReadPlan: () => [symbol],
        _watchLists: { invalidate: () => events.push("invalidate-watch") },
        _elfService: {
            invalidate: () => events.push("invalidate-elf"),
            ready: async () => {
                if (failRefresh) throw new Error("ELF parse failed");
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
            assert.strictEqual(symbols[0].address, 0x20000004);
        },
        _watchListWithDisplayNames: () => [symbol],
        _syncSidebarTarget: (post) => {
            events.push("sidebar-refresh");
            post({ type: "availableVariables", symbols: [symbol] });
        },
        _probeConnectionService: {
            prepare: async () => ({}),
            recordSuccess: async () => events.push("verified")
        },
        _flashService: {
            download: async () => {
                assert.strictEqual(provider._downloadRunning, true);
                assert.strictEqual(provider._liveSession, null);
                if (sampling) assert.ok(events.includes("stopped"), "probe exits before flashing starts");
                events.push("flash");
                if (failFlash) throw new Error("Flash failed");
            }
        },
        startLiveWatch: async (items, interval, consumer) => {
            assert.strictEqual(provider._downloadRunning, false, "release the probe before resuming");
            assert.ok(events.includes("memory-ready"));
            assert.ok(events.includes("sidebar-refresh"));
            assert.strictEqual(provider._latestSidebarSamples.size, 0, "discard values from old firmware");
            assert.strictEqual(interval, 50);
            assert.strictEqual(consumer, "refresh");
            events.push("resume");
            if (failResume) throw new Error("Reconnect failed");
            provider._samplingIntent = true;
        }
    });
    if (sampling) {
        provider._liveWatchLease = provider._probeCoordinator.acquire("liveWatch");
        provider._liveSession = {
            stop: async () => {
                events.push("stop");
                await Promise.resolve();
                assert.strictEqual(provider._downloadRunning, true, "reserve the probe while it exits");
                events.push("stopped");
            }
        };
    } else provider._liveSession = null;
    provider.registerCommandHandlers();
    return { provider, events, warnings, messages, state };
}

(async () => {
    const active = fixture();
    assert.strictEqual(await active.provider.commandHandlers["mcu-vscode.download"](), true);
    assert.deepStrictEqual(active.events, [
        "stop",
        "stopped",
        "flash",
        "verified",
        "invalidate-elf",
        "invalidate-watch",
        "memory-start",
        "memory-ready",
        "rebind",
        "sidebar-refresh",
        "resume"
    ]);
    assert.strictEqual(active.provider._samplingIntent, true);
    assert.ok(active.messages.some((message) => message.type === "availableVariables"));

    const idle = fixture({ sampling: false });
    await idle.provider.commandHandlers["mcu-vscode.download"]();
    assert.ok(idle.events.includes("sidebar-refresh"));
    assert.ok(!idle.events.includes("resume"), "previously stopped sampling stays stopped");

    const failed = fixture({ failFlash: true });
    await assert.rejects(failed.provider.commandHandlers["mcu-vscode.download"](), /Flash failed/);
    assert.strictEqual(failed.provider._samplingIntent, false);
    assert.strictEqual(failed.provider._downloadRunning, false);
    assert.ok(!failed.events.includes("resume"));

    const incomplete = fixture();
    incomplete.state.delete("mcu.elfPath");
    assert.strictEqual(await incomplete.provider.commandHandlers["mcu-vscode.download"](), false);
    assert.ok(!incomplete.events.includes("flash"));
    assert.ok(!incomplete.events.includes("resume"));
    assert.strictEqual(incomplete.provider._downloadRunning, false);

    for (const options of [{ failRefresh: true }, { failResume: true }]) {
        const followup = fixture(options);
        assert.strictEqual(await followup.provider.commandHandlers["mcu-vscode.download"](), true);
        assert.strictEqual(followup.provider._downloadRunning, false);
        assert.strictEqual(followup.warnings.length, 1, "post-flash failure preserves the successful flash result");
        if (options.failRefresh) assert.ok(!followup.events.includes("resume"));
    }

    const busy = fixture({ sampling: false });
    busy.provider._samplingIntent = true;
    const lease = busy.provider._probeCoordinator.acquire("download");
    await busy.provider._refreshSamplingPlan();
    assert.ok(!busy.events.includes("resume"), "ELF updates cannot start sampling during a flash");
    assert.strictEqual(await busy.provider.commandHandlers["mcu-vscode.download"](), false);
    lease.release();
    console.log("Flash refresh, sampling restoration and failure isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
