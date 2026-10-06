"use strict";

const assert = require("assert");
const path = require("path");
const { loadProvider } = require("./helpers/load-provider");
const { ExternalDebugService } = require("../src/services/externalDebugService");
const { ProbeCoordinator } = require("../src/probeCoordinator");
const { DebugLifecycle } = require("../src/services/debugLifecycle");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { fingerprintWritePlan } = require("../src/writeAuthorization");

(async () => {
    const config = { "experimental.externalGdb.enabled": true, "experimental.externalGdb.target": "localhost:3333" };
    const settings = { get: (key, fallback) => config[key] ?? fallback };
    const folder = { uri: { fsPath: __dirname, toString: () => "folder" } };
    const other = { uri: { fsPath: path.dirname(__dirname), toString: () => "other" } };
    const values = new Map([["mcu.elfPath", __filename]]);
    const state = { get: (key) => values.get(key), update: async (key, value) => values.set(key, value) };
    let actualFolder;
    let tools = true;
    let duringTools = () => {};
    const vscode = {
        workspace: {
            isTrusted: true,
            getConfiguration: (_section, uri) => {
                actualFolder = uri;
                return settings;
            }
        },
        debug: { stopDebugging: async () => true },
        window: { showErrorMessage: () => {} }
    };
    const Host = loadProvider(vscode, {
        "./services/cortexDebugPreflight": {
            ensureDebugTools: async () => {
                duringTools();
                return tools ? { gdbPath: "fake-gdb" } : null;
            }
        }
    });
    const host = Object.create(Host.prototype);
    host._probeCoordinator = new ProbeCoordinator();
    host._context = { workspaceState: state };
    host._externalDebug = new ExternalDebugService({
        state,
        coordinator: host._probeCoordinator,
        settings: () => settings
    });
    host._debugBridge = new DebugSessionBridge();
    host._debugLifecycle = new DebugLifecycle();
    host._terminatedDebugSessionIds = new Set();
    host._svdManager = { currentPath: async () => "" };
    host._samplingCoordinator = { setDebugIntent: (bridge, intent) => bridge.setIntent(intent) };
    host._postConsumerStatuses = () => {};
    host._t = (key) => key;
    host._activeReadPlan = () => [];
    host._syncDebugSampleSession = () => {};
    host._probeConnectionService = {
        recordSuccess: () => {
            throw new Error("external must not record a physical probe");
        },
        assertCurrent: () => {}
    };
    host.commandHandlers = {};
    host.registerCommandHandlers();
    await assert.rejects(host.commandHandlers["mcu-vscode.debug"](folder.uri, { servertype: "external" }), /F5/);
    for (const name of ["_resolveOpenOcdPath", "_startManagedDebugServer", "_assertProbeDriverIdle"])
        host[name] = () => {
            throw new Error(`external must not call ${name}`);
        };

    const launch = { type: "emberprobe", request: "attach", servertype: "external", executable: __filename };
    await assert.rejects(host.prepareExternalDebug(folder, { ...launch, gdbTarget: "host:1" }));
    assert(!host._externalDebug.held);
    vscode.workspace.isTrusted = false;
    await assert.rejects(host.prepareExternalDebug(folder, launch), /trusted/);
    vscode.workspace.isTrusted = true;
    config["experimental.externalGdb.enabled"] = false;
    await assert.rejects(host.prepareExternalDebug(folder, launch), /Enable/);
    config["experimental.externalGdb.enabled"] = true;
    tools = false;
    assert.strictEqual(await host.prepareExternalDebug(folder, launch), undefined);
    assert(!host._externalDebug.held);
    tools = true;
    duringTools = () => {
        config["experimental.externalGdb.enabled"] = false;
    };
    await assert.rejects(host.prepareExternalDebug(folder, launch), /disabled during startup/);
    assert(!host._externalDebug.held);
    duringTools = () => {
        config["experimental.externalGdb.target"] = "changed:4444";
    };
    config["experimental.externalGdb.enabled"] = true;
    const prepared = await host.prepareExternalDebug(other, launch);
    assert.strictEqual(actualFolder, other.uri, "settings resolve against the actual debug folder");
    assert.strictEqual(prepared.gdbTarget, "localhost:3333", "connection settings are frozen at startup");
    assert.strictEqual(prepared.servertype, "external");
    assert.strictEqual(prepared.rtos, "");
    assert.strictEqual(host._managedDebugServer, undefined);
    assert.strictEqual(host._probeCoordinator.firstActive(), "externalDebug");
    await assert.rejects(host.prepareExternalDebug(folder, launch));

    const session = { id: "external", type: "emberprobe", workspaceFolder: other, configuration: prepared };
    host.handleDebugSessionStart(session);
    assert(host._matchesManagedDebugSession(session));
    host.handleDebugAdapterMessage(session, { type: "response", command: "attach", success: true });
    host.handleDebugAdapterMessage(session, { type: "event", event: "initialized" });
    assert(!host._debugLifecycle.pending);
    host.handleDebugAdapterMessage(session, {
        type: "event",
        event: "capabilities",
        body: {
            capabilities: {
                supportsReadMemoryRequest: true,
                supportsWriteMemoryRequest: true,
                supportsRestartRequest: false
            }
        }
    });
    host.handleDebugAdapterMessage(session, { type: "event", event: "stopped", body: { threadId: 7 } });
    assert(host._debugBridge.paused);
    await host.startLiveWatch([], undefined, "sidebar");
    assert(host._debugBridge.intentEnabled, "paused sampling uses DAP without requiring a probe configuration");
    values.set("mcu.elfPath", path.join(__dirname, "wrong.elf"));
    assert.throws(() => host._assertGroupedReadElf(), { code: "DEBUG_ELF_SESSION_MISMATCH" });
    values.set("mcu.elfPath", __filename);
    host._assertGroupedReadElf();
    const identity = host._sessionWriteConnection(host._debugBridge);
    assert.strictEqual(identity.kind, "dap");
    assert.strictEqual(identity.sessionId, session.id);
    const old = fingerprintWritePlan({ connection: identity });
    host._debugBridge.stopEpoch++;
    assert.notStrictEqual(
        fingerprintWritePlan({ connection: host._sessionWriteConnection(host._debugBridge) }),
        old,
        "old write confirmation cannot cross stop generations"
    );
    let restored = 0;
    host.startLiveWatch = () => restored++;
    host._samplingIntent = true;
    await host.restoreSamplingAfterDebug();
    assert.strictEqual(restored, 0);
    await host._externalDebug.message(session, {
        type: "event",
        event: "emberprobe.externalGdbProcess",
        body: { exited: true }
    });
    await host.handleDebugSessionTerminate(session);
    await host.handleDebugSessionTerminate(session);
    assert(!host._externalDebug.active);
    assert(host._externalDebug.held);
    assert.strictEqual(host._samplingIntent, false);
    config["experimental.externalGdb.enabled"] = false;
    await host.externalDebugSettingsChanged();
    assert(!host._externalDebug.held);
    assert.strictEqual(restored, 0, "disabling the setting never auto-starts sampling");
    host._debugBridge.dispose();
    host._debugLifecycle.clear();
    console.log("External GDB native settings, host routing, DAP identity and sampling protection tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
