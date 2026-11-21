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

## GD32F1x0、GD32F3x0 与 AT32 单 Bank 型号

GD32F130/F150、GD32F310/F330/F350 通过 `gigadevice/` 下的目标配置复用 `stm32f1x` 驱动。配置显式声明 Flash Bank 大小，避免驱动根据 Cortex-M4 读 STM32F3 的容量地址。两个 GD32 系列均以 32 位读 ESIG `0x1FFFF7E0`，取低半字的容量。启动后的初始化钩子先核对 DBG_ID 的修订号和器件 ID，再核对实际容量。读取失败或不匹配时结束 OpenOCD 会话，阻止普通烧录和 GDB Flash 请求。

AT32 复用锁定构建内的 `artery/at32f4x.cfg` 和 `artery` 驱动。自动识别限于该版本驱动表列出的单 Bank 型号。芯片信息和自动探针身份检查使用完整 32 位 PID。GD32 目标保留修订号参与身份比较，以区分共用 STM32 DEV_ID 的器件。已记录器件的 ID 读取失败会终止该次连接检查。

离线验证使用 `noinit` 加载目标脚本，也以寄存器替身检查不同容量的配置和拒绝路径。两平台运行时沿用原二进制。厂商寄存器依据见 [GD32F1x0 用户手册](https://www.gd32mcu.com/download/down/document_id/151/path_type/1) 与 [GD32F3x0 用户手册](https://www.gd32mcu.com/data/documents/userManual/GD32F3x0_User_Manual_Rev3.3.pdf)。

## GD32F10x/F303、APM32E103/E030 与 CH32F103

单 Bank 目标使用 `target/emberprobe/f1-compat.tcl` 统一加载 `stm32f1x`。初始化检查 CPUID 和厂商器件 ID。GD32F101/F103 和 F303 还核对 CoreSight 设计者及 32 位 ESIG 容量。APM32E103 和 CH32F103 核对晶圆版本及容量。APM32E030 的手册标明 `0x00100440` 对应 x8，使用固定 64 KiB。检查失败时在擦写前结束 OpenOCD。

APM32F003 的主 Flash 基址、FMC 接口和选项字节与 `stm32f1x` 不同，工程识别先阻止选到通用 APM32F0 配置。GD32F105/F107、F20x、F403、E1x 和 C1x3 需进一步核对器件标识以及页布局或驱动流程。

`targetHelpers` 在清单中登记共享 Tcl 文件，打包时随两个运行时更新。离线测试在真实 OpenOCD 中用 `noinit` 和寄存器替身覆盖 ID、容量和设计者不匹配以及正常路径。

## GD32F303 双 Bank

`0005-gd32f30x-dual-bank.patch` 注册 `gd32f30x` 主 Flash 驱动，复用 `stm32f1x` 的半字编程和擦除实现。Bank 0 从 `0x08000000` 开始，固定 512 KiB，擦除页为 2 KiB。Bank 1 从 `0x08080000` 开始，擦除页为 4 KiB，控制寄存器从 `0x40022040` 开始。两个 Bank 分别探测，均要求 Cortex-M4、DEV_ID `0x430`、GigaDevice 的 CoreSight 设计者及与所选配置一致的 32 位 ESIG 容量。WP[31] 保护两个 Bank 中从 124 KiB 起的区域。驱动可查询保护状态，Flash 选项字节与解除保护操作不对外提供。页布局与寄存器见 [GD32F30x 用户手册](https://www.gd32mcu.com/data/documents/userManual/GD32F30x_User_Manual_Rev3.0.pdf)。

普通烧录和 GDB 下载共用整镜像预检。OpenOCD 先探测当前目标的两个 Bank，再检查所有镜像加载区间。区间可穿过相邻 Bank。超过物理 Flash 的区间在首次擦除前被拒绝。

## AT32 双 Bank

`0006-artery-dual-bank.patch` 在 `artery` 的读、擦除和编程流程上增加 `artery_dual`。AT32F403A/F407/F407A 的已知 1024 KiB PID 通过 `artery/at32f4x-1024.cfg` 使用两个 512 KiB Bank，每个 Bank 有 256 个 2 KiB 扇区。第二 Bank 基址为 `0x08080000`，解锁、状态、控制和地址寄存器相对第一 Bank 偏移 `0x40`。探测在首次写入前验证 Cortex-M4、完整 PID 和实际容量。主 Flash 操作保留 USD 和 FAP。普通烧录和 GDB 下载在擦除前核对两个 Bank 的整镜像范围。布局依据见 [AT32F403A/F407 参考手册](https://static.chipdip.ru/lib/639/DOC046639644.pdf)。

`artery/at32f43x-1024.cfg` 面向参考手册中列出完整 PID 的 8 个 F435/F437 型号。两 Bank 均为 512 KiB 和 2 KiB 扇区，Flash 控制器基址为 `0x40023C00`。探测同时核对 UID 系列字节。保护映射的前 128 KiB 每 4 KiB 一块，之后每 128 KiB 一块，第二 Bank 从 `FLASH_EPPS1` 的位 3 开始。见 [AT32F435/F437 参考手册](https://www.arterychip.com/download/RM/RM_AT32F435_437_EN_V2.06.pdf)。

两种双 Bank 配置在自动探针模式读取完整 PID 及 `0x1FFFF7E8` 的 96 位 UID，可以区分 PID 相同但 UID 不同的板卡。

### 待接入的 Arm 系列

| 系列 | 接入所需的驱动工作 |
| --- | --- |
| GD32F20x、GD32F403 | 双 Bank 容量档在 512 KiB 处分 Bank。两份厂商设备包的 SVD 将 `DBG_ID` 复位值填为零，实际器件值仍需确认。见 [GD32F20x 用户手册](https://www.gd32mcu.com/data/documents/userManual/GD32F20x_User_Manual_Rev3.3.pdf)、[GD32F403 用户手册](https://www.gd32mcu.com/data/documents/userManual/GD32F403_User_Manual_Rev2.6.pdf)。 |
| GD32F405/F407/F425/F427/F450/F470 | 3 MiB 布局包含 256 KiB 扇区，F425/F427/F470 还支持 4 KiB 页擦除。需要按器件和容量建表，并核对 Bank 切换、扇区编号和保护位。见 [GD32F4xx 用户手册](https://www.gd32mcu.com/data/documents/userManual/GD32F4xx_User_Manual_Rev2.7.pdf)。 |
| CH32F203/F205/F207 | CH32F203C8 的 224 KiB 包含 64 KiB 零等待区，同系列还有 480 KiB 布局。需要确认每个 Arm 型号的常规编程、快速区和扩展区的地址及擦除状态。见 [WCH 型号资料](https://www.wch.cn/products/CH32F203.html)、[CH32F203 下载说明](https://www.wch.cn/uploads/file/20230404/1680573065146901.pdf)。 |
| AT32F435/F437 960、1984、4032 KiB | 三档均使用 4 KiB 扇区，第二 Bank 分别从 `0x08080000`、`0x08100000`、`0x08200000` 开始。960 和 1984 KiB 需补齐 PID。4032 KiB 需澄清手册中 EPP6 的保留位与实际覆盖范围。见 [AT32F435/F437 参考手册](https://www.arterychip.com/download/RM/RM_AT32F435_437_V2.07_EN.pdf)。 |
| APM32F003 | 主 Flash 起址为 `0x00000000`，16/32 KiB 容量从 `0x000203E0` 读取，FMC 控制器从 `0x40011000` 开始。还需验证可区分其他 Cortex-M0+ 的器件身份。见 [APM32F003 用户手册](https://global.geehy.com/uploads/tool/APM32F003x4x6%20User%20Manual%20V1.5.pdf)。 |
| APM32F035、M3514 及遗漏的 F4 | F035/M3514 的主 Flash 从 `0x08000000` 开始，容量为 64 KiB，页大小为 1 KiB。手册的 `DBGMCU_IDCODE` 复位值与器件和修订字段的描述不一致。遗漏的 F4 需按器件确认扇区和保护方式。见 [APM32F035/M3514 用户手册](https://www.geehy.com/uploads/tool/APM32F035x8_M3514x8%C2%A0%E7%94%A8%E6%88%B7%E6%89%8B%E5%86%8C%C2%A0V1.2.pdf)。 |

## 兼容性与验证边界

GD32 E23x 和 VF103 沿用上游配置。CH32F20x、HPMicro、部分 APM32/AT32、STM32H5、Espressif 和 TI 系列仍需额外驱动。Nuvoton 厂商脚本使用过时的 DAP API，现有 `numicro` 驱动也无法据此确认 M23 支持。

`npm run check:openocd-bundle`、`test/openocd-target-bundle.test.js` 和 `test/openocd-installer.test.js` 检查包清单、源码摘要、原始内容、目标目录、安装发现和配置加载。Windows x64 与 WSL Ubuntu 26.04 下的 Linux x64 均已完成配置加载检查，配置加载检查覆盖目标、Flash Bank 和选定传输协议。检查以 `shutdown` 退出，不执行 `init`。真机支持须按 [HIL 流程](../../test/hil/README.md)单独验证。
