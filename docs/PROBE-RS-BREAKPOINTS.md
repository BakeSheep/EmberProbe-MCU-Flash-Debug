# probe-rs 断点调试

EmberProbe 使用 `emberprobe-probe-rs` 调试类型，将 VS Code 的 DAP 请求转发给本机 `probe-rs dap-server`。源码断点语言注册包括 C、C++、ASM 与 Rust，不需要其他调试扩展注册这些语言。

选择 probe-rs 后端、目标芯片与包含 DWARF 的匹配 ELF，使用侧栏“启动调试”或 F5 开启调试。`launch` 默认烧录；对已烧录固件使用 `attach`，其初始化可能短暂停机。连接后可在源码行号旁点击或按 F9 设置普通硬件断点，命中后查看调用栈、作用域、局部变量与寄存器，并执行继续、单步进入、单步跳过和单步跳出。反汇编视图支持指令断点。断点地址解析和可用硬件槽位受固件符号、优化程度、核心与上游实现限制。

## 当前能力与 Agent 行为

GCC C++ 的部分 DWARF 行表没有 `prologue_end` 标记，当前 probe-rs 对这种编译单元的源码断点可能返回 `No valid breakpoint information`，即使 `-O0 -g3` 的行地址存在；Windows 路径大小写也可能造成绝对路径匹配失败。EmberProbe 先使用上游源码解析，失败时只为普通源码断点读取当前调试 ELF 的 DWARF 行表，在实际可执行段中查找精确文件和行的地址，再由上游指令断点验证。只有指令断点设置成功才显示已验证。函数、条件、命中次数和日志断点不会静默变为普通断点。

行表解析在 ELF Worker 内执行，支持 DWARF 2–5，限制文件、操作次数、时间和字节数。没有实际指令的空行、无匹配源码、已替换的 ELF 或硬件断点槽位不足仍返回失败。源码回退地址与反汇编断点合并管理，删除一种来源保留其他来源的断点。此兼容路径不修复上游 C++ 的源码单步算法；单步能否停在下一源码行仍依赖上游对当前固件的支持，可使用指令粒度检查。

通过“开始采样”自动 attach 后，侧栏写入复用同一 DAP 会话。新增写入变量导致快照刷新的短暂窗口会等待当前采样读取完成，再执行一次写入与回读校验。停止采样、切换会话或改变执行状态会取消待写请求。界面分别显示采样未开启、当前值读取中、调试器操作进行中或不支持内存写入，避免把所有不可写状态都提示为“开始采样”。

拖动写入滑条时，全侧栏最多一笔写入在途；每个变量仅保留最新待发送值，并维持 10 Hz 拖动节流。当前侧栏写入及随后的快照刷新允许继续拖动，松手后提交最终值；旧回读不会覆盖更新的输入。停止、切换会话/停止代次、执行控制、移除变量或真实写入失败清除待发送值，不自动重试失败写入。

