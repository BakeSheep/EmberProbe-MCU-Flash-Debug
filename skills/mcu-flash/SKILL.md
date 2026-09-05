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
