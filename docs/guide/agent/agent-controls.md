# Agent 控制

[English](agent-controls.en.md)

侧栏的“Agent 配置”卡片集中管理 Agent 相关的开关，与“MCU 配置”并列，各自记住折叠状态。

## 卡片内容

- **Agent Skills**：把 skills 安装到工作区。
- **MCP 服务器**：逐个客户端安装、升级或移除，见 [MCP 服务器](mcp.md)。
- **完全允许 Agent 操作**：免去操作确认。

## 完全允许 Agent 操作

默认关闭，只保存在当前工作区。开启时同时启用 Agent 访问；关闭后恢复逐次确认，Agent 连接和已有的授权保留，已开始的操作不会取消。

需要打开受信任的工作区。Agent 不能自己开启这个开关。

开启后不再逐次确认的操作：

- 烧录和 Flash 校验
- 修改变量和外设寄存器
- CubeMX 和 CubeMX2 生成

仍然保留的检查：

- 探针独占、目标和连接身份、文件路径、调试会话状态。
- 外设副作用限制和写入后的回读。
- 没有可靠序列号的探针，烧录和修改变量仍要确认。
- ELF 与已烧录固件不一致时，修改变量仍要确认。
- MCP 客户端自己的工具审批，以及修改过的 skills 的审批，不受这个开关影响。

## 相关文档

- [Agent 权限](permissions.md)
- [Agent 信任边界（英文）](../../design/agent-trust-boundaries.md)
