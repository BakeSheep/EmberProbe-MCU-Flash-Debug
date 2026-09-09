---
name: mcu-fault-analyzer
description: Read and decode Cortex-M fault status registers (CFSR/HFSR/DFSR/MMFAR/BFAR) through EmberProbe and symbolize PC/LR against the ELF. Use when the user reports a crashed, frozen, or HardFault-ed MCU, asks why the firmware stopped responding, or wants a fault/exception diagnosis of the attached target.
---

# MCU Fault Analyzer

Use `scripts/analyze-fault.js` from this skill directory.

## Before you run

- **Applies to**: reading and decoding Cortex-M fault status registers (CFSR/HFSR/DFSR/MMFAR/BFAR) and symbolizing PC/LR against the ELF for a crashed, frozen, or HardFault-ed target.
- **Requires**: the EmberProbe Agent Bridge, OpenOCD, a connected probe, and a powered target.
- **Preconditions**: the probe is free — otherwise `PROBE_BUSY` is returned; wait or let the user stop the current owner.
- **Side effects**: reads the SCB fault registers non-intrusively, briefly halts the core to capture PC/SP/LR/xPSR, then restores the original run state.
- **Success evidence**: `faultDetected` plus decoded faults and symbolized PC/LR. No fault flags means none is pending — not that the program runs correctly.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

```bash
node <skill-dir>/scripts/analyze-fault.js --workspace <workspace>
```

EmberProbe reads the SCB fault registers non-intrusively (they are readable while the core runs), briefly halts the core only to capture PC/SP/LR/xPSR, then restores the original run state. The probe must be free (not downloading, sampling, or debugging), otherwise `PROBE_BUSY` is returned.

## Interpreting the result

The JSON on stdout contains `faultDetected`, `faults` (decoded flag list), `exception` (active exception from ICSR), raw `registers`, and `pc`/`lr` with `pcSymbol`/`lrSymbol` (`function+0xOFFSET` resolved from the ELF).

- If `faultDetected` is true, lead with a one-line conclusion combining the strongest evidence, e.g. "Precise bus error at 0x60000000 (`faultAddress`), executing `uart_send+0x12` (`pcSymbol`)". Then list the decoded flags with their descriptions.
- `HFSR.FORCED` means a lower-priority fault escalated to HardFault — the root cause is in the CFSR flags, not the HardFault itself.
- `CFSR.IMPRECISERR` means PC has already moved past the faulting store; say the reported PC is only approximate.
- `exception.name` tells which handler the core is currently in (e.g. `HardFault`); `Thread` with no fault flags means the core is running normally.
- If `faultDetected` is false and the target state is `running`, state clearly that no fault is pending — the problem is elsewhere (e.g. a stuck loop; suggest mcu-variables to inspect variables).
- If `symbolication` is `unavailable` or symbols are empty, the ELF is missing or stripped; report raw addresses and suggest a Debug build.

## Failure diagnostics

On failure, parse the JSON `diagnostic` on stderr and act on `error.code` (`PROBE_BUSY`, `TARGET_NOT_CONNECTED`, `TARGET_UNPOWERED`, `CONFIG_INCOMPLETE`, `OPENOCD_NOT_READY`).