本机 probe-rs 0.32.0 的 DAP 声明支持指令断点与单步粒度，支持普通源码硬件断点；未声明函数、条件、命中次数、日志点或数据断点能力。参考 [上游调试器说明](https://probe.rs/docs/tools/debugger/)。

Agent 的 `debug.status.capabilities` 保留所选会话的 `functionBreakpoints`、`conditionalBreakpoints`、`hitConditionalBreakpoints` 和 `logPoints`。初始化前为 `null`，初始化后未声明的能力为 `false`；动态能力事件和会话切换更新各会话自己的状态。

- 普通源码断点可以在会话开始前设置。
- 添加或启用函数及高级源码断点要求相关能力为 `true`。明确不支持时返回 `BREAKPOINT_UNSUPPORTED`；尚未取得能力时返回 `BREAKPOINT_CAPABILITY_UNAVAILABLE`。
- 启用已有断点时检查保存的条件、命中次数与日志消息，并在验证所有匹配项后才修改断点列表。
- 删除或禁用仍可用于清理不受支持的断点。
- 多会话存在歧义时，添加或启用前须显式选择会话。断点列表中的 `verified` 和实际行号来自适配器；仅列在 VS Code 中不能证明固件地址已验证或命中。

## 软件回归

`test/debug-control.test.js` 覆盖能力未知、不支持与支持、输入类型、动态能力更新、所选会话隔离，以及拒绝时无断点列表变化。`test/rust-probe-rs.test.js` 检查调试语言的断点注册。

`test/probe-rs-source-breakpoints.test.js` 覆盖无 prologue 标记的 C++ 行表、Windows 路径大小写、DWARF 2–5、精确文件/行、损坏与预算拒绝、源码/反汇编断点合并清理，以及 Worker ELF 代次隔离。Extension Host 另行覆盖通过“开始采样”自动连接的 C++ F9 回退和新增写入变量后立即写入。`test/probe-rs-safety.test.js` 验证快照刷新、停止采样、后端不支持写入和会话结束时的写入行为。

`test/write-slider.test.js` 使用实际侧栏 DOM 验证慢写入期间的密集拖动、最终值合并、节流、旧结果隔离、多变量串行、状态/列表取消与真实失败提示。Extension Host 把这些 UI 消息交给生产消息处理器，通过模拟 DAP 验证写入回读；`test/probe-rs-safety.test.js` 另行拒绝旧会话和停止代次的 UI 写入。

`test/probe-rs-debug-adapter.test.js` 通过真实子进程和模拟 DAP 后端覆盖源码/指令断点命中、调用栈与变量、单步、旧变量引用失效、未验证断点、事件超时与退出确认。`test/e2e/suite/probe-rs.test.js` 在无其他调试扩展的 VS Code Extension Host 中执行 Rust 源码 F9、断点验证与命中、调用栈/局部变量、单步和继续，并检查 Agent 能力拒绝。模拟结果不证明真实芯片、探针或平台支持。

## 独立真机验收

`test/hil/probe-rs-breakpoint-smoke.js` 是显式启用的独立 DAP 验收，不属于普通测试或 `npm run test:hil`。需要专用板卡、探针独占、正在运行且已烧录的固件，以及与之匹配的未剥离 ELF 和源码。选取会反复执行的源码行，例如 Embassy H723 测试程序循环内的 `TUNE_MS.load`；一次性初始化行不能保证 attach 后仍会执行。源码路径须与 ELF 中的 DWARF 能匹配，不能把其他固件的行号直接套用。

该脚本会 attach、设置源码硬件断点、等待命中、读取调用栈与变量/寄存器、改用同一地址的指令断点（若支持）、执行一次源码单步，然后清除断点、继续运行并确认进程退出。它不烧录或复位，但会暂停和推进固件执行；应在执行这些动作前取得硬件操作授权。

在仓库根目录使用 Node.js 20+，替换以下路径、芯片、探针和行号：

```powershell
$env:EMBERPROBE_HIL_CONFIRM = "YES"
$env:EMBERPROBE_HIL_ELF = "C:/path/to/flashed/firmware.elf"
$env:EMBERPROBE_HIL_CHIP = "STM32H723VG"
$env:EMBERPROBE_HIL_PROBE = "VID:PID:Serial"
$env:EMBERPROBE_HIL_SOURCE = "C:/path/to/firmware/src/main.rs"
$env:EMBERPROBE_HIL_LINE = "25"
$env:EMBERPROBE_HIL_SPEED = "2000"
$env:EMBERPROBE_HIL_PROBE_RS = "probe-rs"
node test/hil/probe-rs-breakpoint-smoke.js
```

多探针环境必须提供明确的选择器；单探针环境可不设置 `EMBERPROBE_HIL_PROBE`。每次请求和状态事件有独立时间预算，错误不自动重试。脚本输出已验证地址、实际源码位置、读取作用域、单步后栈帧、运行恢复和进程退出结果；清理失败会使验收失败。

将实际输出与 OS、probe-rs 版本、板卡/探针型号及固件标识一起保存。此次修复的验收限于软件测试；真实源码与指令断点命中须执行上述专用硬件测试后另行记录。
