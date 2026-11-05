# 调试工具链

[English](toolchain.en.md)

调试需要 ARM GDB、objdump 和 nm。EmberProbe 直接使用本机已有的工具链，不需要另外安装一份。如果已经装过 STM32CubeCLT、STM32CubeIDE 或 ST bundles，通常无需任何配置。

## 查找顺序

点击调试时按以下顺序查找，三个工具都存在才会采用：

1. `launch.json` 中的工具路径，以及 `emberprobe.gdbPath`、`emberprobe.armToolchainPath`、`emberprobe.objdumpPath` 设置。
2. 之前在目录选择框里选定的工具链目录。
3. 系统 PATH。VS Code 启动后才安装的工具也能找到。
4. ST 工具的常见安装位置：先查 ST bundles，再查 CubeCLT 和 CubeIDE。
5. 都没有时提示选择目录，选 `bin` 或包含 `bin` 的目录都可以。

## 手动指定

工具链装在非标准位置时，直接配置 bin 目录：

```json
{
  "emberprobe.armToolchainPath": "C:/ST/STM32CubeCLT_1.18.0/GNU-tools-for-STM32/bin"
}
```

GDB 和 binutils 分开安装时，同时设置 `emberprobe.gdbPath` 和 `emberprobe.armToolchainPath`。工具前缀默认是 `arm-none-eabi`，其他前缀用 `emberprobe.armToolchainPrefix` 设置。

## 自动查找的位置

| 系统 | ST bundles | CubeCLT、CubeIDE |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\stm32cube\bundles` | `C:\ST`，以及 Program Files、Program Files (x86)、LOCALAPPDATA 下的 `STMicroelectronics`、`ST` |
| Linux | `~/.local/share/stm32cube/bundles`（遵循 `XDG_DATA_HOME`） | `/opt/st`、`/opt/ST`、`/opt`、`/usr/local/STMicroelectronics`、`~/ST` |
| macOS | `~/Library/Application Support/stm32cube/bundles` | `/Applications/STMicroelectronics`、`/Applications`、`~/Applications` |

同一工具有多个版本时优先用最新版本。

## 限制

- 查找只读取目录，不运行 ST 命令，不下载工具，也不修改设置。
- 自动找到的路径不保存，ST 工具更新后会重新发现；手动选定的目录会被记住。
- 使用本机 GDB 不会启动 ST 的调试服务器。EmberProbe 仍通过 OpenOCD 或显式配置的外部服务器连接。

## 常见问题

**装了工具链仍提示找不到**：确认三个工具都在同一目录且可执行。安装位置太深或不标准时用 `emberprobe.armToolchainPath` 指定。

**用错了版本**：设置 `emberprobe.armToolchainPath` 固定版本，设置优先于自动查找。
