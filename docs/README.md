# EmberProbe 文档

[English](README.en.md)

## 我想……

### 开始使用

- [安装调试工具链](guide/getting-started/toolchain.md)
- [连接和选择探针](guide/getting-started/probe-connections.md)
- [使用 J-Link](guide/getting-started/jlink.md)
- [配置 OpenOCD 目标](guide/getting-started/openocd-targets.md)

### 烧录和调试

- [烧录固件，调整下载速度](guide/flash-debug/flash.md)
- [在调试控制台输入 GDB 命令](guide/flash-debug/gdb-console.md)
- [查看 RTOS 任务和栈](guide/flash-debug/rtos.md)
- [调试多核芯片](guide/flash-debug/multicore.md)
- [连接外部 GDB 服务器](guide/flash-debug/external-gdb-server.md)

### 查看变量和波形

- [实时采样变量](guide/variables/sampling.md)
- [使用波形窗口](guide/variables/waveform.md)
- [设置波形背景图标](guide/variables/chart-background.md)
- [查看指针和 C++ 对象](guide/variables/pointers.md)
- [查看枚举变量](guide/variables/enums.md)
- [区分同名变量](guide/variables/variable-names.md)
- [只看自己写的变量](guide/variables/origin-filter.md)

### 读写外设寄存器

- [外设寄存器](guide/peripherals.md)

### 让 Agent 操作

- [开启 Agent 访问，了解确认规则](guide/agent/permissions.md)
- [使用侧栏的 Agent 配置](guide/agent/agent-controls.md)
- [连接 MCP 客户端](guide/agent/mcp.md)
- [生成 CubeMX 代码](guide/agent/cubemx.md)

### 调整界面和设置

- [查看全部设置](guide/settings.md)
- [缩放界面](guide/webview-zoom.md)

## 参与开发

项目约定见仓库根目录的 `AGENTS.md`。流程文档：[发布指南](development/releasing.md)、[MCP 客户端实机验收](development/mcp-harness-acceptance.md)。

### 设计说明

解释实现方式、数据流和不变量，给开发者和审查者看。

| 主题 | 文档 |
| --- | --- |
| 探针 | [探针选择](design/probe-selection.md) |
| 烧录与调试 | [烧录与调试](design/flash-and-debug.md)、[调试会话](design/debug-sessions.md) |
| 采样 | [采样流水线](design/sampling-pipeline.md)、[波形历史](design/chart-history.md) |
| 变量 | [变量显示](design/variable-display.md)、[变量身份与来源](design/variable-identity.md) |
| 外设 | [外设访问](design/peripheral-access.md) |
| Agent | [信任边界](design/agent-trust-boundaries.md)、[MCP 服务器](design/mcp-server.md)、[CubeMX 生成](design/cubemx-pipeline.md) |
| 界面 | [Webview 界面](design/webview-ui.md) |
| 构建 | [OpenOCD 构建](design/openocd-build.md) |

### 历史记录

`records/` 保存带日期的审计、计划、诊断和实板验证。它们记录当时的情况，不再更新，也不代表当前行为。

## 文档怎么写

- `guide/` 面向用户，写能做什么、怎么用、有什么限制、出错怎么办，不写内部实现。中文为主，同名 `.en.md` 是英文版。
- `design/` 写为什么这样实现，可以只有一种语言。
- `records/` 按日期归档，写完不改。
