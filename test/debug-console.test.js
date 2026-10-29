"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { EmberDebugSession } = require("../src/debug/session");
const { MiClient, quote } = require("../src/debug/mi");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { AgentDebugInspection } = require("../src/services/agentDebugInspection");
const { RtosViewService } = require("../src/services/rtosViewService");
const { scenario } = require("./helpers/scenario");

const tick = () => new Promise((resolve) => setImmediate(resolve));
class Mi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.breaks = [];
    }
    async command(command) {
        this.commands.push(command);
        if (command.startsWith("-interpreter-exec console")) {
            this.emit("output", "CLI output\n");
            await this.console?.(JSON.parse(command.slice(command.indexOf('"'))));
        }
        if (command === "-thread-info") return { threads: [{ id: "2" }], "current-thread-id": "2" };
        if (command === "-stack-info-frame") return { frame: { level: "1" } };
        if (command === "-break-list") return { BreakpointTable: { body: this.breaks.map((bkpt) => ({ bkpt })) } };
        if (command.startsWith("-break-insert")) {
            const bkpt = { number: "7", addr: "0x08000000", line: "12", enabled: "y" };
            this.breaks.push(bkpt);
            return { bkpt };
        }
        if (command.startsWith("-var-create")) return { name: "v1", type: "int", numchild: "0", value: "3" };
        return {};
    }
    async stop() {}
}
function setup() {
    const mi = new Mi();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    adapter.ready = true;
    adapter.config = { cwd: process.cwd(), executable: __filename };
    adapter.threads.add(1);
    adapter.clientCapabilities.supportsInvalidatedEvent = true;
    const events = [];
    const responses = [];
    adapter.sendEvent = (event) => events.push(event);
    adapter.sendResponse = (response) => responses.push(response);
    adapter.sendErrorResponse = (response, error) => responses.push({ ...response, success: false, error });
    return { mi, adapter, events, responses };
}
const repl = (adapter, expression, args = {}) => adapter.evaluate({ expression, context: "repl", ...args });
function bridgeSetup(type = "emberprobe", options = {}) {
    const states = [];
    const bridge = new DebugSessionBridge({ ...options, onTargetState: (event) => states.push(event) });
    const session = { id: "one", type, configuration: {}, customRequest: async () => ({}) };
    bridge.attach(session);
    bridge.handleMessage(session, {
        type: "response",
        command: "initialize",
        body: { supportsReadMemoryRequest: true, supportsWriteMemoryRequest: true }
    });
    bridge.handleMessage(session, { type: "event", event: "stopped", body: { threadId: 1 } });
    const request = (seq, target = session) =>
        bridge.handleRequest(target, {
            type: "request",
            command: "evaluate",
            seq,
            arguments: { context: "repl", expression: "bt" }
        });
    const response = (seq, success = true, target = session) =>
        bridge.handleMessage(target, {
            type: "response",
            command: "evaluate",
            request_seq: seq,
            success
        });
    return { bridge, session, states, request, response };
}

