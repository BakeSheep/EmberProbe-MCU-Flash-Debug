"use strict";

const path = require("path");
const { spawn } = require("child_process");

// Windows can need seconds to start GDB cold. Complete a throwaway `--version` run in the background
// where possible, and settle any remaining preparation before a managed launch acquires the probe.
const REWARM_MS = 10 * 60 * 1000;
const RUN_BUDGET_MS = 30000;

class GdbWarmup {
    constructor({ spawnProcess = spawn, now = Date.now, platform = process.platform, budgetMs = RUN_BUDGET_MS } = {}) {
        this.spawnProcess = spawnProcess;
        this.now = now;
        this.platform = platform;
        this.budgetMs = budgetMs;
        this.warmedAt = new Map();
        this.results = new Map();
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
        const entry = { child: null, done: null, startedAt: this.now(), result: null, cancel: () => {} };
        entry.done = new Promise((resolve) => {
            let settled = false;
            let timer;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                entry.result = {
                    state: ok ? "ready" : "failed",
                    durationMs: Math.max(0, this.now() - entry.startedAt)
                };
                this.results.set(key, entry.result);
                if (ok && !this.disposed) this.warmedAt.set(key, this.now());
                resolve(ok);
            };
            entry.cancel = () => finish(false);
            try {
                entry.child = this.spawnProcess(gdbPath, ["--version"], {
                    stdio: "ignore",
                    windowsHide: true,
                    shell: false
                });
            } catch {
                finish(false);
                return;
            }
            timer = setTimeout(() => {
                // Launch may await this promise. A missing exit event must not make that wait unbounded.
                // Retain the child in running until exit so dispose can retry cleanup without duplicating it.
                finish(false);
                try {
                    entry.child.kill();
                } catch {
                    /* Ownership remains until exit or disposal. */
                }
            }, this.budgetMs);
            timer.unref?.();
            entry.child.once("error", () => {
                if (!entry.child.pid) this.running.delete(key);
                finish(false);
            });
            entry.child.once("exit", (code) => {
                this.running.delete(key);
                finish(code === 0);
            });
            entry.child.unref?.();
        });
        this.running.set(key, entry);
        if (!entry.child) this.running.delete(key);
        return entry.done;
    }
    // Durations and state only; safe to forward to the adapter's performance trace.
    snapshot(gdbPath) {
        const key = path.win32.normalize(gdbPath).toLowerCase();
        const active = this.running.get(key);
        if (active && !active.result)
            return { state: "pending", durationMs: Math.max(0, this.now() - active.startedAt) };
        return { ...(active?.result || this.results.get(key) || { state: "notStarted", durationMs: 0 }) };
    }
    dispose() {
        this.disposed = true;
        for (const { child, cancel } of this.running.values()) {
            cancel();
            try {
                child?.kill();
            } catch {
                /* The process may already have exited. */
            }
        }
    }
}

module.exports = { GdbWarmup, REWARM_MS };
