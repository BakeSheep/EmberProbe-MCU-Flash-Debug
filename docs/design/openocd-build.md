# 内置 OpenOCD 构建与目标配置

用户操作见 [OpenOCD 与目标配置](../guide/getting-started.md#openocd-与目标配置)。本页描述内置运行时的来源、完整性和兼容性边界。

## 运行时与目标别名

`resources/openocd-win32-x64.tar.gz` 和 `resources/openocd-linux-x64.tar.gz` 包含基于 xPack OpenOCD 0.12.0-7 源码构建的 EmberProbe 版本，带 scatter 读取补丁与已审查的目标配置。重新打包保留可执行文件、脚本、库、许可证、权限及链接目标。以下别名复用原有目标实现。

| 增加的配置 | 使用的实现 | 用途 |
| --- | --- | --- |
| `numicroM0.cfg` | `numicro.cfg` | 兼容 NuMicro M0 旧名称 |
| `numicroM4.cfg` | `numicro_m4.cfg` | 兼容 NuMicro M4 旧名称 |
| `stm32mp13x.cfg` | `st/stm32mp13x.cfg` | 上游目录变化后保留目录项 |
| `stm32mp15x.cfg` | `st/stm32mp15x.cfg` | 上游目录变化后保留目录项 |
| `renesas_rz_g2.cfg` | `renesas_rz.cfg` | 复用现有 Renesas RZ 目标实现 |
| `rp2040-core0.cfg` | `rp2040.cfg`，`USE_CORE=0` | 使用现有多点 SWD 实现，只配置核 0 |

别名配置由调用方选择适配器和传输协议。器件 ID、Flash bank、擦写与复位行为由原始脚本决定。NuMicro 别名沿用驱动已知的器件 ID，Renesas RZ 保留原始脚本的器件限制。可加载配置只验证声明有效，实际兼容范围取决于目标、探针和使用的功能。

备用目录排除缺失的 `nds32v2.cfg`、`nds32v3.cfg`、`nds32v3m.cfg` 和 `vd_xtensa_jtag.cfg`。可选目标以运行时发现的脚本为准。

## 完整性与重新打包

别名源码在 `resources/openocd-targets/target/`。`resources/openocd-targets-manifest.json` 记录来源 URL、补丁、构建和源码身份，以及可执行文件和部署压缩包的摘要。聚合摘要覆盖审查的非目录条目及其权限、链接目标。每个平台的发行目录带有 `distro-info/emberprobe-targets.json`。

构建和源码分发流程见[内置 OpenOCD 构建](../../native/openocd/README.md)。复用锁定的原生构建时，`npm run openocd:package -- --input test-results/openocd-scatter-release` 拒绝混用构建版本、缺失依赖或同名别名冲突。打包流式复制原 tar 条目，无需先在构建主机上解包，因此 Windows 上重打包仍能保留 Linux 权限和链接。安装缓存键含压缩包摘要，包发生变化时使用新目录，其他窗口可继续使用旧运行时。

只修改目标 Tcl 脚本时，可针对已核验的现有构建运行 `npm run openocd:package -- --scripts target/stm32c5x.cfg`。替换脚本保存在 `resources/openocd-targets/`。`scriptOverrides` 记录相对路径、原始原生构建脚本摘要和替换摘要。打包先校验现有运行时，确认对应源码包包含原脚本，再以事务方式更新两平台压缩包及其来源记录。

仅替换脚本时，原生二进制摘要与 `BUILD-INFO.json` 保留真实构建身份。源码包保留原始构建输入，同时增加 `runtime-script-overrides/` 与条目清单。普通 `--input` 打包也会将登记的脚本替换应用到匹配构建。变更 C 源码、依赖、原生补丁或构建配方时，须重新执行锁定的完整构建。

<a name="stm32c0-and-stm32c5"></a>

## STM32C0 与 STM32C5

STM32C0 使用基础构建的 `stm32c0x.cfg` 和 `stm32l4x` Flash 驱动，覆盖 C011/C031/C051/C071/C091/C092。C0 无 JTAG 引脚，J-Link 在 `auto` 下按已知 Cortex-M 目标使用 SWD。

STM32C5（Cortex-M33）使用实验性支持。锁定构建的基础版本通过以下补丁增加 C5 配置。

| 补丁 | 来源 | 职责 |
| --- | --- | --- |
| `0002-stldr-flash-driver.patch` | 上游评审 9697，补丁集 8 | `stldr` 驱动在目标上执行 STM32CubeProgrammer Flash 加载器 |
| `0003-stm32c5x-target.patch` | 上游评审 9699，补丁集 6 | 提供 `target/stm32c5x.cfg` |
| `0004-emberprobe-c5-local-loaders.patch` | EmberProbe | 按 DEV_ID 使用内置加载器 |

上游评审中的在线加载器方案没有进入该构建。运行时从 `scripts/flash_loaders/stm32c5/` 取用 ST `stm32c5xx-dfp` 2.1.0 的三个加载器，哈希由清单固定。

| DEV_ID | 器件 | 加载器 |
| --- | --- | --- |
| 0x44F | C531/C532/C542 | `STM32C53x_C54x.xldr` |
| 0x44E | C551/C552/C562 | `STM32C55x_C56x.xldr` |
| 0x45A | C591/C593/C5A3 | `STM32C59x_C5Ax.xldr` |

C5 需要 HLA 无法创建的调试 AP。使用 `interface/stlink-hla.cfg` 时扩展会在启动前拒绝。`interface/stlink.cfg` 使用 `st-link`（dapdirect SWD）驱动，可加载配置，J-Link 和 CMSIS-DAP 也具备这一配置路径。加载器支持擦除、编程和读取 Flash，选项字节与 RDP 尚无 C5 OpenOCD 命令。擦写性能和超时取决于加载器。外部 OpenOCD 须自带匹配脚本和加载器，缺失时报告 `FLASH_LOADER_MISSING`。

C5 脚本替换从事件目标推导芯片名，并把加载器表声明为全局变量，使 `examine-end` 可在 OpenOCD 的 `program` 或复位过程内运行。查找或初始化失败时保留 `EXAMINED=0`，允许修正配置后重新初始化。离线事件测试覆盖三个 DEV_ID、自定义目标名及失败后的重试，寄存器和加载器操作使用替身，`noinit` 阻止初始化物理探针。

2026 年 11 月 12 日，Windows 上的 STM32C593 与 WCH-LinkW 组合完成五次实板烧录、校验和复位。详细连接与结果见本地 `docs/records/audits/2026-11-13-c593-wchlinkw.md`。该记录限于测试配置，其他 C5 型号、探针、系统及长期无线稳定性仍须分别验收。

## 兼容性与验证边界

GD32 E23x 和 VF103 沿用上游配置。需要额外驱动的 WCH、HPMicro、部分 APM32/AT32、STM32H5、Espressif 和 TI 厂商配置未加入内置包。Nuvoton 厂商脚本使用过时的 DAP API，现有 `numicro` 驱动也无法据此确认 M23 支持。

`npm run check:openocd-bundle`、`test/openocd-target-bundle.test.js` 和 `test/openocd-installer.test.js` 检查包清单、源码摘要、原始内容、目标目录、安装发现和配置加载。Windows x64 与 WSL Ubuntu 26.04 下的 Linux x64 均已完成配置加载检查，六个别名保留原始目标、Flash bank 和选定传输协议。检查以 `shutdown` 退出，不执行 `init`。真机支持须按 [HIL 流程](../../test/hil/README.md)单独验证。
