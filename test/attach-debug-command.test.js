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
        "./services/cortexDebugPreflight": { ensureDebugTools: async () => ({ gdbPath: "fake-gdb" }) },
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
        prepareForCortexDebug: async () => {},
        _probeCoordinator: new ProbeCoordinator(),
        _startManagedDebugServer: async (_executable, _probe, _target, _cfg, _interactive, _rtos, options, phase) => {
            serverRequests.push(options.request);
            phase?.("preflight");
            phase?.("server");
            return { gdbTarget: "127.0.0.1:3333" };
        },
        _armDebugStartupWatchdog: () => new Promise(() => {}),
        _clearDebugStartupWatchdog() {},
        _stopManagedDebugServer: async () => {
            serverStops++;
            host._debugServerLease?.release();
            host._debugServerLease = null;
        },
        restoreSamplingAfterDebug: async () => {}
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
    await host._stopManagedDebugServer();
    const traced = await host.commandHandlers["mcu-vscode.debug"](undefined, {
        request: "launch",
        performanceTrace: true
    });
    const startup = traced.__emberprobeStartupTrace;
    assert(Number.isSafeInteger(startup.startedAt) && startup.startedAt <= Date.now());
    assert.deepStrictEqual(Object.keys(startup.phases), STARTUP_PHASES);
    assert(Object.values(startup.phases).every((duration) => Number.isInteger(duration) && duration >= 0));
    console.log("attach-debug-command tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
