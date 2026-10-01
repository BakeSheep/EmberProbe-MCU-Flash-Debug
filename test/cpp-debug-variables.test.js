"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { EmberDebugSession } = require("../src/debug/session");
const { pageRange } = require("../src/debug/variables");

class PrinterMi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.failPrinter = false;
        this.editable = true;
        this.update = [];
        this.size = 250;
    }
    async stop() {}
    async command(command) {
        this.commands.push(command);
        if (this.interruptOn && command.startsWith(this.interruptOn))
            this.emit("record", { kind: "*", class: "running", data: {} });
        if (command.startsWith("-var-show-attributes")) return { status: this.editable ? "editable" : "noneditable" };
        if (command.startsWith("-var-assign")) return { value: "42" };
        if (command.startsWith("-var-update")) return { changelist: this.update };
        if (command.startsWith("-var-info-num-children")) return { numchild: "2" };
        if (command.startsWith("-var-evaluate-expression")) return { value: "{raw}" };
        if (command.startsWith("-var-set-visualizer")) this.failPrinter = false;
        if (command === "-stack-list-variables --simple-values")
            return { variables: Array.from({ length: 205 }, (_, index) => ({ name: `local${index}` })) };
        if (command.startsWith("-var-create")) {
            if (this.warnOnCreate) {
                this.warnOnCreate = false;
                this.emit("output", "Python Exception <class 'gdb.GdbError'>: printer failed\n");
            }
            const exp = JSON.parse(command.slice(command.lastIndexOf(' "') + 1));
            return { name: exp, exp, value: "0", numchild: "0", type: "int" };
        }
        const range = /^-var-list-children --all-values "([^"]+)" (\d+) (\d+)$/.exec(command);
        if (range) {
            if (this.warnOnExpand) {
                this.warnOnExpand = false;
                this.emit("output", "Python Exception <class 'gdb.GdbError'>: printer failed\n");
            }
            if (this.failPrinter) {
                this.failPrinter = false;
                throw new Error("Variable iterator failure");
            }
            const [, name, first, last] = range;
            const from = Number(first),
                end = Math.min(Number(last), this.size);
            return {
                has_more: end < this.size ? "1" : "0",
                children: Array.from({ length: Math.max(0, end - from) }, (_, offset) => ({
                    child: {
                        name: `${name}.${from + offset}`,
                        exp: `[${from + offset}]`,
                        type: "int",
                        value: String(from + offset),
                        numchild: "0",
                        ...(this.nested ? { dynamic: "1", displayhint: "array" } : {})
                    }
                }))
            };
        }
        return {};
    }
}

function setup(item = {}) {
    const mi = new PrinterMi();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    adapter.ready = true;
    adapter.config.enablePrettyPrinting = false;
    adapter.sendEvent = () => {};
    const node = adapter.variableStore.root(
        {
            name: "root",
            numchild: "0",
            dynamic: "1",
            has_more: "1",
            displayhint: "array",
            value: "vector of length 250",
            type: "std::vector<int>",
            ...item
        },
        { thread: 2, level: 0 }
    );
    return { mi, adapter, node, ref: adapter.variableStore.present(node).variablesReference };
}

