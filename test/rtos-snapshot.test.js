"use strict";

const assert = require("assert");
const { FreeRtosSnapshot, numeric, LIMITS } = require("../src/services/freeRtosSnapshot");

function fixture({
    shift = 0,
    missing = "",
    corrupt = false,
    detached = false,
    arch = "armv7e-m",
    endian = "little"
} = {}) {
    const memory = new Map();
    // Zero-initialized kernel .bss around the list heads; other memory is readable only where set.
    const bss = { address: 0x20001000, bytes: Buffer.alloc(0x800) };
    const definitions = {
        TCB_t: {
            size: 80 + shift,
            fields: {
                pxTopOfStack: [0, 4],
                xStateListItem: [4 + shift, 20],
                xEventListItem: [24 + shift, 20],
                "xEventListItem.pvContainer": [40 + shift, 4],
                uxPriority: [44 + shift, 4],
                pxStack: [48 + shift, 4],
                uxBasePriority: [52 + shift, 4],
                pcTaskName: [56 + shift, 16],
                pxEndOfStack: [72 + shift, 4],
                ulRunTimeCounter: [76 + shift, 4]
            }
        },
        List_t: { size: 20, fields: { uxNumberOfItems: [0, 4], xListEnd: [8, 12], "xListEnd.pxNext": [12, 4] } },
        ListItem_t: { size: 20, fields: { pxNext: [4, 4], pvOwner: [12, 4] } }
    };
    // Lists and pointer variables map to their addresses; pxCurrentTCB and the scalars to their values.
    const symbols = {
        pxCurrentTCB: 0x20002000,
        pxReadyTasksLists: 0x20001000,
        pxDelayedTaskList: 0x20001100,
        pxOverflowDelayedTaskList: 0x20001104,
        xSuspendedTaskList: 0x20001300,
        xPendingReadyList: 0x20001400,
        xTasksWaitingTermination: 0x20001500,
        xDelayedTaskList1: 0x20001600,
        xDelayedTaskList2: 0x20001700
    };
    const pointer = (address, value) => {
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32LE(value);
        memory.set(address, bytes);
    };
    pointer(symbols.pxDelayedTaskList, symbols.xDelayedTaskList1);
    pointer(symbols.pxOverflowDelayedTaskList, symbols.xDelayedTaskList2);
    const tcbs = [
        [0x20002000, "Idle", 0x20005000, 0],
        [0x20003000, "Worker", 0x20006000, 1]
    ];
    for (const [address, name, stack, priority] of tcbs) {
        const type = definitions.TCB_t;
        const bytes = Buffer.alloc(type.size);
        const write = (field, value) => bytes.writeUInt32LE(value, type.fields[field][0]);
        write("pxTopOfStack", stack + 16);
        write("pxStack", stack);
        write("pxEndOfStack", stack + 28);
        write("uxPriority", priority);
        write("uxBasePriority", priority);
        write("ulRunTimeCounter", 100);
        bytes.write(name, type.fields.pcTaskName[0]);
        memory.set(address, bytes);
        const fill = Buffer.alloc(32, 0);
        fill.fill(0xa5, 0, 20);
        memory.set(stack, fill);
    }
    // Links one TCB into a list through the named embedded item, or through a separate node when detached.
    function link(listAddress, owner, member = "xStateListItem") {
        const nodeAddress = detached ? owner + 0x8000 : owner + definitions.TCB_t.fields[member][0];
        const header = Buffer.alloc(20);
        header.writeUInt32LE(1, 0);
        header.writeUInt32LE(nodeAddress, 12);
        memory.set(listAddress, header);
        const node = detached ? Buffer.alloc(20) : memory.get(owner).subarray(nodeAddress - owner);
        node.writeUInt32LE(corrupt ? nodeAddress : listAddress + 8, 4);
        node.writeUInt32LE(owner, 12);
        if (detached) memory.set(nodeAddress, node);
        return nodeAddress;
    }
    function empty(listAddress) {
        const header = Buffer.alloc(20);
        header.writeUInt32LE(listAddress + 8, 12);
        memory.set(listAddress, header);
    }
    link(symbols.pxReadyTasksLists, 0x20002000);
    link(symbols.pxReadyTasksLists + 20, 0x20003000);
    for (const name of [
        "xSuspendedTaskList",
        "xPendingReadyList",
        "xTasksWaitingTermination",
        "xDelayedTaskList1",
        "xDelayedTaskList2"
    ])
        empty(symbols[name]);
    function readMemory(address, size) {
        const bytes = Buffer.alloc(size);
        const covered = new Uint8Array(size);
        for (const [start, block] of [[bss.address, bss.bytes], ...memory]) {
            const from = Math.max(start, address),
                to = Math.min(start + block.length, address + size);
            for (let at = from; at < to; at++) {
                bytes[at - address] = block[at - start];
                covered[at - address] = 1;
            }
        }
        if (covered.includes(0)) throw new Error("Cannot access memory");
        return bytes;
    }
    const commands = [];
    let generation = 0;
    let directory = null;
    const session = {
        paused: () => {},
        variableStore: {
            snapshot: () => generation,
            check: (snapshot) => {
                if (snapshot !== generation) throw new Error("Stale RTOS operation");
            }
        },
        // Like the real directory, the same entry array is returned until symbols are reloaded.
        symbolDirectory: {
            load: async () =>
                (directory ||= Object.keys(symbols)
                    .filter((name) => name !== missing)
                    .map((name) => ({ name, expression: name, file: "tasks.c", isStatic: false }))),
            reset: () => {
                directory = null;
            }
        },
        captureConsole: async (run) => {
            await run();
            return `The target architecture is ${arch}. The target is ${endian} endian.`;
        },
        mi: {
            command: async (command) => {
                commands.push(command);
                if (session.resumeOn && command.startsWith(session.resumeOn)) generation++;
                if (command.startsWith("-data-read-memory-bytes")) {
                    const [, address, size] = command.split(" ");
                    const contents = readMemory(Number(address), Number(size)).toString("hex");
                    return { memory: [{ begin: address, contents }] };
                }
                if (!command.startsWith("-data-evaluate-expression")) return {};
                const expr = JSON.parse(command.slice(command.indexOf(" ") + 1));
                if (expr === "sizeof(void*)") return { value: "4" };
                if (expr === "sizeof(pxReadyTasksLists) / sizeof(List_t)") return { value: "2" };
                if (Object.hasOwn(symbols, expr)) return { value: String(symbols[expr]) };
                const address = expr.match(/^\(unsigned long\)&\((\w+)\)$/);
                if (address) return { value: String(symbols[address[1]]) };
                const typeSize = expr.match(/^sizeof\((\w+)\)$/);
                if (typeSize) return { value: String(definitions[typeSize[1]].size) };
                const field = expr.match(/\(\((\w+)\*\)0\)->([\w.]+)/);
                if (field) {
                    if (field[2] === missing) throw new Error("No member named " + missing);
                    const definition = definitions[field[1]].fields[field[2]];
                    return { value: String(definition[expr.startsWith("sizeof") ? 1 : 0]) };
                }
                throw new Error("Unexpected expression " + expr);
            }
        }
    };
    return { session, commands, memory, definitions, symbols, link };
}

