"use strict";

const assert = require("assert");
const { loadProvider } = require("./helpers/load-provider");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { STARTUP_PHASES } = require("../src/services/debugConfiguration");

// The "debug without reset" entry must reuse the managed OpenOCD path but issue a DAP attach,
// so the adapter only halts the core (no reset, no download) and the current state survives.
(async () => {
    const started = [];
    const serverRequests = [];
    const folder = { uri: { fsPath: __dirname, toString: () => "folder" } };
    const values = new Map([
        ["mcu.elfPath", __filename],
        ["mcu.debugger", "stlink.cfg"],
        ["mcu.mcuCore", "stm32f1x.cfg"]
    ]);
    const vscode = {
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        window: { showErrorMessage: () => {}, showWarningMessage: () => {} },
        debug: {
            startDebugging: async (_folder, config) => {
                started.push(config);
                throw new Error("captured");
            }
        }
    };
    const Host = loadProvider(vscode, {
        "./services/debugToolPreflight": { ensureDebugTools: async () => ({ gdbPath: "fake-gdb" }) },
        "./openocdScripts": { ...require("../src/openocdScripts"), resolveOpenOcdLaunch: () => ({}) }
    });
    const host = Object.create(Host.prototype);
    let serverStops = 0;
    Object.assign(host, {
        _context: { workspaceState: { get: (key) => values.get(key), update: async () => {} } },
        _t: (key) => key,
        _commandContext: () => ({ folder }),
        _postProbeOperationStatus() {},
        _svdManager: { currentPath: async () => "" },
        _resolveOpenOcdPath: async () => "openocd",
        _probeCoordinator: new ProbeCoordinator()
    });
    Object.assign(host.debugLaunch, {
        prepareProbe: async () => {},
        startManagedServer: async (_executable, _probe, _target, _cfg, _interactive, _rtos, options, phase) => {
            serverRequests.push(options.request);
            phase?.("preflight");
            phase?.("server");
            return { gdbTarget: "127.0.0.1:3333" };
        },
        armStartupWatchdog: () => new Promise(() => {}),
        clearStartupWatchdog() {},
        stopManagedServer: async () => {
            serverStops++;
            host.debugLaunch.serverLease?.release();
            host.debugLaunch.serverLease = null;
        },
        restoreSampling: async () => {}
    });
    host.commandHandlers = {};
    host.registerCommandHandlers();

    await assert.rejects(host.commandHandlers["mcu-vscode.attachDebug"](), /captured/);
    await assert.rejects(host.commandHandlers["mcu-vscode.debug"](), /captured/);
    assert.deepStrictEqual(
        started.map((config) => config.request),
        ["attach", "launch"]
    );
    assert.deepStrictEqual(serverRequests, ["attach", "launch"]);
    assert.strictEqual(started[0].gdbTarget, "127.0.0.1:3333");
    assert.strictEqual(started[0].type, "emberprobe");
    assert.strictEqual(serverStops, 2, "a failed start must still release the managed server");

    // An explicit launch.json request is never overridden by the sidebar shortcut.
    const resolved = await host.commandHandlers["mcu-vscode.debug"](undefined, { request: "launch" }, true, {
        attach: true
    });
    assert.strictEqual(resolved.request, "launch");
    assert.strictEqual(resolved.__emberprobeStartupTrace, undefined, "only performanceTrace forwards startup phases");

    // performanceTrace forwards the extension-side phases before the adapter starts, as durations only.
    await host.debugLaunch.stopManagedServer();
    const traced = await host.commandHandlers["mcu-vscode.debug"](undefined, {
        request: "launch",
        performanceTrace: true
    });
    const startup = traced.__emberprobeStartupTrace;
    assert(Number.isSafeInteger(startup.startedAt) && startup.startedAt <= Date.now());
    assert.deepStrictEqual(Object.keys(startup.phases), STARTUP_PHASES);
    assert(Object.values(startup.phases).every((duration) => Number.isInteger(duration) && duration >= 0));
    await host.debugLaunch.stopManagedServer();
    let releaseWarmup;
    let warmupStarted;
    const warming = new Promise((resolve) => (warmupStarted = resolve));
    const gate = new Promise((resolve) => (releaseWarmup = resolve));
    host.debugLaunch.gdbWarmup = {
        warm: () => {
            warmupStarted();
            return gate;
        },
        snapshot: () => ({ state: "ready", durationMs: 5300 })
    };
    let prepared = false;
    host.debugLaunch.prepareProbe = async () => (prepared = true);
    const waiting = host.commandHandlers["mcu-vscode.debug"](undefined, {
        request: "launch",
        performanceTrace: true
    });
    await warming;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(prepared, false, "a cold GDB prepares before stopping sampling or acquiring the probe");
    assert.strictEqual(host._probeCoordinator.anyActive(), false);
    releaseWarmup(true);
    const warmed = await waiting;
    assert(prepared);
    assert.deepStrictEqual(warmed.__emberprobeStartupTrace.gdbWarmup, { state: "ready", durationMs: 5300 });
    await host.debugLaunch.stopManagedServer();
    host.debugLaunch.gdbWarmup = {
        warm: async () => false,
        snapshot: () => ({ state: "failed", durationMs: 30000 })
    };
    const failedWarmup = await host.commandHandlers["mcu-vscode.debug"](undefined, {
        request: "attach",
        performanceTrace: true
    });
    assert.strictEqual(failedWarmup.request, "attach", "a failed optimization does not prevent normal startup");
    assert.strictEqual(failedWarmup.__emberprobeStartupTrace.gdbWarmup.state, "failed");
    await host.debugLaunch.stopManagedServer();
    console.log("attach-debug-command tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
