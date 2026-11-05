# Debug Toolchain

[中文](toolchain.md)

Debugging needs ARM GDB, objdump and nm. EmberProbe uses the toolchain already on your machine, so no separate install is needed. If you have STM32CubeCLT, STM32CubeIDE or ST bundles, usually nothing needs configuring.

## Lookup order

When you start debugging, EmberProbe looks in this order and accepts a candidate only if all three tools exist:

1. Tool paths in `launch.json`, then the `emberprobe.gdbPath`, `emberprobe.armToolchainPath` and `emberprobe.objdumpPath` settings.
2. A toolchain folder you picked earlier in the folder dialog.
3. The system PATH, including tools installed after VS Code started.
4. Common ST install locations: ST bundles first, then CubeCLT and CubeIDE.
5. If nothing is found, you are asked to choose a folder: either `bin` or a folder containing `bin`.

## Setting it manually

If the toolchain is in a non-standard location, point at its bin folder:

```json
{
  "emberprobe.armToolchainPath": "C:/ST/STM32CubeCLT_1.18.0/GNU-tools-for-STM32/bin"
}
```

If GDB and binutils are installed separately, set both `emberprobe.gdbPath` and `emberprobe.armToolchainPath`. The tool prefix defaults to `arm-none-eabi`; set `emberprobe.armToolchainPrefix` for others.

## Locations searched

| OS | ST bundles | CubeCLT, CubeIDE |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\stm32cube\bundles` | `C:\ST`, plus `STMicroelectronics` and `ST` under Program Files, Program Files (x86) and LOCALAPPDATA |
| Linux | `~/.local/share/stm32cube/bundles` (honors `XDG_DATA_HOME`) | `/opt/st`, `/opt/ST`, `/opt`, `/usr/local/STMicroelectronics`, `~/ST` |
| macOS | `~/Library/Application Support/stm32cube/bundles` | `/Applications/STMicroelectronics`, `/Applications`, `~/Applications` |

When several versions exist, the newest is used.

## Limits

- The search only reads folders. It runs no ST commands, downloads nothing and changes no settings.
- Automatically found paths are not saved, so they follow ST tool updates. A folder you picked is remembered.
- Using your GDB does not start ST's debug server. EmberProbe still connects through OpenOCD or an explicitly configured external server.

## Troubleshooting

**Installed but reported as missing**: check that all three tools are in one folder and executable. For deep or non-standard locations, set `emberprobe.armToolchainPath`.

**Wrong version used**: set `emberprobe.armToolchainPath` to fix the version. Settings take priority over discovery.
