# 局部变量采样：审计与设计

日期：2026-10-24。范围：只读审计现有代码，给出可行性边界与设计建议；未改动实现，未连接硬件。

## 1. 结论摘要

- **函数内 `static`（C）和函数局部静态对象（C++ `_ZZ…`）已经支持**，与全局变量走同一条采样路径，不需要新功能，只需改善显示名。
- **真正的栈上局部变量只有在“栈帧长期存活且地址固定”时才能做非侵入连续采样**：`main()` 超级循环、RTOS 任务入口函数（`for(;;)` 不返回）以及这类函数中不返回的 C++ `run()` 方法。地址解析一次后就是普通内存地址，可与全局变量同轮、同时间戳读取，几乎没有额外开销。
- **寄存器中的局部变量（`-O2/-Os` 下的大多数标量）和短生命周期函数的局部变量无法在目标运行时读取**。Cortex-M 的核心寄存器只能在暂停状态下经 DCRSR 读取；短命栈帧在采样时刻大多已不存在。对这两类只能提供：暂停时快照（已有），或可选的“断点采样”（侵入式，需要单独确认，单独限速）。
- **推荐路线**：先做 GDB 辅助的“固定帧”方案。目标暂停时由 GDB 解析地址和位置类型，恢复运行后由现有采样 Worker 按普通地址采样，并在同一批读取中顺带读取帧守卫字。之后再自研 `.debug_frame` 展开，从阻塞任务保存的上下文中非侵入地解析地址。断点采样放到最后，作为可选功能。

