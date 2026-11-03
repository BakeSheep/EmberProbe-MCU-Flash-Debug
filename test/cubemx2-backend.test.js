"use strict";
const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { scenario } = require("./helpers/scenario");
const { startBackend, removeWorkingArea, killTree } = require("../src/services/cubemx2Backend");

const bundle = { backend: "/bundle/dist/stm32cubemx2", node: "/bundle/node", cli: "/bundle/dist/bin.js", env: {} };

// A backend process: prints its port (or not), and exits when shut down or killed as configured.
function fakeBackend({ output = "BACKEND_PORT 52318\n", exitOnShutdown = true, exitOnKill = true, exitEarly } = {}) {
    const state = { spawned: [], cli: [], kills: [] };
    let child;
    state.spawn = (command, args, options) => {
        state.spawned.push({ command, args, options });
        child = new EventEmitter();
        child.pid = 4242;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
            child.stderr.emit("data", Buffer.from("electron warning\n"));
            if (exitEarly !== undefined) child.emit("exit", exitEarly);
            else if (output) child.stdout.emit("data", Buffer.from(output));
        });
        return child;
    };
    state.runCli = async (_bundle, argv, options) => {
        state.cli.push({ argv, port: options.port });
        if (argv[0] === "shutdown" && exitOnShutdown) setImmediate(() => child.emit("exit", 0));
        return { ok: true };
    };
    state.execFile = (file, args, _options, callback) => {
        state.kills.push([file, ...args]);
        if (exitOnKill) setImmediate(() => child.emit("exit", 1));
        callback(null);
    };
    state.kill = (pid, signal) => {
        state.kills.push([pid, signal]);
        if (exitOnKill) setImmediate(() => child.emit("exit", null));
    };
    return state;
}

// Timers that fire on the next turn, so stop waits do not slow the test.
const quickClock = { setTimeout: (fn) => setImmediate(fn), clearTimeout: (handle) => clearImmediate(handle) };

(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cubemx2-backend-"));
    try {
        await scenario("Start a private guiless backend and address every CLI call to its port", async () => {
            const fake = fakeBackend();
            const userDataDir = path.join(dir, "user-data");
            const backend = await startBackend(bundle, {
                userDataDir,
                env: { CUBE_DCM: "x" },
                spawn: fake.spawn,
                runCli: fake.runCli,
                platform: "win32",
                execFile: fake.execFile
            });
            assert.strictEqual(backend.port, 52318);
            assert.strictEqual(fake.spawned[0].command, bundle.backend);
            assert.deepStrictEqual(fake.spawned[0].args.slice(0, 3), [
                "--guiless",
                "--allow-multiple-windows",
                "--no-sandbox"
            ]);
            assert.ok(fake.spawned[0].args.includes(`--user-data-dir=${userDataDir}`));
            assert.strictEqual(fake.spawned[0].options.shell, false);
            assert.strictEqual(fake.spawned[0].options.detached, false);
            assert.ok((await fs.stat(userDataDir)).isDirectory());
            await backend.run(["peripherals", "list"], { port: 1 });
            assert.deepStrictEqual(fake.cli[0], { argv: ["peripherals", "list"], port: 52318 });
            assert.strictEqual(await backend.close(), true);
            assert.deepStrictEqual(fake.cli[1].argv, ["shutdown"]);
            assert.deepStrictEqual(fake.kills, []);
        });

        await scenario("Kill the process tree when shutdown does not stop the backend", async () => {
            const fake = fakeBackend({ exitOnShutdown: false });
            const backend = await startBackend(bundle, {
                userDataDir: path.join(dir, "kill"),
                spawn: fake.spawn,
                runCli: fake.runCli,
                platform: "win32",
                execFile: fake.execFile,
                clock: quickClock
            });
            assert.strictEqual(await backend.close(), true);
            assert.deepStrictEqual(fake.kills, [["taskkill", "/PID", "4242", "/T", "/F"]]);

            const stuck = fakeBackend({ exitOnShutdown: false, exitOnKill: false });
            const logPath = path.join(dir, "stuck.log");
            const unconfirmed = await startBackend(bundle, {
                userDataDir: path.join(dir, "stuck"),
                spawn: stuck.spawn,
                runCli: stuck.runCli,
                platform: "linux",
                kill: stuck.kill,
                clock: quickClock,
                logPath
            });
            assert.strictEqual(stuck.spawned[0].options.detached, true);
            assert.strictEqual(await unconfirmed.close(), false);
            assert.deepStrictEqual(stuck.kills, [[-4242, "SIGKILL"]]);
            assert.match(await fs.readFile(logPath, "utf8"), /electron warning/);
        });

        await scenario(
            "Fail cleanly when the backend exits, stays silent, reports a bad port or is cancelled",
            async () => {
                const start = (fake, extra = {}) =>
                    startBackend(bundle, {
                        userDataDir: path.join(dir, "fail"),
                        spawn: fake.spawn,
                        runCli: fake.runCli,
                        platform: "win32",
                        execFile: fake.execFile,
                        ...extra
                    });
                await assert.rejects(start(fakeBackend({ exitEarly: 0 })), (error) => {
                    assert.strictEqual(error.code, "CUBEMX2_BACKEND_FAILED");
                    assert.match(error.message, /exited with code 0/);
                    return true;
                });
                const silent = fakeBackend({ output: "" });
                await assert.rejects(start(silent, { clock: quickClock }), /did not report its port/);
                assert.strictEqual(silent.kills.length, 1);
                await assert.rejects(start(fakeBackend({ output: "BACKEND_PORT 70000\n" })), /invalid port/);
                const controller = new AbortController();
                controller.abort();
                await assert.rejects(start(fakeBackend(), { signal: controller.signal }), { code: "CUBEMX_CANCELLED" });
                // Cancelled while waiting for the port.
                const waiting = new AbortController();
                const pending = fakeBackend({ output: "" });
                const cancelled = start(pending, { signal: waiting.signal });
                while (!pending.spawned.length) await new Promise((resolve) => setImmediate(resolve));
                waiting.abort();
                await assert.rejects(cancelled, { code: "CUBEMX_CANCELLED" });
                assert.strictEqual(pending.kills.length, 1);
                await assert.rejects(
                    start({
                        spawn: () => {
                            throw new Error("ENOENT");
                        }
                    }),
                    { code: "CUBEMX2_BACKEND_FAILED" }
                );
                await killTree(0, "win32");
            }
        );

        await scenario("Remove only the working area named after the staged project", async () => {
            const id = "11111111-2222-3333-4444-555555555555";
            const area = path.join(dir, "stm32cube", "working_area", id);
            await fs.mkdir(path.join(area, "nested"), { recursive: true });
            assert.strictEqual(await removeWorkingArea(path.join(area, "nested"), "other-id"), false);
            assert.strictEqual(await removeWorkingArea(path.join(area, "nested"), ""), false);
            assert.strictEqual(await removeWorkingArea(undefined, id), false);
            const foreign = path.join(dir, "elsewhere", id);
            await fs.mkdir(foreign, { recursive: true });
            assert.strictEqual(await removeWorkingArea(foreign, id), false);
            assert.ok((await fs.stat(foreign)).isDirectory());
            assert.strictEqual(await removeWorkingArea(path.join(area, "nested"), id), true);
            await assert.rejects(fs.stat(area), { code: "ENOENT" });
        });
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
    console.log("CubeMX2 backend lifecycle and working area cleanup passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
