# EmberProbe

EmberProbe 是一款基于 OpenOCD 面向 Cortex-M 开发的 VSCode 扩展，集成固件烧录、断点调试、实时变量观测与 Agent 辅助开发。

> [English documentation](README_EN.md)

![实时图表面板：采样波形、当前数值与写入列表](docs/images/live-watch-waveform.png)

## 功能特性

- **自动识别**：检测工作区中最新的 ELF 文件与 MCU 目标。
- **固件烧录**：一键烧录 ELF 文件并运行，支持固件校验。
- **芯片信息**：查看芯片身份、存储容量与运行状态。
- **实时变量观测**：在目标运行时查看变量数值与波形，支持多图表、历史查看和 CSV 导出。
- **实时变量写入**：在目标运行时调整变量值，并自动回读校验。
- **内置断点调试**：支持断点、单步、调用栈、变量与寄存器查看，以及内存读写。
- **Agent 辅助开发**：提供可选安装的 Agent Skills，辅助完成固件开发、调试与分析。

## Agent Skills

| 重点功能 | Skill |
| --- | --- |
| 固件烧录与变量读写 | `mcu-flash`、`mcu-variables` |
| 芯片信息与故障分析 | `mcu-chip-info`、`mcu-fault-analyzer` |
| ELF 与外设分析 | `mcu-elf-analyze`、`mcu-peripheral-debug` |
| 断点与 FreeRTOS 调试 | `mcu-debug-control`、`mcu-rtos` |
| 配置管理与 CubeMX 代码生成 | `mcu-config`、`mcu-cubemx` |

## 环境要求

- Visual Studio Code 1.85 或更高版本
- OpenOCD
- ARM GDB 工具链（断点调试必需）

当前扩展版本为 `0.8.0`。

## 更多文档

- [Agent Skills](skills/)
- [实时变量采样说明](docs/LAYERED-SAMPLING.md)
- [FreeRTOS 调试说明](docs/RTOS-AWARENESS.md)
- [CubeMX 代码生成说明](docs/CUBEMX-GENERATION.md)
- [发布指南](docs/RELEASING.md)

## 许可证与归属

扩展代码采用 MIT 许可证。npm 运行时依赖与自带 xPack OpenOCD 的许可证及来源信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
