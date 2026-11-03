"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scenario } = require("./helpers/scenario");
const { QUERY, MUTATING, MAX_OPERATIONS, commandArgs, operationList } = require("../src/services/cubemx2Commands");

(async () => {
    await scenario("Build argument vectors with values bound to their option", () => {
        assert.deepStrictEqual(commandArgs({ command: "peripherals  view", args: { peripheral: "USART1" } }), [
            "peripherals",
            "view",
            "--peripheral=USART1"
        ]);
        assert.deepStrictEqual(
            commandArgs(
                { command: "peripherals enable", args: { peripheral: "USART1", mode: "Async", override: true } },
                { mutating: true }
            ),
            ["peripherals", "enable", "--peripheral=USART1", "--mode=Async", "--override"]
        );
        // A value that looks like an option stays part of its own option.
        assert.deepStrictEqual(
            commandArgs({ command: "clock set-value", args: { id: "SYSCLK", value: "--force" } }, { mutating: true }),
            ["clock", "set-value", "--id=SYSCLK", "--value=--force"]
        );
        assert.deepStrictEqual(commandArgs({ command: "pinout pin", args: { pin: "PA9", short: false } }), [
            "pinout",
            "pin",
            "--pin=PA9"
        ]);
        assert.deepStrictEqual(commandArgs({ command: "nvic set-grouping", args: { value: 4 } }, { mutating: true }), [
            "nvic",
            "set-grouping",
            "--value=4"
        ]);
        assert.deepStrictEqual(commandArgs({ command: "ide-project build-target list" }), [
            "ide-project",
            "build-target",
            "list"
        ]);
    });

    await scenario("Reject commands and options outside the allowlist", () => {
        const rejects = (operation, options, pattern) =>
            assert.throws(
                () => commandArgs(operation, options),
                (error) => {
                    assert.strictEqual(error.code, "CUBEMX2_OPERATION_INVALID");
                    if (pattern) assert.match(error.message, pattern);
                    return true;
                }
            );
        // Mutations are refused where only queries may run.
        rejects({ command: "peripherals enable", args: { peripheral: "USART1" } }, {}, /cubemx\.prepare/);
        for (const command of [
            "ide-project generate",
            "project save",
            "project create-from-mcu",
            "project delete",
            "pack-manager install",
            "middleware enable-middleware",
            "utilities enable-utility",
            "ide-project set-destination",
            "ide-project set-modifiable-base-dir",
            "shutdown",
            ""
        ])
            rejects({ command }, { mutating: true }, /Unsupported CubeMX2 command/);
        rejects({ command: "peripherals view", args: { "project-path": "x.ioc2" } }, {}, /Unsupported option/);
        rejects({ command: "peripherals view", args: { port: "1" } }, {}, /Unsupported option/);
        rejects({ command: "peripherals view", args: { host: "example.com" } }, {}, /Unsupported option/);
        rejects({ command: "peripherals list", args: { enabled: "yes" } }, {}, /flag/);
        for (const value of ["", "a\nb", "a\0", "x".repeat(4097), { nested: 1 }, ["a"], Infinity])
            rejects({ command: "peripherals view", args: { peripheral: value } }, {}, /single-line/);
        rejects(null);
        rejects(["peripherals list"]);
        rejects({ command: "peripherals view", args: ["USART1"] });
    });

    await scenario("Bound operation lists and keep the excluded commands out of both tables", () => {
        const list = operationList([{ command: "peripherals list" }, { command: "clock get-clock-status" }]);
        assert.deepStrictEqual(
            list.map((item) => item.command),
            ["peripherals list", "clock get-clock-status"]
        );
        for (const value of [[], {}, Array(MAX_OPERATIONS + 1).fill({ command: "peripherals list" })])
            assert.throws(() => operationList(value), { code: "CUBEMX2_OPERATION_INVALID" });
        for (const command of [...Object.keys(QUERY), ...Object.keys(MUTATING)])
            assert.doesNotMatch(command, /generate|save|create|delete|pack-manager|enable-middleware|enable-utility/);
        for (const schema of [...Object.values(QUERY), ...Object.values(MUTATING)])
            for (const name of Object.keys(schema)) assert.doesNotMatch(name, /^(project-path|port|host|destination)$/);
    });

    await scenario("Skill script takes operations for --query and --prepare and a candidate hash for --start", () => {
        const { args, readOperations } = require("../skills/mcu-cubemx/scripts/cubemx");
        const ops = '[{"command":"peripherals list"}]';
        assert.strictEqual(args(["--query", "--operations", ops]).operations, ops);
        assert.strictEqual(args(["--prepare", "--operations-file", "ops.json"])["operations-file"], "ops.json");
        assert.strictEqual(args(["--start", "--candidate-hash", "ab"])["candidate-hash"], "ab");
        for (const argv of [
            ["--query"],
            ["--query", "--operations", ops, "--operations-file", "ops.json"],
            ["--inspect", "--operations", ops],
            ["--prepare", "--operations", ops, "--candidate", "next.ioc"],
            ["--prepare", "--candidate-hash", "ab"],
            ["--start", "--candidate", "next.ioc", "--candidate-hash", "ab"]
        ])
            assert.throws(() => args(argv), Error, argv.join(" "));
        assert.deepStrictEqual(readOperations(".", { operations: '{"command":"clock get-clock-status"}' }), [
            { command: "clock get-clock-status" }
        ]);
        assert.throws(() => readOperations(".", { operations: "peripherals list" }), {
            code: "CUBEMX2_OPERATION_INVALID"
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cubemx2-ops-"));
        try {
            fs.writeFileSync(path.join(dir, "ops.json"), ops);
            assert.deepStrictEqual(readOperations(dir, { "operations-file": "ops.json" }), JSON.parse(ops));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    console.log("CubeMX2 command allowlist and argument binding passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
