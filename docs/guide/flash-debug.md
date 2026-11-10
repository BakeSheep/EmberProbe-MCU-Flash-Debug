# 烧录与调试

烧录固件，使用内置调试器，查看 RTOS，调试多核芯片，连接外部 GDB 服务器，查看 RTT 日志。

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

| 配置                            | 效果                         |
| ------------------------------- | ---------------------------- |
| 默认                            | 下载 `executable` 指定的 ELF |
| `loadFiles: ["a.elf", "b.elf"]` | 按顺序下载这些文件           |
| `loadFiles: []`                 | 不下载                       |
| `request: "attach"`             | 从不写入 Flash               |

### 查看启动耗时

调试启动慢时，在 launch 配置中加上 `"performanceTrace": true`。调试控制台会输出各阶段耗时，比如查找工具链、启动 OpenOCD、启动 GDB、下载。记录里只有耗时，不含路径或目标数据。

Windows 上首次启动 GDB 可能需要几秒。EmberProbe 会在后台提前准备，打开工程后立刻调试时仍可能等待。

## GDB 控制台

在 EmberProbe 调试会话中，VS Code **调试控制台**的每次输入都是一条 GDB 命令。

### 常用命令

| 输入                                 | 用途                               |
| ------------------------------------ | ---------------------------------- |
| `bt`                                 | 查看调用栈                         |
| `info registers`                     | 查看寄存器                         |
| `p counter`                          | 打印变量                           |
| `x/16wx 0x20000000`                  | 按 32 位十六进制查看 16 个内存单元 |
| `set variable counter = 5`           | 修改变量                           |
| `thread 2`、`frame 1`                | 切换线程、栈帧                     |
| `continue`、`next`、`step`、`finish` | 运行或单步                         |
| `info breakpoints`                   | 查看全部断点及实际启用状态         |

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

## 数据断点：查出是谁修改了变量

怀疑某个变量被意外修改时，可以设置数据断点。目标运行到修改它的位置时暂停，再通过调用栈和源码检查原因，无需预先知道是哪一行代码。

### 设置与管理

1. 启动 EmberProbe 内置调试器，暂停目标。
2. 在 VS Code **运行和调试 → 变量**中找到变量，或展开结构体、数组找到具体成员。
3. 右键选择数据断点操作：**值变化时中断**、**读取时中断**或**访问时中断**。菜单名称取决于 VS Code 的显示语言。
4. 继续运行。命中后，调试界面显示数据断点停止原因；值变化时会附带旧值和新值（如果 GDB 提供），可查看调用栈、源码及其他变量。

数据断点显示在 VS Code 的**断点**列表中，可以勾选启停、删除，也可以添加条件。不支持命中次数条件。设置失败时，断点显示失败原因；目标不支持或硬件资源不足时，需要移除部分数据断点或选择更小的成员。

### 三种触发方式

| 方式   | 何时停止                                                           |
| ------ | ------------------------------------------------------------------ |
| 值变化 | CPU 写入使所监视数据的值改变；重复写入相同值通常不会向用户报告停止 |
| 读取   | CPU 读取所监视数据时停止                                           |
| 访问   | CPU 读取或写入所监视数据时停止，适合检查包括同值写入在内的访问     |

### 范围与限制

- 当前支持有明确内存地址、自然对齐的 **1、2、4 字节**变量或成员。较大的结构体、数组请选择其中的成员或元素。
- 优化掉的变量、寄存器变量、位域和不能确认地址的显示项无法设置。读取和访问断点是否可用，由芯片和 GDB 服务器决定。
- 使用 GDB 的**硬件监视点**，数量由目标硬件决定。不会自动退化为会反复单步、明显改变时序的软件监视点；有些资源不足只能在继续运行时由服务器报告。
- 监视的是设置时解析到的**固定内存地址**。局部变量离开作用域、容器重新分配内存或指针改变后，不会自动跟踪新对象；旧地址可能已被其他数据复用，应删除并重新设置。
- 数据断点仅在当前调试会话有效，停止调试后需要重新设置。
- 通常只能监视当前 CPU 的内存访问，不能用来保证捕获 DMA、其他内核或通过探针写入的数据。
- 它会暂停目标，适合定位代码和内存破坏。仅开启实时采样时不提供数据断点。

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

| 字段                 | 要求                                                          |
| -------------------- | ------------------------------------------------------------- |
| `serverGroup`        | 组名，1–64 个字母、数字、下划线、点或短横线，以字母或数字开头 |
| `numberOfProcessors` | 2–32                                                          |
| `targetProcessor`    | 从 0 开始的核索引                                             |
| `targetName`         | 可选，必须与该索引的实际目标名一致                            |

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