(async () => {
    for (const args of [
        { start: -1 },
        { count: -1 },
        { count: 1001 },
        { start: Infinity },
        { count: 0.1 },
        { start: 0x7fffffff },
        { filter: "other" }
    ])
        assert.throws(() => pageRange(args));
    assert.strictEqual(pageRange({ count: 0 }).size, 100);
    const { mi, adapter: a, node, ref } = setup();
    assert(ref > 0, "dynamic numchild=0 can still have children");
    assert.strictEqual(a.variableStore.present(node).indexedVariables, undefined, "unknown counts are not fabricated");
    const first = (await a.handle("variables", { variablesReference: ref })).variables;
    assert.strictEqual(first.length, 101);
    assert.strictEqual(first[0].name, "[0]");
    const second = (await a.handle("variables", { variablesReference: first.at(-1).variablesReference })).variables;
    assert.strictEqual(second[0].name, "[100]");
    const third = (await a.handle("variables", { variablesReference: second.at(-1).variablesReference })).variables;
    assert.strictEqual(third.length, 50);
    assert.strictEqual(third.at(-1).name, "[249]");
    assert.strictEqual((await a.handle("variables", { variablesReference: ref, filter: "named" })).variables.length, 0);
    assert.strictEqual(
        (await a.handle("variables", { variablesReference: ref, start: 250, count: 10 })).variables.length,
        0
    );
    await a.handle("setVariable", { variablesReference: ref, name: "[0]", value: "42" });
    await a.handle("setVariable", { variablesReference: first.at(-1).variablesReference, name: "[100]", value: "42" });
    assert(mi.commands.includes('-var-assign "root.0" "42"'));
    assert(mi.commands.includes('-var-update --all-values "root"'));
    assert(!mi.commands.some((command) => command.endsWith(" *")));
    mi.editable = false;
    await assert.rejects(a.handle("setVariable", { variablesReference: ref, name: "[0]", value: "7" }), /not editable/);
    await assert.rejects(
        a.handle("setVariable", { variablesReference: ref, name: "missing", value: "7" }),
        /unavailable/
    );

    const map = setup({ displayhint: "map", type: "std::map<int,int>" });
    map.mi.size = 8;
    const pairs = (await map.adapter.handle("variables", { variablesReference: map.ref, start: 1, count: 2 }))
        .variables;
    assert.strictEqual(pairs.length, 2);
    assert(map.mi.commands.includes('-var-list-children --all-values "root" 2 6'));
    const pair = (await map.adapter.handle("variables", { variablesReference: pairs[0].variablesReference })).variables;
    assert.deepStrictEqual(
        pair.map((item) => item.name),
        ["key", "value"]
    );
    assert(pair[0].presentationHint.attributes.includes("readOnly"));
    await assert.rejects(
        map.adapter.handle("setVariable", {
            variablesReference: pairs[0].variablesReference,
            name: "key",
            value: "42"
        }),
        /read only/
    );
    await map.adapter.handle("setVariable", {
        variablesReference: pairs[0].variablesReference,
        name: "value",
        value: "42"
    });
    assert(map.mi.commands.includes('-var-assign "root.3" "42"'));
    assert.deepStrictEqual(
        (
            await map.adapter.handle("variables", {
                variablesReference: pairs[0].variablesReference,
                filter: "indexed"
            })
        ).variables,
        []
    );
    const repeated = (await map.adapter.handle("variables", { variablesReference: map.ref, start: 1, count: 2 }))
        .variables;
    assert.strictEqual(repeated[0].variablesReference, pairs[0].variablesReference);
    map.mi.size = 3;
    await assert.rejects(map.adapter.handle("variables", { variablesReference: map.ref }), /invalid.*page/);

    const empty = setup({ has_more: "0" });
    assert.strictEqual(empty.ref, 0);
    const string = setup({ has_more: undefined, displayhint: "string" });
    assert.strictEqual(string.ref, 0);
    const fixed = setup({ dynamic: undefined, has_more: "0", type: "int [250]", numchild: "250" });
    assert.strictEqual(fixed.adapter.variableStore.present(fixed.node).indexedVariables, 250);
    fixed.mi.nested = true;
    const children = (await fixed.adapter.handle("variables", { variablesReference: fixed.ref, count: 2 })).variables;
    assert(children[0].variablesReference, "nested dynamic children omit has_more and require lazy expansion");
    const again = (await fixed.adapter.handle("variables", { variablesReference: fixed.ref, count: 2 })).variables;
    assert.strictEqual(again[0].variablesReference, children[0].variablesReference);
    const dynamicChild = fixed.adapter.variableStore.nodes.get("root.0");
    fixed.mi.update = [
        { name: "root.0", in_scope: "true", type_changed: "true", new_type: "long", new_num_children: "0" }
    ];
    await fixed.adapter.handle("setVariable", { variablesReference: fixed.ref, name: "[0]", value: "42" });
    assert.strictEqual(dynamicChild.item.type, "long");
    fixed.mi.update = [{ name: "root.0", in_scope: "invalid" }];
    await fixed.adapter.handle("setVariable", { variablesReference: fixed.ref, name: "[0]", value: "42" });
    await assert.rejects(
        fixed.adapter.handle("setVariable", { variablesReference: fixed.ref, name: "[0]", value: "42" }),
        /unavailable/
    );

    const fallback = setup();
    fallback.mi.failPrinter = true;
    fallback.mi.size = 2;
    const raw = await fallback.adapter.handle("variables", { variablesReference: fallback.ref });
    assert.strictEqual(raw.variables.length, 2);
    assert.strictEqual(fallback.node.item.dynamic, "0");
    assert(fallback.mi.commands.some((command) => command === '-var-set-visualizer "root" None'));
    fallback.mi.failPrinter = true;
    await assert.rejects(
        fallback.adapter.handle("variables", { variablesReference: fallback.ref }),
        /Variable iterator/
    );
    for (const creating of [false, true]) {
        const warning = setup();
        warning.adapter.config.effectivePrettyPrintingMode = "gdb";
        warning.mi.size = 2;
        if (creating) {
            warning.mi.warnOnCreate = true;
            const variable = await warning.adapter.handle("evaluate", { expression: "printerValue" });
            assert(variable.variablesReference, "a soft Python creation failure restores expandable raw fields");
            assert(warning.adapter.variableStore.nodes.get("printerValue").raw);
        } else {
            warning.mi.warnOnExpand = true;
            const page = await warning.adapter.handle("variables", { variablesReference: warning.ref });
            assert.strictEqual(page.variables.length, 2);
            assert(warning.node.raw, "a soft Python iteration failure restores raw fields");
        }
    }

    const scope = setup();
    const frameId = scope.adapter.handleFor({ kind: "frame", thread: 2, level: 0 });
    const scopeId = scope.adapter.handleFor({ kind: "scope", frameId });
    const locals = (await scope.adapter.handle("variables", { variablesReference: scopeId })).variables;
    assert.strictEqual(locals.length, 101);
    await scope.adapter.handle("variables", { variablesReference: scopeId });
    assert.strictEqual(scope.mi.commands.filter((command) => command.startsWith("-var-create")).length, 100);
    await scope.adapter.handle("setVariable", { variablesReference: scopeId, name: "local0", value: "42" });
    assert(scope.mi.commands.includes('-var-set-update-range "local0" 0 0'));
    await scope.adapter.handle("variables", { variablesReference: locals.at(-1).variablesReference });
    assert.strictEqual(scope.mi.commands.filter((command) => command.startsWith("-var-create")).length, 200);

    const task = setup();
    task.adapter.rtosAware = true;
    task.adapter.threads.add(2);
    const exitedFrame = task.adapter.handleFor({ kind: "frame", thread: 2, level: 0 });
    const exitedScope = task.adapter.handleFor({ kind: "scope", frameId: exitedFrame });
    await task.adapter.handle("variables", { variablesReference: task.ref, count: 1 });
    task.adapter.forgetThread(2);
    await assert.rejects(task.adapter.handle("variables", { variablesReference: task.ref }), /Stale/);
    await assert.rejects(task.adapter.handle("variables", { variablesReference: exitedScope }), /Stale/);

    // The exiting task has been browsed before, and exits during another task's MI request.
    for (const operation of ["variables", "setVariable"]) {
        const concurrent = setup();
        const adapter = concurrent.adapter;
        adapter.rtosAware = true;
        adapter.thread = 2;
        adapter.threads = new Set([2, 3]);
        await adapter.handle("variables", { variablesReference: concurrent.ref, count: 1 });
        const cachedFrame = adapter.handleFor({ kind: "frame", thread: 3, level: 0 });
        const cachedScope = adapter.handleFor({ kind: "scope", frameId: cachedFrame });
        const cached = adapter.variableStore.root(
            { name: "other", type: "int [1]", numchild: "1", value: "{...}" },
            { thread: 3, level: 0 }
        );
        const cachedRef = adapter.variableStore.present(cached).variablesReference;
        const command = concurrent.mi.command.bind(concurrent.mi);
        concurrent.mi.command = async (text) => {
            if (text.startsWith(operation === "variables" ? "-var-list-children" : "-var-show-attributes"))
                adapter.forgetThread(3);
            return command(text);
        };
        const result = await adapter.handle(operation, {
            variablesReference: concurrent.ref,
            count: 1,
            name: "[0]",
            value: "42"
        });
        if (operation === "setVariable") assert.strictEqual(result.value, "42");
        else assert.strictEqual(result.variables.length, 1);
        for (const reference of [cachedScope, cachedRef])
            await assert.rejects(adapter.handle("variables", { variablesReference: reference }), /Stale/);
        assert(!adapter.variableStore.nodes.has("other"));
    }

    // Losing the owning task still rejects the in-flight operation, even if its ID is reused.
    for (const operation of ["variables", "setVariable"]) {
        const ownerExit = setup();
        ownerExit.adapter.rtosAware = true;
        ownerExit.adapter.threads.add(2);
        await ownerExit.adapter.handle("variables", { variablesReference: ownerExit.ref, count: 1 });
        const command = ownerExit.mi.command.bind(ownerExit.mi);
        ownerExit.mi.command = async (text) => {
            if (text.startsWith(operation === "variables" ? "-var-list-children" : "-var-show-attributes")) {
                ownerExit.adapter.forgetThread(2);
                ownerExit.adapter.confirmThread(2);
            }
            return command(text);
        };
        await assert.rejects(
            ownerExit.adapter.handle(operation, {
                variablesReference: ownerExit.ref,
                count: 1,
                name: "[0]",
                value: "42"
            }),
            /Stale/
        );
        assert(!ownerExit.mi.commands.some((text) => text.startsWith("-var-assign")));
    }

    const race = setup();
    race.mi.interruptOn = "-var-list-children";
    await assert.rejects(race.adapter.handle("variables", { variablesReference: race.ref }), /paused/);
    race.adapter.onRecord({ kind: "*", class: "stopped", data: { "thread-id": "2" } });
    await assert.rejects(race.adapter.handle("variables", { variablesReference: race.ref }), /Stale/);
    assert.strictEqual(race.adapter.variableStore.nodes.size, 0);
    console.log("C++ dynamic variables, bounded paging, map writes and stop lifetime tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
