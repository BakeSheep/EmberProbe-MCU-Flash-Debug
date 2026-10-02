"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { EmberDebugSession } = require("../src/debug/session");
const { debugSymbols, nmSymbols } = require("../src/debug/symbolDirectory");

class ContextMi extends EventEmitter {
    constructor() {
        super();
        this.thread = 2;
        this.frame = 1;
    }
    async command(command) {
        if (command.startsWith("-thread-select ")) this.thread = Number(command.split(" ")[1]);
        if (command.startsWith("-stack-select-frame ")) this.frame = Number(command.split(" ")[1]);
        if (command.startsWith("-data-evaluate-expression"))
            return { value: String(0x20000000 + this.thread * 256 + this.frame * 16) };
        if (command.startsWith("-data-write-memory-bytes") && this.failWrite) throw new Error("Write failed");
        if (command.startsWith("-thread-select") && this.resume)
            this.emit("record", { kind: "*", class: "running", data: {} });
        return {};
    }
}

(async () => {
    const catalog = debugSymbols({ symbols: { debug: { fullname: "main.cpp", symbols: { name: "counter" } } } });
    assert.strictEqual(catalog[0].expression, "::counter");
    assert.strictEqual(nmSymbols("20000000 00000004 B counter")[0].expression, "::counter");

    const mi = new ContextMi();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    adapter.ready = true;
    adapter.rtosAware = true;
    adapter.threads = new Set([1, 2]);
    const events = [];
    adapter.sendEvent = (event) => events.push(event);
    await adapter.handle("initialize", { supportsInvalidatedEvent: true });
    const node = adapter.variableStore.root({ name: "v1", type: "int", numchild: "0" }, { thread: 1, level: 0 });
    node.expression = "p.x";
    await adapter.variableStore.metadata(node);
    assert.strictEqual(node.memoryReference, "0x20000100", "address must use the owning thread and frame");

    const frameId = adapter.handleFor({ kind: "frame", thread: 1, level: 0 });
    const request = { memoryReference: "0x20000000", data: "AQAAAA==" };
    mi.failWrite = true;
    await assert.rejects(adapter.handle("writeMemory", request), /Write failed/);
    assert(adapter.handles.has(frameId));
    assert(!events.some((event) => event.event === "invalidated"));
    mi.failWrite = false;
    await adapter.handle("writeMemory", { ...request, data: "" });
    assert(adapter.handles.has(frameId), "empty writes preserve references");
    await adapter.handle("writeMemory", request);
    assert(!adapter.handles.has(frameId));
    assert.deepStrictEqual(events.find((event) => event.event === "invalidated").body.areas, ["stacks", "variables"]);
    const refreshed = adapter.handleFor({ kind: "frame", thread: 1, level: 0 });
    assert.strictEqual((await adapter.handle("scopes", { frameId: refreshed })).scopes.length, 4);

    events.length = 0;
    adapter.clientCapabilities = {};
    await adapter.handle("writeMemory", request);
    assert(!events.some((event) => event.event === "invalidated"), "respect client capabilities");
    const stale = adapter.variableStore.root({ name: "v2", type: "int" }, { thread: 1, level: 0 });
    stale.expression = "p.x";
    mi.resume = true;
    await assert.rejects(adapter.variableStore.metadata(stale), /paused|running|Stale/);
    assert.strictEqual(stale.memoryReference, undefined);
    console.log("Global qualification, frame-bound addresses and memory-write invalidation passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
