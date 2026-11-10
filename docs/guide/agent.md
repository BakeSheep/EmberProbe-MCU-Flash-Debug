# Agent

让 Agent 操作硬件：权限与确认、MCP 服务器和 CubeMX 代码生成。

## Agent 权限

Agent 读取芯片信息、变量和外设不需要逐次确认。烧录、写入和代码生成默认都要在 Agent 对话中由你确认，VS Code 不会再弹第二个确认框。

### 开启 Agent 访问

侧栏的“Agent 配置”卡片集中管理 Agent 开关：

- **工作区 Agent 访问**：首项常驻开关，控制当前工作区是否允许 Agent 连接。
- **MCP 服务器**：逐个客户端安装、升级或移除，见 [MCP 服务器](#mcp-服务器)。
- **Agent Skills**：把 skills 安装到工作区。
- **完全允许 Agent 操作**：免去操作确认，见[下文](#完全允许-agent-操作)。

Agent 访问按工作区开启，工作区必须受信任。在侧栏“Agent 配置”中打开“工作区 Agent 访问”开关，或运行命令 `EmberProbe: 为此工作区启用 Agent 访问`。未打开工作区或工作区不受信任时，开关不可用。停用后 Agent 无法连接这个工作区，优先于其他条件。

已安装工作区 skills 且没有设置过开关时，视为已启用。

### 哪些操作要确认

| 操作 | 确认方式 | 可以记住 24 小时 |
| --- | --- | --- |
| 烧录固件 | 对话确认 | 可以 |
| 修改变量 | 对话确认 | 可以 |
| CubeMX 生成 | 对话确认 | 可以 |
| Flash 校验 | 对话确认 | 不可以 |
| 修改外设寄存器 | 对话确认 | 不可以 |

确认时，Agent 会给出具体计划，比如固件路径和哈希、探针、写入的名称和新值。回答后才执行。

**只有你在确认时明确要求，才会记住 24 小时**，让 Agent 烧录并不等于同意记住。

记住的范围：

- **烧录**：同一 ELF 路径、目标、探针、传输方式、速度和 OpenOCD。重新编译同一路径的固件不需要再确认，结果里仍会报告实际写入的哈希。
- **修改变量**：同一 ELF 内容和连接。ELF 与目标固件不一致时不生效。
- **CubeMX**：同一工程和工具。

没有可靠序列号的探针每次都要确认。

要清除已记住的权限，让 Agent 调用 `permission_reset`。

### 完全允许 Agent 操作

默认关闭，只保存在当前工作区，只能在侧栏开启，Agent 不能自己打开。需要受信任的工作区，开启时同时启用 Agent 访问。关闭后恢复逐次确认，Agent 连接和已有的授权保留，已开始的操作不会取消。

开启后，烧录、Flash 校验、修改变量和外设寄存器、CubeMX 和 CubeMX2 生成不再逐次确认。

仍然保留的检查：

- 探针独占、目标和连接身份、文件路径、调试会话状态。
- 外设副作用限制和写入后的回读。
- 没有可靠序列号的探针，烧录和修改变量仍要确认。
- ELF 与已烧录固件不一致时，修改变量仍要确认。
- MCP 客户端自己的工具审批，以及修改过的 skills 的审批，不受这个开关影响。

### 固件一致性

Agent 读取、采样和写入时，结果会报告目标固件是否与配置的 ELF 一致：`match`、`mismatch` 或 `unknown`。其他工具烧录的固件观察不到，所以 `unknown` 和旧记录都只能作为参考。

### 修改过的 skills

已安装的 skills 被改动时，需要你对当前内容重新批准。MCP 服务器随扩展提供，不需要这一步。

### 能防什么，不能防什么

确认机制保证 Agent 执行的就是它展示的计划，计划变化后确认失效。但它有边界：

- EmberProbe 无法证明确认确实来自人。Agent 或客户端可以被配置成自动应答。
- 同一系统账户下运行的程序不被隔离。这里不是沙箱。

## MCP 服务器

EmberProbe 随扩展提供 MCP 服务器，让支持 MCP 的 Agent 客户端直接调用烧录、变量、调试、外设和 CubeMX 工具。

所有客户端都需要保持 EmberProbe 窗口运行，并为该工作区[开启 Agent 访问](#开启-agent-访问)。

### 安装

在 VS Code 中使用 GitHub Copilot 或在 Cursor 中使用时，扩展自动提供服务器，无需安装。

其他客户端在侧栏“Agent 配置”的 **MCP 服务器** 区域安装：

| 状态 | 含义 | 操作 |
| --- | --- | --- |
| 未安装 | 配置中没有 EmberProbe | 安装 |
| 已安装 | 配置是最新的 | 移除 |
| 可升级 | 启动路径或超时已过期 | 升级、移除 |
| 无法读取 | 配置文件损坏或过大 | 复制配置 |
| 手动配置 | 配置路径未知 | 复制配置 |
| 默认安装 | 由 VS Code 直接提供 | 无 |

安装后在客户端刷新或重启。安装只写用户级配置，保留其他服务器和设置，所有工程共用一份，切换工程不用重装。悬停状态可以看到目标文件。

同时用多个编辑器时，配置里的启动路径属于最后安装它的编辑器，另一个编辑器显示“可升级”是正常的，不用操作。

### 支持的客户端

| 客户端 | 配置位置 |
| --- | --- |
| Claude Code | `~/.claude.json`，支持 `CLAUDE_CONFIG_DIR` |
| Codex | `$CODEX_HOME/config.toml`，默认 `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| OpenCode | `opencode.jsonc` 或 `opencode.json`，遵循 `OPENCODE_CONFIG` 和 `XDG_CONFIG_HOME` |
| Cursor | 自动注册，或使用安装链接 |
| Antigravity | `~/.gemini/config/mcp_config.json` |
| DeepSeek Harness (DSH) | `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，默认 `~/.dsh` |
| 其他客户端 | 复制通用 JSON，自行合并 |

也可以运行命令 `EmberProbe: 安装 MCP 服务器到客户端`，在对话框中预览配置，或使用客户端 CLI、复制配置。

客户端的具体用法：

- **Antigravity**：安装后在客户端刷新 MCP 服务器，可在 **MCP Servers → Manage MCP Servers → View raw config** 查看结果。
- **DSH**：安装后重启相应 profile，例如 `dsh web`。自动写入失败时，把复制的内容保存为 `emberprobe.cordis.yml`，运行 `dsh web --patch "/absolute/path/emberprobe.cordis.yml"`。这是 YAML patch，不能粘贴到 `mcpServers` JSON 中。DSH 不支持 MCP prompts，直接使用工具即可。

### 选择工程

EmberProbe 按 Agent 客户端提供的根目录或工作目录找到工程，所以从工程目录启动客户端即可。多个工程可以同时使用，互不干扰。

远程窗口（Remote-SSH、WSL）中的配置只适用于运行在同一远端的客户端。

### 工具

MCP 固定提供全部工具和工作流提示，按功能分为三类：

| 分类 | 工具 |
| --- | --- |
| 基础 | 配置、探针、芯片信息、故障读取、ELF 分析、烧录与校验、权限、变量读写与采样、外设、RTT 日志 |
| 调试 | 调试启动与控制、断点、栈与变量检查、RTOS |
| CubeMX | 检测、检查、准备、生成、取消 |

另有六个工作流提示：`flash`、`fault_triage`、`variable_debug`、`rtos_inspect`、`rtt_logging`、`cubemx_generate`。

Agent 可以启动和停止 [RTT](flash-debug.md#rtt-日志)、读取固件日志，但不能向固件发送输入。

烧录、写入和 CubeMX 生成需要确认。客户端支持时以表单询问，默认选项是拒绝；不支持时在对话中确认。见 [Agent 权限](#agent-权限)。

### 限制

- 只支持 stdio，不支持 HTTP 传输。
- 配置中的 30 分钟超时用于人工确认、烧录和 CubeMX 等长调用，不改变 EmberProbe 自身的操作预算。
- 烧录和写入收到取消请求时不会中断，结果按未知处理，应先查询状态。
- 配置安装不会启用 Agent 访问，也不授予硬件操作权限。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| `BRIDGE_UNAVAILABLE`，提示工作区未启用 | 在侧栏启用 Agent 访问 |
| `BRIDGE_UNAVAILABLE`，没有找到窗口 | 确认 EmberProbe 窗口在运行，从工程目录启动客户端，或在启动客户端的环境中设置 `EMBERPROBE_WORKSPACE` |
| `BRIDGE_AMBIGUOUS` | 两个窗口打开了同一文件夹，关闭一个，或设置 `EMBERPROBE_BRIDGE_INSTANCE` |
| 客户端无法启动服务器 | 打开一次 EmberProbe 窗口；编辑器换过位置时在侧栏升级 |
| 已有同名服务器，CLI 安装失败 | 编辑已有的 `emberprobe` 条目，不要覆盖整个配置文件 |
| 长操作超时 | 检查客户端超时：Codex 用 `tool_timeout_sec`（秒），Gemini 和 OpenCode 用 `timeout`（毫秒） |
| Cursor 中看不到服务器 | 确认工作区受信任且已启用 Agent 访问 |
| DSH 没有出现 `mcp__emberprobe__*` | 检查 patch 是否由该 profile 加载，查看启动日志 |

## CubeMX 代码生成

让 Agent 修改 CubeMX 配置并生成代码，用的是你本机安装的 STM32CubeMX 或 STM32CubeMX2。生成前会先检查，不会静默覆盖你的改动。

### 配置工具路径

在 VS Code **用户设置**中配置，本机所有工作区共用：

| 设置 | 工具 |
| --- | --- |
| `emberprobe.cubemxPath` | STM32CubeMX，用于 `.ioc` 工程 |
| `emberprobe.cubemx2Path` | STM32CubeMX2 启动器（如 `stm32cubemx2-1.1.2.exe`），用于 `.ioc2` 工程 |

留空时自动查找，找到后保存到用户设置，不会替换已保存的路径。Agent 能读取这两个路径，但不能修改。

CubeMX2 自动查找支持 Windows 和 Linux，macOS 暂不支持。

### 选择工程

在侧栏“其他配置”的“.ioc / .ioc2 路径”中选择工程文件。自动配置会识别这两种工程：只有一个候选工程时自动填入；存在多个工程时，点击自动配置后选择。后台自动配置保留已有的有效选择，也不会弹出选择框。工程文件决定使用哪个工具，侧栏显示对应工具的状态。侧栏的固件包检查只适用于 `.ioc` 工程。

### 生成流程

1. 让 Agent 提出修改。这一步只在临时副本上进行，不写工作区。
2. Agent 展示工程和变更，等你在对话中确认。
3. EmberProbe 重新生成当前配置和新配置两份结果，比较后再写回工程。
4. 写回前备份被修改的文件。

可以在确认时选择记住 24 小时，见 [Agent 权限](#agent-权限)。

Agent 可用的操作见 `mcu-cubemx` skill 和 [MCP 工具](#工具)。

### 用户代码

**`.ioc` 工程**：写在 `USER CODE` 块内的代码会保留。

**`.ioc2` 工程**：生成的源文件没有 `USER CODE` 块。`main.c`、`main.h`、启动文件、链接脚本等归你所有，已存在时不会被覆盖，只在结果的 `warnings` 中列出。其他生成文件归 CubeMX2 所有，改动过会被判定为冲突。

### 处理冲突

`CUBEMX_BASELINE_DRIFT` 表示工程里的生成文件被改过，与工具重新生成的结果不一致。查看错误中的 `details.changes`，并对比 `details.baselineOutput` 下工具重新生成的版本。

常见情况：在 `cmake/stm32cubemx/CMakeLists.txt` 里手动加了源文件，而这个文件是生成的。把它移到你自己的顶层 CMake 文件：

```cmake
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    Core/Src/stress_test.c
)
```

确认后删除生成列表中手动加的条目，再重新准备。EmberProbe 不会替你移动或丢弃这些修改。

### CubeMX2 的要求

- 必须安装工程记录的 CubeMX2 版本（`mx2Version`）。EmberProbe 不迁移工程。
- 所需的 pack 要在 CubeMX2 界面中安装，EmberProbe 不下载。缺少时报 `CUBEMX2_PACK_MISSING`。
- 不能通过 Agent 新建或删除工程、安装 pack、启用中间件组件。
- 目前只在 Windows 上验证过，尚未提供侧栏配置界面。

### 限制

- 生成成功不代表能编译，也不代表硬件上能跑。
- 工程目录内的符号链接如果涉及 CubeMX 的输入或输出，生成会被拒绝。
- 每次操作的日志和备份保存在扩展存储中，结果的 `diagnosticsPath` 给出位置。

### 常见问题

**写回中断，结果显示 `recoveryRequired`**：备份在 `diagnosticsPath` 的 `backup/` 下，可用它恢复。

**`CUBEMX_EXIT_UNCONFIRMED`**：工具没有确认退出，新的生成会被阻止。用 `cubemx.cancel` 重试结束进程。

**`CUBEMX2_VERSION_MISMATCH`**：安装工程记录的 CubeMX2 版本。

## 相关文档

- [Agent 信任边界（英文）](../design/agent-trust-boundaries.md)
- [MCP 服务器设计](../design/mcp-server.md)
- [CubeMX 生成设计（英文）](../design/cubemx-pipeline.md)
