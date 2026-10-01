"use strict";
const assert = require("assert");
const { resolvePrettyPrinting, initializePrettyPrinting } = require("../src/services/prettyPrinting");
const { validateDebugConfiguration } = require("../src/services/debugConfiguration");
(async () => {
    assert.strictEqual(resolvePrettyPrinting().enablePrettyPrinting, true);
    assert.strictEqual(
        resolvePrettyPrinting({ enablePrettyPrinting: false }, { enablePrettyPrinting: true }).enablePrettyPrinting,
        false
    );
    assert.strictEqual(
        resolvePrettyPrinting({ prettyPrinterPath: "" }, { prettyPrinterPath: "old" }).prettyPrinterPath,
        ""
    );
    for (const config of [{ enablePrettyPrinting: "true" }, { prettyPrinterPath: [] }])
        assert.throws(() => resolvePrettyPrinting(config));
    assert.strictEqual(
        validateDebugConfiguration({ request: "attach", prettyPrinterPath: "old" }, { uri: { fsPath: process.cwd() } })
            .prettyPrinterPath,
        "old"
    );
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
        await initializePrettyPrinting(mi, { enablePrettyPrinting: false, prettyPrinterPath: "old" }, (value) =>
            reports.push(value)
        ),
        false
    );
    assert.strictEqual(reports.length, 1);
    assert.match(reports[0], /deprecated and ignored/);
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
