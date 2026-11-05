# Flash and Download

[中文](flash.md)

Sidebar downloads, debug launches and Agent programming all write firmware to target Flash. Each one does a full erase, write, verify and reset-run.

## How to use it

- **Download**: click download in the sidebar, or right-click an ELF in the Explorer.
- **Debug**: a `launch` configuration downloads the firmware, then stops at the entry point.
- **Agent**: program through the `mcu-flash` skill or MCP tools, confirmed in the conversation. See [Agent permissions](../agent/permissions.en.md).

## Download behavior

- Firmware is programmed again even when it matches target Flash exactly. Nothing is skipped.
- EmberProbe raises the SWD clock while programming. If a fast write fails, it restores the original clock and writes once more; an error appears only if that also fails.
- Only Cortex-M over SWD gets the raised clock. JTAG, RISC-V and other targets keep the script's clock.

## Adjusting the speed

A nonzero `emberprobe.adapterSpeedKhz` is used as the programming clock.

With long or unshielded wiring, the fast write may fail and repeat on every download, making it slower. Set a lower value in that case.

Erase time is set by the Flash itself. A faster clock only shortens the write.

## launch configuration

| Configuration | Effect |
| --- | --- |
| Default | Downloads the ELF in `executable` |
| `loadFiles: ["a.elf", "b.elf"]` | Downloads these files in order |
| `loadFiles: []` | Downloads nothing |
| `request: "attach"` | Never writes Flash |

## Viewing startup timing

If debug startup is slow, add `"performanceTrace": true` to the launch configuration. The Debug Console then prints each phase's duration, such as toolchain lookup, OpenOCD start, GDB start and download. Only durations are logged, never paths or target data.

GDB can take several seconds to start the first time on Windows. EmberProbe prepares it in the background, but debugging right after opening a project may still wait.

## Related documents

- [Flash and debug startup design (Chinese)](../../design/flash-and-debug.md)
- [J-Link](../getting-started/jlink.en.md)
