"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { EmberDebugSession } = require("../src/debug/session");

class ClassMi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.items = {
            class: { name: "class", type: "Derived", numchild: "1", value: "{...}" },
            public: { name: "class.public", exp: "public", numchild: "3" },
            value: { name: "class.public.value", exp: "value", type: "int", numchild: "0", value: "11" },
            anonymousA: {
                name: "class.public.anonymousA",
                exp: "",
                type: "union {...}",
                numchild: "1",
                value: "{...}"
            },
            anonymousB: {
                name: "class.public.anonymousB",
                exp: "",
                type: "struct {...}",
                numchild: "1",
                value: "{...}"
            }
        };
    }
    async command(command) {
        this.commands.push(command);
        if (command.startsWith("-var-create")) return this.items.class;
        if (command.startsWith("-var-list-children")) {
            const [, name, start, end] = command.match(/--all-values "([^"]+)" (\d+) (\d+)$/);
            const items =
                name === "class"
                    ? [this.items.public]
                    : [this.items.value, this.items.anonymousA, this.items.anonymousB];
            return { children: items.slice(Number(start), Number(end)).map((child) => ({ child })) };
        }
        if (command.startsWith("-var-info-path-expression")) return { path_expr: "classObject.value" };
        if (command.startsWith("-data-evaluate-expression")) return { value: "536870912" };
        if (command.startsWith("-var-show-attributes")) return { attr: "editable" };
        if (command.startsWith("-var-assign")) return { value: "22" };
        return {};
    }
}

(async () => {
    const mi = new ClassMi();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    adapter.sendEvent = () => {};
    adapter.ready = true;
    adapter.config.prettyPrintingMode = "raw";
    const expand = async (variable, args = {}) =>
        (await adapter.handle("variables", { variablesReference: variable.variablesReference, ...args })).variables;
    const root = await adapter.handle("evaluate", { expression: "classObject" });
    const groups = await expand(root);
    assert.strictEqual(groups[0].name, "public");
    assert.strictEqual(groups[0].value, "3 members");
    assert.strictEqual(groups[0].evaluateName, undefined);
    assert.strictEqual(groups[0].memoryReference, undefined);
    assert.strictEqual(groups[0].presentationHint.kind, "virtual");
    assert(!mi.commands.some((command) => command.includes('path-expression "class.public"')));
    await assert.rejects(
        adapter.handle("setVariable", { variablesReference: root.variablesReference, name: "public", value: "0" }),
        /read only/
    );
    const page = await expand(groups[0], { start: 1, count: 1 });
    assert.strictEqual(page[0].name, "<anonymous union 1>");
    assert.strictEqual(page[0].presentationHint.visibility, "public");
    const full = await expand(groups[0]);
    assert.deepStrictEqual(
        full.map((item) => item.name),
        ["value", "<anonymous union 1>", "<anonymous member 2>"]
    );
    assert.strictEqual(full[1].variablesReference, page[0].variablesReference);
    assert(
        !full[0].presentationHint.attributes?.includes("readOnly"),
        "visibility groups do not lock editable members"
    );
    assert.strictEqual(
        (
            await adapter.handle("setVariable", {
                variablesReference: groups[0].variablesReference,
                name: "value",
                value: "22"
            })
        ).value,
        "22"
    );
    mi.items.class.type = "const Derived";
    adapter.variableStore.reset();
    const constRoot = await adapter.handle("evaluate", { expression: "constClassObject" });
    const constGroup = (await expand(constRoot))[0];
    const constMember = (await expand(constGroup))[0];
    assert(constMember.presentationHint.attributes.includes("readOnly"));
    await assert.rejects(
        adapter.handle("setVariable", {
            variablesReference: constGroup.variablesReference,
            name: "value",
            value: "22"
        }),
        /read only/
    );
    console.log("C++ visibility groups, stable anonymous paging, member writes and const inheritance passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
