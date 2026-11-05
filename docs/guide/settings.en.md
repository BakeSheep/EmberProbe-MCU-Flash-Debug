# VS Code Settings

[中文](settings.md)

All EmberProbe settings are in VS Code Settings; search for `@ext:BakeSheep.emberprobe`. There are 21 settings in six groups. Every key starts with `emberprobe.`, which the table omits.

| Group | Setting | Purpose |
| --- | --- | --- |
| Connection | `openocdPath` | OpenOCD executable path |
| | `tclPort` | Tcl-RPC port; random when not set |
| | `adapterSpeedKhz` | Debug and flash adapter clock |
| | `transport` | Transport protocol |
| Sampling & Waveforms | `sampleFrequencyHz` | Target waveform sampling rate |
| | `samplingAdapterSpeedKhz` | Standalone sampling adapter clock |
| | `chartHistoryMaxMiB` | Waveform history memory budget |
| | `samplingArchiveMaxMiB` | Sampling archive disk limit |
| | `chartBackgroundIcon.enabled` | Show the waveform background icon |
| Toolchain & Debugging | `gdbPath` | ARM GDB executable path |
| | `armToolchainPath` | Toolchain bin directory |
| | `armToolchainPrefix` | Toolchain prefix |
| | `objdumpPath` | ARM objdump executable path |
| | `rtos` | RTOS awareness while debugging |
| C++ Variable Display | `prettyPrintingMode` | Built-in, GDB or raw field display |
| | `prettyPrinterFiles` | Explicit GDB Python printer scripts |
| CubeMX | `cubemxPath` | STM32CubeMX executable path |
| | `cubemx2Path` | STM32CubeMX2 launcher path |
| Experimental | `experimental.externalGdb.enabled` | Enable external GDB attach |
| | `experimental.externalGdb.target` | External server host and port |
| | `experimental.externalGdb.connectionMode` | External GDB connection mode |

The probe is not a setting: pick it in the sidebar's **Connected probe** row. See [Probe connections](getting-started/probe-connections.en.md).

## Removed settings

| Old setting | What to do now |
| --- | --- |
| `probeSerial` | Pick the device under **Connected probe** in the sidebar. The old setting no longer locks or overrides that choice |
| `sampleIntervalMs` | Set the rate with `sampleFrequencyHz` |
| `maxSamples` | Waveform history keeps the latest 30 minutes within its memory and disk budgets |
| `enablePrettyPrinting` | Use `prettyPrintingMode: "raw"` for physical fields |
| `prettyPrinterPath` | Use `prettyPrintingMode: "gdb"` with `prettyPrinterFiles` |
| `memory.regionKinds` | Memory regions are classified by linker name; unrecognized regions become other, with a notice |
| `mcp.toolsets` | MCP always offers every tool, with no filtering |

Existing configuration is not rewritten. Old keys have no effect and can be deleted by hand.
