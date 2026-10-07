# CPU 工作负载估计 / CPU workload estimate

这是实验性、默认关闭的主机采样功能。选择当前固件 ELF、探针和 MCU 后，展开烧录调试卡片内的 **其他**。
“其他”分为上方 **内存占用** 与下方 **实验性功能**，内存刷新按钮位于内存占用标题右侧。
使用实验性功能标题右侧的播放／暂停图标按钮启停 CPU 采样，也可使用键盘 Tab、Enter／空格操作该按钮。
**CPU负载** 行只显示工作负载百分率和计算覆盖率，覆盖率保留圆角徽标，整行加圆角边框；
右侧为负载数值，背景按有效负载百分率填充。进度条本身不控制采样，悬停可查看采样状态和失败原因。
折叠“其他”不停止采样。
无需增加固件统计代码或重编译；启动不会触发调试、暂停、继续、复位或下载。
CPU 使用专属独立 OpenOCD 连接和 `cpuLoad` 探针租约，从启动检查到确认退出均严格独占；
与烧录、调试、变量采样、一次性硬件读写及驱动切换双向互斥，须先结束当前操作再启动下一项。
启动前离线检查当前 ELF 的单核 FreeRTOS 符号和 DWARF，不支持的工程禁用启动，不建立硬件连接。
退出未确认时保留租约和连接，并允许重试停止。首版没有新增 Agent 控制命令。

This experimental monitor is off by default. Select the firmware ELF, probe and MCU, then expand **Other** in the
flash/debug card. **Memory usage** comes first, with its refresh button beside the heading; **Experimental features**
comes below, with a play/pause button to start or stop CPU sampling. Tab and Enter/Space also operate that button.
The rounded **CPU load** bar shows only workload and calculation coverage, with a coverage badge and a background fill
shared with the memory bars. Hover for status and errors. The bar itself is display-only. Folding Other does not stop sampling.
It reads existing kernel state without firmware changes or execution control. CPU sampling owns a dedicated standalone
connection and probe lease through confirmed process exit. Flashing, debugging, variable sampling, hardware reads/writes
and driver changes are mutually exclusive with CPU sampling in both directions. Finish the current operation first.
FreeRTOS ELF/DWARF is checked offline before creating a connection; unsupported projects disable Start.
Unconfirmed shutdown retains ownership and allows another Stop attempt.

## 指标口径

“CPU 工作负载估计”测量 **非 Idle 任务或活动异常的驻留比例**。它不是硬件非睡眠比例或完整执行时间。
例如任务驻留 10%、Idle 被中断期间异常驻留 60%、空闲 30%，工作负载估计为 70%。SysTick、PendSV 等系统异常也算工作。
Idle 忙循环算空闲；独立睡眠比例始终不可用。RTOS 面板的 `ulRunTimeCounter` 仍是原始累计计数，没有与采样混算。

Workload means non-Idle task residency plus active exceptions, including SysTick and PendSV. It is not awake time.
An ISR interrupting Idle counts as work. The existing RTOS runtime counters retain their original meaning.

默认请求上限 200 Hz，实际计划频率自适应，间隔抖动 ±20%；使用 10 秒滚动窗口、每秒更新一次。
控制器按实测读取耗时、CPU 的每秒 200 ms 预算和变量采样压力降低频率；链路变快后逐渐恢复。
后台统计仍包含请求上限、实际频率、自适应目标和读取耗时估计；精简进度条不展示这些诊断字段。
样本按当前自适应计划槽的时间权重积分。主动选择较低频率代表较低时间分辨率，不等同于丢样；
覆盖率衡量计划槽中成功分类的时间权重，不表示每一毫秒都被实际观察，也不表示相同统计精度。
首个完整窗口形成前负载显示“—”，悬停提示“采集中”。覆盖率低于 80% 时负载数值与背景填充不可用，覆盖率徽标以警示色呈现；
未知时间不被重新归一化，不能把已知工作占比解释成完整窗口的 CPU 负载。
已确认工作、Idle 和未知比例合计 100%。没有已确认 Idle 时，工作负载数值不可用；精简界面不展示异常和任务驻留。
真正错过的计划槽、写事务、变量优先读取、背压、超时和不稳定读数都计入未知。
后台“未知时间原因”按各原因占窗口的时间比例统计。即使覆盖率高，低频采样仍可能漏掉短任务和中断；
高覆盖不等于高精度或完整执行时间记录。

