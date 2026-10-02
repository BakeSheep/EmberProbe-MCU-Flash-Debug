"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { AgentBridge } = require("../src/agentBridge");
const { AgentService } = require("../src/services/agentService");
const { createAgentRoutes } = require("../src/services/agentRoutes");
const { AgentDebugInspection } = require("../src/services/agentDebugInspection");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { RtosViewService } = require("../src/services/rtosViewService");
const cli = require("../skills/_emberprobe/debug-inspection-client");
const { diagnosticForError } = require("../skills/_emberprobe/agent-client");

(async () => {
    for (const method of ["debug.inspect", "rtos.status", "rtos.snapshot"]) {
        const diagnostic = diagnosticForError(
            Object.assign(new Error("timeout"), { code: "BRIDGE_TIMEOUT", details: { method } }),
            { operation: method }
        );
        assert.strictEqual(diagnostic.error.details.resultUnknown, false, `${method} is a read-only request`);
        assert.strictEqual(diagnostic.error.retryable, true);
    }
    const calls = [];
    let hook = null;
    let threadId = 7;
    const session = {
        id: "core-0",
        type: "emberprobe",
        async customRequest(command, params) {
            calls.push({ command, params });
            if (hook) await hook(command);
            switch (command) {
                case "threads":
                    return { body: { threads: [{ id: threadId, name: "Worker" }] } };
                case "stackTrace":
                    return { stackFrames: [{ id: 0, name: "app::Worker::run", line: 42 }], totalFrames: 1 };
                case "scopes":
                    return { scopes: [{ name: "Locals", variablesReference: 10, expensive: false }] };
                case "variables":
                    return {
                        variables: [
                            { name: "samples", type: "std::vector<int>", value: "length 205", variablesReference: 20 },
                            { name: "ticks", type: "uint64_t", value: "18446744073709551615", variablesReference: 0 }
                        ]
                    };
                case "emberprobe.rtosSnapshot":
                    return {
                        kernel: { name: "FreeRTOS", supported: true },
                        tasks: [{ taskKey: "0x20000100", name: "Worker", priority: 3, stack: {} }],
                        partial: true,
                        diagnostics: ["stack bounds unavailable"]
                    };
                default:
                    throw new Error(`Unexpected DAP command ${command}`);
            }
        }
    };
    const bridge = new DebugSessionBridge({ trackSessions: false });
    bridge.sessions.set(session.id, session);
    bridge.paused = true;
    bridge.stopEpoch = 1;
    const inspection = new AgentDebugInspection(bridge);
    const threads = await inspection.inspect({ action: "threads" });
    assert.strictEqual(threads.threads[0].id, 7);
    assert.strictEqual(threads.sessionId, session.id);
    const stack = await inspection.inspect({ action: "stack", threadId: 7, start: 2, count: 3 });
    const frame = stack.stackFrames[0].frame;
    assert.strictEqual(stack.stackFrames[0].id, undefined);
    assert.deepStrictEqual(calls.at(-1).params, { threadId: 7, startFrame: 2, levels: 3 });
    const scopes = await inspection.inspect({ action: "scopes", frame });
    assert.strictEqual(calls.at(-1).params.frameId, 0, "DAP frame zero is valid");
    const reference = scopes.scopes[0].reference;
    const variables = await inspection.inspect({
        action: "variables",
        reference,
        start: 100,
        count: 5,
        filter: "indexed"
    });
    assert.deepStrictEqual(calls.at(-1).params, { variablesReference: 10, start: 100, count: 5, filter: "indexed" });
    assert.strictEqual(variables.variables[1].value, "18446744073709551615");
    assert.strictEqual(variables.variables[1].reference, null);
    assert(variables.variables[0].reference);
    await inspection.inspect({ action: "variables", reference: variables.variables[0].reference });
    assert.strictEqual(calls.at(-1).params.variablesReference, 20);

    for (const params of [
        { action: "evaluate", expression: "reset()" },
        { action: "stack", threadId: 0 },
        { action: "stack", threadId: 7, count: 101 },
        { action: "variables", reference, start: -1 },
        { action: "variables", reference, filter: "all" }
    ])
        await assert.rejects(inspection.inspect(params), { code: "DEBUG_INSPECTION_INVALID" });
    await assert.rejects(inspection.inspect({ action: "variables", reference: 10 }), {
        code: "DEBUG_INSPECTION_STALE"
    });
    await assert.rejects(inspection.inspect({ action: "scopes", frame: reference }), {
        code: "DEBUG_INSPECTION_STALE"
    });
    threadId = 8;
    await assert.rejects(inspection.inspect({ action: "stack", threadId: 7 }), { code: "DEBUG_TASK_EXITED" });
    threadId = 7;
    bridge.handleRequest(session, { type: "request", command: "writeMemory" });
    await assert.rejects(inspection.inspect({ action: "variables", reference }), { code: "DEBUG_INSPECTION_STALE" });
    bridge.handleMessage(session, { type: "event", event: "invalidated", body: { areas: ["variables"] } });
    assert.strictEqual(bridge.inspectionEpoch, 2);
    bridge.writing = true;
    await assert.rejects(inspection.inspect({ action: "threads" }), { code: "DEBUG_CONTROL_BUSY" });
    bridge.writing = false;
    bridge.transitionKind = "step";
    await assert.rejects(inspection.inspect({ action: "threads" }), { code: "DEBUG_STATE_TRANSITION" });
    bridge.transitionKind = "";
    hook = async () => {
        bridge.stopEpoch++;
    };
    await assert.rejects(inspection.inspect({ action: "threads" }), { code: "DEBUG_INSPECTION_STALE" });
    hook = async () => {
        throw Object.assign(new Error("GDB failure"), { code: "GDB_TEST_FAILURE" });
    };
    await assert.rejects(inspection.inspect({ action: "threads" }), { code: "GDB_TEST_FAILURE" });
    hook = null;
    bridge.paused = false;
    await assert.rejects(inspection.inspect({ action: "threads" }), { code: "TARGET_NOT_PAUSED" });
    bridge.paused = true;
    session.type = "cortex-debug";
    await assert.rejects(inspection.inspect({ action: "threads" }), { code: "DEBUG_INSPECTION_UNSUPPORTED" });
    session.type = "emberprobe";
    const replacement = { ...session, id: "core-1" };
    const oldStack = await inspection.inspect({ action: "stack", threadId: 7 });
    bridge.sessions.clear();
    bridge.sessions.set(replacement.id, replacement);
    await assert.rejects(inspection.inspect({ action: "scopes", frame: oldStack.stackFrames[0].frame }), {
        code: "DEBUG_INSPECTION_STALE"
    });
    bridge.sessions.set(session.id, session);
    await assert.rejects(inspection.inspect({ action: "threads" }), { code: "DEBUG_SESSION_CONFLICT" });
    bridge.sessions.delete(replacement.id);
    const routes = createAgentRoutes({ _debugBridge: bridge, _rtosViewService: new RtosViewService(bridge) });
    assert.throws(() => routes["rtos.snapshot"]({ includeStackUsage: "false" }), { code: "DEBUG_INSPECTION_INVALID" });
    assert.strictEqual((await routes["rtos.snapshot"]({ includeStackUsage: false })).partial, true);
    assert.strictEqual(calls.at(-1).params.includeStackUsage, false);

    for (const argv of [
        [],
        ["--threads", "--stack"],
        ["--stack"],
        ["--scopes"],
        ["--variables"],
        ["--threads", "--thread", "7"],
        ["--stack", "--thread", "-1"],
        ["--variables", "--reference", "x", "--count", "101"],
        ["--variables", "--reference", "x", "--filter", "all"],
        ["--status", "--no-stack-usage"],
        ["--snapshot", "--workspace"],
        ["--evaluate", "reset()"]
    ])
        assert.throws(() => cli.args(argv, true));

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-inspection-"));
    const agent = new AgentService({ handlers: routes });
    const server = new AgentBridge(workspace, (method, params) => agent.call(method, params));
    const exec = promisify(execFile);
    const run = async (script, argv) =>
        JSON.parse(
            (
                await exec(process.execPath, [
                    path.resolve(__dirname, "..", "skills", script),
                    "--workspace",
                    workspace,
                    ...argv
                ])
            ).stdout
        );
    try {
        await server.start();
        const result = await run("mcu-debug-control/scripts/inspect.js", ["--stack", "--thread", "7"]);
        const scopeResult = await run("mcu-debug-control/scripts/inspect.js", [
            "--scopes",
            "--frame",
            result.stackFrames[0].frame
        ]);
        const object = await run("mcu-rtos/scripts/rtos.js", [
            "--variables",
            "--reference",
            scopeResult.scopes[0].reference
        ]);
        assert.strictEqual(object.variables[0].type, "std::vector<int>");
        const snapshot = await run("mcu-rtos/scripts/rtos.js", ["--snapshot", "--no-stack-usage"]);
        assert.strictEqual(snapshot.tasks[0].threadId, undefined, "TCB is never converted into a thread ID");
        assert.deepStrictEqual(snapshot.diagnostics, ["stack bounds unavailable"]);
        assert.strictEqual((await run("mcu-rtos/scripts/rtos.js", ["--status"])).supported, true);
        bridge.paused = false;
        await assert.rejects(run("mcu-rtos/scripts/rtos.js", ["--snapshot"]), (error) => {
            assert.strictEqual(JSON.parse(error.stderr).error.code, "TARGET_NOT_PAUSED");
            return true;
        });
    } finally {
        await server.stop();
        bridge.dispose();
        fs.rmSync(workspace, { recursive: true, force: true });
    }
    console.log("Agent C++/RTOS inspection, pagination, stale contexts and CLI bridge tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
