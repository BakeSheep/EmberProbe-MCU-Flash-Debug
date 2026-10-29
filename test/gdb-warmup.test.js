"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const { GdbWarmup, REWARM_MS } = require("../src/services/gdbWarmup");
const { loadProvider } = require("./helpers/load-provider");

const GDB = "C:\\Arm\\bin\\arm-none-eabi-gdb.exe";

function fakeSpawn() {
    const calls = [];
    const spawnProcess = (file, args, options) => {
        const child = new EventEmitter();
        child.killed = false;
        child.kill = () => {
            child.killed = true;
            child.emit("exit", null);
        };
        child.unref = () => {
            child.unrefed = true;
        };
        calls.push({ file, args, options, child });
        return child;
    };
    return { calls, spawnProcess };
}

// Warm-up timers are unref'd for the extension host; keep this process alive until the checks finish.
const keepAlive = setInterval(() => {}, 1000);
(async () => {
    {
        let now = 1000;
        const { calls, spawnProcess } = fakeSpawn();
        const warmup = new GdbWarmup({ spawnProcess, now: () => now, platform: "win32" });
        const first = warmup.warm(GDB);
        assert.deepStrictEqual(warmup.snapshot(GDB), { state: "pending", durationMs: 0 });
        // Concurrent requests for the same executable share one process, whatever the path casing.
        assert.strictEqual(warmup.warm(GDB.toUpperCase()), first);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].file, GDB);
        assert.deepStrictEqual(calls[0].args, ["--version"]);
        assert.deepStrictEqual(calls[0].options, { stdio: "ignore", windowsHide: true, shell: false });
        assert(calls[0].child.unrefed, "a warm-up never keeps the extension host alive");
        calls[0].child.emit("exit", 0);
        assert.strictEqual(await first, true);
        assert.deepStrictEqual(warmup.snapshot(GDB), { state: "ready", durationMs: 0 });
        assert.strictEqual(await warmup.warm(GDB), true);
        assert.strictEqual(calls.length, 1, "a recent warm-up is reused");
        now += REWARM_MS;
        const again = warmup.warm(GDB);
        assert.strictEqual(calls.length, 2, "an expired warm-up runs again");
        calls[1].child.emit("exit", 1);
        assert.strictEqual(await again, false);
        const retry = warmup.warm(GDB);
        assert.strictEqual(calls.length, 3, "a failed warm-up is not remembered");
        calls[2].child.emit("error", new Error("ENOENT"));
        assert.strictEqual(await retry, false);
        assert.strictEqual(warmup.snapshot(GDB).state, "failed");
    }
    {
        const { calls, spawnProcess } = fakeSpawn();
        for (const [platform, gdbPath] of [
            ["linux", "/opt/arm/bin/arm-none-eabi-gdb"],
            ["darwin", "/opt/arm/bin/arm-none-eabi-gdb"],
            ["win32", "arm-none-eabi-gdb"],
            ["win32", undefined]
        ])
            assert.strictEqual(await new GdbWarmup({ spawnProcess, platform }).warm(gdbPath), false);
        assert.strictEqual(calls.length, 0, "only absolute Windows executables are started");
        const throwing = new GdbWarmup({
            platform: "win32",
            spawnProcess: () => {
                throw new Error("spawn EACCES");
            }
        });
        assert.strictEqual(await throwing.warm(GDB), false);
    }
    {
        const { calls, spawnProcess } = fakeSpawn();
        const bounded = new GdbWarmup({ spawnProcess, platform: "win32", budgetMs: 5 });
        assert.strictEqual(await bounded.warm(GDB), false);
        assert(calls[0].child.killed, "a hung warm-up is killed within its budget");
        const disposed = new GdbWarmup({ spawnProcess, platform: "win32" });
        const pending = disposed.warm(GDB);
        disposed.dispose();
        assert.strictEqual(await pending, false);
        assert(calls[1].child.killed, "dispose stops a running warm-up");
        assert.strictEqual(await disposed.warm(GDB), false);
        assert.strictEqual(calls.length, 2, "nothing starts after dispose");
    }
    {
        const { calls, spawnProcess } = fakeSpawn();
        const warmup = new GdbWarmup({ spawnProcess, platform: "win32", budgetMs: 5 });
        const waiting = warmup.warm(GDB);
        calls[0].child.kill = () => {
            calls[0].child.killed = true;
            return false;
        };
        assert.strictEqual(await waiting, false, "launch is bounded even when process exit is never confirmed");
        assert.strictEqual(warmup.snapshot(GDB).state, "failed");
        assert.strictEqual(warmup.warm(GDB), waiting, "an unconfirmed process is retained rather than duplicated");
        calls[0].child.emit("exit", 0);
        assert(!warmup.warmedAt.has(GDB.toLowerCase()), "a late clean exit cannot turn a timeout into success");
        const retry = warmup.warm(GDB);
        calls[1].child.emit("exit", 0);
        assert.strictEqual(await retry, true);
        warmup.dispose();
    }
    {
        // Activation scheduling: trusted workspaces with chosen firmware only, using the prompt-free lookup.
        const folder = { uri: { fsPath: "C:\\work", toString: () => "folder" } };
        const vscode = { workspace: { isTrusted: true } };
        const lookups = [];
        const Host = loadProvider(vscode, {
            "./services/debugToolPreflight": {
                ensureDebugTools: async () => null,
                findWarmupDebugTools: async (_vscode, target) => {
                    lookups.push(target);
                    return { gdbPath: GDB };
                }
            }
        });
        const warmed = [];
        const host = Object.create(Host.prototype);
        const values = new Map([["mcu.elfPath", "C:\\work\\build\\app.elf"]]);
        Object.assign(host, {
            _context: { workspaceState: { get: (key) => values.get(key) } },
            _commandContext: () => ({ folder }),
            _gdbWarmup: { warm: async (gdbPath) => warmed.push(gdbPath) },
            _gdbWarmupTimer: null,
            _shutdownPromise: null
        });
        const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
        host.scheduleGdbWarmup();
        await settle();
        assert.deepStrictEqual(warmed, [GDB]);
        assert.deepStrictEqual(lookups, [folder]);
        vscode.workspace.isTrusted = false;
        host.scheduleGdbWarmup(0);
        await settle();
        vscode.workspace.isTrusted = true;
        values.delete("mcu.elfPath");
        host.scheduleGdbWarmup(0);
        await settle();
        assert.strictEqual(warmed.length, 1, "untrusted or unconfigured workspaces never start GDB");
        values.set("mcu.elfPath", "C:\\work\\build\\app.elf");
        host.scheduleGdbWarmup(1000);
        assert(host._gdbWarmupTimer);
        host._gdbWarmup.dispose = () => {};
        clearTimeout(host._gdbWarmupTimer);
        host._gdbWarmupTimer = null;
        host.scheduleGdbWarmup(0);
        host._shutdownPromise = Promise.resolve();
        await settle();
        assert.strictEqual(warmed.length, 1, "shutdown cancels a pending warm-up");
    }
    console.log("GDB warm-up: Windows-only background start, dedupe, expiry, budget, dispose and trust gate passed");
})()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => clearInterval(keepAlive));
