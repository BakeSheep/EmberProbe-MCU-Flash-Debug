# 烧录与下载

[English](flash.en.md)

侧栏下载、调试启动和 Agent 烧录都会把固件写入目标 Flash。每次都完整擦除、写入、校验并复位运行。

## 怎么用

- **下载**：在侧栏点击下载，或在资源管理器中右键 ELF。
- **调试**：启动 `launch` 配置时自动下载固件，再停在入口处。
- **Agent**：通过 `mcu-flash` skill 或 MCP 工具烧录，需要在对话中确认，见 [Agent 权限](../agent/permissions.md)。

## 下载行为

- 即使固件与目标 Flash 完全相同也会重新烧录，不会跳过。
- 烧录时 EmberProbe 自动提高 SWD 时钟，高速写入失败时恢复原时钟重写一次，只有第二次也失败才报错。
- 这一提速只用于 Cortex-M 的 SWD 连接。JTAG 和 RISC-V 等目标保持脚本时钟。

## 调整速度

`emberprobe.adapterSpeedKhz` 设为非零值时用作烧录时钟。

连线较长或没有屏蔽时，高速写入可能每次都失败再重写，下载反而变慢。这时设置一个较低的值。

擦除时间由 Flash 本身决定，提高时钟只缩短写入部分。

## launch 配置

| 配置 | 效果 |
| --- | --- |
| 默认 | 下载 `executable` 指定的 ELF |
| `loadFiles: ["a.elf", "b.elf"]` | 按顺序下载这些文件 |
| `loadFiles: []` | 不下载 |
| `request: "attach"` | 从不写入 Flash |

## 查看启动耗时

调试启动慢时，在 launch 配置中加上 `"performanceTrace": true`。调试控制台会输出各阶段耗时，比如查找工具链、启动 OpenOCD、启动 GDB、下载。记录里只有耗时，不含路径或目标数据。

Windows 上首次启动 GDB 可能需要几秒。EmberProbe 会在后台提前准备，打开工程后立刻调试时仍可能等待。

## 相关文档

- [烧录与调试启动设计](../../design/flash-and-debug.md)
- [J-Link](../getting-started/jlink.md)
