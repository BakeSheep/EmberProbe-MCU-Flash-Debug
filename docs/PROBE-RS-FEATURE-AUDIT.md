# probe-rs 与 OpenOCD 后端功能接入对比审计报告

> **审计日期**：2026-10-10  
> **审计范围**：EmberProbe 当前工作区中 probe-rs 与 OpenOCD 的主要功能接入，区分侧栏独立操作、F5/DAP 调试和共用 ELF/DWARF 服务。  
> **代码基线**：HEAD `14c37b6f51f594bca6ce0ff7852109b29cf6d2b7`，包含当前未提交的 probe-rs 目标选择改动。  
> **上游基线**：本机 probe-rs `0.32.0 (48f5e4d)`，实现按上游 `v0.32.0` 源码核对。  
> **审计结论**：**probe-rs 尚未达到 OpenOCD 在 EmberProbe 中的功能等价**。当前已接入 DAP 调试、运行中固定地址 RAM 采样与限定标量写回，以及 RTT/defmt 输出；Agent Flash、Agent Fault 分析、RTOS 任务诊断、多会话共享组和驱动助手等仍有差距。Rust static/Atomic 解析属于共用能力，不能列为 probe-rs 独占优势；运行中读写也不能承诺核心绝不暂停。

**证据边界**：下表“已接入”表示存在实现路径，不代表所有芯片、探针和平台均经过实板验收。性能数字引用既有验收记录，不构成同条件后端性能比较。本次未找到 F407 验收所指的原始 `test-results/probe-rs-f407.json`，未重新计算其采样率和分位耗时。

**核心源码**：

- 烧录：[probeRsFlashService.js](../src/services/probeRsFlashService.js)、[flashService.js](../src/services/flashService.js)、[agentFlashService.js](../src/services/agentFlashService.js)、[elf-file.js](../skills/_emberprobe/elf-file.js)、[debugImages.js](../src/services/debugImages.js)。
- 调试：[probeRsConfiguration.js](../src/services/probeRsConfiguration.js)、[probeRsDebugAdapter.js](../src/services/probeRsDebugAdapter.js)、[debugSessionBridge.js](../src/services/debugSessionBridge.js)、[session.js](../src/debug/session.js)。
- LiveWatch 与类型：[mainViewProvider.js](../src/mainViewProvider.js)、[liveWatch.js](../src/liveWatch.js)、[liveWatchService.js](../src/services/liveWatchService.js)、[types.js](../src/dwarf/types.js)、[svdPeripheralService.js](../src/services/svdPeripheralService.js)。
- 诊断与配置：[probeRsChipInfo.js](../src/services/probeRsChipInfo.js)、[probeRsStatusService.js](../src/services/probeRsStatusService.js)、[rules.js](../src/chip/rules.js)、[autoDetect.js](../src/autoDetect.js)、[probeRsTargets.js](../src/services/probeRsTargets.js)。

---

## 一、主要功能接入矩阵

