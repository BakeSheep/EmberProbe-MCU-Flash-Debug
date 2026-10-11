# probe-rs 与 Embassy 使用说明

MC02 的独立 Embassy 仓库、自动 LiveWatch 和整数/浮点调参验收步骤见 [MC02 回归测试](MC02-REGRESSION.md)。

## Embassy / Rust 与 probe-rs

EmberProbe 可以用 probe-rs 调试 Cortex-M 上的 Rust 程序，并在同一个调试会话中读取运行中的全局变量、绘制波形和写入可调标量。在侧栏“调试后端”选择 `probe-rs`，扩展会检测命令行工具；未安装时，环境卡片提供“选择路径”和“一键安装”。安装或配置支持 `dap-server` 的 probe-rs 后，再选择探针和芯片。侧栏只检测当前后端的环境；probe-rs 模式不需要安装 OpenOCD。也可在 VS Code 工作区设置中配置：

```json
{
    "emberprobe.backend": "probe-rs",
    "emberprobe.probeRsPath": "probe-rs",
    "emberprobe.probeRsChip": "STM32H723VG",
    "emberprobe.sampleFrequencyHz": 10
}
```

## 环境检测与安装

扩展先检查 PATH，再检查用户 Cargo 安装目录（`CARGO_HOME/bin` 或 `~/.cargo/bin`）。显式填写的 `emberprobe.probeRsPath` 优先，不会自动改用其他程序。命令面板也提供“EmberProbe: 检查 probe-rs 环境”。缺少或无法运行的工具会显示环境卡片；启动调试、LiveWatch 或下载前再次检查，缺失时打开侧栏，不启动探针进程。

