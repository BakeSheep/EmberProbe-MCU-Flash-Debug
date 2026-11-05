# J-Link

[中文](jlink.md)

EmberProbe uses J-Link through OpenOCD, which on Windows needs the WinUSB driver. You can switch from the sidebar and go back to the SEGGER driver at any time. Linux uses udev permissions, and macOS has no driver step.

## Connecting

1. Choose `jlink.cfg` under **Select debugger**.
2. Check the device under **Connected probe**. See [Probe connections](probe-connections.en.md) for how one is chosen.
3. Transport and speed are automatic. To set them yourself:

| Setting | Meaning |
| --- | --- |
| `emberprobe.transport` | `auto` by default; `swd` or `jtag` to override |
| `emberprobe.adapterSpeedKhz` | Integer kHz. `0` keeps the script's speed; nonzero is the speed cap and the programming clock |
| `emberprobe.samplingAdapterSpeedKhz` | Standalone sampling clock; `0` inherits the setting above. Changing it reconnects sampling |

Known Cortex-M targets default to SWD. EmberProbe does not lower the speed or change protocol automatically on failure.

## Switching to WinUSB (Windows x64)

A J-Link on the SEGGER driver cannot read, sample, debug or download on Windows.

1. Find its card under **Connected probe** and set the driver dropdown to **WinUSB**. It does not need to be selected first.
2. Approve the administrator prompt. The driver tool in the release is unsigned, so Windows may warn about an unknown publisher, or local policy may block it.
3. When the dropdown stops loading, retry the operation.

The original driver is backed up first. Choose **SEGGER** in the dropdown to restore it. **After switching to WinUSB, Ozone and other SEGGER tools may not work with this J-Link; switch back when you need them.**

When the driver blocks an operation, a warning also appears at the bottom right:

- **Switch to WinUSB** switches the J-Link that was blocked. Retry by hand afterwards.
- **Ignore** stops the reminder in this workspace, but the operation stays blocked.

## Changing the driver by hand

A "manual driver" badge on the card means this J-Link cannot pass automatic verification, for example because its USB product is not on the verified list. Hover for the reason; interface details are in the EmberProbe Chip Info output. Use a tool such as Zadig in that case.

## Hardware differences

A marketplace label like "V9 JLinkOB" is not a real hardware identity. WinUSB support depends on the actual OB implementation and firmware. When diagnosing, record the firmware, hardware strings, serial and each USB interface's driver.

## Troubleshooting

**`Failed to open device`**: either the probe is in use or the driver is incompatible; this line alone does not tell which. Close programs such as Ozone first, then check the driver. OpenOCD and Ozone generally cannot share a debug interface.

**`TARGET_NOT_CONNECTED` or `cannot read IDR`**: USB is fine; the problem is the target's SWD connection. Check wiring, power and the reset pin.

**No reference voltage**: OB probes may not measure it. This does not mean the target is unpowered.

**CMSIS-DAP crash on Linux (`buffer overflow detected`)**: some system OpenOCD 0.12.0 builds have this defect. EmberProbe bundles a fixed OpenOCD for Linux x64; keep `emberprobe.openocdPath` at its default. Do not remove the serial to avoid it, because that bypasses probe selection.

**Error details**: sidebar diagnostics can be expanded and copied. Include the full text when reporting a problem.

## Related documents

- [Probe connections](probe-connections.en.md)
- [Probe selection design (Chinese)](../../design/probe-selection.md)
