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

## 环境要求

- Visual Studio Code 1.85 或更高版本
- OpenOCD
- ARM GDB 工具链（断点调试必需）

当前扩展版本为 `0.8.5`。

## 使用教程

| 章节 | 内容 |
| --- | --- |
| [一、配置与连接](#一配置与连接) | 一键配置、Debug 构建预设、手动配置、J-Link 配置、ARM 工具链 |
| [二、功能使用](#二功能使用) | 烧录、复位/不复位调试、芯片信息、实时读写、波形图、外设寄存器、RTOS 任务、内存占用 |
| [三、高级功能](#三高级功能) | RTOS 栈使用配置、调用栈任务感知、launch.json、探针与采样设置、C++ 显示、Agent Skills |
| [四、实验性功能](#四实验性功能) | 外部 GDB Server、不限速采样、CPU 负载估计、多核共享调试组 |
| [常见问题](#常见问题) | 变量读不到、探针被占用、J-Link 打不开等 |

### 一、配置与连接

#### 1. 一键配置

1. **安装 OpenOCD**：插件启动后自动检测 OpenOCD（需 0.12.0 及以上）。若未找到，侧边栏会出现“OpenOCD 环境”卡片：
   - **一键安装**：Windows x64 直接解压插件内置的 xPack OpenOCD 0.12.0-7，无需联网；
   - **选择路径**：指定已安装的 `openocd` 可执行文件（写入设置 `emberprobe.openocdPath`）；
   - **重新检测**：安装或修改 PATH 后重新检查。
   - Linux 请用包管理器安装（如 `sudo apt install openocd`），macOS 可用 `brew install openocd`，然后点击“选择路径”。
2. **自动检测配置**：展开“MCU 配置”，点击 **自动检测配置**。插件会扫描工作区并填充下方三项：
   - **ELF 固件**：工作区内修改时间最新的 `*.elf`；
   - **MCU 目标**：根据 `.ioc`、`CMakeLists.txt`、`*.cmake`、`*.ld` 中的芯片型号匹配 OpenOCD target 脚本（STM32 全系、APM32、GD32、nRF51/52、RP2040 等）；
   - **调试器**：读取 USB 设备，识别 ST-Link、CMSIS-DAP/DAPLink、J-Link 等探针；同时插着多种探针时会让你选择。
3. 自动检测结果不对时，可在“手动配置”中逐项修改。

![一键配置：自动检测、手动配置项与官方 SVD 下载](docs/images/tutorial/01-config.gif)

#### 2. 注意：使用 Debug 预设构建

实时读写、断点调试、外设与 RTOS 视图都依赖 ELF 中的符号表和 DWARF 调试信息，**请使用 Debug 预设构建固件**：

使用 Release 或去掉调试信息的 ELF 时，可能出现：变量类型只能按大小推测（提示“未读取到 DWARF 类型信息”）、局部变量显示 `optimized out`、结构体无法展开、RTOS 内核符号被优化掉导致任务面板为空等问题。

#### 3. 单独配置（手动配置）

在“MCU 配置 → 手动配置”中逐项选择：

| 配置项 | 说明 |
| --- | --- |
| 选择 ELF 固件 | 从工作区内所有 `*.elf` 中选择要烧录与观测的固件 |
| 选择调试器 | OpenOCD interface 脚本，例如 `stlink.cfg`、`cmsis-dap.cfg`、`jlink.cfg`；列表来自当前 OpenOCD 实际包含的脚本，支持厂商分支 |
| 选择 MCU 目标 | OpenOCD target 脚本，例如 `stm32f4x.cfg`、`stm32h7x.cfg`、`geehy/apm32f4x.cfg` |

“其他配置”中的可选项：

| 配置项 | 说明 |
| --- | --- |
| 选择 SVD 文件 | 外设寄存器视图需要。点击 **下载官方 SVD** 会从官方 CMSIS-Pack 目录查找与当前芯片匹配的 SVD，下载前需确认来源许可，下载中可再次点击取消；也可点击条目选择本地已有 SVD 或清除当前工作区绑定 |
| CubeMX 路径 | STM32CubeMX 可执行文件，供 Agent 的 CubeMX 代码生成使用（Windows / Linux） |
| .ioc 路径 | 当前工程的 CubeMX 工程文件；若所需 STM32Cube 固件包未安装，会显示 **在 CubeMX 中安装** 按钮 |

以上配置按工作区保存，切换工程互不影响。

#### 4. J-Link 配置

EmberProbe 通过 OpenOCD 的 J-Link 后端工作，OpenOCD 要求 J-Link 使用 **WinUSB** 驱动，而 SEGGER 官方驱动安装后默认使用 SEGGER USB 驱动。

1. 在“选择调试器”中选择 `jlink.cfg`（或使用自动检测）。
2. Windows x64 下，若检测到唯一一台使用 SEGGER 驱动的 J-Link，“选择调试器”右侧会出现 **WinUSB / SEGGER** 下拉框，并提示当前驱动不受支持。
3. 在下拉框中选择 **WinUSB**：插件会运行内置的驱动切换工具，Windows 可能弹出管理员授权或“未知发布者”提示，确认后等待下拉框结束加载状态即可使用。
4. 需要恢复 SEGGER 工具（J-Flash、Ozone 等）时，在同一下拉框中选择 **SEGGER** 恢复原驱动。

注意：

- 网购名称如“V9 JLinkOB”不代表一定兼容，是否支持 WinUSB 取决于实际硬件与固件；
- Ozone 等 SEGGER 软件占用探针时，OpenOCD 无法同时打开它，请先关闭对方；
- 多台探针同时连接时，首次操作会弹出“选择物理调试探针”，选择后记住该设备；指定的设备不在线时**不会**自动改用其他探针；
- 序列号、SWD/JTAG 协议、调试速度可在设置中手动覆盖，见第三章“探针高级设置”。

更多细节见 [J-Link 兼容性说明](docs/JLINK-COMPATIBILITY.md)。

#### 5. ARM 工具链

烧录与实时读写只需要 OpenOCD；**断点调试**还需要 ARM GDB 工具链（GDB、objdump、nm），推荐安装 [Arm GNU Toolchain](https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads)。插件优先从 PATH 中查找；找不到时，第一次启动调试会提示 **选择工具链目录**，选择工具链根目录或 `bin` 目录即可，也可在设置中填写 `emberprobe.armToolchainPath` / `emberprobe.gdbPath`。

### 二、功能使用

#### 1. 烧录

点击 **烧录**：插件启动 OpenOCD，写入当前 ELF、校验并复位运行。状态行与日志显示连接、写入、校验进度，以及写入速度与目标电压等信息；失败时可展开“连接诊断”查看并复制完整的结构化错误。

也可以在资源管理器中右键工程文件夹，选择 **EmberProbe: 下载程序**，或在命令面板执行同名命令。

![烧录](docs/images/tutorial/02-flash.gif)

#### 2. 复位调试 / 不复位调试

| 按钮 | 行为 |
| --- | --- |
| **复位调试** | 复位并暂停芯片 → 通过 GDB 下载当前 ELF → 再次复位 → 运行到 `main` 停下 |
| **不复位调试** | 附加到正在运行的芯片并暂停，**不复位、不下载固件** |

> 使用“不复位调试”时，选中的 ELF 必须与芯片中正在运行的固件一致。

调试启动后使用 VS Code 原生调试界面：

- 顶部调试工具栏：继续/暂停（F5）、单步跳过（F10）、单步进入（F11）、单步跳出（Shift+F11）、重启、停止（Shift+F5）；
- 断点、条件断点、调用栈、监视表达式、调试控制台；
- 变量视图支持结构体、数组、枚举，以及 `std::vector`、`std::string` 等 STL 容器的展开显示；
- 调试期间侧边栏的实时读写、外设寄存器、RTOS 任务会切换到当前调试会话读取，芯片暂停时显示暂停时刻的数值。

右键工程文件夹的 **EmberProbe: 启动调试**、**EmberProbe: 不复位调试（保留现场）** 与按钮作用相同；需要自定义参数时可使用 `launch.json` 和 F5 启动，见第三章。

![复位调试：进入调试界面并单步](docs/images/tutorial/03-debug.gif)

#### 3. 芯片信息

展开“芯片信息”，点击 **读取**（读取后变为 **重新读取**）：

| 内容 | 说明 |
| --- | --- |
| 内核与型号 | 例如 Cortex-M4 / STM32F407ZG；内核与系列不符时会标记 |
| 适配器时钟、设计厂商、调试探针 | 当前连接的 SWD/JTAG 时钟、芯片厂商、探针型号与协议 |
| 读取时状态 | Running / Halted；右侧 **▶/⏸** 继续或暂停芯片，**↻** 复位并运行 |
| 详细信息 | 内核修订、Device ID、Revision ID、JEP106、**原厂校验**（区分原厂与兼容芯片）、Flash 容量、字节序、UID（可 **复制**）、调试器固件、传输协议、目标电压、停止原因及暂停时的寄存器 |

读取芯片信息会短暂独占探针：实时采样、烧录、调试进行中时会提示先结束对应操作。复位后请重新读取以刷新状态。

![芯片信息：读取、控制按钮与详细信息](docs/images/tutorial/04-chip-info.gif)

#### 4. 实时读写

在芯片**运行时**通过调试端口非侵入地读写 RAM 中的全局/静态变量，不需要暂停 CPU。

![实时读写：采样、复合变量、写入与变量筛选](docs/images/tutorial/05-live-read-write.gif)

**写入列表**：修改运行中的变量，写入后自动回读校验。

- 在输入框中输入数值后按 Enter 写入；
- `−` / `+` 步进写入；
- 拖动滑块连续写入；输入超出滑块范围的值时，滑块范围会自动平移；
- 必须先点击 **开始** 采样才能写入。

**ELF 全部变量**：列出当前 ELF 中所有可观测变量。

- 搜索框可筛选变量名及结构体子成员名，`×` 清除筛选；
- **仅用户**：隐藏 HAL/CubeMX、RTOS 内核、中间件、工具链库生成的变量，只保留自己代码中的变量（启发式判断，悬停变量名可查看分类与源文件）；
- **↻**：重新编译后刷新变量列表；
- 每行左侧 `✎` 加入写入列表，`+` 加入查看列表（已加入显示 `✓`，再次点击移除）；
- 拖动列表底部边缘可调整高度。

说明：

- 运行时读取只允许访问 ELF 中可写的 RAM 段，并限制每轮读取量；局部变量、寄存器变量无法实时读取；
- 烧录新固件后变量与内存信息会自动刷新。

#### 5. 波形图

点击实时读写中的 **图表**（或命令 **EmberProbe: 实时变量查看**）打开波形图窗口。

![波形图：采样、归一化、冻结、隐藏曲线、曲线设置、导出与导入](docs/images/tutorial/06-waveform.gif)

**工具栏**

| 控件 | 作用 |
| --- | --- |
| `‹ 数值栏` | 折叠/展开左侧当前数值栏，分隔条可左右拖动调整宽度 |
| 波形目标频率 | 0.1–200 Hz（默认 30 Hz），实际频率受探针吞吐自适应调整 |
| 冻结图表 / 恢复实时 | 冻结画面查看历史，采样在后台继续；恢复后回到最新数据 |
| 归一化 | 各曲线独立缩放到同一高度，便于比较量级差别大的变量 |
| 清空历史 | 清空本窗口的采样历史 |
| 导出 CSV | 选择曲线、数据来源（完整采样归档 / 实时保留数据 / 冻结快照）与时间范围（全部、最近 10/30/60 秒、自定义区间）后保存 |
| 自动 Y 轴 | 恢复纵轴自动缩放 |

**图表操作**

- 滚轮：在绘图区内同时缩放时间和数值，在时间轴上只缩放时间，在纵轴上只缩放数值（之后可点 **自动 Y 轴** 恢复）；
- 按住右键拖动：平移视图；
- 左键点击曲线：冻结并固定该时刻读数，曲线重合时可逐项选择；
- 拖动底部时间轴的高亮区域或两端：调整显示的时间范围。

历史数据最近 30 分钟保存在内存中，完整采样另存在磁盘归档（随扩展会话结束自动删除），容量可在设置中调整，见第三章。

#### 6. 外设寄存器

前提：已在“其他配置”中选择或下载 SVD 文件，并且**处于调试会话中且芯片已暂停**（目标运行时显示上次暂停时的数值）。

| 控件 | 作用 |
| --- | --- |
| ↻ | 刷新已展开的寄存器 |
| HEX / DEC / BIN | 切换数值显示格式 |
| `▸` | 展开外设 → 寄存器 → 位域 |
| 点击寄存器名 | 读取该寄存器 |
| `−` / `+` / 数值框 | 减 1、加 1 或直接输入数值写入寄存器或位域，写入后自动回读 |

SVD 标记为“读取有副作用”的寄存器（例如读取即清除标志的状态/数据寄存器）不会被读取，悬停可看到原因；只写、带特殊写入语义的寄存器不提供写入控件。拖动面板底部边缘可调整高度。

![外设寄存器：筛选、读取、展开位域、写入与格式切换](docs/images/tutorial/07-peripherals.gif)

#### 7. RTOS 任务

前提：使用 EmberProbe 内置调试器（复位调试/不复位调试）进入调试，**芯片暂停**后读取 FreeRTOS 任务快照。

| 控件 | 作用 |
| --- | --- |
| 筛选任务 | 按任务名筛选 |
| 排序 | 按任务名、优先级或状态排序 |
| ↻ | 刷新暂停快照 |
| `▸` | 展开任务详情：任务标识、TCB 地址、基础优先级、保存的 SP、栈基址、栈大小、已用/剩余栈空间、运行计数器 |
| 底部边缘 | 拖动调整任务表高度 |

表格列为任务名、状态（Running / Ready / Blocked / Suspended）、优先级与 **栈使用** 百分比。目标继续运行后，快照会标记为“历史快照”；停在 `main` 时调度器尚未启动，继续运行后再次暂停即可看到任务。栈使用列需要固件满足一定配置，见第三章。

![RTOS 任务：刷新、按优先级排序、拖动加高与查看栈使用详情](docs/images/tutorial/08-rtos-stack.gif)

#### 8. 内存占用

展开烧录调试卡片中的 **其他 → 内存占用**，可查看 FLASH、RAM（及 CCMRAM 等自定义区域）的占用量、容量与百分比，展开可看节明细和最大符号；**↻** 重新分析。容量来自工程的 `.map` 或链接脚本 `.ld`，有多个候选时会让你选择。该统计是链接时的节大小，不代表运行时栈/堆峰值。

### 三、高级功能

#### 1. 配置 RTOS 栈使用查看

RTOS 面板的“栈使用”采用**填充估算**（高水位）：FreeRTOS 创建任务时把栈填充为 `0xA5`，EmberProbe 在暂停时从栈底向上统计仍为 `0xA5` 的字节数，得到历史峰值使用量。它反映的是“曾经用到的最深位置”，不是当前 SP。

在 `FreeRTOSConfig.h` 中需要满足：

```c
/* 1. TCB 中记录栈顶地址 pxEndOfStack，用于计算栈大小（Cortex-M 栈向下增长时必需） */
#define configRECORD_STACK_HIGH_ADDRESS        1

/* 2. 新建任务时用 0xA5 填充栈，满足以下任意一项即可 */
#define configCHECK_FOR_STACK_OVERFLOW         2
/* 或 #define configUSE_TRACE_FACILITY        1 */
/* 或 #define INCLUDE_uxTaskGetStackHighWaterMark 1 */

/* 3. 可选：任务详情中显示“运行计数器”，需同时提供运行时统计定时器 */
#define configGENERATE_RUN_TIME_STATS          1
```

使用 STM32CubeMX 时，可在 **Middleware → FREERTOS → Config parameters** 中开启对应选项（如 `RECORD_STACK_HIGH_ADDRESS`、`CHECK_FOR_STACK_OVERFLOW`、`USE_TRACE_FACILITY`），重新生成代码并以 Debug 预设编译、重新烧录或使用复位调试下载。

注意：

- 缺少 `pxEndOfStack` 时栈大小未知，栈使用列显示“不可用”；
- 栈使用只统计内核创建的任务栈，单次扫描上限 64 KiB；
- 面板目前支持小端单核 Cortex-M 的 FreeRTOS；读取均在暂停时进行，有任务数、节点数与时间预算保护，读取失败会显示部分结果与诊断信息。

#### 2. 调用栈中的 RTOS 任务

默认情况下调试器只显示一个线程。在设置中把 `emberprobe.rtos` 设为 `FreeRTOS`（区分大小写，也支持 `ThreadX`、`Zephyr`、`uCOS-III` 等），下次启动调试时 VS Code 调用栈会按任务列出，切换任务可查看各自的栈帧与局部变量，单步也会绑定到所选任务。

固件需保留 `uxTopUsedPriority` 等内核符号；若被链接器优化掉，OpenOCD 会找不到任务。建议写明 RTOS 名称而不是 `auto`。详见 [RTOS 感知调试](docs/RTOS-AWARENESS.md)。

#### 3. 使用 launch.json 自定义调试

在 `.vscode/launch.json` 中添加 `emberprobe` 类型的配置，即可按 F5 启动，探针、目标与 OpenOCD 仍沿用侧边栏配置：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "EmberProbe: Launch",
      "type": "emberprobe",
      "request": "launch",
      "executable": "${workspaceFolder}/build/Debug/app.elf",
      "runToEntryPoint": "main",
      "rtos": "FreeRTOS"
    }
  ]
}
```

- `request` 为 `attach` 时等同于“不复位调试”；
- `runToEntryPoint` 指定启动后停下的函数；
- `rtos` 覆盖工作区设置，写 `""` 可在该会话关闭任务感知；
- 另支持 `preLaunchCommands` / `postLaunchCommands` / `preAttachCommands` / `postAttachCommands`（GDB 命令钩子）、`loadFiles`（下载多个镜像）、`symbolFiles`（附加符号文件）、`sourceFileMap`（源码路径映射）等字段，编辑时可借助 VS Code 自动补全查看全部字段。

#### 4. 探针高级设置

在 VS Code 设置中搜索 `emberprobe`：

| 设置 | 说明 |
| --- | --- |
| `emberprobe.probeSerial` | 指定探针序列号（J-Link 为十进制，DAP/ST-Link 区分大小写），多探针时固定使用某一台 |
| `emberprobe.transport` | `auto`（默认）/ `swd` / `jtag` |
| `emberprobe.adapterSpeedKhz` | 调试链路时钟（kHz），`0` 使用脚本默认值；接线较长或不稳定时可降低 |
| `emberprobe.tclPort` | 实时采样使用的 OpenOCD Tcl 端口，默认随机，建议保持默认 |
| `emberprobe.openocdPath` | OpenOCD 可执行文件路径 |

#### 5. 采样频率与历史容量

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `emberprobe.sampleFrequencyHz` | 30 | 波形窗口目标采样频率（侧边栏固定 20 Hz） |
| `emberprobe.chartHistoryMaxMiB` | 512 | 波形历史内存预算，耗尽时淘汰最旧数据，磁盘归档继续记录 |
| `emberprobe.samplingArchiveMaxMiB` | 1024 | 本次扩展会话的磁盘归档上限，退出时自动删除 |

侧边栏与波形窗口共用同一个采样连接，变量同轮到期时合并读取；隐藏的曲线继续记录，重新显示即可回看。原理见 [分层采样与静默历史](docs/LAYERED-SAMPLING.md)。

#### 6. 内存区域类型

若链接脚本中有自定义区域名（如 `APP_STORAGE`、`FAST_HEAP`），可通过 `emberprobe.memory.regionKinds` 指定类型：

```json
"emberprobe.memory.regionKinds": { "APP_STORAGE": "flash", "FAST_HEAP": "ram" }
```

#### 7. C++ 变量显示

`emberprobe.prettyPrintingMode` 控制暂停时 C++ 对象的显示方式：`builtin`（默认，内置 STL 显示，无需 Python）、`gdb`（加载 `emberprobe.prettyPrinterFiles` 中显式指定的 GDB Python 脚本）、`raw`（显示原始成员）。

#### 8. Agent Skills 与 CubeMX 代码生成

点击侧边栏顶部 **安装 Agent Skills** 的开关，可选择 **安装到当前项目**、**全局安装（所有项目可用）** 或 **卸载**。安装后，支持 Agent Skills 的 AI 编程助手即可通过本地认证接口调用烧录、变量读写、芯片诊断、ELF 分析、断点控制、FreeRTOS 分析、CubeMX 代码生成等能力（列表见下方 [Agent Skills](#agent-skills)）。

烧录、变量/外设写入、CubeMX 生成等敏感操作必须经过两阶段确认，并在 VS Code 中弹窗由你批准（允许本次或此工作区 24 小时）。CubeMX 生成先在临时目录生成并比对，保留 `USER CODE` 段后才写回，详见 [CubeMX 代码生成说明](docs/CUBEMX-GENERATION.md)。

### 四、实验性功能

以下功能默认关闭或标记为实验性，尚未完成全部实板验收，行为可能调整。

#### 1. 外部 GDB Server

连接你已经启动的 GDB Server（如 J-Link GDB Server、pyOCD、ST-LINK GDB Server），用 EmberProbe 内置调试器进行 attach。在工作区设置中开启：

```json
{
  "emberprobe.experimental.externalGdb.enabled": true,
  "emberprobe.experimental.externalGdb.target": "127.0.0.1:2331",
  "emberprobe.experimental.externalGdb.connectionMode": "extended-remote"
}
```

再在 `launch.json` 中添加 `"request": "attach"`、`"servertype": "external"`、`"executable"` 指向匹配 ELF 的配置，用 F5 启动。支持断点、单步、变量、STL 与暂停时的内存读写；不支持下载、复位、重启和运行期实时采样。使用结束后请自行停止外部服务器，并关闭该开关以解除探针占用保护。详见 [外部 GDB Server](docs/EXTERNAL-GDB-SERVER.md)。

#### 2. 不限速采样

开启设置 `emberprobe.experimental.unlimitedSampling.enabled` 后，波形窗口目标频率旁会出现 **不限速** 开关。打开后，独立采样（非调试会话）不再受 200 Hz 上限约束，按探针吞吐背靠背读取，工具栏显示“不限速 · 实际 N Hz”，并提示受探针还是插件处理速度限制。内存历史仍为每变量最多 360,001 点，高频时可回看时长相应缩短，完整数据保存在磁盘归档中。详见 [不限速采样](docs/UNLIMITED-SAMPLING.md)。

#### 3. CPU 负载估计

适用于单核 FreeRTOS（Cortex-M0/M0+/M3/M4/M7）且 ELF 带内核 DWARF 的工程，无需修改固件。展开烧录调试卡片中的 **其他 → 实验性功能**，点击右侧 **▶** 开始采样，**CPU负载** 行显示非 Idle 任务与中断的驻留比例，以及计算覆盖率；覆盖率低于 80% 时不显示负载值。CPU 采样独占探针，与烧录、调试、变量采样互斥。详见 [CPU 负载估计](docs/CPU-LOAD-MONITORING.md)。

#### 4. 多核共享调试组

双核芯片可在 `launch.json` 中通过 `serverGroup`、`numberOfProcessors`、`targetProcessor` 让多个调试会话共用一个 OpenOCD 与探针：先启动一个核，初始化成功后再 attach 其他核。配置示例见 [多核共享 OpenOCD](docs/SHARED-DEBUG-GROUPS.md)。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| 变量类型显示为推测、成员无法展开、`optimized out` | 使用 Debug 预设重新构建，确认选中的是 Debug 目录下的 ELF，然后点击 ELF 全部变量的 **↻** |
| 提示探针被占用 / 无法同时进行 | 同一探针同一时刻只能被一个 OpenOCD 使用：先停止实时采样、CPU 采样或调试，或关闭 Ozone、CubeIDE 等其他占用探针的软件 |
| J-Link `Failed to open device` | 按第一章第 4 节切换到 WinUSB 驱动，并确认没有其他软件占用 |
| 读取芯片信息超时 / 目标电压异常 | 检查 SWD 接线、目标供电与 VTref；可在设置中降低 `emberprobe.adapterSpeedKhz` |
| 外设寄存器无数值 | 需要配置 SVD，并在调试会话中暂停芯片 |
| RTOS 任务为空 | 停在 `main` 时调度器尚未启动，继续运行后再暂停；确认使用 Debug 构建且内核符号未被裁剪 |
| 调试启动超时 | 检查 GDB 是否能在终端正常启动，或在设置中指定 `emberprobe.gdbPath` |

## Agent Skills

| 重点功能 | Skill |
| --- | --- |
| 固件烧录与变量读写 | `mcu-flash`、`mcu-variables` |
| 芯片信息与故障分析 | `mcu-chip-info`、`mcu-fault-analyzer` |
| ELF 与外设分析 | `mcu-elf-analyze`、`mcu-peripheral-debug` |
| 断点与 FreeRTOS 调试 | `mcu-debug-control`、`mcu-rtos` |
| 配置管理与 CubeMX 代码生成 | `mcu-config`、`mcu-cubemx` |

## 更多文档

- [Agent Skills](skills/)
- [实时变量采样说明](docs/LAYERED-SAMPLING.md)
- [FreeRTOS 调试说明](docs/RTOS-AWARENESS.md)
- [J-Link 兼容性说明](docs/JLINK-COMPATIBILITY.md)
- [枚举变量显示](docs/ENUM-VARIABLES.md)
- [ELF 变量来源筛选](docs/VARIABLE-ORIGIN-FILTER.md)
- [外部 GDB Server（实验性）](docs/EXTERNAL-GDB-SERVER.md)
- [不限速采样（实验性）](docs/UNLIMITED-SAMPLING.md)
- [CPU 负载估计（实验性）](docs/CPU-LOAD-MONITORING.md)
- [多核共享调试组（实验性）](docs/SHARED-DEBUG-GROUPS.md)
- [CubeMX 代码生成说明](docs/CUBEMX-GENERATION.md)
- [Agent 信任边界](docs/AGENT-TRUST-BOUNDARIES.md)
- [发布指南](docs/RELEASING.md)

## 许可证与归属

扩展代码采用 MIT 许可证。npm 运行时依赖与自带 xPack OpenOCD 的许可证及来源信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
