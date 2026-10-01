"use strict";

const assert = require("assert");
const { FreeRtosSnapshot, numeric, LIMITS } = require("../src/services/freeRtosSnapshot");

function fixture({ shift = 0, missing = "", corrupt = false } = {}) {
    const memory = new Map();
    const definitions = {
        TCB_t: {
            size: 48 + shift,
            fields: {
                pxTopOfStack: [0, 4],
                uxPriority: [4 + shift, 4],
                pxStack: [8 + shift, 4],
                uxBasePriority: [12 + shift, 4],
                pcTaskName: [16 + shift, 16],
                "xEventListItem.pvContainer": [32 + shift, 4],
                pxEndOfStack: [40 + shift, 4],
                ulRunTimeCounter: [44 + shift, 4]
            }
        },
        List_t: { size: 20, fields: { uxNumberOfItems: [0, 4], xListEnd: [8, 12], "xListEnd.pxNext": [12, 4] } },
        ListItem_t: { size: 20, fields: { pxNext: [4, 4], pvOwner: [12, 4] } }
    };
    const symbols = {
        pxCurrentTCB: 0x20002000,
        pxReadyTasksLists: 0x20001000,
        pxDelayedTaskList: 0x20001100,
        pxOverflowDelayedTaskList: 0x20001200,
        xSuspendedTaskList: 0x20001300,
        xPendingReadyList: 0x20001400,
        xTasksWaitingTermination: 0x20001500
    };
    function list(address, owner, nodeAddress) {
        const bytes = Buffer.alloc(20);
        bytes.writeUInt32LE(owner ? 1 : 0, 0);
        bytes.writeUInt32LE(owner ? nodeAddress : address + 8, 12);
        memory.set(address, bytes);
        if (owner) {
            const node = Buffer.alloc(20);
            node.writeUInt32LE(corrupt ? nodeAddress : address + 8, 4);
            node.writeUInt32LE(owner, 12);
            memory.set(nodeAddress, node);
        }
    }
    list(symbols.pxReadyTasksLists, symbols.pxCurrentTCB, 0x20004000);
    list(symbols.pxReadyTasksLists + 20, 0x20003000, 0x20004100);
    for (const [name, address] of Object.entries(symbols)) if (!/[Cc]urrent|ReadyTasks/.test(name)) list(address);
    for (const [address, name, stack, priority] of [
        [0x20002000, "Idle", 0x20005000, 0],
        [0x20003000, "Worker", 0x20006000, 1]
    ]) {
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
    const commands = [];
    let generation = 0;
    const session = {
        paused: () => {},
        variableStore: {
            snapshot: () => generation,
            check: (snapshot) => {
                if (snapshot !== generation) throw new Error("Stale RTOS operation");
            }
        },
        symbolDirectory: {
            load: async () =>
                Object.keys(symbols)
                    .filter((name) => name !== missing)
                    .map((name) => ({ name, expression: name, file: "tasks.c", isStatic: false }))
        },
        captureConsole: async (run) => {
            await run();
            return "The target architecture is armv7e-m. The target is little endian.";
        },
        mi: {
            command: async (command) => {
                commands.push(command);
                if (session.resumeOn && command.startsWith(session.resumeOn)) generation++;
                if (command.startsWith("-data-read-memory-bytes")) {
                    const [, address, size] = command.split(" ");
                    const block = memory.get(Number(address));
                    if (!block || block.length < Number(size)) throw new Error("Cannot access memory");
                    return { memory: [{ begin: address, contents: block.subarray(0, Number(size)).toString("hex") }] };
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
    return { session, commands, memory, definitions, symbols };
}

(async () => {
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
    wide.definitions.TCB_t.size = 56;
    wide.definitions.TCB_t.fields.ulRunTimeCounter = [48, 8];
    for (const address of [0x20002000, 0x20003000]) {
        const bytes = Buffer.alloc(56);
        wide.memory.get(address).copy(bytes);
        bytes.writeBigUInt64LE(9007199254740993n, 48);
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
    budget.memory.set(0x20001000, Buffer.alloc(10));
    await assert.rejects(
        decoder.read(0x20001000, 20, { generation: 0, bytes: 0, deadline: Infinity }),
        /Cannot access/
    );
    assert.throws(() => numeric("0x100000000"), /ARM32/);
    console.log("FreeRTOS typed layouts, bounded snapshots, stack estimates, partial failures and stale epochs passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
