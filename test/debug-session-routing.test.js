"use strict";
const assert = require("assert");
const path = require("path");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { DebugControlService } = require("../src/services/debugControlService");
const { RtosViewService } = require("../src/services/rtosViewService");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const { args, request } = require("../skills/mcu-debug-control/scripts/debug");
const { loadProvider } = require("./helpers/load-provider");

(async () => {
    const bridge = new DebugSessionBridge();
    const folder = { uri: { toString: () => "file:///routing", fsPath: process.cwd() } };
    const calls = [];
    let resolveRead, resolveWrite, resolveTasks;
    function core(index, workspaceFolder = folder) {
        return {
            id: "core" + index,
            type: "emberprobe",
            name: "CPU " + index,
            workspaceFolder,
            configuration: {
                serverGroup: "dual",
                targetProcessor: index,
                executable: "core" + index + ".elf",
                cwd: process.cwd()
            },
            async customRequest(command, data) {
                calls.push({ id: this.id, command, data });
                if (command === "readMemory")
                    return new Promise((resolve) => {
                        resolveRead = resolve;
                    });
                if (command === "writeMemory")
                    return new Promise((resolve) => {
                        resolveWrite = resolve;
                    });
                if (command === "emberprobe.rtosSnapshot")
                    return new Promise((resolve) => {
                        resolveTasks = resolve;
                    });
                if (command === "next") {
                    bridge.handleMessage(this, {
                        type: "event",
                        event: "stopped",
                        body: { threadId: data.threadId, reason: "step" }
                    });
                    return {};
                }
                throw new Error(command);
            }
        };
    }
    function stopped(session, threadId) {
        bridge.handleMessage(session, {
            type: "response",
            command: "initialize",
            success: true,
            body: { supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true, supportsRestartRequest: true }
        });
        bridge.handleMessage(session, {
            type: "event",
            event: "capabilities",
            body: { capabilities: { supportsRestartRequest: false } }
        });
        bridge.handleMessage(session, { type: "event", event: "stopped", body: { threadId, reason: "breakpoint" } });
    }
    const a = core(0),
        b = core(1),
        other = core(2, { uri: { toString: () => "file:///other" } });
    bridge.setWorkspace(folder);
    bridge.attach(a);
    stopped(a, 7);
    bridge.attach(b);
    stopped(b, 19);
    bridge.attach(other);
    stopped(other, 33);
    assert.strictEqual(bridge.agentStatus().state, "conflict");
    assert.strictEqual(bridge.agentStatus().sessions.length, 2);
    assert.throws(() => bridge.assertUniqueSession(), { code: "DEBUG_SESSION_CONFLICT" });
    for (const selector of [
        {},
        { targetProcessor: 1 },
        { sessionId: "" },
        { serverGroup: "dual", targetProcessor: -1 },
        { sessionId: 2 }
    ])
        assert.throws(() => bridge.selectSession(selector), { code: "DEBUG_SESSION_SELECTION_INVALID" });
    assert.throws(() => bridge.selectSession({ serverGroup: "dual" }), { code: "DEBUG_SESSION_CONFLICT" });
    assert.throws(() => bridge.selectSession({ sessionId: other.id }), { code: "DEBUG_SESSION_NOT_ACTIVE" });
    assert.strictEqual(bridge.selectSession({ serverGroup: "dual", targetProcessor: 1 }).threadId, 19);
    assert.strictEqual(bridge.capabilities.restart, false);
    bridge.handleMessage(a, { type: "event", event: "continued" });
    assert.strictEqual(bridge.threadId, 19, "another core's event cannot replace the selected task");
    assert(bridge.paused);
    bridge.handleRequest(a, { type: "request", command: "continue", seq: 10 });
    assert.strictEqual(bridge.transitionKind, "");
    const tasks = new RtosViewService(bridge).refresh();
    const staleRead = bridge.readPausedItems([{ name: "value", address: 0x20000000, size: 1 }]);
    await Promise.resolve();
    const epoch = bridge.stopEpoch;
    bridge.selectSession({ sessionId: a.id });
    assert(!bridge.paused);
    assert(bridge.stopEpoch > epoch);
    resolveRead({ data: "AQ==" });
    await assert.rejects(staleRead, /cancelled|changed/);
    resolveTasks({ tasks: [{ name: "old task" }] });
    await assert.rejects(tasks, /Stale/);
    assert(!bridge.snapshotReady);
    bridge.selectSession({ sessionId: b.id });
    assert(bridge.paused);
    assert.strictEqual((await bridge.control("stepOver")).threadId, 19);
    assert.strictEqual(calls.at(-1).id, b.id);
    const writing = bridge.writePausedMemory(0x20000000, [2]);
    assert.throws(() => bridge.selectSession({ sessionId: a.id }), { code: "DEBUG_CONTROL_BUSY" });
    await assert.rejects(bridge.writePausedMemory(0x20000000, [3]), { code: "DEBUG_CONTROL_BUSY" });
    resolveWrite({ bytesWritten: 1 });
    await writing;
    const interrupted = bridge.writePausedMemory(0x20000000, [4]);
    bridge.handleMessage(b, { type: "event", event: "continued" });
    resolveWrite({ bytesWritten: 1 });
    await assert.rejects(interrupted, { code: "DEBUG_STATE_CHANGED" });
    assert(!bridge.writing);
    bridge.setWorkspace(other.workspaceFolder);
    assert.strictEqual(bridge.threadId, 33, "inactive workspace events are preserved in their own context");
    bridge.setWorkspace(folder);
    bridge.selectSession({ sessionId: a.id });
    const service = new DebugControlService({
        debugBridge: bridge,
        vscode: {
            debug: {
                stopDebugging: async (session) => {
                    assert.strictEqual(session, a);
                    bridge.detach(session);
                }
            }
        }
    });
    await service.control({ action: "stop" });
    assert(bridge.allSessions.has(b.id), "stop waits for the selected session only");
    assert.strictEqual(bridge.activeSession, b);
    bridge.dispose();

    const operation = request(args(["--select", "--group", "dual", "--core", "1"]));
    assert.deepStrictEqual(operation, {
        method: "debug.select",
        params: { sessionId: undefined, serverGroup: "dual", targetProcessor: 1 }
    });
    assert.strictEqual(request(args(["--select", "--session", "core0"])).params.sessionId, "core0");
    for (const argv of [
        ["--select"],
        ["--select", "--core", "1"],
        ["--status", "--session", "core0"],
        ["--select", "--group", "dual", "--core", "-1"],
        ["--select", "--session", "core0", "--thread", "1"]
    ])
        assert.throws(() => args(argv));
    const routes = createAgentRoutes({ _selectDebugSession: (value) => value });
    assert.deepStrictEqual(routes["debug.select"]({ sessionId: "one" }), { sessionId: "one" });
    const Provider = loadProvider();
    const host = Object.create(Provider.prototype);
    let selected = path.resolve("core0.elf");
    Object.assign(host, {
        _managedDebugGroup: {},
        _context: { workspaceState: { get: () => selected } },
        _debugBridge: { activeSession: a, assertUniqueSession: () => a }
    });
    host._assertGroupedReadElf();
    selected = path.resolve("core1.elf");
    assert.throws(() => host._assertGroupedReadElf(), { code: "DEBUG_ELF_SESSION_MISMATCH" });
    selected = null;
    assert.throws(() => host._assertGroupedReadElf(), { code: "DEBUG_ELF_SESSION_MISMATCH" });
    const notices = [];
    const entry = {
        latestSamples: new Map([["value", 1]]),
        _pendingScalars: [1],
        post: (message) => notices.push(message)
    };
    Object.assign(host, {
        _managedDebugGroup: { id: "dual" },
        _debugBridge: { activeSession: a },
        _latestSidebarSamples: new Map([["value", 1]]),
        _livePanels: new Map([[1, entry]]),
        _webviewView: { webview: { postMessage: (message) => notices.push(message) } },
        _pendingSidebarScalars: [1]
    });
    const scope0 = host._debugSamplingScope("watch");
    host._syncDebugSampleContext();
    assert.strictEqual(host._latestSidebarSamples.size, 0);
    assert.strictEqual(entry.latestSamples.size, 0);
    assert.deepStrictEqual(host._pendingSidebarScalars, []);
    assert.deepStrictEqual(entry._pendingScalars, []);
    assert.strictEqual(notices.length, 2);
    host._syncDebugSampleContext();
    assert.strictEqual(notices.length, 2, "repeating one session's status keeps its history");
    host._debugBridge.activeSession = b;
    assert.notStrictEqual(host._debugSamplingScope("watch"), scope0, "CSV history is separated by session");
    host._syncDebugSampleContext();
    assert.strictEqual(notices.at(-1).sessionId, b.id);
    host._managedDebugGroup = null;
    assert.strictEqual(host._debugSamplingScope("watch"), "watch");
    host._syncDebugSampleContext();
    console.log(
        "Explicit per-session routing: independent states, stale reads/tasks, writes, stop, CLI and ELF guards passed"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
