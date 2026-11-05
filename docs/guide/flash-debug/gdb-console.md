# GDB 控制台

[English](gdb-console.en.md)

在 EmberProbe 调试会话中，VS Code **调试控制台**的每次输入都是一条 GDB 命令。

## 常用命令

| 输入 | 用途 |
| --- | --- |
| `bt` | 查看调用栈 |
| `info registers` | 查看寄存器 |
| `p counter` | 打印变量 |
| `x/16wx 0x20000000` | 按 32 位十六进制查看 16 个内存单元 |
| `set variable counter = 5` | 修改变量 |
| `thread 2`、`frame 1` | 切换线程、栈帧 |
| `continue`、`next`、`step`、`finish` | 运行或单步 |
| `info breakpoints` | 查看全部断点及实际启用状态 |

打印变量要写 `p counter`，直接输入 `counter` 不会求值。Watch 和悬停仍使用表达式，写 `counter` 即可。

## 使用规则

- 一次一行，最多 16,384 个字符，不支持继续追问式的交互输入。多行命令可以写到文件里，再用 `source` 加载。
- 目标运行时也能提交命令，能否执行由 GDB 判断。EmberProbe 不会替你暂停或恢复。
- 命令执行期间，侧栏读取、写入和会话切换会等待，停止调试始终可用。
- 命令执行后，调用栈、变量和 RTOS 任务表会重新读取，之前的结果标记为过期。
- 命令出错只显示在控制台，会话继续可用。超时或 GDB 退出时结束会话，不自动重试。
- 多核调试时，控制台顶部的会话选择决定命令发给哪个核。目标脚本的芯片级操作仍可能影响其他核。

## 断点

- 用 `break` 创建的断点由 GDB 管理，不会出现在 VS Code 断点列表中。
- VS Code 已有的断点被 GDB 修改或删除时会自动同步。
- GDB 的 `enable`/`disable` 无法反映到 VS Code 的勾选框，以 `info breakpoints` 为准。

## 限制

- 不支持 GDB/MI 原始命令。
- Agent 不能通过这里发送任意 GDB 命令，Agent 的写入和烧录确认不受影响。

## 相关文档

- [调试会话设计](../../design/debug-sessions.md)
