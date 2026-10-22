"use strict";

// A GDB command typed in the Debug Console (next, step, continue, ...) stops the target like the
// toolbar does, and VS Code then focuses the editor at the new frame (debug.focusEditorOnBreak).
// For stops that a console command caused, focus returns to the console once VS Code has revealed
// the frame, so the next command can be typed straight away. Toolbar, keyboard and Agent Bridge
// stepping are DAP control requests and keep VS Code's editor focus.
const CONTROL_REQUESTS = new Set([
    "continue",
    "next",
    "stepIn",
    "stepOut",
    "stepBack",
    "reverseContinue",
    "pause",
    "restart",
    "restartFrame",
    "goto",
    "disconnect",
    "terminate"
]);
// VS Code reveals the frame right after its first stackTrace response; an unchanged editor and
// selection produce no editor event, so focus follows shortly after that response instead.
const REVEAL_SETTLE_MS = 200;
// Upper bound when no stackTrace response or editor event follows the stop.
const REVEAL_TIMEOUT_MS = 2000;

class ReplFocusRestorer {
    constructor({ focusRepl, setTimer = setTimeout, clearTimer = clearTimeout }) {
        this.focusRepl = focusRepl;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        // Sessions whose latest execution was started by a console command.
        this.armed = new Set();
        this.waiting = null;
    }

    handleRequest(session, message) {
        if (!session || message?.type !== "request") return;
        if (message.command === "evaluate" && message.arguments?.context === "repl") {
            this.armed.add(session.id);
        } else if (CONTROL_REQUESTS.has(message.command)) {
            this.armed.delete(session.id);
            if (this.waiting?.sessionId === session.id) this._cancelWait();
        }
    }

    handleMessage(session, message) {
        if (!session || !message) return;
        if (message.type === "event" && message.event === "stopped") {
            if (!this.armed.delete(session.id)) return;
            this._cancelWait();
            this.waiting = { sessionId: session.id, settled: false, timer: null };
            this._schedule(REVEAL_TIMEOUT_MS);
        } else if (
            message.type === "response" &&
            message.command === "stackTrace" &&
            this.waiting?.sessionId === session.id &&
            !this.waiting.settled
        ) {
            this.waiting.settled = true;
            this._schedule(REVEAL_SETTLE_MS);
        } else if (message.type === "event" && ["terminated", "exited"].includes(message.event)) {
            this.sessionEnded(session);
        }
    }

    // "reveal" is VS Code moving the editor to the stopped frame; "user" is typing or clicking in an
    // editor, which means the user has moved on and the console should not take focus back.
    editorActivity(kind) {
        if (kind === "user") {
            this.armed.clear();
            this._cancelWait();
        } else if (this.waiting) {
            this._focus();
        }
    }

    sessionEnded(session) {
        if (!session) return;
        this.armed.delete(session.id);
        if (this.waiting?.sessionId === session.id) this._cancelWait();
    }

    dispose() {
        this.armed.clear();
        this._cancelWait();
    }

    _schedule(delay) {
        if (this.waiting.timer !== null) this.clearTimer(this.waiting.timer);
        this.waiting.timer = this.setTimer(() => this._focus(), delay);
    }

    _cancelWait() {
        if (this.waiting?.timer != null) this.clearTimer(this.waiting.timer);
        this.waiting = null;
    }

    _focus() {
        this._cancelWait();
        Promise.resolve()
            .then(() => this.focusRepl())
            .catch((error) => console.error("Unable to focus the Debug Console:", error));
    }
}

module.exports = { ReplFocusRestorer, REVEAL_SETTLE_MS, REVEAL_TIMEOUT_MS };
