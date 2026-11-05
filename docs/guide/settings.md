# VS Code 设置

[English](settings.en.md)

EmberProbe 的设置都在 VS Code 设置页中，搜索 `@ext:BakeSheep.emberprobe` 即可找到。共 21 项，按 4 个大类排列。设置键均以 `emberprobe.` 开头，下表省略这一前缀。

| 分组 | 设置 | 用途 |
| --- | --- | --- |
| 工具与路径 | `openocdPath` | OpenOCD 路径 |
| | `gdbPath` | ARM GDB 路径 |
| | `armToolchainPath` | 工具链 bin 目录 |
| | `armToolchainPrefix` | 工具链前缀 |
| | `objdumpPath` | ARM objdump 路径 |
| | `cubemxPath` | STM32CubeMX 路径 |
| | `cubemx2Path` | STM32CubeMX2 启动器路径 |
| 连接与调试 | `tclPort` | Tcl-RPC 端口；未设置时随机分配 |
| | `adapterSpeedKhz` | 调试和烧录的链路时钟 |
| | `transport` | 传输协议 |
| | `rtos` | 调试时的 RTOS 感知 |
| | `prettyPrintingMode` | 内置、GDB 或原始字段显示 |
| | `prettyPrinterFiles` | 明确指定的 GDB Python 打印脚本 |
| 采样与波形 | `sampleFrequencyHz` | 波形目标采样频率 |
| | `samplingAdapterSpeedKhz` | 独立采样的链路时钟 |
| | `chartHistoryMaxMiB` | 波形历史的内存预算 |
| | `samplingArchiveMaxMiB` | 采样归档的磁盘上限 |
| | `chartBackgroundIcon.enabled` | 显示波形背景图标 |
| 实验功能 | `experimental.externalGdb.enabled` | 启用外部 GDB 附加 |
| | `experimental.externalGdb.target` | 外部服务器地址和端口 |
| | `experimental.externalGdb.connectionMode` | 外部 GDB 连接模式 |

探针不在设置中选择，而是在侧栏“已连接调试器”一行点选，见[探针连接](getting-started/probe-connections.md)。

## 已移除的设置

| 旧设置 | 现在的做法 |
| --- | --- |
| `probeSerial` | 在侧栏“已连接调试器”中选择设备。旧设置不再锁定或覆盖侧栏选择 |
| `sampleIntervalMs` | 用 `sampleFrequencyHz` 设置频率 |
| `maxSamples` | 波形历史保留最近 30 分钟，并受内存和磁盘预算约束 |
| `enablePrettyPrinting` | 用 `prettyPrintingMode: "raw"` 查看原始字段 |
| `prettyPrinterPath` | 用 `prettyPrintingMode: "gdb"` 加 `prettyPrinterFiles` 加载脚本 |
| `memory.regionKinds` | 内存区域按链接器名称自动分类，无法识别的区域归为其他类型并提示 |
| `mcp.toolsets` | MCP 固定提供全部工具，不再筛选 |

旧配置不会被自动改写，留在设置文件里不起作用，可以手动删除。
