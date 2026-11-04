"use strict";
const assert = require("assert");
const { scenario } = require("./helpers/scenario");
const { resolvePrettyPrinting, initializePrettyPrinting } = require("../src/services/prettyPrinting");
const { validateDebugConfiguration } = require("../src/services/debugConfiguration");
(async () => {
    scenario("Use only explicit display modes and printer files", () => {
        assert.strictEqual(resolvePrettyPrinting().prettyPrintingMode, "builtin");
        assert.strictEqual(resolvePrettyPrinting({ prettyPrintingMode: "raw" }).prettyPrintingMode, "raw");
        const obsolete = { enablePrettyPrinting: false, prettyPrinterPath: "old" };
        assert.deepStrictEqual(resolvePrettyPrinting(obsolete), {
            prettyPrintingMode: "builtin",
            prettyPrinterFiles: []
        });
        assert.strictEqual(resolvePrettyPrinting({}, obsolete).prettyPrintingMode, "builtin");
        assert.strictEqual(
            validateDebugConfiguration(
                { request: "attach", prettyPrintingMode: "raw" },
                { uri: { fsPath: process.cwd() } }
            ).prettyPrintingMode,
            "raw"
        );
    });
    const commands = [],
        reports = [];
    const mi = {
        command: async (command) => {
            commands.push(command);
            return {};
        }
    };
    assert.strictEqual(await initializePrettyPrinting(mi, {}, (value) => reports.push(value)), true);
    assert.deepStrictEqual(commands, [
        "-gdb-set auto-load off",
        "-gdb-set print raw-values on",
        "-gdb-set may-call-functions off",
        "-gdb-set print object on"
    ]);
    assert.strictEqual(
        await initializePrettyPrinting(mi, { prettyPrintingMode: "raw" }, (value) => reports.push(value)),
        false
    );
    assert.strictEqual(reports.length, 0);
    assert(!commands.some((command) => /python|visualizer|enable-pretty|list-features/.test(command)));
    await assert.rejects(
        initializePrettyPrinting(
            {
                command: async () => {
                    throw new Error("closed");
                }
            },
            {},
            () => {}
        ),
        /closed/
    );
    console.log("Built-in STL settings and script-free GDB initialization passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
