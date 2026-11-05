# Peripheral access design

User behavior is in [Peripheral registers](../guide/peripherals.md).

The sidebar, Agent skill and MCP tools use the same SVD-bound service. Reads and ordinary register/field writes
work through an active sampling connection, during managed single-core OpenOCD debugging, and while debugging
is paused. Without debugging, sampling must already be enabled and connected. Access itself never sends halt,
reset or resume and never starts a temporary probe connection. Debug access does not require variable sampling.

## Connection and widths

Reuse an active sampling connection or the selected debug session's managed OpenOCD connection. Without either,
reject register reads and writes with `PERIPHERAL_SAMPLING_REQUIRED`; SVD browsing remains available.
Paused access retains the selected session's DAP path. Multicore groups and external GDB servers remain paused-only.
The sidebar disables hardware controls until a supported connection is available and refreshes expanded registers
when sampling connects. Stopping or replacing the sampling connection invalidates pending requests and cached values.

Running Tcl access uses aligned 8/16/32-bit transfers at the SVD width, never widened RAM reads or write fallbacks.
64-bit access remains paused DAP only. Read-side-effect, write-only, write-once and special modified-write
restrictions remain in place. Missing SVD side-effect annotations cannot guarantee a harmless read.

Custom OpenOCD scripts decide their own initialization behavior. Running access is not promised for every target or low-power state.

## Approval and readback

Agent/MCP writes require single-use approval bound to the workspace, SVD, physical connection, selected debug
session/stop (when present), sampling connection generation, original values and requested writes. Stopping or
replacing the sampling connection invalidates approval, as does a changed probe/attachment/target or original value. Check original values again
immediately before writing; cancel when they changed. Bitfield updates are not atomic against firmware, DMA or
peripheral hardware, even when the CPU is halted.

Responses add access mode and generation. Write results retain previous/written/readBack/verified and add
verification: matched, different or unavailable. While running (including standalone), a completed write with
different/unavailable readback reports verified: false; this does not prove the write did not happen. Paused DAP
retains strict checking. Write timeouts/target changes report completed/attempted work and unknown outcomes.
Never automatically resend a failed or unverified write. When the debug state or SVD changes only after every
write and its readback finished, the result stays successful and adds stateChangedAfterWrite. Each running
transaction has a 5 s budget checked between OpenOCD commands; each command is bounded by the Tcl RPC timeout.

## Verification

Software tests use fake OpenOCD/DAP endpoints and the real Worker RPC, covering all three states, widths,
approval invalidation, readback differences, partial failures and stale generations. They do not establish board
support. Hardware acceptance requires separate authorization and dedicated hardware; record the OS, probe,
target script, firmware and SVD.

2026-11-01: APM32F407 + J-Link/WinUSB passed all three read modes, running reads alongside sampling, and six
explicitly approved same-value whole-register/field writes. This covers 32-bit transfers on that setup only.
See the [board acceptance record](../records/validation/peripheral-board-2026-11-01.md) for versions, evidence and limits.
2026-11-03: the same setup passed again after the sidebar and write-outcome fixes, including running reads while
sampling stayed active; see the [re-check record](../records/validation/peripheral-board-2026-11-03.md).