## 2. 现状审计

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 采样读取 | 采样 Worker 独占 OpenOCD Tcl 连接；按地址排序合并相邻范围，每条 Tcl 命令最多 8 组、1024 字节（`join [list ocd_read_memory …]`） | [liveWatch.js:214](../../src/liveWatch.js#L214)、[liveWatch.js:1390](../../src/liveWatch.js#L1390) |
| 同轮多速率 | 波形与侧栏消费者同轮到期时合并读取，同一个 `t` | [multiRatePlan.js](../../src/services/multiRatePlan.js) |
| 运行时地址（指针追踪） | `runtimeLayout` 项每轮由 `RuntimeObjectReader` 先读指针再读对象，有字节、命令和时间预算 | [liveWatch.js:1469](../../src/liveWatch.js#L1469)、[runtimeObjectReader.js](../../src/services/runtimeObjectReader.js) |
| 调试态预算 | 每轮 4096 B / 32 条命令 / 1 s；超预算项被剔除，其余继续采样 | [liveWatch.js:24](../../src/liveWatch.js#L24)、[mainViewProvider.js:1692](../../src/mainViewProvider.js#L1692) |
| RAM 白名单 | 托管调试读取只允许 ELF 中 `WRITE|ALLOC` 段内的地址 | [liveWatchService.js:143](../../src/services/liveWatchService.js#L143) |
| DWARF 局部变量 | 解析器**默认跳过**子程序内的局部 DIE（`LOCAL_TAGS`），只保留有静态地址（`DW_OP_addr`/`addrx`）的 static local；`retainLocals` 只用于修补类型引用 | [dwarf/parser.js:51](../../src/dwarf/parser.js#L51)、[dwarf/parser.js:558](../../src/dwarf/parser.js#L558) |
| static local 命名 | 编号名 `calls.0`、`file::calls.0` 与 C++ `_ZZ` 已有身份规则与测试 | [elfSymbols.js:55](../../src/elfSymbols.js#L55)、`test/agent-cu-static-variables.test.js` |
| CFI / 栈展开 | **没有**。`.debug_frame` / `.ARM.exidx` 均未解析 | — |
| 调试器 locals | 暂停时通过 GDB `-stack-list-variables` + varobj 取得，绑定线程/栈帧/停止代次 | [debug/variables.js:248](../../src/debug/variables.js#L248) |
| 暂停快照 | DAP 暂停快照一次性读取，间隔至少 250 ms | [debugSessionBridge.js:5](../../src/services/debugSessionBridge.js#L5) |
| 非侵入运行态信息（历史实现，后于 `e1fddf3` 移除） | CPU 负载采样在一次 Tcl 请求中读取 `pxCurrentTCB`、ICSR.VECTACTIVE 和可选 DWT PCSR，不轮询 DHCSR | [cpuLoadSampler.js:13](https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/blob/a23ea4e86f4b0509adfd4e381ef37a04187d3b53/src/services/cpuLoadSampler.js#L13)、[CPU-LOAD-MONITORING.md](https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/blob/a23ea4e86f4b0509adfd4e381ef37a04187d3b53/docs/CPU-LOAD-MONITORING.md) |
| RTOS 任务栈 | 快照已读取 `pxTopOfStack`、`pxStack`，并估算栈使用量 | [freeRtosSnapshot.js:185](../../src/services/freeRtosSnapshot.js#L185) |
| 缺失值 | 历史 Worker 与 `samples.bin` 归档都有独立缺失标记，曲线会断开 | `docs/LAYERED-SAMPLING.md` |

关键缺口：没有栈展开，没有局部变量的位置表达式求值，栈区不在 RAM 白名单内，也没有“帧身份”概念。

## 3. 哪些局部变量能采样

判断取决于两个维度：**变量存在哪里**（存储位置）和**它的栈帧活多久**（帧生命周期）。

| 类别 | 典型例子 | 运行中连续采样 | 暂停快照 | 说明 |
| --- | --- | :-: | :-: | --- |
| A. 函数内 `static` / C++ 函数局部静态 | `static uint32_t calls;`、`static Foo inst;` | ✅ 已支持 | ✅ | `DW_OP_addr` 固定地址，本质上是全局变量 |
| B. 长期帧中的栈变量（`DW_OP_fbreg`） | `main()` 循环里的 `int cnt`、任务函数里的 `pid_t pid` | ✅ 新增（主要价值） | ✅ | 帧在函数返回前地址不变；需要帧守卫 |
| C. 长期帧中的 `volatile` / 取过地址 / 数组 / 结构体 | `volatile float err;`、`uint8_t buf[64]` | ✅ | ✅ | 即使 `-O2` 也大多留在栈上 |
| D. 长期帧中的寄存器变量（`DW_OP_regN` / 位置列表） | `-O2` 下的循环计数器 | ❌ | ✅ | 运行中寄存器不可读；阻塞任务中被保存的 r4–r11 例外，见 §5.3 |
| E. 短生命周期函数的局部变量 | `pid_update()` 内的临时量、ISR 局部变量 | ❌（只能断点采样） | ✅（只在停在该函数时） | 采样时刻帧多半不存在；同一地址被其他调用复用，读到的是垃圾数据 |
| F. 引用/指针局部变量所指对象 | `Foo& f = …;`、`this->state` | ✅（B 类槽位 + 现有指针追踪） | ✅ | 槽位地址固定后，复用 `runtimeLayout` 读取所指对象 |
| G. 被优化掉的变量（`<optimized out>`）、`DW_OP_stack_value`、`DW_OP_implicit_value` | — | ❌ | 部分 | 没有存储位置，没有可读内存 |
| H. 递归帧、VLA/`alloca` 函数中的变量 | — | ❌ | ✅ | 帧地址不唯一或随运行变化；应拒绝 |

**FreeRTOS 的重要陷阱**：CM3/CM4F/CM7 端口在 `prvPortStartFirstTask` 中会把 MSP 复位到向量表初值，之后中断复用 `main()` 的栈。调度器启动后，`main()` 中的局部变量会被覆盖。检测到 `xSchedulerRunning != 0` 时，必须把位于 MSP 上的 `main()` 帧标记为失效，不能继续显示数值。

### “长期帧”的判定

当前栈帧满足以下条件时，可以视为长期帧：

1. 目标函数是 `main`，或是某个任务栈最外层的函数（展开到底的那一帧），或是在它们之下、且在暂停时用户显式指定的不返回函数（例如 `Controller::run()`）；
2. 函数没有 VLA/`alloca`（帧大小不随运行变化）；
3. 同一任务中该函数只出现一次（排除递归）；
4. 变量位置是单一内存表达式：`DW_OP_fbreg(n)`，或者位置列表在该函数所有可能的“停留 PC”范围内都解析为同一内存地址。保守起见，第一版只接受单一表达式 `exprloc`，不接受位置列表。

## 4. C / C++ 支持

| 语言特性 | 支持 | 备注 |
| --- | --- | --- |
| C 自动变量、结构体、数组、位域 | ✅ | 类型布局复用全局变量的 `compositeLayout` / 位域解码 |
| C 函数内 `static` | ✅ 已有 | 显示名建议从 `calls.0` 改为 `函数::calls`（DWARF 父 DIE 即可给出函数名） |
| C++ 函数局部静态 `_ZZ…` | ✅ 已有 | 带线程安全初始化时，可读取 `_ZGV…` 守卫字节，显示“未初始化”状态 |
| C++ 类类型局部对象 | ✅ | 布局同全局对象；局部类（定义在函数内的类型）由解析器保留的 lexical block 作用域支撑 |
| C++ 引用局部变量、`this` | ✅（经指针追踪） | `this` 是 artificial 形参。`-O0` 时在栈上；`-O2` 时多在寄存器，见 D 类 |
| 不返回的成员函数（`Task::run()`） | ✅ | 常见的 C++ 任务模式；`this->成员` 本来就能通过全局实例访问，局部价值在 `run()` 内的临时状态 |
| 内联函数的局部变量（`DW_TAG_inlined_subroutine`） | 部分 | 只有外层真实帧是长期帧，且 GDB 能给出内存地址时才支持 |
| 模板实例 | ✅ | 名称按 DWARF 限定名 / 反修饰显示 |
| 栈上 STL 容器（`std::array`、`std::vector`） | 部分 | `std::array` 是定长布局；`std::vector` 等需要走现有运行时对象的预算与只读规则 |
| lambda 闭包、协程帧 | ❌ | 第一版不支持 |

**编译器与优化等级**（决定实际可用比例）：

| 构建 | 栈上可采样比例 | 说明 |
| --- | --- | --- |
| GCC `-O0`（CubeMX Debug 默认） | 高 | 几乎所有局部变量都是 `DW_OP_fbreg`；GCC ARM 的 `DW_AT_frame_base` 通常是 `DW_OP_call_frame_cfa` |
| GCC `-Og` | 中 | 标量常在寄存器且带位置列表 |
| GCC `-O2/-Os`、LTO | 低 | 只有 C 类（volatile、数组、结构体、取址变量）可靠 |
| armclang / LLVM | 中 | frame base 可能是 `DW_OP_reg7`（r7）或 `DW_OP_reg13`（sp），需要分别处理；要做实板验证 |
| IAR | 未验证 | 不在第一版范围 |
| `-g0` / 剥离 DWARF | ❌ | 没有局部变量信息 |

界面上应把“不支持”的原因直接告诉用户，并给出可操作的建议：“位于寄存器 r4（优化等级导致）。可声明为 `volatile`、改用 `-Og/-O0`，或使用断点采样。”

## 5. 地址解析方案

核心思路：**解析一次，按普通地址持续读取，用帧守卫做廉价校验**。

### 5.1 路线一（MVP）：GDB 辅助解析

适用于托管调试会话中的暂停状态，也可以在独立采样模式下临时启动一个 GDB 来完成一次解析。

1. 目标暂停（用户断点，或经确认的短暂 halt）。
2. 对选中的线程/栈帧执行：
   - `-stack-select-frame` + `info address <var>`：得到位置类型（`a variable at frame base reg $r7 offset 8+-12`、`a variable in register $r4`、`multi-location` 等），用来区分 B/C 与 D/G 类；
   - `-data-evaluate-expression &(<var>)`：得到绝对地址（GDB 会处理 CFI、frame base 和位置列表）；
   - `-data-evaluate-expression sizeof(<var>)` 和类型名：与 ELF/DWARF 布局交叉核对；
   - 记录帧守卫：`$pc` 所在函数、CFA（`info frame` 的 `frame at`），以及保存的返回地址槽（GDB `info frame` 中的 `Saved registers: lr at 0x…`）及其当前值。
3. 恢复运行后，生成普通的固定地址观察项（附带 `localFrame` 元数据），交给现有读取计划。

优点：无需在扩展中实现 CFI/位置表达式求值；正确性依赖 GDB。缺点：需要暂停一次；独立模式下需要 GDB 工具链（项目已有 `cortexToolchainService`）。

### 5.2 路线二：自研静态解析（无 GDB）

- 惰性解析 DWARF：主解析仍跳过局部变量（保持现有 200 万 DIE 等加载预算），只为用户选中的子程序在 `elfWorker` 中按偏移重新解析其子树，单独设置预算。
- 新增 `.debug_frame` CFI 解析器（只需支持 Cortex-M 常见指令：`def_cfa`、`def_cfa_offset`、`offset`、`restore`、`advance_loc`、`remember/restore_state`），以及一个只覆盖 `fbreg`/`breg`/`call_frame_cfa`/`addr`/`piece` 的位置表达式求值器。
- 暂停时根据 `PC/SP/LR` 展开得到 CFA；也可以使用 §5.3 中的保存上下文。

### 5.3 路线三：从阻塞任务的保存上下文非侵入解析（FreeRTOS）

被切出的任务把上下文保存在自己的栈上：`pxTopOfStack` → 软件保存的 r4–r11（CM4F/CM7 还有 EXC_RETURN 和按需的 s16–s31）→ 硬件帧 r0–r3、r12、LR、PC、xPSR（按需含 s0–s15、FPSCR）。读出这段内存就得到完整寄存器组，再用 §5.2 的 CFI 展开到最外层（任务入口函数）帧，即可在**不暂停目标**的情况下得到 CFA 和局部变量地址。

- 要求任务当前未运行（`pxCurrentTCB` 不等于该 TCB）；正在运行的任务等它阻塞后重试，不需要暂停目标。
- 端口差异（CM0、CM3、CM4F、CM7 r0p1、CM33 带 PSPLIM/安全上下文）要按端口白名单处理；第一版只支持 CM3/CM4F/CM7。
- 额外收益：保存上下文中的 r4–r11 让 D 类中“入口帧里跨阻塞调用存活在被调用者保存寄存器中”的变量，在任务阻塞期间也可读，但前提是该 PC 处的位置列表指向这个寄存器。这一项复杂度高，放到最后。

### 5.4 帧守卫（每轮或低频校验）

| 守卫 | 成本 | 频率 | 失败时 |
| --- | --- | --- | --- |
| 返回地址槽（CFA-4 附近的保存 LR，入口函数为 `prvTaskExitError`，`main` 为返回 Reset_Handler 的地址） | 1 个字，通常与局部变量相邻，并入同一读取组 | 每轮 | 该帧所有通道输出缺失值并报 `LIVE_FRAME_INACTIVE` |
| TCB 身份（TCB 地址、`pxStack` 不变，任务未被删除） | 1 组，约 8 B | 1–5 Hz（低速消费者） | 标记任务已删除或重建，需要重新解析 |
| 调度器状态（`main` 帧在 MSP 上时检查 `xSchedulerRunning`） | 1 个字 | 1 Hz | `main` 帧失效 |
| 栈范围（地址位于该任务 `pxStack … pxStack+深度` 或 MSP 栈区） | 静态检查 | 解析时 | 拒绝 |
| 复位、重新烧录、ELF SHA 变化、`targetEpoch` 变化 | 无 | 事件触发 | 回到“待解析”状态 |

如果编译器没有在长期帧中压栈 LR（`-O2` 下的 `noreturn` 循环常见），就退化为只使用 TCB 和栈范围守卫，并在界面上标记“守卫较弱”。

### 5.5 RAM 白名单

`filterRuntimeRamPlan` 只允许 ELF `WRITE|ALLOC` 段。FreeRTOS 动态任务栈位于 `ucHeap`（`.bss`）中，可以通过；但 `main` 使用的 MSP 栈通常从 `_estack` 向下增长，常常不在 `._user_heap_stack` 段内，会被判为 `LIVE_ADDRESS_NOT_RAM`。需要新增一个“已验证栈区”来源：`_estack` 与 `_Min_Stack_Size` 符号、RTOS 快照中的 `pxStack` 范围，或者解析时由 GDB 读到的 MSP/PSP 加上链接脚本中的内存区域。只放行这些显式验证过的栈区，不要整体放宽白名单。

## 6. 与全局变量同步采样和性能

**同步**：解析后的局部变量就是普通 `{ name, address, size }` 项，进入 `buildActiveReadPlan` → `MultiRatePlan` → `compileReadBatches`，与全局变量在**同一采样周期、同一 `t`**读取。不需要新的时钟，也不需要新的对齐逻辑。历史、归档、冻结、CSV 导出全部复用。

**开销分析**：

- 同一帧的局部变量在栈上连续，加上相邻的守卫字通常合并为 **1 个读取组**。栈区与 `.data/.bss` 不相邻，所以会多出 1 组；但每条 Tcl 命令可容纳 8 组，因此多数情况下**不增加 Tcl 往返次数**，只增加字节数（通常 < 64 B）。实际频率主要由 Tcl 往返次数决定，所以对 200 Hz 或不限速模式影响很小。
- 多个任务帧各占 1 组；超过 8 组才会多一条 Tcl 命令。
- 调试态每轮 4096 B / 32 条命令的预算继续适用；`partitionManagedReadPlan` 优先保留小项，大的局部数组可能被剔除。界面需要显示“超出每轮预算”。
- 解析（GDB 或 CFI 展开）只在添加变量、复位或守卫失败时执行一次，不进入采样热路径。CFI 表按 ELF SHA 缓存在 Worker 中。
- TCB 守卫走低速消费者（与侧栏 20 Hz 同类机制，复用 `MultiRatePlan` 的“同轮到期合并”），不拖慢波形频率。
- 守卫失败时输出缺失值，而不是停止采样；其他通道不受影响。

**一致性说明**：与全局变量一样，各组按顺序读取，不是原子快照；同一帧内的局部变量在一次内存读取中取得，彼此一致到字粒度。需要严格一致的快照只能暂停目标（§7）。

**通道身份**：同一个任务函数可能被多个任务实例复用（不同的 `pvParameters`），每个实例有自己的帧，因此身份必须包含帧实例：

```
local:<ELF SHA>:<CU 路径>::<函数限定名>#<变量 DIE 偏移>@<任务 TCB 地址 | "main">
```

显示名使用 `vCtrlTask()::pid.err @ CtrlTask`。归档字典按“变量键 + 身份”分配通道，因此重新解析后 CFA 改变时会产生新通道，旧数据不会混入。

## 7. 断点采样（可选，侵入式）

用于 E 类（短命函数，例如控制环 `pid_update()` 中的临时量）：

- 在指定源码行设置硬件断点（Cortex-M FPB 通常 6–8 个），命中 → 读取寄存器/内存 → 自动继续，类似 GDB tracepoint。
- **每次命中都会暂停 CPU**（ST-Link 往返通常在毫秒量级），会破坏 1 kHz 控制环这类实时行为；外设是否随之冻结取决于 DBGMCU 配置。必须显式开启，并经过确认（与写入/烧录相同级别的提示）；默认限速（例如 ≤ 10 Hz，命中过频时在 N 次后自动禁用断点），并在通道上显示“侵入式”标记。
- 同步：目标处于暂停状态时，同时读取当前波形中的全局变量，得到严格一致的快照点；这些点在图上画为散点或阶梯，不与连续曲线插值相连。
- 与托管调试会话冲突（GDB 拥有断点）：只在本扩展的调试器中提供，并且要占用 FPB 名额、与用户断点隔离。

这一部分风险最高，建议最后再做，或者只在调试会话中通过“日志断点 + 值记录”实现。

## 8. 前端设计

### 8.1 入口

1. **调试器变量视图（主要入口）**：暂停时在 VS Code Variables 视图的 locals 上提供右键菜单“持续采样（运行时）”/“加入波形”（`debug/variables/context`）。可行性立即判定：可采样的直接加入；不可采样的显示禁用项和原因（寄存器、短命帧、被优化掉）。
2. **侧栏“局部变量”分组**：在“ELF 全部变量”旁增加一个切换，按 `任务 / 函数` 分组列出长期帧候选（`main` 和各任务入口函数；任务列表来自 RTOS 快照）。每个函数展开后显示其 DWARF 局部变量及其可行性标记。地址尚未解析的条目显示“待解析”。
3. **手动输入**：扩展现有的 `file::name` 语法：`main()::counter`、`vCtrlTask()::pid@CtrlTask`、`app::Controller::run()::acc`。
4. **Agent / MCP**：`mcu-variables` 技能接受同样的限定语法；解析时需要暂停目标的，遵循现有确认流程。

### 8.2 卡片状态机

```
待解析 ──(暂停/保存上下文解析)──▶ 采样中 ──(守卫失败)──▶ 帧失效（灰，曲线断开）
   ▲                                │                         │
   └──── 复位 / 重新烧录 / ELF 变化 ◀─┴──── 任务删除/重建 ◀───────┘
```

- **徽标**：`栈` 表示长期帧局部变量；`static` 表示函数内静态变量；`侵入式` 表示断点采样（琥珀色）；`守卫较弱` 表示没有找到返回地址槽。
- **悬停详情**：函数、任务、CFA、位置描述（`fbreg -12`）、守卫类型、解析来源（GDB / CFI / 保存上下文）、优化等级提示。
- **不可采样项**：保留在列表中但置灰，并在一行中说明原因和建议，不静默丢弃。
- **写入**：局部变量写入沿用现有写入授权；帧守卫失败时拒绝写入（防止写入已被复用的栈内存）。第一版可以只读。

### 8.3 波形窗口

- 图例前缀显示作用域：`vCtrlTask › pid.err`；颜色、样式与全局变量一致（复用 `seriesStyleStore`）。
- 帧失效期间沿用现有缺失值分段，在断开处显示原因标记（悬停可见“任务已删除”“调度器已启动，main 帧失效”）。
- 断点采样通道用散点或阶梯显示，悬停显示命中时刻和同步读取的全局变量值。
- 工具栏的速率区域在存在局部变量时增加“局部 N 项 · 守卫 1 Hz”提示；超出预算时沿用现有 `overBudget` 提示。

UI 原型应在 `src/webview/mockup/` 中复用真实前端组件制作，不另画假界面。

## 9. 分阶段实施

| 阶段 | 内容 | 主要改动 | 风险 |
| --- | --- | --- | --- |
| P0 | static local 显示名改为 `函数::变量`；C++ `_ZGV` 初始化状态 | `elfSymbols`、`dwarf/types` | 低 |
| P1 | GDB 辅助解析长期帧（调试会话暂停时），Variables 右键入口，帧守卫（返回地址槽 + 事件失效），栈区白名单，通道身份 | `debug/variables`、新的 `services/localFrameResolver.js`、`liveWatchService`、`mainViewProvider`、`i18n` | 中：守卫误判；GDB 输出格式差异 |
| P2 | 惰性局部 DIE 解析与 `.debug_frame` CFI 展开；FreeRTOS 保存上下文非侵入解析；侧栏“局部变量”分组 | `dwarf/parser`（按子程序重新解析）、新的 `dwarf/cfi.js`、`elfWorker`、`freeRtosSnapshot` | 中高：端口差异、FPU 上下文 |
| P3 | 断点采样（侵入式），带确认、限速和自动禁用 | `debug/session`、`probeCoordinator` | 高：实时性影响、断点资源冲突 |

**测试**（遵循 AGENTS.md，普通测试不依赖探针）：

- 在 `test/helpers/elf-fixture` 中构造带 `DW_OP_fbreg`、`DW_OP_reg4`、位置列表、`DW_OP_call_frame_cfa` 的子程序，测试可行性分类。
- CFI：构造 `.debug_frame` 字节流，覆盖 CM3/CM4F 序言与 `remember_state`，并加入畸形输入的预算测试。
- 保存上下文：用合成的栈内存测试 EXC_RETURN 位 4 两种情况（有/无 FPU 帧）。
- 读取计划：验证局部变量与全局变量同批、同 `t`，组数与 Tcl 命令数符合预期；守卫失败时输出缺失值，其他通道不受影响。
- 身份：同一任务函数的两个实例产生两个通道；重新解析后 CFA 改变时产生新的身份。
- `test/gdb/` 中加入真实 `arm-none-eabi-gdb` 的 `info address` 解析测试。
- 实板验证（需单独授权）：H750/F407 × `-O0/-Og/-O2` × 裸机/FreeRTOS。

## 10. 待确认问题

1. 第一版是否只在**调试会话中**提供（借助 GDB 解析，最低风险），还是也要覆盖独立采样模式（需要临时启动 GDB 或在 P2 自研展开）？
2. 独立模式下解析时短暂暂停目标（约几十毫秒），是否接受用“一次确认”的方式处理，还是必须完全非侵入（只走 P2 的保存上下文路线，只覆盖阻塞的 RTOS 任务）？
3. 局部变量是否需要支持写入？建议第一版只读。
4. 断点采样是否在范围内？它是唯一能覆盖短命函数局部变量的方式，但它会改变目标的实时行为。