不支持下载、自动复位、Restart、多核共享、运行时采样、SWO 和 [RTT](#rtt-日志)，也不管理服务器和驱动。

EmberProbe 不主动发送 OpenOCD `monitor` 命令。你在配置里写的 attach hooks 会照常执行，请自行确认服务器兼容性。

## RTT 日志

通过 SEGGER RTT 查看固件输出，向固件发送一行输入，并把日志保存到文件。J-Link 和 CMSIS-DAP 用法相同。

### 固件要求

固件需要集成 SEGGER RTT（`SEGGER_RTT.c`），例如用 `SEGGER_RTT_printf(0, ...)` 输出，或把 `printf` 重定向到通道 0。

### 启动和停止

- **启动**：在侧栏“RTT 日志”卡片点击启动，或执行命令 `EmberProbe: 启动 RTT 日志`。
- **查看输出**：首次启动后，底部面板（问题、输出、终端、调试控制台所在的一栏）出现“RTT 终端”标签页。上方显示输出，下方是独立的输入框，用法同调试控制台。有多个通道时，面板顶部按通道分标签，有新输出的标签带圆点。
- **停止**：执行 `EmberProbe: 停止 RTT 日志`。标签页不会隐藏，保留已有输出和结束原因，下次启动继续使用。
- **找回面板**：点击卡片上的“终端”，或执行 `EmberProbe: 显示 RTT 终端`。面板标题栏的清空按钮清除当前通道的输出。

RTT 默认手动启动，之后跟随会话变化：调试或采样开始后继续输出，烧录期间暂停，输入框中未发送的内容保留。启动失败、重试耗尽和连接中断都显示在 RTT 卡片的提示框里，卡片折叠时自动展开。

打开 `emberprobe.rtt.autoStart` 后，调试或实时采样会话开始时自动附加 RTT。它只使用已经打开的会话，不会单独占用探针；在某次会话中手动停止后，这次会话不再自动启动。固件停在复位处时，使用精确控制块地址的自动启动会等待约 5 分钟。配置了通道 `mode` 时不自动启动，需要手动启动。

### 选择通道

默认读取 up 通道 0。用 `emberprobe.rtt.channels` 选择其他通道，例如 `[0, 2]`，最多 16 个，修改后手动重新启动生效。

也可以给通道指定模式，例如 `[0, { "index": 1, "mode": "trim" }]`。省略 mode 时保留固件设置；可选 skip、trim、block。覆盖模式需要精确控制块地址或 ELF `_SEGGER_RTT` 符号，并由你在 VS Code 中启动 RTT；Agent 不能隐式应用配置中的模式写入，但可以读取已经启动的输出。

对象写法还可以设置：

- `format`：`text`（默认，按行处理）、`raw`（解码后原样显示，用于 shell、光标控制等固件自己控制终端的场景）、`hex`（十六进制转储，带流偏移，用于二进制数据）。
- `encoding`：`utf-8`、`gbk`、`gb18030`、`big5`、`shift_jis`、`euc-kr`、`latin1`。默认取 `emberprobe.rtt.encoding`。
- `down`：输入发往的 down 通道，默认与 up 通道同号。

每个已配置的通道在 RTT 终端面板中有一个 `#N <名称>` 标签。固件尚未配置所选通道时会继续重试；未指定模式的通道只缺其中一部分时照常启动，并提示缺少的通道。指定了模式的通道必须初始化完成，等待耗尽时会明确失败。卡片显示实际模式；待应用或固件后来改变模式时，同时说明期望模式。

### 虚拟终端

固件用 `SEGGER_RTT_SetTerminal()` 在通道 0 上切换虚拟终端时，切换标记不会显示，来自 1 到 F 号终端的行带 `[Tn]` 前缀。不同终端的输出不会并在一行。通道 0 以 `latin1` 输出可能含 0xFF 的内容时，关闭 `emberprobe.rtt.virtualTerminals`。

### 找不到控制块

EmberProbe 依次尝试：

1. 设置 `emberprobe.rtt.controlBlockAddress`（如 `0x24000000`）。
2. ELF 中的 `_SEGGER_RTT` 符号。
3. 设置 `emberprobe.rtt.searchRange`（如 `{ "address": "0x20000000", "size": "0x20000" }`），最大 16 MiB。
4. ELF 中可写的 RAM 段。
5. 链接脚本中的第一个 RAM 区。

第 4、5 步最多自动搜索 1 MiB，超出时报 `RTT_SCAN_RANGE_TOO_LARGE`，需要设置地址或搜索范围。搜索期间采样和调试可以继续。适配器速度很低时直接设置地址。

搜索时探针无响应会报 `RTT_SCAN_TIMEOUT`。个别 CMSIS-DAP 探针在某些时钟下读取大块内存会卡住，这时设置控制块地址，或用 `emberprobe.samplingAdapterSpeedKhz` 换一个时钟。

ELF 中有多个 `_SEGGER_RTT` 时报 `RTT_CONTROL_BLOCK_AMBIGUOUS`，这时也要设置地址。修改地址、范围、通道或轮询间隔后需要重新启动 RTT。

### 向固件发送输入

默认在 RTT 终端面板下方的输入框输入一行并回车，发送到当前通道的 down 通道；发出的行以灰色 `> ` 显示在输出中，↑↓ 翻看该通道发过的行。`emberprobe.rtt.input.lineEnding` 选择行尾：`lf`（默认）、`crlf`、`cr` 或 `none`。

`emberprobe.rtt.input.mode` 设为 `raw` 后，输入框隐藏，点击输出区后每次按键立即发送，包括方向键和 Ctrl+C（选中文字时 Ctrl+C 仍是复制），不做本地回显，由固件决定显示什么。这两个设置立即生效。

- 输入始终按 UTF-8 发送，不跟随通道的 `encoding`。
- 每行最多 1022 个字节（不含行尾）；加上行尾不能超过 down 缓冲容量，超出时整行不发送。
- 没有 down 缓冲时输入框不可用；超长和发送失败的提示显示在输入框上方，不写入日志。
- 输入发送成功不代表固件已处理。缓冲中还有未读数据时，输入可能被丢弃。

### 时间戳和日志文件

- **时间戳**：`EmberProbe: 切换 RTT 时间戳`，或设置 `emberprobe.rtt.timestamps`。记录一行的第一个字节到达电脑的时间，格式 `[HH:MM:SS.mmm]`。这不是固件时间：同一次轮询读到的行时间相同，精度受轮询间隔限制，不能用来测量固件内部的时间差。`hex` 格式给每次收到的数据加时间，`raw` 格式不加。
- **保存日志**：`EmberProbe: 保存/停止保存 RTT 日志`，选择已有目录开始保存，再次执行停止。也可以设置 `emberprobe.rtt.logFile.enabled` 和 `directory`。

目录留空时使用工作区根目录，相对路径从根目录解析，没有工作区时要写绝对路径。单通道写入 `rtt.log`，多通道写入 `rtt-chN.log`，已有文件继续追加。

打开 `emberprobe.rtt.logFile.raw` 后保存收到的原始字节，单通道写入 `rtt.bin`，多通道写入 `rtt-chN.bin`，适合事后解码。原始日志不含时间戳、边界和缺口标记。

单个文件默认 8 MiB（`emberprobe.rtt.logFile.maxBytes`），写满后轮转为 `.1`，只保留一个备份。默认去除 ANSI 颜色序列，关闭 `emberprobe.rtt.logFile.stripAnsi` 可以保留。

日志写入失败时会提示并停止该文件的记录，终端继续输出。修改日志设置或重新启动 RTT 后再次尝试。时间戳和日志设置立即生效。

### 速率、占用和丢失

默认以 10 ms 间隔轮询目标。`emberprobe.rtt.pollingIntervalMs` 可调整间隔，显式设置 0 使用原有 100 ms；手动重启 RTT 后生效。更短间隔可能增加探针负载，具体吞吐和对采样的影响取决于探针、固件和通道数。

卡片按通道显示原始接收速率及累计接收字节。已知精确控制块地址时，还显示约每秒采样的目标缓冲占用；只有扫描范围时占用显示不可用，需要选择带符号 ELF 或设置精确地址。

主机“历史淘汰”表示缓存删除了旧历史，不等于终端已经漏读。终端或日志实际错过主机字节时会插入带字节数的缺口标记；会话切换的缺口无法定量，会单独提示。标准 RTT 不提供通用的固件丢弃计数，卡片会把目标丢失显示为未知。低占用、主机缺口为零都不能保证固件端未丢失。

### 通道模式

固件为每个通道设置模式：skip（剩余空间不足时丢弃整次写入）、trim（只保留能放入的前缀）、block（等待主机读取）。可以按上面的通道配置在启动时覆盖，停止 RTT 不恢复原模式。

**block 模式下主机没有读取时，目标会阻塞**，包括停止 RTT 后缓冲写满的情况。调试暂停时尤其要注意，排查时序问题建议用 skip 或 trim。

### 限制

- 只支持单核目标，多核共享调试组中不可用。
- 外部 GDB Server 模式下不可用。
- 不支持 SWO、半主机和 defmt 解码，也不解析固件自带的时间戳。
- 重新挂载时终端和日志会标记输出边界；缓冲溢出时显示数据丢失提示。
- 目标复位后输出偶尔会中断（目标缓冲有数据但不再被读取）。已知精确控制块地址时，扩展会在几秒内自动重新启动一次 RTT，终端出现边界标记；重启后仍无输出则停止并报错。只有扫描范围时没有这项检测，需要手动重启 RTT。

## 相关文档

- [烧录与调试启动设计](../design/flash-and-debug.md)
- [调试会话设计](../design/debug-sessions.md)
- [RTT 设计](../design/rtt.md)
