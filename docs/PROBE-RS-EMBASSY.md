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
probe-rs 模式下“读取芯片信息”会读取核心 CPUID；对 STM32H7 还会读取 Device ID、Revision ID、Flash 容量和 UID。独立模式使用 probe-rs CLI，调试会话内复用 DAP 连接。
