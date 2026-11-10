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
    // DAP integers are not handles: a numeric reference is malformed rather than expired.
    for (const params of [
        { action: "variables", reference: 10 },
        { action: "scopes", frame: 0 },
        { action: "scopes", frame: "" }
    ])
        await assert.rejects(inspection.inspect(params), { code: "DEBUG_INSPECTION_INVALID" });
    await assert.rejects(inspection.inspect({ action: "variables", reference: "unknown-handle" }), {
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
    session.type = "cppdbg";
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
    {
        // Evaluate and raw memory reads share the paused-context checks and the handle table.
        const requests = [];
        const memory = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const target = {
            id: "core-1",
            type: "emberprobe",
            async customRequest(command, params) {
                requests.push({ command, params });
                if (command === "stackTrace") return { stackFrames: [{ id: 3, name: "main" }] };
                if (command === "threads") return { threads: [{ id: 1 }] };
                if (command === "evaluate")
                    return { result: "{x = 1}", type: "struct pos", variablesReference: 30, memoryReference: "0x2000" };
                if (command === "readMemory")
                    return {
                        address: params.memoryReference,
                        data: memory.subarray(0, params.count).toString("base64")
                    };
                throw new Error(`Unexpected DAP command ${command}`);
            }
        };
        const evaluationBridge = new DebugSessionBridge({ trackSessions: false });
        evaluationBridge.sessions.set(target.id, target);
        evaluationBridge.paused = true;
        evaluationBridge.stopEpoch = 4;
        const evaluation = new AgentDebugInspection(evaluationBridge);
        const value = await evaluation.evaluate({ expression: " sensor.pos " });
        assert.deepStrictEqual(requests.at(-1), {
            command: "evaluate",
            params: { expression: "sensor.pos", context: "hover" }
        });
        assert.strictEqual(value.result, "{x = 1}");
        assert.strictEqual(value.variablesReference, undefined, "DAP integers never reach the Agent");
        assert.match(value.reference, /^[0-9a-f-]{36}$/);
        assert.strictEqual(value.sessionId, "core-1");
        const frame = (await evaluation.inspect({ action: "stack", threadId: 1 })).stackFrames[0].frame;
        await evaluation.evaluate({ expression: "buf[2]", frame });
        assert.strictEqual(requests.at(-1).params.frameId, 3);
        const sent = requests.length;
        for (const expression of ["x = 1", "count++", "--count", "reset()", "f (1)"])
            await assert.rejects(
                evaluation.evaluate({ expression }),
                { code: "DEBUG_EXPRESSION_REJECTED" },
                expression
            );
        for (const expression of ["", "   ", 7, "x".repeat(1025)])
            await assert.rejects(evaluation.evaluate({ expression }), { code: "DEBUG_INSPECTION_INVALID" });
        assert.strictEqual(requests.length, sent, "rejected expressions never reach the debugger");

        const bytes = await evaluation.readMemory({ address: "0x20000000", length: 4 });
        assert.deepStrictEqual(requests.at(-1), {
            command: "readMemory",
            params: { memoryReference: "0x20000000", count: 4 }
        });
        assert.deepStrictEqual(
            { address: bytes.address, length: bytes.length, hex: bytes.hex, unreadableBytes: bytes.unreadableBytes },
            { address: "0x20000000", length: 4, hex: "deadbeef", unreadableBytes: 0 }
        );
        assert.strictEqual((await evaluation.readMemory({ address: 0x3ffffff8, length: 8 })).unreadableBytes, 4);
        assert.strictEqual((await evaluation.readMemory({ address: 0 })).length, 64, "default length");
        const before = requests.length;
        for (const [address, length] of [
            ["0x40020014", 4],
            [0x3ffffffd, 4],
            ["0xE000ED28", 4],
            ["0x60000000", 1]
        ])
            await assert.rejects(evaluation.readMemory({ address, length }), (error) => {
                assert.strictEqual(error.code, "MEMORY_REGION_NOT_ALLOWED");
                assert.strictEqual(error.details.limit, "0x3FFFFFFF");
                return true;
            });
        for (const params of [
            { address: "20000000" },
            { address: "0x123456789" },
            { address: -1 },
            { address: 1.5 },
            { address: "0x20000000", length: 0 },
            { address: "0x20000000", length: 4097 }
        ])
            await assert.rejects(evaluation.readMemory(params), { code: "DEBUG_INSPECTION_INVALID" });
        assert.strictEqual(requests.length, before, "refused reads never reach the debugger");
        evaluationBridge.paused = false;
        await assert.rejects(evaluation.readMemory({ address: "0x20000000" }), { code: "TARGET_NOT_PAUSED" });
        await assert.rejects(evaluation.evaluate({ expression: "x" }), { code: "TARGET_NOT_PAUSED" });
        evaluationBridge.dispose();
    }
    console.log("Agent C++/RTOS inspection, pagination, stale contexts and CLI bridge tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