## 能力与必要元数据

- 首版只接受小端 ELF32 ARM、单个 Cortex-M CPU 目标、单核 FreeRTOS，以及运行期 CPUID 确认的 Cortex-M0/M0+/M3/M4/M7。
  OpenOCD 按 `cget -type` 区分 CPU 与辅助 `mem_ap` 目标；例如 `stm32h7x.cfg` 的 `ap2 mem_ap` 不算第二个核。
  多个 CPU 或其他目标类型仍拒绝，当前所选目标必须是已验证的 CPU。后续内存和状态读取绑定该 CPU，不切换目标。
  相关命令见 [OpenOCD CPU Configuration](https://openocd.org/doc/html/CPU-Configuration.html)。
- 当前 ELF 必须包含 `pxCurrentTCB` 和可解析的内核 DWARF。TCB 必须有 `pxTopOfStack`、`pxStack`、`uxPriority`、`pcTaskName`；
  `uxTCBNumber` 可选。支持既有 ELF Worker 的 DWARF 4/5 路径与解析预算；不通过 GDB 调用目标函数或暂停解析。
- 静态内核地址、TCB 和栈地址必须属于 ELF 中已验证的可写 RAM。链接脚本未描述的动态堆地址会被拒绝；不会扩大普通变量读取范围。
- Idle 使用 `xIdleTaskHandle`，前后读取一致且 TCB 验证通过后确认。没有句柄时精简界面仅显示覆盖率，负载不可用；
  不会按任务名或优先级自动猜测。后台保留本次测量代次内的已验证任务选择接口，精简界面不提供手动 Idle 入口。
- `xSchedulerRunning` 存在时，未运行调度器显示等待；缺失时无法把所有未验证 TCB 状态可靠解释成“尚未启动”。
- 任务元数据按需读取，1 秒过期，不遍历任务链表。编号和地址共同标识任务；缺少编号时标记“生命周期未确认”，
  只展示窗口内地址驻留。地址重用、可观测的身份异常或 Idle 身份变化结束原窗口。
- 后台汇总最多包含 32 个任务、20 个函数热点，其他条目合并；最多缓存 256 个任务和最近 120 个汇总点。
  精简界面只展示负载与覆盖率，不展示任务、热点、采样频率或未知原因列表。
- 共享多核组、SMP、TrustZone 核、其他 RTOS、外部 GDB Server、SWO/ETM 完整追踪不在首版范围内。

## 读取与有效性

一个 Tcl 请求依次读取 OpenOCD `curstate`、当前 TCB、ICSR.VECTACTIVE、可选 PCSR、ICSR、TCB、`curstate`。
前后任务或异常不同、目标非运行、读取失败，或批次跨度超过有效采样周期一半，样本为未知。
前后相同仍是非原子统计估计。任务标签随后通过有界 TCB 读取验证，过期或失效时不使用旧任务名。

专用寄存器白名单仅包含 CPUID、ICSR、DEMCR、DWT_CTRL、PCSR；没有 DHCSR 轮询。
PCSR 只用于函数热点：先读能力和当前 Trace 配置，Trace 未启用或核心不支持时退化到基础指标。
读取 PC 时再次确认 TRCENA；不会写 TRCENA、DWT 或其他调试寄存器。无效 PC 不表示睡眠，也不破坏有效任务／异常分类。
热点按函数地址索引定位，共享函数不归属于唯一任务；重叠／歧义函数范围不强行归因。

Worker 内仍保留 Tcl 队列互斥、到期变量优先和不积压补采的底层保护；CPU 的专属连接不对其他消费者开放。
CPU 调度预算为滚动每秒 200 ms，且受整体 Tcl 占用预算约束（独立模式 70%、调试模式 40%）；
控制器对读取成本进行平滑、对成本突增立即退让，预留 10% CPU 预算用于抖动和元数据刷新，
并逐渐恢复速率。预算不足导致真正跳过的计划槽仍计入未知。
传输自身的长延迟或超时无法被软件预算提前消除，错误成本也计入预算并阻止继续加压；不能据此保证链路毫秒级上界或零扰动。

## 生命周期

结果绑定专属连接、已验证目标、ELF SHA-256 和测量代次，变量事件格式保持不变。
镜像或工作区变化、断连、能力失败和用户停止会清除监测意图，废弃窗口与过期响应，并关闭连接。
被拒绝的启动不保留等待意图，不随烧录或调试结束自动恢复。可观测目标恢复时只在本次独占连接内重新验证窗口。
主机每秒检查 ELF 服务身份；独立模式使用 OpenOCD 自身状态、调度器及任务身份异常识别可观测失效。
外部快速复位可能在两次观测之间完成且身份没有变化，不能宣称已检测。ELF 身份表示选择的主机镜像，并非对目标 Flash 内容进行哈希验证。
CPU 占用期间拒绝修改探针连接配置；下载和调试不会自动停止 CPU 或接管其连接。
停止响应等待启动取消和进程退出确认，尚未确认退出时其他操作继续被拒绝。

## 验证与后续实板验收

普通测试覆盖分类、ISR/Idle、权重、丢槽、抖动、降频、读范围、DWARF 4/5、Worker 通道、双向互斥、
元数据先行、启动取消、退出失败保留租约、镜像及任务身份变化、过期响应和双语 UI。
模拟数据与软件测试不能证明芯片支持、精度或时序零扰动。
执行 `npm run check`、`npm run quality`、`npm run bundle`、`npm run test:e2e`；硬件测试须单独授权。

2026-10-07 对 `F407_car` 的一次授权只读检查验证了 ELF 内核布局和运行状态：TCB 大小 100 字节，
Idle 句柄可解析；6 个调度器样本均为运行中，tick 增长符合约 1000 Hz。
该检查通过现有 Agent Bridge 的临时租约读取 RAM，没有暂停、复位、写寄存器或下载固件；
它不能证明 CPU 百分比精度或新自适应策略在实板上的覆盖率。

同日对 `H750_RTOS_CPP_Test` 进行了离线 ELF 检查：当前任务、Idle 句柄和调度器符号可解析，TCB 大小 92 字节。
安装的 `stm32h7x.cfg` 在非 HLA 连接下同时创建 `ap2 mem_ap` 与 `cpu0 cortex_m`，旧检查误把访问目标计为第二个 CPU；
已改为按类型识别，并通过模拟 H7 目标列表的 Worker／TCP 测试。该修复尚未完成 H750 实板 CPU 采样验收。
另以 OpenOCD 0.12.0 的 dummy adapter 创建同类目标，验证了实际 Tcl 类型查询的返回格式，未初始化或连接硬件。

后续专用板卡验收需独立时间参考，覆盖已知占空比、ISR、tickless、缓存和低功耗。
目标是在连续 60 秒、覆盖率至少 95% 时，稳定负载平均误差不超过 5 个百分点；变量采样率下降不超过 10%，
同时记录目标时序扰动。实板验收完成前不发布精度或零扰动保证。

参见 [CPU 占用率审计](CPU-UTILIZATION-AUDIT.md)、[RTOS 能力边界](RTOS-AWARENESS.md)、[共享调试组](SHARED-DEBUG-GROUPS.md)。
