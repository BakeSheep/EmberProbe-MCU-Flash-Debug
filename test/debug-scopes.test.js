"use strict";

const { scenario } = require("./helpers/scenario");

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { EmberDebugSession } = require("../src/debug/session");
const { SymbolDirectory, debugSymbols, nmSymbols, sourceKey } = require("../src/debug/symbolDirectory");
const { safePath } = require("../src/debug/stl");

const catalog = {
    symbols: {
        debug: [
            {
                fullname: "C:\\src\\a.cpp",
                symbols: [
                    { name: "counter", description: "static int counter;", type: "int" },
                    { name: "app::text[abi:cxx11]", type: "std::string" },
                    {
                        name: "(anonymous namespace)::events",
                        description: "static int (anonymous namespace)::events;",
                        type: "int"
                    },
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
        ["'C:/src/a.cpp'::counter", "'C:/src/a.cpp'::'(anonymous namespace)::events'", "'C:/src/b.cpp'::counter"]
    );
    // GDB rejects `::app::text` in C frames and resolves `app::text` relative to the frame's namespace.
    assert(entries.some((entry) => entry.expression === "'C:/src/a.cpp'::'app::text'"));
    assert(entries.some((entry) => entry.expression === "::global0"));
    assert.strictEqual(safePath("'C:/src/a.cpp'::counter"), "'C:/src/a.cpp'::counter");
    for (const path of [
        "'C:/src/a.cpp'::'app::text'",
        "('C:/src/a.cpp'::counter).field",
        "('C:/src/a.cpp'::'(anonymous namespace)::events').field"
    ])
        assert.strictEqual(safePath(path), path);
    assert.throws(() => safePath("('C:/src/a.cpp'::counter).danger()"), /side-effect/);
    assert.throws(() => safePath("'C:/src/a.cpp'::danger()"), /side-effect/);
    assert.throws(() => safePath("global0++"), /side-effect/);
    const fallback = nmSymbols(
        "20000000 00000004 b counter\tC:/src/a.cpp:3\n20000004 00000004 b orphan\n20000008 00000004 B app::text[abi:cxx11]\n"
    );
    assert.strictEqual(fallback.length, 2);
    assert.strictEqual(fallback[1].expression, "::app::text", "without a source file only `::` can anchor the name");
    assert.strictEqual(
        nmSymbols("20000008 00000004 B AppConfig::balance	C:/src/config.hpp:46")[0].expression,
        "'C:/src/config.hpp'::'AppConfig::balance'"
    );
    // A Windows-built ELF read on Linux: nm and GDB prefix comp_dir to the recorded drive path, and
    // GDB scopes resolve only the recorded name (observed with arm-none-eabi 15.2 in WSL).
    assert.strictEqual(
        nmSymbols("20002730 00000004 b xSchedulerRunning\tC:\\fw\\build\\Debug/C:/fw/Middlewares/tasks.c:369")[0]
            .expression,
        "'C:/fw/Middlewares/tasks.c'::xSchedulerRunning"
    );
    assert.strictEqual(
        debugSymbols({
            symbols: {
                debug: {
                    filename: "C:/fw/Middlewares/tasks.c",
                    fullname: "C:/fw/build/Debug/C:/fw/Middlewares/tasks.c",
                    symbols: { name: "xSchedulerRunning", description: "static volatile BaseType_t x;" }
                }
            }
        })[0].file,
        "C:/fw/Middlewares/tasks.c"
    );
    for (const [input, expected] of [
        ["C:\\fw\\src\\x.c", "C:/fw/src/x.c"],
        ["C:/fw/build/../Core/x.c", "C:/fw/Core/x.c"],
        ["/home/me/fw/build/../Core/x.c", "/home/me/fw/Core/x.c"],
        ["build/../Core/main.c", "Core/main.c"],
        ["//server/share/x.c", "//server/share/x.c"],
        ["", ""]
    ])
        assert.strictEqual(sourceKey(input), expected, input);
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
    assert.strictEqual(first[0].evaluateName, "'C:/src/a.cpp'::'app::text'");
    assert.strictEqual(first[0].memoryReference, "0x20000000");
    assert.strictEqual(mi.commands.filter((command) => command.startsWith("-var-create")).length, 100);
    const next = (await adapter.handle("variables", { variablesReference: first.at(-1).variablesReference })).variables;
    assert.strictEqual(next.length, 101);
    const statics = (await adapter.handle("variables", { variablesReference: scopes[2].variablesReference })).variables;
    assert.deepStrictEqual(
        statics.map((item) => [item.evaluateName, item.memoryReference]),
        [
            ["'C:/src/a.cpp'::'(anonymous namespace)::events'", "0x20000000"],
            ["'C:/src/a.cpp'::counter", "0x20000000"]
        ]
    );
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

    await scenario("Qualify globals, bind addresses to frames and invalidate successful memory writes", async () => {
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
        assert.deepStrictEqual(events.find((event) => event.event === "invalidated").body.areas, [
            "stacks",
            "variables"
        ]);
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
    });

    await scenario("Build a single-image directory from nm without the GDB catalog", async () => {
        const { nmExecutable, sourceKey, CATALOG_TIMEOUT_MS } = require("../src/debug/symbolDirectory");
        assert.strictEqual(
            nmExecutable({ gdbPath: "C:/tc/bin/arm-none-eabi-gdb.exe" }),
            "C:/tc/bin/arm-none-eabi-nm.exe"
        );
        assert.strictEqual(nmExecutable({ gdbPath: "/usr/bin/gdb" }), "/usr/bin/nm");
        assert.strictEqual(nmExecutable({ gdbPath: "gdb-multiarch" }), "");
        assert.strictEqual(nmExecutable({ nmPath: "nm", gdbPath: "x-gdb" }), "nm");
        assert.strictEqual(sourceKey("C:\\proj\\build/../Core/Src/a.c"), "C:/proj/Core/Src/a.c");
        assert.strictEqual(sourceKey("\\\\server\\share\\x/../a.c"), "//server/share/a.c");

        const images = fs.mkdtempSync(path.join(os.tmpdir(), "ep-nm-directory-"));
        const elf = path.join(images, "app.elf");
        fs.writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]));
        const { adapter, mi } = setup();
        adapter.config.executable = elf;
        adapter.config.gdbPath = "C:/tc/bin/arm-none-eabi-gdb.exe";
        const diagnostics = [];
        adapter.variableDiagnostic = (message) => diagnostics.push(message);
        const runs = [];
        let nmResult = {
            stdout: [
                "20000000 00000004 B global0\tC:/proj/build/../Core/Src/a.c:2",
                "20000004 00000004 b counter\tC:\\proj\\build/../Core/Src/a.c:3",
                "20000008 00000004 b counter\tC:/proj/Core/Src/b.c:3",
                "2000000c 00000004 b cnt.0\tC:/proj/Core/Src/a.c:9",
                "08000100 0000000c R typeinfo for app::Sensor",
                "08000200 00000010 V vtable for app::Sensor",
                "20000010 00000004 B errno",
                "08000000 00000020 T main\tC:/proj/Core/Src/a.c:12"
            ].join("\n")
        };
        adapter.symbolDirectory.run = async (file, args, options) => {
            runs.push({ file, args, options });
            if (nmResult instanceof Error) throw nmResult;
            return nmResult;
        };
        const directory = await adapter.symbolDirectory.load();
        assert.deepStrictEqual(runs[0].args, ["--defined-only", "-S", "-l", "-C", elf]);
        assert.strictEqual(runs[0].file, "C:/tc/bin/arm-none-eabi-nm.exe");
        assert(runs[0].options.timeout <= 10000 && runs[0].options.windowsHide);
        assert(!mi.commands.includes("-symbol-info-variables"), "a single image must not expand GDB's catalog");
        assert.deepStrictEqual(
            directory.map((entry) => entry.name),
            ["counter", "counter", "errno", "global0"],
            "local statics and C++ ABI objects are excluded"
        );
        assert(directory.every((entry) => entry.image === elf.replace(/\\/g, "/")));
        const frame = adapter.handleFor({ kind: "frame", thread: 1, level: 0, file: "C:\\proj\\Core\\Src\\a.c" });
        const scopes = (await adapter.handle("scopes", { frameId: frame })).scopes;
        const statics = (await adapter.handle("variables", { variablesReference: scopes[2].variablesReference }))
            .variables;
        assert.deepStrictEqual(
            statics.map((item) => item.evaluateName),
            ["'C:/proj/Core/Src/a.c'::counter"],
            "nm's unnormalized comp_dir path matches GDB's frame file"
        );

        // A failed nm listing keeps GDB alive and uses the catalog with its own timeout.
        const timeouts = [];
        const command = mi.command.bind(mi);
        mi.command = (text, timeout) => {
            if (text === "-symbol-info-variables") timeouts.push(timeout);
            return command(text, timeout);
        };
        nmResult = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        adapter.symbolDirectory.reset();
        const catalogEntries = await adapter.symbolDirectory.load();
        assert.deepStrictEqual(timeouts, [CATALOG_TIMEOUT_MS]);
        assert(catalogEntries.some((entry) => entry.name === "global204"));
        assert(diagnostics.some((message) => /nm symbol directory unavailable \(spawn ENOENT\)/.test(message)));

        // nm cannot size non-ELF (PE/COFF) objects, so those images never take the nm path.
        const pe = path.join(images, "host.exe");
        fs.writeFileSync(pe, "MZ");
        adapter.config.executable = pe;
        adapter.symbolDirectory.reset();
        const before = runs.length;
        assert((await adapter.symbolDirectory.load()).length > 0);
        assert.strictEqual(runs.length, before);
        assert.strictEqual(timeouts.length, 2);
        fs.rmSync(images, { recursive: true, force: true });
    });

    console.log("Debug scopes, qualified symbol identity, paging, expression writes and register tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
