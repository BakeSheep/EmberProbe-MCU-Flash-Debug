"use strict";
const assert = require("assert");
const { ReplFocusRestorer, REVEAL_SETTLE_MS, REVEAL_TIMEOUT_MS } = require("../src/services/replFocus");

function harness() {
    const timers = new Map();
    let nextTimer = 1;
    const calls = [];
    const restorer = new ReplFocusRestorer({
        focusRepl: () => calls.push("focusRepl"),
        setTimer: (fn, delay) => {
            const id = nextTimer++;
            timers.set(id, { fn, delay });
            return id;
        },
        clearTimer: (id) => timers.delete(id)
    });
    const session = { id: "s1" };
    let seq = 1;
    return {
        restorer,
        session,
        calls,
        timers,
        request: (command, args, target = session) =>
            restorer.handleRequest(target, { type: "request", seq: seq++, command, arguments: args }),
        stopped: (target = session) =>
            restorer.handleMessage(target, { type: "event", event: "stopped", body: { reason: "step" } }),
        stackTrace: (target = session) =>
            restorer.handleMessage(target, { type: "response", command: "stackTrace", success: true }),
        fire() {
            const pending = [...timers.entries()];
            timers.clear();
            pending.forEach(([, timer]) => timer.fn());
        },
        delays: () => [...timers.values()].map((timer) => timer.delay),
        settle: () => new Promise((resolve) => setImmediate(resolve))
    };
}

(async () => {
    {
        // Console next: focus returns once VS Code reveals the stopped frame in an editor.
        const h = harness();
        h.request("evaluate", { expression: "next", context: "repl" });
        h.stopped();
        assert.deepStrictEqual(h.delays(), [REVEAL_TIMEOUT_MS]);
        h.restorer.editorActivity("reveal");
        await h.settle();
        assert.deepStrictEqual(h.calls, ["focusRepl"]);
        assert.strictEqual(h.timers.size, 0, "revealing cancels the fallback timer");
        h.restorer.editorActivity("reveal");
        await h.settle();
        assert.deepStrictEqual(h.calls, ["focusRepl"], "only the stop after a console command refocuses once");
    }
    {
        // An unchanged editor gives no event; the first stackTrace response starts a short settle timer.
        const h = harness();
        h.request("evaluate", { expression: "step", context: "repl" });
        h.stopped();
        h.stackTrace();
        assert.deepStrictEqual(h.delays(), [REVEAL_SETTLE_MS]);
        h.stackTrace();
        assert.deepStrictEqual(h.delays(), [REVEAL_SETTLE_MS], "later stack pages do not postpone focus");
        h.fire();
        await h.settle();
        assert.deepStrictEqual(h.calls, ["focusRepl"]);
    }
    {
        // Toolbar, keyboard and Agent Bridge stepping are DAP control requests and keep the editor focus.
        const h = harness();
        h.request("evaluate", { expression: "print x", context: "repl" });
        h.request("next", { threadId: 1 });
        h.stopped();
        h.restorer.editorActivity("reveal");
        h.fire();
        await h.settle();
        assert.deepStrictEqual(h.calls, []);
        assert.strictEqual(h.timers.size, 0);
    }
    {
        // Watch and hover evaluations are not console commands.
        const h = harness();
        h.request("evaluate", { expression: "x", context: "watch" });
        h.request("evaluate", { expression: "y", context: "hover" });
        h.stopped();
        assert.strictEqual(h.timers.size, 0);
    }
    {
        // Typing or clicking in an editor while the console command runs means the user moved on.
        const h = harness();
        h.request("evaluate", { expression: "continue", context: "repl" });
        h.restorer.editorActivity("user");
        h.stopped();
        assert.strictEqual(h.timers.size, 0);
        h.request("evaluate", { expression: "next", context: "repl" });
        h.stopped();
        h.restorer.editorActivity("user");
        h.fire();
        await h.settle();
        assert.deepStrictEqual(h.calls, [], "user input before the reveal also cancels");
    }
    {
        // Sessions are tracked independently, and ending one drops its pending focus.
        const h = harness();
        const other = { id: "s2" };
        h.request("evaluate", { expression: "next", context: "repl" });
        h.stopped(other);
        assert.strictEqual(h.timers.size, 0, "another session's stop does not consume this command");
        h.stopped();
        h.request("continue", {}, other);
        assert.strictEqual(h.timers.size, 1, "another session's control request keeps this wait");
        h.restorer.handleMessage(h.session, { type: "event", event: "terminated" });
        assert.strictEqual(h.timers.size, 0);
        h.stopped();
        assert.strictEqual(h.timers.size, 0);
    }
    {
        // A failing focus command is reported, not thrown into the debug adapter tracker.
        const errors = [];
        const original = console.error;
        console.error = (...args) => errors.push(args);
        try {
            const restorer = new ReplFocusRestorer({
                focusRepl: () => Promise.reject(new Error("no console")),
                setTimer: () => 1,
                clearTimer: () => {}
            });
            const session = { id: "s1" };
            restorer.handleRequest(session, { type: "request", command: "evaluate", arguments: { context: "repl" } });
            restorer.handleMessage(session, { type: "event", event: "stopped" });
            restorer.editorActivity("reveal");
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(errors.length, 1);
        } finally {
            console.error = original;
        }
    }
    console.log("Debug Console focus after console-initiated stops passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
