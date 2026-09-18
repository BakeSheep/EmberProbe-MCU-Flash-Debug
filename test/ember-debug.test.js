"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { MiClient, parseRecord, quote } = require("../src/debug/mi");
const { EmberDebugSession } = require("../src/debug/session");
const { validateDebugConfiguration, isSupportedDebugSession } = require("../src/services/debugConfiguration");

class FakeMi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.id = 0;
        this.failOn = "";
        this.stopReason = "signal-received";
    }
    start(...args) {
        this.startArgs = args;
    }
    async stop() {
        this.stopped = true;
    }
    async command(command) {
        this.commands.push(command);
        if (this.failOn && command.includes(this.failOn)) throw new Error("simulated GDB error");
        if (command.startsWith("-break-insert"))
            return { bkpt: { number: String(++this.id), addr: "0x8000000", line: "12" } };
        if (command === "-exec-interrupt --all")
            this.emit("record", {
                kind: "*",
                class: "stopped",
                data: { reason: this.stopReason, "signal-name": "SIGINT", "thread-id": "1" }
            });
        if (/^-exec-(continue|next|step|finish)$/.test(command))
            this.emit("record", { kind: "*", class: "running", data: {} });
        if (command === "-thread-info") return { threads: [{ id: "1", name: "Cortex-M" }] };
        if (command === "-stack-list-frames")
            return {
                stack: [
                    { frame: { level: "0", func: "main", fullname: "/build/main.c", line: "12", addr: "0x8000000" } }
                ]
            };
        if (command === "-stack-list-variables --simple-values")
            return { variables: [{ name: "counter", value: "3" }, { name: "missing" }] };
        if (command.startsWith("-var-create")) {
            if (command.includes("missing")) throw new Error("optimized out");
            return { name: `var${++this.id}`, numchild: "1", value: "{...}", type: "struct State" };
        }
        if (command.startsWith("-var-list-children"))
            return {
                children: [{ child: { name: "var1.count", exp: "count", value: "3", numchild: "0", type: "int" } }]
            };
        if (command.startsWith("-var-assign")) return { value: "4" };
        if (command.startsWith("-data-read-memory-bytes"))
            return { memory: [{ begin: "0x20000000", contents: "01020304" }] };
        return {};
    }
}

function session() {
    const mi = new FakeMi();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    const events = [];
    adapter.sendEvent = (event) => events.push(event);
    return { mi, adapter, events };
}

