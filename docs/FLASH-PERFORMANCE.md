# Flash performance / 烧录性能

Sidebar downloads and Agent `flash.execute` share one OpenOCD command built by `skills/_emberprobe/openocd-flash.js`. It still runs OpenOCD's own `program <elf> verify reset exit`, so target reset events, the work-area backup, final verification and reset-run are unchanged. Two steps are added around its `flash write_image erase` call.

侧边栏下载与 Agent `flash.execute` 共用 `skills/_emberprobe/openocd-flash.js` 生成的 OpenOCD 命令。整体仍由 OpenOCD 自带的 `program <elf> verify reset exit` 执行，target 复位事件、work-area 备份、最终校验与复位运行保持不变，只在其 `flash write_image erase` 前后增加两步。

## Unchanged images / 固件未变化

Before erasing, `verify_image_checksum` compares the image with target memory using an on-target CRC. When every section matches, erase and write are skipped; the normal final `verify_image` and reset still run. The terminal reports "固件与目标一致，已跳过擦写" and Agent results report `programming.unchanged: true`. A mismatch only costs the CRC and falls through to a normal erase and write. Bytes in partially used sectors outside the image are not re-erased when the image is skipped.

擦除前先用 `verify_image_checksum`（目标端 CRC）比较镜像与目标存储器。所有段一致时跳过擦写，最终 `verify_image` 与复位照常执行；终端显示“固件与目标一致，已跳过擦写”，Agent 结果为 `programming.unchanged: true`。不一致时只多一次 CRC 计算，随后正常擦写。跳过时，镜像未覆盖的扇区剩余字节不会被重新擦除。

## Programming clock / 烧录时钟

Target scripts choose conservative clocks (for example STM32F1 1 MHz, STM32H7 4 MHz after reset-init). After `reset init` has configured the target clocks, EmberProbe raises the SWD clock for the write:

target 脚本的速度偏保守（例如 STM32F1 为 1 MHz，STM32H7 在 reset-init 后为 4 MHz）。`reset init` 完成目标时钟配置后，EmberProbe 为写入提高 SWD 时钟：

| Probe / 探针 | Requested / 请求 | Effective / 实际 |
| --- | --- | --- |
| ST-Link (`hla`, `st-link`) | 24000 kHz | V2/V2-1 clamp to 4 MHz, V3 runs 24 MHz / V2 钳制为 4 MHz，V3 为 24 MHz |
| J-Link | 15000 kHz | Reduced to the model maximum by the driver / 驱动按型号上限降低 |
| CMSIS-DAP | 10000 kHz | Firmware uses its fastest supported divider / 固件取其最快可用分频 |
| Others / 其他 | — | Script clock / 脚本时钟 |

A nonzero `emberprobe.adapterSpeedKhz` replaces the table value. The clock is raised only for Cortex-M targets over SWD (`swd`, `hla_swd`, `dapdirect_swd`) and only when a CPUID read at the new clock matches the read at the previous clock. If the write or OpenOCD's final `verify_image` fails at the raised clock, EmberProbe restores the previous clock, runs `reset init` again, rewrites and verifies once more; only that second attempt's errors are reported. A successful fast write is verified once, as before. JTAG, RISC-V and other targets keep the script clock.

非零的 `emberprobe.adapterSpeedKhz` 替代表中数值。仅在 Cortex-M 且使用 SWD（`swd`、`hla_swd`、`dapdirect_swd`）时提速，并且新时钟下读取的 CPUID 必须与原时钟一致。提速后写入或 OpenOCD 最终 `verify_image` 失败时，恢复原时钟、重新 `reset init` 并重写、重新校验一次，只报告第二次的错误；高速写入成功时仍只校验一次。JTAG、RISC-V 等目标保持脚本时钟。

Measured on an APM32F407 with J-Link V9 (clamped to 12 MHz; the F4 script already runs at 8 MHz after reset-init), a full erase and write took about the same time, and the CRC pre-check added about 0.13 s; an unchanged image went from 2.1 s to 0.7 s. Targets whose scripts stay at a low clock (STM32F1 1 MHz, STM32H7 4 MHz) gain more from the raised clock. Erase time is set by the Flash itself and is not affected by the probe clock. Long or unshielded wiring may make the fallback run on every download; set an explicit lower `adapterSpeedKhz` in that case.

在 APM32F407 + J-Link V9（钳制为 12 MHz；F4 脚本在 reset-init 后已是 8 MHz）上实测，完整擦写耗时基本不变，CRC 预检约增加 0.13 s；固件未变化时由 2.1 s 降至 0.7 s。脚本时钟较低的目标（STM32F1 1 MHz、STM32H7 4 MHz）提速收益更大。擦除时间由 Flash 本身决定，不受探针时钟影响。连线较长或无屏蔽时可能每次都触发降速重烧，此时请设置较低的 `adapterSpeedKhz`。
