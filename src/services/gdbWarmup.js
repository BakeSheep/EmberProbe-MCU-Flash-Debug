"use strict";

const path = require("path");
const { spawn } = require("child_process");

// Windows can need seconds to start a large GDB executable the first time after boot or a toolchain
// update (on-access scanning, cold file cache), and that start sits on the debug path while OpenOCD
// already holds the probe. A throwaway `--version` run pays it in the background instead.
const REWARM_MS = 10 * 60 * 1000;
const RUN_BUDGET_MS = 30000;

class GdbWarmup {
    constructor({ spawnProcess = spawn, now = Date.now, platform = process.platform, budgetMs = RUN_BUDGET_MS } = {}) {
        this.spawnProcess = spawnProcess;
        this.now = now;
        this.platform = platform;
        this.budgetMs = budgetMs;
        this.warmedAt = new Map();
        this.running = new Map();
        this.disposed = false;
    }
    // Resolves true once the executable started and exited cleanly; never rejects.
    warm(gdbPath) {
        if (
            this.disposed ||
            this.platform !== "win32" ||
            typeof gdbPath !== "string" ||
            !path.win32.isAbsolute(gdbPath)
        )
            return Promise.resolve(false);
        const key = path.win32.normalize(gdbPath).toLowerCase();
        const active = this.running.get(key);
        if (active) return active.done;
        const last = this.warmedAt.get(key);
        if (last !== undefined && this.now() - last < REWARM_MS) return Promise.resolve(true);
        const entry = { child: null, done: null };
        entry.done = new Promise((resolve) => {
            try {
                entry.child = this.spawnProcess(gdbPath, ["--version"], {
                    stdio: "ignore",
                    windowsHide: true,
                    shell: false
                });
            } catch {
                resolve(false);
                return;
            }
            const timer = setTimeout(() => entry.child.kill(), this.budgetMs);
            timer.unref?.();
            const finish = (ok) => {
                clearTimeout(timer);
                resolve(ok);
            };
            entry.child.once("error", () => finish(false));
            entry.child.once("exit", (code) => finish(code === 0));
            entry.child.unref?.();
        }).then((ok) => {
            this.running.delete(key);
            if (ok && !this.disposed) this.warmedAt.set(key, this.now());
            return ok;
        });
        this.running.set(key, entry);
        return entry.done;
    }
    dispose() {
        this.disposed = true;
        for (const { child } of this.running.values()) {
            try {
                child?.kill();
            } catch {
                /* The process may already have exited. */
            }
        }
    }
}

module.exports = { GdbWarmup, REWARM_MS };
