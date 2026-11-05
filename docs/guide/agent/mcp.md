# MCP 服务器

[English](mcp.en.md)

EmberProbe 随扩展提供 MCP 服务器，让支持 MCP 的 Agent 客户端直接调用烧录、变量、调试、外设和 CubeMX 工具。

所有客户端都需要保持 EmberProbe 窗口运行，并为该工作区[开启 Agent 访问](permissions.md#开启-agent-访问)。

## 安装

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

## 支持的客户端

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

## 选择工程

EmberProbe 按 Agent 客户端提供的根目录或工作目录找到工程，所以从工程目录启动客户端即可。多个工程可以同时使用，互不干扰。

远程窗口（Remote-SSH、WSL）中的配置只适用于运行在同一远端的客户端。

## 工具

MCP 固定提供全部工具和工作流提示，按功能分为三类：

| 分类 | 工具 |
| --- | --- |
| 基础 | 配置、探针、芯片信息、故障读取、ELF 分析、烧录与校验、权限、变量读写与采样、外设 |
| 调试 | 调试启动与控制、断点、栈与变量检查、RTOS |
| CubeMX | 检测、检查、准备、生成、取消 |

另有五个工作流提示：`flash`、`fault_triage`、`variable_debug`、`rtos_inspect`、`cubemx_generate`。

烧录、写入和 CubeMX 生成需要确认。客户端支持时以表单询问，默认选项是拒绝；不支持时在对话中确认。见 [Agent 权限](permissions.md)。

## 限制

- 只支持 stdio，不支持 HTTP 传输。
- 配置中的 30 分钟超时用于人工确认、烧录和 CubeMX 等长调用，不改变 EmberProbe 自身的操作预算。
- 烧录和写入收到取消请求时不会中断，结果按未知处理，应先查询状态。
- 配置安装不会启用 Agent 访问，也不授予硬件操作权限。

## 常见问题

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

## 相关文档

- [MCP 服务器设计](../../design/mcp-server.md)
- [Agent 权限](permissions.md)