“选择路径”打开可执行文件选择框，只有通过 `probe-rs --version` 验证的程序才会保存。“一键安装”按平台执行 [probe-rs 官方安装文档](https://probe.rs/docs/getting-started/installation/) 的指令，下载当前官方发布的工具：

Windows：

```powershell
irm https://github.com/probe-rs/probe-rs/releases/latest/download/probe-rs-tools-installer.ps1 | iex
```

Linux / macOS：

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/probe-rs/probe-rs/releases/latest/download/probe-rs-tools-installer.sh | sh
```

Windows 使用非交互 PowerShell；Linux/macOS 使用 Bash 的 `pipefail` 执行官方管道，下载失败也会报错。通知和环境卡片显示持续进度条及安装输出，安装结束后验证程序并保存路径。官方脚本没有提供完整下载总量，因此进度条不显示估算百分比。整个安装有 10 分钟超时。失败后可重试或选择已有路径；安装期间重复点击不会重复执行，后台检测也不会覆盖安装状态。安装期间若路径设置发生变化，保留新的设置。

官方脚本会安装到用户 Cargo 目录并按其规则更新 PATH；设置了 `PROBE_RS_TOOLS_INSTALL_DIR` 或 `CARGO_DIST_FORCE_INSTALL_DIR` 时，也会检查对应的 `bin` 目录。扩展直接检测安装位置并保存验证通过的路径，当前 VS Code 进程无需重启以刷新 PATH。VSIX 不包含 probe-rs 可执行文件或安装包；一键安装需要访问官方 GitHub 下载地址。

## 固件、目标与调试

上面的芯片名适用于 STM32H723VGT6；其他芯片请以 `probe-rs chip list` 的名称为准。多探针环境可另设 `emberprobe.probeRsProbe` 为 `VID:PID:Serial`。选择固件时，EmberProbe 会查找 Cargo 默认 `target/<triple>/debug` 和 `release` 目录内的无扩展名 ARM ELF；也可点“Browse for ELF”手选。固件必须包含未剥离的 ELF 符号和 DWARF 类型信息。点击侧栏“启动”会以 probe-rs `attach` 连接现有固件；“启动调试”会使用 probe-rs 烧录并开启断点调试。下载按钮在同一连接内烧录、写后校验并复位，成功后刷新变量和内存信息，按原意图恢复采样；F5 Launch 默认启用写后校验。门禁、失败诊断及验证范围见 [烧录行为说明](PROBE-RS-FLASH.md)。

源码中可用 F9 或行号旁的边栏设置普通硬件断点，暂停后使用 VS Code 调试工具栏单步、查看调用栈与局部变量。probe-rs 0.32 DAP 尚未支持函数断点、条件断点、命中次数断点、日志点或数据断点。Agent 按选定会话的实际 DAP 能力拒绝不支持的断点请求；详细入口、测试范围和独立真机验收见 [断点调试说明](PROBE-RS-BREAKPOINTS.md)。

侧栏“MCU 目标”会读取当前配置的 probe-rs 可执行文件的内置目标列表，支持搜索芯片名称和系列；选择后保存到工作区的 `emberprobe.probeRsChip`。目标列表随本机 probe-rs 版本更新，无需维护另一份预设。列表读取失败时会提示检查 probe-rs 路径和安装，保留已有芯片配置；也可直接在工作区设置中填写芯片名称。

点击“自动检测配置”会同时配置 ELF 和 MCU 目标。若已选择 `.ioc`，以该文件的芯片信息为准；否则从工作区 `.ioc`、CMake/链接脚本、`.cargo/config.toml`（或 `.cargo/config`）和 `.vscode/launch.json` 中查找线索，并与本机目标列表匹配。支持将 STM32 完整料号的封装和温度后缀匹配到对应目标，例如 `STM32H723VGT6` 对应 `STM32H723VG`。存在多个候选，或尚未设置目标且没有匹配结果时，会打开目标选择列表；无匹配线索时保留已有的有效目标。后台自动检测只填充缺失配置，不弹出目标选择框。取消选择保留原 MCU 设置；活动探针会话期间不能修改目标。

也可以使用 `launch.json`：

```json
{
    "type": "emberprobe-probe-rs",
    "request": "launch",
    "name": "EmberProbe: Rust",
    "chip": "STM32H723VG",
    "executable": "${workspaceFolder}/target/thumbv7em-none-eabihf/debug/firmware",
    "rttEnabled": true,
    "rttChannelFormats": [{ "channelNumber": 0, "dataFormat": "Defmt" }]
}
```

`attach` 不烧录或复位固件；probe-rs DAP 在连接初始化时会短暂暂停核心，完成配置后再继续运行。后续运行中采样直接读 RAM。RTT 数据会显示在 `EmberProbe RTT` 输出通道。LiveWatch 第一阶段支持固定 RAM 地址的 Rust 全局 `static`，包括 `Atomic<u32>` 等存储宽度明确的标量；不解析 async 任务局部变量。使用当前 Rust 编译器的 `DW_AT_linkage_name` 关联 Rust 符号与 DWARF 类型。运行中写入限定对齐的 8/16/32 位标量，并要求 ELF 可写 RAM 段、可靠类型和回读校验；probe-rs 0.32 的 DAP `writeMemory` 实际按字节传输，多字节写入不能视为原子操作，固件若同时读取或改写该地址，可能读到中间值或导致回读不同。STM32H7 开启 D-Cache 时，调试口读到的 RAM 也可能不同于核心缓存中的值，建议先在关闭缓存或非缓存区验证观测量。

### 实时采样频率

侧栏频率设置支持 0.1–200 Hz。probe-rs 按每轮开始时间计算周期，读取和样本分发耗时包含在该周期内。例如设定 20 Hz（50 ms）、每次读取耗时 25 ms，修正后的软件调度每轮约 50 ms；旧实现每轮约 75 ms，实际只有约 13.3 Hz。读取超过设定周期时，完成后再开始下一轮，不积压补采请求；面板显示实际频率及读取耗时。

附近变量会合并为一次 DAP `readMemory`，包含至多 64 字节的间隙；合并区间必须完全位于同一 ELF 可写、已分配 RAM 段。无法合并的运行期区间以最多 4 个请求为一组发送，减少逐项等待带来的后端空闲休眠；停止或状态变化后不发送下一组，失败时收完本组已发送的响应再退出。每轮读取仍受 4096 字节和请求数量预算限制，间隙也计入字节预算；没有预算余量时使用精确区间。暂停快照保持原有读取行为，运行中写入仍只写授权标量并逐项回读。

Windows 运行期采样复用扩展已有的高精度定时器，减少普通定时器约 15.6 ms 粒度带来的周期延长；停止、暂停、会话变化、无变量和重试耗尽时释放。原生定时器不可用时继续采样，实际频率可能较低。

实际频率取决于探针、SWD 速度、变量地址分布、目标运行状态和上游 DAP；即使设置 200 Hz，也不保证达到 OpenOCD 的采样频率，上游限制见下节。当前优化复用已有连接，不新增探针连接或后台预读。

自动化回归覆盖 25 ms 模拟读取下的 20 Hz 调度、1 ms 模拟读取下的 200 Hz 调度、跨 RAM 段隔离、字节预算、失败重试和状态变化取消。Extension Host 使用有 25 ms 延迟的模拟 DAP 进程检查实际 IPC 链路。这些软件结果不代表实板频率；真机验证需记录实际频率、读取耗时、探针和变量数量。

### 原版 probe-rs 的频率上限

EmberProbe 使用用户安装的原版 probe-rs，不提供修改过的采样后端。probe-rs 0.32 的 [DAP 请求循环](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/debugger.rs) 有以下固定开销，扩展侧调度无法消除：

- 目标运行且没有待处理请求时休眠 50 ms，新请求不能打断这次休眠。
- 每个请求处理前都轮询一次核心状态，并重新创建核心访问对象、重读 AP 寄存器。J-Link 在 probe-rs 中按原始 SWD 访问，每次寄存器读写都是一次独立的 USB 往返。
- `readMemory` 先把请求长度减半再分块，4 字节变量会拆成 2+1+1 字节，对同一个 32 位字读 3 次。目标在两次读取之间更新变量时，可能读到从未出现过的拼接值。

此前在 J-Link / F407_car 上使用原版 probe-rs 0.32、设定 100 Hz，监视两个相距 324 字节的 4 字节 RAM 变量时，实测约 6.4 Hz，每轮读取 P95 约 155 ms。上游 master 已合并探针层的 [批量内存访问](https://github.com/probe-rs/probe-rs/pull/4345) 等改动，可减少每次访问的 USB 包数；截至 2026-10-11 尚未发布，DAP 层的空闲休眠、逐请求轮询和分块读取也没有改变。C 固件需要高频采样时，建议使用 OpenOCD 后端；probe-rs 后端更适合 Rust/Embassy 调试和低频观测。

Agent Bridge 的变量读取与写入可复用活动的 probe-rs LiveWatch/DAP 会话。Agent Flash 与故障寄存器分析仍限于 OpenOCD；probe-rs 烧录请使用侧栏“烧录”按钮。

独立的 STM32H723 Embassy 真机测试程序与复测步骤见 [HIL smoke app](../test/hil/fixtures/embassy-h723/README.md)。
probe-rs 模式下“读取芯片信息”与 OpenOCD 复用项目的已知芯片地址表：Cortex-M CPUID、核心版本、CoreSight ROM / JEP106 厂商线索，以及 STM32 F0/F1/F2/F3/F4/F7、G0/G4、H7、L0/L1/L4、WB/WL 的 Device ID、Revision ID 和 UID。Flash 容量读取按地址表提供，L1 没有容量地址；F2/F4/F7 等半字地址使用 16 位读取。表内的家族级支持不代表每个子型号已完成实板验证；H7R/S、其他未知系列不使用旧 H7/STM32 身份地址，也不会扫描其他家族。APM32F4 只读已知 IDCODE；检测到 Geehy 厂商指纹时也不会套用 STM32 UID/容量地址。厂商指纹提供线索，不构成可靠的真伪鉴定。

独立模式用只读 CLI 读取身份信息和 DHCSR 状态；运行或休眠时不为普通读取建立 DAP 调试连接。状态读回停机时，使用短连接 DAP 的 `info reg` 读取 PC/SP/LR；CLI 对原停止位置的限制见下文。已有调试会话则复用所选 DAP 会话，并按停止代次检查结果；运行状态不读停机寄存器。选填字段读取失败时，已取得的信息仍显示，面板注明缺失字段，悬停可查看原因；Agent 返回的 `readErrors` 保留对应诊断。一次信息读取有 15 秒时间预算和固定字节预算。

面板会在 CPUID 返回后先显示核心，随后补齐身份字段，完成前禁用控制按钮。F1/F2/F4 的 UID 和容量跨度为 20 字节，F7 为 36 字节，使用一次半字读取；区间不可读则回退到分字段读取。Geehy 指纹仍禁止 UID/容量读取。Agent 的 `--fields`/`--section` 会传入硬件读取计划，跳过不需要的 ROM、IDCODE、容量、UID、运行状态或寄存器；选择性结果不会覆盖面板完整缓存。仅查询配置派生的调试元数据时不访问芯片，不代表已经验证探针在线。独立执行控制后的刷新复用尚未关闭的 DAP 连接。

保留 CLI 独立读取意味着完整刷新仍有多次探针连接开销。上游 `probe-rs read` 完成后会调用 `resume_all_cores`，连接和清理也可能短暂停机；这条路径不能保证已暂停目标的原停止位置。需要保持断点暂停时，使用已有 DAP 调试会话读取。优化边界及 F407_car 只读实测见 [芯片读取性能说明](PROBE-RS-CHIP-INFO-PERFORMANCE.md)。

芯片面板支持暂停、继续和复位。独立模式在 `chipInfo` 探针租约内复核状态，再用短连接 DAP 执行；普通读取不复位或烧录。短连接跳过 `configurationDone`，避免初始化自动恢复已停机核心，断开时不要求暂停或终止目标；仅在进程退出确认后释放探针。独立复位最终继续运行。已有调试会话的控制使用共用 DebugSessionBridge，并按适配器声明决定是否显示复位按钮；调试期间复位遵循当前调试配置的 restart 行为。连接、芯片配置或所选会话变化后，须重新读取后再操作；写入或其他探针操作占用时拒绝控制。

链路速率显示配置值，探针类型在选择器可明确识别时显示 J-Link 或 ST-Link。当前上游 CLI/DAP 未提供通用目标电压或探针固件/硬件版本查询，缺失时继续显示“不支持读取”或留空。短连接 attach 的暂停行为依据 [probe-rs 0.32 DAP 初始化实现](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/debugger.rs)；寄存器命令依据 [上游 info reg 实现](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/debug_adapter/dap/repl_commands/info.rs)。本次验证为模拟探针和 Extension Host 回归，未执行实板暂停、复位、烧录或驱动切换。
