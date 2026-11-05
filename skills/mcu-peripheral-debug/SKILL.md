---
name: mcu-peripheral-debug
description: Inspect and safely modify MCU peripheral registers and bit fields from the EmberProbe workspace SVD. Use when the user asks about GPIO, timers, UART, clocks, control/status registers, peripheral configuration, or named SVD register fields. Requires active sampling or a supported debug connection; supports managed single-core running access without halting and paused debug access.
---

# MCU Peripheral Debug

Use `scripts/peripheral.js` from this skill directory. Do not parse the SVD or construct raw DAP/OpenOCD commands yourself.

## Before you run

- **MCP first**: if this session provides EmberProbe MCP tools (such as `peripherals_read`), use them; the scripts here are the fallback. The authorization and hardware rules on this page apply to both.
- **Applies to**: inspecting and safely modifying MCU peripheral registers and bit fields from the workspace SVD.
- **Requires**: the EmberProbe Agent Bridge and an SVD bound to the workspace. `--read`/`--set` also need an active sampling connection or a supported debug session; they never start a temporary probe connection. `--list` only parses the SVD (no hardware).
- **Preconditions**: `--list` needs a bound SVD (else `SVD_NOT_CONFIGURED`); `--read`/`--set` preserve execution state; multicore/external servers and 64-bit access require an already paused session; `--set` needs per-write confirmation unless the Bridge applies the sidebar full-access grant.
- **Side effects**: `--list`/`--read` are read-only (EmberProbe refuses reads with SVD-declared side effects); `--set` writes registers and reports readback separately. Running bitfield updates are not atomic against firmware or hardware.
- **Success evidence**: `--list` returns matched peripherals; `--read` returns exact hex values plus decoded fields; `--set` returns a plan, then after confirmation the readback. A `--list` success does not prove hardware reads work, and a session-gate failure does not prove the register path is broken.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

List or search the configured SVD without touching hardware:

```bash
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --list
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --list --query gpio
```

Read named registers without halting through active sampling or managed single-core debugging:

```bash
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --read GPIOA.MODER,USART1.SR
```

The result includes exact hexadecimal register values plus decoded fields and enumeration names. A batch is preflighted before hardware access: if any paths are unknown, no registers are read and `SVD_TARGET_NOT_FOUND` reports every bad path in `details.invalidTargets`. Correct the whole batch using `--list` or `--query`, then retry once. Never pause a running target implicitly. `PERIPHERAL_ACCESS_UNSUPPORTED` means this width or connection cannot be used while running; report the limitation instead of halting or starting another server. EmberProbe refuses write-only registers and reads with SVD-declared side effects.

## Peripheral write permission

```bash
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --set GPIOA.MODER.MODE0=Output
```

With the sidebar full-access grant active, this call executes the intended write directly and returns `permission.mode: "full"`; never use it as a dry run or enable the grant yourself. Otherwise the first call returns a write plan with the current and final register values. Show every planned register change in the Agent conversation and ask whether to allow this write once or deny it. Only after an explicit approval, repeat the identical command with the returned ID. EmberProbe does not display a second operation approval dialog:

```bash
node <skill-dir>/scripts/peripheral.js --workspace <workspace> --set GPIOA.MODER.MODE0=Output --confirm <confirmationId>
```

The sidebar's explicit full-access workspace grant may authorize a write without an ID (`permission.mode: "full"`). Otherwise there is no remembered peripheral-only trust mode; ask only when `confirmationRequired` is true. Confirmations expire after five minutes, are single-use, and are invalidated if the SVD, physical probe/attachment/target, selected debug session/stop, current register value, or requested write changes. Values may be decimal or hexadecimal; an enumeration name is accepted only when that exact field declares it in the SVD. When `INVALID_PERIPHERAL_WRITE_VALUE` is returned, use `details.allowedEnumerations` when present instead of guessing a name. EmberProbe permits only ordinary read-write registers; it rejects read/write side effects and write-once semantics rather than guessing.

Running access supports aligned 8/16/32-bit registers at their natural width. Without debugging, sampling must
already be enabled and connected. `PERIPHERAL_SAMPLING_REQUIRED` means start sampling explicitly and wait for
the connection before reading or writing; do not bypass this gate with another probe server. Debug access does
not require variable sampling. Stopping or replacing the sampling connection invalidates write confirmation.
Responses include access mode and generation. Write results include verification (matched/different/unavailable)
and verified. A completed write with verified: false may have been overwritten by firmware or hardware,
or its readback may have failed. Never claim it was not written or automatically repeat it.
A write timeout can leave the result unknown; report completed and attempted items before further action.
A successful result with stateChangedAfterWrite means every write finished first; report the later change.

On failure, parse the stderr diagnostic and report its `error.code`, `likelyCause`, `suggestedActions`, and details.
