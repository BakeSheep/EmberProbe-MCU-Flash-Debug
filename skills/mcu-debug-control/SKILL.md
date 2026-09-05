---
name: mcu-debug-control
description: Control the current workspace Cortex-Debug session and manage source-line or function breakpoints through EmberProbe. Use when the user asks to start or stop debugging, inspect debug state, pause, continue, step over/in/out, restart, or add, remove, enable, disable, or list breakpoints.
---

# MCU Debug Control

Use `scripts/debug.js` from this skill directory. It uses VS Code's debugger APIs and never reads or edits `launch.json`.

## Before you run

- **Applies to**: controlling the workspace Cortex-Debug session (start/stop/pause/continue/step/restart) and managing source-line or function breakpoints.
- **Requires**: the EmberProbe Agent Bridge and VS Code's debugger APIs; `--start` also needs a complete EmberProbe debug configuration (ELF, probe, target, OpenOCD, SVD).
- **Preconditions**: one control action in flight (else `DEBUG_CONTROL_BUSY` — read status instead); pause needs a running target, continue/step need a paused target; breakpoints can be created before a session starts.
- **Side effects**: `--start` launches a session and halts the target; control actions change execution state; `--stop` ends the session; breakpoint mutations change VS Code breakpoints.
- **Success evidence**: state-changing commands complete from the corresponding DAP state event. A `--status`/`--breakpoints` read does not prove `--start` works. On timeout, read status; never auto-resend.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

```bash
node <skill-dir>/scripts/debug.js --workspace <workspace> --status
node <skill-dir>/scripts/debug.js --workspace <workspace> --start
node <skill-dir>/scripts/debug.js --workspace <workspace> --pause
node <skill-dir>/scripts/debug.js --workspace <workspace> --continue
node <skill-dir>/scripts/debug.js --workspace <workspace> --step-over
node <skill-dir>/scripts/debug.js --workspace <workspace> --step-in
node <skill-dir>/scripts/debug.js --workspace <workspace> --step-out
node <skill-dir>/scripts/debug.js --workspace <workspace> --restart
node <skill-dir>/scripts/debug.js --workspace <workspace> --stop
```

Use one action per call. `--start` reuses EmberProbe's configured ELF, probe, target, OpenOCD, and SVD. State-changing commands complete from the corresponding DAP state event even if Cortex-Debug's request promise responds late, and they do not retry after a timeout. Only one control action may be in flight; on `DEBUG_CONTROL_BUSY`, read status instead of issuing concurrent commands. Pause requires a running target; continue and stepping require a paused target. Restart is available only when Cortex-Debug advertises it.

Use optional `--thread <positive-id>` only with debug control actions (`--pause`, `--continue`, stepping, `--restart`, or `--stop`). Status, start, breakpoint listing, and breakpoint mutation commands do not accept a thread ID.

If a control action returns `DEBUG_CONTROL_TIMEOUT`, run `--status` and do not automatically repeat the original command. If the target is still running and an explicit `--pause` or `--restart` also times out, explain that Cortex-Debug may be stuck and ask before running `--stop`, followed by `--start`, to rebuild the session.

## Breakpoints

```bash
node <skill-dir>/scripts/debug.js --workspace <workspace> --breakpoints
node <skill-dir>/scripts/debug.js --workspace <workspace> --add-breakpoint --source src/main.c --line 42
node <skill-dir>/scripts/debug.js --workspace <workspace> --disable-breakpoint --source src/main.c --line 42
node <skill-dir>/scripts/debug.js --workspace <workspace> --remove-breakpoint --function main
```

Breakpoint mutation actions are `--add-breakpoint`, `--remove-breakpoint`, `--enable-breakpoint`, and `--disable-breakpoint`. Select either `--source <workspace-file> --line <1-based-line> [--column <1-based-column>]` or `--function <name>`. Optional `--condition`, `--hit-condition`, and `--log-message` are accepted when adding. Breakpoints are managed by VS Code, remain visible in its Breakpoints view, and can be created before a session starts.

If EmberProbe reports `DEBUG_SESSION_CONFLICT`, do not guess which session to control. Base all failure explanations on the structured stderr diagnostic.
