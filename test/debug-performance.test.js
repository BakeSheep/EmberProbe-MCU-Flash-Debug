"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { EmberDebugSession } = require("../src/debug/session");
const { DebugControlService } = require("../src/services/debugControlService");
const { SvdPeripheralService, parseSvd } = require("../src/services/svdPeripheralService");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
class Mi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.id = 0;
    }
    async command(command) {
        this.commands.push(command);
        if (this.block?.command === command) await this.block.promise;
        if (command === "-exec-interrupt --all")
            this.emit("record", { kind: "*", class: "stopped", data: { "thread-id": "1" } });
        if (/^-exec-(continue|next|step|finish)/.test(command))
            this.emit("record", { kind: "*", class: "running", data: {} });
        if (command === "-thread-info") return { threads: [{ id: "1" }] };
        if (command === "-stack-list-variables --simple-values")
            return { variables: Array.from({ length: 100 }, (_, i) => ({ name: "x" + i, value: "1" })) };
        if (command.startsWith("-var-create"))
            return { name: "obj" + ++this.id, type: "int", numchild: "0", value: "1" };
        if (command.startsWith("-var-evaluate-expression")) return { value: "2" };
        if (command.startsWith("-data-evaluate-expression")) return { value: "536870912" };
        if (command.startsWith("-break-insert")) return { bkpt: { number: "1", addr: "0x8000000", line: "12" } };
        return {};
    }
}
function setup() {
    const mi = new Mi();
    const session = new EmberDebugSession({ mi });
    session.setRunAsServer(true);
    session.ready = true;
    session.threads.add(1);
    session.responses = [];
    session.events = [];
    session.sendEvent = (event) => session.events.push(event);
    session.sendResponse = (response) => session.responses.push(response);
    session.sendErrorResponse = (response, error) => session.responses.push({ ...response, success: false, error });
    return { mi, session };
}

