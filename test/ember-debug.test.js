"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { MiClient, parseRecord, quote } = require("../src/debug/mi");
const { EmberDebugSession } = require("../src/debug/session");
const {
    validateDebugConfiguration,
    isSupportedDebugSession,
    resolveRtos
} = require("../src/services/debugConfiguration");

class FakeMi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.id = 0;
        this.failOn = "";
        this.stopReason = "signal-received";
        this.threads = [{ id: "1", name: "Cortex-M" }];
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
        if (/^-exec-(continue|next|step|finish)(?: --thread \d+)?$/.test(command))
            this.emit("record", { kind: "*", class: "running", data: {} });
        if (command === "-thread-info") return { threads: this.threads, "current-thread-id": this.threads[0]?.id };
        if (command.startsWith("-thread-select") && !this.threads.some((t) => t.id === command.split(" ")[1]))
            throw new Error(`Unknown thread ${command.split(" ")[1]}.`);
        if (command.startsWith("-stack-list-frames"))
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
        if (command.startsWith("-var-show-attributes")) return { status: "editable" };
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
    for (const bad of ["FreeRTOs", "freertos", "hwthread", "mqx; shutdown", 4])
        assert.throws(
            () => validateDebugConfiguration({ request: "launch", rtos: bad }, folder),
            (error) => error.code === "OPENOCD_RTOS_INVALID",
            `${JSON.stringify(bad)} is not an OpenOCD RTOS name`
        );
    assert.strictEqual(validateDebugConfiguration({ request: "launch", rtos: " FreeRTOS " }, folder).rtos, "FreeRTOS");
    assert.strictEqual(validateDebugConfiguration({ request: "launch", rtos: "" }, folder).rtos, "");
    // launch.json wins whenever it carries a value, including an explicit empty string.
    assert.strictEqual(resolveRtos({}, "FreeRTOS"), "FreeRTOS");
    assert.strictEqual(resolveRtos({ rtos: "" }, "FreeRTOS"), "", "An explicit empty value overrides the setting");
    assert.strictEqual(resolveRtos({ rtos: "Zephyr" }, "FreeRTOS"), "Zephyr");
    assert.strictEqual(resolveRtos({ rtos: null }, "FreeRTOS"), "FreeRTOS");
    assert.strictEqual(
        resolveRtos(validateDebugConfiguration({ request: "launch", rtos: null }, folder), "FreeRTOS"),
        "FreeRTOS",
        "validation must preserve null's fallback behavior"
    );
    assert.strictEqual(resolveRtos(undefined, undefined), "");
    assert.throws(
        () => resolveRtos({ rtos: "FreeRTOs" }, ""),
        (error) => error.code === "OPENOCD_RTOS_INVALID"
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
        backend.commands.indexOf("-gdb-set auto-load off") <
            backend.commands.findIndex((command) => command.startsWith("-file-exec-and-symbols")),
        "disable auto-loading before any ELF scripts can load"
    );
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
    assert(backend.commands.includes("-stack-list-frames 0 19"));
    await a.handle("stackTrace", { threadId: 1, startFrame: 2, levels: 3 });
    assert(backend.commands.includes("-stack-list-frames 2 4"));
    await assert.rejects(a.handle("stackTrace", { threadId: 1, levels: 1001 }), /paging/);
    const scope = (await a.handle("scopes", { frameId: frame.id })).scopes[0];
    const vars = (await a.handle("variables", { variablesReference: scope.variablesReference })).variables;
    assert.match(vars[1].value, /unavailable.*optimized out/);
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
    // A session without an RTOS must produce exactly the command and event stream it did before
    // task awareness existed.
    assert(backend.commands.some((c) => c.startsWith("-exec-continue")));
    assert(!backend.commands.some((c) => c.includes("--thread")), "a non-RTOS session never pins a thread");
    assert(backend.commands.includes('-var-create - * "counter"'), "varobjs keep their unpinned form");
    assert(!events.some((e) => e.event === "thread"), "a non-RTOS session emits no thread events");
    assert.strictEqual(
        backend.commands.filter((c) => c === "-thread-info").length,
        1,
        "task awareness adds no MI round trip"
    );
    const plain = session();
    plain.mi.threads = [];
    await plain.adapter.handle("launch", config);
    assert(plain.adapter.threads.has(1), "a non-RTOS session keeps the legacy single-thread default");
    plain.adapter.onRecord({ kind: "*", class: "stopped", data: { reason: "breakpoint-hit" } });
    assert.strictEqual(plain.events.at(-1).body.threadId, 1);
    await plain.adapter.close();
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

    const optedOut = session();
    await optedOut.adapter.handle("launch", { ...config, rtos: "none" });
    assert.strictEqual(optedOut.adapter.rtosAware, false);
    assert(!optedOut.mi.commands.includes("-thread-info"), '"none" never queries the task list');
    assert(optedOut.adapter.threads.has(1));
    await optedOut.adapter.handle("continue", { threadId: 1 });
    assert(optedOut.mi.commands.includes("-exec-continue"));
    assert(!optedOut.mi.commands.some((c) => c.includes("--thread")));
    await optedOut.adapter.close();
    const grouped = session();
    await grouped.adapter.handle("attach", {
        ...config,
        serverGroup: "dual",
        numberOfProcessors: 2,
        targetProcessor: 1
    });
    assert(
        grouped.events.some(
            (event) => event.event === "capabilities" && event.body.capabilities.supportsRestartRequest === false
        )
    );
    assert(
        !grouped.mi.commands.some((command) => command.includes("monitor reset") || command === "-target-download"),
        "joining a group never resets or downloads"
    );
    const beforeRestart = grouped.mi.commands.length;
    await assert.rejects(grouped.adapter.handle("restart", {}), /shared|group|cores/i);
    assert.strictEqual(
        grouped.mi.commands.length,
        beforeRestart,
        "shared restart is rejected before interrupting or running hooks"
    );
    await grouped.adapter.close();

    // Nothing is invented before the scheduler has created a task.
    const early = session();
    early.mi.threads = [];
    await early.adapter.handle("launch", { ...config, rtos: "FreeRTOS" });
    assert.strictEqual(early.adapter.thread, null, "no task is assumed before GDB confirms one");
    early.adapter.onRecord({ kind: "*", class: "stopped", data: { reason: "breakpoint-hit" } });
    assert(!("threadId" in early.events.at(-1).body), "an unconfirmed thread id is never reported");
    await early.adapter.close();

    const rtos = session();
    rtos.mi.threads = [{ id: "1", name: "IDLE" }];
    await rtos.adapter.handle("launch", { ...config, rtos: "FreeRTOS" });
    assert.strictEqual(rtos.adapter.rtosAware, true);
    assert.deepStrictEqual([...rtos.adapter.threads], [1], "task ids come from GDB, not from a default");
    assert.strictEqual(rtos.adapter.thread, 1);
    assert(
        rtos.mi.commands.indexOf("-target-select extended-remote 127.0.0.1:3333") <
            rtos.mi.commands.indexOf("-thread-info"),
        "the task list is seeded once GDB is attached"
    );
    rtos.adapter.onRecord({ kind: "=", class: "thread-created", data: { id: "2" } });
    rtos.adapter.onRecord({ kind: "=", class: "thread-created", data: { id: "2" } });
    rtos.adapter.onRecord({ kind: "=", class: "thread-created", data: { id: "3" } });
    rtos.adapter.onRecord({ kind: "=", class: "thread-group-added", data: { id: "i1" } });
    assert.deepStrictEqual(
        [...rtos.adapter.threads].sort((l, r) => l - r),
        [1, 2, 3]
    );
    assert.deepStrictEqual(
        rtos.events.filter((e) => e.event === "thread").map((e) => [e.body.reason, e.body.threadId]),
        [
            ["started", 2],
            ["started", 3]
        ],
        "a thread group is not a task and a duplicate creation is not reported twice"
    );
    rtos.events.length = 0;
    rtos.adapter.onRecord({ kind: "*", class: "stopped", data: { reason: "breakpoint-hit", "thread-id": "3" } });
    assert.strictEqual(rtos.adapter.thread, 3);
    assert.strictEqual(rtos.events.at(-1).body.threadId, 3);
    // Task 3 disappears and task 4 appears without any lifecycle notification.
    rtos.mi.threads = [
        { id: "1", name: "IDLE" },
        { id: "2", name: "blink" },
        { id: "4", name: "uart" }
    ];
    rtos.events.length = 0;
    assert.deepStrictEqual(
        (await rtos.adapter.handle("threads", {})).threads.map((t) => t.id),
        [1, 2, 4]
    );
    assert.deepStrictEqual(
        [...rtos.adapter.threads].sort((l, r) => l - r),
        [1, 2, 4]
    );
    assert.deepStrictEqual(
        rtos.events.filter((e) => e.event === "thread").map((e) => [e.body.reason, e.body.threadId]),
        [["exited", 3]],
        "querying the list recalibrates it"
    );
    assert.strictEqual(rtos.adapter.thread, null, "the stopped task is dropped when it exits");
    rtos.adapter.onRecord({ kind: "*", class: "stopped", data: { reason: "breakpoint-hit", "thread-id": "2" } });
    await rtos.adapter.handle("stackTrace", { threadId: 4 });
    assert(rtos.mi.commands.includes("-thread-select 4"), "browsing another task selects it in GDB");
    await rtos.adapter.handle("next", { threadId: 2 });
    assert(
        rtos.mi.commands.includes("-exec-next --thread 2"),
        "stepping targets the requested task, not the one GDB last selected"
    );
    rtos.adapter.onRecord({ kind: "*", class: "stopped", data: { reason: "end-stepping-range", "thread-id": "2" } });
    rtos.mi.threads = [
        { id: "1", name: "IDLE" },
        { id: "4", name: "uart" }
    ];
    rtos.adapter.onRecord({ kind: "=", class: "thread-exited", data: { id: "2" } });
    assert.strictEqual(rtos.adapter.thread, null);
    const issued = rtos.mi.commands.length;
    await assert.rejects(rtos.adapter.handle("next", { threadId: 2 }), (e) => e.code === "DEBUG_TASK_EXITED");
    assert(
        !rtos.mi.commands.slice(issued).some((c) => c.startsWith("-exec-")),
        "an exited task is rejected before any command reaches GDB"
    );
    await assert.rejects(rtos.adapter.handle("continue", { threadId: 0 }), (e) => e.code === "DEBUG_THREAD_INVALID");
    rtos.mi.threads = [{ id: "1", name: "IDLE" }];
    await rtos.adapter.handle("restart", {});
    assert.deepStrictEqual([...rtos.adapter.threads], [1], "a reset rebuilds the task list");
    await rtos.adapter.close();

    const pinned = session();
    pinned.mi.threads = [
        { id: "1", name: "IDLE" },
        { id: "2", name: "blink" }
    ];
    await pinned.adapter.handle("launch", { ...config, rtos: "FreeRTOS" });
    pinned.adapter.onRecord({ kind: "*", class: "stopped", data: { reason: "breakpoint-hit", "thread-id": "2" } });
    const taskFrame = (await pinned.adapter.handle("stackTrace", { threadId: 2 })).stackFrames[0];
    const taskScope = (await pinned.adapter.handle("scopes", { frameId: taskFrame.id })).scopes[0];
    await pinned.adapter.handle("variables", { variablesReference: taskScope.variablesReference });
    await pinned.adapter.handle("evaluate", { frameId: taskFrame.id, expression: "counter" });
    assert(
        pinned.mi.commands.filter((c) => c === '-var-create --thread 2 --frame 0 - * "counter"').length === 2,
        "locals and expressions are bound to the owning task and frame"
    );
    await pinned.adapter.close();
    console.log("Independent EmberProbe MI and DAP tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
