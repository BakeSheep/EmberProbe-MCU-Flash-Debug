---
name: mcu-peripheral-debug
description: Inspect and safely modify MCU peripheral registers and bit fields from the EmberProbe workspace SVD. Use when the user asks about GPIO, timers, UART, clocks, control/status registers, peripheral configuration, or named SVD register fields. Requires a paused Cortex-Debug session for hardware reads and writes.
---

# MCU Peripheral Debug

Use `scripts/peripheral.js` from this skill directory. Do not parse the SVD or construct raw DAP/OpenOCD commands yourself.

## Before you run

- **Applies to**: inspecting and safely modifying MCU peripheral registers and bit fields from the workspace SVD.
- **Requires**: the EmberProbe Agent Bridge and an SVD bound to the workspace. `--read`/`--set` also need a unique paused Cortex-Debug session and connected hardware; `--list` only parses the SVD (no hardware).
- **Preconditions**: `--list` needs a bound SVD (else `SVD_NOT_CONFIGURED`); `--read`/`--set` need the target already paused (never pause implicitly); `--set` needs explicit per-write confirmation.
- **Side effects**: `--list`/`--read` are read-only (EmberProbe refuses reads with SVD-declared side effects); `--set` writes registers and verifies by readback.
- **Success evidence**: `--list` returns matched peripherals; `--read` returns exact hex values plus decoded fields; `--set` returns a plan, then after confirmation the readback. A `--list` success does not prove hardware reads work, and a session-gate failure does not prove the register path is broken.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

List or search the configured SVD without touching hardware:

```bash
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --list
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --list --query gpio
```

Read named registers while the unique Cortex-Debug session is paused:

```bash
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --read GPIOA.MODER,USART1.SR
```

The result includes exact hexadecimal register values plus decoded fields and enumeration names. A batch is preflighted before hardware access: if any paths are unknown, no registers are read and `SVD_TARGET_NOT_FOUND` reports every bad path in `details.invalidTargets`. Correct the whole batch using `--list` or `--query`, then retry once. Never pause a running target implicitly; if `TARGET_NOT_PAUSED` is returned, report that the user must pause first. EmberProbe refuses write-only registers and reads with SVD-declared side effects.

## Peripheral writes require confirmation every time

```bash
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --set GPIOA.MODER.MODE0=Output
```

The first call only returns a write plan with the current and final register values. Show every planned register change and ask whether to allow this write once or deny it. Only after an explicit approval, repeat the identical command with the returned ID:

```bash
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --set GPIOA.MODER.MODE0=Output --confirm <confirmationId>
```

There is no persistent trust mode. Confirmations expire after five minutes, are single-use, and are invalidated if the SVD, debug stop, current register value, or requested write changes. Values may be decimal or hexadecimal; an enumeration name is accepted only when that exact field declares it in the SVD. When `INVALID_PERIPHERAL_WRITE_VALUE` is returned, use `details.allowedEnumerations` when present instead of guessing a name. EmberProbe permits only ordinary read-write registers; it rejects read/write side effects and write-once semantics rather than guessing.

On failure, parse the stderr diagnostic and report its `error.code`, `likelyCause`, `suggestedActions`, and details.
