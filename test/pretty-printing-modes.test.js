"use strict";
const assert = require("assert");
const path = require("path");
const {
    resolvePrettyPrinting,
    initializePrettyPrinting,
    configuredPrettyPrintingMode
} = require("../src/services/prettyPrinting");
const { validateDebugConfiguration } = require("../src/services/debugConfiguration");

(async () => {
    const script = path.resolve(__dirname, "fixtures/gdb-printers.py");
    assert.strictEqual(resolvePrettyPrinting({ enablePrettyPrinting: false }).prettyPrintingMode, "raw");
    assert.strictEqual(
        resolvePrettyPrinting({ enablePrettyPrinting: false, prettyPrintingMode: "gdb" }).prettyPrintingMode,
        "gdb"
    );
    assert.strictEqual(
        resolvePrettyPrinting({ prettyPrintingMode: "raw" }, { prettyPrintingMode: "gdb" }).prettyPrintingMode,
        "raw"
    );
    assert.strictEqual(
        configuredPrettyPrintingMode({ inspect: () => ({ defaultValue: "builtin" }), get: () => "builtin" }),
        undefined
    );
    assert.strictEqual(
        configuredPrettyPrintingMode({ inspect: () => ({ globalValue: "gdb" }), get: () => "gdb" }),
        "gdb"
    );
    assert.strictEqual(
        validateDebugConfiguration({ request: "attach" }, { uri: { fsPath: process.cwd() } }).prettyPrintingMode,
        undefined
    );
    const config = resolvePrettyPrinting(
        { prettyPrintingMode: "gdb", prettyPrinterFiles: ["gdb-printers.py"] },
        {},
        path.dirname(script)
    );
    assert.deepStrictEqual(config.prettyPrinterFiles, [script]);
    for (const invalid of [
        { prettyPrintingMode: "auto" },
        { prettyPrinterFiles: "printer.py" },
        { prettyPrinterFiles: ["\n"] },
        { prettyPrinterFiles: Array(33).fill(script) },
        { prettyPrintingMode: "gdb", prettyPrinterFiles: [__dirname] }
    ])
        assert.throws(() => resolvePrettyPrinting(invalid));
    assert.throws(
        () => resolvePrettyPrinting({ prettyPrintingMode: "gdb", prettyPrinterFiles: ["missing.py"] }),
        /ENOENT/
    );
    const commands = [],
        reports = [];
    const mi = {
        command: async (command) => {
            commands.push(command);
            if (command === "-list-features") return { features: mi.python ? ["python"] : [] };
            if (mi.failOn && command.includes(mi.failOn)) throw new Error("script failed");
            return {};
        },
        python: true,
        failOn: ""
    };
    assert.strictEqual(await initializePrettyPrinting(mi, config, (message) => reports.push(message)), false);
    assert.strictEqual(config.effectivePrettyPrintingMode, "gdb");
    assert(commands.at(-1) === "-enable-pretty-printing");
    assert(commands[0] === "-gdb-set auto-load off");
    assert(commands.some((command) => command.includes("compile(open(")));
    assert(reports.some((message) => message.includes("outside")));
    mi.python = false;
    const unavailable = { prettyPrintingMode: "gdb" };
    assert.strictEqual(await initializePrettyPrinting(mi, unavailable, (message) => reports.push(message)), true);
    assert.strictEqual(unavailable.effectivePrettyPrintingMode, "builtin");
    mi.python = true;
    mi.failOn = "compile(open(";
    const failed = { prettyPrintingMode: "gdb", prettyPrinterFiles: [script] };
    const before = commands.filter((command) => command === "-enable-pretty-printing").length;
    assert.strictEqual(await initializePrettyPrinting(mi, failed, (message) => reports.push(message)), true);
    assert.strictEqual(failed.effectivePrettyPrintingMode, "builtin");
    assert.strictEqual(commands.filter((command) => command === "-enable-pretty-printing").length, before);
    console.log(
        "Pretty-printing mode precedence, explicit scripts, Python detection and initialization fallback passed"
    );
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
