# probe-rs 原生采样

原生后端只用于独立、只读 RAM 采样。OpenOCD 仍是默认后端，并继续管理烧录、调试、外设、RTT 和变量写入。
原生会话持有现有 ProbeCoordinator 租约，不在它占用探针时启动第二个硬件连接。

Rust 子进程直接使用锁定版本的 probe-rs 库，独占 Session/Core，在进程内按图表和侧栏各自的节拍采样。
控制消息使用有界的私有 stdio 帧，样本用二进制帧批量传输，避免每轮 JavaScript/Rust 请求往返和 Base64。
Worker 保留现有代次、流控、历史和归档行为。旧 DAP 后端不恢复。
启动失败会关闭共享采样意图，`sampling.status.lastStartError` 保留最近启动失败的结构化原因，
下一次启动清除；helper 未确认退出仍保留租约并报告 exit-unconfirmed。原生统计中的
`linkSpeedKhz` 使用 helper 确认的链路时钟，避免把配置默认值 0 当成吞吐测试的实际速度。

目标、探针和 ELF 必须来自明确配置及现有预检。Rust 自行从 ELF 提取允许的可写 RAM 范围，
拒绝外设、越界、过大的帧或读取计划。普通 attach 不复位、不主动暂停或恢复目标，也不提供 Flash/RAM 写接口。
连接或读取失败不自动重试，进程退出未确认时保留租约；停止、计划替换和执行代次变化废弃旧样本。

初始范围为固定地址全局量和静态布局的数组/结构；需要运行时寻址的指针及 STL 对象仍使用 OpenOCD。
原生会话不提供外设、RTT 或写入能力，不会通过另一条连接绕过占用或授权保护。

MCU 配置卡保留共用 ELF/探针和 OpenOCD 目标，新增后端及 probe-rs 型号选择。型号查询使用经过
相同包完整性校验的 helper `--list-chips`，只枚举 registry，不枚举 USB 或连接硬件。查询加载随附
C593 和用户配置的 YAML，筛选单核 Cortex-M，以协议版本、4 MiB 输出、30000 型号和 10 秒超时限制目录。
`SamplingConfiguration` 负责 QuickPick 与用户设置写入，选前/选后复核探针会话空闲及设置未被替换，
不会从系列级 OpenOCD 脚本猜测具体型号，也不会覆盖共用 ELF 或原先 OpenOCD 目标。

`NativeSamplingService` 复用探针连接预检，要求侧栏中用户明确选择的 USB VID/PID/序列号，
并在 ELF 指纹检查后复核配置没有改变。原生设置只由用户设置，Agent 不能指定可执行程序或 YAML。
SEGGER VID `1366` 的 J-Link 序列号按非零 u32 十进制身份比较，兼容 USB 描述符的前导零，
例如 `20781318` 与 `000020781318`；VID/PID 仍须相同，多个匹配仍拒绝，其他探针序列号保持逐字节精确匹配。
目前预检仍使用现有 OpenOCD 的安装与接口检查；原生采样环路不启动 OpenOCD 服务或 DAP。
调试中的采样继续借用已有调试会话，不为 native 设置启动另一条连接。

helper 限定单核 ARM ELF32 小端目标。可读 RAM 是 ELF 已分配、可写 section 与目标 RAM 映射的交集；
不支持无 section ELF、RAM-only 固件或找不到可验证 Flash 段的目标。初始化核对 ELF SHA-256，
只读比较落入目标 NVM 映射的非空 PT_LOAD 物理地址段（总计不超过 16 MiB）；Flash 不一致即退出。
文件上限为 ELF 64 MiB、YAML 4 MiB、section 16384、program header 1024。

所有帧都有 4 字节小端长度，正文最多 1 MiB。类型 1 为带请求 id 的 JSON 控制帧，
类型 2 为 generation、recipe、点数、每点字节数和样本数组。每点含 f64 毫秒时间戳、f32 读取耗时和原始字节。
时间戳来自一次墙钟与单调时钟锚定后的读取中点，批量传输不改写采样时刻。每批最多 64 点或约 8 ms。
stdin 命令队列 32、stdout 队列 16、JS 在途请求 64，满时暂停生产，不无限积累内存。
初始化超时 30 秒，普通控制超时 5 秒，超时后关闭连接且不重试；停止确认涵盖 helper 实际退出。

采样计划预编译 graph/sidebar/combined 三种读取配方。静态范围仅在同一允许 RAM section 内合并，
最多扩读 4 字节间隙，每轮最多 4096 字节 / 64 范围（上层仍保留 32 项预算）。对齐范围使用
`read_32`，其次 `read_16`，其余 `read_8`；不扩大到范围以外。无限速环路不经过 JS 定时器或每点 RPC，
有限速跳过错过的截止点、不追补突发。Worker 的 ACK、host hold、归档背压和代次继续生效。

开发与发行构建见 [发布指南](../development/releasing.md)。只读实板测量脚本为
`scripts/measure-probe-rs.js PLAN HELPER SPEED_KHZ OUTPUT`，需 `EMBERPROBE_HIL_CONFIRM=YES`，
专用 JSON 计划指定同一 ELF 指纹、USB 身份、RAM sections、tick 地址和读取布局；每组先预热一秒，
再以 Rust 时间戳统计送达宿主的点数、Hz、队列 gap 与固件 tick。该脚本不属于破坏性 `test:hil`。
测量覆盖 Rust → 二进制 IPC → Worker → 宿主，不包含图表绘制、CSV 或归档磁盘吞吐；原始结果留在
`test-results/`，实板环境和限制追加到本地 `docs/records/`。
