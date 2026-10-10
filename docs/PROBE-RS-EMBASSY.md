# probe-rs 与 Embassy 使用说明

MC02 的独立 Embassy 仓库、自动 LiveWatch 和整数/浮点调参验收步骤见 [MC02 回归测试](MC02-REGRESSION.md)。

## Embassy / Rust 与 probe-rs

EmberProbe 可以用 probe-rs 调试 Cortex-M 上的 Rust 程序，并在同一个调试会话中读取运行中的全局变量、绘制波形和写入可调标量。先安装支持 `dap-server` 的 `probe-rs` 命令行工具，在侧栏“调试后端”选择 `probe-rs`，再选择探针和芯片。侧栏只检测当前后端的环境；probe-rs 模式不需要安装 OpenOCD。也可在 VS Code 工作区设置中配置：

```json
{
  "emberprobe.backend": "probe-rs",
  "emberprobe.probeRsPath": "probe-rs",
  "emberprobe.probeRsChip": "STM32H723VG",
  "emberprobe.sampleFrequencyHz": 10
}
```

上面的芯片名适用于 STM32H723VGT6；其他芯片请以 `probe-rs chip list` 的名称为准。多探针环境可另设 `emberprobe.probeRsProbe` 为 `VID:PID:Serial`。选择固件时，EmberProbe 会查找 Cargo 默认 `target/<triple>/debug` 和 `release` 目录内的无扩展名 ARM ELF；也可点“Browse for ELF”手选。固件必须包含未剥离的 ELF 符号和 DWARF 类型信息。点击侧栏“启动”会以 probe-rs `attach` 连接现有固件；“启动调试”会使用 probe-rs 烧录并开启断点调试。下载按钮调用 probe-rs 烧录、复位。

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

Agent Bridge 的变量读取与写入可复用活动的 probe-rs LiveWatch/DAP 会话。Agent Flash 与故障寄存器分析仍限于 OpenOCD；probe-rs 烧录请使用侧栏“烧录”按钮。

独立的 STM32H723 Embassy 真机测试程序与复测步骤见 [HIL smoke app](../test/hil/fixtures/embassy-h723/README.md)。
probe-rs 模式下“读取芯片信息”与 OpenOCD 复用项目的已知芯片地址表：Cortex-M CPUID、核心版本、CoreSight ROM / JEP106 厂商线索，以及 STM32 F0/F1/F2/F3/F4/F7、G0/G4、H7、L0/L1/L4、WB/WL 的 Device ID、Revision ID 和 UID。Flash 容量读取按地址表提供，L1 没有容量地址；F2/F4/F7 等半字地址使用 16 位读取。表内的家族级支持不代表每个子型号已完成实板验证；H7R/S、其他未知系列不使用旧 H7/STM32 身份地址，也不会扫描其他家族。APM32F4 只读已知 IDCODE；检测到 Geehy 厂商指纹时也不会套用 STM32 UID/容量地址。厂商指纹提供线索，不构成可靠的真伪鉴定。

独立模式用只读 CLI 读取身份信息和 DHCSR 状态；运行或休眠时不为普通读取建立 DAP 调试连接。状态读回停机时，使用短连接 DAP 的 `info reg` 读取 PC/SP/LR；CLI 对原停止位置的限制见下文。已有调试会话则复用所选 DAP 会话，并按停止代次检查结果；运行状态不读停机寄存器。选填字段读取失败时，已取得的信息仍显示，面板注明缺失字段，悬停可查看原因；Agent 返回的 `readErrors` 保留对应诊断。一次信息读取有 15 秒时间预算和固定字节预算。

面板会在 CPUID 返回后先显示核心，随后补齐身份字段，完成前禁用控制按钮。F1/F2/F4 的 UID 和容量跨度为 20 字节，F7 为 36 字节，使用一次半字读取；区间不可读则回退到分字段读取。Geehy 指纹仍禁止 UID/容量读取。Agent 的 `--fields`/`--section` 会传入硬件读取计划，跳过不需要的 ROM、IDCODE、容量、UID、运行状态或寄存器；选择性结果不会覆盖面板完整缓存。仅查询配置派生的调试元数据时不访问芯片，不代表已经验证探针在线。独立执行控制后的刷新复用尚未关闭的 DAP 连接。

保留 CLI 独立读取意味着完整刷新仍有多次探针连接开销。上游 `probe-rs read` 完成后会调用 `resume_all_cores`，连接和清理也可能短暂停机；这条路径不能保证已暂停目标的原停止位置。需要保持断点暂停时，使用已有 DAP 调试会话读取。优化边界及 F407_car 只读实测见 [芯片读取性能说明](PROBE-RS-CHIP-INFO-PERFORMANCE.md)。

芯片面板支持暂停、继续和复位。独立模式在 `chipInfo` 探针租约内复核状态，再用短连接 DAP 执行；普通读取不复位或烧录。短连接跳过 `configurationDone`，避免初始化自动恢复已停机核心，断开时不要求暂停或终止目标；仅在进程退出确认后释放探针。独立复位最终继续运行。已有调试会话的控制使用共用 DebugSessionBridge，并按适配器声明决定是否显示复位按钮；调试期间复位遵循当前调试配置的 restart 行为。连接、芯片配置或所选会话变化后，须重新读取后再操作；写入或其他探针操作占用时拒绝控制。

链路速率显示配置值，探针类型在选择器可明确识别时显示 J-Link 或 ST-Link。当前上游 CLI/DAP 未提供通用目标电压或探针固件/硬件版本查询，缺失时继续显示“不支持读取”或留空。短连接 attach 的暂停行为依据 [probe-rs 0.32 DAP 初始化实现](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/server/debugger.rs)；寄存器命令依据 [上游 info reg 实现](https://github.com/probe-rs/probe-rs/blob/v0.32.0/probe-rs-tools/src/bin/probe-rs/cmd/dap_server/debug_adapter/dap/repl_commands/info.rs)。本次验证为模拟探针和 Extension Host 回归，未执行实板暂停、复位、烧录或驱动切换。