(async () => {
    {
        let pending = 0,
            peak = 0;
        const service = new DebugControlService({
            vscode: { debug: { breakpoints: Array.from({ length: 20 }, (_, i) => ({ functionName: "f" + i })) } },
            debugBridge: {
                activeSession: {
                    async getDebugProtocolBreakpoint(breakpoint) {
                        peak = Math.max(peak, ++pending);
                        await tick();
                        pending--;
                        if (breakpoint.functionName === "f3") throw new Error("unavailable");
                        return { verified: true };
                    }
                }
            }
        });
        service.status = () => ({});
        const result = await service.listBreakpoints();
        assert.strictEqual(peak, 8);
        assert.strictEqual(result.breakpoints[3].verified, null);
        assert.strictEqual(result.breakpoints[19].function, "f19", "concurrency retains output order");
    }
    {
        const { mi, session } = setup();
        session.dispatchRequest({ seq: 1, command: "continue", arguments: { threadId: 1 } });
        session.dispatchRequest({ seq: 2, command: "pause" });
        await session.queue;
        assert.deepStrictEqual(
            mi.commands,
            ["-exec-continue", "-exec-interrupt --all"],
            "a pause received before a queued continue starts must still stop that continue"
        );
        session.end();
    }
    {
        const { mi, session } = setup();
        const gate = deferred();
        mi.block = { command: "-thread-info", ...gate };
        session.running = true;
        session.dispatchRequest({ seq: 1, command: "threads" });
        await tick();
        session.dispatchRequest({ seq: 2, command: "pause" });
        assert(mi.commands.includes("-exec-interrupt --all"), "pause bypasses an unresolved read");
        gate.resolve();
        await session.queue;
        assert.strictEqual(session.responses.length, 2);
        session.end();
    }
    {
        const { mi, session } = setup();
        const gate = deferred();
        mi.block = { command: "-stack-list-variables --simple-values", ...gate };
        const frameId = session.handleFor({ kind: "frame", thread: 1, level: 0 });
        const scope = (await session.handle("scopes", { frameId })).scopes[0].variablesReference;
        session.dispatchRequest({ seq: 1, command: "variables", arguments: { variablesReference: scope } });
        await tick();
        session.dispatchRequest({ seq: 2, command: "threads" });
        session.dispatchRequest({ seq: 3, command: "next", arguments: { threadId: 1 } });
        gate.resolve();
        await session.queue;
        assert(mi.commands.includes("-exec-next"));
        assert(!mi.commands.includes("-thread-info"), "queued obsolete read is dropped");
        assert(!mi.commands.some((c) => c.startsWith("-var-create")), "cancel at the next MI boundary");
        assert.strictEqual(session.responses.find((r) => r.request_seq === 3).success, true);
        assert.strictEqual(session.responses.filter((r) => !r.success).length, 2);
        session.end();
    }
    {
        const { mi, session } = setup();
        const gate = deferred();
        mi.block = { command: "-data-write-memory-bytes 0x20000000 01", ...gate };
        session.dispatchRequest({
            seq: 1,
            command: "writeMemory",
            arguments: {
                memoryReference: "0x20000000",
                data: "AQ=="
            }
        });
        await tick();
        session.dispatchRequest({ seq: 2, command: "next", arguments: { threadId: 1 } });
        assert(!mi.commands.includes("-exec-next"), "control cannot interrupt a write");
        gate.resolve();
        await session.queue;
        assert(session.responses.every((r) => r.success));
        session.end();
    }
    for (const operation of ["continue", "next", "stepIn", "stepOut"]) {
        const { mi, session } = setup();
        for (let i = 0; i < 100; i++) session.varObjects.add("old" + i);
        await session.handle(operation, { threadId: 1 });
        await tick();
        assert.strictEqual(mi.commands.length, 1, "control does not wait for 100 deletions");
        assert.strictEqual(session.handles.size, 0);
        const gate = deferred();
        mi.block = { command: '-var-delete "old0"', ...gate };
        mi.emit("record", { kind: "*", class: "stopped", data: { "thread-id": "1" } });
        await tick();
        assert(mi.commands.includes('-var-delete "old0"'));
        await session.handle("continue", { threadId: 1 });
        gate.resolve();
        await tick();
        await tick();
        assert(!mi.commands.includes('-var-delete "old1"'), "cleanup yields when target resumes");
        session.end();
    }
    {
        const { mi, session } = setup();
        const frameId = session.handleFor({ kind: "frame", thread: 1, level: 0 });
        const scopes = await session.handle("scopes", { frameId });
        const variables = await session.handle("variables", {
            variablesReference: scopes.scopes[0].variablesReference
        });
        assert.strictEqual(variables.variables.length, 100);
        assert.strictEqual(mi.commands.length, 203, "one frame bind, one list and two commands per scalar");
        mi.commands.length = 0;
        for (let i = 0; i < 20; i++)
            await session.handle("evaluate", { frameId, expression: "counter", context: "hover" });
        assert.strictEqual(mi.commands.filter((c) => c.startsWith("-var-create")).length, 1);
        assert.strictEqual(mi.commands.filter((c) => c.startsWith("-var-evaluate-expression")).length, 19);
        session.invalidateVariables();
        await session.handle("evaluate", { frameId, expression: "counter", context: "hover" });
        assert.strictEqual(mi.commands.filter((c) => c.startsWith("-var-create")).length, 2);
        const other = session.variableStore.root({ name: "other", type: "int" }, { thread: 2, level: 1 });
        await session.variableStore.stl.bindFrame(other, session.variableStore.stl.context(other.frame));
        assert.strictEqual(session.selectedFrame.thread, 2);
        mi.commands.length = 0;
        await session.selectFrame(frameId);
        assert.deepStrictEqual(
            mi.commands,
            ["-thread-select 1", "-stack-select-frame 0"],
            "returning from an STL owner in another frame must rebind"
        );
        session.end();
    }
    {
        const { mi, session } = setup();
        const args = { source: { path: "main.c" }, breakpoints: [{ line: 12 }] };
        const first = await session.handle("setBreakpoints", args);
        session.running = true;
        mi.commands.length = 0;
        assert.deepStrictEqual(await session.handle("setBreakpoints", args), first);
        assert.deepStrictEqual(mi.commands, []);
        session.config.performanceTrace = true;
        session.dispatchRequest({ seq: 1, command: "threads" });
        await session.queue;
        assert(session.events.some((e) => e.body?.output?.includes('"miCommands":1')));
        session.end();
    }
    {
        const registers = Array.from(
            { length: 64 },
            (_, i) => `<register><name>R${i}</name><addressOffset>${i * 4}</addressOffset></register>`
        ).join("");
        const model = parseSvd(`<device><name>T</name><size>32</size><access>read-only</access>
            <peripherals><peripheral><name>P</name><baseAddress>0x40000000</baseAddress>
            <registers>${registers}</registers></peripheral></peripherals></device>`);
        const reads = [];
        const bridge = {
            assertPausedAccess() {},
            agentStatus: () => ({ epoch: 1 }),
            async readPausedMemory(address, size) {
                reads.push({ address, size });
                if (this.fail && (size > 4 || address === 0x40000004)) throw new Error("unreadable");
                return Buffer.alloc(size);
            }
        };
        const service = new SvdPeripheralService({ debugBridge: bridge });
        service.model = async () => model;
        const targets = Array.from({ length: 64 }, (_, i) => "P.R" + i);
        const result = await service.readForView(targets);
        assert.strictEqual(result.registers.length, 64);
        assert.deepStrictEqual(reads, [{ address: 0x40000000, size: 256 }]);
        bridge.fail = true;
        const partial = await service.readForView(targets.slice(0, 3));
        assert.strictEqual(partial.registers[0].value, "0x00000000");
        assert.strictEqual(partial.registers[1].error, "unreadable");
        assert.strictEqual(partial.registers[2].value, "0x00000000");
    }
    console.log(
        "Debug performance: interrupt priority, cancellable reads, write ordering, bounded cleanup, frame/hover reuse and MMIO batching passed"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
