"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { scenario } = require("./helpers/scenario");
const { runCli, parseDocument, cubeEnvironment } = require("../src/services/cubemx2Cli");

const bundle = { node: "/bundle/node", cli: "/bundle/dist/bin.js", env: { CUBE_DCM: "/bundle/cube-dcm.json" } };

// A CLI process that prints the given output and exits, or never exits (exit: null).
function fakeSpawn(behaviour, calls = []) {
    return (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => setImmediate(() => child.emit("close", null));
        setImmediate(() => {
            if (behaviour.stdout) child.stdout.emit("data", Buffer.from(behaviour.stdout));
            if (behaviour.stderr) child.stderr.emit("data", Buffer.from(behaviour.stderr));
            if (behaviour.exit !== null) child.emit("close", behaviour.exit ?? 0);
        });
        return child;
    };
}

(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx2-cli-"));
    try {
        await scenario("Find the JSON document after warnings on stdout or stderr", () => {
            assert.deepStrictEqual(parseDocument('warning line\n{\n  "status": "success",\n  "data": [1]\n}\n'), {
                status: "success",
                data: [1]
            });
            assert.strictEqual(parseDocument("{ not json\nplain"), null);
            assert.strictEqual(parseDocument('{"other": 1}'), null);
        });

        await scenario("Strip Electron and Node options inherited from the extension host", () => {
            const env = cubeEnvironment(bundle, {
                PATH: "/bin",
                ELECTRON_RUN_AS_NODE: "1",
                electron_no_attach_console: "1",
                NODE_OPTIONS: "--require x"
            });
            assert.deepStrictEqual(env, { PATH: "/bin", CUBE_DCM: "/bundle/cube-dcm.json" });
        });

        await scenario("Run a command with the project and port EmberProbe owns, and return its data", async () => {
            const calls = [];
            const logPath = path.join(dir, "cli.log");
            const data = await runCli(bundle, ["peripherals", "list"], {
                port: 4711,
                project: "/stage/p.ioc2",
                logPath,
                spawn: fakeSpawn({ stdout: '{"status":"success","data":["RCC"]}' }, calls)
            });
            assert.deepStrictEqual(data, ["RCC"]);
            assert.strictEqual(calls[0].command, "/bundle/node");
            assert.deepStrictEqual(calls[0].args, [
                "/bundle/dist/bin.js",
                "peripherals",
                "list",
                "-p",
                "/stage/p.ioc2",
                "--port",
                "4711"
            ]);
            assert.strictEqual(calls[0].options.shell, false);
            assert.strictEqual(calls[0].options.env.CUBE_DCM, "/bundle/cube-dcm.json");
            assert.match(await fs.readFile(logPath, "utf8"), /\$ peripherals list\n\[exit 0/);
        });

        await scenario("Report CLI errors from either stream and classify missing packs", async () => {
            const fails = (behaviour, code, pattern) =>
                assert.rejects(
                    runCli(bundle, ["peripherals", "view"], { port: 1, spawn: fakeSpawn(behaviour) }),
                    (error) => {
                        assert.strictEqual(error.code, code);
                        assert.match(error.message, pattern);
                        return true;
                    }
                );
            await fails(
                {
                    stderr: '{\n "status": "error",\n "errorMessage": "Configurable element with name \'NOPE\' not found."\n}',
                    exit: 1
                },
                "CUBEMX2_COMMAND_FAILED",
                /NOPE/
            );
            await fails(
                { stdout: '{"status":"error","errorMessage":"destination is not empty"}', exit: 1 },
                "CUBEMX2_COMMAND_FAILED",
                /destination/
            );
            await fails({ stdout: "fetch failed\n", exit: 1 }, "CUBEMX2_COMMAND_FAILED", /fetch failed/);
            await fails({ exit: 3 }, "CUBEMX2_COMMAND_FAILED", /code 3/);
            // A success document with a failing exit code is not success.
            await fails({ stdout: '{"status":"success"}', exit: 1 }, "CUBEMX2_COMMAND_FAILED", /success|code 1/);
            await fails(
                {
                    stdout: '{"status":"error","errorMessage":"Pack STMicroelectronics.stm32c5xx_dfp is not installed"}',
                    exit: 1
                },
                "CUBEMX2_PACK_MISSING",
                /not installed/
            );
        });

        await scenario("Stop hung, oversized and cancelled commands", async () => {
            await assert.rejects(
                runCli(bundle, ["clock", "get-clocks"], { port: 1, timeoutMs: 20, spawn: fakeSpawn({ exit: null }) }),
                { code: "CUBEMX2_TIMEOUT" }
            );
            await assert.rejects(
                runCli(bundle, ["pinout", "all-pins"], {
                    port: 1,
                    spawn: fakeSpawn({ stdout: "x".repeat(16 * 1024 * 1024 + 1), exit: null })
                }),
                { code: "CUBEMX2_OUTPUT_TOO_LARGE" }
            );
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(
                runCli(bundle, ["pinout", "all-pins"], {
                    port: 1,
                    signal: controller.signal,
                    spawn: fakeSpawn({ exit: null })
                }),
                { code: "CUBEMX_CANCELLED" }
            );
            await assert.rejects(
                runCli(bundle, ["x"], {
                    port: 1,
                    spawn: () => {
                        throw new Error("ENOENT");
                    }
                }),
                { code: "CUBEMX2_CLI_FAILED" }
            );
        });
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
    console.log("CubeMX2 CLI invocation, output parsing and failure classification passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
