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
        _livePanels: new Map(),
        _latestSidebarSamples: new Map([["counter", { bytes: [1] }]]),
        _debugBridge: { hasSession: false, hasAnySession: false, setIntent() {} },
        _webviewView: { webview: { postMessage: (message) => messages.push(message) } },
        _postConsumerStatuses() {},
        _postLive: (message) => messages.push(message),
        _resolveOpenOcdPath: async () => "fake-openocd",
        _commandContext: () => ({}),
        _t: (key) => key,
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
            download: async (_vscode, options) => {
                assert.strictEqual(provider._downloadRunning, true);
                assert.strictEqual(provider._sampling.session, null);
                if (sampling) assert.ok(events.includes("stopped"), "probe exits before flashing starts");
                events.push("flash");
                await options.prepare();
                if (failFlash) throw new Error("Flash failed");
            }
        }
    });
    Object.assign(provider._elfView, {
        hydrateSelectedLayouts: async () => {},
        rebindWatchLists: async (symbols) => {
            events.push("rebind");
            assert.strictEqual(symbols[0].address, 0x20000004);
        }
    });
    Object.assign(provider._sampling, {
        intent: sampling,
        consumers: new Set(["sidebar", "graph"]),
        intervalMs: 50,
        _flushPendingWebviewSamples() {},
        start: async (items, interval, consumer) => {
            assert.strictEqual(provider._downloadRunning, false, "release the probe before resuming");
            assert.ok(events.includes("memory-ready"));
            assert.ok(events.includes("sidebar-refresh"));
            assert.strictEqual(provider._latestSidebarSamples.size, 0, "discard values from old firmware");
            assert.strictEqual(interval, 50);
            assert.strictEqual(consumer, "refresh");
            events.push("resume");
            if (failResume) throw new Error("Reconnect failed");
            provider._sampling.intent = true;
        }
    });
    Object.assign(provider._sampling, { activeReadPlan: () => [symbol] });
    if (sampling) {
        provider._sampling._lease = provider._probeCoordinator.acquire("liveWatch");
        provider._sampling.session = {
            stop: async () => {
                events.push("stop");
                await Promise.resolve();
                assert.strictEqual(provider._sampling.running, true, "retain sampling ownership while it exits");
                events.push("stopped");
            }
        };
    } else provider._sampling.session = null;
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
    assert.strictEqual(active.provider._sampling.intent, true);
    assert.ok(active.messages.some((message) => message.type === "availableVariables"));

    const idle = fixture({ sampling: false });
    await idle.provider.commandHandlers["mcu-vscode.download"]();
    assert.ok(idle.events.includes("sidebar-refresh"));
    assert.ok(!idle.events.includes("resume"), "previously stopped sampling stays stopped");

    const failed = fixture({ failFlash: true });
    await assert.rejects(failed.provider.commandHandlers["mcu-vscode.download"](), /Flash failed/);
    assert.strictEqual(failed.provider._sampling.intent, false);
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
        const notices = followup.messages.filter((message) => message.type === "notice");
        assert.deepStrictEqual(
            notices.map(({ id, notice }) => [id, notice.level]).filter(([, level]) => level !== "info"),
            [
                ["mcu-vscode.download", "success"],
                ["download-refresh", "warning"]
            ],
            "post-flash failure preserves the successful flash result"
        );
        assert.strictEqual(followup.warnings.length, 0, "a visible sidebar shows the warning without a notification");
        if (options.failRefresh) assert.ok(!followup.events.includes("resume"));
    }

    const busy = fixture({ sampling: false });
    busy.provider._sampling.intent = true;
    const lease = busy.provider._probeCoordinator.acquire("download");
    await busy.provider._sampling.refreshSamplingPlan();
    assert.ok(!busy.events.includes("resume"), "ELF updates cannot start sampling during a flash");
    assert.strictEqual(await busy.provider.commandHandlers["mcu-vscode.download"](), false);
    lease.release();

    // A probe held by an operation the download cannot displace is refused before RTT or live watch is interrupted.
    const held = fixture({ sampling: false });
    Object.defineProperty(held.provider, "_rtt", {
        value: { yieldForRestart: () => held.events.push("rtt-yield"), onSessionsChanged() {} }
    });
    const scan = held.provider._probeCoordinator.acquire("targetScan");
    assert.strictEqual(await held.provider.commandHandlers["mcu-vscode.download"](), false);
    assert.deepStrictEqual(held.events, [], "nothing is interrupted for a download that cannot start");
    assert.ok(
        held.messages.some(
            (message) =>
                message.type === "notice" && message.id === "mcu-vscode.download" && message.notice.level === "warning"
        )
    );
    scan.release();
    console.log("Flash refresh, sampling restoration and failure isolation tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
