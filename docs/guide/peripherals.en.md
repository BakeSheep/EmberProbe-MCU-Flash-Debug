# Peripheral Registers

[中文](peripherals.md)

View and change a chip's peripheral registers and bit fields using an SVD file. The sidebar, Agent skill and MCP share the same feature.

No ELF is needed. Access itself never halts, resets or resumes the target, and never opens a temporary probe connection.

## When it is available

| State | Reading and writing registers |
| --- | --- |
| Not debugging, sampling connected | Available |
| Not debugging, no sampling | Browse the SVD only; no reads or writes |
| Single-core debugging, running | Available |
| Debugging, paused | Available |
| Multicore groups, external GDB server | Paused only |

When not debugging, turn sampling on and wait until it connects; until then the read and write controls stay disabled. Once sampling connects, expanded registers refresh. Stopping or replacing the sampling connection discards earlier readings and pending requests.

Peripheral access during debugging does not need sampling.

## Changing registers

- Running access uses the 8, 16 or 32-bit width in the SVD; 64-bit registers work only while debugging is paused.
- Read-to-clear, write-only and write-once registers have matching restrictions.
- A missing side-effect note in the SVD does not guarantee a harmless read. Check the manual before reading status registers.
- A field change reads then writes, so it can race with firmware, DMA or peripheral hardware, even with the CPU paused.

## Agent register writes

Each write is confirmed in the conversation; see [Agent permissions](agent/permissions.en.md). Original values are checked again right before writing, and the write is cancelled if they changed. Stopping or replacing the sampling connection also voids the confirmation.

`verified: false` in a result means the value read back differs or could not be read. **It does not mean nothing was written.** Many registers read back differently by design. Failed or unverified writes are never resent automatically.

## Troubleshooting

**`PERIPHERAL_SAMPLING_REQUIRED`**: no connection is available. Turn on sampling or start debugging.

## Limits

- Running access is not promised for every target and may fail in low-power states.
- Custom OpenOCD scripts decide their own initialization behavior.
- Board acceptance so far covers only 32-bit access on APM32F407 + J-Link, writing the same values.

## Related documents

- [Peripheral access design](../design/peripheral-access.md)
- [Board acceptance record](../records/validation/peripheral-board-2026-11-01.md)
