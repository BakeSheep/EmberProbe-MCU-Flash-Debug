# OpenOCD 与目标配置

[English](openocd-targets.en.md)

EmberProbe 在 Windows x64 和 Linux x64 上内置 OpenOCD，`emberprobe.openocdPath` 保持默认即可，无需单独安装。目标脚本列表来自所用 OpenOCD 自带的脚本，在侧栏选择。

要使用自己的 OpenOCD，在侧栏“配置 OpenOCD 路径”中选择，或设置 `emberprobe.openocdPath`，并使用该构建配套的 scripts。

## 额外提供的目标名

内置脚本之外，这几个名称可以直接选用。它们只是现有实现的别名，不代表新增了芯片支持：

| 目标脚本 | 实际使用 | 用途 |
| --- | --- | --- |
| `numicroM0.cfg` | `numicro.cfg` | NuMicro M0 |
| `numicroM4.cfg` | `numicro_m4.cfg` | NuMicro M4 |
| `stm32mp13x.cfg` | `st/stm32mp13x.cfg` | STM32MP13 |
| `stm32mp15x.cfg` | `st/stm32mp15x.cfg` | STM32MP15 |
| `renesas_rz_g2.cfg` | `renesas_rz.cfg` | Renesas RZ |
| `rp2040-core0.cfg` | `rp2040.cfg` | 只调试 RP2040 的 core 0 |

## STM32C0

使用 `stm32c0x.cfg`，支持 C011/C031/C051/C071/C091/C092。C0 没有 JTAG 引脚，`transport` 为 `auto` 时使用 SWD。

## STM32C5（实验性）

使用 `stm32c5x.cfg`，支持 C531/C532/C542、C551/C552/C562、C591/C593/C5A3。这一支持**尚未经过实板验证**。

- 调试器脚本用 `interface/stlink.cfg`、J-Link 或 CMSIS-DAP。`interface/stlink-hla.cfg` 不支持此目标，会在启动前被拒绝。
- 只能擦除、编程和读取 Flash，不能操作选项字节和 RDP。
- 擦写速度尚未测量。
- 使用自己的 OpenOCD 时需要它自带 C5 脚本和 Flash loader，否则报 `FLASH_LOADER_MISSING`。

## 限制

- 目标脚本能加载不代表每块板子都能用，也不代表所有功能都可用。实板支持需要单独验证。
- 需要额外驱动的厂商配置没有内置，包括 WCH、HPMicro、较新的 APM32/AT32 型号、STM32H5，以及更多的 Espressif 和 TI 系列。

## 相关文档

- [内置 OpenOCD 的构建与校验](../../design/openocd-build.md)
- [探针连接](probe-connections.md)
