# VS Code 设置 / VS Code settings

EmberProbe 提供 21 项设置，按 4 个大类排列。所有设置键均以 `emberprobe.` 开头；下表省略此前缀。设置页面中的每项说明同时提供中文和英文。

EmberProbe provides 21 settings in four groups. All keys start with `emberprobe.`; the table omits that prefix. Each Settings UI description includes both Chinese and English.

| 分组 / Group | 设置 / Setting | 用途 / Purpose |
| --- | --- | --- |
| 工具与路径 / Tools & Paths | `openocdPath` | OpenOCD 路径 / OpenOCD executable path |
|  | `gdbPath` | ARM GDB 路径 / ARM GDB executable path |
|  | `armToolchainPath` | 工具链 bin 目录 / Toolchain bin directory |
|  | `armToolchainPrefix` | 工具链前缀 / Toolchain prefix |
|  | `objdumpPath` | ARM objdump 路径 / ARM objdump executable path |
|  | `cubemxPath` | STM32CubeMX 路径 / STM32CubeMX executable path |
|  | `cubemx2Path` | STM32CubeMX2 启动器路径 / STM32CubeMX2 launcher path |
| 连接与调试 / Connection & Debugging | `tclPort` | Tcl-RPC 端口；未显式设置时随机分配 / Tcl-RPC port; random unless explicitly configured |
|  | `adapterSpeedKhz` | 调试和烧录链路时钟 / Debug and flash adapter clock |
|  | `transport` | OpenOCD 传输协议 / OpenOCD transport |
|  | `rtos` | 调试时的 RTOS 感知 / RTOS awareness for debugging |
|  | `prettyPrintingMode` | 内置、GDB 或原始字段显示 / Built-in, GDB or raw field display |
|  | `prettyPrinterFiles` | 明确指定的 GDB Python 打印脚本 / Explicit GDB Python printer scripts |
| 采样与波形 / Sampling & Waveforms | `sampleFrequencyHz` | 波形目标采样频率 / Target waveform sampling frequency |
|  | `samplingAdapterSpeedKhz` | 独立采样链路时钟 / Standalone sampling adapter clock |
|  | `chartHistoryMaxMiB` | 波形历史内存预算 / Waveform history memory budget |
|  | `samplingArchiveMaxMiB` | 采样归档磁盘上限 / Sampling archive disk limit |
|  | `chartBackgroundIcon.enabled` | 显示波形背景图标 / Show waveform background icon |
| 实验功能 / Experimental | `experimental.externalGdb.enabled` | 启用外部 GDB 附加 / Enable external GDB attach |
|  | `experimental.externalGdb.target` | 外部服务器地址和端口 / External server host and port |
|  | `experimental.externalGdb.connectionMode` | 外部 GDB 连接模式 / External GDB connection mode |

## 已移除设置 / Removed settings

`probeSerial` 已从 VS Code 设置和 Agent `config.set` 中移除。请在侧栏“已连接调试器”中选择设备；原设置不再锁定或覆盖侧栏选择。接口脚本中指定的设备和独立烧录脚本的显式序列号参数仍按各自规则处理。

`probeSerial` has been removed from VS Code settings and Agent `config.set`. Select the device under Connected probes in the sidebar; the old setting no longer locks or overrides that selection. Interface-script device selectors and explicit serial arguments in standalone flash scripts retain their own behavior.

`sampleIntervalMs`、`maxSamples`、`enablePrettyPrinting` 和 `prettyPrinterPath` 已移除。使用 `sampleFrequencyHz` 设置频率；波形历史保留最近 30 分钟，并受内存与磁盘预算约束。使用 `prettyPrintingMode: "raw"` 查看原始字段，使用 `prettyPrintingMode: "gdb"` 和 `prettyPrinterFiles` 加载明确指定的打印脚本。旧用户配置不会被自动改写。

`sampleIntervalMs`, `maxSamples`, `enablePrettyPrinting` and `prettyPrinterPath` have been removed. Set the rate with `sampleFrequencyHz`; waveform history retains the latest 30 minutes within memory and disk budgets. Use `prettyPrintingMode: "raw"` for physical fields, or `prettyPrintingMode: "gdb"` with `prettyPrinterFiles` for explicit scripts. Existing user configuration files are not rewritten automatically.

`memory.regionKinds` 和 `mcp.toolsets` 已移除。内存区域按链接器名称自动分类；无法识别的区域保留为其他类型并提示。MCP 固定暴露所有工具和工作流提示（包括 CubeMX），不再支持设置或环境变量筛选；旧 `EMBERPROBE_MCP_TOOLSETS` 值不再生效。

`memory.regionKinds` and `mcp.toolsets` have been removed. Memory regions are classified automatically by linker name; unrecognized regions remain other and produce a diagnostic. MCP always exposes every tool and workflow prompt, including CubeMX. Settings and environment filters are no longer supported; legacy `EMBERPROBE_MCP_TOOLSETS` values have no effect.
