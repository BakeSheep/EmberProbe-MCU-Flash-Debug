---
name: mcu-fault-analyzer
description: Read and decode Cortex-M fault status registers (CFSR/HFSR/DFSR/MMFAR/BFAR) through EmberProbe, symbolize PC/LR against the ELF, and tell where a hung target is stuck (interrupt handler, masks, PC samples). Use when the user reports a crashed, frozen, hung, or HardFault-ed MCU, asks why the firmware stopped responding, or wants a fault/exception diagnosis of the attached target.
---

# MCU Fault Analyzer

Use `scripts/analyze-fault.js` from this skill directory.

## Before you run

- **MCP first**: if this session provides EmberProbe MCP tools (such as `fault_read`), use them; the scripts here are the fallback. The authorization and hardware rules on this page apply to both.
- **Applies to**: reading and decoding Cortex-M fault status registers (CFSR/HFSR/DFSR/MMFAR/BFAR) and symbolizing PC/LR against the ELF for a crashed, frozen, or HardFault-ed target.
- **Requires**: the EmberProbe Agent Bridge, OpenOCD, a connected probe, and a powered target.
- **Preconditions**: the probe is free — otherwise `PROBE_BUSY` is returned; wait or let the user stop the current owner.
- **Side effects**: reads the SCB fault registers non-intrusively, briefly halts the core to capture PC/SP/LR/xPSR and the interrupt masks, and, when it was running, halts it four more times about 10 ms apart to sample PC; it then restores the original run state.
- **Success evidence**: `faultDetected` plus decoded faults and symbolized PC/LR. No fault flags means none is pending — not that the program runs correctly.

For failure handling, retry limits, cross-skill routing, and result scoping, read [../_emberprobe/agent-workflow.md](../_emberprobe/agent-workflow.md).

```bash
node <skill-dir>/scripts/analyze-fault.js --workspace <workspace>
```

EmberProbe reads the SCB fault registers non-intrusively (they are readable while the core runs), briefly halts the core only to capture PC/SP/LR/xPSR and PRIMASK/BASEPRI/FAULTMASK, samples PC a few more times when the core was running, then restores the original run state. The probe must be free (not downloading, sampling, or debugging), otherwise `PROBE_BUSY` is returned.

## Interpreting the result

The JSON on stdout contains `faultDetected`, `faults` (decoded flag list), `exception` (active exception from ICSR), raw `registers`, and `pc`/`lr` with `pcSymbol`/`lrSymbol` (`function+0xOFFSET` resolved from the ELF).

- If `faultDetected` is true, lead with a one-line conclusion combining the strongest evidence, e.g. "Precise bus error at 0x60000000 (`faultAddress`), executing `uart_send+0x12` (`pcSymbol`)". Then list the decoded flags with their descriptions.
- `HFSR.FORCED` means a lower-priority fault escalated to HardFault — the root cause is in the CFSR flags, not the HardFault itself.
- `CFSR.IMPRECISERR` means PC has already moved past the faulting store; say the reported PC is only approximate.
- `exception.name` tells which handler the core is currently in (e.g. `HardFault`); `Thread` with no fault flags means no fault exception is active — not that the application logic or hardware peripherals are functioning normally.
- `execution` describes the halted core: `mode` (`thread` or `handler`), `exception` from IPSR with `handler` (the vector table entry named from the ELF, such as `UART7_IRQHandler`; `name` becomes `UART7_IRQn` for such handlers) and `masks` (`primask`, `basepri`, `faultmask` where the core has them).
- `stall` appears only when the target was running: `samples` lists the first PC and the sampled PCs with symbols. `verdict` is `tightLoop` (all within 64 bytes: a busy-wait or endless loop), `sameFunction` (still inside one function), `progressing` (different functions), or `unknown` (not enough symbols to tell).
- If `faultDetected` is false, lead with `execution` and `stall`: for example "No fault; the core is stuck in `UART7_IRQn` (`UART7_IRQHandler`), looping in `HAL_DMA_Abort+0x1C`". A `handler` of `Default_Handler` means an enabled interrupt has no handler. While in a handler, lower-priority interrupts and the RTOS tick cannot run; a nonzero `basepri` or `primask` in thread mode also blocks them.
- If `faultDetected` is false and `stall.verdict` is `progressing`, state that no fault is pending and the core is executing — the problem is elsewhere (e.g. waiting on a state; suggest mcu-variables to inspect variables).
- For a full call stack and locals at the stuck point, use mcu-debug-control `--start --attach`, which halts the running firmware without reset.
- After regenerating initialization code, the project must be rebuilt; after rebuilding, do not assume the target is running the new firmware until programmed.
- If `symbolication` is `unavailable` or symbols are empty, the ELF is missing or stripped; report raw addresses and suggest a Debug build.

## Failure diagnostics

On failure, parse the JSON `diagnostic` on stderr and act on `error.code` (`PROBE_BUSY`, `TARGET_NOT_CONNECTED`, `TARGET_UNPOWERED`, `CONFIG_INCOMPLETE`, `OPENOCD_NOT_READY`).
