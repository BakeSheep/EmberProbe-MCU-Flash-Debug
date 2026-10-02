---
name: mcu-rtos
description: Inspect paused MCU RTOS tasks, task call stacks and variables through EmberProbe. Use for FreeRTOS task state, priority and stack usage diagnosis, or investigating a particular RTOS task's C/C++ locals. Structured kernel snapshots currently support single-core FreeRTOS only.
---

# MCU RTOS Inspection

Use `scripts/rtos.js` from this skill directory. It reads the selected debugger through the
EmberProbe Agent Bridge; it does not open a second probe connection or change firmware.

## Preconditions and support

- `--status` needs only the Bridge and reports the selected session, state, stop epoch and
  whether it uses the native EmberProbe debugger. `supported` here identifies the adapter,
  not proof that the kernel layout is supported.
- Task snapshots, threads, stacks, scopes and variables require a paused native `emberprobe`
  session. If several sessions/cores are listed, select one with `mcu-debug-control` first.
- Structured snapshots currently decode FreeRTOS on little-endian, single-core Cortex-M ARM32
  with kernel DWARF type information. SMP, ThreadX and Zephyr snapshots are not implemented.
  OpenOCD's RTOS configuration list does not imply corresponding snapshot decoder support.
- For task call stacks, configure the actual kernel using launch/attach `rtos` or workspace
  `emberprobe.rtos`; launch configuration takes precedence, and empty/`none` disables task
  awareness. A configuration change requires a full stop/start; session restart reuses the
  server. Do not modify configuration or restart/pause the target merely to inspect status.
  Read workspace settings via `mcu-config --get`; when explicitly requested, use its
  `--set "rtos=FreeRTOS"`. An explicit launch `rtos` still overrides that workspace setting.

For failure handling, retries and cross-skill routing, read
[../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

## Read tasks and investigate a task

```bash
node <skill-dir>/scripts/rtos.js --workspace <workspace> --status
node <skill-dir>/scripts/rtos.js --workspace <workspace> --snapshot
node <skill-dir>/scripts/rtos.js --workspace <workspace> --snapshot --no-stack-usage
node <skill-dir>/scripts/rtos.js --workspace <workspace> --threads
node <skill-dir>/scripts/rtos.js --workspace <workspace> --stack --thread 7 --count 20
node <skill-dir>/scripts/rtos.js --workspace <workspace> --scopes --frame <returned-frame-handle>
node <skill-dir>/scripts/rtos.js --workspace <workspace> --variables --reference <returned-reference> --count 50
```

Use the current `--threads` result to select a DAP thread. A snapshot's `taskKey`/`tcbAddress`
is a TCB identity, **not** a DAP thread ID. Do not correlate by task name alone or manufacture
a mapping; duplicate names and thread renumbering are possible. The snapshot may omit
`threadId`. Unproven correlation must be reported as unavailable. Other kernels can use
the thread/stack workflow when OpenOCD exposes them, even though structured snapshots are
unavailable.

Stacks accept `--start` (zero-based) and `--count` (1–100). Scopes return opaque `reference`
handles; variables may return child references and named/indexed counts. Expand only the
requested branches and use `--start`, `--count`, optional `--filter named|indexed` for paging.
For C++ display modes and layout limitations, read
[../mcu-debug-control/references/paused-inspection.md](../mcu-debug-control/references/paused-inspection.md).

All inspection results carry `sessionId`, `stopEpoch` and `inspectionEpoch`. Frame/reference handles expire
after resume, stepping, writes, restart or session/core changes. On `DEBUG_INSPECTION_STALE`,
discard old handles and begin from threads and stacks at the current stop. No inspection
command implicitly pauses, resumes, evaluates arbitrary expressions or writes memory.

## Interpret the evidence

Preserve `kernel.supported`, `kernel.state`, `partial` and `diagnostics`. `not-started` and
`no-tasks` are startup states, not evidence of list corruption. Missing optional fields are
unknown, not zero; a partial or unsupported snapshot cannot prove all tasks were collected.

Report task identity, name, state, priority and available stack bounds. `savedPointer` is
the TCB's saved SP, not the executing task's live SP. `fillEstimate` is a bounded fill-pattern
estimate; use `usedPercent` only when supplied and inspect `complete`/`scannedBytes`.
`runtime.counter` is a raw counter, not a CPU percentage. One stopped snapshot cannot prove
deadlock, starvation or stack overflow: distinguish observed facts from hypotheses and
propose the next task stack/source check. Execution control belongs to `mcu-debug-control`;
variable modification belongs to the existing explicitly authorized write workflow.