| 功能维度                 | 细分子项                      | OpenOCD 接入                              | probe-rs 接入                                       | 状态判定              | 差异与限制                                                               |
| :----------------------- | :---------------------------- | :---------------------------------------- | :-------------------------------------------------- | :-------------------- | :----------------------------------------------------------------------- |
| **固件烧录与擦除**       | 侧栏独立固件烧录              | 支持 ELF32 little-endian                  | 支持 ELF32 little-endian                            | 已接入                | 两者均经过 `inspectElf`；侧栏均不直接接受 HEX/BIN                        |
|                          | F5 Launch 烧录                | 支持                                      | 支持，可关闭 `flashingEnabled`                      | 已接入                | 不应将 Launch 一概描述为必然烧录                                         |
|                          | Intel HEX 镜像加载            | F5 `loadFiles` 支持                       | 侧栏未接入；纯 HEX 的 F5 路径未建立完整验收         | 接入差距              | probe-rs 配置保留 `formatOptions`，但 `programBinary` 还承担调试信息加载 |
|                          | RAW BIN 与基地址              | F5 `loadFiles` 支持，要求 `address`       | 侧栏未封装格式/基地址；F5 纯 BIN 路径未建立完整验收 | 接入差距              | 不能把扩展入口限制描述为上游 CLI 不支持                                  |
|                          | 独立全片擦除入口              | 未提供                                    | 未提供                                              | 入口均缺              | probe-rs F5 烧录可配置 `fullChipErase`，不等于独立擦除入口               |
|                          | 烧录时扇区擦除                | 支持                                      | 支持                                                | 已接入                | 按镜像涉及区域和算法处理；不承诺自动跳过已一致内容                       |
|                          | 侧栏烧录进度与默认校验        | 流式进度，`program … verify`              | 缓冲 `execFile` 输出，未传 `--verify`               | 侧栏差距              | probe-rs F5/DAP 另有进度事件和 `verifyAfterFlashing` 配置                |
|                          | 侧栏烧录后复位运行            | 同一连接执行下载、校验和复位              | download/reset 两个子进程                           | 实现差异              | 同一连接不是失败可回滚的原子事务                                         |
|                          | 侧栏烧录后符号刷新与采样恢复  | 成功刷新后按原采样意图恢复                | 当前没有相同步骤                                    | 接入差距              | probe-rs 自动采样会话停止后需重新启动                                    |
|                          | Agent Flash 烧录与独立校验    | 支持指纹、快照和授权流程                  | `BACKEND_UNSUPPORTED`                               | 显式限制              | 变量读写 Agent 接口不受此 Flash 限制                                     |
| **调试会话与执行控制**   | 适配器通信                    | Node DAP → GDB/MI → OpenOCD               | Inline DAP → stdio → dap-server                     | 已接入                | probe-rs 不依赖 GDB；DAP 消息不是 JSON-RPC 2.0                           |
|                          | Attach 现有固件               | 支持，不烧录，初始化可能 halt             | 支持，不烧录，默认不复位，初始化短暂 halt           | 已接入                | 不能称为严格无扰动或“无感”接入                                           |
|                          | 暂停、继续、单步              | 支持                                      | 支持                                                | 已接入                | 按各调试器能力执行                                                       |
|                          | 源码/指令硬件断点             | 支持                                      | 支持                                                | 已接入                | 资源数量和行为受核心及上游实现限制                                       |
|                          | DAP 函数断点                  | 支持                                      | 0.32 未支持                                         | 缺失                  | 上游未声明 `supportsFunctionBreakpoints`，也无对应请求处理               |
|                          | 观察点/数据断点               | 可经 GDB 控制台配置                       | 0.32 DAP 未支持                                     | 接入差距              | 不代表 probe-rs 库所有接口均无相关底层能力                               |
|                          | 连接与复位策略                | Target 脚本及调试配置                     | F5 可透传上游字段；侧栏选项不完整                   | 部分接入              | 可传 `connectUnderReset`、`wireProtocol`、`haltAfterReset` 等            |
|                          | GDB 命令钩子                  | 六组 Pre/Post 钩子                        | 未提供对应机制                                      | 接入差距              | 不能把 VS Code 通用构建任务与底层 GDB 钩子混为一谈                       |
|                          | RTOS 任务感知                 | 允许 12 个具名 RTOS，另有 `auto`/`none`   | 0.32 DAP 未解析 RTOS 任务                           | 接入差距              | 允许列表不含 RT-Thread；内核版本与符号条件仍需验证                       |
|                          | FreeRTOS 任务诊断面板         | 原生 `emberprobe` 调试器支持              | 未接入                                              | 接入差距              | 面板按会话类型限制，不是由 `isRtosSession()` 对 probe-rs 恒返回 false    |
|                          | 多核共享组                    | `serverGroup`，实验性                     | 未实现同等协同                                      | 接入差距              | OpenOCD 双核实板验收未完成；probe-rs 保留多 core 配置但请求仍选首项      |
|                          | 探针租约与退出确认            | 已接入 coordinator                        | 已接入，进程退出后释放                              | 已接入                | 启动、退出未确认和竞争访问仍可能被拒绝                                   |
| **LiveWatch 与变量读写** | 运行中固定地址 RAM 采样       | Tcl-RPC 轮询                              | DAP `readMemory`                                    | 已接入                | probe-rs 0.32 在核心休眠时可能短暂 halt/resume                           |
|                          | 实际采样率与延迟              | 缺少本次同条件对照                        | 历史记录：F407 约 2.26 Hz；H723 约 7.23 Hz          | 待对照测量            | 不同板卡/探针/平台的数据不能归纳为统一性能，也未证实 JSON/Base64 是瓶颈  |
|                          | 运行中读取区间守卫            | 过滤不符合 ELF 区间的项并提示             | 任一不符合项严格拒绝                                | 策略差异              | 按 `SHF_WRITE \| SHF_ALLOC` section；不是硬件内存图的独立认证            |
|                          | 运行中标量写回                | 独立 LiveWatch 支持；受管理调试运行态禁用 | 运行中 DAP 支持限定标量                             | probe-rs 调试集成优势 | 休眠状态可能短暂 halt；有写前读取、身份约束和回读校验                    |
|                          | 运行中写入宽度与原子性        | 32 位对齐，必要时预读补齐                 | 自然对齐的 8/16/32 位标量                           | 实现差异              | probe-rs 0.32 DAP 走 8 位传输，多字节写入不具备总线原子性                |
|                          | Rust static/Atomic 解析       | 使用共用 ELF/DWARF 服务                   | 使用同一服务                                        | 共用能力              | 解包要求类型名与存储宽度匹配，不能称为 probe-rs 独占或完整支持           |
|                          | 64 位 Atomic 运行中写回       | 不由共用解包能力保证                      | 被 1/2/4 字节限制拒绝                               | 有限支持              | 类型识别、读取和写入是不同能力；直接写存储也不是 Rust 原子操作           |
|                          | LiveWatch 局部/async 任务变量 | 未接入动态栈寻址                          | 未接入动态栈寻址                                    | 当前范围外            | 此限制不适用于停机调试器中的一般局部变量查看                             |
|                          | SVD 停机读写                  | 共用 SVD 服务                             | 共用 SVD 服务                                       | 已接入                | 访问权限、副作用、传输宽度和具体寄存器行为仍需验证                       |
|                          | SVD 运行中读写                | 暂停状态门禁                              | 暂停状态门禁                                        | 共同限制              | `TARGET_NOT_PAUSED` 是保护策略，不是上游硬件能力判定                     |
| **诊断、驱动与配置**     | Cortex-M CPUID                | 支持                                      | 支持                                                | 已接入                | 读取 `0xe000ed00`，不应推广到所有架构                                    |
|                          | IDCODE、Flash 容量、UID       | 一批 STM32 系列地址表及受限兜底           | 当前仅 STM32H7 名称分支补充读取                     | 接入差距              | OpenOCD 非全家族保证；APM32F4 的 UID/Flash 地址读取仍禁用                |
|                          | CoreSight ROM 厂商线索        | JEP106 解码                               | 芯片信息服务未接入                                  | 接入差距              | 厂商指纹不是可靠的芯片真伪鉴定                                           |
|                          | 芯片面板电压及 PC/SP/LR       | 探针提供信息时解析；停机读取寄存器        | 面板未接入                                          | 接入差距              | 不等于 probe-rs 库或 DAP 无寄存器读取能力                                |
|                          | 芯片面板 Pause/Run/Reset      | 支持，受占用限制                          | `controlsAvailable: false`                          | 面板差距              | probe-rs 仍可使用调试器的执行控制                                        |
|                          | 调试期间刷新芯片信息          | 独占操作，通常拒绝占用                    | 可复用选定 DAP 会话                                 | probe-rs 集成优势     | 重复读取、会话/状态变化和其他冲突仍被拒绝                                |
|                          | Agent Fault 自动分析          | 支持 Cortex-M 故障寄存器解码              | `BACKEND_UNSUPPORTED`                               | 显式限制              | 不代表所有手动寄存器读取或上游异常调试均不可用                           |
|                          | CPU 负载率监测                | 现有服务使用 OpenOCD                      | 未实现 probe-rs 执行路径                            | 接入差距              | 监测仍为独占探针的实验性功能                                             |
|                          | 内置 RTT/defmt 日志输出       | 扩展未集成对应输出                        | DAP 事件 → OutputChannel                            | probe-rs 集成优势     | 这里比较 EmberProbe 接入，不是宣称 OpenOCD 上游没有 RTT                  |
|                          | RTT 交互下行与侧栏终端        | 未集成                                    | 仅只读 OutputChannel                                | 接入不足              | 不能向 MCU 下发交互输入；依赖活动 dap-server 会话                        |
|                          | Windows J-Link 驱动助手       | 有主动切换入口                            | 当前隐藏入口                                        | 接入差距              | 需独占和管理员授权，具体型号与官方工具兼容性仍有条件                     |
|                          | USB 探针候选列表              | USB inventory 与脚本匹配                  | 未接入候选列表                                      | UI 差距               | `probeRsProbe` 可留空自动选择唯一可用探针，不是必须手填                  |
|                          | MCU 目标选择与自动匹配        | 匹配目标脚本                              | 读取本机 `chip list` 并匹配项目线索                 | 已接入                | probe-rs 支持目标搜索及 .ioc/Cargo/构建文件线索                          |
|                          | 扩展内自动安装                | 可下载 OpenOCD 预编译包                   | `canInstall: false`                                 | 接入差距              | probe-rs 可外部使用官方安装脚本、包管理器或 cargo，并非必须源码编译      |

