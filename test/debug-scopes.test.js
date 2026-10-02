"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { EmberDebugSession } = require("../src/debug/session");
const { SymbolDirectory, debugSymbols, nmSymbols } = require("../src/debug/symbolDirectory");
const { safePath } = require("../src/debug/stl");

const catalog = {
    symbols: {
        debug: [
            {
                fullname: "C:\\src\\a.cpp",
                symbols: [
                    { name: "counter", description: "static int counter;", type: "int" },
                    { name: "app::text[abi:cxx11]", type: "std::string" },
                    ...Array.from({ length: 205 }, (_, index) => ({ name: `global${index}`, type: "int" }))
                ]
            },
            { fullname: "C:/src/b.cpp", symbols: { name: "counter", description: "static int counter;", type: "int" } }
        ]
    }
};

class ScopeMi extends EventEmitter {
    constructor() {
        super();
        this.commands = [];
        this.id = 0;
        this.value = "3";
    }
    async command(command) {
        this.commands.push(command);
        if (this.resumeOn && command.startsWith(this.resumeOn))
            this.emit("record", { kind: "*", class: "running", data: {} });
        if (command === "-symbol-info-variables") return catalog;
        if (command.startsWith("-var-create"))
            return { name: `var${++this.id}`, value: this.value, type: "int", numchild: "0" };
        if (command.startsWith("-var-info-path-expression")) return { path_expr: "global0" };
        if (command.startsWith("-var-show-attributes")) return { attr: this.readOnly ? "noneditable" : "editable" };
        if (command.startsWith("-var-assign")) {
            this.value = "7";
            return { value: this.value };
        }
        if (command === "-data-list-register-names") return { "register-names": ["r0", "", "pc"] };
        if (command.startsWith("-data-list-register-values"))
            return {
                "register-values": [
                    { number: "0", value: "0x7" },
                    { number: "2", value: "0x8000000" }
                ]
            };
        if (command.startsWith("-data-evaluate-expression"))
            return { value: command.includes("unsigned long long") ? "536870912" : "7" };
        return {};
    }
}

function setup() {
    const mi = new ScopeMi();
    const adapter = new EmberDebugSession({ mi });
    adapter.setRunAsServer(true);
    adapter.ready = true;
    adapter.config.enablePrettyPrinting = false;
    const events = [];
    adapter.sendEvent = (event) => events.push(event);
    const frameId = adapter.handleFor({ kind: "frame", thread: 1, level: 0, file: "C:/src/a.cpp" });
    return { mi, adapter, frameId, events };
}

