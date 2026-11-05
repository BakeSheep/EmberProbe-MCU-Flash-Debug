# RTOS 调试

[English](rtos.en.md)

开启后，VS Code 调用栈按 RTOS 任务显示，可以切换任务查看各自的栈和局部变量。这一功能默认关闭。

FreeRTOS 还有实验性的任务面板，可以在暂停时查看任务列表，尚未经过实板验收。

## 开启

在 VS Code 设置中填 `emberprobe.rtos`，或在 `launch.json` 中按会话设置：

```json
{
  "type": "emberprobe",
  "request": "launch",
  "executable": "${workspaceFolder}/build/app.elf",
  "rtos": "FreeRTOS"
}
```

`attach` 配置同样支持。`launch.json` 优先，写 `"rtos": ""` 可以只在这次会话关闭。

可选值：`FreeRTOS`、`ThreadX`、`chibios`、`Chromium-EC`、`eCos`、`embKernel`、`linux`、`mqx`、`nuttx`、`RIOT`、`uCOS-III`、`Zephyr`、`auto`、`none`。

- 名称区分大小写，`freertos` 会报错。
- 建议写明 RTOS 名称。`auto` 在裁剪过或高度优化的固件上可能判断错误。
- `none` 表示明确关闭，可以覆盖目标脚本中已有的 RTOS 设置。

修改在下一次启动调试时生效。VS Code 的“重启”沿用原设置，需要停止后重新启动。

## 调试时的变化

- 调用栈列出所有任务。调度器启动之前只显示一个线程，这是正常的。
- 查看另一个任务的栈不影响单步，单步作用在你请求的任务上。
- 任务已退出时操作会报 `DEBUG_TASK_EXITED`，不会误操作其他任务。

## FreeRTOS 任务面板

暂停时显示任务列表，支持过滤、排序，继续运行后旧数据标记为过期。

- 只支持小端 ARM32 和单核 FreeRTOS，不支持 FreeRTOS SMP。
- 刚停在 `main` 时任务通常还没创建，面板会提示。继续运行过初始化后再暂停。
- 栈使用量和运行时间统计取决于固件配置，缺少对应字段时不显示。
- 栈填充估算只是估算，不代表当前实时的栈指针。

## 固件要求

调试时依靠 ELF 中的内核符号找到任务，所以固件不能裁掉这些符号。

最常见的问题是 `uxTopUsedPriority` 被链接器优化掉，导致找不到任何任务。遇到这种情况时保留该符号。

调用栈显示任务名还是 `Thread N`，取决于固件中能读到什么。

## 限制

- 只在调试时生效，实时采样不读取 RTOS 结构。
- 双核芯片上只配置当前核，请选择真正运行 RTOS 的核。多核见[多核调试](multicore.md)。
- 暂不支持崩溃任务分析。

## 常见问题

**`OPENOCD_RTOS_INVALID`**：名称拼写或大小写不对，或目标脚本没有当前 target。

**看不到任务**：先确认调度器已经启动，再检查 `uxTopUsedPriority` 是否被优化掉。

## 相关文档

- [调试会话设计](../../design/debug-sessions.md)
- [GDB 控制台](gdb-console.md)
