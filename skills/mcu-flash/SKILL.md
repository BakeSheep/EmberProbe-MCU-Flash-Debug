---
name: mcu-flash
description: Program MCU firmware or verify on-chip Flash against the workspace ELF through OpenOCD. Use when the user asks to flash, download, program, burn, verify, compare, or confirm firmware on an attached target.
---

# MCU Flash

## Before you run

- **Applies to**: programming/downloading/burning firmware, or verifying on-chip Flash against the workspace ELF.
- **Requires**: the EmberProbe Agent Bridge, OpenOCD, a connected probe, a powered target, and a resolvable ELF.
- **Preconditions**: the probe is free (not sampling, downloading, or debugging); ELF, target, and probe are resolved — never guess a missing one; programming needs one-time user authorization.
- **Side effects**: programming rewrites target Flash and resets the target; verification briefly halts then resumes it, restoring the prior run state.
- **Success evidence**: preflight reports the selected ELF, ELF SHA-256, target, probe, OpenOCD, and each value's `sources`; the run reports OpenOCD's own result. A verify success does not prove a program success.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

Choose exactly one operation from the user's request:

- To program, download, burn, or flash firmware, read [references/programming.md](references/programming.md) and use `scripts/program.js`.
- To compare existing on-chip Flash with the local ELF without programming it, read [references/verification.md](references/verification.md) and use `scripts/verify.js`.

Programming already performs OpenOCD's program-and-verify sequence. If the user asks to flash and confirm success in one request, run only the programming workflow and report its verification result; do not start a second verification session.

Both operations must complete detection first and report the selected ELF, ELF SHA-256, target, probe, and OpenOCD executable. Never guess a missing target or probe. Do not run either operation while EmberProbe is sampling, downloading, or debugging because the probe has a single owner.

## OpenOCD compatibility

- Preflight `ready` requires a readable ELF, compatible executable, valid interface/target scripts, compiled adapter support and a resolved connection identity. Report `diagnostics` and `notes` when false; do not execute or request confirmation.
- `--transport auto|swd|jtag|hla_swd|hla_jtag` overrides the workspace transport. Missing values use the workspace setting, then `auto`. Keep the same transport for confirmation and execution.
- J-Link `auto` resolves to SWD for known Cortex-M targets, otherwise the interface script default, validated with `noinit`. Preserve the resolved transport reported by preflight; do not retry other protocols on failure. `--probe-serial <decimal>` selects the physical J-Link and `--adapter-speed-khz <integer>` sets kHz (`0` keeps script defaults). Report and preserve these values from preflight through confirmation and execution. A changed identity invalidates confirmation.
- Multiple detected probe types require an explicit `--probe`. Same-model J-Links use their serial numbers; duplicate/unreadable identities must be resolved before proceeding. Use `mcu-config --probes` to inspect OS metadata. Never fall back to a different serial when the selected device is absent.
- Windows J-Link USB failures may indicate a legacy SEGGER driver binding. Explain the reported diagnostic; do not automatically replace drivers or retry flashing.