(async () => {
    const entries = debugSymbols(catalog);
    assert.deepStrictEqual(
        entries.filter((entry) => entry.isStatic).map((entry) => entry.expression),
        ["'C:/src/a.cpp'::counter", "'C:/src/b.cpp'::counter"]
    );
    assert(entries.some((entry) => entry.expression === "::app::text"));
    assert.strictEqual(safePath("'C:/src/a.cpp'::counter"), "'C:/src/a.cpp'::counter");
    assert.throws(() => safePath("'C:/src/a.cpp'::danger()"), /side-effect/);
    assert.throws(() => safePath("global0++"), /side-effect/);
    const fallback = nmSymbols(
        "20000000 00000004 b counter\tC:/src/a.cpp:3\n20000004 00000004 b orphan\n20000008 00000004 B app::text[abi:cxx11]\n"
    );
    assert.strictEqual(fallback.length, 2);
    assert.strictEqual(fallback[1].expression, "::app::text");
    assert.strictEqual(nmSymbols("20AB0000 00000004 u inlineValue")[0].isStatic, false);
    assert.strictEqual(nmSymbols("20AB0000 00000004 v weakObject")[0].isStatic, false);
    let calls = 0;
    const old = new SymbolDirectory(
        {
            config: { objdumpPath: "arm-objdump.exe", executable: "app.elf" },
            mi: {
                command: async () => {
                    throw new Error("Undefined MI command: symbol-info-variables");
                }
            },
            variableDiagnostic: () => {}
        },
        async (file, args) => {
            calls++;
            assert.strictEqual(file, "arm-nm.exe");
            assert(args.includes("app.elf"));
            return { stdout: "20000000 00000004 B global" };
        }
    );
    assert.strictEqual((await old.variables("globals")).length, 1);
    await old.load();
    assert.strictEqual(calls, 1);
    old.reset();
    await old.load();
    assert.strictEqual(calls, 2);
    const failed = new SymbolDirectory({
        mi: {
            command: async () => {
                throw new Error("GDB transport closed");
            }
        }
    });
    await assert.rejects(failed.load(), /transport closed/);

    const { adapter, mi, frameId, events } = setup();
    const capabilities = await adapter.handle("initialize", { supportsInvalidatedEvent: true });
    assert(capabilities.supportsSetExpression && capabilities.supportsEvaluateForHovers);
    const scopes = (await adapter.handle("scopes", { frameId })).scopes;
    assert.strictEqual(scopes.length, 4);
    assert.strictEqual(mi.commands.length, 0, "scopes remain lazy");
    const globalRef = scopes[1].variablesReference;
    const first = (await adapter.handle("variables", { variablesReference: globalRef })).variables;
    assert.strictEqual(first.length, 101);
    assert.strictEqual(first[0].evaluateName, "::app::text");
    assert.strictEqual(first[0].memoryReference, "0x20000000");
    assert.strictEqual(mi.commands.filter((command) => command.startsWith("-var-create")).length, 100);
    const next = (await adapter.handle("variables", { variablesReference: first.at(-1).variablesReference })).variables;
    assert.strictEqual(next.length, 101);
    const statics = (await adapter.handle("variables", { variablesReference: scopes[2].variablesReference })).variables;
    assert.strictEqual(statics.length, 1);
    assert.strictEqual(statics[0].evaluateName, "'C:/src/a.cpp'::counter");
    assert.strictEqual(statics[0].memoryReference, "0x20000000");
    const edited = await adapter.handle("setExpression", { frameId, expression: "global0", value: "7" });
    assert.strictEqual(edited.value, "7");
    assert(events.some((event) => event.event === "invalidated"));
    await assert.rejects(adapter.handle("variables", { variablesReference: globalRef }), /[Ii]nvalid|[Ss]tale/);
    mi.readOnly = true;
    await assert.rejects(adapter.handle("setExpression", { expression: "global0", value: "8" }), /not editable/);
    await assert.rejects(adapter.handle("evaluate", { expression: "" }), /nonempty/);
    await assert.rejects(adapter.handle("evaluate", { expression: "global0++", context: "hover" }), /side-effect/);

    const registers = setup();
    const registerRef = (await registers.adapter.handle("scopes", { frameId: registers.frameId })).scopes[3]
        .variablesReference;
    const page = (await registers.adapter.handle("variables", { variablesReference: registerRef })).variables;
    assert.deepStrictEqual(
        page.map((item) => item.name),
        ["r0", "pc"]
    );
    assert(registers.mi.commands.includes("-data-list-register-values x 0 2"));
    await assert.rejects(
        registers.adapter.handle("setVariable", { variablesReference: registerRef, name: "missing", value: "7" }),
        /unavailable/
    );
    const write = await registers.adapter.handle("setVariable", {
        variablesReference: registerRef,
        name: "r0",
        value: "7"
    });
    assert.strictEqual(write.value, "0x7");
    assert(registers.mi.commands.includes("-data-write-register-values x 0 7"));

    for (const prefix of ["-symbol-info-variables", "-data-list-register-values", "-stack-select-frame"]) {
        const interrupted = setup();
        interrupted.mi.resumeOn = prefix;
        const all = (await interrupted.adapter.handle("scopes", { frameId: interrupted.frameId })).scopes;
        await assert.rejects(
            interrupted.adapter.handle("variables", {
                variablesReference: all[prefix.includes("register") ? 3 : 1].variablesReference
            }),
            /paused|running|[Ss]tale/
        );
        assert(!interrupted.mi.commands.some((command) => command.startsWith("-var-assign")));
    }
    console.log("Debug scopes, qualified symbol identity, paging, expression writes and register tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