(async () => {
    await scenario("CLI forwarding, single output and input validation", async () => {
        const { mi, adapter, events } = setup();
        for (const command of [
            "bt",
            "info registers",
            "p counter",
            "x/16wx 0x20000000",
            'printf "中文 \\\\"',
            "x".repeat(16384)
        ]) {
            assert.deepStrictEqual(await repl(adapter, command), { result: "", variablesReference: 0 });
            assert(mi.commands.includes(`-interpreter-exec console ${quote(command)}`));
        }
        assert.strictEqual(events.filter((event) => event.event === "output").length, 6);
        assert(!mi.commands.some((command) => command.startsWith("-var-create")));
        for (const command of [undefined, null, 1, "", "   ", "bt\ncontinue", "bt\r", "p a\0b", "x".repeat(16385)]) {
            const before = mi.commands.length;
            await assert.rejects(repl(adapter, command), /single.line|16384|nonempty/);
            assert.strictEqual(mi.commands.length, before);
        }
        adapter.end();
    });
    await scenario("REPL invalidates handles and defers varobj deletion", async () => {
        const { mi, adapter, events } = setup();
        const frameId = adapter.handleFor({ kind: "frame", thread: 1, level: 0 });
        adapter.varObjects.add("old");
        adapter.hoverEvaluations.set("old", {});
        const generation = adapter.variableStore.snapshot();
        mi.console = () => {
            assert.strictEqual(adapter.handles.size, 0);
            assert.strictEqual(adapter.hoverEvaluations.size, 0);
            assert(adapter.pendingVarCleanup.includes("old"));
            assert(!mi.commands.includes('-var-delete "old"'));
        };
        await repl(adapter, "frame 1", { frameId });
        assert.deepStrictEqual(mi.commands.slice(0, 3), [
            "-thread-select 1",
            "-stack-select-frame 0",
            '-interpreter-exec console "frame 1"'
        ]);
        assert.throws(() => adapter.reference(frameId), /Stale/);
        assert.throws(() => adapter.variableStore.check(generation), /changed|Stale|stale/);
        assert(events.some((event) => event.event === "invalidated"));
        await tick();
        adapter.end();
    });
    await scenario("running commands and fast stops preserve GDB state", async () => {
        const { mi, adapter, events, responses } = setup();
        adapter.running = true;
        await repl(adapter, "info breakpoints");
        assert(adapter.running);
        assert(!mi.commands.includes("-exec-interrupt --all"));
        adapter.running = false;
        mi.console = () => {
            assert(!adapter.running, "query submission never pretends to resume");
            mi.emit("record", { kind: "*", class: "running", data: {} });
            mi.emit("record", {
                kind: "*",
                class: "stopped",
                data: { "thread-id": "2", reason: "end-stepping-range" }
            });
        };
        adapter.dispatchRequest({ seq: 1, command: "evaluate", arguments: { context: "repl", expression: "next" } });
        await adapter.queue;
        assert(!adapter.running);
        assert(responses[0].success);
        assert.deepStrictEqual(
            events.filter((event) => ["continued", "stopped"].includes(event.event)).map((event) => event.event),
            ["continued", "stopped"]
        );
        mi.console = () => {
            throw new Error("Undefined command");
        };
        await assert.rejects(repl(adapter, "unknown"), /Undefined command/);
        assert(!adapter.ended);
        mi.console = () => mi.emit("record", { kind: "*", class: "stopped", data: { reason: "exited-normally" } });
        await repl(adapter, "quit");
        assert(adapter.ended);
    });
    await scenario("GDB log errors appear once and ordinary warnings are retained", async () => {
        const { adapter, mi, events, responses } = setup();
        mi.console = () => {
            mi.emit("output", "A GDB warning\n", "&");
        };
        await repl(adapter, "bt");
        assert(events.some((event) => event.body?.output === "A GDB warning\n"));
        events.length = 0;
        mi.console = () => {
            mi.emit("output", "Earlier warning\n", "&");
            mi.emit("output", "Undefined command\n", "&");
            throw new Error("Undefined command");
        };
        adapter.dispatchRequest({ seq: 1, command: "evaluate", arguments: { context: "repl", expression: "unknown" } });
        await adapter.queue;
        assert.strictEqual(responses[0].error.format, "Undefined command");
        assert(events.some((event) => event.body?.output === "Earlier warning\n"));
        assert(
            !events.some((event) => event.body?.output?.includes("Undefined command")),
            "the DAP error already displays this diagnostic"
        );
        events.length = 0;
        mi.console = () => {
            mi.emit("output", "w".repeat(65537), "&");
            assert(adapter.consoleLogs.length <= 65536);
        };
        await repl(adapter, "bt");
        assert.strictEqual(
            events
                .filter((event) => event.event === "output")
                .map((event) => event.body.output)
                .join(""),
            "CLI output\n" + "w".repeat(65537)
        );
        adapter.end();
    });
    await scenario("Watch and hover still use expressions; CLI context is retained", async () => {
        const { mi, adapter } = setup();
        adapter.rtosAware = true;
        await repl(adapter, "thread 2");
        mi.commands.length = 0;
        assert.strictEqual((await adapter.evaluate({ expression: "counter", context: "watch" })).result, "3");
        assert(!mi.commands.some((command) => command.startsWith("-thread-select")));
        const node = adapter.variableStore.nodes.get("v1");
        assert.strictEqual(node.frame.thread, 2);
        assert.strictEqual(node.frame.level, 1);
        assert.strictEqual((await adapter.evaluate({ expression: "counter", context: "hover" })).result, "3");
        adapter.running = true;
        await assert.rejects(adapter.evaluate({ expression: "counter", context: "watch" }), /paused/);
        adapter.end();
    });
    await scenario("mapped breakpoint changes, deletes and list reconciliation", async () => {
        const { mi, adapter, events } = setup();
        const args = { source: { path: __filename }, breakpoints: [{ line: 12 }] };
        const original = (await adapter.setBreakpoints(args)).breakpoints[0];
        mi.emit("record", {
            kind: "=",
            class: "breakpoint-modified",
            data: { bkpt: { number: "7", addr: "0x08000004", line: "14", enabled: "n" } }
        });
        const changed = events.filter((event) => event.event === "breakpoint").at(-1);
        assert.strictEqual(changed.body.breakpoint.id, original.id);
        assert.strictEqual(changed.body.breakpoint.line, 14);
        assert.strictEqual(changed.body.breakpoint.instructionReference, "0x08000004");
        assert.match(changed.body.breakpoint.message, /disabled.*info breakpoints/i);
        mi.emit("record", {
            kind: "=",
            class: "breakpoint-created",
            data: { bkpt: { number: "99", addr: "0x08000010" } }
        });
        assert.strictEqual(adapter.breakpoints.get(__filename).size, 1);
        mi.breaks = [];
        await repl(adapter, "delete 7");
        assert.strictEqual(adapter.breakpoints.get(__filename).size, 0);
        assert(events.some((event) => event.event === "breakpoint" && event.body.reason === "removed"));
        await adapter.setBreakpoints(args);
        mi.emit("record", { kind: "=", class: "breakpoint-deleted", data: { id: "7" } });
        await adapter.setBreakpoints({ ...args, breakpoints: [] });
        assert(!mi.commands.includes("-break-delete 7"), "deleted GDB ids are never reused");
        adapter.end();
    });
    await scenario("Bridge request identity, busy gates and real stop state", async () => {
        const { bridge, session, request, response, states } = bridgeSetup();
        bridge.setIntent(true);
        bridge.snapshotReady = true;
        const epoch = bridge.stopEpoch;
        const inspection = bridge.inspectionEpoch;
        request(10);
        request(11);
        assert(bridge.replBusy);
        assert(bridge.paused);
        assert(bridge.stopEpoch > epoch);
        assert(bridge.inspectionEpoch > inspection);
        assert(!bridge.canRead && !bridge.canWritePaused);
        assert.throws(() => bridge.assertPausedAccess(), /console|progress/i);
        assert.throws(() => bridge.selectSession({ sessionId: session.id }), { code: "DEBUG_CONTROL_BUSY" });
        await assert.rejects(bridge.control("continue"), { code: "DEBUG_CONTROL_BUSY" });
        await assert.rejects(bridge.writeAndVerify([]), { code: "DEBUG_CONTROL_BUSY" });
        assert.throws(() => new AgentDebugInspection(bridge).context(), /console|finish/i);
        await assert.rejects(new RtosViewService(bridge).refresh(), /console|refresh/i);
        response(999);
        response(10, false);
        assert(bridge.replBusy);
        bridge.handleMessage(session, { type: "event", event: "continued" });
        bridge.handleMessage(session, { type: "event", event: "stopped", body: { threadId: 2 } });
        assert(bridge.replBusy && !bridge.canRead);
        response(11);
        assert(!bridge.replBusy && bridge.paused && bridge.canRead);
        assert(bridge.snapshotPending);
        assert(states.some((event) => event.transition === "repl"));
        request(12);
        bridge.handleMessage(session, { type: "event", event: "terminated" });
        assert(!bridge.replBusy);
        response(12);
        assert(!bridge.paused);
        bridge.dispose();
    });
    await scenario("background cores and non-native sessions retain isolated behavior", async () => {
        const { bridge, session, request, response } = bridgeSetup();
        const other = { ...session, id: "other" };
        bridge.attach(other);
        bridge.selectSession({ sessionId: session.id });
        const epoch = bridge.stopEpoch;
        request(1, other);
        assert(!bridge.replBusy);
        assert.strictEqual(bridge.stopEpoch, epoch);
        bridge.selectSession({ sessionId: other.id });
        assert(bridge.replBusy, "selecting a busy background session restores its busy state");
        response(1, false, other);
        assert(!bridge.replBusy);
        bridge.dispose();
        const foreign = bridgeSetup("cppdbg");
        foreign.request(1);
        assert(!foreign.bridge.replBusy);
        foreign.bridge.dispose();
    });
    await scenario("running breakpoint reconciliation waits for the next stop", async () => {
        const { adapter, mi } = setup();
        await adapter.setBreakpoints({ source: { path: __filename }, breakpoints: [{ line: 12 }] });
        adapter.running = true;
        mi.breaks = [];
        await repl(adapter, "delete 7");
        assert(!mi.commands.includes("-break-list"));
        assert.strictEqual(adapter.breakpoints.get(__filename).size, 1);
        mi.emit("record", { kind: "*", class: "stopped", data: { "thread-id": "1" } });
        await tick();
        await adapter.queue;
        assert(mi.commands.includes("-break-list"));
        assert.strictEqual(adapter.breakpoints.get(__filename).size, 0);
        adapter.end();
    });
    await scenario("queued REPL commands serialize and Stop bypasses an outstanding command", async () => {
        const { adapter, mi, responses } = setup();
        let release;
        mi.console = () =>
            new Promise((resolve) => {
                release = resolve;
            });
        const args = { context: "repl", expression: "bt" };
        adapter.dispatchRequest({ seq: 1, command: "evaluate", arguments: args });
        adapter.dispatchRequest({ seq: 2, command: "evaluate", arguments: args });
        await tick();
        assert.strictEqual(mi.commands.filter((command) => command.startsWith("-interpreter-exec")).length, 1);
        adapter.dispatchRequest({ seq: 3, command: "disconnect" });
        await tick();
        assert(adapter.ended);
        assert(responses.some((response) => response.request_seq === 3 && response.success));
        release();
        await adapter.queue;
        assert.strictEqual(responses.length, 3);
        assert.strictEqual(mi.commands.filter((command) => command.startsWith("-interpreter-exec")).length, 1);
    });
    await scenario("MI timeout, closure and GDB exit release all pending REPL requests", async () => {
        for (const failure of ["timeout", "transport closed", "GDB exited"]) {
            const mi = new MiClient({ timeoutMs: 15 });
            // A stalled in-memory transport exercises the actual MiClient timeout/fail cleanup.
            mi.process = { stdin: { write() {} }, exitCode: 0 };
            const adapter = new EmberDebugSession({ mi });
            adapter.setRunAsServer(true);
            adapter.ready = true;
            const { bridge, session, request } = bridgeSetup();
            const responses = [];
            adapter.sendEvent = (event) => bridge.handleMessage(session, event);
            adapter.sendResponse = (response) => {
                responses.push(response);
                bridge.handleMessage(session, response);
            };
            adapter.sendErrorResponse = (response) => adapter.sendResponse({ ...response, success: false });
            for (const seq of [1, 2]) {
                request(seq);
                adapter.dispatchRequest({ seq, command: "evaluate", arguments: { context: "repl", expression: "bt" } });
            }
            await tick();
            if (failure !== "timeout") mi.fail(new Error(failure));
            await adapter.queue;
            assert(adapter.ended && mi.closed);
            assert.strictEqual(mi.pending.size, 0);
            assert.strictEqual(responses.length, 2);
            assert(responses.every((response) => response.success === false));
            assert(!bridge.replBusy && !bridge.paused);
            bridge.dispose();
        }
    });
    await scenario("sidebar, RTOS and Agent read fresh data after a console write", async () => {
        const samples = [];
        const { bridge, session, request, response } = bridgeSetup("emberprobe", {
            getReadPlan: () => [{ name: "counter", address: 0x20000000, size: 4 }],
            onSamples: (value) => samples.push(value)
        });
        let counter = 3;
        let taskReads = 0;
        session.customRequest = async (command) => {
            if (command === "readMemory") {
                const bytes = Buffer.alloc(4);
                bytes.writeUInt32LE(counter);
                return { data: bytes.toString("base64") };
            }
            if (command === "emberprobe.rtosSnapshot") {
                taskReads++;
                return { tasks: [{ name: String(counter) }] };
            }
            if (command === "threads") return { threads: [{ id: 1 }] };
            if (command === "stackTrace") return { stackFrames: [{ id: 1, name: "main" }] };
            return {};
        };
        bridge.setIntent(true);
        await bridge._poll();
        assert.strictEqual(samples.length, 1);
        const rtos = new RtosViewService(bridge);
        assert.strictEqual((await rtos.refresh()).tasks[0].name, "3");
        const agent = new AgentDebugInspection(bridge);
        const frame = (await agent.inspect({ action: "stack", threadId: 1 })).stackFrames[0].frame;
        request(1);
        counter = 5;
        await bridge._poll();
        assert.strictEqual(samples.length, 1, "background sampling is suspended during REPL");
        response(1);
        await bridge._poll();
        assert.strictEqual(Buffer.from(samples[1][0].bytes).readUInt32LE(), 5);
        assert.strictEqual((await rtos.refresh()).tasks[0].name, "5");
        assert.strictEqual(taskReads, 2);
        await assert.rejects(agent.inspect({ action: "scopes", frame }), { code: "DEBUG_INSPECTION_STALE" });
        request(2);
        bridge.detach(session);
        assert(!bridge.replBusy);
        bridge.dispose();
    });
    console.log("Native GDB console regressions passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
