---
name: mcu-debug-control
description: Control the workspace debugger, manage source-line or function breakpoints, and inspect paused C/C++ task stacks, scopes, classes and STL objects through EmberProbe. Use for debugging controls, breakpoints, or frame-specific variable inspection.
---

# MCU Debug Control

Use `scripts/debug.js` from this skill directory. It uses VS Code's debugger APIs and never reads or edits `launch.json`.

For paused C/C++ threads, stacks, scopes and object expansion, use `scripts/inspect.js` and
read [references/paused-inspection.md](references/paused-inspection.md). For RTOS task states,
priorities and stack fill estimates, use `mcu-rtos`. Inspection requires the native EmberProbe
adapter; existing execution controls continue to support integrated Cortex-Debug sessions.

C++ breakpoints accept `.cpp` source lines or a quoted, fully qualified function signature
(for example `--function "app::Worker::run(int)"`). Prefer source lines when overloads or
inlining make a function breakpoint ambiguous. A listed breakpoint is not proof that it
has been verified at a firmware address; report adapter verification when available.

## Before you run

- **Applies to**: controlling the workspace debugger session (start/stop/pause/continue/step/restart) and managing source-line or function breakpoints.
- **Requires**: the EmberProbe Agent Bridge and VS Code's debugger APIs; `--start` also needs a complete EmberProbe debug configuration (ELF, probe, target, OpenOCD, SVD).
- **Preconditions**: one control action in flight (else `DEBUG_CONTROL_BUSY` — read status instead); pause needs a running target, continue/step need a paused target; breakpoints can be created before a session starts.
- **Side effects**: `--start` launches a session and halts the target; control actions change execution state; `--stop` ends the session; breakpoint mutations change VS Code breakpoints.
- **Success evidence**: state-changing commands complete from the corresponding DAP state event. A `--status`/`--breakpoints` read does not prove `--start` works. On timeout, read status; never auto-resend.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

```bash
node <skill-dir>/scripts/debug.js --workspace <workspace> --status
node <skill-dir>/scripts/debug.js --workspace <workspace> --select --session <session-id>
node <skill-dir>/scripts/debug.js --workspace <workspace> --select --group <server-group> --core <zero-based-core>
node <skill-dir>/scripts/debug.js --workspace <workspace> --start
node <skill-dir>/scripts/debug.js --workspace <workspace> --pause
node <skill-dir>/scripts/debug.js --workspace <workspace> --continue
node <skill-dir>/scripts/debug.js --workspace <workspace> --step-over
node <skill-dir>/scripts/debug.js --workspace <workspace> --step-in
node <skill-dir>/scripts/debug.js --workspace <workspace> --step-out
node <skill-dir>/scripts/debug.js --workspace <workspace> --restart
node <skill-dir>/scripts/debug.js --workspace <workspace> --stop
```

Use one action per call. `--start` reuses EmberProbe's configured ELF, probe, target, OpenOCD, and SVD. State-changing commands complete from the corresponding DAP state event even if debugger's request promise responds late, and they do not retry after a timeout. Only one control action may be in flight; on `DEBUG_CONTROL_BUSY`, read status instead of issuing concurrent commands. Pause requires a running target; continue and stepping require a paused target. Restart is available only when debugger advertises it.

Use optional `--thread <positive-id>` only with debug control actions (`--pause`, `--continue`, stepping, `--restart`, or `--stop`). Status, start, breakpoint listing, and breakpoint mutation commands do not accept a thread ID.

If status lists multiple sessions, select one explicitly before control or memory access. `--select` accepts a session ID or an unambiguous group/core in the requested workspace; it performs no hardware operation. Selection is rejected during writes or control actions. `--stop` closes the selected member only; shared OpenOCD groups stop their server after the last member exits. Group members do not advertise restart: stop every core before starting a new launch that resets the device. Grouped scalar reads/writes require the sidebar ELF to match the selected core. Do not guess a core or reuse another session's write confirmation.

If a control action returns `DEBUG_CONTROL_TIMEOUT`, run `--status` and do not automatically repeat the original command. If the target is still running and an explicit `--pause` or `--restart` also times out, explain that debugger may be stuck and ask before running `--stop`, followed by `--start`, to rebuild the session.

## Breakpoints

```bash
node <skill-dir>/scripts/debug.js --workspace <workspace> --breakpoints
node <skill-dir>/scripts/debug.js --workspace <workspace> --add-breakpoint --source src/main.c --line 42
node <skill-dir>/scripts/debug.js --workspace <workspace> --disable-breakpoint --source src/main.c --line 42
node <skill-dir>/scripts/debug.js --workspace <workspace> --remove-breakpoint --function main
```

Breakpoint mutation actions are `--add-breakpoint`, `--remove-breakpoint`, `--enable-breakpoint`, and `--disable-breakpoint`. Select either `--source <workspace-file> --line <1-based-line> [--column <1-based-column>]` or `--function <name>`. Optional `--condition`, `--hit-condition`, and `--log-message` are accepted when adding. Breakpoints are managed by VS Code, remain visible in its Breakpoints view, and can be created before a session starts.

If EmberProbe reports `DEBUG_SESSION_CONFLICT`, do not guess which session to control. Base all failure explanations on the structured stderr diagnostic.