---

## 二、核心维度技术分析

### 1. 固件烧录、擦除与 Agent 接口

#### 区分侧栏下载、F5 镜像加载和上游 CLI

- **侧栏独立下载**：两个后端均经 `inspectElf()` 校验 ELF32 little-endian，并创建烧录快照。HEX/BIN 会被该入口拒绝。
- **OpenOCD F5**：`debugImages.js` 的 `loadFiles` 支持 ELF、Intel HEX 和 BIN。BIN 要求显式 `address`，ELF/HEX 可设置 `offset`；该能力不能归为侧栏下载支持。
- **probe-rs F5**：`resolveProbeRsDebugConfiguration()` 检查文件存在且为普通文件，不调用 `inspectElf()`；它保留 `flashingConfig.formatOptions`。但上游还会以 `programBinary` 加载调试信息，仅能透传格式字段不等于已经集成并验收纯 HEX/BIN 烧录调试。
- **probe-rs CLI**：0.32 本身支持 `--binary-format`、BIN 的 `--base-address`/`--skip` 等。当前侧栏没有封装这些参数。不能将入口缺失描述为工具本身无法处理这些格式。

上游格式与调试配置见 [官方调试器文档](https://probe.rs/docs/tools/debugger/)；调试信息加载约束见 [v0.32.0 session_data.rs](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/session_data.rs)。本机 `probe-rs download --help` 已核对。

#### Agent Flash 仍显式拒绝 probe-rs

`agentFlashService.js` 在读取配置后拒绝 probe-rs：

```javascript
const configured = this.getConfig();
if (configured.backend === "probe-rs")
    throw Object.assign(new Error("Use the EmberProbe Download button for probe-rs flashing"), {
        code: "BACKEND_UNSUPPORTED"
    });
```

现有 Flash 烧录、独立校验及授权流水线仍使用 OpenOCD 参数和 Tcl 命令。Agent 变量读取与写入可以复用 probe-rs LiveWatch/DAP；不能把 Flash 限制扩大为所有 Agent 功能不可用。

#### 擦除、进度、校验、复位与状态恢复

- **侧栏 OpenOCD**：同一连接执行 `program $file verify reset exit`，提供流式进度。成功烧录后刷新 ELF 绑定，刷新成功且原先有采样意图时恢复采样。同一连接完成不等于操作失败时可回滚。
- **侧栏 probe-rs**：用缓冲的 `execFile` 运行 `download`，随后另起 `reset`，产生两次探针连接。当前没有传 `--verify`、`--preverify` 或 `--chip-erase`，也没有侧栏流式阶段解析、烧录后 ELF 刷新和采样恢复。
- **F5 probe-rs**：DAP 烧录会发出进度事件，可通过 `flashingConfig.verifyAfterFlashing` 启用写后校验、`fullChipErase` 选择全片擦除。此路径与侧栏 download 不同。
- **擦除语义**：两个后端均没有独立全片擦除按钮。probe-rs 的双缓冲用于编程数据传输；跳过已一致内容由预校验选项控制，不能称为默认“双缓冲增量擦除”。

DAP 进度、校验和擦除实现见 [v0.32.0 debugger.rs 的 flash()](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/debugger.rs)。

### 2. 调试会话、执行控制、RTOS 与多核

#### 通信与断点能力

OpenOCD 路径由 Node 调试适配器通过 GDB/MI 控制 GDB，再连接 OpenOCD 的 GDB RSP 服务。GDB 端口受配置和共享组分配影响，不应固定描述为 3333。

probe-rs 使用 `DebugAdapterInlineImplementation`，启动 `probe-rs dap-server`，通过 stdio 转发带 Content-Length 分帧的 DAP JSON 消息。DAP 使用自己的请求、响应和事件结构，不是 JSON-RPC 2.0。

两者已接入暂停、继续、单步和源码/指令断点。probe-rs 0.32 初始化能力中的 `supports_function_breakpoints` 被注释，请求分发也没有 `setFunctionBreakpoints`；不能由“硬件断点支持”推导“DAP 函数断点支持”。该版本 DAP 也未接入数据断点。上游证据见 [v0.32.0 debugger.rs](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/debugger.rs)。

#### Attach 和连接策略

默认 Attach 不烧录现有固件；probe-rs 初始化会短暂暂停核心并恢复，因此不能称为严格无扰动接入。用户主动配置的连接/复位策略还可能改变目标行为。

probe-rs 配置器通过 `...config` 保留顶层字段，并保留 `flashingConfig`。F5 可以传 `connectUnderReset`、`wireProtocol`、`haltAfterReset` 等上游支持的选项；当前侧栏缺少对应控件、独立下载缺少参数封装是另一层限制。OpenOCD 仍有 Target 脚本和六组 GDB Pre/Post 命令钩子，probe-rs 没有接入对应的 GDB 钩子机制。

#### RTOS 任务与诊断面板

OpenOCD 配置允许以下 12 个具名 RTOS：

`FreeRTOS`、`ThreadX`、`chibios`、`Chromium-EC`、`eCos`、`embKernel`、`linux`、`mqx`、`nuttx`、`RIOT`、`uCOS-III`、`Zephyr`。

另有 `auto` 和 `none`；它们不是额外的 RTOS 种类，列表不含 RT-Thread。任务识别仍依赖内核版本、目标支持及 ELF 符号，不能由配置允许列表推出所有项目均能正确显示任务。详见 [RTOS 感知说明](RTOS-AWARENESS.md) 和 [openocd-launch.js](../skills/_emberprobe/openocd-launch.js)。

probe-rs 0.32 的 DAP `threads()` 以当前物理核心作为线程，没有实现 RTOS TCB/任务链表解析。[上游实现](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/debug_adapter/dap/adapter.rs)

EmberProbe 的 `isRtosSession()` 只检查配置里的 `rtos` 字符串，没有针对 probe-rs 恒返回 false 的分支。FreeRTOS 诊断面板真正由 [rtosViewService.js](../src/services/rtosViewService.js) 限制为原生 `emberprobe` 会话。CPU 负载率监测的执行路径则仍创建独立 OpenOCD 连接。

#### 多核、并发与租约

- **OpenOCD**：`serverGroup` 允许同一个服务进程分配多核 GDB 端口和成员会话；功能仍为实验性，已有软件回归，双核实板验收尚未完成。首成员可以 Launch 或 Attach，后续成员按共享组规则加入。详见 [共享调试组说明](SHARED-DEBUG-GROUPS.md)。
- **probe-rs**：扩展配置器会复制并保留整个 `coreConfigs` 数组，主要程序路径和 RTT 便捷字段补入首项，不是把数组截成单核。实际限制包括扩展拒绝其他并发调试会话，以及上游 0.32 DAP 请求处理仍选择首个 core config。多个配置项被保留不代表完整多核调试已实现。
- **进程租约**：`ProbeRsDebugAdapter` 启动子进程前取得 `debugStart`，Launch/Attach 成功后转为 `debugServer`。收到 DAP `terminated` 不提前释放，确认子进程退出后才释放；退出未确认时保留租约。自动 LiveWatch 替换为手动调试会话时，也会等待旧连接退出。

上述租约机制减少连接争用；既有 F407 记录显示修正退出等待后快速重连通过，但不能保证消除所有 J-Link/USB 重连失败。

### 3. LiveWatch、变量写回与 SVD

#### 运行中读取和实际性能

OpenOCD LiveWatch 使用 Tcl-RPC 内存读取；probe-rs 使用 DAP `readMemory`，没有额外 Tcl 端口。未启动调试时，probe-rs 可自动创建 `__emberprobeWatchOnly` Attach 会话。

probe-rs 0.32 的 `handle_request()` 在核心处于 `CoreStatus::Sleeping` 时，会为 `readMemory`、`writeMemory` 等请求先 `halt()`，完成后 `run()`。因此通常不要求用户手动暂停，但不能承诺核心绝不暂停或休眠行为完全不受影响。[上游请求处理](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/debugger.rs)

既有观测：

| 环境                                                                   | 请求周期/频率 | 记录的观测值                    | 验证范围                              |
| :--------------------------------------------------------------------- | :------------ | :------------------------------ | :------------------------------------ |
| Windows、Geehy APM32F407ZG、J-Link；probe-rs 使用 STM32F407ZG 连接模型 | 100 ms        | 约 2.26 Hz，p95 读取耗时 331 ms | 短窗口 Attach、RAM 读取及拒绝路径验收 |
| Linux、STM32H723VG、CMSIS-DAP、Embassy 测试程序                        | 10 Hz         | 最终观测窗口约 7.23 Hz          | 全局 RAM 观测、曲线及限定标量写回验收 |

来源：[F407 验收记录](PROBE-RS-AUDIT-VALIDATION-2026-10-09.md)、[MC02 验收记录](MC02-PROBE-RS-VALIDATION.md)。F407 实际芯片不是原厂 STM32F407；该连接模型的读取结果也不能证明其 Flash 算法适用于 APM32。

以上缺少同板卡、同探针、同固件、同观察列表的 OpenOCD 对照，不能据此判定后端统一吞吐量，更不能承诺 OpenOCD 稳定达到 10~100 Hz+。尚无分层计时证据证明 JSON/Base64 是瓶颈；状态轮询、休眠时 halt/resume、硬件访问及调度都需要分别测量。数字在本次仅与历史验收文档核对，原始 F407 JSON 未找到，未重新计算。

#### ELF 区间守卫和外设副作用

共用 `filterRuntimeRamPlan()` 按 ELF section 的 `SHF_WRITE | SHF_ALLOC` 属性与完整地址范围筛选读取项。OpenOCD 运行中采样可过滤被拒绝项并提示；probe-rs 的严格计划会在任一项不符合时返回 `LIVE_ADDRESS_NOT_RAM`。

该规则保护按正常 ELF 布局选取的 RAM 全局量，但 ELF 声明的可写区间不是经过硬件内存图独立确认的 RAM。不能保证任意 ELF 声明的区间均无外设副作用。

限制不受控 MMIO 读取可避免读清零和 FIFO 弹出等副作用。术语应区分：

- `rc_w0`/`rc_w1`：可读取，写 0/写 1 清除。
- `rc_r` 或 SVD `readAction: clear`：读取本身清除。

见 [ST 寄存器缩写表](https://www.st.com/resource/en/reference_manual/rm0031-.pdf) 和 [CMSIS-SVD 寄存器语义](https://open-cmsis-pack.github.io/svd-spec/main/elem_registers.html)。

#### 运行中写回的范围和风险

OpenOCD 独立 LiveWatch 支持变量写回，但受管理 GDB 调试运行态禁用运行中写入。probe-rs DAP 允许运行中写入自然对齐的 1/2/4 字节标量，并执行可靠类型、ELF 区间、镜像/会话身份、写前读取和回读校验等约束。

`targetHaltedDuringWrite: false` 是 EmberProbe 根据 Bridge 状态生成的字段，不能证明上游未短暂 halt；休眠例外同样适用于写入。

- **多字节非原子性**：0.32 DAP 写回进入 `core.write_8()`，ARM ADI 实现选择 8 位总线传输。多字节值可能出现撕裂；邻近字节可以批量传输，并不代表每字节都单独往返一次 DAP。自然对齐和回读校验不能赋予其总线原子性。[core_data.rs](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/core_data.rs)、[ADI write_8()](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs/src/architecture/arm/memory/adi_memory_interface.rs)
- **缓存与固件竞争**：启用 Cortex-M7 D-Cache 时，调试口 RAM 值可能不同于核心缓存值；固件并发读写还可能读到中间值或使回读不一致。已有 H723 验收使用关闭 D-Cache 的测试程序，不能推广到缓存开启的所有项目。
- **邻近数据**：OpenOCD 的非对齐小宽度写入可能预读并补齐为 32 位访问；这也不能证明任意变量组合或整个写入事务具有原子性。

#### 共用类型解析及变量范围

C/C++ 标量、枚举、结构体叶子和 Rust 固定地址 static 都使用共用 ELF/DWARF 服务，实际能力受符号保留、类型可靠性和解析预算约束。Rust 符号通过 `DW_AT_linkage_name` 等信息绑定，不应描述为“完美映射”或 OpenOCD 完全不支持 Rust。

`types.js` 对类型名匹配且存储宽度一致的 `Atomic<u8|i8|u16|i16|u32|i32|u64|i64|bool>` 自动解包。识别 64 位类型不代表 probe-rs 运行中可写 64 位值；运行中写入仍仅接受 1/2/4 字节。直接写入 Atomic 存储也不具备 Rust 原子操作及内存序语义。

LiveWatch 当前围绕固定地址全局量，不解析动态栈寻址的函数局部量或 Embassy async 任务内部状态。该限制不能推广到整个调试器：两个 DAP 调试路径都有停机后的作用域/局部变量查看能力，Embassy 任务状态则没有专门的任务级接入。

#### SVD 外设读写

两者在暂停状态下使用共用 SVD 服务浏览寄存器、展开位域和执行受约束写入；运行中访问被 `TARGET_NOT_PAUSED` 拒绝。

共用服务不代表所有硬件访问等价。尤其 probe-rs 0.32 DAP 写入采用 8 位传输，具体 MMIO 寄存器的宽度要求和副作用仍需核对；不能仅由软件路径存在就承诺全部寄存器读写“完全对齐”。

### 4. 芯片诊断、Fault、RTT、驱动与配置

#### Agent Fault 分析

`_readAgentFault()` 在选择 probe-rs 时返回 `BACKEND_UNSUPPORTED`。EmberProbe 的 SCB 故障寄存器自动解码及相关符号分析尚未接入 probe-rs。这是当前 Agent Fault 服务的限制，不等于上游 DAP 不具备所有寄存器读取或异常调试能力。

#### 芯片信息读取

- **身份地址覆盖**：OpenOCD 地址表覆盖一批 STM32 系列，不是全家族/全型号保证。例如 Flash 容量表没有 L1，未知目标的扫描兜底受停机状态限制。APM32F4 当前只明确提供 IDCODE 地址，UID/Flash 容量地址读取仍禁用，等待地址验证。
- **probe-rs 补充字段**：通用 Cortex-M CPUID 之外，仅在配置 chip 名以 `STM32H7` 开头时读取额外 IDCODE、Flash 容量和 UID；其他系列没有这套补充字段。共用 H7 地址不能代表全部 H7 子型号已逐一验证。
- **厂商线索**：OpenOCD 读取 CoreSight ROM 信息并进行 JEP106 解码；probe-rs 的芯片信息服务尚未接入。厂商指纹提供识别线索，不能视为可靠真伪鉴定。
- **探针与寄存器面板**：OpenOCD 在探针输出相关信息时解析电压、固件等，并可在停机状态读 PC/SP/LR；probe-rs 面板使用 `probeName: "probe-rs"`，没有同样的字段读取和面板控制。此处限制不能推广为上游库/DAP 不会读寄存器。
- **连接复用**：OpenOCD 芯片读取走独占流程，调试/采样占用时拒绝；probe-rs 可复用选定活动 DAP 会话。重复芯片读取、能力未就绪、执行状态变化、会话切换和其他冲突仍受检查，不能称为无限制“随时并发”。

#### RTT/defmt 输出

probe-rs 路径接收 `probe-rs-rtt-channel-config` 和 `probe-rs-rtt-data`，创建只读 OutputChannel 输出日志，defmt 解码由上游承担。当前没有交互下行或侧栏终端集成，输出依赖活动 dap-server 会话。

OpenOCD 路径没有集成同样的 EmberProbe RTT 输出入口；这不是对 OpenOCD 上游 RTT 能力的否定。

#### Windows J-Link 驱动助手

当前 probe-rs 模式隐藏 EmberProbe 的 J-Link 驱动选择器。probe-rs 官方说明 Windows J-Link 需要通用 WinUSB，优先推荐 J-Link Configurator；选项不可用时可使用 Zadig。不同探针的要求不同，不能将此概括为所有 probe-rs 探针都需手动替换驱动。[官方探针设置](https://probe.rs/docs/getting-started/probe-setup/)

OpenOCD 模式提供驱动检测和主动切换入口，但需要独占探针与管理员授权，具体 J-Link 型号及 SEGGER 工具兼容性仍有条件，不能承诺“一键无缝”。详见 [J-Link 兼容性说明](JLINK-COMPATIBILITY.md)。

#### 自动配置与安装

- **探针**：probe-rs 自动检测未返回 USB 候选列表；`probeRsProbe` 仍是可选项，留空时由 CLI 自动选择唯一可用探针。多探针环境需指定选择器。
- **MCU**：侧栏读取本机 `probe-rs chip list` 提供搜索列表，并从 .ioc、CMake/链接脚本、Cargo 配置和 launch.json 匹配目标。不能将整个自动配置体系描述为只能手填。
- **安装**：扩展的 probe-rs 状态服务固定 `canInstall: false`，需要在外部安装或选择已有可执行文件。官方提供安装脚本、包管理器、cargo binstall 和源码编译等方式，cargo 编译不是唯一渠道。[官方安装说明](https://probe.rs/docs/getting-started/installation/)
- **调试配置**：`emberprobe` 与 `emberprobe-probe-rs` 的后端专用字段不同，完整配置需按后端调整；executable、request、name 等通用概念仍有对应关系，不应称为所有字段互不兼容。

---

## 三、使用范围与后续建议

### 当前使用范围

probe-rs 已接入的主要路径包括：

1. Rust/C/C++ 源码级断点、单步和 Attach 调试，受上游 DAP 能力及符号条件限制。
2. 运行中固定地址 RAM 观测，以及对齐的 8/16/32 位标量调参；需要接受休眠时短暂暂停、非原子多字节传输及缓存/并发限制。
3. RTT/defmt 日志输出。
4. 基于本机芯片列表的 MCU 选择与项目线索匹配。

目前仍由 OpenOCD 路径提供的 EmberProbe 功能包括：

1. 经现有 Agent Flash 授权流水线执行的烧录和独立校验。
2. Agent Fault 故障寄存器自动分析。
3. RTOS 任务感知、原生 FreeRTOS 诊断面板和现有 CPU 负载率监测。
4. F5 的 HEX/BIN `loadFiles`、多镜像加载及 GDB 命令钩子。
5. 实验性 `serverGroup` 多会话协同；双核实板支持仍待验收。
6. 地址表覆盖范围内的芯片详细身份读取、CoreSight 厂商线索和 Windows J-Link 驱动助手。

Rust static/Atomic 解析可由两个后端共用；标准 `connectUnderReset` 等 F5 配置也不是必须切换 OpenOCD 的理由。

### 后续演进建议

1. **适配 Agent Flash 执行器**：将 probe-rs 烧录与校验纳入既有镜像指纹、快照、连接身份和授权流程，不能只删除后端拒绝分支。
2. **补齐侧栏下载功能**：增加经过验证的格式/基地址、校验、连接策略和进度处理，以及成功下载后的符号刷新和采样恢复。
3. **接入驱动诊断与选择**：probe-rs 模式复用 J-Link inventory 和驱动助手，保留主动授权、独占租约及退出确认。
4. **扩展芯片身份读取**：复用经验证的型号地址与读取预算，为主流非 H7 型号补充字段；未知地址和型号继续保持限制。
5. **适配 Fault 分析**：复用会话绑定、暂停/状态检查和读取预算，通过 DAP 读取 Cortex-M SCB 数据并接入现有解码。
6. **补充对照验收**：同条件测量两后端的读取、调度、休眠和 RTT 开销，并单独验证多核、缓存开启和 MMIO 写入宽度。

## 四、本次复核验证

八个现有无硬件测试文件均通过：

```text
node test/rust-probe-rs.test.js
node test/probe-rs-safety.test.js
node test/probe-rs-debug-adapter.test.js
node test/probe-rs-chip-info.test.js
node test/probe-rs-configuration.test.js
node test/probe-rs-targets.test.js
node test/backend-routing.test.js
node test/debug-images.test.js
```

额外无硬件断言确认配置器保留多个 core config、`connectUnderReset`、`fullChipErase`、`verifyAfterFlashing` 和格式对象，且配置器本身只验证普通文件而非 ELF 内容；确认 `isRtosSession()` 不按 probe-rs 后端恒返回 false。

这些检查验证当前软件路径，不建立新的实板支持。历史实机记录按各自环境和验收范围引用；本次未进行烧录、复位、驱动切换或硬件复测。