(async () => {
    {
        const { session, commands } = fixture();
        const result = await new FreeRtosSnapshot(session).snapshot({ includeStackUsage: false });
        assert.strictEqual(result.tasks[1].stack.totalBytes, 32, "cheap stack bounds stay available");
        assert.strictEqual(result.tasks[1].stack.fillEstimate, undefined);
        assert(
            !commands.some((command) => /^-data-read-memory-bytes 0x2000[56]000 /.test(command)),
            "automatic snapshot never scans stack fill"
        );
    }
    for (const shift of [0, 4]) {
        const { session, commands } = fixture({ shift });
        const result = await new FreeRtosSnapshot(session).snapshot();
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.partial, false);
        assert(result.kernel.supported);
        assert.deepStrictEqual(
            result.tasks.map((task) => task.name),
            ["Idle", "Worker"]
        );
        assert.deepStrictEqual(
            result.tasks.map((task) => task.state),
            ["running", "ready"]
        );
        assert.strictEqual(result.tasks[1].priority, 1);
        assert.strictEqual(result.tasks[1].stack.totalBytes, 32);
        assert.strictEqual(result.tasks[1].stack.fillEstimate.usedPercent, 37.5);
        assert.strictEqual(result.tasks[0].threadId, undefined, "TCBs never masquerade as DAP thread IDs");
        assert(
            commands.every((command) =>
                /^-(data-evaluate-expression|data-read-memory-bytes|interpreter-exec console "show )/.test(command)
            )
        );
    }
    for (const missing of ["pxCurrentTCB", "xSuspendedTaskList"]) {
        const { session } = fixture({ missing });
        const result = await new FreeRtosSnapshot(session).snapshot();
        assert(result.partial && result.diagnostics.some((message) => message.includes(missing)));
    }
    for (const missing of ["pxEndOfStack", "ulRunTimeCounter", "uxBasePriority", "xEventListItem.pvContainer"]) {
        const { session } = fixture({ missing });
        const result = await new FreeRtosSnapshot(session).snapshot();
        assert.strictEqual(result.partial, false, "Optional config fields may be absent");
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.tasks.length, 2);
        if (missing === "pxEndOfStack") assert.strictEqual(result.tasks[0].stack.totalBytes, undefined);
        if (missing === "ulRunTimeCounter") assert.strictEqual(result.tasks[0].runtime, undefined);
    }
    for (const scheduler of [0, undefined]) {
        const initial = fixture();
        initial.symbols.pxCurrentTCB = 0;
        initial.symbols.uxCurrentNumberOfTasks = 0;
        if (scheduler !== undefined) initial.symbols.xSchedulerRunning = scheduler;
        // Model BSS at main: no initialized sentinel or delayed-list pointer.
        for (const [address, bytes] of initial.memory) initial.memory.set(address, Buffer.alloc(bytes.length));
        const result = await new FreeRtosSnapshot(initial.session).snapshot();
        assert.strictEqual(result.kernel.state, scheduler === 0 ? "not-started" : "no-tasks");
        assert.strictEqual(result.kernel.supported, true);
        assert.strictEqual(result.partial, false);
        assert.deepStrictEqual(result.tasks, []);
        assert.deepStrictEqual(result.diagnostics, []);
        assert(!initial.commands.some((command) => command.startsWith("-data-read-memory-bytes")));
    }
    {
        const initial = fixture();
        initial.symbols.xSchedulerRunning = 0;
        initial.symbols.pxCurrentTCB = 0;
        delete initial.symbols.uxCurrentNumberOfTasks;
        for (const [address, bytes] of initial.memory) initial.memory.set(address, Buffer.alloc(bytes.length));
        const result = await new FreeRtosSnapshot(initial.session).snapshot();
        assert.strictEqual(result.kernel.state, "not-started");
        assert.strictEqual(result.kernel.supported, true);
        assert.strictEqual(result.partial, false);
        assert.deepStrictEqual(result.tasks, []);
        assert.deepStrictEqual(result.diagnostics, []);
        assert(!initial.commands.some((command) => command.startsWith("-data-read-memory-bytes")));
    }
    {
        // Both kernel statics optimized out and no current TCB: undecidable, and walking the
        // zero-initialized lists would report them as corrupt.
        const initial = fixture();
        initial.symbols.pxCurrentTCB = 0;
        for (const [address, bytes] of initial.memory) initial.memory.set(address, Buffer.alloc(bytes.length));
        const result = await new FreeRtosSnapshot(initial.session).snapshot();
        assert.strictEqual(result.kernel.state, "unknown");
        assert.strictEqual(result.kernel.supported, true);
        assert.strictEqual(result.partial, true);
        assert.deepStrictEqual(result.tasks, []);
        assert.strictEqual(result.diagnostics.length, 1);
        assert.match(result.diagnostics[0], /cannot be told apart|cannot be determined|undecidable|corruption/i);
        assert(!initial.commands.some((command) => command.startsWith("-data-read-memory-bytes")));
    }
    for (const arch of ["armv6-m", "armv7e-m", "armv8-m.main", "armv8.1-m", "armv8.1-m.main"]) {
        const result = await new FreeRtosSnapshot(fixture({ arch }).session).snapshot();
        assert.strictEqual(result.kernel.supported, true, `${arch} is a Cortex-M profile`);
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.tasks.length, 2);
    }
    for (const rejected of [{ arch: "armv7-a" }, { arch: "armv8.1-a" }, { endian: "big" }]) {
        const gate = fixture(rejected);
        const result = await new FreeRtosSnapshot(gate.session).snapshot();
        assert.strictEqual(result.kernel.supported, false, JSON.stringify(rejected));
        assert.deepStrictEqual(result.tasks, []);
        assert.match(result.diagnostics[0], /little-endian single-core Cortex-M ARM32/u);
    }
    const beforeScheduler = fixture();
    beforeScheduler.symbols.xSchedulerRunning = 0;
    beforeScheduler.symbols.uxCurrentNumberOfTasks = 2;
    const created = await new FreeRtosSnapshot(beforeScheduler.session).snapshot();
    assert.strictEqual(created.kernel.state, "not-started");
    assert.deepStrictEqual(
        created.tasks.map((task) => task.state),
        ["ready", "ready"]
    );
    const initialized = fixture({ corrupt: true });
    initialized.symbols.xSchedulerRunning = 1;
    initialized.symbols.uxCurrentNumberOfTasks = 0;
    initialized.symbols.pxCurrentTCB = 0;
    const damaged = await new FreeRtosSnapshot(initialized.session).snapshot();
    assert.strictEqual(damaged.kernel.state, "running");
    assert(damaged.partial && damaged.diagnostics.length > 0, "Started kernels retain corruption diagnostics");
    const invalidOptional = fixture();
    invalidOptional.definitions.TCB_t.fields.pxEndOfStack[1] = 2;
    const invalidWidth = await new FreeRtosSnapshot(invalidOptional.session).snapshot();
    assert(
        invalidWidth.partial &&
            invalidWidth.diagnostics.some((message) => message.includes("Unsupported optional field"))
    );
    const probeFailure = fixture();
    probeFailure.symbols.xSchedulerRunning = 0;
    probeFailure.symbols.uxCurrentNumberOfTasks = 0;
    probeFailure.symbols.pxCurrentTCB = 0;
    const command = probeFailure.session.mi.command;
    probeFailure.session.mi.command = async (value) => {
        if (value.includes('"xSchedulerRunning"')) throw new Error("Cannot access memory");
        return command(value);
    };
    const unreadable = await new FreeRtosSnapshot(probeFailure.session).snapshot();
    assert(unreadable.partial && unreadable.diagnostics.some((message) => message.includes("Cannot access memory")));
    const corrupt = fixture({ corrupt: true });
    const partial = await new FreeRtosSnapshot(corrupt.session).snapshot();
    assert(partial.partial && partial.diagnostics.some((message) => /cycle/.test(message)));
    for (const problem of ["missing", "ambiguous", "wrong-address"]) {
        const multi = fixture();
        multi.session.config = {
            symbolFiles: [{ file: "primary.elf" }, { file: "second.elf" }],
            primarySymbolFile: "primary.elf"
        };
        const original = multi.session.symbolDirectory.load;
        multi.session.symbolDirectory.load = async () =>
            (await original()).map((entry) => ({
                ...entry,
                image: problem === "missing" ? "second.elf" : "primary.elf",
                expression: problem === "ambiguous" && entry.name === "pxCurrentTCB" ? null : entry.expression,
                symbolAddress: problem === "wrong-address" ? "0x20009000" : "0x20002000"
            }));
        const result = await new FreeRtosSnapshot(multi.session).snapshot();
        assert(result.partial && !result.kernel.supported && result.tasks.length === 0);
        assert(
            !multi.commands.some((command) => command.startsWith("-data-read-memory-bytes")),
            "unverified primary image cannot trigger TCB memory decoding"
        );
    }
    const wide = fixture();
    wide.definitions.TCB_t.size = 88;
    wide.definitions.TCB_t.fields.ulRunTimeCounter = [80, 8];
    for (const address of [0x20002000, 0x20003000]) {
        const bytes = Buffer.alloc(88);
        wide.memory.get(address).copy(bytes);
        bytes.writeBigUInt64LE(9007199254740993n, 80);
        wide.memory.set(address, bytes);
    }
    assert.strictEqual(
        (await new FreeRtosSnapshot(wide.session).snapshot()).tasks[0].runtime.counter,
        "9007199254740993"
    );
    const stale = fixture();
    stale.session.resumeOn = "-data-read-memory-bytes";
    await assert.rejects(new FreeRtosSnapshot(stale.session).snapshot(), /Stale/);
    const budget = fixture();
    const decoder = new FreeRtosSnapshot(budget.session);
    await assert.rejects(
        decoder.read(0x20001000, 20, { generation: 0, bytes: LIMITS.bytes, deadline: Infinity }),
        /budget/
    );
    await assert.rejects(decoder.read(0x20001001, 20, { generation: 0, bytes: 0, deadline: Infinity }), /address/);
    budget.memory.set(0x20008000, Buffer.alloc(10));
    await assert.rejects(
        decoder.read(0x20008000, 20, { generation: 0, bytes: 0, deadline: Infinity }),
        /Cannot access/
    );
    const reads = (commands) => commands.filter((command) => command.startsWith("-data-read-memory-bytes"));
    {
        const warm = fixture();
        warm.symbols.xSchedulerRunning = 1;
        warm.symbols.uxCurrentNumberOfTasks = 2;
        const first = await new FreeRtosSnapshot(warm.session).snapshot();
        const cold = warm.commands.splice(0);
        const second = await new FreeRtosSnapshot(warm.session).snapshot();
        assert.deepStrictEqual(second, first, "cached layouts decode the same snapshot");
        assert.deepStrictEqual(
            warm.commands.filter((command) => !command.startsWith("-data-read-memory-bytes")),
            ["pxCurrentTCB", "xSchedulerRunning", "uxCurrentNumberOfTasks"].map(
                (name) => `-data-evaluate-expression ${JSON.stringify(name)}`
            ),
            "a later stop reads only the kernel values that change"
        );
        assert.deepStrictEqual(
            reads(warm.commands),
            [
                "-data-read-memory-bytes 0x20001000 1812",
                "-data-read-memory-bytes 0x20002000 80",
                "-data-read-memory-bytes 0x20005000 32",
                "-data-read-memory-bytes 0x20003000 80",
                "-data-read-memory-bytes 0x20006000 32"
            ],
            "list heads share one window and each node arrives with its TCB"
        );
        assert(cold.length > warm.commands.length * 4);
        warm.session.symbolDirectory.reset();
        warm.commands.length = 0;
        assert.deepStrictEqual(await new FreeRtosSnapshot(warm.session).snapshot(), first);
        assert(
            warm.commands.includes('-data-evaluate-expression "sizeof(TCB_t)"'),
            "reloaded symbols rebuild the layouts"
        );
    }
    {
        const detached = fixture({ detached: true });
        const result = await new FreeRtosSnapshot(detached.session).snapshot();
        assert.deepStrictEqual(result.diagnostics, []);
        assert.deepStrictEqual(
            result.tasks.map((task) => [task.name, task.state]),
            [
                ["Idle", "running"],
                ["Worker", "ready"]
            ]
        );
        assert(reads(detached.commands).includes("-data-read-memory-bytes 0x2000a000 20"), "nodes outside TCBs");
    }
    {
        const blocked = fixture();
        const command = blocked.session.mi.command;
        blocked.session.mi.command = async (value) => {
            if (value === "-data-read-memory-bytes 0x20001000 1812") throw new Error("Cannot access memory");
            return command(value);
        };
        const result = await new FreeRtosSnapshot(blocked.session).snapshot();
        assert.deepStrictEqual(result.diagnostics, [], "an unreadable window falls back to per-list reads");
        assert.deepStrictEqual(
            result.tasks.map((task) => task.name),
            ["Idle", "Worker"]
        );
        assert(reads(blocked.commands).includes("-data-read-memory-bytes 0x20001000 20"));
    }
    {
        const pending = fixture();
        pending.link(pending.symbols.xPendingReadyList, 0x20003000, "xEventListItem");
        const result = await new FreeRtosSnapshot(pending.session).snapshot();
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.tasks[1].state, "pending-ready", "pending-ready lists link event items");
        assert.deepStrictEqual(
            reads(pending.commands).filter((command) => /0x2000301[08]|0x20003000/.test(command)),
            ["-data-read-memory-bytes 0x20003000 80"],
            "a TCB reached from two lists is read once"
        );
    }
    {
        const absent = fixture({ missing: "xSuspendedTaskList" });
        await new FreeRtosSnapshot(absent.session).snapshot();
        absent.commands.length = 0;
        const result = await new FreeRtosSnapshot(absent.session).snapshot();
        assert(result.partial && result.diagnostics.some((message) => message.includes("xSuspendedTaskList")));
        assert(!absent.commands.some((command) => command.includes("sizeof")), "configuration absence is cached");
    }
    {
        const transient = fixture();
        const command = transient.session.mi.command;
        let failures = 1;
        transient.session.mi.command = async (value) => {
            if (value.includes("->pxEndOfStack") && failures-- > 0) throw new Error("Remote connection closed");
            return command(value);
        };
        const failed = await new FreeRtosSnapshot(transient.session).snapshot();
        assert(failed.diagnostics.some((message) => message.includes("Remote connection closed")));
        transient.commands.length = 0;
        const retried = await new FreeRtosSnapshot(transient.session).snapshot();
        assert.deepStrictEqual(retried.diagnostics, [], "a transport failure is not cached");
        assert.strictEqual(retried.tasks[0].stack.totalBytes, 32);
        assert(transient.commands.includes('-data-evaluate-expression "sizeof(TCB_t)"'));
    }
    assert.throws(() => numeric("0x100000000"), /ARM32/);
    console.log("FreeRTOS typed layouts, bounded snapshots, stack estimates, partial failures and stale epochs passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