(async () => {
    assert.strictEqual(parseRecord("(gdb)"), null);
    assert.strictEqual(parseRecord('~"hi\\n\\303\\251"').text, "hi\né");
    assert.strictEqual(parseRecord('~"😀"').text, "😀");
    assert.strictEqual(parseRecord('7^done,value="a\\\"b"').data.value, 'a"b');
    assert.strictEqual(parseRecord('*stopped,reason="breakpoint-hit"').class, "stopped");
    assert.strictEqual(parseRecord('1^done,stack=[frame={level="0",args=["a",""]}]').data.stack[0].frame.args[1], "");
    assert.throws(() => parseRecord('1^done,value="unfinished'), /Unterminated/);
    assert.throws(() => parseRecord('1^done,value={x="1";y="2"}'), /separator/);
    assert.throws(() => parseRecord("1^done,value=x"), /Invalid/);
    assert.throws(() => parseRecord('1^done,value="x"garbage'), /Invalid/);
    assert.strictEqual(quote("a\nb"), '"a\\nb"');
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
        child.killed = true;
    };
    const mi = new MiClient({ spawn: () => child, timeoutMs: 30 });
    mi.start("gdb", ".");
    const first = mi.command("-first");
    const second = mi.command("-second");
    const progress = [];
    mi.on("record", (record) => progress.push(record));
    child.stdout.write('2+download,{section=".text",section-size="6668",total-size="9880"}\r\n');
    child.stdout.write(
        '+download,{section=".text",section-sent="512",section-size="6668",total-sent="512",total-size="9880"}\r\r\n'
    );
    assert.strictEqual(progress.length, 2);
    assert.strictEqual(progress[0].data.section, ".text");
    assert.strictEqual(progress[1].data["section-sent"], "512");
    assert.strictEqual(mi.closed, false, "download progress must not terminate GDB during flash programming");
    child.stdout.write('2^done,value="two"\n1^do');
    child.stdout.write('ne,value="one"\n');
    assert.strictEqual((await first).value, "one");
    assert.strictEqual((await second).value, "two");
    const failed = mi.command("-bad");
    child.stdout.write('3^error,msg="bad command"\n');
    await assert.rejects(failed, /bad command/);
    await assert.rejects(mi.command("bad\ncommand"), /Invalid/);
    await assert.rejects(mi.command("-timeout"), /timed out/);
    assert.strictEqual(child.killed, true);
    await assert.rejects(mi.command("-closed"), /not running/);
    await mi.stop();

    assert(isSupportedDebugSession({ type: "emberprobe" }));
    assert(isSupportedDebugSession({ type: "cortex-debug" }));
    assert(!isSupportedDebugSession({ type: "node" }));
    const folder = { uri: { fsPath: __dirname } };
    assert.throws(() => validateDebugConfiguration({ request: "launch" }, null));
    assert.throws(() => validateDebugConfiguration({ request: "bad" }, folder));
    assert.throws(() => validateDebugConfiguration({ request: "launch", sourceFileMap: [] }, folder));
    assert.throws(() => validateDebugConfiguration({ request: "launch", runToEntryPoint: 4 }, folder));
    assert.strictEqual(
        validateDebugConfiguration(
            { request: "launch", executable: __filename, cwd: __dirname, gdbTarget: "bad" },
            folder
        ).gdbTarget,
        undefined
    );

    const { adapter: a, mi: backend, events } = session();
    const config = {
        executable: __filename,
        gdbPath: "gdb",
        gdbTarget: "127.0.0.1:3333",
        sourceFileMap: { "/build": "/local" }
    };
    const caps = await a.handle("initialize", {});
    assert(caps.supportsReadMemoryRequest && caps.supportsConditionalBreakpoints);
    await a.handle("launch", config);
    assert(
        backend.commands.indexOf('-interpreter-exec console "monitor reset halt"') <
            backend.commands.indexOf("-target-download")
    );
    let bps = await a.handle("setBreakpoints", {
        source: { path: "/local/main.c" },
        breakpoints: [{ line: 12, condition: "counter > 0" }]
    });
    assert(bps.breakpoints[0].verified);
    const id = bps.breakpoints[0].id;
    assert(backend.commands.some((c) => c.includes('"/build/main.c:12"')));
    bps = await a.handle("setBreakpoints", {
        source: { path: "/local/main.c" },
        breakpoints: [{ line: 12, condition: "counter > 0" }]
    });
    assert.strictEqual(bps.breakpoints[0].id, id);
    await a.handle("setBreakpoints", { source: { path: "/local/main.c" }, breakpoints: [] });
    assert(backend.commands.some((c) => c.startsWith("-break-delete")));
    backend.failOn = "-break-insert";
    assert.strictEqual(
        (await a.handle("setFunctionBreakpoints", { breakpoints: [{ name: "missing" }] })).breakpoints[0].verified,
        false
    );
    await a.handle("configurationDone", {});
    assert(events.some((e) => e.event === "stopped"));
    backend.failOn = "";
    assert.strictEqual((await a.handle("threads", {})).threads[0].id, 1);
    const frame = (await a.handle("stackTrace", { threadId: 1 })).stackFrames[0];
    assert.strictEqual(frame.source.path, "/local/main.c");
    const scope = (await a.handle("scopes", { frameId: frame.id })).scopes[0];
    const vars = (await a.handle("variables", { variablesReference: scope.variablesReference })).variables;
    assert.strictEqual(vars[1].value, "<unavailable>");
    const children = (await a.handle("variables", { variablesReference: vars[0].variablesReference })).variables;
    assert.strictEqual(children[0].name, "count");
    assert.strictEqual(
        (await a.handle("setVariable", { variablesReference: vars[0].variablesReference, name: "count", value: "4" }))
            .value,
        "4"
    );
    assert((await a.handle("evaluate", { frameId: frame.id, expression: "counter" })).variablesReference);
    const memory = await a.handle("readMemory", { memoryReference: "0x20000000", count: 8 });
    assert.strictEqual(memory.unreadableBytes, 4);
    assert.strictEqual(
        (await a.handle("writeMemory", { memoryReference: "0x20000000", data: "AQIDBA==" })).bytesWritten,
        4
    );
    await assert.rejects(a.handle("writeMemory", { memoryReference: "0", data: "bad!" }));
    await assert.rejects(a.handle("readMemory", { memoryReference: "0xffffffff", count: 2 }));
    await assert.rejects(a.handle("readMemory", { memoryReference: "0", count: -1 }));
    await a.handle("continue", {});
    assert.throws(() => a.reference(frame.id, "frame"), /paused/);
    await a.handle("setFunctionBreakpoints", { breakpoints: [{ name: "foo" }] });
    assert(a.running, "internal SIGINT resumes execution");
    backend.stopReason = "breakpoint-hit";
    await a.handle("setFunctionBreakpoints", { breakpoints: [{ name: "bar" }] });
    assert(!a.running, "a concurrent user breakpoint must stay stopped");
    assert.throws(() => a.reference(frame.id, "frame"), /Stale/);
    for (const operation of ["next", "stepIn", "stepOut"]) {
        await a.handle(operation, {});
        await a.handle("pause", {});
    }
    const downloads = backend.commands.filter((c) => c === "-target-download").length;
    await a.handle("restart", {});
    assert.strictEqual(backend.commands.filter((c) => c === "-target-download").length, downloads);
    await a.handle("disconnect", {});
    assert(backend.stopped);
    const attached = session();
    await attached.adapter.handle("attach", config);
    assert(!attached.mi.commands.some((c) => c.includes("reset") || c.includes("download")));
    await attached.adapter.handle("configurationDone", {});
    assert(attached.events.some((e) => e.event === "stopped"));
    const responses = [];
    attached.adapter.sendResponse = (r) => responses.push(r);
    attached.adapter.dispatchRequest({ seq: 123, type: "request", command: "unsupported" });
    await attached.adapter.queue;
    assert.strictEqual(responses.length, 1);
    assert.strictEqual(responses[0].success, false);
    await attached.adapter.close();
    console.log("Independent EmberProbe MI and DAP tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
