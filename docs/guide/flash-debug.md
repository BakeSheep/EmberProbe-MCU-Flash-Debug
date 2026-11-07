# 烧录与调试

烧录固件，使用内置调试器，查看 RTOS，调试多核芯片，连接外部 GDB 服务器。

## 烧录与下载

侧栏下载、调试启动和 Agent 烧录都会把固件写入目标 Flash。每次都完整擦除、写入、校验并复位运行。

### 怎么用

- **下载**：在侧栏点击下载，或在资源管理器中右键 ELF。
- **调试**：启动 `launch` 配置时自动下载固件，再停在入口处。
- **Agent**：通过 `mcu-flash` skill 或 MCP 工具烧录，需要在对话中确认，见 [Agent 权限](agent.md#agent-权限)。

### 下载行为

- 即使固件与目标 Flash 完全相同也会重新烧录，不会跳过。
- 烧录时 EmberProbe 自动提高 SWD 时钟，高速写入失败时恢复原时钟重写一次，只有第二次也失败才报错。
- 这一提速只用于 Cortex-M 的 SWD 连接。JTAG 和 RISC-V 等目标保持脚本时钟。

### 调整速度

`emberprobe.adapterSpeedKhz` 设为非零值时用作烧录时钟。

连线较长或没有屏蔽时，高速写入可能每次都失败再重写，下载反而变慢。这时设置一个较低的值。

擦除时间由 Flash 本身决定，提高时钟只缩短写入部分。

### launch 配置

| 配置 | 效果 |
| --- | --- |
| 默认 | 下载 `executable` 指定的 ELF |
| `loadFiles: ["a.elf", "b.elf"]` | 按顺序下载这些文件 |
| `loadFiles: []` | 不下载 |
| `request: "attach"` | 从不写入 Flash |

### 查看启动耗时

调试启动慢时，在 launch 配置中加上 `"performanceTrace": true`。调试控制台会输出各阶段耗时，比如查找工具链、启动 OpenOCD、启动 GDB、下载。记录里只有耗时，不含路径或目标数据。

Windows 上首次启动 GDB 可能需要几秒。EmberProbe 会在后台提前准备，打开工程后立刻调试时仍可能等待。

## GDB 控制台

在 EmberProbe 调试会话中，VS Code **调试控制台**的每次输入都是一条 GDB 命令。

### 常用命令

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

### 使用规则

- 一次一行，最多 16,384 个字符，不支持继续追问式的交互输入。多行命令可以写到文件里，再用 `source` 加载。
- 目标运行时也能提交命令，能否执行由 GDB 判断。EmberProbe 不会替你暂停或恢复。
- 命令执行期间，侧栏读取、写入和会话切换会等待，停止调试始终可用。
- 命令执行后，调用栈、变量和 RTOS 任务表会重新读取，之前的结果标记为过期。
- 命令出错只显示在控制台，会话继续可用。超时或 GDB 退出时结束会话，不自动重试。
- 多核调试时，控制台顶部的会话选择决定命令发给哪个核。目标脚本的芯片级操作仍可能影响其他核。

### 断点

- 用 `break` 创建的断点由 GDB 管理，不会出现在 VS Code 断点列表中。
- VS Code 已有的断点被 GDB 修改或删除时会自动同步。
- GDB 的 `enable`/`disable` 无法反映到 VS Code 的勾选框，以 `info breakpoints` 为准。

### 限制

- 不支持 GDB/MI 原始命令。
- Agent 不能通过这里发送任意 GDB 命令，Agent 的写入和烧录确认不受影响。

## RTOS 调试

开启后，VS Code 调用栈按 RTOS 任务显示，可以切换任务查看各自的栈和局部变量。这一功能默认关闭。

FreeRTOS 还有任务面板，可以在暂停时查看任务列表。

### 开启

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

### 调试时的变化

- 调用栈列出所有任务。调度器启动之前只显示一个线程，这是正常的。
- 查看另一个任务的栈不影响单步，单步作用在你请求的任务上。
- 任务已退出时操作会报 `DEBUG_TASK_EXITED`，不会误操作其他任务。

### FreeRTOS 任务面板

暂停时显示任务列表，支持过滤、排序，继续运行后旧数据标记为过期。

- 只支持小端 ARM32 和单核 FreeRTOS，不支持 FreeRTOS SMP。
- 刚停在 `main` 时任务通常还没创建，面板会提示。继续运行过初始化后再暂停。
- 栈使用量和运行时间统计取决于固件配置，缺少对应字段时不显示。
- 栈填充估算只是估算，不代表当前实时的栈指针。

### 固件要求

调试时依靠 ELF 中的内核符号找到任务，所以固件不能裁掉这些符号。

最常见的问题是 `uxTopUsedPriority` 被链接器优化掉，导致找不到任何任务。遇到这种情况时保留该符号。

调用栈显示任务名还是 `Thread N`，取决于固件中能读到什么。

### 限制

- 只在调试时生效，实时采样不读取 RTOS 结构。
- 双核芯片上只配置当前核，请选择真正运行 RTOS 的核。多核见[多核调试](#多核调试)。
- 暂不支持崩溃任务分析。

### 常见问题

**`OPENOCD_RTOS_INVALID`**：名称拼写或大小写不对，或目标脚本没有当前 target。

**看不到任务**：先确认调度器已经启动，再检查 `uxTopUsedPriority` 是否被优化掉。

## 多核调试

用一个 OpenOCD 和一台探针同时调试芯片的多个核，每个核一个调试会话。**这是实验性功能，还没有经过双核实板验收。**

### 配置

先在 EmberProbe 中选好探针、双核目标脚本和 OpenOCD，然后在 `launch.json` 中为每个核写一项配置。替换 ELF 路径，并按实际 `target names` 的顺序核对索引：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "CPU 0 launch",
      "type": "emberprobe",
      "request": "launch",
      "executable": "${workspaceFolder}/build/core0.elf",
      "cwd": "${workspaceFolder}",
      "serverGroup": "dual",
      "numberOfProcessors": 2,
      "targetProcessor": 0,
      "rtos": "FreeRTOS",
      "runToEntryPoint": "main"
    },
    {
      "name": "CPU 1 attach",
      "type": "emberprobe",
      "request": "attach",
      "executable": "${workspaceFolder}/build/core1.elf",
      "cwd": "${workspaceFolder}",
      "serverGroup": "dual",
      "numberOfProcessors": 2,
      "targetProcessor": 1,
      "rtos": "FreeRTOS"
    }
  ]
}
```

| 字段 | 要求 |
| --- | --- |
| `serverGroup` | 组名，1–64 个字母、数字、下划线、点或短横线，以字母或数字开头 |
| `numberOfProcessors` | 2–32 |
| `targetProcessor` | 从 0 开始的核索引 |
| `targetName` | 可选，必须与该索引的实际目标名一致 |

### 启动顺序

1. 启动第一个核，等它初始化完成。
2. 再启动其他核。其他核的固件必须已经部署好：加入组时只会 attach，不下载也不复位。

不支持同时启动多个配置（compound），初始化期间加入会返回 `DEBUG_GROUP_BUSY`。第一个核的 `launch` 默认会复位和下载，可能影响整个芯片。

### 切换核

出现多个会话后，在 RTOS 面板上方选择会话。这个选择同时决定侧栏暂停读取、外设操作和 Agent 控制发往哪个核。

切换后，变量和任务表重新读取。写入和执行控制期间不能切换。

侧栏变量使用选定的 ELF，必须与当前核的固件一致；不一致时选择对应的 ELF 后重试。

Agent 用 `debug.status` 查看候选会话，用 `debug.select` 选择：

```text
node <skill-dir>/scripts/debug.js --workspace <workspace> --status
node <skill-dir>/scripts/debug.js --workspace <workspace> --select --group dual --core 1
```

### 结束

停止一个核不影响其他核。最后一个核退出时才停止 OpenOCD 并释放探针。

### 限制

- 组内成员必须使用相同的探针、OpenOCD、目标脚本、传输方式、速度、核数和 RTOS 设置。各核可以用不同的 ELF。
- 各核使用不同 RTOS 的组合暂不支持。
- 不支持组内 Restart，请结束所有会话后重新启动。
- 组内不能在运行时采样，变量和外设只能在暂停时访问。
- 不保证跨核同步单步，也不保证多核一致的快照。

## 外部 GDB Server

用 EmberProbe 的调试器 attach 到你自己启动的 Cortex-M / ARM32 TCP GDB server。**这是实验性功能，默认关闭，尚未对具体服务器或板卡做兼容性验证。**

### 配置

1. 在目标工作区或文件夹的 VS Code 设置中开启：

   ```json
   {
     "emberprobe.experimental.externalGdb.enabled": true,
     "emberprobe.experimental.externalGdb.target": "127.0.0.1:3333",
     "emberprobe.experimental.externalGdb.connectionMode": "extended-remote"
   }
   ```

   `target` 写 `host:port` 或 `[IPv6]:port`，不支持串口、URL 或管道。`connectionMode` 可选 `remote` 和 `extended-remote`。

2. 在 `launch.json` 添加配置：

   ```json
   {
     "name": "External GDB attach",
     "type": "emberprobe",
     "request": "attach",
     "servertype": "external",
     "executable": "${workspaceFolder}/build/app.elf"
   }
   ```

3. 启动你的 GDB server，然后在 VS Code 的“运行和调试”中选择这项配置，按 F5。

需要受信任的工作区、与目标固件一致的本地 ELF，以及已配置的工具链。侧栏、右键和 Agent 的调试入口仍然使用 OpenOCD，不受这个开关影响。

### 可以做什么

- 断点、调用栈、变量、STL 显示、暂停、继续、单步。
- 暂停时读取内存，以及在侧栏读写变量。

attach 时目标如果还在运行，会被中断，因此 attach 可能暂停目标。

RTOS 线程由服务器提供，EmberProbe 不配置服务器的 RTOS。

### 结束和恢复

1. 在 VS Code 停止调试。这只断开连接并退出本地 GDB，目标的状态取决于服务器。
2. 自己停止外部服务器，确认它已释放探针。
3. 关闭 `emberprobe.experimental.externalGdb.enabled`。
4. 手动使用采样、烧录等功能，它们不会自动恢复。

尝试过外部连接后，EmberProbe 会暂时阻止自己使用探针，以免抢占，重载窗口后仍然有效，完成上面的步骤才解除。这个保护只对当前窗口的 EmberProbe 有效，挡不住其他程序或窗口。

### 限制

不支持下载、自动复位、Restart、多核共享、运行时采样、SWO/RTT，也不管理服务器和驱动。

EmberProbe 不主动发送 OpenOCD `monitor` 命令。你在配置里写的 attach hooks 会照常执行，请自行确认服务器兼容性。

## 相关文档

- [烧录与调试启动设计](../design/flash-and-debug.md)
- [调试会话设计](../design/debug-sessions.md)
